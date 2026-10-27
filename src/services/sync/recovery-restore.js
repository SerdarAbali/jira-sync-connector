import * as kvsStore from '../storage/kvs.js';
import { createHash, randomBytes } from 'crypto';
import {
  getOrganizationsWithTokens,
  storeMapping,
  getRemoteKey,
  getLocalKey,
  isValidIssueKey
} from '../storage/mappings.js';
import { logAuditEntry } from '../storage/stats.js';
import { getPilotPause } from './pilot-pause.js';
import { readForgeInstallationIdentity } from '../readiness/connector-readiness.js';
import { setSyncAuthorizationState, SYNC_AUTHORIZATION_STATES } from './sync-authorization.js';
import { buildIssueCreateOperationKey, ISSUE_CREATE_STATES } from './issue-create-operation.js';
import { previewRestoreSnapshot } from './recovery-snapshot-preview.js';
import { stableStringify } from './recovery-snapshot.js';
import {
  PAIR_WITNESS_ISSUE_CLASSES,
  PAIR_WITNESS_READ_CLASSES,
  PAIR_WITNESS_SIDES,
  deterministicPairId,
  readIssueIdentity,
  readPairWitness,
  sameWitnessPairIdentity
} from './pair-witness.js';
import { counterpartStatusBlocksSync } from './counterpart-status.js';

/**
 * Controlled recovery from a previously exported recovery snapshot.
 *
 * This is a Forge-storage repair, not a synchronization path. It never creates,
 * updates or deletes a Jira issue, never searches, and never changes the pause
 * state. It restores only missing mapping pairs and the succeeded create-ledger
 * rows that point at those pairs. Evidence sections are consulted as blockers;
 * they are never resurrected by the restore.
 *
 * The workflow is deliberately split into immutable plan -> explicit approval
 * -> bounded, resumable batches:
 *   1. Preview re-parses the file, verifies identity/routing, classifies every
 *      pair against live storage and reads both pairing witnesses.
 *   2. A plan stores the exact selected candidates under a digest.
 *   3. Approval re-reads every fact and puts synchronization authorization into
 *      `restore-in-progress`; it never restores authorization itself.
 *   4. Each batch re-reads the pair, witness and ledger immediately before a
 *      write, writes at most one mapping and its succeeded ledger rows, and
 *      persists progress after every item.
 *   5. Completion leaves the pause untouched and sets authorization to
 *      `blocked`, so synchronization can never resume as a side effect.
 */

export const RECOVERY_RESTORE_VERSION = 1;
export const RECOVERY_RESTORE_PLAN_TTL_SECONDS = 3600;
export const RECOVERY_RESTORE_LOCK_TTL_SECONDS = 120;
export const RECOVERY_RESTORE_BATCH_SIZE = 10;
export const RECOVERY_RESTORE_MAX_BATCH_SIZE = 50;
export const RECOVERY_RESTORE_MAX_PAIRS = 200;
export const RECOVERY_RESTORE_PLAN_KEY = (orgId) => `recoveryRestorePlan:${orgId}`;
export const RECOVERY_RESTORE_LOCK_KEY = 'recoveryRestoreLock';

export const RECOVERY_RESTORE_PLAN_STATES = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  RUNNING: 'running',
  COMPLETED: 'completed',
  NEEDS_ATTENTION: 'needs-attention',
  CANCELLED: 'cancelled'
});

export const RECOVERY_RESTORE_ITEM_STATES = Object.freeze({
  PENDING: 'pending',
  RESTORED: 'restored',
  PRESENT: 'present',
  PARTIAL: 'partial',
  CONFLICT: 'conflict',
  EXCLUDED: 'excluded'
});

export const RECOVERY_RESTORE_WITNESS_CLASSES = Object.freeze({
  CONFIRMED: 'confirmed',
  ABSENT: 'absent',
  BLOCKED: 'blocked'
});

export const RECOVERY_RESTORE_ERRORS = Object.freeze({
  ORGANIZATION_INVALID: 'RECOVERY_RESTORE_ORGANIZATION_INVALID',
  ORGANIZATION_NOT_FOUND: 'RECOVERY_RESTORE_ORGANIZATION_NOT_FOUND',
  ORGANIZATION_UNUSABLE: 'RECOVERY_RESTORE_ORGANIZATION_UNUSABLE',
  PAUSE_REQUIRED: 'RECOVERY_RESTORE_PAUSE_REQUIRED',
  PAUSE_UNREADABLE: 'RECOVERY_RESTORE_PAUSE_UNREADABLE',
  PREVIEW_FAILED: 'RECOVERY_RESTORE_PREVIEW_FAILED',
  SNAPSHOT_NOT_RECOVERABLE: 'RECOVERY_RESTORE_SNAPSHOT_NOT_RECOVERABLE',
  SELECTION_INVALID: 'RECOVERY_RESTORE_SELECTION_INVALID',
  PLAN_EMPTY: 'RECOVERY_RESTORE_PLAN_EMPTY',
  PLAN_MISSING: 'RECOVERY_RESTORE_PLAN_MISSING',
  PLAN_EXPIRED: 'RECOVERY_RESTORE_PLAN_EXPIRED',
  PLAN_NOT_APPROVED: 'RECOVERY_RESTORE_PLAN_NOT_APPROVED',
  PLAN_DIGEST_MISMATCH: 'RECOVERY_RESTORE_PLAN_DIGEST_MISMATCH',
  CONFIRMATION_REQUIRED: 'RECOVERY_RESTORE_CONFIRMATION_REQUIRED',
  CONFIRMATION_MISMATCH: 'RECOVERY_RESTORE_CONFIRMATION_MISMATCH',
  APPROVAL_STALE: 'RECOVERY_RESTORE_APPROVAL_STALE',
  AUTHORIZATION_UNAVAILABLE: 'RECOVERY_RESTORE_AUTHORIZATION_UNAVAILABLE',
  NOT_ARMED: 'RECOVERY_RESTORE_NOT_ARMED',
  BUSY: 'RECOVERY_RESTORE_BUSY',
  APPLY_FAILED: 'RECOVERY_RESTORE_APPLY_FAILED',
  CANCELLED: 'RECOVERY_RESTORE_CANCELLED'
});

export const RECOVERY_RESTORE_MESSAGES = Object.freeze({
  [RECOVERY_RESTORE_ERRORS.ORGANIZATION_INVALID]:
    'A configured organization id is required. Legacy scope cannot be restored.',
  [RECOVERY_RESTORE_ERRORS.ORGANIZATION_NOT_FOUND]:
    'The selected organization is not configured.',
  [RECOVERY_RESTORE_ERRORS.ORGANIZATION_UNUSABLE]:
    'The organization has no usable remote site or credentials, so witnesses cannot be verified.',
  [RECOVERY_RESTORE_ERRORS.PAUSE_REQUIRED]:
    'Pause synchronization before previewing, approving or restoring. Restore never changes the pause state.',
  [RECOVERY_RESTORE_ERRORS.PAUSE_UNREADABLE]:
    'The emergency pause state could not be read, so restore was refused.',
  [RECOVERY_RESTORE_ERRORS.PREVIEW_FAILED]:
    'The snapshot could not be validated against this installation and organization.',
  [RECOVERY_RESTORE_ERRORS.SNAPSHOT_NOT_RECOVERABLE]:
    'This snapshot is not sufficient for recovery after storage loss. Nothing was written.',
  [RECOVERY_RESTORE_ERRORS.SELECTION_INVALID]:
    'The selected pairs are not a valid subset of this snapshot\'s restorable candidates.',
  [RECOVERY_RESTORE_ERRORS.PLAN_EMPTY]:
    'No pair can be restored from this snapshot in the current state. Nothing was written.',
  [RECOVERY_RESTORE_ERRORS.PLAN_MISSING]:
    'No restore plan exists for this organization. Create and approve a fresh plan.',
  [RECOVERY_RESTORE_ERRORS.PLAN_EXPIRED]:
    'The restore plan has expired. Create and approve a fresh plan.',
  [RECOVERY_RESTORE_ERRORS.PLAN_NOT_APPROVED]:
    'The restore plan is not approved, or is no longer runnable.',
  [RECOVERY_RESTORE_ERRORS.PLAN_DIGEST_MISMATCH]:
    'The restore plan no longer matches its approved digest. Nothing was written.',
  [RECOVERY_RESTORE_ERRORS.CONFIRMATION_REQUIRED]:
    'Type the exact restore confirmation phrase.',
  [RECOVERY_RESTORE_ERRORS.CONFIRMATION_MISMATCH]:
    'The confirmation phrase does not match this plan. Nothing was approved.',
  [RECOVERY_RESTORE_ERRORS.APPROVAL_STALE]:
    'Live storage or witness evidence changed after the preview. The plan is stale and nothing was approved.',
  [RECOVERY_RESTORE_ERRORS.AUTHORIZATION_UNAVAILABLE]:
    'Synchronization authorization could not be moved to restore-in-progress. Restore was refused.',
  [RECOVERY_RESTORE_ERRORS.NOT_ARMED]:
    'Synchronization authorization is not in restore-in-progress, so the restore cannot write.',
  [RECOVERY_RESTORE_ERRORS.BUSY]:
    'Another restore batch is running. No write was attempted.',
  [RECOVERY_RESTORE_ERRORS.APPLY_FAILED]:
    'The restore batch could not be completed. Completed items remain durable and can be resumed.',
  [RECOVERY_RESTORE_ERRORS.CANCELLED]:
    'The restore plan was cancelled. Synchronization remains blocked until it is explicitly re-authorized.'
});

export class RecoveryRestoreError extends Error {
  constructor(code, details = {}) {
    super(RECOVERY_RESTORE_MESSAGES[code]
      || RECOVERY_RESTORE_MESSAGES[RECOVERY_RESTORE_ERRORS.APPLY_FAILED]);
    this.name = 'RecoveryRestoreError';
    this.code = code;
    this.details = details;
  }
}


const ORG_ID_PATTERN = /^org-\d+$/;
const ITEM_LEDGER_FIELDS = Object.freeze([
  'direction',
  'sourceKey',
  'operationSuffix',
  'state',
  'attempt',
  'targetKey',
  'operationId',
  'createdAt',
  'updatedAt',
  'startedAt',
  'completedAt',
  'unknownAt',
  'failedAt',
  'failureReason'
]);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(stableStringify(value), 'utf8').digest('hex')}`;
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

const defaultDeps = {
  getStored: kvsStore.get,
  setStored: kvsStore.set,
  setStoredWithTtl: kvsStore.setWithTtl,
  queryPage: kvsStore.queryPageByPrefix,
  deleteKey: kvsStore.del,
  setIfNotExists: kvsStore.setIfNotExists,
  createOperation: kvsStore.createIfNotExists,
  readPause: getPilotPause,
  getOrganizations: getOrganizationsWithTokens,
  readIdentity: readForgeInstallationIdentity,
  readIssue: readIssueIdentity,
  readWitness: readPairWitness,
  getRemoteKey,
  getLocalKey,
  storeMapping,
  setAuthorizationState: setSyncAuthorizationState,
  auditWrite: logAuditEntry,
  now: () => Date.now()
};

function depsOf(options = {}) {
  const merged = { ...defaultDeps, ...(options.deps || {}) };
  // Keep compatibility with the snapshot preview's dependency name while the
  // restore service exposes the more explicit `readPause` seam.
  if (options.deps && typeof options.deps.getPilotPause === 'function'
    && typeof options.deps.readPause !== 'function') {
    merged.readPause = options.deps.getPilotPause;
  }
  return merged;
}

function normalizeOrganizationId(orgId) {
  if (typeof orgId !== 'string' || !ORG_ID_PATTERN.test(orgId)) {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.ORGANIZATION_INVALID);
  }
  return orgId;
}

async function readPause(deps) {
  let pause;
  try {
    pause = await deps.readPause();
  } catch {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.PAUSE_UNREADABLE);
  }
  if (!pause || pause.paused !== true) {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.PAUSE_REQUIRED);
  }
  return pause;
}

/**
 * A plan may only run against the installation and routing it was previewed
 * under. A changed installation, environment or remote site makes every pair
 * identity ambiguous, so the plan is refused before any write.
 */
async function assertPlanIdentity(plan, orgInfo, deps) {
  let current;
  try {
    current = await deps.readIdentity();
  } catch {
    current = null;
  }
  if (!current || current.readable !== true) {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.PREVIEW_FAILED, {
      reason: 'identity-unavailable'
    });
  }
  const localSite = (Array.isArray(current.cloudIds) && current.cloudIds[0])
    || (typeof current.siteHost === 'string' ? current.siteHost : null);
  const expected = plan.identity || {};
  if (current.appId !== expected.appId
    || current.environmentId !== expected.environmentId
    || current.installationId !== expected.installationId
    || localSite !== expected.localSite
    || orgInfo.remoteSite !== expected.remoteSite) {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.PLAN_NOT_APPROVED, {
      reason: 'plan-identity-mismatch'
    });
  }
  return true;
}

async function resolveOrganization(orgId, deps) {
  let organizations;
  try {
    organizations = await deps.getOrganizations();
  } catch {
    organizations = [];
  }
  const list = Array.isArray(organizations) ? organizations : [];
  const organization = list.find((entry) => entry?.id === orgId);
  if (!organization) {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.ORGANIZATION_NOT_FOUND);
  }
  const remoteSite = hostFromUrl(organization.remoteUrl);
  if (!remoteSite
    || typeof organization.remoteApiToken !== 'string'
    || organization.remoteApiToken === '') {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.ORGANIZATION_UNUSABLE);
  }
  return {
    organization,
    remoteSite,
    organizationIds: list
      .map((entry) => entry?.id)
      .filter((id) => typeof id === 'string' && ORG_ID_PATTERN.test(id))
  };
}


function normalizeSelection(pairs) {
  if (pairs === undefined || pairs === null) {
    return { mode: 'organization', selection: [] };
  }
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.SELECTION_INVALID, {
      reason: 'empty-explicit-selection'
    });
  }
  const seen = new Set();
  const selection = [];
  for (const entry of pairs) {
    if (!isPlainObject(entry)
      || !isValidIssueKey(entry.localKey)
      || !isValidIssueKey(entry.remoteKey)) {
      throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.SELECTION_INVALID, {
        reason: 'invalid-pair'
      });
    }
    const key = `${entry.localKey}\u0000${entry.remoteKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selection.push({ localKey: entry.localKey, remoteKey: entry.remoteKey });
    if (selection.length > RECOVERY_RESTORE_MAX_PAIRS) {
      throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.SELECTION_INVALID, {
        reason: 'selection-exceeds-plan-limit'
      });
    }
  }
  if (selection.length === 0) {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.SELECTION_INVALID, {
      reason: 'empty-explicit-selection'
    });
  }
  return { mode: 'explicit', selection };
}

function pairKey(localKey, remoteKey) {
  return `${localKey}\u0000${remoteKey}`;
}

function ledgerPair(record) {
  if (!record || record.state !== ISSUE_CREATE_STATES.SUCCEEDED || !record.targetKey) return null;
  if (record.direction === 'local-to-remote') {
    return { localKey: record.sourceKey, remoteKey: record.targetKey };
  }
  if (record.direction === 'remote-to-local') {
    return { localKey: record.targetKey, remoteKey: record.sourceKey };
  }
  return null;
}

function ledgerIdentity(record) {
  return `${record.direction}\u0000${record.sourceKey}\u0000${record.operationSuffix || ''}`;
}

/**
 * A conflicting live ledger row can name the candidate source or its target in
 * either direction. Treat any key overlap as a blocker: restoring a mapping over
 * a contradictory create record would make duplicate prevention lie.
 */
function ledgerConflictsPair(record, pair) {
  if (!record) return false;
  return record.sourceKey === pair.localKey
    || record.sourceKey === pair.remoteKey
    || record.targetKey === pair.localKey
    || record.targetKey === pair.remoteKey;
}

function projectLedger(record) {
  const projected = {};
  for (const field of ITEM_LEDGER_FIELDS) {
    projected[field] = record[field] ?? null;
  }
  return projected;
}

function planDigestOf(plan) {
  return sha256({
    purpose: 'recovery-restore',
    version: RECOVERY_RESTORE_VERSION,
    orgId: plan.orgId,
    installationId: plan.identity?.installationId || null,
    appId: plan.identity?.appId || null,
    environmentId: plan.identity?.environmentId || null,
    snapshotChecksum: plan.snapshot?.checksum || null,
    formatVersion: plan.snapshot?.formatVersion || null,
    selectionMode: plan.selectionMode,
    selection: plan.selectionMode === 'explicit'
      ? (plan.selection || []).map((entry) => [entry.localKey, entry.remoteKey])
      : null,
    items: (plan.items || []).map((item) => ({
      localKey: item.localKey,
      remoteKey: item.remoteKey,
      witness: item.witness,
      ledgers: (item.ledgers || []).map((ledger) => ({
        direction: ledger.direction,
        sourceKey: ledger.sourceKey,
        operationSuffix: ledger.operationSuffix,
        state: ledger.state,
        targetKey: ledger.targetKey,
        operationId: ledger.operationId
      }))
    }))
  });
}

function approvalPhrase(plan) {
  return `RESTORE ${plan.orgId} ${plan.digest}`;
}

function safeAudit(deps, entry) {
  return Promise.resolve()
    .then(() => deps.auditWrite(entry))
    .catch(() => false);
}

function summarizePlan(plan) {
  const states = {};
  for (const item of plan.items || []) {
    states[item.state] = (states[item.state] || 0) + 1;
  }
  const remaining = (plan.items || []).filter((item) => (
    item.state === RECOVERY_RESTORE_ITEM_STATES.PENDING
    || item.state === RECOVERY_RESTORE_ITEM_STATES.PARTIAL
  )).length;
  return {
    success: true,
    orgId: plan.orgId,
    digest: plan.digest,
    status: plan.status,
    selectionMode: plan.selectionMode,
    counts: plan.counts,
    states,
    remaining,
    excluded: plan.excluded || [],
    approvalPhrase: approvalPhrase(plan),
    expiresAt: Number(plan.expiresAt) > 0
      ? new Date(Number(plan.expiresAt)).toISOString()
      : null
  };
}


function blockedWitness(reason, details = {}) {
  return {
    witness: RECOVERY_RESTORE_WITNESS_CLASSES.BLOCKED,
    reason,
    ...details
  };
}

function witnessReadReason(readClass) {
  if (readClass === PAIR_WITNESS_READ_CLASSES.INACCESSIBLE) return 'witness-inaccessible';
  if (readClass === PAIR_WITNESS_READ_CLASSES.UNVERIFIABLE
    || readClass === PAIR_WITNESS_READ_CLASSES.MALFORMED
    || readClass === PAIR_WITNESS_READ_CLASSES.SCHEMA_NEWER) return 'witness-unverifiable';
  if (readClass === PAIR_WITNESS_READ_CLASSES.ABSENT) return 'witness-absent';
  return 'witness-conflict';
}

/**
 * Reads both issues and both witnesses. A matching pair on both sides is
 * `confirmed`; both absent is `absent` and remains eligible only because the
 * administrator explicitly approves the snapshot plan. Anything partial,
 * inaccessible, foreign or contradictory is excluded, never approximated.
 */
async function verifyPairWitness({
  orgId,
  org,
  identity,
  localSite,
  remoteSite,
  localKey,
  remoteKey,
  deps
}) {
  let localIssue;
  let remoteIssue;
  try {
    localIssue = await deps.readIssue({
      side: PAIR_WITNESS_SIDES.LOCAL,
      issueRef: localKey,
      org
    });
  } catch {
    return blockedWitness('local-issue-unreadable');
  }
  if (localIssue?.class === PAIR_WITNESS_ISSUE_CLASSES.MISSING) {
    return blockedWitness('local-issue-missing');
  }
  if (localIssue?.class === PAIR_WITNESS_ISSUE_CLASSES.INACCESSIBLE) {
    return blockedWitness('local-issue-inaccessible');
  }
  if (localIssue?.class !== PAIR_WITNESS_ISSUE_CLASSES.PRESENT
    || !localIssue.id || localIssue.key !== localKey) {
    return blockedWitness('local-issue-unverifiable');
  }

  try {
    remoteIssue = await deps.readIssue({
      side: PAIR_WITNESS_SIDES.REMOTE,
      issueRef: remoteKey,
      org
    });
  } catch {
    return blockedWitness('remote-issue-unreadable');
  }
  if (remoteIssue?.class === PAIR_WITNESS_ISSUE_CLASSES.MISSING) {
    return blockedWitness('remote-issue-missing');
  }
  if (remoteIssue?.class === PAIR_WITNESS_ISSUE_CLASSES.INACCESSIBLE) {
    return blockedWitness('remote-issue-inaccessible');
  }
  if (remoteIssue?.class !== PAIR_WITNESS_ISSUE_CLASSES.PRESENT
    || !remoteIssue.id || remoteIssue.key !== remoteKey) {
    return blockedWitness('remote-issue-unverifiable');
  }

  const expectedBase = {
    installationId: identity.installationId,
    appId: identity.appId,
    orgId,
    localSite,
    remoteSite
  };
  let localWitness;
  let remoteWitness;
  try {
    localWitness = await deps.readWitness({
      side: PAIR_WITNESS_SIDES.LOCAL,
      issueRef: localIssue.id,
      org,
      expected: { ...expectedBase, issueId: localIssue.id }
    });
    remoteWitness = await deps.readWitness({
      side: PAIR_WITNESS_SIDES.REMOTE,
      issueRef: remoteIssue.id,
      org,
      expected: { ...expectedBase, issueId: remoteIssue.id }
    });
  } catch {
    return blockedWitness('witness-unreadable');
  }

  if (localWitness?.class === PAIR_WITNESS_READ_CLASSES.ABSENT
    && remoteWitness?.class === PAIR_WITNESS_READ_CLASSES.ABSENT) {
    return {
      witness: RECOVERY_RESTORE_WITNESS_CLASSES.ABSENT,
      localIssueId: localIssue.id,
      remoteIssueId: remoteIssue.id
    };
  }
  if (localWitness?.class !== PAIR_WITNESS_READ_CLASSES.MATCHING
    || remoteWitness?.class !== PAIR_WITNESS_READ_CLASSES.MATCHING) {
    if (localWitness?.class === PAIR_WITNESS_READ_CLASSES.ABSENT
      || remoteWitness?.class === PAIR_WITNESS_READ_CLASSES.ABSENT) {
      return blockedWitness('witness-partial');
    }
    return blockedWitness(witnessReadReason(
      localWitness?.class !== PAIR_WITNESS_READ_CLASSES.MATCHING
        ? localWitness?.class
        : remoteWitness?.class
    ));
  }

  const localRecord = localWitness.record;
  const remoteRecord = remoteWitness.record;
  if (!localRecord || !remoteRecord
    || !sameWitnessPairIdentity(localRecord, remoteRecord)
    || localRecord.localIssueId !== localIssue.id
    || localRecord.remoteIssueId !== remoteIssue.id
    || localRecord.localKey !== localKey
    || localRecord.remoteKey !== remoteKey) {
    return blockedWitness('witness-conflict');
  }

  let pairId;
  try {
    pairId = deterministicPairId({
      installationId: identity.installationId,
      orgId,
      localIssueId: localIssue.id,
      remoteIssueId: remoteIssue.id
    });
  } catch {
    return blockedWitness('witness-conflict');
  }
  if (localRecord.pairId !== pairId || remoteRecord.pairId !== pairId) {
    return blockedWitness('witness-conflict');
  }

  return {
    witness: RECOVERY_RESTORE_WITNESS_CLASSES.CONFIRMED,
    pairId,
    localIssueId: localIssue.id,
    remoteIssueId: remoteIssue.id
  };
}


function witnessCounts(items) {
  return {
    confirmed: items.filter((item) => item.witness === RECOVERY_RESTORE_WITNESS_CLASSES.CONFIRMED).length,
    absent: items.filter((item) => item.witness === RECOVERY_RESTORE_WITNESS_CLASSES.ABSENT).length
  };
}

async function buildCandidatePlan({ orgId, content, pairs, deps }) {
  normalizeOrganizationId(orgId);
  await readPause(deps);
  const orgInfo = await resolveOrganization(orgId, deps);

  // The snapshot preview owns checksum, header, identity, routing, pause and
  // evidence validation. Reusing it means a restore can never accept a file the
  // read-only preview would have refused.
  const preview = await previewRestoreSnapshot({ orgId, content, deps });
  if (!preview?.success) {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.PREVIEW_FAILED);
  }
  if (!preview.recoverability?.recoverable) {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.SNAPSHOT_NOT_RECOVERABLE, {
      reasons: preview.recoverability?.reasons || []
    });
  }

  const current = preview.identity?.current || {};
  const localSite = (Array.isArray(current.cloudIds) && current.cloudIds[0])
    || (typeof current.siteHost === 'string' ? current.siteHost : null);
  if (typeof current.appId !== 'string'
    || typeof current.installationId !== 'string'
    || !localSite) {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.PREVIEW_FAILED, {
      reason: 'identity-unavailable'
    });
  }
  const identity = {
    appId: current.appId,
    environmentId: typeof current.environmentId === 'string' ? current.environmentId : null,
    installationId: current.installationId,
    localSite,
    remoteSite: orgInfo.remoteSite
  };

  const normalizedSelection = normalizeSelection(pairs);
  const availablePairs = Array.isArray(preview.restore?.candidates?.allPairs)
    ? preview.restore.candidates.allPairs
    : (Array.isArray(preview.restore?.candidates?.pairs)
      ? preview.restore.candidates.pairs
      : []);
  const candidateByKey = new Map();
  for (const candidate of availablePairs) {
    candidateByKey.set(pairKey(candidate.localKey, candidate.remoteKey), candidate);
  }

  let selected;
  if (normalizedSelection.mode === 'explicit') {
    selected = normalizedSelection.selection.map((entry) => {
      const candidate = candidateByKey.get(pairKey(entry.localKey, entry.remoteKey));
      if (!candidate) {
        throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.SELECTION_INVALID, {
          reason: 'pair-not-restorable',
          localKey: entry.localKey,
          remoteKey: entry.remoteKey
        });
      }
      return candidate;
    });
  } else {
    selected = availablePairs;
  }
  selected = [...selected].sort((left, right) => (
    left.localKey.localeCompare(right.localKey) || left.remoteKey.localeCompare(right.remoteKey)
  ));

  const ledgerByPair = new Map();
  for (const record of preview.restore?.candidates?.ledger || []) {
    if (record.state !== ISSUE_CREATE_STATES.SUCCEEDED || !record.targetKey) continue;
    const pair = ledgerPair(record);
    if (!pair) continue;
    const key = pairKey(pair.localKey, pair.remoteKey);
    if (!ledgerByPair.has(key)) ledgerByPair.set(key, []);
    ledgerByPair.get(key).push(projectLedger(record));
  }

  const items = [];
  const excluded = [];
  const conflictingLedger = Array.isArray(preview.restore?.candidates?.conflictingLedger)
    ? preview.restore.candidates.conflictingLedger
    : [];
  let examinedPairs = 0;
  for (const pair of selected) {
    if (normalizedSelection.mode === 'organization'
      && items.length >= RECOVERY_RESTORE_MAX_PAIRS) {
      break;
    }
    examinedPairs += 1;
    if (conflictingLedger.some((record) => ledgerConflictsPair(record, pair))) {
      excluded.push({
        localKey: pair.localKey,
        remoteKey: pair.remoteKey,
        reason: 'ledger-conflict'
      });
      continue;
    }
    const liveLedger = await readPairLedgerBase(pair, orgId, deps);
    if (liveLedger.state !== 'clear') {
      excluded.push({
        localKey: pair.localKey,
        remoteKey: pair.remoteKey,
        reason: 'ledger-conflict'
      });
      continue;
    }
    const witness = await verifyPairWitness({
      orgId,
      org: orgInfo.organization,
      identity,
      localSite,
      remoteSite: orgInfo.remoteSite,
      localKey: pair.localKey,
      remoteKey: pair.remoteKey,
      deps
    });
    if (witness.witness === RECOVERY_RESTORE_WITNESS_CLASSES.BLOCKED) {
      excluded.push({
        localKey: pair.localKey,
        remoteKey: pair.remoteKey,
        reason: witness.reason
      });
      continue;
    }

    const ledgers = (ledgerByPair.get(pairKey(pair.localKey, pair.remoteKey)) || [])
      .slice()
      .sort((left, right) => ledgerIdentity(left).localeCompare(ledgerIdentity(right)));
    items.push({
      seq: items.length + 1,
      localKey: pair.localKey,
      remoteKey: pair.remoteKey,
      witness: witness.witness,
      ledgers,
      state: RECOVERY_RESTORE_ITEM_STATES.PENDING,
      mappingState: 'pending',
      ledgerStates: ledgers.map(() => 'pending'),
      attempts: 0,
      lastError: null,
      restoredAt: null
    });
  }

  const witness = witnessCounts(items);
  const excludedCount = excluded.length;
  const plan = {
    version: RECOVERY_RESTORE_VERSION,
    orgId,
    status: RECOVERY_RESTORE_PLAN_STATES.PENDING,
    selectionMode: normalizedSelection.mode,
    selection: normalizedSelection.mode === 'explicit' ? normalizedSelection.selection : null,
    identity,
    snapshot: {
      checksum: preview.checksum?.declared || null,
      formatVersion: preview.formatVersion,
      exportedAt: preview.exportedAt || null,
      bytes: preview.bytes,
      lineCount: preview.lineCount,
      organizationId: preview.organization?.snapshotId || orgId
    },
    items,
    excluded: excluded.slice(0, RECOVERY_RESTORE_MAX_PAIRS),
    counts: {
      selectedPairs: items.length,
      witnessConfirmed: witness.confirmed,
      witnessAbsent: witness.absent,
      ledgerRows: items.reduce((sum, item) => sum + item.ledgers.length, 0),
      excludedPairs: excludedCount,
      availablePairs: availablePairs.length,
      truncatedPairs: normalizedSelection.mode === 'organization'
        ? Math.max(0, availablePairs.length - examinedPairs)
        : 0
    },
    createdAt: new Date(Number(deps.now())).toISOString(),
    createdBy: null,
    approvedAt: null,
    approvedBy: null,
    expiresAt: null,
    batches: 0,
    completedAt: null,
    digest: null,
    approvalPhrase: null
  };
  plan.digest = planDigestOf(plan);
  plan.approvalPhrase = approvalPhrase(plan);
  return { plan, preview, orgInfo };
}


/**
 * Read-only restore preview. It runs the full snapshot validation and reads both
 * witnesses for each candidate, but writes nothing to Forge storage or Jira.
 */
export async function previewRecoveryRestore(options = {}) {
  const deps = depsOf(options);
  const orgId = normalizeOrganizationId(options.orgId);
  const { plan, preview } = await buildCandidatePlan({
    orgId,
    content: options.content,
    pairs: options.pairs,
    deps
  });

  return {
    success: true,
    readOnly: true,
    noWritesPerformed: true,
    orgId,
    snapshot: plan.snapshot,
    identity: plan.identity,
    organization: {
      requested: orgId,
      snapshotId: preview.organization?.snapshotId || null,
      match: preview.organization?.match === true
    },
    counts: plan.counts,
    digest: plan.digest,
    approvalPhrase: plan.approvalPhrase,
    candidates: plan.items.map((item) => ({
      localKey: item.localKey,
      remoteKey: item.remoteKey,
      witness: item.witness,
      ledgers: item.ledgers.map((ledger) => ({
        direction: ledger.direction,
        sourceKey: ledger.sourceKey,
        operationSuffix: ledger.operationSuffix,
        targetKey: ledger.targetKey,
        state: ledger.state
      }))
    })),
    excluded: plan.excluded,
    limitations: [
      'The preview reads both pairing witnesses and both issue identities. It never creates, updates or deletes a Jira issue and never searches.',
      'Only missing mapping pairs and succeeded create-ledger rows that point at those pairs are restorable. Pending, unknown and failed-definitive ledger rows are left untouched for explicit create recovery.',
      'A bounded plan covers at most 200 pairs. Restore that plan, then preview the same file again to select the next missing slice.',
      'No write is made by this preview. Approval and each batch re-read mappings, blockers, witnesses and ledger rows before writing.'
    ]
  };
}

/**
 * Builds and stores a pending plan. This is an administrative storage write
 * only: no mapping, ledger row, Jira issue or pause state is changed.
 */
export async function planRecoveryRestore(options = {}) {
  const deps = depsOf(options);
  const orgId = normalizeOrganizationId(options.orgId);
  const { plan } = await buildCandidatePlan({
    orgId,
    content: options.content,
    pairs: options.pairs,
    deps
  });
  if (plan.items.length === 0) {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.PLAN_EMPTY, {
      excludedPairs: plan.excluded.length,
      counts: plan.counts
    });
  }

  plan.createdBy = typeof options.accountId === 'string'
    ? options.accountId.slice(0, 100)
    : null;
  plan.expiresAt = Number(deps.now()) + RECOVERY_RESTORE_PLAN_TTL_SECONDS * 1000;
  try {
    await deps.setStoredWithTtl(
      RECOVERY_RESTORE_PLAN_KEY(orgId),
      plan,
      RECOVERY_RESTORE_PLAN_TTL_SECONDS
    );
  } catch {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.APPLY_FAILED, {
      reason: 'plan-storage-failed'
    });
  }

  await safeAudit(deps, {
    action: 'recovery-restore',
    orgId,
    outcome: 'planned',
    success: true,
    reason: 'restore-plan-created'
  });

  return {
    ...summarizePlan(plan),
    candidates: plan.items.map((item) => ({
      localKey: item.localKey,
      remoteKey: item.remoteKey,
      witness: item.witness,
      ledgers: item.ledgers.length
    }))
  };
}


async function readMappingState(item, orgId, deps) {
  let remote;
  let local;
  let meta;
  try {
    [remote, local, meta] = await Promise.all([
      deps.getRemoteKey(item.localKey, orgId),
      deps.getLocalKey(item.remoteKey, orgId),
      deps.getStored(`mapping-meta:${orgId}:${item.localKey}`)
    ]);
  } catch {
    return { state: 'unreadable' };
  }
  const metaMatches = isPlainObject(meta)
    && meta.localKey === item.localKey
    && meta.remoteKey === item.remoteKey;
  if (!remote && !local && !meta) return { state: 'missing' };
  if (remote === item.remoteKey && local === item.localKey) {
    if (metaMatches) return { state: 'present' };
    if (!meta) return { state: 'meta-missing' };
    return { state: 'conflict', reason: 'metadata-differs' };
  }
  return { state: 'conflict', remoteKey: remote || null, localKey: local || null };
}

async function readBlockingState(item, orgId, deps) {
  const keys = [
    `mapping-ended:${orgId}:${item.localKey}:${item.remoteKey}`,
    `mapping-repair:${orgId}:${item.localKey}:${item.remoteKey}`,
    `counterpart-status:${orgId}:${item.localKey}:${item.remoteKey}`
  ];
  let values;
  try {
    values = await Promise.all(keys.map((key) => deps.getStored(key)));
  } catch {
    return { blocked: true, reason: 'blocking-record-unreadable' };
  }
  if (values[0]) return { blocked: true, reason: 'mapping-ended' };
  if (values[1]) return { blocked: true, reason: 'mapping-repair' };
  const counterpart = values[2];
  if (counterpart) {
    if (!isPlainObject(counterpart) || typeof counterpart.state !== 'string') {
      return { blocked: true, reason: 'counterpart-unreadable' };
    }
    if (counterpart.state === 'ended' || counterpart.state === 'replaced') {
      return { blocked: true, reason: 'counterpart-archived' };
    }
    try {
      if (counterpartStatusBlocksSync(counterpart, { hasMapping: false }).blocked) {
        return { blocked: true, reason: 'counterpart-deleted' };
      }
    } catch {
      return { blocked: true, reason: 'counterpart-unreadable' };
    }
  }
  return { blocked: false };
}

async function readLedgerState(ledger, orgId, deps) {
  let key;
  try {
    key = buildIssueCreateOperationKey({
      orgId,
      direction: ledger.direction,
      sourceKey: ledger.sourceKey,
      operationSuffix: ledger.operationSuffix
    });
  } catch {
    return { state: 'conflict', reason: 'ledger-key-invalid' };
  }
  let value;
  try {
    value = await deps.getStored(key);
  } catch {
    return { state: 'unreadable', key };
  }
  if (!value) return { state: 'missing', key };
  if (isPlainObject(value)
    && value.state === ISSUE_CREATE_STATES.SUCCEEDED
    && value.targetKey === ledger.targetKey) {
    return { state: 'present', key };
  }
  return { state: 'conflict', key, reason: 'ledger-state-differs' };
}

async function readPairLedgerBase(item, orgId, deps) {
  const checks = [
    { direction: 'local-to-remote', sourceKey: item.localKey, targetKey: item.remoteKey },
    { direction: 'remote-to-local', sourceKey: item.remoteKey, targetKey: item.localKey }
  ];
  const matches = (value, targetKey) => isPlainObject(value)
    && value.state === ISSUE_CREATE_STATES.SUCCEEDED
    && value.targetKey === targetKey;

  for (const check of checks) {
    let key;
    try {
      key = buildIssueCreateOperationKey({
        orgId,
        direction: check.direction,
        sourceKey: check.sourceKey
      });
    } catch {
      return { state: 'conflict', reason: 'ledger-key-invalid' };
    }
    let value;
    try {
      value = await deps.getStored(key);
    } catch {
      return { state: 'unreadable', reason: 'ledger-unreadable' };
    }
    if (value && !matches(value, check.targetKey)) {
      return { state: 'conflict', reason: 'ledger-state-differs' };
    }

    // The base slot is not the only possible ledger key: automatic replacement
    // operations append an operation suffix. Scan that bounded suffix space so
    // an extra pending/unknown/succeeded row cannot be hidden from the restore.
    if (typeof deps.queryPage === 'function') {
      let cursor = null;
      let pages = 0;
      for (;;) {
        let page;
        try {
          page = await deps.queryPage(`${key}:`, { cursor, limit: 100 });
        } catch {
          return { state: 'unreadable', reason: 'ledger-unreadable' };
        }
        if (!page || !Array.isArray(page.records)) {
          return { state: 'unreadable', reason: 'ledger-unreadable' };
        }
        for (const entry of page.records) {
          if (!entry || entry.key === key) continue;
          if (!matches(entry.value, check.targetKey)) {
            return { state: 'conflict', reason: 'ledger-state-differs' };
          }
        }
        pages += 1;
        cursor = typeof page.nextCursor === 'string' && page.nextCursor
          ? page.nextCursor
          : null;
        if (!cursor) break;
        if (pages >= 10) {
          return { state: 'conflict', reason: 'ledger-query-too-large' };
        }
      }
    }
  }
  return { state: 'clear' };
}

/**
 * Re-reads every assumption of one plan item. This is called before approval
 * and again immediately before each batch item writes. Nothing is cached.
 */
async function revalidateItem({ item, orgId, org, identity, localSite, remoteSite, deps }) {
  const mapping = await readMappingState(item, orgId, deps);
  if (mapping.state === 'unreadable') return { ok: false, reason: 'mapping-unreadable' };
  if (mapping.state === 'conflict') {
    return { ok: false, reason: 'mapping-conflict', mapping };
  }

  const blocking = await readBlockingState(item, orgId, deps);
  if (blocking.blocked) return { ok: false, reason: blocking.reason };

  const baseLedger = await readPairLedgerBase(item, orgId, deps);
  if (baseLedger.state === 'unreadable') return { ok: false, reason: 'ledger-unreadable' };
  if (baseLedger.state === 'conflict') {
    return { ok: false, reason: baseLedger.reason || 'ledger-conflict' };
  }

  const witness = await verifyPairWitness({
    orgId,
    org,
    identity,
    localSite,
    remoteSite,
    localKey: item.localKey,
    remoteKey: item.remoteKey,
    deps
  });
  if (witness.witness === RECOVERY_RESTORE_WITNESS_CLASSES.BLOCKED) {
    return { ok: false, reason: witness.reason };
  }
  if (witness.witness !== item.witness) {
    return { ok: false, reason: 'witness-evidence-changed' };
  }

  const ledgerStates = [];
  for (const ledger of item.ledgers || []) {
    const state = await readLedgerState(ledger, orgId, deps);
    if (state.state === 'unreadable') {
      return { ok: false, reason: 'ledger-unreadable' };
    }
    if (state.state === 'conflict') {
      return { ok: false, reason: state.reason || 'ledger-conflict' };
    }
    ledgerStates.push(state.state);
  }

  const mappingSatisfied = mapping.state === 'present';
  const ledgerSatisfied = ledgerStates.every((state) => state === 'present');
  return {
    ok: true,
    mapping,
    ledgerStates,
    noWork: mappingSatisfied && ledgerSatisfied
  };
}


export async function acquireRecoveryRestoreLock(options = {}) {
  const deps = depsOf(options);
  const token = randomBytes(16).toString('hex');
  const now = Number(deps.now());
  const record = {
    token,
    orgId: typeof options.orgId === 'string' ? options.orgId : null,
    acquiredAt: now,
    expiresAt: now + RECOVERY_RESTORE_LOCK_TTL_SECONDS * 1000
  };
  try {
    if (typeof deps.setIfNotExists === 'function') {
      await deps.setIfNotExists(RECOVERY_RESTORE_LOCK_KEY, record, RECOVERY_RESTORE_LOCK_TTL_SECONDS);
    } else {
      const existing = await deps.getStored(RECOVERY_RESTORE_LOCK_KEY);
      if (existing) {
        const conflict = new Error('lock exists');
        conflict.code = 'KEY_ALREADY_EXISTS';
        throw conflict;
      }
      await deps.setStoredWithTtl(
        RECOVERY_RESTORE_LOCK_KEY,
        record,
        RECOVERY_RESTORE_LOCK_TTL_SECONDS
      );
    }
  } catch (error) {
    if (error?.code === 'KEY_ALREADY_EXISTS' || /exists/i.test(String(error?.message || ''))) {
      throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.BUSY);
    }
    throw error;
  }
  return record;
}

export async function releaseRecoveryRestoreLock(lock, options = {}) {
  const deps = depsOf(options);
  try {
    const stored = await deps.getStored(RECOVERY_RESTORE_LOCK_KEY);
    if (isPlainObject(stored) && lock && stored.token !== lock.token) return false;
    await deps.deleteKey(RECOVERY_RESTORE_LOCK_KEY);
    return true;
  } catch {
    return false;
  }
}

async function readStoredPlan(orgId, deps, { allowExpired = false } = {}) {
  let stored;
  try {
    stored = await deps.getStored(RECOVERY_RESTORE_PLAN_KEY(orgId));
  } catch {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.PLAN_MISSING);
  }
  if (!isPlainObject(stored)
    || stored.version !== RECOVERY_RESTORE_VERSION
    || stored.orgId !== orgId
    || !Array.isArray(stored.items)
    || typeof stored.digest !== 'string') {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.PLAN_MISSING);
  }
  if (!allowExpired && !(Number(stored.expiresAt) > Number(deps.now()))) {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.PLAN_EXPIRED);
  }
  if (planDigestOf(stored) !== stored.digest) {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.PLAN_DIGEST_MISMATCH);
  }
  return stored;
}


/**
 * Revalidates the immutable plan against current storage and Jira, then arms the
 * installation by putting synchronization authorization into restore-in-progress.
 * Approval writes no mapping, ledger row or Jira issue.
 */
export async function approveRecoveryRestore(options = {}) {
  const deps = depsOf(options);
  const orgId = normalizeOrganizationId(options.orgId);
  await readPause(deps);
  const plan = await readStoredPlan(orgId, deps);

  if (plan.status === RECOVERY_RESTORE_PLAN_STATES.APPROVED
    || plan.status === RECOVERY_RESTORE_PLAN_STATES.RUNNING) {
    return {
      ...summarizePlan(plan),
      alreadyApproved: true,
      jiraWrites: 0,
      authorizationState: SYNC_AUTHORIZATION_STATES.RESTORE_IN_PROGRESS
    };
  }
  if (plan.status !== RECOVERY_RESTORE_PLAN_STATES.PENDING) {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.PLAN_NOT_APPROVED, {
      status: plan.status
    });
  }
  if (typeof options.confirmation !== 'string' || options.confirmation.trim() === '') {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.CONFIRMATION_REQUIRED, {
      expectedPhrase: approvalPhrase(plan)
    });
  }
  if (options.confirmation !== approvalPhrase(plan)) {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.CONFIRMATION_MISMATCH);
  }
  if (typeof options.digest === 'string' && options.digest !== plan.digest) {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.PLAN_DIGEST_MISMATCH);
  }

  const orgInfo = await resolveOrganization(orgId, deps);
  const identity = plan.identity || {};
  if (!identity.installationId || !identity.appId || !identity.localSite || !identity.remoteSite) {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.PREVIEW_FAILED, {
      reason: 'plan-identity-missing'
    });
  }
  await assertPlanIdentity(plan, orgInfo, deps);

  const conflicts = [];
  for (const item of plan.items) {
    if (item.state !== RECOVERY_RESTORE_ITEM_STATES.PENDING
      && item.state !== RECOVERY_RESTORE_ITEM_STATES.PARTIAL) continue;
    const current = await revalidateItem({
      item,
      orgId,
      org: orgInfo.organization,
      identity,
      localSite: identity.localSite,
      remoteSite: identity.remoteSite,
      deps
    });
    if (!current.ok) {
      conflicts.push({
        localKey: item.localKey,
        remoteKey: item.remoteKey,
        reason: current.reason
      });
    }
  }
  if (conflicts.length > 0) {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.APPROVAL_STALE, {
      conflicts: conflicts.slice(0, 5),
      conflictCount: conflicts.length
    });
  }

  // A pending plan may not overwrite authorization that another organization's
  // restore already armed. Only one restore may hold the global
  // restore-in-progress veto at a time; approval of a different plan is refused
  // until that restore completes, is cancelled, or is explicitly re-authorized.
  let currentAuthorization = null;
  try {
    currentAuthorization = await deps.getStored('syncAuthorization');
  } catch {
    currentAuthorization = null;
  }
  if (currentAuthorization?.state === SYNC_AUTHORIZATION_STATES.RESTORE_IN_PROGRESS) {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.AUTHORIZATION_UNAVAILABLE, {
      reason: 'another-restore-in-progress'
    });
  }


  const organizationIds = orgInfo.organizationIds.includes(orgId)
    ? orgInfo.organizationIds
    : [...orgInfo.organizationIds, orgId];
  try {
    await deps.setAuthorizationState({
      state: SYNC_AUTHORIZATION_STATES.RESTORE_IN_PROGRESS,
      organizationIds,
      basis: 'restored',
      accountId: typeof options.accountId === 'string' ? options.accountId : null,
      reason: 'recovery-restore-approved'
    });
  } catch {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.AUTHORIZATION_UNAVAILABLE);
  }

  plan.status = RECOVERY_RESTORE_PLAN_STATES.APPROVED;
  plan.approvedAt = new Date(Number(deps.now())).toISOString();
  plan.approvedBy = typeof options.accountId === 'string'
    ? options.accountId.slice(0, 100)
    : null;
  plan.expiresAt = Number(deps.now()) + RECOVERY_RESTORE_PLAN_TTL_SECONDS * 1000;
  try {
    await deps.setStoredWithTtl(
      RECOVERY_RESTORE_PLAN_KEY(orgId),
      plan,
      RECOVERY_RESTORE_PLAN_TTL_SECONDS
    );
  } catch {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.APPLY_FAILED, {
      reason: 'plan-storage-failed-after-arming'
    });
  }

  await safeAudit(deps, {
    action: 'recovery-restore',
    orgId,
    outcome: 'approved',
    success: true,
    reason: 'restore-plan-approved'
  });

  return {
    ...summarizePlan(plan),
    alreadyApproved: false,
    jiraWrites: 0,
    authorizationState: SYNC_AUTHORIZATION_STATES.RESTORE_IN_PROGRESS
  };
}


async function assertRestoreArmed(deps) {
  let record;
  try {
    record = await deps.getStored('syncAuthorization');
  } catch {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.NOT_ARMED);
  }
  if (!isPlainObject(record)
    || record.state !== SYNC_AUTHORIZATION_STATES.RESTORE_IN_PROGRESS) {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.NOT_ARMED);
  }
  return record;
}

function ledgerRecordForWrite(ledger, plan, now) {
  return {
    orgId: plan.orgId,
    direction: ledger.direction,
    sourceKey: ledger.sourceKey,
    ...(ledger.operationSuffix ? { operationSuffix: ledger.operationSuffix } : {}),
    state: ISSUE_CREATE_STATES.SUCCEEDED,
    attempt: Number.isInteger(ledger.attempt) && ledger.attempt > 0 ? ledger.attempt : 1,
    targetKey: ledger.targetKey,
    ...(ledger.operationId ? { operationId: ledger.operationId } : {}),
    ...(ledger.createdAt ? { createdAt: ledger.createdAt } : {}),
    ...(ledger.startedAt ? { startedAt: ledger.startedAt } : {}),
    ...(ledger.completedAt ? { completedAt: ledger.completedAt } : {}),
    updatedAt: new Date(now).toISOString(),
    restoredAt: new Date(now).toISOString(),
    restoredBy: plan.approvedBy || null,
    restorePlanDigest: plan.digest
  };
}

async function writeLedgerRow(ledger, plan, deps) {
  const key = buildIssueCreateOperationKey({
    orgId: plan.orgId,
    direction: ledger.direction,
    sourceKey: ledger.sourceKey,
    operationSuffix: ledger.operationSuffix
  });
  const existing = await deps.getStored(key);
  if (existing) {
    if (isPlainObject(existing)
      && existing.state === ISSUE_CREATE_STATES.SUCCEEDED
      && existing.targetKey === ledger.targetKey) {
      return { state: 'present', key };
    }
    return { state: 'conflict', key, reason: 'ledger-state-differs' };
  }

  const value = ledgerRecordForWrite(ledger, plan, Number(deps.now()));
  try {
    if (typeof deps.createOperation === 'function') {
      await deps.createOperation(key, value);
    } else {
      await deps.setStored(key, value);
    }
  } catch {
    // A concurrent writer may have created the same success row. Read it once
    // and accept only an identical succeeded target; never overwrite it.
    let current = null;
    try {
      current = await deps.getStored(key);
    } catch {
      return { state: 'partial', key, reason: 'ledger-unreadable' };
    }
    if (isPlainObject(current)
      && current.state === ISSUE_CREATE_STATES.SUCCEEDED
      && current.targetKey === ledger.targetKey) {
      return { state: 'present', key };
    }
    if (!current) {
      // A transient create failure is retryable; nothing was written.
      return { state: 'partial', key, reason: 'ledger-write-failed' };
    }
    return { state: 'conflict', key, reason: 'ledger-write-conflict' };
  }
  return { state: 'restored', key };
}


async function processItem({
  item,
  plan,
  org,
  orgId,
  identity,
  localSite,
  remoteSite,
  deps
}) {
  item.attempts = Number(item.attempts || 0) + 1;
  const current = await revalidateItem({
    item,
    orgId,
    org,
    identity,
    localSite,
    remoteSite,
    deps
  });
  if (!current.ok) {
    item.state = RECOVERY_RESTORE_ITEM_STATES.CONFLICT;
    item.lastError = current.reason;
    await safeAudit(deps, {
      action: 'recovery-restore',
      orgId,
      sourceIssue: item.localKey,
      targetIssue: item.remoteKey,
      outcome: 'conflict',
      success: false,
      reason: 'restore-item-conflict',
      errors: [current.reason]
    });
    return { state: item.state, mappingWrites: 0, ledgerWrites: 0, reason: current.reason };
  }

  if (current.noWork) {
    item.state = RECOVERY_RESTORE_ITEM_STATES.PRESENT;
    item.mappingState = 'present';
    item.ledgerStates = current.ledgerStates;
    item.restoredAt = new Date(Number(deps.now())).toISOString();
    return { state: item.state, mappingWrites: 0, ledgerWrites: 0, reason: 'already-present' };
  }

  let mappingWrites = 0;
  let ledgerWrites = 0;
  item.mappingState = current.mapping.state;
  item.ledgerStates = current.ledgerStates;

  if (current.mapping.state === 'missing' || current.mapping.state === 'meta-missing') {
    try {
      const stored = await deps.storeMapping(item.localKey, item.remoteKey, orgId);
      mappingWrites = stored?.idempotent ? 0 : 1;
      item.mappingState = 'present';
    } catch (error) {
      item.state = RECOVERY_RESTORE_ITEM_STATES.PARTIAL;
      item.lastError = error?.code === 'MAPPING_CONFLICT' ? 'mapping-conflict' : 'mapping-write-failed';
      await safeAudit(deps, {
        action: 'recovery-restore',
        orgId,
        sourceIssue: item.localKey,
        targetIssue: item.remoteKey,
        outcome: 'partial',
        success: false,
        reason: item.lastError,
        errors: [item.lastError]
      });
      return { state: item.state, mappingWrites, ledgerWrites, reason: item.lastError };
    }
  }

  for (let index = 0; index < (item.ledgers || []).length; index += 1) {
    if (item.ledgerStates[index] === 'present') continue;
    const ledger = item.ledgers[index];
    let written;
    try {
      written = await writeLedgerRow(ledger, plan, deps);
    } catch {
      written = { state: 'unreadable', reason: 'ledger-write-failed' };
    }
    if (written.state === 'restored') {
      ledgerWrites += 1;
      item.ledgerStates[index] = 'present';
      continue;
    }
    if (written.state === 'present') {
      item.ledgerStates[index] = 'present';
      continue;
    }
    item.ledgerStates[index] = written.state;
    item.lastError = written.reason || 'ledger-write-failed';
    item.state = written.state === 'conflict'
      ? RECOVERY_RESTORE_ITEM_STATES.CONFLICT
      : RECOVERY_RESTORE_ITEM_STATES.PARTIAL;
    await safeAudit(deps, {
      action: 'recovery-restore',
      orgId,
      sourceIssue: item.localKey,
      targetIssue: item.remoteKey,
      outcome: 'conflict',
      success: false,
      reason: item.lastError,
      errors: [item.lastError]
    });
    return { state: item.state, mappingWrites, ledgerWrites, reason: item.lastError };
  }

  item.state = mappingWrites + ledgerWrites > 0
    ? RECOVERY_RESTORE_ITEM_STATES.RESTORED
    : RECOVERY_RESTORE_ITEM_STATES.PRESENT;
  item.lastError = null;
  item.restoredAt = new Date(Number(deps.now())).toISOString();
  await safeAudit(deps, {
    action: 'recovery-restore',
    orgId,
    sourceIssue: item.localKey,
    targetIssue: item.remoteKey,
    outcome: 'applied',
    success: true,
    reason: 'restore-item-applied'
  });
  return { state: item.state, mappingWrites, ledgerWrites, reason: null };
}


function remainingItems(plan) {
  return (plan.items || []).filter((item) => (
    item.state === RECOVERY_RESTORE_ITEM_STATES.PENDING
    || item.state === RECOVERY_RESTORE_ITEM_STATES.PARTIAL
  ));
}

async function settlePlan(plan, orgInfo, deps) {
  const remaining = remainingItems(plan).length;
  const conflicted = (plan.items || []).some((item) => (
    item.state === RECOVERY_RESTORE_ITEM_STATES.CONFLICT
  ));
  if (remaining > 0) {
    plan.status = RECOVERY_RESTORE_PLAN_STATES.RUNNING;
  } else {
    plan.status = conflicted
      ? RECOVERY_RESTORE_PLAN_STATES.NEEDS_ATTENTION
      : RECOVERY_RESTORE_PLAN_STATES.COMPLETED;
    plan.completedAt = new Date(Number(deps.now())).toISOString();
  }

  let authorizationState = SYNC_AUTHORIZATION_STATES.RESTORE_IN_PROGRESS;
  let authorizationWarning = null;
  if (remaining === 0) {
    try {
      await deps.setAuthorizationState({
        state: SYNC_AUTHORIZATION_STATES.BLOCKED,
        organizationIds: orgInfo.organizationIds,
        basis: 'restored',
        accountId: plan.approvedBy,
        reason: conflicted ? 'recovery-restore-needs-attention' : 'recovery-restore-completed'
      });
      authorizationState = SYNC_AUTHORIZATION_STATES.BLOCKED;
    } catch {
      // Leaving restore-in-progress is fail-closed: it blocks every Jira write
      // until an administrator explicitly re-authorizes the installation.
      authorizationWarning = 'authorization-not-transitioned';
    }
  }

  try {
    await deps.setStoredWithTtl(
      RECOVERY_RESTORE_PLAN_KEY(plan.orgId),
      plan,
      RECOVERY_RESTORE_PLAN_TTL_SECONDS
    );
  } catch {
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.APPLY_FAILED, {
      reason: 'progress-storage-failed'
    });
  }

  await safeAudit(deps, {
    action: 'recovery-restore',
    orgId: plan.orgId,
    outcome: remaining === 0 ? 'settled' : 'running',
    success: remaining === 0 && !conflicted,
    reason: conflicted
      ? 'restore-needs-attention'
      : (remaining === 0 ? 'restore-completed' : 'restore-running')
  });

  return {
    ...summarizePlan(plan),
    authorizationState,
    authorizationWarning
  };
}


/**
 * Runs one bounded, resumable batch. Every item is revalidated immediately
 * before its mapping or ledger write. Progress is persisted after each item, so
 * an interrupted invocation can be resumed without trusting cached evidence.
 */
export async function applyRecoveryRestore(options = {}) {
  const deps = depsOf(options);
  const orgId = normalizeOrganizationId(options.orgId);
  await readPause(deps);

  const requestedBatch = Number(options.batchSize);
  const batchSize = Number.isInteger(requestedBatch) && requestedBatch > 0
    ? Math.min(requestedBatch, RECOVERY_RESTORE_MAX_BATCH_SIZE)
    : RECOVERY_RESTORE_BATCH_SIZE;

  let lock;
  try {
    lock = await acquireRecoveryRestoreLock({ orgId, deps });
  } catch (error) {
    if (error instanceof RecoveryRestoreError) throw error;
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.APPLY_FAILED);
  }

  try {
    const plan = await readStoredPlan(orgId, deps);
    if (plan.status === RECOVERY_RESTORE_PLAN_STATES.COMPLETED) {
      let authorization = null;
      try {
        authorization = await deps.getStored('syncAuthorization');
      } catch {
        authorization = null;
      }
      return {
        ...summarizePlan(plan),
        processed: 0,
        mappingWrites: 0,
        ledgerWrites: 0,
        jiraWrites: 0,
        authorizationState: typeof authorization?.state === 'string'
          ? authorization.state
          : 'missing'
      };
    }
    if (![RECOVERY_RESTORE_PLAN_STATES.APPROVED,
      RECOVERY_RESTORE_PLAN_STATES.RUNNING,
      RECOVERY_RESTORE_PLAN_STATES.NEEDS_ATTENTION].includes(plan.status)) {
      throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.PLAN_NOT_APPROVED, {
        status: plan.status
      });
    }
    if (typeof options.digest === 'string' && options.digest !== plan.digest) {
      throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.PLAN_DIGEST_MISMATCH);
    }
    await assertRestoreArmed(deps);

    const orgInfo = await resolveOrganization(orgId, deps);
    const identity = plan.identity || {};
    if (!identity.installationId || !identity.appId || !identity.localSite || !identity.remoteSite) {
      throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.PREVIEW_FAILED, {
        reason: 'plan-identity-missing'
      });
    }
    await assertPlanIdentity(plan, orgInfo, deps);

    const pending = remainingItems(plan);
    if (pending.length === 0) {
      return {
        ...await settlePlan(plan, orgInfo, deps),
        processed: 0,
        mappingWrites: 0,
        ledgerWrites: 0,
        jiraWrites: 0
      };
    }

    const slice = pending.slice(0, batchSize);
    plan.status = RECOVERY_RESTORE_PLAN_STATES.RUNNING;
    plan.batches = Number(plan.batches || 0) + 1;
    let mappingWrites = 0;
    let ledgerWrites = 0;
    const processed = [];

    for (const item of slice) {
      const result = await processItem({
        item,
        plan,
        org: orgInfo.organization,
        orgId,
        identity,
        localSite: identity.localSite,
        remoteSite: identity.remoteSite,
        deps
      });
      mappingWrites += result.mappingWrites;
      ledgerWrites += result.ledgerWrites;
      processed.push({
        localKey: item.localKey,
        remoteKey: item.remoteKey,
        state: item.state,
        reason: result.reason || null
      });
      try {
        await deps.setStoredWithTtl(
          RECOVERY_RESTORE_PLAN_KEY(orgId),
          plan,
          RECOVERY_RESTORE_PLAN_TTL_SECONDS
        );
      } catch {
        throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.APPLY_FAILED, {
          reason: 'progress-storage-failed'
        });
      }
    }

    const settled = await settlePlan(plan, orgInfo, deps);
    return {
      ...settled,
      processed: processed.length,
      mappingWrites,
      ledgerWrites,
      jiraWrites: 0,
      pauseUnchanged: true,
      items: processed
    };
  } finally {
    await releaseRecoveryRestoreLock(lock, { deps });
  }
}


/** Cancels a plan, leaves the pause untouched and keeps synchronization blocked. */
export async function cancelRecoveryRestore(options = {}) {
  const deps = depsOf(options);
  const orgId = normalizeOrganizationId(options.orgId);
  await readPause(deps);
  let lock;
  try {
    lock = await acquireRecoveryRestoreLock({ orgId, deps });
  } catch (error) {
    if (error instanceof RecoveryRestoreError) throw error;
    throw new RecoveryRestoreError(RECOVERY_RESTORE_ERRORS.APPLY_FAILED);
  }

  try {
    const plan = await readStoredPlan(orgId, deps, { allowExpired: true });
    if (plan.status === RECOVERY_RESTORE_PLAN_STATES.CANCELLED) {
      return { ...summarizePlan(plan), alreadyCancelled: true, jiraWrites: 0 };
    }
    const wasArmed = [
      RECOVERY_RESTORE_PLAN_STATES.APPROVED,
      RECOVERY_RESTORE_PLAN_STATES.RUNNING,
      RECOVERY_RESTORE_PLAN_STATES.NEEDS_ATTENTION
    ].includes(plan.status);
    plan.status = RECOVERY_RESTORE_PLAN_STATES.CANCELLED;
    plan.cancelledAt = new Date(Number(deps.now())).toISOString();
    plan.expiresAt = Number(deps.now()) + RECOVERY_RESTORE_PLAN_TTL_SECONDS * 1000;

    const orgInfo = await resolveOrganization(orgId, deps);
    let currentAuthorization = null;
    try {
      currentAuthorization = await deps.getStored('syncAuthorization');
    } catch {
      currentAuthorization = null;
    }
    let authorizationState = typeof currentAuthorization?.state === 'string'
      ? currentAuthorization.state
      : 'missing';
    if (wasArmed) {
      try {
        await deps.setAuthorizationState({
          state: SYNC_AUTHORIZATION_STATES.BLOCKED,
          organizationIds: orgInfo.organizationIds,
          basis: 'restored',
          accountId: typeof options.accountId === 'string' ? options.accountId : null,
          reason: 'recovery-restore-cancelled'
        });
        authorizationState = SYNC_AUTHORIZATION_STATES.BLOCKED;
      } catch {
        // The plan is still cancelled; restore-in-progress remains fail-closed.
        authorizationState = SYNC_AUTHORIZATION_STATES.RESTORE_IN_PROGRESS;
      }
    }

    await deps.setStoredWithTtl(
      RECOVERY_RESTORE_PLAN_KEY(orgId),
      plan,
      RECOVERY_RESTORE_PLAN_TTL_SECONDS
    );
    await safeAudit(deps, {
      action: 'recovery-restore',
      orgId,
      outcome: 'cancelled',
      success: true,
      reason: 'restore-plan-cancelled'
    });
    return {
      ...summarizePlan(plan),
      alreadyCancelled: false,
      authorizationState,
      jiraWrites: 0
    };
  } finally {
    await releaseRecoveryRestoreLock(lock, { deps });
  }
}

/** Read-only plan status. It never writes and never changes authorization. */
export async function getRecoveryRestoreStatus(options = {}) {
  const deps = depsOf(options);
  const orgId = normalizeOrganizationId(options.orgId);
  let stored;
  try {
    stored = await deps.getStored(RECOVERY_RESTORE_PLAN_KEY(orgId));
  } catch {
    stored = null;
  }
  if (!isPlainObject(stored)
    || stored.version !== RECOVERY_RESTORE_VERSION
    || stored.orgId !== orgId
    || !Array.isArray(stored.items)) {
    return {
      success: true,
      orgId,
      plan: null,
      message: 'No recovery restore plan exists for this organization.'
    };
  }
  const expired = !(Number(stored.expiresAt) > Number(deps.now()));
  return {
    success: true,
    orgId,
    plan: {
      ...summarizePlan(stored),
      expired,
      approvedAt: stored.approvedAt || null,
      approvedBy: stored.approvedBy || null,
      createdAt: stored.createdAt || null,
      items: stored.items.map((item) => ({
        localKey: item.localKey,
        remoteKey: item.remoteKey,
        witness: item.witness,
        state: item.state,
        mappingState: item.mappingState,
        ledgerStates: item.ledgerStates || [],
        attempts: item.attempts || 0,
        lastError: item.lastError || null
      }))
    }
  };
}

