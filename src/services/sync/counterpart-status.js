import * as kvsStore from '../storage/kvs.js';

const ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-[0-9]+$/;

function isValidIssueKey(value) {
  return typeof value === 'string' && value.length <= 100 && ISSUE_KEY_PATTERN.test(value);
}

export const COUNTERPART_STATUS_VALUES = Object.freeze({
  CONFIRMED_DELETED: 'confirmed_deleted',
  UNAVAILABLE: 'unavailable',
  ACCESS_PROBLEM: 'access_problem',
  TEMPORARY_FAILURE: 'temporary_failure'
});

export const COUNTERPART_RECORD_STATES = Object.freeze({
  ACTIVE: 'active',
  RESOLVED: 'resolved',
  ENDED: 'ended',
  REPLACED: 'replaced',
  DISMISSED: 'dismissed'
});

export const COUNTERPART_DELETED_SIDES = Object.freeze({
  LOCAL: 'local',
  REMOTE: 'remote'
});

const STATUS_PREFIX = 'counterpart-status';
const SAFE_REASON_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;
const VALID_STATUSES = new Set(Object.values(COUNTERPART_STATUS_VALUES));
const VALID_SIDES = new Set(Object.values(COUNTERPART_DELETED_SIDES));
const VALID_STATES = new Set(Object.values(COUNTERPART_RECORD_STATES));

function orgScope(orgId) {
  return orgId === null || orgId === undefined || orgId === '' ? 'legacy' : String(orgId);
}

function safeReason(value, fallback = 'unspecified') {
  return typeof value === 'string' && SAFE_REASON_PATTERN.test(value)
    ? value.slice(0, 80)
    : fallback;
}

function safeStatus(value) {
  return VALID_STATUSES.has(value) ? value : null;
}

function safeSide(value) {
  return VALID_SIDES.has(value) ? value : null;
}

function statusKey(orgId, localKey, remoteKey) {
  return `${STATUS_PREFIX}:${orgScope(orgId)}:${localKey}:${remoteKey}`;
}

function statusPrefix(orgId) {
  return `${STATUS_PREFIX}:${orgScope(orgId)}:`;
}

function safeTimestamp(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function sanitizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!isValidIssueKey(value.localKey) || !isValidIssueKey(value.remoteKey)) return null;
  const status = safeStatus(value.status);
  if (!status) return null;
  const state = VALID_STATES.has(value.state)
    ? value.state
    : COUNTERPART_RECORD_STATES.ACTIVE;
  return {
    version: 1,
    orgId: orgScope(value.orgId),
    localKey: value.localKey,
    remoteKey: value.remoteKey,
    status,
    deletedSide: safeSide(value.deletedSide),
    source: safeReason(value.source, 'unknown'),
    reasonCode: safeReason(value.reasonCode, 'unspecified'),
    probeStatusCode: Number.isInteger(value.probeStatusCode)
      ? value.probeStatusCode
      : null,
    firstDetectedAt: safeTimestamp(value.firstDetectedAt),
    lastDetectedAt: safeTimestamp(value.lastDetectedAt),
    updatedAt: safeTimestamp(value.updatedAt),
    state,
    endedAt: safeTimestamp(value.endedAt),
    endedBy: typeof value.endedBy === 'string' ? value.endedBy.slice(0, 100) : null,
    resolvedAt: safeTimestamp(value.resolvedAt),
    replacementLocalKey: isValidIssueKey(value.replacementLocalKey)
      ? value.replacementLocalKey
      : null,
    replacementRemoteKey: isValidIssueKey(value.replacementRemoteKey)
      ? value.replacementRemoteKey
      : null
  };
}

export function buildCounterpartStatusKey({ orgId = null, localKey, remoteKey }) {
  if (!isValidIssueKey(localKey) || !isValidIssueKey(remoteKey)) {
    throw new Error('Invalid issue key in counterpart status');
  }
  return statusKey(orgId, localKey, remoteKey);
}

/**
 * Persist only safe identifiers and classification metadata. Descriptions,
 * summaries, URLs, tokens, comments and arbitrary Jira fields are never stored.
 */
export async function recordCounterpartStatus({
  orgId = null,
  localKey,
  remoteKey,
  status,
  deletedSide = null,
  source,
  reasonCode = 'unspecified',
  probeStatusCode = null,
  now = Date.now()
}) {
  const safeClassifiedStatus = safeStatus(status);
  if (!isValidIssueKey(localKey) || !isValidIssueKey(remoteKey) || !safeClassifiedStatus) {
    return { success: false, code: 'COUNTERPART_STATUS_INVALID' };
  }

  const key = statusKey(orgId, localKey, remoteKey);
  const timestamp = new Date(now).toISOString();
  let existing = null;
  try {
    existing = sanitizeRecord(await kvsStore.get(key));
  } catch {
    return { success: false, code: 'COUNTERPART_STATUS_STORAGE_ERROR' };
  }

  // A duplicate/late event must not reopen an archived incident. Replacement and
  // ending are terminal for that exact old pair.
  if (existing && (
    existing.state === COUNTERPART_RECORD_STATES.ENDED
    || existing.state === COUNTERPART_RECORD_STATES.REPLACED
  )) {
    return { success: false, code: 'COUNTERPART_STATUS_ARCHIVED', record: existing };
  }

  const next = {
    version: 1,
    orgId: orgScope(orgId),
    localKey,
    remoteKey,
    status: safeClassifiedStatus,
    deletedSide: safeSide(deletedSide),
    source: safeReason(source, 'unknown'),
    reasonCode: safeReason(reasonCode, 'unspecified'),
    probeStatusCode: Number.isInteger(probeStatusCode) ? probeStatusCode : null,
    firstDetectedAt: existing?.firstDetectedAt || timestamp,
    lastDetectedAt: timestamp,
    updatedAt: timestamp,
    state: COUNTERPART_RECORD_STATES.ACTIVE,
    endedAt: null,
    endedBy: null,
    resolvedAt: null,
    replacementLocalKey: null,
    replacementRemoteKey: null
  };

  try {
    await kvsStore.set(key, next);
    return { success: true, record: sanitizeRecord(next) };
  } catch {
    return { success: false, code: 'COUNTERPART_STATUS_STORAGE_ERROR' };
  }
}

export async function getCounterpartStatus({ orgId = null, localKey, remoteKey }) {
  if (!isValidIssueKey(localKey) || !isValidIssueKey(remoteKey)) {
    return null;
  }
  try {
    return sanitizeRecord(await kvsStore.get(statusKey(orgId, localKey, remoteKey)));
  } catch {
    return null;
  }
}

async function listStatusRecords(prefix, limit) {
  if (typeof kvsStore.queryByPrefix !== 'function') {
    return [];
  }
  try {
    const results = await kvsStore.queryByPrefix(prefix, limit);
    return results.map(result => sanitizeRecord(result.value)).filter(Boolean);
  } catch {
    return [];
  }
}

export async function listCounterpartStatuses(orgId, {
  includeResolved = false,
  limit = 200
} = {}) {
  const records = await listStatusRecords(statusPrefix(orgId), Math.min(limit, 1000));
  return records
    .filter(record => includeResolved || record.state === COUNTERPART_RECORD_STATES.ACTIVE)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, limit);
}

/**
 * A local key can have archived records for older counterpart pairs. Return the
 * newest record so normal synchronization cannot resurrect an ended pair.
 */
export async function getLatestCounterpartStatusForLocalKey(orgId, localKey) {
  if (!isValidIssueKey(localKey)) return null;
  const records = await listStatusRecords(`${statusPrefix(orgId)}${localKey}:`, 50);
  return records
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
}

export async function resolveCounterpartStatus({
  orgId = null,
  localKey,
  remoteKey,
  state = COUNTERPART_RECORD_STATES.RESOLVED,
  endedAt = null,
  endedBy = null,
  replacementLocalKey = null,
  replacementRemoteKey = null,
  now = Date.now()
}) {
  if (!VALID_STATES.has(state)) {
    return { success: false, code: 'COUNTERPART_STATUS_INVALID' };
  }
  const existing = await getCounterpartStatus({ orgId, localKey, remoteKey });
  if (!existing) {
    return { success: false, code: 'COUNTERPART_STATUS_NOT_FOUND' };
  }
  const timestamp = new Date(now).toISOString();
  const next = {
    ...existing,
    state,
    updatedAt: timestamp,
    endedAt: state === COUNTERPART_RECORD_STATES.ENDED
      ? (safeTimestamp(endedAt) || timestamp)
      : existing.endedAt,
    endedBy: state === COUNTERPART_RECORD_STATES.ENDED
      ? (typeof endedBy === 'string' ? endedBy.slice(0, 100) : null)
      : existing.endedBy,
    resolvedAt: state === COUNTERPART_RECORD_STATES.RESOLVED
      || state === COUNTERPART_RECORD_STATES.DISMISSED
      ? timestamp
      : existing.resolvedAt,
    replacementLocalKey: isValidIssueKey(replacementLocalKey)
      ? replacementLocalKey
      : existing.replacementLocalKey,
    replacementRemoteKey: isValidIssueKey(replacementRemoteKey)
      ? replacementRemoteKey
      : existing.replacementRemoteKey
  };
  try {
    await kvsStore.set(statusKey(orgId, localKey, remoteKey), next);
    return { success: true, record: sanitizeRecord(next) };
  } catch {
    return { success: false, code: 'COUNTERPART_STATUS_STORAGE_ERROR' };
  }
}

export function counterpartStatusBlocksSync(record, { hasMapping = true } = {}) {
  if (!record || record.state !== COUNTERPART_RECORD_STATES.ACTIVE) {
    if (record?.state === COUNTERPART_RECORD_STATES.ENDED && !hasMapping) {
      return { blocked: true, code: 'COUNTERPART_SYNC_ENDED' };
    }
    return { blocked: false };
  }
  switch (record.status) {
    case COUNTERPART_STATUS_VALUES.CONFIRMED_DELETED:
      return { blocked: true, code: 'COUNTERPART_CONFIRMED_DELETED' };
    case COUNTERPART_STATUS_VALUES.UNAVAILABLE:
      return { blocked: true, code: 'COUNTERPART_UNAVAILABLE' };
    case COUNTERPART_STATUS_VALUES.ACCESS_PROBLEM:
      return { blocked: true, code: 'COUNTERPART_ACCESS_PROBLEM' };
    default:
      return { blocked: false };
  }
}

export function normalizeCounterpartStatusClass(statusCode) {
  const code = Number(statusCode);
  if (code === 404) return COUNTERPART_STATUS_VALUES.UNAVAILABLE;
  if (code === 401 || code === 403) return COUNTERPART_STATUS_VALUES.ACCESS_PROBLEM;
  if (code === 429 || code >= 500) return COUNTERPART_STATUS_VALUES.TEMPORARY_FAILURE;
  if (Number.isInteger(code) && code >= 400) return COUNTERPART_STATUS_VALUES.UNAVAILABLE;
  return null;
}
