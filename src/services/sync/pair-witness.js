import { createHash } from 'crypto';
import api, { route, fetch } from '../jira/guarded-api.js';
import { stableStringify } from './recovery-snapshot.js';
import { isValidIssueKey } from '../storage/mappings.js';
import {
  PAIR_WITNESS_MAX_KEY_BYTES,
  PAIR_WITNESS_MAX_VALUE_BYTES,
  PAIR_WITNESS_PROPERTY_KEY,
  PAIR_WITNESS_VERSION
} from './pair-witness-constants.js';

export {
  PAIR_WITNESS_MAX_KEY_BYTES,
  PAIR_WITNESS_MAX_VALUE_BYTES,
  PAIR_WITNESS_PROPERTY_KEY,
  PAIR_WITNESS_VERSION
};

/**
 * Jira issue-property pairing witness: schema, canonical form and read access.
 *
 * The witness is a small, versioned JSON value stored as an entity property on
 * BOTH issues of a synchronized pair. It exists so a previously synchronized
 * pair can still be recognised after Forge mapping and ledger records are lost,
 * because the evidence then lives in Jira instead of Forge storage.
 *
 * Phase 1 is read-only. This module never writes a property, never creates an
 * issue, never imports a storage write helper and never reaches a POST/PUT/DELETE
 * endpoint: both readers issue a GET through the guarded transport, so the
 * existing pause, lease-migration and synchronization-authorization gates still
 * apply to every request.
 *
 * Reading is deliberately conservative:
 *   - 404 means absent and only absent.
 *   - 401/403 means inaccessible (project permissions or app access rules) and
 *     is never treated as absent.
 *   - 429, 5xx and transport failures mean unverifiable.
 *   - A newer schema, a foreign installation, a foreign organization, a site
 *     mismatch, an issue mismatch or a malformed value is a conflict.
 */


export const PAIR_WITNESS_STATES = Object.freeze({
  PENDING_CREATE: 'pending-create',
  ACTIVE: 'active',
  ENDED: 'ended'
});

export const PAIR_WITNESS_SIDES = Object.freeze({
  LOCAL: 'local',
  REMOTE: 'remote'
});

export const PAIR_WITNESS_DIRECTIONS = Object.freeze(['local-to-remote', 'remote-to-local']);

/**
 * Read classes. `matching` is the only class that proves a pair. Everything
 * else either blocks (conflict/inaccessible/unverifiable) or reports absence.
 */
export const PAIR_WITNESS_READ_CLASSES = Object.freeze({
  MATCHING: 'matching',
  ABSENT: 'absent',
  DIFFERENT_PAIR: 'different-pair',
  ENDED: 'ended',
  PENDING_CREATE: 'pending-create',
  INACCESSIBLE: 'inaccessible',
  UNVERIFIABLE: 'unverifiable',
  MALFORMED: 'malformed',
  SCHEMA_NEWER: 'schema-newer',
  FOREIGN_INSTALLATION: 'foreign-installation',
  FOREIGN_ORGANIZATION: 'foreign-organization',
  ISSUE_MISMATCH: 'issue-mismatch',
  SITE_MISMATCH: 'site-mismatch'
});

export const PAIR_WITNESS_ISSUE_CLASSES = Object.freeze({
  PRESENT: 'present',
  MISSING: 'missing',
  INACCESSIBLE: 'inaccessible',
  UNVERIFIABLE: 'unverifiable'
});


export const PAIR_WITNESS_CODES = Object.freeze({
  NOT_FOUND: 'PAIR_WITNESS_NOT_FOUND',
  INACCESSIBLE: 'PAIR_WITNESS_INACCESSIBLE',
  RATE_LIMITED: 'PAIR_WITNESS_RATE_LIMITED',
  UNAVAILABLE: 'PAIR_WITNESS_UNAVAILABLE',
  NETWORK: 'PAIR_WITNESS_NETWORK_ERROR',
  MALFORMED: 'PAIR_WITNESS_MALFORMED',
  VALUE_TOO_LARGE: 'PAIR_WITNESS_VALUE_TOO_LARGE',
  SCHEMA_UNKNOWN: 'PAIR_WITNESS_SCHEMA_UNKNOWN',
  FOREIGN_INSTALLATION: 'PAIR_WITNESS_FOREIGN_INSTALLATION',
  FOREIGN_ORGANIZATION: 'PAIR_WITNESS_FOREIGN_ORGANIZATION',
  ISSUE_MISMATCH: 'PAIR_WITNESS_ISSUE_MISMATCH',
  SITE_MISMATCH: 'PAIR_WITNESS_SITE_MISMATCH',
  INVALID_INPUT: 'PAIR_WITNESS_INVALID_INPUT',
  ISSUE_MISSING: 'PAIR_WITNESS_ISSUE_MISSING',
  ISSUE_UNVERIFIABLE: 'PAIR_WITNESS_ISSUE_UNVERIFIABLE'
});

export const PAIR_WITNESS_MESSAGES = Object.freeze({
  [PAIR_WITNESS_CODES.NOT_FOUND]: 'No pairing witness is stored on this issue.',
  [PAIR_WITNESS_CODES.INACCESSIBLE]:
    'The pairing witness could not be read because the issue is not accessible to the connector. This is not evidence that no witness exists.',
  [PAIR_WITNESS_CODES.RATE_LIMITED]:
    'Jira rate limited the pairing-witness read, so the witness could not be verified.',
  [PAIR_WITNESS_CODES.UNAVAILABLE]:
    'Jira did not answer the pairing-witness read, so the witness could not be verified.',
  [PAIR_WITNESS_CODES.NETWORK]:
    'The pairing-witness read failed before a response was received, so the witness could not be verified.',
  [PAIR_WITNESS_CODES.MALFORMED]:
    'A pairing witness exists but is not a record this connector wrote.',
  [PAIR_WITNESS_CODES.VALUE_TOO_LARGE]: 'The pairing witness exceeds the Jira property value limit.',
  [PAIR_WITNESS_CODES.SCHEMA_UNKNOWN]:
    'A pairing witness exists with a schema version this connector does not understand.',
  [PAIR_WITNESS_CODES.FOREIGN_INSTALLATION]:
    'A pairing witness belongs to a different Forge installation or app.',
  [PAIR_WITNESS_CODES.FOREIGN_ORGANIZATION]:
    'A pairing witness belongs to a different connector organization.',
  [PAIR_WITNESS_CODES.ISSUE_MISMATCH]:
    'A pairing witness names a different issue than the one it is stored on.',
  [PAIR_WITNESS_CODES.SITE_MISMATCH]:
    'A pairing witness names a different Jira site than this connector is configured with.',
  [PAIR_WITNESS_CODES.INVALID_INPUT]:
    'The pairing witness could not be built from the supplied values.',
  [PAIR_WITNESS_CODES.ISSUE_MISSING]: 'The issue this witness refers to no longer exists.',
  [PAIR_WITNESS_CODES.ISSUE_UNVERIFIABLE]: 'The issue could not be verified.'
});

export class PairWitnessError extends Error {
  constructor(code, details = {}) {
    super(PAIR_WITNESS_MESSAGES[code] || 'The pairing witness is not usable.');
    this.name = 'PairWitnessError';
    this.code = code;
    this.details = details;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISSUE_ID_PATTERN = /^\d{1,32}$/;
const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const ORGANIZATION_ID_PATTERN = /^org-\d+$/;
const SITE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/;
const VALID_STATES = new Set(Object.values(PAIR_WITNESS_STATES));

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isIssueId(value) {
  return typeof value === 'string' && ISSUE_ID_PATTERN.test(value);
}

function isInstallationId(value) {
  return typeof value === 'string' && INSTALLATION_ID_PATTERN.test(value);
}

function isOrganizationId(value) {
  return typeof value === 'string' && ORGANIZATION_ID_PATTERN.test(value);
}

function isSite(value) {
  return typeof value === 'string' && SITE_PATTERN.test(value);
}

function isTimestamp(value) {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
/**
 * Digest of the security-relevant payload of a witness: identity, organization,
 * sites, both issue ids, both keys, state and direction.
 *
 * `writtenAt` and `digest` are excluded so a re-issued permit still matches a
 * body written a moment later, while the pair id, both issues, the organization
 * and the state are all bound. A permit authorizes one exact payload, not
 * "whatever this issue might send".
 */
export const PAIR_WITNESS_PAYLOAD_FIELDS = Object.freeze([
  'v',
  'pairId',
  'state',
  'installationId',
  'appId',
  'orgId',
  'localSite',
  'remoteSite',
  'localIssueId',
  'localKey',
  'remoteIssueId',
  'remoteKey',
  'direction'
]);

export function pairWitnessPayloadDigest(record) {
  const source = isPlainObject(record) ? record : {};
  const payload = {};
  for (const field of PAIR_WITNESS_PAYLOAD_FIELDS) {
    payload[field] = source[field] === undefined ? null : source[field];
  }
  return `sha256:${sha256Hex(stableStringify(payload))}`;
}

/** True when two stored/intended witnesses describe the same pair identically. */
export function samePairWitness(left, right) {
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  return serializePairWitness(left) === serializePairWitness(right);
}

/** Fixed namespace for derived pair ids. Never change it: pair identity depends on it. */
export const PAIR_WITNESS_NAMESPACE = '6f2b3c1e-7a5d-5e4f-9b8a-1c2d3e4f5a6b';

/**
 * Deterministic pair identity (RFC 4122 v5 over the stable identity tuple).
 *
 * A random id per attempt would create two different witnesses for one pair
 * after an interrupted run. Deriving the id from installation, organization and
 * both stable issue ids makes it identical on every retry, in every process and
 * after losing every plan record — while a different org or issue yields a
 * different id.
 */
export function deterministicPairId({ installationId, orgId, localIssueId, remoteIssueId } = {}) {
  if (!isInstallationId(installationId) || !isOrganizationId(orgId)
    || !isIssueId(localIssueId) || !isIssueId(remoteIssueId)) {
    throw new PairWitnessError(PAIR_WITNESS_CODES.INVALID_INPUT, { field: 'pairIdSource' });
  }
  const namespace = Buffer.from(PAIR_WITNESS_NAMESPACE.replace(/-/g, ''), 'hex');
  const name = Buffer.from(
    `${installationId}:${orgId}:${localIssueId}:${remoteIssueId}`,
    'utf8'
  );
  const digest = createHash('sha1').update(Buffer.concat([namespace, name])).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Canonical serialization; the digest is computed over exactly these bytes. */
export function serializePairWitness(record) {
  const { digest, ...rest } = record || {};
  return stableStringify(rest);
}

export function pairWitnessDigest(record) {
  return `sha256:${sha256Hex(serializePairWitness(record))}`;
}

/**
 * Builds the canonical witness value. Throws PairWitnessError when any field
 * cannot be represented, so a caller can never persist an ambiguous record.
 */
export function buildPairWitness(input = {}) {
  const fail = (field) => {
    throw new PairWitnessError(PAIR_WITNESS_CODES.INVALID_INPUT, { field });
  };

  if (!isUuid(input.pairId)) fail('pairId');
  if (!VALID_STATES.has(input.state)) fail('state');
  if (!isInstallationId(input.installationId)) fail('installationId');
  if (!isInstallationId(input.appId)) fail('appId');
  if (!isOrganizationId(input.orgId)) fail('orgId');
  if (!isSite(input.localSite)) fail('localSite');
  if (!isSite(input.remoteSite)) fail('remoteSite');
  if (!isIssueId(input.localIssueId)) fail('localIssueId');
  if (!isIssueId(input.remoteIssueId)) fail('remoteIssueId');
  if (!isValidIssueKey(input.localKey)) fail('localKey');
  if (!isValidIssueKey(input.remoteKey)) fail('remoteKey');
  if (!PAIR_WITNESS_DIRECTIONS.includes(input.direction)) fail('direction');
  if (!isTimestamp(input.writtenAt)) fail('writtenAt');

  const record = {
    v: PAIR_WITNESS_VERSION,
    pairId: input.pairId,
    state: input.state,
    installationId: input.installationId,
    appId: input.appId,
    orgId: input.orgId,
    localSite: input.localSite,
    remoteSite: input.remoteSite,
    localIssueId: input.localIssueId,
    localKey: input.localKey,
    remoteIssueId: input.remoteIssueId,
    remoteKey: input.remoteKey,
    direction: input.direction,
    writtenAt: input.writtenAt
  };
  const complete = { ...record, digest: pairWitnessDigest(record) };
  const bytes = Buffer.byteLength(JSON.stringify(complete), 'utf8');
  if (bytes > PAIR_WITNESS_MAX_VALUE_BYTES) {
    throw new PairWitnessError(PAIR_WITNESS_CODES.VALUE_TOO_LARGE, { bytes });
  }
  return complete;
}

/**
 * Parses a stored property value. Returns `{ ok: true, record }` for a complete
 * v1 record and `{ ok: false, code }` for anything else. A record with a
 * different major version is reported as `SCHEMA_UNKNOWN`, never coerced.
 */
export function parsePairWitnessValue(value) {
  if (!isPlainObject(value)) {
    return { ok: false, code: PAIR_WITNESS_CODES.MALFORMED, record: null };
  }
  if (!Number.isInteger(value.v) || value.v < 1) {
    return { ok: false, code: PAIR_WITNESS_CODES.MALFORMED, record: null };
  }
  if (value.v > PAIR_WITNESS_VERSION) {
    return { ok: false, code: PAIR_WITNESS_CODES.SCHEMA_UNKNOWN, record: null };
  }
  if (value.v !== PAIR_WITNESS_VERSION) {
    return { ok: false, code: PAIR_WITNESS_CODES.MALFORMED, record: null };
  }
  if (!isUuid(value.pairId)
    || !VALID_STATES.has(value.state)
    || !isInstallationId(value.installationId)
    || !isInstallationId(value.appId)
    || !isOrganizationId(value.orgId)
    || !isSite(value.localSite)
    || !isSite(value.remoteSite)
    || !isIssueId(value.localIssueId)
    || !isIssueId(value.remoteIssueId)
    || !isValidIssueKey(value.localKey)
    || !isValidIssueKey(value.remoteKey)
    || !PAIR_WITNESS_DIRECTIONS.includes(value.direction)
    || !isTimestamp(value.writtenAt)
    || typeof value.digest !== 'string') {
    return { ok: false, code: PAIR_WITNESS_CODES.MALFORMED, record: null };
  }
  const record = {
    v: value.v,
    pairId: value.pairId,
    state: value.state,
    installationId: value.installationId,
    appId: value.appId,
    orgId: value.orgId,
    localSite: value.localSite,
    remoteSite: value.remoteSite,
    localIssueId: value.localIssueId,
    localKey: value.localKey,
    remoteIssueId: value.remoteIssueId,
    remoteKey: value.remoteKey,
    direction: value.direction,
    writtenAt: value.writtenAt,
    digest: value.digest
  };
  // A digest mismatch means the value was edited or partially replaced. It is
  // reported as malformed rather than trusted field by field.
  if (pairWitnessDigest(record) !== value.digest) {
    return { ok: false, code: PAIR_WITNESS_CODES.MALFORMED, record: null };
  }
  return { ok: true, code: null, record };
}


/**
 * Pure classification of one property read.
 *
 * `expected` carries what the caller believes the pair is. Every field is
 * optional so a caller can classify without prior knowledge.
 */
export function classifyPairWitnessResponse({
  side,
  status,
  body = null,
  bodyUnreadable = false,
  transportError = false,
  expected = {}
} = {}) {
  const base = {
    side,
    statusCode: Number.isFinite(Number(status)) ? Number(status) : null,
    record: null,
    pairId: null,
    state: null
  };

  if (transportError) {
    return { ...base, class: PAIR_WITNESS_READ_CLASSES.UNVERIFIABLE, code: PAIR_WITNESS_CODES.NETWORK };
  }
  if (status === 404) {
    return { ...base, class: PAIR_WITNESS_READ_CLASSES.ABSENT, code: PAIR_WITNESS_CODES.NOT_FOUND };
  }
  if (status === 401 || status === 403) {
    return { ...base, class: PAIR_WITNESS_READ_CLASSES.INACCESSIBLE, code: PAIR_WITNESS_CODES.INACCESSIBLE };
  }
  if (status === 429) {
    return { ...base, class: PAIR_WITNESS_READ_CLASSES.UNVERIFIABLE, code: PAIR_WITNESS_CODES.RATE_LIMITED };
  }
  if (status !== 200) {
    return { ...base, class: PAIR_WITNESS_READ_CLASSES.UNVERIFIABLE, code: PAIR_WITNESS_CODES.UNAVAILABLE };
  }
  if (bodyUnreadable || !isPlainObject(body)) {
    return { ...base, class: PAIR_WITNESS_READ_CLASSES.MALFORMED, code: PAIR_WITNESS_CODES.MALFORMED };
  }
  // Jira answers `{ key, value }`. A 200 without a `value` member is not a
  // witness this connector wrote.
  if (!Object.prototype.hasOwnProperty.call(body, 'value')) {
    return { ...base, class: PAIR_WITNESS_READ_CLASSES.MALFORMED, code: PAIR_WITNESS_CODES.MALFORMED };
  }

  const parsed = parsePairWitnessValue(body.value);
  if (!parsed.ok) {
    const readClass = parsed.code === PAIR_WITNESS_CODES.SCHEMA_UNKNOWN
      ? PAIR_WITNESS_READ_CLASSES.SCHEMA_NEWER
      : PAIR_WITNESS_READ_CLASSES.MALFORMED;
    return { ...base, class: readClass, code: parsed.code };
  }

  const record = parsed.record;
  const seen = { ...base, record, pairId: record.pairId, state: record.state };

  if (typeof expected.installationId === 'string' && record.installationId !== expected.installationId) {
    return {
      ...seen,
      class: PAIR_WITNESS_READ_CLASSES.FOREIGN_INSTALLATION,
      code: PAIR_WITNESS_CODES.FOREIGN_INSTALLATION
    };
  }
  if (typeof expected.appId === 'string' && record.appId !== expected.appId) {
    return {
      ...seen,
      class: PAIR_WITNESS_READ_CLASSES.FOREIGN_INSTALLATION,
      code: PAIR_WITNESS_CODES.FOREIGN_INSTALLATION
    };
  }
  if (typeof expected.orgId === 'string' && record.orgId !== expected.orgId) {
    return {
      ...seen,
      class: PAIR_WITNESS_READ_CLASSES.FOREIGN_ORGANIZATION,
      code: PAIR_WITNESS_CODES.FOREIGN_ORGANIZATION
    };
  }
  if (typeof expected.localSite === 'string' && record.localSite !== expected.localSite) {
    return { ...seen, class: PAIR_WITNESS_READ_CLASSES.SITE_MISMATCH, code: PAIR_WITNESS_CODES.SITE_MISMATCH };
  }
  if (typeof expected.remoteSite === 'string' && record.remoteSite !== expected.remoteSite) {
    return { ...seen, class: PAIR_WITNESS_READ_CLASSES.SITE_MISMATCH, code: PAIR_WITNESS_CODES.SITE_MISMATCH };
  }
  const claimedIssueId = side === PAIR_WITNESS_SIDES.REMOTE ? record.remoteIssueId : record.localIssueId;
  if (typeof expected.issueId === 'string' && claimedIssueId !== expected.issueId) {
    return { ...seen, class: PAIR_WITNESS_READ_CLASSES.ISSUE_MISMATCH, code: PAIR_WITNESS_CODES.ISSUE_MISMATCH };
  }
  if (record.state === PAIR_WITNESS_STATES.ENDED) {
    return { ...seen, class: PAIR_WITNESS_READ_CLASSES.ENDED, code: null };
  }
  if (record.state === PAIR_WITNESS_STATES.PENDING_CREATE) {
    return { ...seen, class: PAIR_WITNESS_READ_CLASSES.PENDING_CREATE, code: null };
  }
  if (typeof expected.pairId === 'string' && record.pairId !== expected.pairId) {
    return { ...seen, class: PAIR_WITNESS_READ_CLASSES.DIFFERENT_PAIR, code: null };
  }
  return { ...seen, class: PAIR_WITNESS_READ_CLASSES.MATCHING, code: null };
}

/** Classifies the existence read of one issue. 403 is never "missing". */
export function classifyIssueResponse({ side, status, body = null, transportError = false } = {}) {
  const base = {
    side,
    statusCode: Number.isFinite(Number(status)) ? Number(status) : null,
    id: null,
    key: null
  };
  if (transportError) {
    return { ...base, class: PAIR_WITNESS_ISSUE_CLASSES.UNVERIFIABLE, code: PAIR_WITNESS_CODES.NETWORK };
  }
  if (status === 404) {
    return { ...base, class: PAIR_WITNESS_ISSUE_CLASSES.MISSING, code: PAIR_WITNESS_CODES.ISSUE_MISSING };
  }
  if (status === 401 || status === 403) {
    return { ...base, class: PAIR_WITNESS_ISSUE_CLASSES.INACCESSIBLE, code: PAIR_WITNESS_CODES.INACCESSIBLE };
  }
  if (status !== 200) {
    return { ...base, class: PAIR_WITNESS_ISSUE_CLASSES.UNVERIFIABLE, code: PAIR_WITNESS_CODES.ISSUE_UNVERIFIABLE };
  }
  const id = isPlainObject(body) && isIssueId(String(body.id ?? '')) ? String(body.id) : null;
  const key = isPlainObject(body) && isValidIssueKey(body.key) ? body.key : null;
  if (!id && !key) {
    return { ...base, class: PAIR_WITNESS_ISSUE_CLASSES.UNVERIFIABLE, code: PAIR_WITNESS_CODES.ISSUE_UNVERIFIABLE };
  }
  return { ...base, id, key, class: PAIR_WITNESS_ISSUE_CLASSES.PRESENT, code: null };
}

/** True when the read neither proves absence nor permits a create. */
export function pairWitnessBlocksCreation(readClass) {
  return readClass !== PAIR_WITNESS_READ_CLASSES.ABSENT;
}


function basicAuth(org) {
  return Buffer.from(`${org.remoteEmail}:${org.remoteApiToken}`).toString('base64');
}

function propertyPath(issueRef) {
  return `/rest/api/3/issue/${issueRef}/properties/${PAIR_WITNESS_PROPERTY_KEY}`;
}

const defaultDeps = {
  requestLocal: (issueRef) => api.asApp().requestJira(
    route`/rest/api/3/issue/${issueRef}/properties/${PAIR_WITNESS_PROPERTY_KEY}`,
    { headers: { 'Accept': 'application/json' } }
  ),
  requestLocalIssue: (issueRef) => api.asApp().requestJira(
    route`/rest/api/3/issue/${issueRef}?fields=key`,
    { headers: { 'Accept': 'application/json' } }
  ),
  fetchRemote: (org, issueRef) => fetch(`${org.remoteUrl}${propertyPath(issueRef)}`, {
    method: 'GET',
    headers: {
      'Authorization': `Basic ${basicAuth(org)}`,
      'Accept': 'application/json'
    }
  }),
  fetchRemoteIssue: (org, issueRef) => fetch(`${org.remoteUrl}/rest/api/3/issue/${issueRef}?fields=key`, {
    method: 'GET',
    headers: {
      'Authorization': `Basic ${basicAuth(org)}`,
      'Accept': 'application/json'
    }
  })
};

async function readResponse(call) {
  let response;
  try {
    response = await call();
  } catch {
    return { transportError: true };
  }
  const status = Number(response?.status);
  const result = { status: Number.isFinite(status) ? status : null, body: null, bodyUnreadable: false };
  if (result.status === 200) {
    try {
      result.body = await response.json();
    } catch {
      result.bodyUnreadable = true;
    }
  }
  return result;
}

/**
 * Reads the witness stored on one issue of a pair. `issueRef` is a stable issue
 * id when known, otherwise a key. Only a GET is issued.
 */
export async function readPairWitness({
  side,
  issueRef,
  org = null,
  expected = {},
  deps = {}
} = {}) {
  const merged = { ...defaultDeps, ...deps };
  if (typeof issueRef !== 'string' || issueRef.trim() === '') {
    throw new PairWitnessError(PAIR_WITNESS_CODES.INVALID_INPUT, { field: 'issueRef' });
  }
  if (side === PAIR_WITNESS_SIDES.REMOTE && !isPlainObject(org)) {
    throw new PairWitnessError(PAIR_WITNESS_CODES.INVALID_INPUT, { field: 'org' });
  }
  const read = side === PAIR_WITNESS_SIDES.REMOTE
    ? await readResponse(() => merged.fetchRemote(org, issueRef))
    : await readResponse(() => merged.requestLocal(issueRef));
  return {
    issueRef,
    ...classifyPairWitnessResponse({ side, expected, ...read })
  };
}

/** Reads `{ id, key }` for one issue. Only a GET is issued. */
export async function readIssueIdentity({
  side,
  issueRef,
  org = null,
  deps = {}
} = {}) {
  const merged = { ...defaultDeps, ...deps };
  if (typeof issueRef !== 'string' || issueRef.trim() === '') {
    throw new PairWitnessError(PAIR_WITNESS_CODES.INVALID_INPUT, { field: 'issueRef' });
  }
  if (side === PAIR_WITNESS_SIDES.REMOTE && !isPlainObject(org)) {
    throw new PairWitnessError(PAIR_WITNESS_CODES.INVALID_INPUT, { field: 'org' });
  }
  const read = side === PAIR_WITNESS_SIDES.REMOTE
    ? await readResponse(() => merged.fetchRemoteIssue(org, issueRef))
    : await readResponse(() => merged.requestLocalIssue(issueRef));
  return { issueRef, ...classifyIssueResponse({ side, ...read }) };
}

