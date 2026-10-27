import { getRemoteKey, getLocalKey } from '../storage/mappings.js';
import {
  getIssueCreateOperation,
  ISSUE_CREATE_DIRECTIONS,
  ISSUE_CREATE_STATES
} from './issue-create-operation.js';
import {
  PAIR_WITNESS_READ_CLASSES,
  PAIR_WITNESS_SIDES,
  deterministicPairId,
  readIssueIdentity,
  readPairWitness,
  sameWitnessPairIdentity
} from './pair-witness.js';
import { readForgeInstallationIdentity, readWitnessIdentity } from '../readiness/connector-readiness.js';
import { SYNC_DECISIONS } from './sync-observability.js';

/**
 * Pre-create pairing-witness guard.
 *
 * Before a synchronized counterpart may be created, this module answers one
 * question: does Jira hold evidence that the pair already exists? It reads the
 * source issue's own `sync-connector-pair` property. When a matching witness
 * names a counterpart, the counterpart and its witness are read by stable issue
 * id. Only two outcomes are possible:
 *
 *   - `allow`: no evidence exists and the existing mapping/ledger checks did not
 *     find a conflict, or an explicitly authorized replacement is in progress;
 *   - `block`: evidence exists, or cannot be read well enough to prove absence.
 *
 * Boundaries:
 *   - No Jira write, no property write, no mapping/ledger write, no create.
 *   - No Jira search. The only counterpart addressed is the one named by the
 *     witness, by stable numeric id.
 *   - Every Jira read is a GET through `guarded-api`.
 *   - An absent witness is never treated as proof that a counterpart never
 *     existed. It only preserves the existing mapping/ledger trust model.
 *   - Legacy (`null`) organization scope cannot carry a witness at all (the
 *     schema requires `org-<n>`), so it is reported and skipped rather than
 *     silently blocking every legacy create.
 */

export const PAIR_WITNESS_GUARD_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  BLOCK: 'block'
});

export const PAIR_WITNESS_GUARD_CODES = Object.freeze({
  NOT_APPLICABLE_LEGACY: 'PAIR_WITNESS_NOT_APPLICABLE_LEGACY',
  NO_WITNESS_EVIDENCE: 'PAIR_WITNESS_NO_EVIDENCE',
  MAPPING_PRESENT: 'PAIR_WITNESS_MAPPING_PRESENT',
  LEDGER_IN_DOUBT: 'PAIR_WITNESS_LEDGER_IN_DOUBT',
  STORAGE_UNREADABLE: 'PAIR_WITNESS_STORAGE_UNREADABLE',
  IDENTITY_UNAVAILABLE: 'PAIR_WITNESS_IDENTITY_UNAVAILABLE',
  ORGANIZATION_UNUSABLE: 'PAIR_WITNESS_ORGANIZATION_UNUSABLE',
  INVALID_INPUT: 'PAIR_WITNESS_GUARD_INVALID_INPUT',
  SOURCE_UNVERIFIABLE: 'PAIR_WITNESS_SOURCE_UNVERIFIABLE',
  SOURCE_INACCESSIBLE: 'PAIR_WITNESS_SOURCE_INACCESSIBLE',
  WITNESS_INACCESSIBLE: 'PAIR_WITNESS_INACCESSIBLE',
  WITNESS_UNVERIFIABLE: 'PAIR_WITNESS_UNVERIFIABLE',
  WITNESS_MALFORMED: 'PAIR_WITNESS_MALFORMED',
  WITNESS_SCHEMA_NEWER: 'PAIR_WITNESS_SCHEMA_NEWER',
  WITNESS_CONFLICT: 'PAIR_WITNESS_CONFLICT',
  WITNESS_PAIR_ENDED: 'PAIR_WITNESS_PAIR_ENDED',
  WITNESS_CREATE_PENDING: 'PAIR_WITNESS_CREATE_PENDING',
  WITNESS_PAIR_ID_MISMATCH: 'PAIR_WITNESS_PAIR_ID_MISMATCH',
  PAIR_PROVEN: 'PAIR_WITNESS_PAIR_PROVEN',
  COUNTERPART_MISSING: 'PAIR_WITNESS_COUNTERPART_MISSING',
  COUNTERPART_INACCESSIBLE: 'PAIR_WITNESS_COUNTERPART_INACCESSIBLE',
  COUNTERPART_UNVERIFIABLE: 'PAIR_WITNESS_COUNTERPART_UNVERIFIABLE',
  COUNTERPART_WITNESS_ABSENT: 'PAIR_WITNESS_COUNTERPART_WITNESS_ABSENT',
  COUNTERPART_WITNESS_CONFLICT: 'PAIR_WITNESS_COUNTERPART_WITNESS_CONFLICT',
  REPLACEMENT_ALLOWED: 'PAIR_WITNESS_REPLACEMENT_AUTHORIZED'
});
export const PAIR_WITNESS_GUARD_MESSAGES = Object.freeze({
  [PAIR_WITNESS_GUARD_CODES.NOT_APPLICABLE_LEGACY]:
    'This legacy organization cannot carry pairing witnesses, so no witness check was possible.',
  [PAIR_WITNESS_GUARD_CODES.NO_WITNESS_EVIDENCE]:
    'No pairing witness is stored on the source issue.',
  [PAIR_WITNESS_GUARD_CODES.MAPPING_PRESENT]:
    'A mapping already exists for this source issue, so a new counterpart must not be created.',
  [PAIR_WITNESS_GUARD_CODES.LEDGER_IN_DOUBT]:
    'The issue-create ledger already records a started, succeeded or unknown create for this source issue.',
  [PAIR_WITNESS_GUARD_CODES.STORAGE_UNREADABLE]:
    'Connector storage could not be read, so the absence of a mapping or create record is unproven.',
  [PAIR_WITNESS_GUARD_CODES.IDENTITY_UNAVAILABLE]:
    'The Forge installation identity could not be read, so a witness could not be attributed.',
  [PAIR_WITNESS_GUARD_CODES.ORGANIZATION_UNUSABLE]:
    'The organization has no usable remote site or credentials, so its issues cannot be verified.',
  [PAIR_WITNESS_GUARD_CODES.INVALID_INPUT]: 'The witness guard was called with invalid input.',
  [PAIR_WITNESS_GUARD_CODES.SOURCE_UNVERIFIABLE]:
    'The source issue could not be verified, so no witness check was possible.',
  [PAIR_WITNESS_GUARD_CODES.SOURCE_INACCESSIBLE]:
    'The source issue is not accessible to the connector. This is not evidence that no counterpart exists.',
  [PAIR_WITNESS_GUARD_CODES.WITNESS_INACCESSIBLE]:
    'The pairing witness is not accessible to the connector. This is not evidence that no counterpart exists.',
  [PAIR_WITNESS_GUARD_CODES.WITNESS_UNVERIFIABLE]:
    'The pairing witness could not be read (rate limit, server error or transport failure).',
  [PAIR_WITNESS_GUARD_CODES.WITNESS_MALFORMED]:
    'A pairing witness exists but is not a record this connector can trust.',
  [PAIR_WITNESS_GUARD_CODES.WITNESS_SCHEMA_NEWER]:
    'A pairing witness exists with a schema version this connector does not understand.',
  [PAIR_WITNESS_GUARD_CODES.WITNESS_CONFLICT]:
    'A pairing witness contradicts this installation, organization, site or issue.',
  [PAIR_WITNESS_GUARD_CODES.WITNESS_PAIR_ENDED]:
    'A pairing witness records an ended pair. A new counterpart requires an explicit recovery decision.',
  [PAIR_WITNESS_GUARD_CODES.WITNESS_CREATE_PENDING]:
    'A pairing witness records an unfinished create. No new counterpart may be created.',
  [PAIR_WITNESS_GUARD_CODES.WITNESS_PAIR_ID_MISMATCH]:
    'The pairing witness pair id does not match its own installation, organization and issue ids.',
  [PAIR_WITNESS_GUARD_CODES.PAIR_PROVEN]:
    'Both Jira issues carry a matching pairing witness, so the counterpart already exists.',
  [PAIR_WITNESS_GUARD_CODES.COUNTERPART_MISSING]:
    'The counterpart named by the witness is missing. It may only be replaced through the existing confirmed-deletion workflow.',
  [PAIR_WITNESS_GUARD_CODES.COUNTERPART_INACCESSIBLE]:
    'The counterpart named by the witness is not accessible to the connector.',
  [PAIR_WITNESS_GUARD_CODES.COUNTERPART_UNVERIFIABLE]:
    'The counterpart named by the witness could not be verified.',
  [PAIR_WITNESS_GUARD_CODES.COUNTERPART_WITNESS_ABSENT]:
    'Only one issue of the witnessed pair carries a witness, so the pair is not proven and no create is allowed.',
  [PAIR_WITNESS_GUARD_CODES.COUNTERPART_WITNESS_CONFLICT]:
    'The two pairing witnesses disagree about the pair.',
  [PAIR_WITNESS_GUARD_CODES.REPLACEMENT_ALLOWED]:
    'An explicitly authorized replacement of a confirmed-deleted counterpart may proceed.'
});

const ORG_ID_PATTERN = /^org-\d+$/;
const ISSUE_ID_PATTERN = /^\d{1,32}$/;

/**
 * Context-only identity is enough for a normal Forge invocation. Only when the
 * context carries no cloud id does this fall back to the one-time serverInfo
 * read, which keeps the guard compatible with the migration's `localSite`
 * derivation without spending that request on every create.
 */
async function readCreateGuardIdentity() {
  const fast = readWitnessIdentity();
  if (fast.readable === true) {
    return fast;
  }
  try {
    const slow = await readForgeInstallationIdentity();
    if (!slow || slow.readable !== true) {
      return fast;
    }
    const localSite = Array.isArray(slow.cloudIds) && slow.cloudIds.length > 0
      ? slow.cloudIds[0]
      : slow.siteHost;
    return {
      readable: !!(slow.appId && slow.installationId && localSite),
      code: null,
      appId: slow.appId,
      environmentId: slow.environmentId,
      installationId: slow.installationId,
      cloudIds: Array.isArray(slow.cloudIds) ? slow.cloudIds : [],
      localSite: localSite || null
    };
  } catch {
    return fast;
  }
}

const defaultDeps = {
  getRemoteKey,
  getLocalKey,
  getIssueCreateOperation,
  readIdentity: readCreateGuardIdentity,
  readIssue: readIssueIdentity,
  readWitness: readPairWitness
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function isIssueId(value) {
  return typeof value === 'string' && ISSUE_ID_PATTERN.test(value);
}

function isKnownDirection(value) {
  return value === ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE
    || value === ISSUE_CREATE_DIRECTIONS.REMOTE_TO_LOCAL;
}

function allow(code, details = {}) {
  return {
    decision: PAIR_WITNESS_GUARD_DECISIONS.ALLOW,
    code,
    message: PAIR_WITNESS_GUARD_MESSAGES[code] || null,
    readClass: null,
    statusCode: null,
    pairId: null,
    counterpartKey: null,
    counterpartIssueId: null,
    sourceIssueId: null,
    ...details
  };
}

function block(code, details = {}) {
  return {
    decision: PAIR_WITNESS_GUARD_DECISIONS.BLOCK,
    code,
    message: PAIR_WITNESS_GUARD_MESSAGES[code] || null,
    readClass: null,
    statusCode: null,
    pairId: null,
    counterpartKey: null,
    counterpartIssueId: null,
    sourceIssueId: null,
    ...details
  };
}

/**
 * Maps a guard refusal onto an existing sanitized synchronization decision. A
 * proven pair is a duplicate, contradictory evidence is a conflict, and
 * unreadable evidence is a locked skip. No new decision enum is introduced.
 */
export function syncDecisionForGuardCode(code) {
  if (code === PAIR_WITNESS_GUARD_CODES.PAIR_PROVEN) return SYNC_DECISIONS.DUPLICATE;
  if (code === PAIR_WITNESS_GUARD_CODES.WITNESS_INACCESSIBLE
    || code === PAIR_WITNESS_GUARD_CODES.SOURCE_INACCESSIBLE
    || code === PAIR_WITNESS_GUARD_CODES.WITNESS_UNVERIFIABLE
    || code === PAIR_WITNESS_GUARD_CODES.SOURCE_UNVERIFIABLE
    || code === PAIR_WITNESS_GUARD_CODES.COUNTERPART_INACCESSIBLE
    || code === PAIR_WITNESS_GUARD_CODES.COUNTERPART_UNVERIFIABLE) {
    return SYNC_DECISIONS.SKIPPED_LOCKED;
  }
  if (code === PAIR_WITNESS_GUARD_CODES.LEDGER_IN_DOUBT) return SYNC_DECISIONS.AMBIGUOUS_WRITE;
  return SYNC_DECISIONS.CONFLICT;
}

function witnessReadBlockCode(readClass) {
  switch (readClass) {
    case PAIR_WITNESS_READ_CLASSES.INACCESSIBLE:
      return PAIR_WITNESS_GUARD_CODES.WITNESS_INACCESSIBLE;
    case PAIR_WITNESS_READ_CLASSES.UNVERIFIABLE:
      return PAIR_WITNESS_GUARD_CODES.WITNESS_UNVERIFIABLE;
    case PAIR_WITNESS_READ_CLASSES.SCHEMA_NEWER:
      return PAIR_WITNESS_GUARD_CODES.WITNESS_SCHEMA_NEWER;
    case PAIR_WITNESS_READ_CLASSES.MALFORMED:
      return PAIR_WITNESS_GUARD_CODES.WITNESS_MALFORMED;
    case PAIR_WITNESS_READ_CLASSES.ENDED:
      return PAIR_WITNESS_GUARD_CODES.WITNESS_PAIR_ENDED;
    case PAIR_WITNESS_READ_CLASSES.PENDING_CREATE:
      return PAIR_WITNESS_GUARD_CODES.WITNESS_CREATE_PENDING;
    case PAIR_WITNESS_READ_CLASSES.ABSENT:
    case PAIR_WITNESS_READ_CLASSES.MATCHING:
      return null;
    default:
      return PAIR_WITNESS_GUARD_CODES.WITNESS_CONFLICT;
  }
}

function replacementMatchesRecord(record, replacementKey, direction) {
  if (typeof replacementKey !== 'string' || replacementKey === '') return false;
  return direction === ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE
    ? record.remoteKey === replacementKey
    : record.localKey === replacementKey;
}

function counterpartSideFor(direction) {
  return direction === ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE
    ? PAIR_WITNESS_SIDES.REMOTE
    : PAIR_WITNESS_SIDES.LOCAL;
}

function sourceSideFor(direction) {
  return direction === ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE
    ? PAIR_WITNESS_SIDES.LOCAL
    : PAIR_WITNESS_SIDES.REMOTE;
}

/**
 * Evaluate one create attempt. Pure classification is applied to evidence read
 * through injectable dependencies, so every branch is testable without Forge.
 */
export async function evaluatePairWitnessCreateGuard({
  orgId = null,
  org = null,
  direction,
  sourceKey,
  sourceIssueId = null,
  operationSuffix = null,
  replacementKey = null,
  identity = null,
  deps = {}
} = {}) {
  const merged = { ...defaultDeps, ...deps };

  if (!isKnownDirection(direction) || typeof sourceKey !== 'string' || sourceKey === '') {
    return block(PAIR_WITNESS_GUARD_CODES.INVALID_INPUT);
  }

  // Legacy scope has no witness representation. Blocking every legacy create
  // would disable synchronization without protecting anything.
  if (orgId === null || orgId === undefined || orgId === '' || orgId === 'legacy') {
    return allow(PAIR_WITNESS_GUARD_CODES.NOT_APPLICABLE_LEGACY);
  }
  if (typeof orgId !== 'string' || !ORG_ID_PATTERN.test(orgId)) {
    return block(PAIR_WITNESS_GUARD_CODES.INVALID_INPUT);
  }
  if (!isPlainObject(org)) {
    return block(PAIR_WITNESS_GUARD_CODES.ORGANIZATION_UNUSABLE);
  }
  const remoteSite = hostFromUrl(org.remoteUrl);
  const hasRemoteCredentials = typeof org.remoteEmail === 'string' && org.remoteEmail !== ''
    && typeof org.remoteApiToken === 'string' && org.remoteApiToken !== '';
  if (!remoteSite || !hasRemoteCredentials) {
    return block(PAIR_WITNESS_GUARD_CODES.ORGANIZATION_UNUSABLE);
  }

  // 1. Existing mapping. A caller that already has a mapping should update, not
  // create. The only exception is the explicitly authorized replacement flow,
  // whose old mapping is still present until the new issue has been created.
  let mappedKey;
  try {
    mappedKey = direction === ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE
      ? await merged.getRemoteKey(sourceKey, orgId)
      : await merged.getLocalKey(sourceKey, orgId);
  } catch {
    return block(PAIR_WITNESS_GUARD_CODES.STORAGE_UNREADABLE);
  }
  if (mappedKey && mappedKey !== replacementKey) {
    return block(PAIR_WITNESS_GUARD_CODES.MAPPING_PRESENT);
  }

  // 2. Issue-create ledger, read with exactly the key the claim will use.
  let operation;
  try {
    operation = await merged.getIssueCreateOperation({
      orgId,
      direction,
      sourceKey,
      operationSuffix: operationSuffix || null
    });
  } catch {
    return block(PAIR_WITNESS_GUARD_CODES.STORAGE_UNREADABLE);
  }
  if (operation && (operation.state === ISSUE_CREATE_STATES.SUCCEEDED
      || operation.state === ISSUE_CREATE_STATES.UNKNOWN)) {
    return block(PAIR_WITNESS_GUARD_CODES.LEDGER_IN_DOUBT, {
      operationState: operation.state
    });
  }

  // 3. Installation identity, without an extra Jira request.
  let witnessIdentity = identity;
  if (!witnessIdentity) {
    try {
      witnessIdentity = await merged.readIdentity();
    } catch {
      witnessIdentity = null;
    }
  }
  if (!witnessIdentity || witnessIdentity.readable !== true
      || typeof witnessIdentity.appId !== 'string'
      || typeof witnessIdentity.installationId !== 'string'
      || typeof witnessIdentity.localSite !== 'string') {
    return block(PAIR_WITNESS_GUARD_CODES.IDENTITY_UNAVAILABLE);
  }

  const sourceSide = sourceSideFor(direction);
  const counterpartSide = counterpartSideFor(direction);


  // 4. Source issue stable id. The caller normally has it from the Jira event
  // or the full issue read; only fall back to a GET when it is genuinely absent.
  let resolvedSourceId = isIssueId(sourceIssueId) ? sourceIssueId : null;
  if (!resolvedSourceId) {
    let sourceRead;
    try {
      sourceRead = await merged.readIssue({ side: sourceSide, issueRef: sourceKey, org });
    } catch {
      return block(PAIR_WITNESS_GUARD_CODES.SOURCE_UNVERIFIABLE);
    }
    if (sourceRead.class !== 'present' || !isIssueId(sourceRead.id)) {
      return block(
        sourceRead.class === 'inaccessible'
          ? PAIR_WITNESS_GUARD_CODES.SOURCE_INACCESSIBLE
          : PAIR_WITNESS_GUARD_CODES.SOURCE_UNVERIFIABLE,
        { readClass: sourceRead.class || null }
      );
    }
    resolvedSourceId = sourceRead.id;
  }

  // 5. Read the source-side witness.
  let witnessRead;
  try {
    witnessRead = await merged.readWitness({
      side: sourceSide,
      issueRef: resolvedSourceId,
      org,
      expected: {
        installationId: witnessIdentity.installationId,
        appId: witnessIdentity.appId,
        orgId,
        localSite: witnessIdentity.localSite,
        remoteSite,
        issueId: resolvedSourceId
      }
    });
  } catch {
    return block(PAIR_WITNESS_GUARD_CODES.WITNESS_UNVERIFIABLE, {
      sourceIssueId: resolvedSourceId
    });
  }

  const base = {
    sourceIssueId: resolvedSourceId,
    readClass: witnessRead.class || null,
    statusCode: Number.isFinite(Number(witnessRead.statusCode))
      ? Number(witnessRead.statusCode)
      : null
  };

  if (witnessRead.class === PAIR_WITNESS_READ_CLASSES.ABSENT) {
    // Absence is not proof. Creation still depends on the mapping and ledger
    // being absent, which steps 1 and 2 established.
    return allow(
      replacementKey
        ? PAIR_WITNESS_GUARD_CODES.REPLACEMENT_ALLOWED
        : PAIR_WITNESS_GUARD_CODES.NO_WITNESS_EVIDENCE,
      base
    );
  }

  const witnessBlock = witnessReadBlockCode(witnessRead.class);
  if (witnessBlock) {
    // An ended witness may be superseded only by the explicitly authorized
    // replacement of exactly the counterpart it names.
    if (witnessRead.class === PAIR_WITNESS_READ_CLASSES.ENDED
        && witnessRead.record
        && replacementMatchesRecord(witnessRead.record, replacementKey, direction)) {
      return allow(PAIR_WITNESS_GUARD_CODES.REPLACEMENT_ALLOWED, {
        ...base,
        pairId: witnessRead.record.pairId || null,
        counterpartKey: direction === ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE
          ? witnessRead.record.remoteKey
          : witnessRead.record.localKey
      });
    }
    return block(witnessBlock, {
      ...base,
      pairId: witnessRead.record?.pairId || null
    });
  }


  const record = witnessRead.record;
  if (!isPlainObject(record)) {
    return block(PAIR_WITNESS_GUARD_CODES.WITNESS_MALFORMED, base);
  }

  // 6. The pair id must be derivable from the record's own identity tuple.
  let expectedPairId;
  try {
    expectedPairId = deterministicPairId({
      installationId: witnessIdentity.installationId,
      orgId,
      localIssueId: record.localIssueId,
      remoteIssueId: record.remoteIssueId
    });
  } catch {
    return block(PAIR_WITNESS_GUARD_CODES.WITNESS_MALFORMED, base);
  }
  if (record.pairId !== expectedPairId) {
    return block(PAIR_WITNESS_GUARD_CODES.WITNESS_PAIR_ID_MISMATCH, {
      ...base,
      pairId: record.pairId || null
    });
  }

  const counterpartIssueId = counterpartSide === PAIR_WITNESS_SIDES.REMOTE
    ? record.remoteIssueId
    : record.localIssueId;
  const counterpartKey = counterpartSide === PAIR_WITNESS_SIDES.REMOTE
    ? record.remoteKey
    : record.localKey;
  const pairDetails = {
    ...base,
    pairId: record.pairId,
    counterpartKey: counterpartKey || null,
    counterpartIssueId
  };

  // 7. Verify the counterpart named by the witness, by stable id only.
  let counterpartRead;
  try {
    counterpartRead = await merged.readIssue({
      side: counterpartSide,
      issueRef: counterpartIssueId,
      org
    });
  } catch {
    return block(PAIR_WITNESS_GUARD_CODES.COUNTERPART_UNVERIFIABLE, pairDetails);
  }

  if (counterpartRead.class === 'missing') {
    if (replacementMatchesRecord(record, replacementKey, direction)) {
      return allow(PAIR_WITNESS_GUARD_CODES.REPLACEMENT_ALLOWED, pairDetails);
    }
    return block(PAIR_WITNESS_GUARD_CODES.COUNTERPART_MISSING, pairDetails);
  }
  if (counterpartRead.class === 'inaccessible') {
    return block(PAIR_WITNESS_GUARD_CODES.COUNTERPART_INACCESSIBLE, pairDetails);
  }
  if (counterpartRead.class !== 'present' || !isIssueId(counterpartRead.id)) {
    return block(PAIR_WITNESS_GUARD_CODES.COUNTERPART_UNVERIFIABLE, pairDetails);
  }
  if (counterpartRead.id !== counterpartIssueId) {
    return block(PAIR_WITNESS_GUARD_CODES.COUNTERPART_WITNESS_CONFLICT, pairDetails);
  }

  // 8. Two-sided proof. Both issues must carry the same pair identity.
  let counterpartWitness;
  try {
    counterpartWitness = await merged.readWitness({
      side: counterpartSide,
      issueRef: counterpartIssueId,
      org,
      expected: {
        installationId: witnessIdentity.installationId,
        appId: witnessIdentity.appId,
        orgId,
        localSite: witnessIdentity.localSite,
        remoteSite,
        issueId: counterpartIssueId,
        pairId: record.pairId
      }
    });
  } catch {
    return block(PAIR_WITNESS_GUARD_CODES.COUNTERPART_WITNESS_CONFLICT, pairDetails);
  }

  if (counterpartWitness.class === PAIR_WITNESS_READ_CLASSES.MATCHING) {
    if (!sameWitnessPairIdentity(counterpartWitness.record, record)) {
      return block(PAIR_WITNESS_GUARD_CODES.COUNTERPART_WITNESS_CONFLICT, {
        ...pairDetails,
        counterpartKey: counterpartRead.key || counterpartKey || null
      });
    }
    return block(PAIR_WITNESS_GUARD_CODES.PAIR_PROVEN, {
      ...pairDetails,
      counterpartKey: counterpartRead.key || counterpartKey || null
    });
  }
  if (counterpartWitness.class === PAIR_WITNESS_READ_CLASSES.ABSENT) {
    return block(PAIR_WITNESS_GUARD_CODES.COUNTERPART_WITNESS_ABSENT, pairDetails);
  }
  return block(PAIR_WITNESS_GUARD_CODES.COUNTERPART_WITNESS_CONFLICT, {
    ...pairDetails,
    reason: counterpartWitness.code || 'counterpart-witness-unusable'
  });
}

