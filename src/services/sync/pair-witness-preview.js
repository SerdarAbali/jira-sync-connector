import * as kvsStore from '../storage/kvs.js';
import { getPilotPause } from './pilot-pause.js';
import { readForgeInstallationIdentity } from '../readiness/connector-readiness.js';
import { getOrganizationsWithTokens, isValidIssueKey } from '../storage/mappings.js';
import {
  ISSUE_CREATE_DIRECTIONS,
  ISSUE_CREATE_STATES,
  buildIssueCreateOperationKey
} from './issue-create-operation.js';
import { RecoverySnapshotError, normalizeSnapshotOrgId } from './recovery-snapshot.js';
import {
  PAIR_WITNESS_ISSUE_CLASSES,
  PAIR_WITNESS_READ_CLASSES,
  PAIR_WITNESS_SIDES,
  readIssueIdentity,
  readPairWitness
} from './pair-witness.js';

/**
 * Read-only migration preview for Jira issue-property pairing witnesses.
 *
 * The preview answers one question without changing anything: for the pairs
 * this installation currently believes in, which already carry a matching
 * witness on both issues, which carry none, and which carry a witness that
 * contradicts storage or cannot be verified?
 *
 * Boundaries:
 * - No property is written, no issue is created or modified, no mapping or ledger
 *   record is written, and the pause state is never changed. The module imports
 *   no write helper from the storage layer and issues no POST/PUT/DELETE.
 * - Every Jira read is a GET through the guarded transport, so the pause, lease
 *   migration and synchronization-authorization gates still apply.
 * - A 403 on an issue or property is reported as inaccessible, never as absent.
 *   A 429, 5xx or transport failure is reported as unverifiable.
 * - The scan is bounded. A bounded result is reported as truncated rather than
 *   presented as complete, exactly as the snapshot preview does.
 */

export const PAIR_WITNESS_PREVIEW_DEFAULT_MAX_PAIRS = 25;
export const PAIR_WITNESS_PREVIEW_MAX_PAIRS = 200;
export const PAIR_WITNESS_PREVIEW_SCAN_PAGE_SIZE = 100;
export const PAIR_WITNESS_PREVIEW_FINDING_LIMIT = 50;
export const PAIR_WITNESS_PREVIEW_MAPPING_PREFIX = 'mapping-meta';

/**
 * Pair classes, in the precedence order used by classifyPair. The first match
 * decides, so a pair that is both contradicted by storage and missing a witness
 * is reported as the stronger problem.
 */
export const PAIR_WITNESS_PAIR_CLASSES = Object.freeze({
  MAPPING_MISMATCH: 'mapping-mismatch',
  CREATE_IN_DOUBT: 'create-in-doubt',
  DUPLICATE_DESTINATION: 'duplicate-destination',
  PAIR_ENDED: 'pair-ended',
  REPAIR_REQUIRED: 'repair-required',
  COUNTERPART_MISSING: 'counterpart-missing',
  COUNTERPART_INACCESSIBLE: 'counterpart-inaccessible',
  UNVERIFIED: 'unverified',
  WITNESS_CONFLICT: 'witness-conflict',
  WITNESS_INACCESSIBLE: 'witness-inaccessible',
  WITNESS_UNVERIFIABLE: 'witness-unverifiable',
  WITNESS_ENDED: 'witness-ended',
  WITNESS_PENDING_CREATE: 'witness-pending-create',
  PARTIAL: 'partially-witnessed',
  WITNESSED: 'already-witnessed',
  READY: 'ready-to-witness'
});

export const PAIR_WITNESS_PREVIEW_ERRORS = Object.freeze({
  ORGANIZATION_REQUIRED: 'PAIR_WITNESS_ORGANIZATION_REQUIRED',
  ORGANIZATION_INVALID: 'PAIR_WITNESS_ORGANIZATION_INVALID',
  ORGANIZATION_NOT_FOUND: 'PAIR_WITNESS_ORGANIZATION_NOT_FOUND',
  ORGANIZATION_UNUSABLE: 'PAIR_WITNESS_ORGANIZATION_UNUSABLE',
  IDENTITY_UNAVAILABLE: 'PAIR_WITNESS_IDENTITY_UNAVAILABLE',
  REQUIRES_PAUSE: 'PAIR_WITNESS_REQUIRES_PAUSE',
  PAUSE_UNREADABLE: 'PAIR_WITNESS_PAUSE_UNREADABLE',
  STORAGE_UNAVAILABLE: 'PAIR_WITNESS_STORAGE_UNAVAILABLE',
  PREVIEW_FAILED: 'PAIR_WITNESS_PREVIEW_FAILED'
});

const PREVIEW_ERROR_TEXT = Object.freeze({
  [PAIR_WITNESS_PREVIEW_ERRORS.ORGANIZATION_REQUIRED]:
    'Select exactly one organization before previewing pairing witnesses.',
  [PAIR_WITNESS_PREVIEW_ERRORS.ORGANIZATION_INVALID]:
    'The selected organization identifier is not valid.',
  [PAIR_WITNESS_PREVIEW_ERRORS.ORGANIZATION_NOT_FOUND]:
    'The selected organization is not configured in this installation.',
  [PAIR_WITNESS_PREVIEW_ERRORS.ORGANIZATION_UNUSABLE]:
    'The selected organization has no usable remote site or credentials, so its issues cannot be verified.',
  [PAIR_WITNESS_PREVIEW_ERRORS.IDENTITY_UNAVAILABLE]:
    'The Forge installation identity could not be read, so a witness could not be attributed to this installation.',
  [PAIR_WITNESS_PREVIEW_ERRORS.REQUIRES_PAUSE]:
    'Pause synchronization before previewing pairing witnesses. The preview never changes the pause state itself.',
  [PAIR_WITNESS_PREVIEW_ERRORS.PAUSE_UNREADABLE]:
    'The emergency pause state could not be read. Previewing without it could describe a moving target, so the preview was refused.',
  [PAIR_WITNESS_PREVIEW_ERRORS.STORAGE_UNAVAILABLE]:
    'Connector storage could not be read, so no preview was reported and nothing was written.',
  [PAIR_WITNESS_PREVIEW_ERRORS.PREVIEW_FAILED]: 'The pairing-witness preview could not be completed.'
});

export function pairWitnessPreviewErrorMessage(code) {
  return PREVIEW_ERROR_TEXT[code] || PREVIEW_ERROR_TEXT[PAIR_WITNESS_PREVIEW_ERRORS.PREVIEW_FAILED];
}

export function pairWitnessPreviewError(code, details = {}) {
  const error = new Error(pairWitnessPreviewErrorMessage(code));
  error.name = 'PairWitnessPreviewError';
  error.code = code;
  error.details = details;
  return error;
}

export const PAIR_WITNESS_PREVIEW_LIMITATIONS = Object.freeze([
  'This preview only reads. It writes no issue property, creates no issue and changes no mapping, ledger row or pause state.',
  'No migration approval or apply action exists yet. A pair reported as ready-to-witness is a proposal for a later, separately authorized migration.',
  'Pairing evidence is limited to the stored mapping-meta index and both directed lookup prefixes. Issue descriptions and cross-reference text are never read, and are therefore never used as proof of a pairing; the description marker is supplementary at best.',
  'A witness that cannot be read is never reported as missing: 403 is inaccessible, 429/5xx and transport failures are unverifiable, and both block a future write.',
  'The scan is bounded by the requested pair count. A truncated result describes only the pairs listed.',
  'Ended pairs are reported, not repaired. A historical witness is never deleted merely because synchronization ended; a future migration transitions it to an ended state instead.',
  'An in-doubt create ledger row blocks classification. The existing ledger stays the authority for ambiguous creates; this preview never resolves one.'
]);


const WITNESS_CONFLICT_CLASSES = new Set([
  PAIR_WITNESS_READ_CLASSES.DIFFERENT_PAIR,
  PAIR_WITNESS_READ_CLASSES.MALFORMED,
  PAIR_WITNESS_READ_CLASSES.SCHEMA_NEWER,
  PAIR_WITNESS_READ_CLASSES.FOREIGN_INSTALLATION,
  PAIR_WITNESS_READ_CLASSES.FOREIGN_ORGANIZATION,
  PAIR_WITNESS_READ_CLASSES.ISSUE_MISMATCH,
  PAIR_WITNESS_READ_CLASSES.SITE_MISMATCH
]);

const IN_DOUBT_LEDGER_STATES = new Set([
  ISSUE_CREATE_STATES.PENDING,
  ISSUE_CREATE_STATES.UNKNOWN
]);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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

function mappingPrefix(orgId) {
  return `${PAIR_WITNESS_PREVIEW_MAPPING_PREFIX}:${orgId}:`;
}

function directionKeys(orgId, localKey, remoteKey) {
  return {
    localToRemote: `${orgId}:local-to-remote:${localKey}`,
    remoteToLocal: `${orgId}:remote-to-local:${remoteKey}`
  };
}

function ledgerKeys(orgId, localKey, remoteKey) {
  return {
    localToRemote: buildIssueCreateOperationKey({
      orgId,
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: localKey
    }),
    remoteToLocal: buildIssueCreateOperationKey({
      orgId,
      direction: ISSUE_CREATE_DIRECTIONS.REMOTE_TO_LOCAL,
      sourceKey: remoteKey
    })
  };
}

function endedKey(orgId, localKey, remoteKey) {
  return `mapping-ended:${orgId}:${localKey}:${remoteKey}`;
}

function repairKey(orgId, localKey, remoteKey) {
  return `mapping-repair:${orgId}:${localKey}:${remoteKey}`;
}

/** Reads one named record; a read failure is reported, never silently treated as absent. */
async function readFlagged(key, deps) {
  try {
    const value = await deps.getStored(key);
    return { present: value !== null && value !== undefined, unreadable: false };
  } catch {
    return { present: false, unreadable: true };
  }
}

async function readLedger(orgId, localKey, remoteKey, deps) {
  const keys = ledgerKeys(orgId, localKey, remoteKey);
  try {
    const [forward, reverse] = await Promise.all([
      deps.getStored(keys.localToRemote),
      deps.getStored(keys.remoteToLocal)
    ]);
    const states = [forward, reverse]
      .map((record) => (isPlainObject(record) && typeof record.state === 'string' ? record.state : null))
      .filter(Boolean);
    if (states.length === 0) return { state: 'none', unreadable: false, inDoubt: false };
    const inDoubt = states.some((state) => IN_DOUBT_LEDGER_STATES.has(state));
    return { state: states.join('+'), unreadable: false, inDoubt };
  } catch {
    return { state: 'unreadable', unreadable: true, inDoubt: false };
  }
}

async function readDirections(orgId, localKey, remoteKey, deps) {
  const keys = directionKeys(orgId, localKey, remoteKey);
  try {
    const [forward, reverse] = await Promise.all([
      deps.getStored(keys.localToRemote),
      deps.getStored(keys.remoteToLocal)
    ]);
    const forwardOk = forward === remoteKey;
    const reverseOk = reverse === localKey;
    return {
      forward: typeof forward === 'string' ? forward : null,
      reverse: typeof reverse === 'string' ? reverse : null,
      forwardOk,
      reverseOk,
      consistent: forwardOk && reverseOk,
      unreadable: false
    };
  } catch {
    return {
      forward: null,
      reverse: null,
      forwardOk: false,
      reverseOk: false,
      consistent: false,
      unreadable: true
    };
  }
}


/**
 * Classifies one pair. Pure: all reads happen before this runs, so the ordering
 * is testable without any transport.
 */
export function classifyPair(pair = {}) {
  const localIssue = pair.local?.issue || {};
  const remoteIssue = pair.remote?.issue || {};
  const localWitness = pair.local?.witness || {};
  const remoteWitness = pair.remote?.witness || {};
  const witnessClasses = [localWitness.class, remoteWitness.class].filter(Boolean);

  if (pair.mapping?.unreadable === true) return PAIR_WITNESS_PAIR_CLASSES.MAPPING_MISMATCH;
  if (pair.mapping?.consistent === false) return PAIR_WITNESS_PAIR_CLASSES.MAPPING_MISMATCH;
  if (pair.ledger?.unreadable === true) return PAIR_WITNESS_PAIR_CLASSES.CREATE_IN_DOUBT;
  if (pair.ledger?.inDoubt === true) return PAIR_WITNESS_PAIR_CLASSES.CREATE_IN_DOUBT;
  if (pair.ended?.unreadable === true) return PAIR_WITNESS_PAIR_CLASSES.UNVERIFIED;
  if (pair.ended?.present === true) return PAIR_WITNESS_PAIR_CLASSES.PAIR_ENDED;
  if (pair.repaired?.unreadable === true) return PAIR_WITNESS_PAIR_CLASSES.UNVERIFIED;
  if (pair.repaired?.present === true) return PAIR_WITNESS_PAIR_CLASSES.REPAIR_REQUIRED;

  const issueClasses = [localIssue.class, remoteIssue.class];
  if (issueClasses.includes(PAIR_WITNESS_ISSUE_CLASSES.MISSING)) {
    return PAIR_WITNESS_PAIR_CLASSES.COUNTERPART_MISSING;
  }
  if (issueClasses.includes(PAIR_WITNESS_ISSUE_CLASSES.INACCESSIBLE)) {
    return PAIR_WITNESS_PAIR_CLASSES.COUNTERPART_INACCESSIBLE;
  }
  if (issueClasses.includes(PAIR_WITNESS_ISSUE_CLASSES.UNVERIFIABLE)) {
    return PAIR_WITNESS_PAIR_CLASSES.UNVERIFIED;
  }

  if (witnessClasses.some((readClass) => WITNESS_CONFLICT_CLASSES.has(readClass))) {
    return PAIR_WITNESS_PAIR_CLASSES.WITNESS_CONFLICT;
  }
  if (witnessClasses.includes(PAIR_WITNESS_READ_CLASSES.INACCESSIBLE)) {
    return PAIR_WITNESS_PAIR_CLASSES.WITNESS_INACCESSIBLE;
  }
  if (witnessClasses.includes(PAIR_WITNESS_READ_CLASSES.UNVERIFIABLE)) {
    return PAIR_WITNESS_PAIR_CLASSES.WITNESS_UNVERIFIABLE;
  }
  if (witnessClasses.includes(PAIR_WITNESS_READ_CLASSES.ENDED)) {
    return PAIR_WITNESS_PAIR_CLASSES.WITNESS_ENDED;
  }
  if (witnessClasses.includes(PAIR_WITNESS_READ_CLASSES.PENDING_CREATE)) {
    return PAIR_WITNESS_PAIR_CLASSES.WITNESS_PENDING_CREATE;
  }

  const matching = witnessClasses
    .filter((readClass) => readClass === PAIR_WITNESS_READ_CLASSES.MATCHING).length;
  const absent = witnessClasses
    .filter((readClass) => readClass === PAIR_WITNESS_READ_CLASSES.ABSENT).length;
  if (matching === 2) return PAIR_WITNESS_PAIR_CLASSES.WITNESSED;
  if (matching === 1 && absent === 1) return PAIR_WITNESS_PAIR_CLASSES.PARTIAL;
  if (absent === 2) return PAIR_WITNESS_PAIR_CLASSES.READY;
  return PAIR_WITNESS_PAIR_CLASSES.WITNESS_UNVERIFIABLE;
}

/** Groups pairs by destination so two local issues claiming one remote issue are visible. */
export function findDuplicateDestinations(pairs = []) {
  const byRemote = new Map();
  for (const pair of pairs) {
    if (!isPlainObject(pair) || typeof pair.remoteKey !== 'string') continue;
    const group = byRemote.get(pair.remoteKey) || [];
    group.push(pair.localKey);
    byRemote.set(pair.remoteKey, group);
  }
  const duplicates = [];
  for (const [remoteKey, localKeys] of byRemote) {
    if (localKeys.length > 1) duplicates.push({ remoteKey, localKeys: [...localKeys].sort() });
  }
  return duplicates.sort((a, b) => a.remoteKey.localeCompare(b.remoteKey));
}


export const PAIR_WITNESS_PREVIEW_SCAN_PAGES_MAX = 20;

const defaultDeps = {
  getStored: kvsStore.get,
  queryPage: kvsStore.queryPageByPrefix,
  readPause: getPilotPause,
  readIdentity: readForgeInstallationIdentity,
  getOrganizations: getOrganizationsWithTokens,
  resolveIssue: readIssueIdentity,
  readWitness: readPairWitness,
  now: () => Date.now()
};

function resolveOrgId(value) {
  try {
    return normalizeSnapshotOrgId(value);
  } catch (error) {
    if (error instanceof RecoverySnapshotError) {
      const code = error.code === 'SNAPSHOT_ORGANIZATION_REQUIRED'
        ? PAIR_WITNESS_PREVIEW_ERRORS.ORGANIZATION_REQUIRED
        : PAIR_WITNESS_PREVIEW_ERRORS.ORGANIZATION_INVALID;
      throw pairWitnessPreviewError(code);
    }
    throw pairWitnessPreviewError(PAIR_WITNESS_PREVIEW_ERRORS.ORGANIZATION_INVALID);
  }
}

function clampMaxPairs(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested)) return PAIR_WITNESS_PREVIEW_DEFAULT_MAX_PAIRS;
  return Math.max(1, Math.min(Math.floor(requested), PAIR_WITNESS_PREVIEW_MAX_PAIRS));
}

async function scanMappingPages(orgId, maxPairs, deps) {
  const prefix = mappingPrefix(orgId);
  const records = [];
  let cursor = null;
  let pages = 0;
  let exhausted = false;
  let droppedByLimit = false;

  while (records.length < maxPairs) {
    if (pages >= PAIR_WITNESS_PREVIEW_SCAN_PAGES_MAX) break;
    let page;
    try {
      page = await deps.queryPage(prefix, {
        limit: PAIR_WITNESS_PREVIEW_SCAN_PAGE_SIZE,
        cursor
      });
    } catch {
      throw pairWitnessPreviewError(PAIR_WITNESS_PREVIEW_ERRORS.STORAGE_UNAVAILABLE);
    }
    pages += 1;
    for (const record of page.records || []) {
      if (records.length >= maxPairs) {
        droppedByLimit = true;
        break;
      }
      records.push(record);
    }
    cursor = page.nextCursor || null;
    if (!cursor) {
      exhausted = true;
      break;
    }
  }

  // A scan that stopped at the requested pair limit is never reported as
  // complete, even when the last page happened to contain the remaining keys.
  return { records, exhausted: exhausted && !droppedByLimit, pages };
}

function readMetaPair(record, orgId) {
  const prefix = mappingPrefix(orgId);
  const key = typeof record?.key === 'string' ? record.key : '';
  const value = isPlainObject(record?.value) ? record.value : null;
  const localKey = key.startsWith(prefix) ? key.slice(prefix.length) : '';
  const remoteKey = value && typeof value.remoteKey === 'string' ? value.remoteKey : '';
  if (!isValidIssueKey(localKey) || !isValidIssueKey(remoteKey)) return null;
  if (value && typeof value.localKey === 'string' && value.localKey !== localKey) return null;
  return { localKey, remoteKey, storedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : null };
}


async function readIssueSafe(deps, request) {
  try {
    return await deps.resolveIssue(request);
  } catch {
    return {
      side: request.side,
      class: PAIR_WITNESS_ISSUE_CLASSES.UNVERIFIABLE,
      code: 'PAIR_WITNESS_NETWORK_ERROR',
      statusCode: null,
      id: null,
      key: null
    };
  }
}

async function readWitnessSafe(deps, request) {
  try {
    return await deps.readWitness(request);
  } catch {
    return {
      side: request.side,
      class: PAIR_WITNESS_READ_CLASSES.UNVERIFIABLE,
      code: 'PAIR_WITNESS_NETWORK_ERROR',
      statusCode: null,
      pairId: null,
      state: null,
      record: null
    };
  }
}

function witnessSummary(read) {
  if (!read || !read.class) {
    return { class: null, code: null, statusCode: null, pairId: null, state: null };
  }
  return {
    class: read.class,
    code: read.code || null,
    statusCode: read.statusCode ?? null,
    pairId: read.pairId || null,
    state: read.state || null
  };
}

async function inspectPair(context) {
  const {
    orgId, localKey, remoteKey, identity, localSite, remoteSite, org, deps, reads
  } = context;

  const [mapping, ledger, ended, repaired] = await Promise.all([
    readDirections(orgId, localKey, remoteKey, deps),
    readLedger(orgId, localKey, remoteKey, deps),
    readFlagged(endedKey(orgId, localKey, remoteKey), deps),
    readFlagged(repairKey(orgId, localKey, remoteKey), deps)
  ]);
  reads.storage += 6;

  // Storage already refuses this pair. Reading Jira would spend quota to confirm
  // a decision that is made without it, so no issue or property is read.
  const storageRefused = mapping.unreadable || !mapping.consistent
    || ledger.unreadable || ledger.inDoubt
    || ended.unreadable || ended.present
    || repaired.unreadable || repaired.present;

  if (storageRefused) {
    const skipped = () => ({
      issue: { class: null, statusCode: null, id: null, key: null },
      witness: witnessSummary(null)
    });
    const detail = {
      localKey,
      remoteKey,
      mapping: {
        forward: mapping.forward,
        reverse: mapping.reverse,
        forwardOk: mapping.forwardOk,
        reverseOk: mapping.reverseOk,
        consistent: mapping.consistent,
        unreadable: mapping.unreadable
      },
      ledger: { state: ledger.state, inDoubt: ledger.inDoubt, unreadable: ledger.unreadable },
      ended: { present: ended.present, unreadable: ended.unreadable },
      repaired: { present: repaired.present, unreadable: repaired.unreadable },
      local: skipped(),
      remote: skipped(),
      jiraReadSkipped: true
    };
    detail.pairClass = classifyPair(detail);
    return detail;
  }

  const [localIssue, remoteIssue] = await Promise.all([
    readIssueSafe(deps, { side: PAIR_WITNESS_SIDES.LOCAL, issueRef: localKey }),
    readIssueSafe(deps, { side: PAIR_WITNESS_SIDES.REMOTE, issueRef: remoteKey, org })
  ]);
  reads.issueReads += 2;
  reads.localReads += 1;
  reads.remoteReads += 1;

  const localRef = localIssue.class === PAIR_WITNESS_ISSUE_CLASSES.PRESENT
    ? (localIssue.id || localKey)
    : null;
  const remoteRef = remoteIssue.class === PAIR_WITNESS_ISSUE_CLASSES.PRESENT
    ? (remoteIssue.id || remoteKey)
    : null;

  const [localWitness, remoteWitness] = await Promise.all([
    localRef
      ? readWitnessSafe(deps, {
        side: PAIR_WITNESS_SIDES.LOCAL,
        issueRef: localRef,
        expected: {
          installationId: identity.installationId,
          appId: identity.appId,
          orgId,
          localSite,
          remoteSite,
          issueId: localIssue.id || undefined
        }
      })
      : { class: null },
    remoteRef
      ? readWitnessSafe(deps, {
        side: PAIR_WITNESS_SIDES.REMOTE,
        issueRef: remoteRef,
        org,
        expected: {
          installationId: identity.installationId,
          appId: identity.appId,
          orgId,
          localSite,
          remoteSite,
          issueId: remoteIssue.id || undefined
        }
      })
      : { class: null }
  ]);
  if (localRef) {
    reads.propertyReads += 1;
    reads.localReads += 1;
  }
  if (remoteRef) {
    reads.propertyReads += 1;
    reads.remoteReads += 1;
  }

  const detail = {
    localKey,
    remoteKey,
    mapping: {
      forward: mapping.forward,
      reverse: mapping.reverse,
      forwardOk: mapping.forwardOk,
      reverseOk: mapping.reverseOk,
      consistent: mapping.consistent,
      unreadable: mapping.unreadable
    },
    ledger: { state: ledger.state, inDoubt: ledger.inDoubt, unreadable: ledger.unreadable },
    ended: { present: ended.present, unreadable: ended.unreadable },
    repaired: { present: repaired.present, unreadable: repaired.unreadable },
    local: {
      issue: {
        class: localIssue.class,
        statusCode: localIssue.statusCode ?? null,
        id: localIssue.id || null,
        key: localIssue.key || localKey
      },
      witness: witnessSummary(localWitness)
    },
    remote: {
      issue: {
        class: remoteIssue.class,
        statusCode: remoteIssue.statusCode ?? null,
        id: remoteIssue.id || null,
        key: remoteIssue.key || remoteKey
      },
      witness: witnessSummary(remoteWitness)
    }
  };
  detail.pairClass = classifyPair(detail);
  // A key that no longer matches storage means the issue moved project. The
  // stable id still proves the pair, so this is reported, not refused.
  detail.keyDrift = {
    local: Boolean(localIssue.key) && localIssue.key !== localKey,
    remote: Boolean(remoteIssue.key) && remoteIssue.key !== remoteKey
  };
  return detail;
}


const CLASS_COUNTERS = Object.freeze({
  [PAIR_WITNESS_PAIR_CLASSES.READY]: 'readyToWitness',
  [PAIR_WITNESS_PAIR_CLASSES.PARTIAL]: 'partiallyWitnessed',
  [PAIR_WITNESS_PAIR_CLASSES.WITNESSED]: 'alreadyWitnessed',
  [PAIR_WITNESS_PAIR_CLASSES.WITNESS_CONFLICT]: 'witnessConflict',
  [PAIR_WITNESS_PAIR_CLASSES.WITNESS_ENDED]: 'witnessEnded',
  [PAIR_WITNESS_PAIR_CLASSES.WITNESS_PENDING_CREATE]: 'witnessPendingCreate',
  [PAIR_WITNESS_PAIR_CLASSES.WITNESS_INACCESSIBLE]: 'witnessInaccessible',
  [PAIR_WITNESS_PAIR_CLASSES.WITNESS_UNVERIFIABLE]: 'witnessUnverifiable',
  [PAIR_WITNESS_PAIR_CLASSES.COUNTERPART_MISSING]: 'counterpartMissing',
  [PAIR_WITNESS_PAIR_CLASSES.COUNTERPART_INACCESSIBLE]: 'counterpartInaccessible',
  [PAIR_WITNESS_PAIR_CLASSES.UNVERIFIED]: 'unverified',
  [PAIR_WITNESS_PAIR_CLASSES.MAPPING_MISMATCH]: 'mappingMismatch',
  [PAIR_WITNESS_PAIR_CLASSES.DUPLICATE_DESTINATION]: 'duplicateDestination',
  [PAIR_WITNESS_PAIR_CLASSES.CREATE_IN_DOUBT]: 'createInDoubt',
  [PAIR_WITNESS_PAIR_CLASSES.PAIR_ENDED]: 'pairEnded',
  [PAIR_WITNESS_PAIR_CLASSES.REPAIR_REQUIRED]: 'repairRequired'
});

function emptyCounts() {
  return {
    pairsScanned: 0,
    readyToWitness: 0,
    partiallyWitnessed: 0,
    alreadyWitnessed: 0,
    witnessConflict: 0,
    witnessEnded: 0,
    witnessPendingCreate: 0,
    witnessInaccessible: 0,
    witnessUnverifiable: 0,
    counterpartMissing: 0,
    counterpartInaccessible: 0,
    unverified: 0,
    mappingMismatch: 0,
    duplicateDestination: 0,
    createInDoubt: 0,
    pairEnded: 0,
    repairRequired: 0,
    invalidRecords: 0,
    keyDrift: 0
  };
}

function emptyWitnessCounts() {
  return {
    matching: 0,
    absent: 0,
    ended: 0,
    pendingCreate: 0,
    conflict: 0,
    inaccessible: 0,
    unverifiable: 0,
    notRead: 0,
    malformed: 0,
    foreign: 0,
    schemaNewer: 0
  };
}

function tallyWitness(counts, witness) {
  const readClass = witness?.class;
  if (!readClass) {
    counts.notRead += 1;
    return;
  }
  if (readClass === PAIR_WITNESS_READ_CLASSES.MATCHING) counts.matching += 1;
  else if (readClass === PAIR_WITNESS_READ_CLASSES.ABSENT) counts.absent += 1;
  else if (readClass === PAIR_WITNESS_READ_CLASSES.ENDED) counts.ended += 1;
  else if (readClass === PAIR_WITNESS_READ_CLASSES.PENDING_CREATE) counts.pendingCreate += 1;
  else if (readClass === PAIR_WITNESS_READ_CLASSES.INACCESSIBLE) counts.inaccessible += 1;
  else if (readClass === PAIR_WITNESS_READ_CLASSES.UNVERIFIABLE) counts.unverifiable += 1;
  else if (readClass === PAIR_WITNESS_READ_CLASSES.MALFORMED) counts.malformed += 1;
  else if (readClass === PAIR_WITNESS_READ_CLASSES.SCHEMA_NEWER) counts.schemaNewer += 1;
  else if (readClass === PAIR_WITNESS_READ_CLASSES.DIFFERENT_PAIR
    || readClass === PAIR_WITNESS_READ_CLASSES.ISSUE_MISMATCH
    || readClass === PAIR_WITNESS_READ_CLASSES.SITE_MISMATCH) counts.conflict += 1;
  else if (readClass === PAIR_WITNESS_READ_CLASSES.FOREIGN_INSTALLATION
    || readClass === PAIR_WITNESS_READ_CLASSES.FOREIGN_ORGANIZATION) counts.foreign += 1;
  else counts.unverifiable += 1;
}

function findingDetail(pair) {
  const side = (name) => {
    const entry = pair[name];
    const witness = entry?.witness;
    if (witness?.class) return `${name}:${witness.class}`;
    const issue = entry?.issue;
    if (issue?.class && issue.class !== PAIR_WITNESS_ISSUE_CLASSES.PRESENT) {
      return `${name}:${issue.class}${issue.statusCode ? `-${issue.statusCode}` : ''}`;
    }
    return null;
  };
  return [side('local'), side('remote')].filter(Boolean).join(' ') || null;
}


async function readPauseOrFail(deps) {
  let pause;
  try {
    pause = await deps.readPause();
  } catch {
    throw pairWitnessPreviewError(PAIR_WITNESS_PREVIEW_ERRORS.PAUSE_UNREADABLE);
  }
  if (!pause || pause.paused !== true) {
    throw pairWitnessPreviewError(PAIR_WITNESS_PREVIEW_ERRORS.REQUIRES_PAUSE);
  }
  return {
    paused: true,
    reasonCode: typeof pause.reasonCode === 'string' ? pause.reasonCode : null,
    pausedAt: typeof pause.pausedAt === 'string' ? pause.pausedAt : null
  };
}

async function readIdentityOrFail(deps) {
  let identity;
  try {
    identity = await deps.readIdentity();
  } catch {
    identity = null;
  }
  if (!identity || identity.readable !== true) {
    throw pairWitnessPreviewError(PAIR_WITNESS_PREVIEW_ERRORS.IDENTITY_UNAVAILABLE);
  }
  const cloudIds = Array.isArray(identity.cloudIds)
    ? identity.cloudIds.filter((id) => typeof id === 'string')
    : [];
  const localSite = cloudIds[0] || (typeof identity.siteHost === 'string' ? identity.siteHost : null);
  if (!localSite) {
    throw pairWitnessPreviewError(PAIR_WITNESS_PREVIEW_ERRORS.IDENTITY_UNAVAILABLE);
  }
  return {
    appId: identity.appId,
    environmentId: identity.environmentId,
    installationId: identity.installationId,
    cloudIds,
    siteHost: typeof identity.siteHost === 'string' ? identity.siteHost : null,
    localSite
  };
}

async function readOrganizationOrFail(orgId, deps) {
  let organizations;
  try {
    organizations = await deps.getOrganizations();
  } catch {
    throw pairWitnessPreviewError(PAIR_WITNESS_PREVIEW_ERRORS.STORAGE_UNAVAILABLE);
  }
  const list = Array.isArray(organizations) ? organizations : [];
  const organization = list.find((entry) => entry && entry.id === orgId);
  if (!organization) {
    throw pairWitnessPreviewError(PAIR_WITNESS_PREVIEW_ERRORS.ORGANIZATION_NOT_FOUND);
  }
  const remoteHost = hostFromUrl(organization.remoteUrl);
  const hasToken = typeof organization.remoteApiToken === 'string' && organization.remoteApiToken !== '';
  if (!remoteHost || !hasToken) {
    throw pairWitnessPreviewError(PAIR_WITNESS_PREVIEW_ERRORS.ORGANIZATION_UNUSABLE, {
      missing: [remoteHost ? null : 'remoteUrl', hasToken ? null : 'remoteApiToken'].filter(Boolean)
    });
  }
  return {
    id: orgId,
    name: typeof organization.name === 'string' ? organization.name : null,
    remoteSite: remoteHost,
    remoteUrl: organization.remoteUrl,
    remoteEmail: organization.remoteEmail,
    remoteApiToken: organization.remoteApiToken,
    syncDirection: organization.syncDirection === 'bidirectional' ? 'bidirectional' : 'push'
  };
}


/**
 * Read-only migration preview for one organization.
 *
 * @param {{orgId: string, maxPairs?: number, deps?: object}} options
 * @returns {Promise<object>} the preview; rejects with a coded error when the
 *   organization, installation identity, pause or storage is unusable
 */
export async function previewPairWitnessMigration(options = {}) {
  const deps = { ...defaultDeps, ...(options.deps || {}) };
  const orgId = resolveOrgId(options.orgId);
  const maxPairs = clampMaxPairs(options.maxPairs);

  const pause = await readPauseOrFail(deps);
  const identity = await readIdentityOrFail(deps);
  const organization = await readOrganizationOrFail(orgId, deps);
  const scan = await scanMappingPages(orgId, maxPairs, deps);

  const reads = {
    storage: scan.pages,
    issueReads: 0,
    propertyReads: 0,
    localReads: 0,
    remoteReads: 0
  };
  const counts = emptyCounts();
  const witnesses = emptyWitnessCounts();
  const findings = [];
  let omittedFindings = 0;
  const pairs = [];

  for (const record of scan.records) {
    const meta = readMetaPair(record, orgId);
    if (!meta) {
      counts.invalidRecords += 1;
      if (findings.length < PAIR_WITNESS_PREVIEW_FINDING_LIMIT) {
        findings.push({
          code: PAIR_WITNESS_PAIR_CLASSES.MAPPING_MISMATCH,
          localKey: null,
          remoteKey: null,
          detail: 'invalid-mapping-record'
        });
      } else {
        omittedFindings += 1;
      }
      continue;
    }

    const pair = await inspectPair({
      orgId,
      localKey: meta.localKey,
      remoteKey: meta.remoteKey,
      identity,
      localSite: identity.localSite,
      remoteSite: organization.remoteSite,
      org: organization,
      deps,
      reads
    });
    pairs.push(pair);
  }

  // Two local issues claiming one remote issue are ambiguous for both. The
  // ambiguity outranks whatever the per-pair classifier would have said, because
  // one remote issue cannot legitimately carry two local counterparts.
  const duplicates = findDuplicateDestinations(pairs);
  const duplicateLocals = new Set(duplicates.flatMap((entry) => entry.localKeys));
  for (const pair of pairs) {
    if (!duplicateLocals.has(pair.localKey)) continue;
    if (pair.pairClass !== PAIR_WITNESS_PAIR_CLASSES.DUPLICATE_DESTINATION) {
      pair.basePairClass = pair.pairClass;
      pair.pairClass = PAIR_WITNESS_PAIR_CLASSES.DUPLICATE_DESTINATION;
    }
  }

  for (const pair of pairs) {
    counts.pairsScanned += 1;
    counts[CLASS_COUNTERS[pair.pairClass]] += 1;
    if (pair.keyDrift?.local || pair.keyDrift?.remote) counts.keyDrift += 1;
    tallyWitness(witnesses, pair.local.witness);
    tallyWitness(witnesses, pair.remote.witness);
    if (pair.pairClass === PAIR_WITNESS_PAIR_CLASSES.READY
      || pair.pairClass === PAIR_WITNESS_PAIR_CLASSES.WITNESSED) {
      continue;
    }
    if (findings.length < PAIR_WITNESS_PREVIEW_FINDING_LIMIT) {
      findings.push({
        code: pair.pairClass,
        localKey: pair.localKey,
        remoteKey: pair.remoteKey,
        detail: findingDetail(pair)
      });
    } else {
      omittedFindings += 1;
    }
  }

  const projectedWrites = counts.readyToWitness * 2 + counts.partiallyWitnessed;
  const cost = {
    storagePages: scan.pages,
    jiraIssueReads: reads.issueReads,
    jiraPropertyReads: reads.propertyReads,
    jiraReads: reads.issueReads + reads.propertyReads,
    // readForgeInstallationIdentity reads /rest/api/3/serverInfo once per run.
    identityLookupReads: 1,
    localReads: reads.localReads,
    remoteReads: reads.remoteReads,
    // App-originated requests are what the hourly points quota measures; the
    // remote site is called with an API token, whose traffic the points quota
    // does not cover. One point per local read is the published Issues cost.
    estimatedAppPoints: reads.localReads + 1,
    witnessWritesPerformed: 0,
    witnessWritesProjected: projectedWrites,
    jiraIssuesCreated: 0
  };

  return {
    success: true,
    readOnly: true,
    orgId,
    organization: {
      id: organization.id,
      name: organization.name,
      remoteSite: organization.remoteSite,
      syncDirection: organization.syncDirection
    },
    generatedAt: new Date(deps.now()).toISOString(),
    identity: {
      appId: identity.appId,
      environmentId: identity.environmentId,
      installationId: identity.installationId,
      cloudIds: identity.cloudIds,
      siteHost: identity.siteHost
    },
    pause,
    limits: {
      maxPairs,
      pairsListed: pairs.length,
      pagesScanned: scan.pages,
      truncated: !scan.exhausted,
      findingLimit: PAIR_WITNESS_PREVIEW_FINDING_LIMIT
    },
    counts,
    witnesses,
    duplicates,
    cost,
    pairs,
    findings,
    omittedFindings,
    limitations: PAIR_WITNESS_PREVIEW_LIMITATIONS
  };
}

