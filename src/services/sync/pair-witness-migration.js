import * as kvsStore from '../storage/kvs.js';
import { getAppContext } from '@forge/api';
import { readForgeInstallationIdentity } from '../readiness/connector-readiness.js';
import { getOrganizationsWithTokens, isValidIssueKey } from '../storage/mappings.js';
import { getPilotPause } from './pilot-pause.js';
import {
  PAIR_WITNESS_ISSUE_CLASSES,
  PAIR_WITNESS_READ_CLASSES,
  PAIR_WITNESS_SIDES,
  deterministicPairId,
  readIssueIdentity,
  readPairWitness
} from './pair-witness.js';
import {
  PAIR_WITNESS_PAIR_CLASSES,
  endedKey,
  previewPairWitnessMigration,
  readDirections,
  readFlagged,
  readLedger,
  repairKey
} from './pair-witness-preview.js';
import {
  PAIR_WITNESS_PERMIT_REASONS,
  PAIR_WITNESS_PLAN_KEY,
  PAIR_WITNESS_PLAN_TTL_SECONDS,
  PAIR_WITNESS_PLAN_VERSION,
  PairWitnessPermitError,
  acquirePairWitnessBatchLock,
  assertNoRestoreInProgress,
  assertPairWitnessBatchLockOwner,
  assertPauseConfirmedOn,
  issuePairWitnessPermit,
  markPairWitnessWritten,
  pairWitnessApprovalPhrase,
  readPairWitnessPermit,
  releasePairWitnessBatchLock,
  revokePairWitnessPermit
} from './pair-witness-permit.js';
import {
  PAIR_WITNESS_WRITE_OUTCOMES,
  buildWitnessBody,
  putWitnessProperty,
  verifyWitnessWrite,
  witnessBodyText,
  witnessEntry
} from './pair-witness-write.js';
import { stableStringify } from './recovery-snapshot.js';
import { createHash } from 'crypto';

/**
 * Controlled pairing-witness migration.
 *
 * Writes exactly one Jira property (`sync-connector-pair`) on the two issues of
 * each approved pair, while the connector stays paused and synchronization
 * authorization stays blocked. It never creates an issue, never updates a field
 * or description, and never writes a mapping or create-ledger record.
 *
 * Safety comes from five independent layers:
 *   1. a plan the administrator approved by digest;
 *   2. a short-lived permit naming the exact issues and payloads of one batch;
 *   3. the transport boundary re-evaluating that permit for every single PUT;
 *   4. atomic single-flight batch ownership;
 *   5. read-back verification before any progress is recorded.
 */

export const PAIR_WITNESS_BATCH_SIZE = 10;
export const PAIR_WITNESS_MIGRATION_MAX_PAIRS = 200;

export const PAIR_WITNESS_ITEM_STATES = Object.freeze({
  PENDING: 'pending',
  VERIFIED: 'verified',
  SKIPPED_VERIFIED: 'skipped-verified',
  PARTIAL: 'partial',
  CONFLICT: 'conflict',
  HISTORICAL: 'historical',
  DEFERRED: 'deferred'
});

export const PAIR_WITNESS_ITEM_ACTIONS = Object.freeze({
  BOTH: 'both',
  LOCAL: 'local',
  REMOTE: 'remote',
  NONE: 'none'
});

export const PAIR_WITNESS_MIGRATION_ERRORS = Object.freeze({
  ORGANIZATION_INVALID: 'PAIR_WITNESS_ORGANIZATION_INVALID',
  PLAN_EMPTY: 'PAIR_WITNESS_PLAN_EMPTY',
  PLAN_MISSING: 'PAIR_WITNESS_PLAN_MISSING',
  PLAN_EXPIRED: 'PAIR_WITNESS_PLAN_EXPIRED',
  PLAN_NOT_APPROVED: 'PAIR_WITNESS_PLAN_NOT_APPROVED',
  CONFIRMATION_REQUIRED: 'PAIR_WITNESS_CONFIRMATION_REQUIRED',
  PAUSE_REQUIRED: 'PAIR_WITNESS_PAUSE_REQUIRED',
  PAUSE_UNREADABLE: 'PAIR_WITNESS_PAUSE_UNREADABLE',
  RESTORE_IN_PROGRESS: 'PAIR_WITNESS_RESTORE_IN_PROGRESS',
  IDENTITY_UNAVAILABLE: 'PAIR_WITNESS_IDENTITY_UNAVAILABLE',
  BUSY: 'PAIR_WITNESS_BATCH_BUSY',
  PREVIEW_FAILED: 'PAIR_WITNESS_PREVIEW_FAILED',
  APPLY_FAILED: 'PAIR_WITNESS_APPLY_FAILED',
  SELECTION_INVALID: 'PAIR_WITNESS_SELECTION_INVALID',
  SELECTION_EMPTY: 'PAIR_WITNESS_SELECTION_EMPTY',
  SELECTION_DUPLICATE: 'PAIR_WITNESS_SELECTION_DUPLICATE',
  SELECTION_PAIR_UNKNOWN: 'PAIR_WITNESS_SELECTION_PAIR_UNKNOWN',
  SELECTION_PAIR_MISMATCH: 'PAIR_WITNESS_SELECTION_PAIR_MISMATCH',
  SELECTION_PAIR_INELIGIBLE: 'PAIR_WITNESS_SELECTION_PAIR_INELIGIBLE'
});

export const PAIR_WITNESS_MIGRATION_MESSAGES = Object.freeze({
  [PAIR_WITNESS_MIGRATION_ERRORS.ORGANIZATION_INVALID]:
    'The selected organization identifier is not valid.',
  [PAIR_WITNESS_MIGRATION_ERRORS.PLAN_EMPTY]:
    'No pair in this organization can be witnessed safely, so nothing was approved.',
  [PAIR_WITNESS_MIGRATION_ERRORS.PLAN_MISSING]:
    'No approved migration plan exists for this organization.',
  [PAIR_WITNESS_MIGRATION_ERRORS.PLAN_EXPIRED]:
    'The approved migration plan has expired. Approve a freshly validated plan to continue.',
  [PAIR_WITNESS_MIGRATION_ERRORS.PLAN_NOT_APPROVED]:
    'The migration plan is not in an approved state.',
  [PAIR_WITNESS_MIGRATION_ERRORS.CONFIRMATION_REQUIRED]:
    'The confirmation phrase does not match this plan. Nothing was approved.',
  [PAIR_WITNESS_MIGRATION_ERRORS.PAUSE_REQUIRED]:
    'Pause synchronization before approving or running a witness migration.',
  [PAIR_WITNESS_MIGRATION_ERRORS.PAUSE_UNREADABLE]:
    'The emergency pause state could not be read, so the migration was refused.',
  [PAIR_WITNESS_MIGRATION_ERRORS.RESTORE_IN_PROGRESS]:
    'A restore is in progress, so the migration was refused.',
  [PAIR_WITNESS_MIGRATION_ERRORS.IDENTITY_UNAVAILABLE]:
    'The Forge installation identity could not be read.',
  [PAIR_WITNESS_MIGRATION_ERRORS.BUSY]:
    'Another witness migration batch is already running for this installation.',
  [PAIR_WITNESS_MIGRATION_ERRORS.PREVIEW_FAILED]:
    'The plan could not be validated against current storage and Jira.',
  [PAIR_WITNESS_MIGRATION_ERRORS.APPLY_FAILED]: 'The witness migration batch could not be completed.',
  [PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_INVALID]:
    'The pair selection is not a list of { localKey, remoteKey } entries with valid issue keys.',
  [PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_EMPTY]:
    'An empty pair selection is refused. Omit the selection entirely to plan the whole organization.',
  [PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_DUPLICATE]:
    'The pair selection names the same pair, or the same local issue, more than once.',
  [PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_PAIR_UNKNOWN]:
    'A selected pair is not mapped in this organization.',
  [PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_PAIR_MISMATCH]:
    'A selected pair does not match the stored mapping for that local issue.',
  [PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_PAIR_INELIGIBLE]:
    'A selected pair cannot be witnessed safely, so the whole plan was refused.'
});

export class PairWitnessMigrationError extends Error {
  constructor(code, details = {}) {
    super(PAIR_WITNESS_MIGRATION_MESSAGES[code] || 'The witness migration was refused.');
    this.name = 'PairWitnessMigrationError';
    this.code = code;
    this.details = details;
  }
}

export function pairWitnessMigrationMessage(code) {
  return PAIR_WITNESS_MIGRATION_MESSAGES[code] || PAIR_WITNESS_MIGRATION_MESSAGES[
    PAIR_WITNESS_MIGRATION_ERRORS.APPLY_FAILED
  ];
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/**
 * Normalizes an explicit pair selection.
 *
 * `undefined` means "not supplied" and keeps the full-organization behaviour.
 * Anything else must be a non-empty list of exact `{ localKey, remoteKey }`
 * pairs: an empty list is refused rather than read as "all pairs", and the
 * result is sorted so the same selection always produces the same digest
 * regardless of the order an administrator typed it in.
 */
export function normalizePairSelection(input) {
  if (input === undefined) return null;
  if (!Array.isArray(input)) {
    throw new PairWitnessMigrationError(PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_INVALID, {
      type: typeof input
    });
  }
  if (input.length === 0) {
    throw new PairWitnessMigrationError(PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_EMPTY);
  }

  const byLocalKey = new Map();
  const selection = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new PairWitnessMigrationError(PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_INVALID, {
        entry: 'not-an-object'
      });
    }
    const localKey = typeof entry.localKey === 'string' ? entry.localKey.trim() : null;
    const remoteKey = typeof entry.remoteKey === 'string' ? entry.remoteKey.trim() : null;
    if (!isValidIssueKey(localKey) || !isValidIssueKey(remoteKey)) {
      throw new PairWitnessMigrationError(PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_INVALID, {
        localKey,
        remoteKey
      });
    }
    // One local issue can only ever have one remote counterpart, so a repeated
    // local key is a conflicting selection even when the remote key differs.
    if (byLocalKey.has(localKey)) {
      throw new PairWitnessMigrationError(PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_DUPLICATE, {
        localKey,
        firstRemoteKey: byLocalKey.get(localKey),
        remoteKey
      });
    }
    byLocalKey.set(localKey, remoteKey);
    selection.push({ localKey, remoteKey });
  }

  return selection.sort((left, right) => (
    left.localKey.localeCompare(right.localKey) || left.remoteKey.localeCompare(right.remoteKey)
  ));
}

/**
 * Digest over the plan's immutable identity: the selection mode, the exact
 * selected pairs in canonical order, the resulting item count and every item's
 * pair identity. A one-pair plan and a whole-organization plan can therefore
 * never share a digest, and neither can two selections of different sizes.
 */
function planDigestOf({ orgId, installationId, items, selection, selectionMode }) {
  const mode = selectionMode === 'explicit' && Array.isArray(selection)
    ? 'explicit'
    : 'organization';
  return sha256(stableStringify({
    purpose: 'pair-witness-migration',
    orgId,
    installationId,
    selectionMode: mode,
    selection: mode === 'explicit'
      ? selection.map((entry) => [entry.localKey, entry.remoteKey])
      : null,
    itemCount: items.length,
    items: items.map((item) => ({
      seq: item.seq,
      localKey: item.localKey,
      remoteKey: item.remoteKey,
      localIssueId: item.localIssueId,
      remoteIssueId: item.remoteIssueId,
      pairId: item.pairId,
      action: item.action
    }))
  }));
}

const defaultDeps = {
  getStored: kvsStore.get,
  setStoredWithTtl: kvsStore.setWithTtl,
  deleteKey: kvsStore.del,
  getOrganizations: getOrganizationsWithTokens,
  preview: previewPairWitnessMigration,
  readIdentity: readForgeInstallationIdentity,
  resolveIssue: readIssueIdentity,
  readWitness: readPairWitness,
  readPause: getPilotPause,
  getContext: getAppContext,
  now: () => Date.now()
};

/**
 * Builds and validates the plan from live evidence. Read-only.
 *
 * Every included pair carries the identity it will be written with: both stable
 * ids, the derived pair UUID and which sides still need a property. Anything the
 * preview cannot verify is excluded with its reason rather than approximated.
 */
export async function buildPairWitnessPlan(options = {}) {
  const deps = { ...defaultDeps, ...(options.deps || {}) };
  const orgId = options.orgId;

  let identity;
  try {
    identity = await deps.readIdentity();
  } catch {
    identity = null;
  }
  if (!identity || identity.readable !== true) {
    throw new PairWitnessMigrationError(PAIR_WITNESS_MIGRATION_ERRORS.IDENTITY_UNAVAILABLE);
  }
  const localSite = (Array.isArray(identity.cloudIds) && identity.cloudIds[0])
    || (typeof identity.siteHost === 'string' ? identity.siteHost : null);
  if (!localSite) {
    throw new PairWitnessMigrationError(PAIR_WITNESS_MIGRATION_ERRORS.IDENTITY_UNAVAILABLE);
  }

  let preview;
  try {
    preview = await deps.preview({
      orgId,
      maxPairs: PAIR_WITNESS_MIGRATION_MAX_PAIRS,
      deps: options.previewDeps
    });
  } catch (error) {
    if (error?.code && String(error.code).startsWith('PAIR_WITNESS_')) throw error;
    throw new PairWitnessMigrationError(PAIR_WITNESS_MIGRATION_ERRORS.PREVIEW_FAILED);
  }

  const items = [];
  const excluded = [];
  const remoteSite = preview.organization?.remoteSite || null;
  const selection = normalizePairSelection(options.pairs);
  const previewPairs = Array.isArray(preview.pairs) ? preview.pairs : [];

  // An explicit selection is resolved strictly against this organization's
  // mapped pairs. Unknown, re-pointed or partially matched pairs are refused
  // before a single item is built, so the plan can never be wider than asked.
  let pairsToPlan = previewPairs;
  if (selection) {
    pairsToPlan = selection.map((requested) => {
      const pair = previewPairs.find((candidate) => candidate.localKey === requested.localKey);
      if (!pair) {
        throw new PairWitnessMigrationError(PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_PAIR_UNKNOWN, {
          localKey: requested.localKey,
          remoteKey: requested.remoteKey,
          orgId
        });
      }
      if (pair.remoteKey !== requested.remoteKey) {
        throw new PairWitnessMigrationError(PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_PAIR_MISMATCH, {
          localKey: requested.localKey,
          requestedRemoteKey: requested.remoteKey,
          storedRemoteKey: pair.remoteKey
        });
      }
      return pair;
    });
  }

  for (const pair of pairsToPlan) {
    const localIssueId = pair.local?.issue?.id || null;
    const remoteIssueId = pair.remote?.issue?.id || null;
    // In full-organization mode an unsafe pair is reported and skipped. In
    // explicit mode the administrator asked for that exact pair, so an unsafe
    // pair refuses the whole plan instead of being silently dropped.
    const exclude = (reason) => {
      if (selection) {
        throw new PairWitnessMigrationError(
          PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_PAIR_INELIGIBLE,
          { localKey: pair.localKey, remoteKey: pair.remoteKey, reason }
        );
      }
      excluded.push({ localKey: pair.localKey, remoteKey: pair.remoteKey, reason });
    };


    if (!localIssueId || !remoteIssueId) {
      exclude('identity-unavailable');
      continue;
    }
    const pairId = deterministicPairId({
      installationId: identity.installationId,
      orgId,
      localIssueId,
      remoteIssueId
    });
    const localWitness = pair.local?.witness || {};
    const remoteWitness = pair.remote?.witness || {};

    if (pair.pairClass === PAIR_WITNESS_PAIR_CLASSES.READY) {
      items.push(item(pair, pairId, PAIR_WITNESS_ITEM_ACTIONS.BOTH));
      continue;
    }
    if (pair.pairClass === PAIR_WITNESS_PAIR_CLASSES.WITNESSED) {
      if (localWitness.pairId === pairId && remoteWitness.pairId === pairId) {
        items.push({
          ...item(pair, pairId, PAIR_WITNESS_ITEM_ACTIONS.NONE),
          state: PAIR_WITNESS_ITEM_STATES.SKIPPED_VERIFIED
        });
      } else {
        exclude('witness-pair-mismatch');
      }
      continue;
    }
    if (pair.pairClass === PAIR_WITNESS_PAIR_CLASSES.PARTIAL) {
      const existing = localWitness.class === PAIR_WITNESS_READ_CLASSES.MATCHING
        ? localWitness
        : remoteWitness;
      if (existing.pairId !== pairId) {
        exclude('witness-pair-mismatch');
        continue;
      }
      const action = localWitness.class === PAIR_WITNESS_READ_CLASSES.MATCHING
        ? PAIR_WITNESS_ITEM_ACTIONS.REMOTE
        : PAIR_WITNESS_ITEM_ACTIONS.LOCAL;
      items.push(item(pair, pairId, action));
      continue;
    }
    exclude(String(pair.pairClass));
  }

  // Sequence numbers are part of the digest, so they must be fixed before it is
  // computed and never renumbered afterwards. Items are also ordered canonically
  // by local key so the same selection always yields the same digest and the
  // same batch boundaries.
  items.sort((left, right) => (
    left.localKey.localeCompare(right.localKey) || left.remoteKey.localeCompare(right.remoteKey)
  ));
  items.forEach((entry, index) => {
    entry.seq = index + 1;
  });

  const writableItems = items.filter((entry) => entry.action !== PAIR_WITNESS_ITEM_ACTIONS.NONE);
  const writesRequired = writableItems.reduce((total, entry) => (
    total + (entry.action === PAIR_WITNESS_ITEM_ACTIONS.BOTH ? 2 : 1)
  ), 0);
  const selectionMode = selection ? 'explicit' : 'organization';
  const digest = planDigestOf({
    orgId,
    installationId: identity.installationId,
    items,
    selection,
    selectionMode
  });

  return {
    version: PAIR_WITNESS_PLAN_VERSION,
    orgId,
    installationId: identity.installationId,
    appId: identity.appId,
    localSite,
    remoteSite,
    selectionMode,
    selection,
    items,
    excluded,
    digest,
    counts: {
      pairs: items.length,
      writablePairs: writableItems.length,
      verifyOnlyPairs: items.length - writableItems.length,
      writesRequired,
      excludedPairs: excluded.length
    },
    approvalPhrase: pairWitnessApprovalPhrase({
      orgId,
      planDigest: digest,
      pairCount: writableItems.length
    }),
    limitations: [
      'This plan only writes the sync-connector-pair property. It creates no issue and changes no field, description, mapping or ledger record.',
      'Excluded pairs are reported with a reason and are never written, approximated or repaired.',
      'The plan expires 24 hours after approval; writes stop immediately when it expires.'
    ]
  };
}

function item(pair, pairId, action) {
  return {
    seq: 0,
    localKey: pair.localKey,
    remoteKey: pair.remoteKey,
    localIssueId: pair.local.issue.id,
    remoteIssueId: pair.remote.issue.id,
    pairId,
    action,
    state: action === PAIR_WITNESS_ITEM_ACTIONS.NONE
      ? PAIR_WITNESS_ITEM_STATES.SKIPPED_VERIFIED
      : PAIR_WITNESS_ITEM_STATES.PENDING,
    attempts: 0,
    lastError: null,
    verifiedAt: null
  };
}


/** Refuses unless the connector is explicitly paused and no restore is running. */
async function assertMaintenancePreconditions(deps) {
  try {
    await assertPauseConfirmedOn(deps);
  } catch (error) {
    const pauseReason = error?.reason;
    throw new PairWitnessMigrationError(
      pauseReason === PAIR_WITNESS_PERMIT_REASONS.PAUSE_UNREADABLE
        ? PAIR_WITNESS_MIGRATION_ERRORS.PAUSE_UNREADABLE
        : PAIR_WITNESS_MIGRATION_ERRORS.PAUSE_REQUIRED
    );
  }
  try {
    await assertNoRestoreInProgress(deps);
  } catch {
    throw new PairWitnessMigrationError(PAIR_WITNESS_MIGRATION_ERRORS.RESTORE_IN_PROGRESS);
  }
}

/** Permit entries for the sides of these items that still need a property. */
function entriesForItems(items, localSite) {
  const entries = [];
  for (const entry of items) {
    const writtenAt = new Date().toISOString();
    const record = buildWitnessBody({
      pairId: entry.pairId,
      installationId: entry.planInstallationId,
      appId: entry.planAppId,
      orgId: entry.planOrgId,
      localSite: entry.planLocalSite,
      remoteSite: entry.planRemoteSite,
      localIssueId: entry.localIssueId,
      localKey: entry.localKey,
      remoteIssueId: entry.remoteIssueId,
      remoteKey: entry.remoteKey,
      direction: 'local-to-remote',
      writtenAt
    });
    if (entry.action === PAIR_WITNESS_ITEM_ACTIONS.BOTH
      || entry.action === PAIR_WITNESS_ITEM_ACTIONS.LOCAL) {
      entries.push(witnessEntry({ record, site: 'local' }));
    }
    if (entry.action === PAIR_WITNESS_ITEM_ACTIONS.BOTH
      || entry.action === PAIR_WITNESS_ITEM_ACTIONS.REMOTE) {
      entries.push(witnessEntry({ record, site: entry.planRemoteSite }));
    }
    if (localSite && entry.action === PAIR_WITNESS_ITEM_ACTIONS.NONE) continue;
  }
  return entries;
}

/**
 * Approves one freshly validated plan and issues the first batch permit.
 *
 * The plan is recomputed from live storage and Jira here, so the digest in the
 * confirmation phrase can only match something this installation can actually
 * see right now. Approval writes two storage records and performs no Jira write.
 */
export async function approvePairWitnessMigration(options = {}) {
  const deps = { ...defaultDeps, ...(options.deps || {}) };
  const orgId = options.orgId;
  await assertMaintenancePreconditions(deps);

  const plan = await buildPairWitnessPlan({
    orgId,
    pairs: options.pairs,
    deps: options.deps,
    previewDeps: options.previewDeps
  });
  if (plan.counts.writablePairs === 0) {
    throw new PairWitnessMigrationError(PAIR_WITNESS_MIGRATION_ERRORS.PLAN_EMPTY, {
      verifyOnlyPairs: plan.counts.verifyOnlyPairs,
      excludedPairs: plan.counts.excludedPairs
    });
  }
  if (typeof options.confirmation !== 'string' || options.confirmation !== plan.approvalPhrase) {
    throw new PairWitnessMigrationError(PAIR_WITNESS_MIGRATION_ERRORS.CONFIRMATION_REQUIRED, {
      expectedPhrase: plan.approvalPhrase
    });
  }

  const existingPermit = await readPairWitnessPermit(deps);
  if (existingPermit && existingPermit.orgId !== orgId) {
    throw new PairWitnessPermitError(PAIR_WITNESS_PERMIT_REASONS.LOCK_HELD, {
      activePermitOrg: existingPermit.orgId
    });
  }

  const now = Number(deps.now());
  const approved = {
    ...plan,
    status: 'approved',
    approvedAt: new Date(now).toISOString(),
    approvedBy: typeof options.accountId === 'string' ? options.accountId.slice(0, 100) : null,
    expiresAt: now + PAIR_WITNESS_PLAN_TTL_SECONDS * 1000,
    batches: 0
  };
  await deps.setStoredWithTtl(PAIR_WITNESS_PLAN_KEY(orgId), approved, PAIR_WITNESS_PLAN_TTL_SECONDS);

  const firstSlice = approved.items
    .filter((entry) => entry.state === PAIR_WITNESS_ITEM_STATES.PENDING)
    .slice(0, PAIR_WITNESS_BATCH_SIZE)
    .map((entry) => ({
      ...entry,
      planInstallationId: plan.installationId,
      planAppId: plan.appId,
      planOrgId: plan.orgId,
      planLocalSite: plan.localSite,
      planRemoteSite: plan.remoteSite
    }));
  const permit = firstSlice.length > 0
    ? await issuePairWitnessPermit({
      orgId,
      planDigest: plan.digest,
      batchIndex: 0,
      installationId: plan.installationId,
      appId: plan.appId,
      localSite: plan.localSite,
      accountId: options.accountId,
      entries: entriesForItems(firstSlice, plan.localSite),
      deps
    })
    : null;

  return {
    success: true,
    orgId,
    digest: plan.digest,
    status: approved.status,
    selectionMode: plan.selectionMode,
    selection: plan.selection,
    counts: plan.counts,
    excluded: plan.excluded,
    permitIssued: Boolean(permit),
    permitExpiresAt: permit ? new Date(permit.expiresAt).toISOString() : null,
    permitEntries: permit ? permit.entries.length : 0,
    jiraWritesPerformed: 0
  };
}


/**
 * Re-reads every stored and Jira fact the plan assumed, immediately before a
 * write. Nothing is cached: a plan approved against a healthy pair must not
 * write into a pair that has since been ended, repaired, re-pointed or deleted.
 */
export async function revalidatePairItem({ entry, orgId, org, deps }) {
  const mapping = await readDirections(orgId, entry.localKey, entry.remoteKey, deps);
  if (!mapping.consistent) return { ok: false, reason: 'mapping-mismatch' };

  const ledger = await readLedger(orgId, entry.localKey, entry.remoteKey, deps);
  if (ledger.unreadable || ledger.inDoubt) return { ok: false, reason: 'create-in-doubt' };

  const ended = await readFlagged(endedKey(orgId, entry.localKey, entry.remoteKey), deps);
  if (ended.unreadable || ended.present) return { ok: false, reason: 'pair-ended' };

  const repaired = await readFlagged(repairKey(orgId, entry.localKey, entry.remoteKey), deps);
  if (repaired.unreadable || repaired.present) return { ok: false, reason: 'repair-required' };

  const local = await deps.resolveIssue({ side: PAIR_WITNESS_SIDES.LOCAL, issueRef: entry.localIssueId });
  if (local.class !== PAIR_WITNESS_ISSUE_CLASSES.PRESENT) {
    return { ok: false, reason: `local-issue-${local.class || 'unknown'}` };
  }
  if (local.id !== entry.localIssueId) return { ok: false, reason: 'local-issue-id-mismatch' };

  const remote = await deps.resolveIssue({
    side: PAIR_WITNESS_SIDES.REMOTE,
    issueRef: entry.remoteIssueId,
    org
  });
  if (remote.class !== PAIR_WITNESS_ISSUE_CLASSES.PRESENT) {
    return { ok: false, reason: `remote-issue-${remote.class || 'unknown'}` };
  }
  if (remote.id !== entry.remoteIssueId) return { ok: false, reason: 'remote-issue-id-mismatch' };

  return { ok: true, localIssue: local, remoteIssue: remote, mapping };
}

function expectedFor(entry, plan, side, issueId) {
  return {
    installationId: plan.installationId,
    appId: plan.appId,
    orgId: plan.orgId,
    localSite: plan.localSite,
    remoteSite: plan.remoteSite,
    pairId: entry.pairId,
    issueId
  };
}

/**
 * Writes one side and proves it by reading it back.
 *
 * A 5xx or transport failure is ambiguous, so the property is read back instead
 * of retried blindly: an identical value means the write landed, an absent value
 * is retried exactly once with the same pair, and anything else is a conflict.
 */
export async function writeAndVerifySide({ side, issueId, org, record, deps, lock }) {
  // Ownership is re-asserted for every single submission, so a lock that expired
  // or was taken by another invocation stops this one before it writes.
  if (lock) {
    try {
      await assertPairWitnessBatchLockOwner({ lock, deps });
    } catch (error) {
      return {
        status: PAIR_WITNESS_ITEM_STATES.DEFERRED,
        lastError: 'lock-lost',
        lockLost: true
      };
    }
  }

  const body = witnessBodyText(record);
  let result = await putWitnessProperty({ side, issueId, org, body, deps });

  if (result.outcome === PAIR_WITNESS_WRITE_OUTCOMES.DEFERRED) {
    return { status: PAIR_WITNESS_ITEM_STATES.DEFERRED, retryAfterMs: result.retryAfterMs };
  }
  if (result.outcome === PAIR_WITNESS_WRITE_OUTCOMES.CONFLICT
    || result.outcome === PAIR_WITNESS_WRITE_OUTCOMES.FAILED) {
    return {
      status: PAIR_WITNESS_ITEM_STATES.CONFLICT,
      statusCode: result.statusCode ?? null,
      detail: result.code || null
    };
  }

  let verification = await verifyWitnessWrite({ side, issueId, org, record, deps });
  if (verification.verified) {
    return { status: 'verified', verified: true, statusCode: result.statusCode ?? null };
  }

  if (result.ambiguous && verification.absent) {
    result = await putWitnessProperty({ side, issueId, org, body, deps });
    if (result.outcome === PAIR_WITNESS_WRITE_OUTCOMES.DEFERRED) {
      return { status: PAIR_WITNESS_ITEM_STATES.DEFERRED, retryAfterMs: result.retryAfterMs };
    }
    if (result.outcome === PAIR_WITNESS_WRITE_OUTCOMES.CONFLICT
      || result.outcome === PAIR_WITNESS_WRITE_OUTCOMES.FAILED) {
      return {
        status: PAIR_WITNESS_ITEM_STATES.PARTIAL,
        statusCode: result.statusCode ?? null,
        detail: result.code || null
      };
    }
    verification = await verifyWitnessWrite({ side, issueId, org, record, deps });
    if (verification.verified) {
      return { status: 'verified', verified: true, retried: true };
    }
  }

  return {
    status: verification.absent
      ? PAIR_WITNESS_ITEM_STATES.PARTIAL
      : PAIR_WITNESS_ITEM_STATES.CONFLICT,
    statusCode: verification.statusCode ?? null,
    detail: verification.readClass || null
  };
}


/**
 * Processes one approved pair: revalidate, read both witnesses, write only what
 * is missing, verify both, and report a state. It never deletes, never
 * overwrites a different witness, and never touches a mapping or ledger record.
 */
export async function processPairWitnessItem({ entry, plan, org, deps, lock }) {
  const revalidated = await revalidatePairItem({ entry, orgId: plan.orgId, org, deps });
  if (!revalidated.ok) {
    return {
      state: PAIR_WITNESS_ITEM_STATES.CONFLICT,
      lastError: revalidated.reason,
      writesPerformed: 0
    };
  }

  const localRead = await deps.readWitness({
    side: PAIR_WITNESS_SIDES.LOCAL,
    issueRef: entry.localIssueId,
    expected: expectedFor(entry, plan, PAIR_WITNESS_SIDES.LOCAL, entry.localIssueId)
  });
  const remoteRead = await deps.readWitness({
    side: PAIR_WITNESS_SIDES.REMOTE,
    issueRef: entry.remoteIssueId,
    org,
    expected: expectedFor(entry, plan, PAIR_WITNESS_SIDES.REMOTE, entry.remoteIssueId)
  });

  for (const side of [localRead, remoteRead]) {
    if (side.class === PAIR_WITNESS_READ_CLASSES.ENDED) {
      return { state: PAIR_WITNESS_ITEM_STATES.HISTORICAL, lastError: null, writesPerformed: 0 };
    }
  }
  const conflicts = [
    PAIR_WITNESS_READ_CLASSES.DIFFERENT_PAIR,
    PAIR_WITNESS_READ_CLASSES.MALFORMED,
    PAIR_WITNESS_READ_CLASSES.SCHEMA_NEWER,
    PAIR_WITNESS_READ_CLASSES.FOREIGN_INSTALLATION,
    PAIR_WITNESS_READ_CLASSES.FOREIGN_ORGANIZATION,
    PAIR_WITNESS_READ_CLASSES.ISSUE_MISMATCH,
    PAIR_WITNESS_READ_CLASSES.SITE_MISMATCH,
    PAIR_WITNESS_READ_CLASSES.PENDING_CREATE
  ];
  for (const side of [localRead, remoteRead]) {
    if (conflicts.includes(side.class)) {
      return {
        state: PAIR_WITNESS_ITEM_STATES.CONFLICT,
        lastError: `witness-${side.class}`,
        writesPerformed: 0
      };
    }
  }
  const unverifiable = [PAIR_WITNESS_READ_CLASSES.INACCESSIBLE, PAIR_WITNESS_READ_CLASSES.UNVERIFIABLE];
  for (const side of [localRead, remoteRead]) {
    if (unverifiable.includes(side.class)) {
      return {
        state: PAIR_WITNESS_ITEM_STATES.CONFLICT,
        lastError: `witness-${side.class}`,
        writesPerformed: 0
      };
    }
  }

  const localMatches = localRead.class === PAIR_WITNESS_READ_CLASSES.MATCHING
    && localRead.pairId === entry.pairId;
  const remoteMatches = remoteRead.class === PAIR_WITNESS_READ_CLASSES.MATCHING
    && remoteRead.pairId === entry.pairId;
  if (localMatches && remoteMatches) {
    return { state: PAIR_WITNESS_ITEM_STATES.VERIFIED, lastError: null, writesPerformed: 0 };
  }

  const record = buildWitnessBody({
    pairId: entry.pairId,
    installationId: plan.installationId,
    appId: plan.appId,
    orgId: plan.orgId,
    localSite: plan.localSite,
    remoteSite: plan.remoteSite,
    localIssueId: entry.localIssueId,
    localKey: entry.localKey,
    remoteIssueId: entry.remoteIssueId,
    remoteKey: entry.remoteKey,
    direction: 'local-to-remote',
    writtenAt: new Date(Number(deps.now())).toISOString()
  });

  let writes = 0;
  let localVerified = localMatches;
  if (!localMatches) {
    const localWrite = await writeAndVerifySide({
      side: PAIR_WITNESS_SIDES.LOCAL,
      issueId: entry.localIssueId,
      org,
      record,
      deps,
      lock
    });
    if (localWrite.status === PAIR_WITNESS_ITEM_STATES.DEFERRED) {
      return {
        state: PAIR_WITNESS_ITEM_STATES.DEFERRED,
        lastError: localWrite.lastError || 'rate-limited',
        writesPerformed: writes
      };
    }
    if (localWrite.status !== 'verified') {
      // Nothing was written on the remote side, so the pair is untouched there.
      return {
        state: localWrite.status,
        lastError: localWrite.detail || `local-http-${localWrite.statusCode ?? 'unknown'}`,
        writesPerformed: writes
      };
    }
    writes += 1;
    localVerified = true;
    await markPairWitnessWritten({
      orgId: plan.orgId,
      site: 'local',
      issueId: entry.localIssueId,
      pairId: entry.pairId
    }, deps).catch(() => false);
  }

  if (!remoteMatches) {
    const remoteWrite = await writeAndVerifySide({
      side: PAIR_WITNESS_SIDES.REMOTE,
      issueId: entry.remoteIssueId,
      org,
      record,
      deps,
      lock
    });
    if (remoteWrite.status === PAIR_WITNESS_ITEM_STATES.DEFERRED) {
      return {
        state: PAIR_WITNESS_ITEM_STATES.DEFERRED,
        lastError: remoteWrite.lastError || 'rate-limited',
        writesPerformed: writes
      };
    }
    if (remoteWrite.status !== 'verified') {
      // The local witness stays: it is real evidence and is never rolled back.
      return {
        state: PAIR_WITNESS_ITEM_STATES.PARTIAL,
        lastError: remoteWrite.detail || `remote-http-${remoteWrite.statusCode ?? 'unknown'}`,
        writesPerformed: writes
      };
    }
    writes += 1;
    await markPairWitnessWritten({
      orgId: plan.orgId,
      site: plan.remoteSite,
      issueId: entry.remoteIssueId,
      pairId: entry.pairId
    }, deps).catch(() => false);
  }

  return {
    state: localVerified ? PAIR_WITNESS_ITEM_STATES.VERIFIED : PAIR_WITNESS_ITEM_STATES.PARTIAL,
    lastError: null,
    writesPerformed: writes
  };
}


async function readStoredPlan(orgId, deps) {
  let stored;
  try {
    stored = await deps.getStored(PAIR_WITNESS_PLAN_KEY(orgId));
  } catch {
    throw new PairWitnessMigrationError(PAIR_WITNESS_MIGRATION_ERRORS.PLAN_MISSING);
  }
  if (!stored || typeof stored !== 'object' || stored.version !== PAIR_WITNESS_PLAN_VERSION) {
    throw new PairWitnessMigrationError(PAIR_WITNESS_MIGRATION_ERRORS.PLAN_MISSING);
  }
  // Terminal plans are readable so a repeated batch is a harmless no-op; only
  // pending work can ever produce a write, and the digest above proves the item
  // list was not edited since approval.
  const runnable = new Set(['approved', 'running', 'completed', 'needs-attention']);
  if (!runnable.has(stored.status)) {
    throw new PairWitnessMigrationError(PAIR_WITNESS_MIGRATION_ERRORS.PLAN_NOT_APPROVED, {
      status: stored.status
    });
  }
  if (!(Number(stored.expiresAt) > Number(deps.now()))) {
    throw new PairWitnessMigrationError(PAIR_WITNESS_MIGRATION_ERRORS.PLAN_EXPIRED);
  }
  if (typeof stored.digest !== 'string' || !Array.isArray(stored.items)) {
    throw new PairWitnessMigrationError(PAIR_WITNESS_MIGRATION_ERRORS.PLAN_MISSING);
  }
  // The plan is immutable: its digest must still describe exactly these items.
  if (planDigestOf(stored) !== stored.digest) {
    throw new PairWitnessMigrationError(PAIR_WITNESS_MIGRATION_ERRORS.PLAN_NOT_APPROVED, {
      reason: 'plan-digest-mismatch'
    });
  }
  return stored;
}

async function persistPlan(plan, deps) {
  await deps.setStoredWithTtl(
    PAIR_WITNESS_PLAN_KEY(plan.orgId),
    plan,
    PAIR_WITNESS_PLAN_TTL_SECONDS
  );
}

function withPlanContext(entry, plan) {
  return {
    ...entry,
    planInstallationId: plan.installationId,
    planAppId: plan.appId,
    planOrgId: plan.orgId,
    planLocalSite: plan.localSite,
    planRemoteSite: plan.remoteSite
  };
}

function summarize(plan, extra = {}) {
  const byState = {};
  for (const entry of plan.items) {
    byState[entry.state] = (byState[entry.state] || 0) + 1;
  }
  return {
    success: true,
    orgId: plan.orgId,
    digest: plan.digest,
    status: plan.status,
    counts: plan.counts,
    states: byState,
    excluded: plan.excluded || [],
    ...extra
  };
}

/**
 * A plan with nothing left to write is only "completed" when every pair ended
 * verified or verify-only. A pair that conflicts is terminal but unfinished, so
 * the plan reports `needs-attention` and stops accepting further batches until
 * an administrator approves a freshly validated plan.
 */
function settleStatus(plan, remaining) {
  if (remaining > 0) {
    plan.status = 'running';
    return plan.status;
  }
  const conflicted = plan.items.some((entry) => (
    entry.state === PAIR_WITNESS_ITEM_STATES.CONFLICT
  ));
  plan.status = conflicted ? 'needs-attention' : 'completed';
  if (plan.status === 'completed') {
    plan.completedAt = plan.completedAt || null;
  }
  return plan.status;
}

function remainingCount(plan) {
  return plan.items.filter((entry) => (
    entry.state === PAIR_WITNESS_ITEM_STATES.PENDING
    || entry.state === PAIR_WITNESS_ITEM_STATES.PARTIAL
    || entry.state === PAIR_WITNESS_ITEM_STATES.DEFERRED
  )).length;
}

async function resolveOrganization(orgId, deps) {
  let organizations;
  try {
    organizations = await deps.getOrganizations();
  } catch {
    organizations = [];
  }
  const list = Array.isArray(organizations) ? organizations : [];
  const organization = list.find((entry) => entry && entry.id === orgId);
  if (!organization || typeof organization.remoteUrl !== 'string'
    || typeof organization.remoteApiToken !== 'string' || organization.remoteApiToken === '') {
    throw new PairWitnessMigrationError(PAIR_WITNESS_MIGRATION_ERRORS.PREVIEW_FAILED, {
      reason: 'organization-unusable'
    });
  }
  return organization;
}


/**
 * Runs one bounded batch.
 *
 * Single-flight ownership is taken with an atomic create-if-absent. Continuation
 * after expiry or interruption revalidates the stored plan (digest, immutability,
 * expiry) and re-reads every fact per pair; it never reuses a stale permit.
 */
export async function applyPairWitnessMigration(options = {}) {
  const deps = { ...defaultDeps, ...(options.deps || {}) };
  const orgId = options.orgId;
  await assertMaintenancePreconditions(deps);

  let lock;
  try {
    lock = await acquirePairWitnessBatchLock({ deps });
  } catch (error) {
    if (error?.reason === PAIR_WITNESS_PERMIT_REASONS.LOCK_HELD) {
      throw new PairWitnessMigrationError(PAIR_WITNESS_MIGRATION_ERRORS.BUSY);
    }
    throw error;
  }

  try {
    const plan = await readStoredPlan(orgId, deps);
    const org = await resolveOrganization(orgId, deps);

    const pending = plan.items.filter((entry) => (
      entry.state === PAIR_WITNESS_ITEM_STATES.PENDING
      || entry.state === PAIR_WITNESS_ITEM_STATES.PARTIAL
      || entry.state === PAIR_WITNESS_ITEM_STATES.DEFERRED
    ));

    if (pending.length === 0) {
      settleStatus(plan, 0);
      await persistPlan(plan, deps);
      await revokePairWitnessPermit(deps);
      return summarize(plan, { processed: 0, writesPerformed: 0, remaining: 0 });
    }

    const slice = pending.slice(0, PAIR_WITNESS_BATCH_SIZE)
      .map((entry) => withPlanContext(entry, plan));
    const permit = await issuePairWitnessPermit({
      orgId,
      planDigest: plan.digest,
      batchIndex: plan.batches || 0,
      installationId: plan.installationId,
      appId: plan.appId,
      localSite: plan.localSite,
      accountId: options.accountId,
      entries: entriesForItems(slice, plan.localSite),
      deps
    });
    plan.status = 'running';
    plan.batches = (plan.batches || 0) + 1;
    plan.lastBatchAt = new Date(Number(deps.now())).toISOString();
    await persistPlan(plan, deps);

    let writesPerformed = 0;
    let processed = 0;
    let stopReason = null;

    for (const entry of slice) {
      const outcome = await processPairWitnessItem({ entry, plan, org, deps, lock });
      processed += 1;
      writesPerformed += outcome.writesPerformed || 0;
      const index = plan.items.findIndex((candidate) => candidate.seq === entry.seq);
      if (index >= 0) {
        plan.items[index] = {
          ...plan.items[index],
          state: outcome.state,
          lastError: outcome.lastError,
          attempts: (plan.items[index].attempts || 0) + 1,
          verifiedAt: outcome.state === PAIR_WITNESS_ITEM_STATES.VERIFIED
            ? new Date(Number(deps.now())).toISOString()
            : plan.items[index].verifiedAt || null
        };
      }
      // Progress is durable per pair: an interrupted batch loses no evidence.
      await persistPlan(plan, deps);
      if (outcome.state === PAIR_WITNESS_ITEM_STATES.DEFERRED) {
        stopReason = outcome.lastError === 'lock-lost'
          ? 'lock-lost'
          : (outcome.lastError === 'rate-limited' ? 'rate-limited' : 'deferred');
        break;
      }
    }

    // The permit is single-batch: consumed here, re-minted by the next call.
    await revokePairWitnessPermit(deps);

    const remaining = remainingCount(plan);
    settleStatus(plan, remaining);
    if (plan.status === 'completed') {
      plan.completedAt = new Date(Number(deps.now())).toISOString();
    }
    await persistPlan(plan, deps);

    return summarize(plan, {
      processed,
      writesPerformed,
      remaining,
      batchSize: slice.length,
      permitId: permit.permitId,
      permitExpiresAt: new Date(permit.expiresAt).toISOString(),
      stopReason
    });
  } finally {
    await releasePairWitnessBatchLock(lock, deps);
  }
}

/** Revokes permission and forgets progress. It never touches a Jira property. */
export async function cancelPairWitnessMigration(options = {}) {
  const deps = { ...defaultDeps, ...(options.deps || {}) };
  const orgId = options.orgId;
  const revoked = await revokePairWitnessPermit(deps);
  let planDeleted = false;
  try {
    await deps.deleteKey(PAIR_WITNESS_PLAN_KEY(orgId));
    planDeleted = true;
  } catch {
    planDeleted = false;
  }
  return {
    success: true,
    orgId,
    permitRevoked: revoked,
    planDeleted,
    jiraRequests: 0,
    propertiesDeleted: 0,
    note: 'Cancellation revokes the permit and removes local progress only. No Jira property is created, changed or deleted.'
  };
}


export async function getPairWitnessMigrationStatus(options = {}) {
  const deps = { ...defaultDeps, ...(options.deps || {}) };
  const orgId = options.orgId;
  let stored = null;
  try {
    stored = await deps.getStored(PAIR_WITNESS_PLAN_KEY(orgId));
  } catch {
    stored = null;
  }
  const permit = await readPairWitnessPermit(deps);
  const now = Number(deps.now());
  const permitSummary = permit && permit.orgId === orgId
    ? {
      permitId: permit.permitId,
      expiresAt: new Date(permit.expiresAt).toISOString(),
      entries: permit.entries.length
    }
    : null;

  if (!stored || typeof stored !== 'object' || stored.version !== PAIR_WITNESS_PLAN_VERSION) {
    return {
      success: true,
      orgId,
      plan: null,
      permit: permitSummary,
      message: 'No witness migration plan exists for this organization.'
    };
  }

  const byState = {};
  for (const entry of stored.items || []) {
    byState[entry.state] = (byState[entry.state] || 0) + 1;
  }
  const remaining = (stored.items || []).filter((entry) => (
    entry.state === PAIR_WITNESS_ITEM_STATES.PENDING
    || entry.state === PAIR_WITNESS_ITEM_STATES.PARTIAL
    || entry.state === PAIR_WITNESS_ITEM_STATES.DEFERRED
  )).length;

  return {
    success: true,
    orgId,
    plan: {
      digest: stored.digest,
      status: stored.status,
      selectionMode: stored.selectionMode || 'organization',
      selection: stored.selection || null,
      approvedAt: stored.approvedAt || null,
      approvedBy: stored.approvedBy || null,
      expiresAt: Number(stored.expiresAt) > now ? new Date(stored.expiresAt).toISOString() : null,
      expired: !(Number(stored.expiresAt) > now),
      batches: stored.batches || 0,
      counts: stored.counts || null,
      states: byState,
      remaining,
      items: (stored.items || []).map((entry) => ({
        seq: entry.seq,
        localKey: entry.localKey,
        remoteKey: entry.remoteKey,
        pairId: entry.pairId,
        action: entry.action,
        state: entry.state,
        lastError: entry.lastError || null,
        attempts: entry.attempts || 0
      })),
      excluded: stored.excluded || []
    },
    permit: permitSummary
  };
}

