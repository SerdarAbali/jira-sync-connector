import { randomBytes } from 'crypto';
import * as kvsStore from '../storage/kvs.js';
import { isKeyConflictError } from '../../utils/storage-errors.js';

export const DEFAULT_ISSUE_LEASE_TTL_SECONDS = 120;

function orgScope(orgId) {
  return orgId === null || orgId === undefined || orgId === '' ? 'legacy' : String(orgId);
}

/**
 * One lease per organization + mapped issue pair. The direction is stored as
 * metadata but is intentionally not part of the key so local->remote and
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

async function tryCreateLease(key, value, ttlSeconds) {
  if (typeof kvsStore.setIfNotExists === 'function') {
    await kvsStore.setIfNotExists(key, value, ttlSeconds);
    return;
  }
  // Compatibility for older test doubles. Production always uses the atomic
  // Forge KVS FAIL_IF_EXISTS path above.
  const existing = await kvsStore.get(key);
  if (existing) {
    const conflict = new Error('lease exists');
    conflict.code = 'KEY_ALREADY_EXISTS';
    throw conflict;
  }
  await kvsStore.set(key, value);
}

/**
 * Atomically claim a bounded per-issue-pair lease. Expiration is enforced by
 * the native KVS TTL, so an expired lease cannot block forever.
 */
export async function acquireIssueLease({
  orgId = null,
  localKey = null,
  remoteKey = null,
  sourceKey = null,
  direction = 'unknown',
  ttlSeconds = DEFAULT_ISSUE_LEASE_TTL_SECONDS,
  now = Date.now()
}) {
  let key;
  try {
    key = buildIssueLeaseKey({ orgId, localKey, remoteKey, sourceKey });
  } catch (error) {
    return { acquired: false, status: 'LEASE_STORAGE_ERROR', reason: 'invalid-lease-scope' };
  }

  const token = createLeaseToken();
  const metadata = {
    orgId: orgId === null || orgId === undefined ? null : String(orgId),
    localKey,
    remoteKey: remoteKey || null,
    direction,
    acquiredAt: new Date(now).toISOString(),
    leaseToken: token,
    expiresAt: new Date(now + ttlSeconds * 1000).toISOString()
  };

  try {
    await tryCreateLease(key, metadata, ttlSeconds);
    return { acquired: true, status: 'ACQUIRED', key, token, metadata };
  } catch (error) {
    if (!isKeyConflictError(error)) {
      console.error(`Lease storage failed for ${localKey}: LEASE_STORAGE_ERROR`);
      return { acquired: false, status: 'LEASE_STORAGE_ERROR', reason: 'storage-unavailable' };
    }
    return { acquired: false, status: 'SYNC_ALREADY_IN_PROGRESS', key };
  }
}

/**
 * Release only the caller's lease. A mismatched/absent token is a no-op and can
 * never delete a newer invocation's lease.
 */
export async function releaseIssueLease({ key, token }) {
  if (!key || !token) {
    return { released: false, status: 'LEASE_NOT_OWNED' };
  }
  try {
    const current = await kvsStore.get(key);
    if (!current || current.leaseToken !== token) {
      return { released: false, status: 'LEASE_NOT_OWNED' };
    }
    await kvsStore.del(key);
    return { released: true, status: 'RELEASED' };
  } catch {
    console.error('Lease release failed: LEASE_STORAGE_ERROR');
    return { released: false, status: 'LEASE_STORAGE_ERROR' };
  }
}

/**
 * Run a callback under the issue lease and release it on every exit path.
 * Locked/storage-error outcomes are returned as explicit internal statuses;
 * the callback is not executed for either.
 */
export async function withIssueLease(options, callback) {
  const lease = await acquireIssueLease(options);
  if (!lease.acquired) {
    return { status: lease.status, lease };
  }

  try {
    const result = await callback(lease);
    return { status: 'ok', lease, result };
  } finally {
    await releaseIssueLease({ key: lease.key, token: lease.token });
  }
}
