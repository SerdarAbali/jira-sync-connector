import { getAppContext } from '@forge/api';
import * as kvsStore from '../storage/kvs.js';
import { getPilotPause } from './pilot-pause.js';
import { PAIR_WITNESS_PROPERTY_KEY } from './pair-witness-constants.js';
import { parsePairWitnessValue, pairWitnessPayloadDigest } from './pair-witness.js';

/**
 * Maintenance permit for the pairing-witness migration.
 *
 * The permit is the only thing that can authorize a Jira write while the
 * connector is paused and synchronization authorization is blocked. It is
 * deliberately tiny: one installation, one organization, one plan, one batch,
 * one exact payload per approved issue. It authorizes exactly
 *
 *   PUT /rest/api/3/issue/{stableIssueId}/properties/sync-connector-pair
 *
 * and nothing else. Every other request — creation, field updates, deletion,
 * another property key, another site, another issue — fails the shape test
 * before a permit is even read, and then takes the ordinary fail-closed path.
 *
 * A permit is not a switch that turns checks off. It is an additional,
 * self-contained decision that must satisfy every condition independently; if
 * any condition is missing or unreadable the write is refused outright rather
 * than downgraded to an ordinary attempt.
 */

export const PAIR_WITNESS_PLAN_KEY = (orgId) => `pairWitnessPlan:${orgId}`;
export const PAIR_WITNESS_PERMIT_KEY = 'pairWitnessPermit';
export const PAIR_WITNESS_BATCH_LOCK_KEY = 'pairWitnessBatchLock';
export const PAIR_WITNESS_WRITE_MARKER_KEY = (orgId, site, issueId) =>
  `witnessWritten:${orgId}:${site}:${issueId}`;

export const PAIR_WITNESS_PERMIT_VERSION = 1;
export const PAIR_WITNESS_PLAN_VERSION = 1;
/** Permits are short-lived: one batch, then they are gone. */
export const PAIR_WITNESS_PERMIT_TTL_SECONDS = 600;
export const PAIR_WITNESS_PLAN_TTL_SECONDS = 86400;
/** A crashed batch must not hold the single-flight lock forever. */
export const PAIR_WITNESS_LOCK_TTL_SECONDS = 120;

export const PAIR_WITNESS_PROPERTY_PATH = new RegExp(
  `^/rest/api/3/issue/(\\d{1,32})/properties/${PAIR_WITNESS_PROPERTY_KEY}$`
);

export const PAIR_WITNESS_PERMIT_REASONS = Object.freeze({
  PERMIT_MISSING: 'PAIR_WITNESS_PERMIT_MISSING',
  PERMIT_MALFORMED: 'PAIR_WITNESS_PERMIT_MALFORMED',
  PERMIT_EXPIRED: 'PAIR_WITNESS_PERMIT_EXPIRED',
  PERMIT_FOREIGN_INSTALLATION: 'PAIR_WITNESS_PERMIT_FOREIGN_INSTALLATION',
  PERMIT_ISSUE_NOT_APPROVED: 'PAIR_WITNESS_PERMIT_ISSUE_NOT_APPROVED',
  PERMIT_SITE_NOT_APPROVED: 'PAIR_WITNESS_PERMIT_SITE_NOT_APPROVED',
  PERMIT_PAYLOAD_MISMATCH: 'PAIR_WITNESS_PERMIT_PAYLOAD_MISMATCH',
  PERMIT_PAIR_MISMATCH: 'PAIR_WITNESS_PERMIT_PAIR_MISMATCH',
  PERMIT_PLAN_MISMATCH: 'PAIR_WITNESS_PERMIT_PLAN_MISMATCH',
  PERMIT_ALREADY_WRITTEN: 'PAIR_WITNESS_PERMIT_ALREADY_WRITTEN',
  PAUSE_NOT_CONFIRMED: 'PAIR_WITNESS_PAUSE_NOT_CONFIRMED',
  PAUSE_UNREADABLE: 'PAIR_WITNESS_PAUSE_UNREADABLE',
  RESTORE_IN_PROGRESS: 'PAIR_WITNESS_RESTORE_IN_PROGRESS',
  RESTORE_UNREADABLE: 'PAIR_WITNESS_RESTORE_UNREADABLE',
  PLAN_NOT_APPROVED: 'PAIR_WITNESS_PLAN_NOT_APPROVED',
  PLAN_EXPIRED: 'PAIR_WITNESS_PLAN_EXPIRED',
  IDENTITY_UNAVAILABLE: 'PAIR_WITNESS_IDENTITY_UNAVAILABLE',
  LOCK_HELD: 'PAIR_WITNESS_BATCH_LOCK_HELD',
  LOCK_LOST: 'PAIR_WITNESS_BATCH_LOCK_LOST'
});

const REASON_TEXT = Object.freeze({
  [PAIR_WITNESS_PERMIT_REASONS.PERMIT_MISSING]:
    'No maintenance permit is active for this installation.',
  [PAIR_WITNESS_PERMIT_REASONS.PERMIT_MALFORMED]:
    'The maintenance permit is not a record this connector wrote.',
  [PAIR_WITNESS_PERMIT_REASONS.PERMIT_EXPIRED]: 'The maintenance permit has expired.',
  [PAIR_WITNESS_PERMIT_REASONS.PERMIT_FOREIGN_INSTALLATION]:
    'The maintenance permit belongs to a different installation.',
  [PAIR_WITNESS_PERMIT_REASONS.PERMIT_ISSUE_NOT_APPROVED]:
    'This issue is not in the approved plan.',
  [PAIR_WITNESS_PERMIT_REASONS.PERMIT_SITE_NOT_APPROVED]:
    'This Jira site is not in the approved plan.',
  [PAIR_WITNESS_PERMIT_REASONS.PERMIT_PAYLOAD_MISMATCH]:
    'The property payload does not match the approved payload.',
  [PAIR_WITNESS_PERMIT_REASONS.PERMIT_PAIR_MISMATCH]:
    'The pair identifier does not match the approved pair.',
  [PAIR_WITNESS_PERMIT_REASONS.PERMIT_PLAN_MISMATCH]:
    'The maintenance permit does not belong to the approved plan.',
  [PAIR_WITNESS_PERMIT_REASONS.PERMIT_ALREADY_WRITTEN]:
    'This issue already recorded a witness write.',
  [PAIR_WITNESS_PERMIT_REASONS.PAUSE_NOT_CONFIRMED]:
    'The emergency pause is not confirmed ON, so no maintenance write is allowed.',
  [PAIR_WITNESS_PERMIT_REASONS.PAUSE_UNREADABLE]:
    'The emergency pause could not be read, so no maintenance write is allowed.',
  [PAIR_WITNESS_PERMIT_REASONS.RESTORE_IN_PROGRESS]:
    'A restore is in progress; no maintenance write is allowed.',
  [PAIR_WITNESS_PERMIT_REASONS.RESTORE_UNREADABLE]:
    'The restore state could not be read, so no maintenance write is allowed.',
  [PAIR_WITNESS_PERMIT_REASONS.PLAN_NOT_APPROVED]: 'The migration plan is not approved.',
  [PAIR_WITNESS_PERMIT_REASONS.PLAN_EXPIRED]: 'The approved migration plan has expired.',
  [PAIR_WITNESS_PERMIT_REASONS.IDENTITY_UNAVAILABLE]:
    'The Forge installation identity could not be read.',
  [PAIR_WITNESS_PERMIT_REASONS.LOCK_HELD]: 'Another migration batch is already running.',
  [PAIR_WITNESS_PERMIT_REASONS.LOCK_LOST]:
    'This invocation no longer owns the batch, so it stopped without writing.'
});

export class PairWitnessPermitError extends Error {
  constructor(reason, details = {}) {
    super(REASON_TEXT[reason] || 'The maintenance permit does not authorize this write.');
    this.name = 'PairWitnessPermitError';
    this.code = 'PAIR_WITNESS_PERMIT_REFUSED';
    this.reason = reason;
    this.details = details;
  }
}

export function pairWitnessPermitMessage(reason) {
  return REASON_TEXT[reason] || 'The maintenance permit does not authorize this write.';
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The exact phrase an administrator types to approve one plan. */
export function pairWitnessApprovalPhrase({ orgId, planDigest, pairCount }) {
  const digest = String(planDigest || '').replace(/^sha256:/, '').slice(0, 12);
  return `APPROVE WITNESS ${orgId} ${digest} ${pairCount}`;
}

function readIdentity(getContext) {
  let context;
  try {
    context = getContext();
  } catch {
    return null;
  }
  const appId = typeof context?.appAri?.appId === 'string' ? context.appAri.appId : null;
  const environmentId = typeof context?.environmentAri?.environmentId === 'string'
    ? context.environmentAri.environmentId
    : null;
  const installationId = typeof context?.installationAri?.installationId === 'string'
    ? context.installationAri.installationId
    : null;
  return appId && installationId ? { appId, environmentId, installationId } : null;
}

/** Pause must be explicitly ON. A missing record is not "on". */
export async function assertPauseConfirmedOn(deps) {
  let pause;
  try {
    pause = await deps.readPause();
  } catch {
    throw new PairWitnessPermitError(PAIR_WITNESS_PERMIT_REASONS.PAUSE_UNREADABLE);
  }
  if (!pause || pause.paused !== true) {
    throw new PairWitnessPermitError(PAIR_WITNESS_PERMIT_REASONS.PAUSE_NOT_CONFIRMED);
  }
  return pause;
}

export async function assertNoRestoreInProgress(deps) {
  let record;
  try {
    record = await deps.getStored('syncAuthorization');
  } catch {
    throw new PairWitnessPermitError(PAIR_WITNESS_PERMIT_REASONS.RESTORE_UNREADABLE);
  }
  if (isPlainObject(record) && record.state === 'restore-in-progress') {
    throw new PairWitnessPermitError(PAIR_WITNESS_PERMIT_REASONS.RESTORE_IN_PROGRESS);
  }
  return true;
}

function normalizePermit(value) {
  if (!isPlainObject(value)) return null;
  if (value.version !== PAIR_WITNESS_PERMIT_VERSION) return null;
  if (typeof value.permitId !== 'string' || value.permitId.length < 8) return null;
  if (typeof value.orgId !== 'string' || !/^org-\d+$/.test(value.orgId)) return null;
  if (typeof value.planDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.planDigest)) return null;
  if (typeof value.installationId !== 'string' || typeof value.appId !== 'string') return null;
  if (typeof value.localSite !== 'string' || value.localSite === '') return null;
  if (!Number.isFinite(Number(value.expiresAt))) return null;
  if (!Array.isArray(value.entries)) return null;
  const entries = value.entries
    .filter((entry) => isPlainObject(entry)
      && (entry.site === 'local' || typeof entry.site === 'string')
      && /^\d{1,32}$/.test(String(entry.issueId ?? ''))
      && typeof entry.pairId === 'string'
      && typeof entry.payloadDigest === 'string')
    .map((entry) => ({
      site: entry.site,
      issueId: String(entry.issueId),
      pairId: entry.pairId,
      payloadDigest: entry.payloadDigest
    }));
  if (entries.length === 0) return null;
  return {
    version: PAIR_WITNESS_PERMIT_VERSION,
    permitId: value.permitId,
    orgId: value.orgId,
    planDigest: value.planDigest,
    installationId: value.installationId,
    appId: value.appId,
    localSite: value.localSite,
    batchIndex: Number.isInteger(value.batchIndex) ? value.batchIndex : 0,
    issuedAt: typeof value.issuedAt === 'string' ? value.issuedAt : null,
    expiresAt: Number(value.expiresAt),
    entries
  };
}


const defaultDeps = {
  getStored: kvsStore.get,
  setStored: kvsStore.set,
  setStoredWithTtl: kvsStore.setWithTtl,
  setIfNotExists: kvsStore.setIfNotExists,
  deleteKey: kvsStore.del,
  readPause: getPilotPause,
  getContext: getAppContext,
  now: () => Date.now(),
  audit: null
};

/**
 * The complete maintenance decision for one request.
 *
 * Returns `{ allowed: false, refusal: null }` for anything that is not exactly
 * the approved PUT shape: those requests continue to the ordinary fail-closed my
 * chain and therefore still fail while the connector is paused.
 *
 * Returns `{ allowed: false, refusal: 'PERMIT_INVALID', reason }` for a
 * permit-shaped request that fails any condition. Such a request is refused
 * outright; it is never downgraded to an ordinary attempt.
 */
export async function evaluatePairWitnessPermit(options = {}) {
  const deps = { ...defaultDeps, ...(options.deps || {}) };
  const method = String(options.method || '').toUpperCase();
  if (method !== 'PUT') return { allowed: false, refusal: null, reason: null };

  const match = PAIR_WITNESS_PROPERTY_PATH.exec(String(options.pathname || ''));
  if (!match) return { allowed: false, refusal: null, reason: null };
  const issueId = match[1];

  const refuse = (reason, details = {}) => ({
    allowed: false,
    refusal: 'PERMIT_INVALID',
    reason,
    message: pairWitnessPermitMessage(reason),
    details
  });

  let stored;
  try {
    stored = await deps.getStored(PAIR_WITNESS_PERMIT_KEY);
  } catch {
    return refuse(PAIR_WITNESS_PERMIT_REASONS.PERMIT_MISSING);
  }
  if (stored === null || stored === undefined) {
    return refuse(PAIR_WITNESS_PERMIT_REASONS.PERMIT_MISSING);
  }
  const permit = normalizePermit(stored);
  if (!permit) return refuse(PAIR_WITNESS_PERMIT_REASONS.PERMIT_MALFORMED);

  const identity = readIdentity(deps.getContext);
  if (!identity) return refuse(PAIR_WITNESS_PERMIT_REASONS.IDENTITY_UNAVAILABLE);
  if (permit.installationId !== identity.installationId || permit.appId !== identity.appId) {
    return refuse(PAIR_WITNESS_PERMIT_REASONS.PERMIT_FOREIGN_INSTALLATION);
  }

  const now = Number(deps.now());
  if (!(permit.expiresAt > now)) {
    return refuse(PAIR_WITNESS_PERMIT_REASONS.PERMIT_EXPIRED);
  }

  const raw = String(options.raw ?? '');
  const absolute = /^https?:\/\//i.test(raw);
  let site;
  if (absolute) {
    try {
      site = new URL(raw).hostname.toLowerCase();
    } catch {
      return refuse(PAIR_WITNESS_PERMIT_REASONS.PERMIT_SITE_NOT_APPROVED);
    }
  } else {
    site = 'local';
  }

  if (!permit.entries.some((entry) => entry.issueId === issueId)) {
    return refuse(PAIR_WITNESS_PERMIT_REASONS.PERMIT_ISSUE_NOT_APPROVED, { issueId, site });
  }
  const entry = permit.entries.find((candidate) => candidate.site === site
    && candidate.issueId === issueId);
  if (!entry) {
    return refuse(PAIR_WITNESS_PERMIT_REASONS.PERMIT_SITE_NOT_APPROVED, { issueId, site });
  }

  if (typeof options.body !== 'string' || options.body === '') {
    return refuse(PAIR_WITNESS_PERMIT_REASONS.PERMIT_PAYLOAD_MISMATCH);
  }
  let parsedBody;
  try {
    parsedBody = JSON.parse(options.body);
  } catch {
    return refuse(PAIR_WITNESS_PERMIT_REASONS.PERMIT_PAYLOAD_MISMATCH);
  }
  const parsed = parsePairWitnessValue(parsedBody);
  if (!parsed.ok) {
    return refuse(PAIR_WITNESS_PERMIT_REASONS.PERMIT_PAYLOAD_MISMATCH, { code: parsed.code });
  }
  if (parsed.record.pairId !== entry.pairId) {
    return refuse(PAIR_WITNESS_PERMIT_REASONS.PERMIT_PAIR_MISMATCH);
  }
  if (pairWitnessPayloadDigest(parsed.record) !== entry.payloadDigest) {
    return refuse(PAIR_WITNESS_PERMIT_REASONS.PERMIT_PAYLOAD_MISMATCH);
  }
  if (parsed.record.orgId !== permit.orgId) {
    return refuse(PAIR_WITNESS_PERMIT_REASONS.PERMIT_PAYLOAD_MISMATCH, { orgId: parsed.record.orgId });
  }

  let plan;
  try {
    plan = await deps.getStored(PAIR_WITNESS_PLAN_KEY(permit.orgId));
  } catch {
    return refuse(PAIR_WITNESS_PERMIT_REASONS.PLAN_NOT_APPROVED);
  }
  if (!isPlainObject(plan) || plan.version !== PAIR_WITNESS_PLAN_VERSION) {
    return refuse(PAIR_WITNESS_PERMIT_REASONS.PLAN_NOT_APPROVED);
  }
  if (plan.digest !== permit.planDigest) {
    return refuse(PAIR_WITNESS_PERMIT_REASONS.PERMIT_PLAN_MISMATCH);
  }
  if (plan.status !== 'approved' && plan.status !== 'running') {
    return refuse(PAIR_WITNESS_PERMIT_REASONS.PLAN_NOT_APPROVED, { status: plan.status });
  }
  if (!(Number(plan.expiresAt) > now)) {
    return refuse(PAIR_WITNESS_PERMIT_REASONS.PLAN_EXPIRED);
  }

  try {
    await assertPauseConfirmedOn(deps);
  } catch (error) {
    return refuse(error.reason || PAIR_WITNESS_PERMIT_REASONS.PAUSE_UNREADABLE);
  }
  try {
    await assertNoRestoreInProgress(deps);
  } catch (error) {
    return refuse(error.reason || PAIR_WITNESS_PERMIT_REASONS.RESTORE_UNREADABLE);
  }

  let marker;
  try {
    marker = await deps.getStored(PAIR_WITNESS_WRITE_MARKER_KEY(permit.orgId, site, issueId));
  } catch {
    return refuse(PAIR_WITNESS_PERMIT_REASONS.PERMIT_ALREADY_WRITTEN);
  }
  if (marker !== null && marker !== undefined) {
    return refuse(PAIR_WITNESS_PERMIT_REASONS.PERMIT_ALREADY_WRITTEN);
  }

  if (typeof deps.audit === 'function') {
    try {
      await deps.audit({
        action: 'pair_witness_property_write',
        outcome: 'permitted',
        orgId: permit.orgId,
        site,
        issueId,
        permitId: permit.permitId,
        pairId: entry.pairId,
        batchIndex: permit.batchIndex
      });
    } catch {
      // Audit must not decide whether a permitted write proceeds.
    }
  }

  return { allowed: true, refusal: null, reason: null, permit, entry, plan, site };
}


/**
 * Mints one batch permit. Always a fresh record for one batch slice: entries are
 * the exact (site, issue, pair, payload) tuples this batch may write.
 */
export async function issuePairWitnessPermit(options = {}) {
  const deps = { ...defaultDeps, ...(options.deps || {}) };
  const entries = Array.isArray(options.entries) ? options.entries : [];
  if (entries.length === 0) {
    throw new PairWitnessPermitError(PAIR_WITNESS_PERMIT_REASONS.PERMIT_MALFORMED, {
      field: 'entries'
    });
  }
  const now = Number(deps.now());
  const permit = {
    version: PAIR_WITNESS_PERMIT_VERSION,
    permitId: `pw_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    orgId: options.orgId,
    planDigest: options.planDigest,
    installationId: options.installationId,
    appId: options.appId,
    localSite: options.localSite,
    batchIndex: Number.isInteger(options.batchIndex) ? options.batchIndex : 0,
    issuedAt: new Date(now).toISOString(),
    issuedBy: typeof options.accountId === 'string' ? options.accountId.slice(0, 100) : null,
    expiresAt: now + PAIR_WITNESS_PERMIT_TTL_SECONDS * 1000,
    entries: entries.map((entry) => ({
      site: entry.site,
      issueId: String(entry.issueId),
      pairId: entry.pairId,
      payloadDigest: entry.payloadDigest
    }))
  };
  if (typeof deps.setStoredWithTtl === 'function') {
    await deps.setStoredWithTtl(PAIR_WITNESS_PERMIT_KEY, permit, PAIR_WITNESS_PERMIT_TTL_SECONDS);
  } else {
    await deps.setStored(PAIR_WITNESS_PERMIT_KEY, permit);
  }
  return permit;
}

export async function readPairWitnessPermit(deps = {}) {
  const merged = { ...defaultDeps, ...deps };
  try {
    const stored = await merged.getStored(PAIR_WITNESS_PERMIT_KEY);
    return stored === null || stored === undefined ? null : normalizePermit(stored);
  } catch {
    return null;
  }
}

/** Revokes the permit. Never touches a Jira property. */
export async function revokePairWitnessPermit(deps = {}) {
  const merged = { ...defaultDeps, ...deps };
  try {
    await merged.deleteKey(PAIR_WITNESS_PERMIT_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Single-flight batch ownership.
 *
 * `setIfNotExists` is an atomic create-if-absent with a native TTL, so two
 * concurrent invocations cannot both own a batch. The TTL bounds the damage of a
 * crashed batch to one lock lifetime; no counter is involved.
 */
export async function acquirePairWitnessBatchLock(options = {}) {
  const deps = { ...defaultDeps, ...(options.deps || {}) };
  const now = Number(deps.now());
  const token = typeof options.token === 'string' && options.token !== ''
    ? options.token
    : `lock_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const record = { token, acquiredAt: now, expiresAt: now + PAIR_WITNESS_LOCK_TTL_SECONDS * 1000 };
  try {
    if (typeof deps.setIfNotExists === 'function') {
      await deps.setIfNotExists(PAIR_WITNESS_BATCH_LOCK_KEY, record, PAIR_WITNESS_LOCK_TTL_SECONDS);
    } else {
      await deps.setStored(PAIR_WITNESS_BATCH_LOCK_KEY, record);
    }
  } catch (error) {
    const code = error?.code || '';
    if (code === 'KEY_ALREADY_EXISTS' || /exists/i.test(String(error?.message || ''))) {
      throw new PairWitnessPermitError(PAIR_WITNESS_PERMIT_REASONS.LOCK_HELD);
    }
    throw error;
  }
  return { token, expiresAt: record.expiresAt };
}

export async function releasePairWitnessBatchLock(lock, deps = {}) {
  const merged = { ...defaultDeps, ...deps };
  try {
    const stored = await merged.getStored(PAIR_WITNESS_BATCH_LOCK_KEY);
    if (isPlainObject(stored) && lock && stored.token !== lock.token) return false;
    await merged.deleteKey(PAIR_WITNESS_BATCH_LOCK_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-asserts batch ownership immediately before a property write.
 *
 * A lock with a fixed TTL would otherwise let a second invocation acquire it
 * while the first is still submitting, producing two writers for one pair. This
 * check is deliberately fail-closed: an unreadable, absent or foreign lock stops
 * the batch before the next PUT, and the remaining pairs stay pending for the
 * next run. When less than half the TTL is left the lock is extended, so a slow
 * but healthy batch keeps its ownership.
 */
export async function assertPairWitnessBatchLockOwner({ lock, deps = {} } = {}) {
  const merged = { ...defaultDeps, ...deps };
  if (!lock || typeof lock.token !== 'string' || lock.token === '') {
    throw new PairWitnessPermitError(PAIR_WITNESS_PERMIT_REASONS.LOCK_LOST, {
      reason: 'no-local-lock'
    });
  }

  let stored;
  try {
    stored = await merged.getStored(PAIR_WITNESS_BATCH_LOCK_KEY);
  } catch {
    throw new PairWitnessPermitError(PAIR_WITNESS_PERMIT_REASONS.LOCK_LOST, {
      reason: 'unreadable'
    });
  }
  if (!isPlainObject(stored) || stored.token !== lock.token) {
    throw new PairWitnessPermitError(PAIR_WITNESS_PERMIT_REASONS.LOCK_LOST, {
      reason: stored ? 'foreign-token' : 'expired'
    });
  }

  const now = Number(merged.now());
  const expiresAt = Number(stored.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    throw new PairWitnessPermitError(PAIR_WITNESS_PERMIT_REASONS.LOCK_LOST, {
      reason: 'expired'
    });
  }

  const halfTtl = (PAIR_WITNESS_LOCK_TTL_SECONDS * 1000) / 2;
  if (!Number.isFinite(expiresAt) || expiresAt - now < halfTtl) {
    const renewed = {
      token: lock.token,
      acquiredAt: Number.isFinite(Number(stored.acquiredAt)) ? Number(stored.acquiredAt) : now,
      expiresAt: now + PAIR_WITNESS_LOCK_TTL_SECONDS * 1000
    };
    try {
      if (typeof merged.setStoredWithTtl === 'function') {
        await merged.setStoredWithTtl(
          PAIR_WITNESS_BATCH_LOCK_KEY,
          renewed,
          PAIR_WITNESS_LOCK_TTL_SECONDS
        );
      } else {
        await merged.setStored(PAIR_WITNESS_BATCH_LOCK_KEY, renewed);
      }
    } catch {
      throw new PairWitnessPermitError(PAIR_WITNESS_PERMIT_REASONS.LOCK_LOST, {
        reason: 'renewal-failed'
      });
    }
    lock.expiresAt = renewed.expiresAt;
  }

  return true;
}

/** Records that one issue has been written, so a second permit cannot repeat it. */
export async function markPairWitnessWritten({ orgId, site, issueId, pairId }, deps = {}) {
  const merged = { ...defaultDeps, ...deps };
  const key = PAIR_WITNESS_WRITE_MARKER_KEY(orgId, site, issueId);
  try {
    if (typeof merged.setIfNotExists === 'function') {
      await merged.setIfNotExists(key, {
        pairId,
        writtenAt: new Date(Number(merged.now())).toISOString()
      }, 30 * 24 * 3600);
      return true;
    }
    await merged.setStored(key, { pairId, writtenAt: new Date(Number(merged.now())).toISOString() });
    return true;
  } catch (error) {
    const code = error?.code || '';
    if (code === 'KEY_ALREADY_EXISTS' || /exists/i.test(String(error?.message || ''))) return false;
    throw error;
  }
}

