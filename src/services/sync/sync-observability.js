import * as kvsStore from '../storage/kvs.js';
import { logAuditEntry } from '../storage/stats.js';

export const SYNC_DECISION_TTL_SECONDS = 7 * 24 * 60 * 60;

export const SYNC_DECISIONS = Object.freeze({
  APPLIED: 'applied',
  SKIPPED_ECHO: 'skipped_echo',
  SKIPPED_STALE: 'skipped_stale',
  SKIPPED_LOCKED: 'skipped_locked',
  DUPLICATE: 'duplicate',
  CONFLICT: 'conflict',
  AMBIGUOUS_WRITE: 'ambiguous_write',
  MAPPING_CONFLICT: 'mapping_conflict',
  FAILED: 'failed'
});

function orgScope(orgId) {
  return orgId === null || orgId === undefined || orgId === '' ? 'legacy' : String(orgId);
}

function decisionKey(record) {
  const local = record.localKey || 'unknown-local';
  const remote = record.remoteKey || 'unknown-remote';
  return `sync-decision:${orgScope(record.orgId)}:${local}:${remote}`;
}

/**
 * Store a content-free decision record. Only an explicit allow-list of safe
 * metadata is persisted or logged.
 */
export function sanitizeDecisionRecord(record = {}) {
  const safe = {};
  const allowed = [
    'decision', 'orgId', 'localKey', 'remoteKey', 'direction', 'operation',
    'sourceUpdated', 'destinationUpdated', 'fieldHash', 'destinationHash',
    'reason', 'statusCode'
  ];
  for (const key of allowed) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number' || value === null) {
      safe[key] = value;
    }
  }
  return safe;
}

export async function recordSyncDecision(record) {
  const safe = sanitizeDecisionRecord(record);
  console.log(`Sync decision: ${safe.decision || 'unknown'} (${safe.localKey || '?'} -> ${safe.remoteKey || '?'})`);
  try {
    if (typeof kvsStore.setWithTtl === 'function') {
      await kvsStore.setWithTtl(decisionKey(safe), safe, SYNC_DECISION_TTL_SECONDS);
    } else {
      await kvsStore.set(decisionKey(safe), safe);
    }
  } catch {
    console.warn('Sync decision record could not be stored');
  }

  // Reuse the existing bounded audit log for conflict visibility.
  if (safe.decision === SYNC_DECISIONS.CONFLICT || safe.decision === SYNC_DECISIONS.MAPPING_CONFLICT) {
    try {
      await logAuditEntry({
        action: 'sync-conflict',
        orgId: safe.orgId,
        sourceIssue: safe.localKey,
        targetIssue: safe.remoteKey,
        success: false,
        errors: [safe.reason || safe.decision]
      });
    } catch {
      // Observability must never fail synchronization.
    }
  }
  return safe;
}

export function buildConflictRecord({
  orgId = null,
  localKey,
  remoteKey = null,
  direction = 'unknown',
  localTimestamp = null,
  remoteTimestamp = null,
  sourceHash = null,
  destinationHash = null,
  reason = 'ambiguous-write'
}) {
  return sanitizeDecisionRecord({
    decision: SYNC_DECISIONS.CONFLICT,
    orgId,
    localKey,
    remoteKey,
    direction,
    sourceUpdated: localTimestamp,
    destinationUpdated: remoteTimestamp,
    fieldHash: sourceHash,
    destinationHash,
    reason
  });
}
