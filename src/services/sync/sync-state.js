import * as kvsStore from '../storage/kvs.js';
import { recordSyncDecision, buildConflictRecord, SYNC_DECISIONS } from './sync-observability.js';

export const ECHO_MARKER_TTL_SECONDS = 10 * 60;
export const CONFLICT_RECORD_TTL_SECONDS = 30 * 24 * 60 * 60;
const JIRA_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/;

function orgScope(orgId) {
  return orgId === null || orgId === undefined || orgId === '' ? 'legacy' : String(orgId);
}

function pairScope(localKey, remoteKey) {
  return `${localKey || 'unknown-local'}:${remoteKey || 'unmapped'}`;
}

export function echoMarkerKey({ orgId = null, localKey, remoteKey = null, observedSide }) {
  return `sync-echo:${orgScope(orgId)}:${pairScope(localKey, remoteKey)}:${observedSide}`;
}

export function latestAcceptedKey({ orgId = null, direction, localKey, remoteKey = null }) {
  return `sync-latest:${orgScope(orgId)}:${direction}:${pairScope(localKey, remoteKey)}`;
}

export function conflictRecordKey({ orgId = null, localKey, remoteKey = null }) {
  return `sync-conflict:${orgScope(orgId)}:${pairScope(localKey, remoteKey)}`;
}

/**
 * Strictly parse a Jira source timestamp. Numeric epoch values are accepted
 * only when finite and positive; arbitrary strings are rejected.
 */
export function parseJiraTimestamp(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string' || !JIRA_TIMESTAMP_PATTERN.test(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function setWithTtlIfAvailable(key, value, ttlSeconds) {
  if (typeof kvsStore.setWithTtl === 'function') {
    await kvsStore.setWithTtl(key, value, ttlSeconds);
    return;
  }
  await kvsStore.set(key, value);
}

/**
 * Persist the hash of a write the connector just performed on a destination.
 * No issue content, description or field values are stored.
 */
export async function recordDestinationWrite({
  orgId = null,
  localKey,
  remoteKey = null,
  direction,
  observedSide,
  sourceUpdated = null,
  fieldHash,
  ttlSeconds = ECHO_MARKER_TTL_SECONDS,
  now = Date.now()
}) {
  if (!fieldHash) return null;
  const key = echoMarkerKey({ orgId, localKey, remoteKey, observedSide });
  const marker = {
    orgId: orgId === null || orgId === undefined ? null : String(orgId),
    localKey,
    remoteKey: remoteKey || null,
    direction,
    observedSide,
    sourceUpdated: sourceUpdated || null,
    fieldHash,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlSeconds * 1000).toISOString()
  };
  try {
    await setWithTtlIfAvailable(key, marker, ttlSeconds);
  } catch {
    console.warn(`Echo marker could not be stored for ${localKey}: storage unavailable`);
  }
  return marker;
}

export async function getDestinationWriteMarker({ orgId = null, localKey, remoteKey = null, observedSide }) {
  try {
    const marker = await kvsStore.get(echoMarkerKey({ orgId, localKey, remoteKey, observedSide }));
    if (!marker) return null;
    if (marker.expiresAt) {
      const expires = parseJiraTimestamp(marker.expiresAt);
      if (expires !== null && Date.now() > expires) return null;
    }
    return marker;
  } catch {
    return null;
  }
}

/**
 * A hash-only match against the connector's last write to this destination.
 * A genuine user edit changes the synchronized-field hash and is not skipped.
 */
export async function findAppCausedEcho({
  orgId = null,
  localKey,
  remoteKey = null,
  observedSide,
  fieldHash
}) {
  const marker = await getDestinationWriteMarker({ orgId, localKey, remoteKey, observedSide });
  if (!marker || !fieldHash || marker.fieldHash !== fieldHash) {
    return { echo: false, marker: null };
  }
  return { echo: true, marker };
}

export async function getLatestAccepted({ orgId = null, direction, localKey, remoteKey = null }) {
  try {
    return await kvsStore.get(latestAcceptedKey({ orgId, direction, localKey, remoteKey }));
  } catch {
    return null;
  }
}

/**
 * Advance the last accepted timestamp only after a successful destination
 * write. Timestamp-less events are processed but never recorded as ordering
 * evidence.
 */
export async function recordLatestAccepted({
  orgId = null,
  direction,
  localKey,
  remoteKey = null,
  sourceUpdated,
  fieldHash,
  now = Date.now()
}) {
  if (parseJiraTimestamp(sourceUpdated) === null) {
    return null;
  }
  const record = {
    orgId: orgId === null || orgId === undefined ? null : String(orgId),
    direction,
    localKey,
    remoteKey: remoteKey || null,
    sourceUpdated,
    fieldHash,
    appliedAt: new Date(now).toISOString()
  };
  try {
    await kvsStore.set(latestAcceptedKey({ orgId, direction, localKey, remoteKey }), record);
  } catch {
    console.warn(`Latest accepted timestamp could not be stored for ${localKey}`);
    return null;
  }
  return record;
}

/**
 * Compare an incoming source event with the latest successfully applied event
 * for the same mapping and direction.
 */
export function evaluateStaleEvent({ latest = null, sourceUpdated, fieldHash }) {
  const eventMs = parseJiraTimestamp(sourceUpdated);
  if (eventMs === null) {
    return { decision: 'unverified', status: 'SYNC_ORDER_UNVERIFIED' };
  }
  if (!latest) {
    return { decision: 'apply', status: 'NEWER' };
  }

  const latestMs = parseJiraTimestamp(latest.sourceUpdated);
  if (latestMs === null) {
    return { decision: 'unverified', status: 'SYNC_ORDER_UNVERIFIED' };
  }
  if (eventMs < latestMs) {
    return { decision: 'stale', status: 'SYNC_STALE_EVENT' };
  }
  if (eventMs === latestMs) {
    if (fieldHash && latest.fieldHash && latest.fieldHash === fieldHash) {
      return { decision: 'duplicate', status: 'DUPLICATE' };
    }
    return { decision: 'conflict', status: 'SYNC_CONFLICT_REVIEW_REQUIRED' };
  }
  return { decision: 'apply', status: 'NEWER' };
}

/**
 * Conservative destination-drift check. A conflict is reported only when the
 * destination no longer matches the connector's last write and the incoming
 * source content actually differs.
 */
export function detectDestinationConflict({ expectedDestinationHash, observedDestinationHash, sourceHash, lastSourceHash }) {
  if (!expectedDestinationHash || !observedDestinationHash) {
    return { conflict: false, reason: 'insufficient-evidence' };
  }
  if (expectedDestinationHash === observedDestinationHash) {
    return { conflict: false, reason: 'destination-matches-last-write' };
  }
  if (lastSourceHash && sourceHash === lastSourceHash) {
    return { conflict: false, reason: 'source-unchanged' };
  }
  return { conflict: true, reason: 'destination_changed_since_last_write' };
}

export async function recordConflict({
  orgId = null,
  localKey,
  remoteKey = null,
  direction = 'unknown',
  localTimestamp = null,
  remoteTimestamp = null,
  sourceHash = null,
  destinationHash = null,
  reason = 'ambiguous-write',
  ttlSeconds = CONFLICT_RECORD_TTL_SECONDS
}) {
  const record = buildConflictRecord({
    orgId,
    localKey,
    remoteKey,
    direction,
    localTimestamp,
    remoteTimestamp,
    sourceHash,
    destinationHash,
    reason
  });
  try {
    await setWithTtlIfAvailable(
      conflictRecordKey({ orgId, localKey, remoteKey }),
      record,
      ttlSeconds
    );
  } catch {
    console.warn(`Conflict record could not be stored for ${localKey}`);
  }
  await recordSyncDecision(record);
  return record;
}

export { SYNC_DECISIONS };
