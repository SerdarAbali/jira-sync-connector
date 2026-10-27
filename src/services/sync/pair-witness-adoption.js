import { getRemoteKey, getLocalKey, storeMapping, isValidIssueKey, getOrganizationsWithTokens } from '../storage/mappings.js';
import { logAuditEntry } from '../storage/stats.js';
import { getPilotPause } from './pilot-pause.js';
import { readWitnessIdentity } from '../readiness/connector-readiness.js';
import {
  PAIR_WITNESS_ISSUE_CLASSES,
  PAIR_WITNESS_READ_CLASSES,
  deterministicPairId,
  readIssueIdentity,
  readPairWitness,
  sameWitnessPairIdentity
} from './pair-witness.js';

/**
 * Explicit adoption of a witnessed pair whose Forge mapping was lost.
 *
 * This is a recovery action, not a synchronization action. It never creates,
 * updates or deletes a Jira issue, never searches, and never writes a ledger
 * row. It verifies both Jira-side witnesses and then writes exactly one Forge
 * mapping. The emergency pause must be confirmed ON so a concurrent event
 * cannot create a second counterpart while the mapping is being restored.
 *
 * A witness is user-editable evidence, not authority. Adoption therefore
 * requires an administrator-supplied confirmation phrase that binds the exact
 * organization, keys and deterministic pair id.
 */

export const PAIR_WITNESS_ADOPTION_ERRORS = Object.freeze({
  ORGANIZATION_INVALID: 'PAIR_WITNESS_ORGANIZATION_INVALID',
  ORGANIZATION_NOT_FOUND: 'PAIR_WITNESS_ORGANIZATION_NOT_FOUND',
  ORGANIZATION_UNUSABLE: 'PAIR_WITNESS_ORGANIZATION_UNUSABLE',
  PAUSE_REQUIRED: 'PAIR_WITNESS_PAUSE_REQUIRED',
  PAUSE_UNREADABLE: 'PAIR_WITNESS_PAUSE_UNREADABLE',
  CONFIRMATION_REQUIRED: 'PAIR_WITNESS_CONFIRMATION_REQUIRED',
  CONFIRMATION_MISMATCH: 'PAIR_WITNESS_CONFIRMATION_MISMATCH',
  PAIR_ID_INVALID: 'PAIR_WITNESS_PAIR_ID_INVALID',
  PAIR_ID_MISMATCH: 'PAIR_WITNESS_PAIR_ID_MISMATCH',
  IDENTITY_UNAVAILABLE: 'PAIR_WITNESS_IDENTITY_UNAVAILABLE',
  ISSUE_INVALID: 'PAIR_WITNESS_ISSUE_INVALID',
  ISSUE_MISSING: 'PAIR_WITNESS_ISSUE_MISSING',
  ISSUE_INACCESSIBLE: 'PAIR_WITNESS_ISSUE_INACCESSIBLE',
  ISSUE_UNVERIFIABLE: 'PAIR_WITNESS_ISSUE_UNVERIFIABLE',
  ISSUE_KEY_MISMATCH: 'PAIR_WITNESS_ISSUE_KEY_MISMATCH',
  WITNESS_ABSENT: 'PAIR_WITNESS_WITNESS_ABSENT',
  WITNESS_INACCESSIBLE: 'PAIR_WITNESS_WITNESS_INACCESSIBLE',
  WITNESS_UNVERIFIABLE: 'PAIR_WITNESS_WITNESS_UNVERIFIABLE',
  WITNESS_CONFLICT: 'PAIR_WITNESS_WITNESS_CONFLICT',
  MAPPING_CONFLICT: 'PAIR_WITNESS_MAPPING_CONFLICT',
  MAPPING_WRITE_FAILED: 'PAIR_WITNESS_MAPPING_WRITE_FAILED',
  ADOPTION_FAILED: 'PAIR_WITNESS_ADOPTION_FAILED'
});

export const PAIR_WITNESS_ADOPTION_MESSAGES = Object.freeze({
  [PAIR_WITNESS_ADOPTION_ERRORS.ORGANIZATION_INVALID]:
    'A valid organization is required. Legacy scope cannot carry pairing witnesses.',
  [PAIR_WITNESS_ADOPTION_ERRORS.ORGANIZATION_NOT_FOUND]:
    'The selected organization is not configured.',
  [PAIR_WITNESS_ADOPTION_ERRORS.ORGANIZATION_UNUSABLE]:
    'The organization has no usable remote site or credentials.',
  [PAIR_WITNESS_ADOPTION_ERRORS.PAUSE_REQUIRED]:
    'Pause synchronization before adopting a witnessed pair. Adoption never changes the pause state.',
  [PAIR_WITNESS_ADOPTION_ERRORS.PAUSE_UNREADABLE]:
    'The emergency pause state could not be read, so adoption was refused.',
  [PAIR_WITNESS_ADOPTION_ERRORS.CONFIRMATION_REQUIRED]:
    'Type the exact adoption confirmation phrase.',
  [PAIR_WITNESS_ADOPTION_ERRORS.CONFIRMATION_MISMATCH]:
    'The confirmation phrase does not match this organization, pair and pair id.',
  [PAIR_WITNESS_ADOPTION_ERRORS.PAIR_ID_INVALID]:
    'A deterministic pair id from the witness preview is required.',
  [PAIR_WITNESS_ADOPTION_ERRORS.PAIR_ID_MISMATCH]:
    'The supplied pair id does not match both witnesses.',
  [PAIR_WITNESS_ADOPTION_ERRORS.IDENTITY_UNAVAILABLE]:
    'The Forge installation identity could not be read.',
  [PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_INVALID]: 'Both issue keys are required.',
  [PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_MISSING]:
    'One of the issues no longer exists, so the pair cannot be adopted.',
  [PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_INACCESSIBLE]:
    'One of the issues is not accessible to the connector.',
  [PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_UNVERIFIABLE]:
    'One of the issues could not be verified.',
  [PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_KEY_MISMATCH]:
    'A supplied issue key no longer identifies the issue; re-read the pair before adopting.',
  [PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_ABSENT]:
    'Both issues must carry a pairing witness. An absent witness is not proof of a pair.',
  [PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_INACCESSIBLE]:
    'A pairing witness is not accessible to the connector.',
  [PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_UNVERIFIABLE]:
    'A pairing witness could not be verified.',
  [PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_CONFLICT]:
    'The witnesses do not describe the same pair identity.',
  [PAIR_WITNESS_ADOPTION_ERRORS.MAPPING_CONFLICT]:
    'An existing mapping contradicts this pair. Resolve the conflict first.',
  [PAIR_WITNESS_ADOPTION_ERRORS.MAPPING_WRITE_FAILED]:
    'The verified pair could not be written as a mapping.',
  [PAIR_WITNESS_ADOPTION_ERRORS.ADOPTION_FAILED]:
    'The witnessed pair could not be adopted.'
});

const ORG_ID_PATTERN = /^org-\d+$/;
const PAIR_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const defaultDeps = {
  readPause: getPilotPause,
  getOrganizations: getOrganizationsWithTokens,
  readIdentity: readWitnessIdentity,
  readIssue: readIssueIdentity,
  readWitness: readPairWitness,
  getRemoteKey,
  getLocalKey,
  storeMapping,
  auditWrite: logAuditEntry
};

function failure(code) {
  return {
    success: false,
    code,
    message: PAIR_WITNESS_ADOPTION_MESSAGES[code]
      || PAIR_WITNESS_ADOPTION_MESSAGES[PAIR_WITNESS_ADOPTION_ERRORS.ADOPTION_FAILED]
  };
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

export function pairWitnessAdoptionPhrase({ orgId, localKey, remoteKey, pairId } = {}) {
  return `ADOPT ${orgId} ${localKey} ${remoteKey} ${pairId}`;
}

/**
 * Read-only verification of one candidate pair. It performs the same evidence
 * checks as adoption but writes nothing and does not require a pause; it only
 * reports the current pause state and any conflict.
 */
export async function previewWitnessedPairAdoption({
  orgId = null,
  localKey = null,
  remoteKey = null,
  deps = {}
} = {}) {
  const merged = { ...defaultDeps, ...deps };

  if (typeof orgId !== 'string' || !ORG_ID_PATTERN.test(orgId)) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ORGANIZATION_INVALID);
  }
  if (!isValidIssueKey(localKey) || !isValidIssueKey(remoteKey)) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_INVALID);
  }

  let organizations;
  try {
    organizations = await merged.getOrganizations();
  } catch {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ORGANIZATION_NOT_FOUND);
  }
  const org = Array.isArray(organizations)
    ? organizations.find((candidate) => candidate?.id === orgId)
    : null;
  if (!org) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ORGANIZATION_NOT_FOUND);
  }
  const remoteSite = hostFromUrl(org.remoteUrl);
  if (!remoteSite || typeof org.remoteApiToken !== 'string' || org.remoteApiToken === '') {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ORGANIZATION_UNUSABLE);
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
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.IDENTITY_UNAVAILABLE);
  }

  const localIssue = await merged.readIssue({ side: 'local', issueRef: localKey, org });
  if (localIssue.class === PAIR_WITNESS_ISSUE_CLASSES.MISSING) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_MISSING);
  }
  if (localIssue.class === PAIR_WITNESS_ISSUE_CLASSES.INACCESSIBLE) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_INACCESSIBLE);
  }
  if (localIssue.class !== PAIR_WITNESS_ISSUE_CLASSES.PRESENT || !localIssue.id) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_UNVERIFIABLE);
  }
  if (localIssue.key !== localKey) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_KEY_MISMATCH);
  }

  const remoteIssue = await merged.readIssue({ side: 'remote', issueRef: remoteKey, org });
  if (remoteIssue.class === PAIR_WITNESS_ISSUE_CLASSES.MISSING) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_MISSING);
  }
  if (remoteIssue.class === PAIR_WITNESS_ISSUE_CLASSES.INACCESSIBLE) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_INACCESSIBLE);
  }
  if (remoteIssue.class !== PAIR_WITNESS_ISSUE_CLASSES.PRESENT || !remoteIssue.id) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_UNVERIFIABLE);
  }
  if (remoteIssue.key !== remoteKey) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_KEY_MISMATCH);
  }



  const expected = {
    installationId: identity.installationId,
    appId: identity.appId,
    orgId,
    localSite: identity.localSite,
    remoteSite
  };
  const localWitness = await merged.readWitness({
    side: 'local',
    issueRef: localIssue.id,
    org,
    expected: { ...expected, issueId: localIssue.id }
  });
  if (localWitness.class === PAIR_WITNESS_READ_CLASSES.ABSENT) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_ABSENT);
  }
  if (localWitness.class === PAIR_WITNESS_READ_CLASSES.INACCESSIBLE) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_INACCESSIBLE);
  }
  if (localWitness.class !== PAIR_WITNESS_READ_CLASSES.MATCHING) {
    return failure(localWitness.class === PAIR_WITNESS_READ_CLASSES.UNVERIFIABLE
      ? PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_UNVERIFIABLE
      : PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_CONFLICT);
  }

  const remoteWitness = await merged.readWitness({
    side: 'remote',
    issueRef: remoteIssue.id,
    org,
    expected: { ...expected, issueId: remoteIssue.id }
  });
  if (remoteWitness.class === PAIR_WITNESS_READ_CLASSES.ABSENT) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_ABSENT);
  }
  if (remoteWitness.class === PAIR_WITNESS_READ_CLASSES.INACCESSIBLE) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_INACCESSIBLE);
  }
  if (remoteWitness.class !== PAIR_WITNESS_READ_CLASSES.MATCHING) {
    return failure(remoteWitness.class === PAIR_WITNESS_READ_CLASSES.UNVERIFIABLE
      ? PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_UNVERIFIABLE
      : PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_CONFLICT);
  }

  const localRecord = localWitness.record;
  const remoteRecord = remoteWitness.record;
  if (!sameWitnessPairIdentity(localRecord, remoteRecord)
      || localRecord.localIssueId !== localIssue.id
      || localRecord.remoteIssueId !== remoteIssue.id
      || localRecord.localKey !== localKey
      || localRecord.remoteKey !== remoteKey) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_CONFLICT);
  }

  let pairId;
  try {
    pairId = deterministicPairId({
      installationId: identity.installationId,
      orgId,
      localIssueId: localRecord.localIssueId,
      remoteIssueId: localRecord.remoteIssueId
    });
  } catch {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_CONFLICT);
  }
  if (localRecord.pairId !== pairId || remoteRecord.pairId !== pairId) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.PAIR_ID_MISMATCH);
  }

  let mappedRemote;
  let mappedLocal;
  try {
    [mappedRemote, mappedLocal] = await Promise.all([
      merged.getRemoteKey(localKey, orgId),
      merged.getLocalKey(remoteKey, orgId)
    ]);
  } catch {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ADOPTION_FAILED);
  }
  const mappingConflict = Boolean(
    (mappedRemote && mappedRemote !== remoteKey)
    || (mappedLocal && mappedLocal !== localKey)
  );
  const alreadyMapped = mappedRemote === remoteKey && mappedLocal === localKey;

  let pause = { readable: false, paused: false, reasonCode: null };
  try {
    const current = await merged.readPause();
    pause = {
      readable: true,
      paused: current?.paused === true,
      reasonCode: typeof current?.reasonCode === 'string' ? current.reasonCode : null
    };
  } catch {
    pause = { readable: false, paused: false, reasonCode: null };
  }

  return {
    success: true,
    readOnly: true,
    ready: mappingConflict !== true && alreadyMapped !== true && pause.paused === true,
    orgId,
    localKey,
    remoteKey,
    localIssueId: localIssue.id,
    remoteIssueId: remoteIssue.id,
    pairId,
    localWitness: {
      class: localWitness.class,
      state: localRecord.state,
      pairId: localRecord.pairId
    },
    remoteWitness: {
      class: remoteWitness.class,
      state: remoteRecord.state,
      pairId: remoteRecord.pairId
    },
    mapping: {
      remoteKey: mappedRemote || null,
      localKey: mappedLocal || null,
      state: mappingConflict ? 'conflict' : (alreadyMapped ? 'matching' : 'missing')
    },
    alreadyMapped,
    pause,
    conflicts: [
      ...(mappingConflict ? [PAIR_WITNESS_ADOPTION_ERRORS.MAPPING_CONFLICT] : []),
      ...(pause.readable !== true ? [PAIR_WITNESS_ADOPTION_ERRORS.PAUSE_UNREADABLE] : []),
      ...(pause.readable === true && pause.paused !== true
        ? [PAIR_WITNESS_ADOPTION_ERRORS.PAUSE_REQUIRED]
        : [])
    ],
    confirmationPhrase: pairWitnessAdoptionPhrase({ orgId, localKey, remoteKey, pairId })
  };
}


/**
 * Verify both witnesses and restore exactly one missing Forge mapping.
 * Performs no Jira write and never searches.
 */
export async function adoptWitnessedPair({
  orgId = null,
  localKey = null,
  remoteKey = null,
  pairId = null,
  confirmation = null,
  actorAccountId = null,
  deps = {}
} = {}) {
  const merged = { ...defaultDeps, ...deps };

  if (typeof orgId !== 'string' || !ORG_ID_PATTERN.test(orgId)) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ORGANIZATION_INVALID);
  }
  if (!isValidIssueKey(localKey) || !isValidIssueKey(remoteKey)) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_INVALID);
  }
  if (typeof pairId !== 'string' || !PAIR_ID_PATTERN.test(pairId)) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.PAIR_ID_INVALID);
  }

  let pause;
  try {
    pause = await merged.readPause();
  } catch {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.PAUSE_UNREADABLE);
  }
  if (pause?.paused !== true) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.PAUSE_REQUIRED);
  }

  const expectedPhrase = pairWitnessAdoptionPhrase({ orgId, localKey, remoteKey, pairId });
  if (typeof confirmation !== 'string' || confirmation.trim() === '') {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.CONFIRMATION_REQUIRED);
  }
  if (confirmation !== expectedPhrase) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.CONFIRMATION_MISMATCH);
  }

  let organizations;
  try {
    organizations = await merged.getOrganizations();
  } catch {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ORGANIZATION_NOT_FOUND);
  }
  const org = Array.isArray(organizations)
    ? organizations.find((candidate) => candidate?.id === orgId)
    : null;
  if (!org) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ORGANIZATION_NOT_FOUND);
  }
  const remoteSite = hostFromUrl(org.remoteUrl);
  if (!remoteSite || typeof org.remoteApiToken !== 'string' || org.remoteApiToken === '') {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ORGANIZATION_UNUSABLE);
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
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.IDENTITY_UNAVAILABLE);
  }

  // Resolve both supplied keys to their stable ids before reading evidence.
  const localIssue = await merged.readIssue({ side: 'local', issueRef: localKey, org });
  if (localIssue.class === PAIR_WITNESS_ISSUE_CLASSES.MISSING) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_MISSING);
  }
  if (localIssue.class === PAIR_WITNESS_ISSUE_CLASSES.INACCESSIBLE) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_INACCESSIBLE);
  }
  if (localIssue.class !== PAIR_WITNESS_ISSUE_CLASSES.PRESENT || !localIssue.id) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_UNVERIFIABLE);
  }
  if (localIssue.key !== localKey) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_KEY_MISMATCH);
  }

  const remoteIssue = await merged.readIssue({ side: 'remote', issueRef: remoteKey, org });
  if (remoteIssue.class === PAIR_WITNESS_ISSUE_CLASSES.MISSING) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_MISSING);
  }
  if (remoteIssue.class === PAIR_WITNESS_ISSUE_CLASSES.INACCESSIBLE) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_INACCESSIBLE);
  }
  if (remoteIssue.class !== PAIR_WITNESS_ISSUE_CLASSES.PRESENT || !remoteIssue.id) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_UNVERIFIABLE);
  }
  if (remoteIssue.key !== remoteKey) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_KEY_MISMATCH);
  }


  const expected = {
    installationId: identity.installationId,
    appId: identity.appId,
    orgId,
    localSite: identity.localSite,
    remoteSite,
    pairId
  };
  const localWitness = await merged.readWitness({
    side: 'local',
    issueRef: localIssue.id,
    org,
    expected: { ...expected, issueId: localIssue.id }
  });
  if (localWitness.class === PAIR_WITNESS_READ_CLASSES.ABSENT) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_ABSENT);
  }
  if (localWitness.class === PAIR_WITNESS_READ_CLASSES.INACCESSIBLE) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_INACCESSIBLE);
  }
  if (localWitness.class !== PAIR_WITNESS_READ_CLASSES.MATCHING) {
    return failure(localWitness.class === PAIR_WITNESS_READ_CLASSES.UNVERIFIABLE
      ? PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_UNVERIFIABLE
      : PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_CONFLICT);
  }

  const remoteWitness = await merged.readWitness({
    side: 'remote',
    issueRef: remoteIssue.id,
    org,
    expected: { ...expected, issueId: remoteIssue.id }
  });
  if (remoteWitness.class === PAIR_WITNESS_READ_CLASSES.ABSENT) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_ABSENT);
  }
  if (remoteWitness.class === PAIR_WITNESS_READ_CLASSES.INACCESSIBLE) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_INACCESSIBLE);
  }
  if (remoteWitness.class !== PAIR_WITNESS_READ_CLASSES.MATCHING) {
    return failure(remoteWitness.class === PAIR_WITNESS_READ_CLASSES.UNVERIFIABLE
      ? PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_UNVERIFIABLE
      : PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_CONFLICT);
  }

  const localRecord = localWitness.record;
  const remoteRecord = remoteWitness.record;
  if (!sameWitnessPairIdentity(localRecord, remoteRecord)) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_CONFLICT);
  }
  if (localRecord.localIssueId !== localIssue.id
      || localRecord.remoteIssueId !== remoteIssue.id
      || localRecord.localKey !== localKey
      || localRecord.remoteKey !== remoteKey) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_CONFLICT);
  }

  let derivedPairId;
  try {
    derivedPairId = deterministicPairId({
      installationId: identity.installationId,
      orgId,
      localIssueId: localRecord.localIssueId,
      remoteIssueId: localRecord.remoteIssueId
    });
  } catch {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_CONFLICT);
  }
  if (derivedPairId !== pairId || localRecord.pairId !== pairId) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.PAIR_ID_MISMATCH);
  }

  // A conflicting mapping is never overwritten. An identical mapping is a
  // successful no-op, which makes a repeated adoption safe.
  let mappedRemote;
  let mappedLocal;
  try {
    [mappedRemote, mappedLocal] = await Promise.all([
      merged.getRemoteKey(localKey, orgId),
      merged.getLocalKey(remoteKey, orgId)
    ]);
  } catch {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.ADOPTION_FAILED);
  }
  if ((mappedRemote && mappedRemote !== remoteKey)
      || (mappedLocal && mappedLocal !== localKey)) {
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.MAPPING_CONFLICT);
  }
  if (mappedRemote === remoteKey && mappedLocal === localKey) {
    return {
      success: true,
      idempotent: true,
      code: 'PAIR_WITNESS_ALREADY_ADOPTED',
      message: 'The verified pair is already mapped. Nothing was written.',
      orgId,
      localKey,
      remoteKey,
      localIssueId: localIssue.id,
      remoteIssueId: remoteIssue.id,
      pairId
    };
  }

  try {
    await merged.storeMapping(localKey, remoteKey, orgId);
  } catch (error) {
    try {
      await merged.auditWrite({
        action: 'adopt-pair-witness',
        orgId,
        sourceIssue: localKey,
        targetIssue: remoteKey,
        success: false,
        pairId,
        reason: error?.code || 'MAPPING_WRITE_FAILED',
        errors: [error?.code || 'MAPPING_WRITE_FAILED']
      });
    } catch {
      // Auditing is best-effort.
    }
    return failure(PAIR_WITNESS_ADOPTION_ERRORS.MAPPING_WRITE_FAILED);
  }

  try {
    await merged.auditWrite({
      action: 'adopt-pair-witness',
      orgId,
      sourceIssue: localKey,
      targetIssue: remoteKey,
      success: true,
      pairId,
      reason: 'witness-verified-mapping-restored',
      errors: []
    });
  } catch {
    // The mapping is the operational outcome; a failed audit does not undo it.
  }

  return {
    success: true,
    idempotent: false,
    code: 'PAIR_WITNESS_PAIR_ADOPTED',
    message: 'The verified pair mapping was restored. No Jira issue was changed.',
    orgId,
    localKey,
    remoteKey,
    localIssueId: localIssue.id,
    remoteIssueId: remoteIssue.id,
    pairId,
    adoptedBy: typeof actorAccountId === 'string' ? actorAccountId.slice(0, 100) : null
  };
}

