import { randomBytes, createHash } from 'crypto';
import kvs, { Filter, FilterConditions as C } from '@forge/kvs';
import { assertIssueLeaseMigrationReady } from './lease-migration.js';
import { isKeyConflictError } from '../../utils/storage-errors.js';

export const DEFAULT_ISSUE_LEASE_TTL_SECONDS = 120;

function orgScope(orgId) {
  return orgId === null || orgId === undefined || orgId === '' ? 'legacy' : String(orgId);
}

/**
 * One lease per organization + mapped issue pair. Direction is intentionally
 * not part of the key so local->remote and
 * remote->local writes, scheduled sync and webhooks all contend.
 */
export function buildIssueLeaseKey({ orgId = null, localKey = null, remoteKey = null, sourceKey = null }) {
  const remoteScope = typeof remoteKey === 'string' && remoteKey ? remoteKey : 'unmapped';
  if (typeof localKey === 'string' && localKey) {
    return `sync-lease:${orgScope(orgId)}:${encodeURIComponent(localKey)}:${encodeURIComponent(remoteScope)}`;
  }
  if (typeof sourceKey === 'string' && sourceKey) {
    return `sync-lease:${orgScope(orgId)}:source:${encodeURIComponent(sourceKey)}`;
  }
  throw new Error('localKey or sourceKey is required for an issue lease');
}

export function createLeaseToken() {
  return randomBytes(32).toString('hex');
}

export const ISSUE_LEASE_ENTITY = 'issue-lease';

// Entity keys have a narrower alphabet than basic KVS keys. Keep the original
// scope derivation, but hash it to a bounded, entity-safe key.
export function issueLeaseEntityKey(scope) {
  return createHash('sha256').update(scope).digest('hex');
}

function owned(lease, now) {
  return new Filter().and('leaseToken', C.equalTo(lease.token))
    .and('expiresAt', C.greaterThan(now));
}

function leaseError(code = 'LEASE_NOT_OWNED') {
  const error = new Error('Issue lease ownership could not be verified; no write authorized');
  error.code = code;
  return error;
}

export async function acquireIssueLease({
  orgId = null,
  localKey = null,
  remoteKey = null,
  sourceKey = null,
  ttlSeconds = DEFAULT_ISSUE_LEASE_TTL_SECONDS,
  now = Date.now()
}) {
  let key;
  try {
    key = issueLeaseEntityKey(buildIssueLeaseKey({ orgId, localKey, remoteKey, sourceKey }));
  } catch (error) {
    return { acquired: false, status: 'LEASE_STORAGE_ERROR', reason: 'invalid-lease-scope' };
  }

  if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 900) {
    return { acquired: false, status: 'LEASE_STORAGE_ERROR' };
  }
  const token = createLeaseToken();
  const metadata = { leaseToken: token, expiresAt: now + ttlSeconds * 1000 };
  try {
    await assertIssueLeaseMigrationReady();
    const current = await kvs.entity(ISSUE_LEASE_ENTITY).get(key);
    if (current && (!Number.isFinite(current.expiresAt) || current.expiresAt > now)) {
      return { acquired: false, status: 'SYNC_ALREADY_IN_PROGRESS', key };
    }
    // No native TTL: application expiry authorizes conditional takeover even
    // if an abandoned entity remains stored indefinitely.
    const conditions = current
      ? new Filter().and('leaseToken', C.equalTo(current.leaseToken))
        .and('expiresAt', C.equalTo(current.expiresAt)).and('expiresAt', C.lessThanEqualTo(now))
      : new Filter().and('leaseToken', C.notExists());
    await kvs.transact().set(key, metadata, { entityName: ISSUE_LEASE_ENTITY, conditions }).execute();
    if (metadata.expiresAt <= Date.now()) {
      return { acquired: false, status: 'LEASE_STORAGE_ERROR', reason: 'acquisition-expired' };
    }
    return { acquired: true, status: 'ACQUIRED', key, token, metadata, ttlSeconds };
  } catch (error) {
    // Only known conditional conflicts are contention; unknown transaction
    // errors (including ambiguous outcomes) fail closed as storage errors.
    return { acquired: false, status: isKeyConflictError(error)
      ? 'SYNC_ALREADY_IN_PROGRESS' : 'LEASE_STORAGE_ERROR', reason: error.code };
  }
}

export async function assertIssueLeaseOwned(lease) {
  if (!lease?.key || !lease.token || lease.closed
      || !Number.isFinite(lease.metadata?.expiresAt) || lease.metadata.expiresAt <= Date.now()) {
    throw leaseError();
  }
  try {
    await kvs.transact().check(lease.key, {
      entityName: ISSUE_LEASE_ENTITY, conditions: owned(lease, Date.now())
    }).execute();
  } catch {
    throw leaseError('LEASE_OWNERSHIP_UNAVAILABLE');
  }
  // A delayed storage response must not extend the application's deadline.
  if (lease.closed || lease.metadata.expiresAt <= Date.now()) throw leaseError();
}

export async function renewIssueLease(lease) {
  await assertIssueLeaseMigrationReady();
  await assertIssueLeaseOwned(lease);
  const previousExpiry = lease.metadata.expiresAt;
  const expiresAt = Math.max(previousExpiry, Date.now() + lease.ttlSeconds * 1000);
  try {
    await kvs.transact().set(lease.key, { leaseToken: lease.token, expiresAt }, {
      entityName: ISSUE_LEASE_ENTITY,
      conditions: owned(lease, Date.now()).and('expiresAt', C.equalTo(previousExpiry))
    }).execute();
  } catch {
    throw leaseError('LEASE_OWNERSHIP_UNAVAILABLE');
  }
  // The service compares against the timestamp sent in the predicate, not
  // a server-side clock expression. A delayed renewal must fail locally if
  // the original deadline elapsed while its request was outstanding.
  if (previousExpiry <= Date.now()) {
    lease.closed = true;
    throw leaseError();
  }
  lease.metadata = { leaseToken: lease.token, expiresAt };
  await assertIssueLeaseOwned(lease);
  return lease;
}

export async function releaseIssueLease({ key, token }) {
  if (!key || !token) return { released: false, status: 'LEASE_NOT_OWNED' };
  try {
    await kvs.transact().delete(key, {
      entityName: ISSUE_LEASE_ENTITY,
      conditions: new Filter().and('leaseToken', C.equalTo(token))
    }).execute();
    return { released: true, status: 'RELEASED' };
  } catch {
    // An unavailable release retains the record; application expiry recovers it.
    return { released: false, status: 'LEASE_NOT_OWNED_OR_UNAVAILABLE' };
  }
}

/** Convenience lifecycle helper; context is loaded only when invoked. */
export async function withIssueLease(options, callback) {
  const lease = await acquireIssueLease(options);
  if (!lease.acquired) return { status: lease.status, lease };
  try {
    const { runWithIssueLease } = await import('./issue-lease-context.js');
    const result = await runWithIssueLease(lease, () => callback(lease));
    return { status: 'ok', lease, result };
  } finally {
    await releaseIssueLease(lease);
  }
}
