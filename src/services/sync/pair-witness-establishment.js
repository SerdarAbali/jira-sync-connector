import * as kvsStore from '../storage/kvs.js';
import { isValidIssueKey } from '../storage/mappings.js';
import { logAuditEntry } from '../storage/stats.js';
import {
  PAIR_WITNESS_ISSUE_CLASSES,
  PAIR_WITNESS_READ_CLASSES,
  PAIR_WITNESS_STATES,
  buildPairWitness,
  deterministicPairId,
  readIssueIdentity,
  readPairWitness,
  sameWitnessPairIdentity
} from './pair-witness.js';
import {
  PAIR_WITNESS_WRITE_OUTCOMES,
  putWitnessProperty,
  verifyWitnessWrite
} from './pair-witness-write.js';
import { readWitnessIdentity } from '../readiness/connector-readiness.js';

/**
 * Establishes the Jira-side pairing witness for a pair that was just created.
 *
 * The issue-create ledger and the Forge mapping remain the operational records.
 * This module only mirrors the pair into Jira so a later loss of Forge storage
 * can be detected. It never creates an issue, never retries a create, and never
 * overwrites contradictory evidence.
 *
 * Ordering is fixed: local property, read-back, remote property, read-back. A
 * failed local side stops the remote write, so a pair is never witnessed on the
 * harder-to-reach site first.
 */

export const PAIR_WITNESS_STATE_PREFIX = 'pair-witness-state';
export const PAIR_WITNESS_STATE_VERSION = 1;

export const WITNESS_ESTABLISHMENT_OUTCOMES = Object.freeze({
  APPLIED: 'witness-established',
  ALREADY_PRESENT: 'witness-already-present',
  PARTIAL: 'witness-partial',
  FAILED: 'witness-establishment-failed',
  READ_BACK_FAILED: 'witness-read-back-failed',
  CONFLICT: 'witness-conflict',
  DEFERRED: 'witness-deferred',
  BLOCKED: 'witness-blocked',
  UNAVAILABLE: 'witness-unavailable',
  NOT_APPLICABLE: 'witness-not-applicable',
  MAPPING_PERSISTENCE_FAILED: 'witness-skipped-mapping-failure',
  LEDGER_PERSISTENCE_FAILED: 'witness-skipped-ledger-failure'
});

const ORG_ID_PATTERN = /^org-\d+$/;
const ISSUE_ID_PATTERN = /^\d{1,32}$/;
const SUCCESS_OUTCOMES = new Set([
  WITNESS_ESTABLISHMENT_OUTCOMES.APPLIED,
  WITNESS_ESTABLISHMENT_OUTCOMES.ALREADY_PRESENT,
  // Legacy scope cannot carry a witness; it is a neutral, expected result rather
  // than a failure that would add a warning to every legacy create.
  WITNESS_ESTABLISHMENT_OUTCOMES.NOT_APPLICABLE
]);
const BLOCKED_CODES = new Set([
  'PILOT_PAUSED',
  'PAUSE_STATE_UNAVAILABLE',
  'SYNC_RESTORE_IN_PROGRESS'
]);
const SAFE_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;

const defaultDeps = {
  readIdentity: readWitnessIdentity,
  readIssue: readIssueIdentity,
  readWitness: readPairWitness,
  putWitness: putWitnessProperty,
  verifyWrite: verifyWitnessWrite,
  storeState: (key, value) => kvsStore.set(key, value),
  getState: (key) => kvsStore.get(key),
  auditWrite: logAuditEntry,
  now: () => Date.now()
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isIssueId(value) {
  return typeof value === 'string' && ISSUE_ID_PATTERN.test(value);
}

function safeCode(value) {
  return typeof value === 'string' && SAFE_CODE_PATTERN.test(value) ? value : null;
}

function hostFromUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    return /^[a-z0-9][a-z0-9.-]{0,252}$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

export function buildPairWitnessStateKey(orgId, localKey, remoteKey) {
  return `${PAIR_WITNESS_STATE_PREFIX}:${orgId}:${localKey}:${remoteKey}`;
}

/** Reads the last sanitized establishment state for one pair. */
export async function getPairWitnessState({ orgId, localKey, remoteKey, deps = {} } = {}) {
  if (typeof orgId !== 'string' || !ORG_ID_PATTERN.test(orgId)
      || !isValidIssueKey(localKey) || !isValidIssueKey(remoteKey)) {
    return null;
  }
  const merged = { ...defaultDeps, ...deps };
  try {
    return await merged.getState(buildPairWitnessStateKey(orgId, localKey, remoteKey));
  } catch {
    return null;
  }
}

/**
 * Persists a bounded, content-free attention record and an audit entry. A
 * storage or audit failure never changes the synchronization result.
 */
export async function recordPairWitnessState({
  orgId,
  localKey,
  remoteKey,
  pairId = null,
  outcome,
  reason = null,
  local = null,
  remote = null,
  targetKey = null,
  deps = {}
} = {}) {
  const merged = { ...defaultDeps, ...deps };
  if (typeof orgId !== 'string' || !ORG_ID_PATTERN.test(orgId)
      || !isValidIssueKey(localKey) || !isValidIssueKey(remoteKey)) {
    return null;
  }
  const record = {
    version: PAIR_WITNESS_STATE_VERSION,
    orgId,
    localKey,
    remoteKey,
    pairId: typeof pairId === 'string' ? pairId : null,
    outcome: safeCode(outcome) || 'witness-state-unknown',
    reason: safeCode(reason),
    local: isPlainObject(local) ? local : null,
    remote: isPlainObject(remote) ? remote : null,
    targetKey: isValidIssueKey(targetKey) ? targetKey : null,
    updatedAt: new Date(Number(merged.now())).toISOString()
  };

  try {
    await merged.storeState(buildPairWitnessStateKey(orgId, localKey, remoteKey), record);
  } catch {
    // Attention is advisory. The operational mapping/ledger records are primary.
  }

  try {
    await merged.auditWrite({
      action: 'pair-witness-establishment',
      orgId,
      sourceIssue: localKey,
      targetIssue: remoteKey,
      success: SUCCESS_OUTCOMES.has(record.outcome),
      pairId: record.pairId,
      status: record.outcome,
      reason: record.reason || undefined,
      errors: [record.outcome, record.reason].filter(Boolean)
    });
  } catch {
    // Auditing is best-effort by design.
  }

  return record;
}

/**
 * A replacement may supersede a witness only when the existing record proves
 * exactly the previous pair. Anything else is a conflict and is left untouched.
 */
function witnessMatchesReplacement(record, replacement, side) {
  if (!isPlainObject(record) || !isPlainObject(replacement)) return false;
  if (record.state !== PAIR_WITNESS_STATES.ACTIVE) return false;
  if (side === 'local') {
    const localIdOk = !replacement.localIssueId || record.localIssueId === replacement.localIssueId;
    return localIdOk && record.remoteKey === replacement.remoteKey;
  }
  const remoteIdOk = !replacement.remoteIssueId || record.remoteIssueId === replacement.remoteIssueId;
  return remoteIdOk && record.localKey === replacement.localKey;
}

async function writeWitnessSide({ side, issueId, org, record, deps }) {
  const write = await deps.putWitness({
    side,
    issueId,
    org,
    body: JSON.stringify(record)
  });
  const statusCode = Number.isFinite(Number(write?.statusCode)) ? Number(write.statusCode) : null;

  if (write?.outcome === PAIR_WITNESS_WRITE_OUTCOMES.APPLIED) {
    const verified = await deps.verifyWrite({ side, issueId, org, record });
    if (verified.verified === true) {
      return { status: 'verified', code: null, statusCode };
    }
    return {
      status: verified.absent === true ? 'read-back-absent' : 'read-back-mismatch',
      code: safeCode(verified.code) || safeCode(verified.readClass),
      statusCode
    };
  }
  if (write?.outcome === PAIR_WITNESS_WRITE_OUTCOMES.DEFERRED) {
    return {
      status: 'deferred',
      code: safeCode(write.reason) || 'PAIR_WITNESS_WRITE_DEFERRED',
      statusCode
    };
  }
  if (write?.outcome === PAIR_WITNESS_WRITE_OUTCOMES.CONFLICT) {
    return {
      status: 'conflict',
      code: safeCode(write.reason) || safeCode(write.code) || 'PAIR_WITNESS_WRITE_REFUSED',
      statusCode
    };
  }
  return {
    status: 'failed',
    code: safeCode(write?.code) || 'PAIR_WITNESS_WRITE_FAILED',
    statusCode
  };
}

async function establishSide({ side, issueId, org, record, replacement, deps }) {
  let existing;
  try {
    existing = await deps.readWitness({
      side,
      issueRef: issueId,
      org,
      expected: {
        installationId: record.installationId,
        appId: record.appId,
        orgId: record.orgId,
        localSite: record.localSite,
        remoteSite: record.remoteSite,
        issueId
      }
    });
  } catch {
    return { status: 'unverifiable', code: 'PAIR_WITNESS_READ_UNVERIFIABLE' };
  }

  if (existing.class === PAIR_WITNESS_READ_CLASSES.MATCHING) {
    if (sameWitnessPairIdentity(existing.record, record)) {
      return { status: 'identical', code: null, statusCode: existing.statusCode ?? null };
    }
    if (replacement && witnessMatchesReplacement(existing.record, replacement, side)) {
      return writeWitnessSide({ side, issueId, org, record, deps });
    }
    return { status: 'conflict', code: 'PAIR_WITNESS_PAIR_CONFLICT', statusCode: existing.statusCode ?? null };
  }
  if (existing.class === PAIR_WITNESS_READ_CLASSES.ABSENT) {
    return writeWitnessSide({ side, issueId, org, record, deps });
  }
  if (existing.class === PAIR_WITNESS_READ_CLASSES.INACCESSIBLE) {
    return { status: 'inaccessible', code: 'PAIR_WITNESS_INACCESSIBLE', statusCode: existing.statusCode ?? null };
  }
  return {
    status: 'unverifiable',
    code: safeCode(existing.code) || 'PAIR_WITNESS_READ_UNVERIFIABLE',
    statusCode: existing.statusCode ?? null
  };
}

function isEstablishedStatus(status) {
  return status === 'verified' || status === 'identical';
}

function outcomeForSides(local, remote) {
  if (local.status === 'conflict' || remote?.status === 'conflict') {
    return WITNESS_ESTABLISHMENT_OUTCOMES.CONFLICT;
  }
  if (local.status === 'read-back-absent' || local.status === 'read-back-mismatch'
      || remote?.status === 'read-back-absent' || remote?.status === 'read-back-mismatch') {
    return WITNESS_ESTABLISHMENT_OUTCOMES.READ_BACK_FAILED;
  }
  if (local.status === 'deferred' || remote?.status === 'deferred') {
    return WITNESS_ESTABLISHMENT_OUTCOMES.DEFERRED;
  }
  if (BLOCKED_CODES.has(local.code) || BLOCKED_CODES.has(remote?.code)) {
    return WITNESS_ESTABLISHMENT_OUTCOMES.BLOCKED;
  }
  if (isEstablishedStatus(local.status) && isEstablishedStatus(remote?.status)) {
    return local.status === 'identical' && remote.status === 'identical'
      ? WITNESS_ESTABLISHMENT_OUTCOMES.ALREADY_PRESENT
      : WITNESS_ESTABLISHMENT_OUTCOMES.APPLIED;
  }
  if (isEstablishedStatus(local.status) && remote) {
    return WITNESS_ESTABLISHMENT_OUTCOMES.PARTIAL;
  }
  if (isEstablishedStatus(local.status) && !remote) {
    return WITNESS_ESTABLISHMENT_OUTCOMES.PARTIAL;
  }
  return WITNESS_ESTABLISHMENT_OUTCOMES.FAILED;
}


/**
 * Establish the witness for one created pair. Never throws and never retries a
 * create. The caller's mapping and ledger stay authoritative.
 *
 * @returns {Promise<{success:boolean, outcome:string, code:string|null,
 *   pairId:string|null, local:object|null, remote:object|null}>}
 */
export async function establishPairWitness({
  orgId = null,
  org = null,
  localKey,
  remoteKey,
  localIssueId = null,
  remoteIssueId = null,
  direction = 'local-to-remote',
  replacement = null,
  deps = {}
} = {}) {
  const merged = { ...defaultDeps, ...deps };
  const state = {
    orgId,
    localKey,
    remoteKey,
    pairId: null,
    outcome: WITNESS_ESTABLISHMENT_OUTCOMES.UNAVAILABLE,
    reason: null,
    local: null,
    remote: null
  };

  const finish = async (overrides = {}) => {
    const record = await recordPairWitnessState({ ...state, ...overrides, deps: merged });
    return {
      success: SUCCESS_OUTCOMES.has(record?.outcome || overrides.outcome),
      outcome: record?.outcome || overrides.outcome || state.outcome,
      code: record?.reason || overrides.reason || null,
      pairId: record?.pairId || overrides.pairId || null,
      local: record?.local || overrides.local || null,
      remote: record?.remote || overrides.remote || null
    };
  };

  try {
    if (typeof orgId !== 'string' || !ORG_ID_PATTERN.test(orgId)) {
      return await finish({
        outcome: WITNESS_ESTABLISHMENT_OUTCOMES.NOT_APPLICABLE,
        reason: 'PAIR_WITNESS_NOT_APPLICABLE_LEGACY'
      });
    }
    if (!isValidIssueKey(localKey) || !isValidIssueKey(remoteKey) || !isPlainObject(org)) {
      return await finish({ reason: 'PAIR_WITNESS_INVALID_PAIR' });
    }
    const remoteSite = hostFromUrl(org.remoteUrl);
    if (!remoteSite) {
      return await finish({ reason: 'PAIR_WITNESS_ORGANIZATION_UNUSABLE' });
    }

    let identity;
    try {
      identity = await merged.readIdentity();
    } catch {
      identity = null;
    }
    if (!identity || identity.readable !== true
        || typeof identity.appId !== 'string'
        || typeof identity.installationId !== 'string'
        || typeof identity.localSite !== 'string') {
      return await finish({ reason: 'PAIR_WITNESS_IDENTITY_UNAVAILABLE' });
    }

    let resolvedLocalId = isIssueId(localIssueId) ? localIssueId : null;
    let resolvedRemoteId = isIssueId(remoteIssueId) ? remoteIssueId : null;
    let resolvedLocalKey = localKey;
    let resolvedRemoteKey = remoteKey;

    if (!resolvedLocalId) {
      const local = await merged.readIssue({ side: 'local', issueRef: localKey, org });
      if (local.class !== PAIR_WITNESS_ISSUE_CLASSES.PRESENT || !isIssueId(local.id)) {
        return await finish({ reason: 'PAIR_WITNESS_LOCAL_ISSUE_UNVERIFIABLE' });
      }
      resolvedLocalId = local.id;
      if (isValidIssueKey(local.key)) resolvedLocalKey = local.key;
    }
    if (!resolvedRemoteId) {
      const remote = await merged.readIssue({ side: 'remote', issueRef: remoteKey, org });
      if (remote.class !== PAIR_WITNESS_ISSUE_CLASSES.PRESENT || !isIssueId(remote.id)) {
        return await finish({ reason: 'PAIR_WITNESS_REMOTE_ISSUE_UNVERIFIABLE' });
      }
      resolvedRemoteId = remote.id;
      if (isValidIssueKey(remote.key)) resolvedRemoteKey = remote.key;
    }

    let pairId;
    try {
      pairId = deterministicPairId({
        installationId: identity.installationId,
        orgId,
        localIssueId: resolvedLocalId,
        remoteIssueId: resolvedRemoteId
      });
    } catch {
      return await finish({ reason: 'PAIR_WITNESS_PAIR_ID_INVALID' });
    }

    const record = buildPairWitness({
      pairId,
      state: PAIR_WITNESS_STATES.ACTIVE,
      installationId: identity.installationId,
      appId: identity.appId,
      orgId,
      localSite: identity.localSite,
      remoteSite,
      localIssueId: resolvedLocalId,
      localKey: resolvedLocalKey,
      remoteIssueId: resolvedRemoteId,
      remoteKey: resolvedRemoteKey,
      direction: direction === 'remote-to-local' ? 'remote-to-local' : 'local-to-remote',
      writtenAt: new Date(Number(merged.now())).toISOString()
    });

    // The record keeps the caller's mapping keys for display; identity is the id.
    state.pairId = pairId;
    state.localKey = localKey;
    state.remoteKey = remoteKey;


    // Local first, then read back. A local failure leaves the remote untouched.
    const local = await establishSide({
      side: 'local',
      issueId: resolvedLocalId,
      org,
      record,
      replacement,
      deps: merged
    });
    if (!isEstablishedStatus(local.status)) {
      return await finish({
        outcome: outcomeForSides(local, null),
        reason: local.code,
        local,
        remote: null
      });
    }

    const remote = await establishSide({
      side: 'remote',
      issueId: resolvedRemoteId,
      org,
      record,
      replacement,
      deps: merged
    });

    return await finish({
      outcome: outcomeForSides(local, remote),
      reason: remote.code || local.code || null,
      local,
      remote
    });
  } catch (error) {
    return await finish({
      outcome: WITNESS_ESTABLISHMENT_OUTCOMES.FAILED,
      reason: safeCode(error?.code) || 'PAIR_WITNESS_ESTABLISHMENT_ERROR'
    });
  }
}

/**
 * Records that a created issue could not be bound to its mapping or ledger.
 * No witness is written in this case: an unbound issue must stay an explicit
 * recovery item rather than being legitimized by Jira-side evidence.
 */
export async function recordWitnessPersistenceFailure({
  orgId = null,
  localKey,
  remoteKey,
  targetKey = null,
  outcome,
  reason = null,
  deps = {}
} = {}) {
  const merged = { ...defaultDeps, ...deps };
  const record = await recordPairWitnessState({
    orgId,
    localKey,
    remoteKey,
    targetKey,
    outcome: outcome || WITNESS_ESTABLISHMENT_OUTCOMES.FAILED,
    reason: reason || 'PAIR_WITNESS_PERSISTENCE_FAILED',
    deps: merged
  });
  return {
    success: false,
    outcome: record?.outcome || outcome || WITNESS_ESTABLISHMENT_OUTCOMES.FAILED,
    reason: record?.reason || reason || null,
    targetKey: record?.targetKey || null
  };
}

