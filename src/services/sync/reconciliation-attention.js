import * as kvsStore from '../storage/kvs.js';
import { isValidIssueKey } from '../storage/mappings.js';

/**
 * Stable, per-source-issue attention records for recurring reconciliation.
 *
 * A record's key never changes. Resolving it preserves the history instead of
 * deleting the record. Acknowledging it only mutes administrator notifications;
 * the technical state remains open until a fresh health check resolves it.
 */
export const RECONCILIATION_ATTENTION_STATES = Object.freeze({
  OPEN: 'open',
  RESOLVED: 'resolved'
});

const ATTENTION_PREFIX = 'reconciliation-attention';
const ORG_ID_PATTERN = /^(?:org-[0-9]+|legacy)$/;
const REASON_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;

function scopeSegment(orgId) {
  return orgId === 'legacy' ? 'legacy' : orgId;
}

function normalizeOrgId(orgId) {
  if (typeof orgId !== 'string' || !ORG_ID_PATTERN.test(orgId)) {
    throw new Error('Invalid organization for reconciliation attention');
  }
  return orgId;
}

export function buildReconciliationAttentionKey(orgId, localKey) {
  if (!isValidIssueKey(localKey)) {
    throw new Error('Invalid issue key for reconciliation attention');
  }
  return `${ATTENTION_PREFIX}:${scopeSegment(normalizeOrgId(orgId))}:${localKey}`;
}

function attentionPrefix(orgId) {
  return `${ATTENTION_PREFIX}:${scopeSegment(normalizeOrgId(orgId))}:`;
}

function safeReason(value, fallback = 'UNSPECIFIED') {
  return typeof value === 'string' && REASON_PATTERN.test(value)
    ? value.slice(0, 80)
    : fallback;
}

function safeTimestamp(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function safeActor(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, 100)
    : null;
}

function safeCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function sanitizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!isValidIssueKey(value.localKey)) return null;
  const state = value.state === RECONCILIATION_ATTENTION_STATES.RESOLVED
    ? RECONCILIATION_ATTENTION_STATES.RESOLVED
    : RECONCILIATION_ATTENTION_STATES.OPEN;
  return {
    version: 1,
    orgId: normalizeOrgId(value.orgId),
    localKey: value.localKey,
    remoteKey: isValidIssueKey(value.remoteKey) ? value.remoteKey : null,
    state,
    reasonCode: safeReason(value.reasonCode),
    attempts: safeCounter(value.attempts),
    firstSeenAt: safeTimestamp(value.firstSeenAt),
    lastSeenAt: safeTimestamp(value.lastSeenAt),
    lastJobId: typeof value.lastJobId === 'string'
      ? value.lastJobId.slice(0, 100)
      : null,
    acknowledgedAt: safeTimestamp(value.acknowledgedAt),
    acknowledgedBy: safeActor(value.acknowledgedBy),
    resolvedAt: safeTimestamp(value.resolvedAt),
    resolvedBy: safeActor(value.resolvedBy),
    resolutionCode: safeReason(value.resolutionCode, 'UNSPECIFIED'),
    reviewCommentAt: safeTimestamp(value.reviewCommentAt),
    reviewCommentCount: safeCounter(value.reviewCommentCount),
    reopenCount: safeCounter(value.reopenCount)
  };
}

export async function getReconciliationAttention({ orgId, localKey } = {}) {
  const value = await kvsStore.get(buildReconciliationAttentionKey(orgId, localKey));
  return sanitizeRecord(value);
}

/**
 * Increment one stable attention record. A solved record is reopened as a new
 * episode, preserving the prior resolution timestamp and an episode counter.
 */
export async function recordReconciliationFailure({
  orgId,
  localKey,
  reasonCode,
  jobId = null,
  now = Date.now()
} = {}) {
  const key = buildReconciliationAttentionKey(orgId, localKey);
  const timestamp = new Date(now).toISOString();
  let existing = null;
  try {
    existing = sanitizeRecord(await kvsStore.get(key));
  } catch {
    return { success: false, code: 'RECONCILIATION_ATTENTION_STORAGE_ERROR' };
  }

  if (!existing) {
    const record = {
      version: 1,
      orgId,
      localKey,
      remoteKey: null,
      state: RECONCILIATION_ATTENTION_STATES.OPEN,
      reasonCode: safeReason(reasonCode),
      attempts: 1,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      lastJobId: jobId,
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      resolvedBy: null,
      resolutionCode: null,
      reviewCommentAt: null,
      reviewCommentCount: 0,
      reopenCount: 0
    };
    try {
      await kvsStore.set(key, record);
      return { success: true, record, reopened: false };
    } catch {
      return { success: false, code: 'RECONCILIATION_ATTENTION_STORAGE_ERROR' };
    }
  }

  const reopened = existing.state === RECONCILIATION_ATTENTION_STATES.RESOLVED;
  const next = {
    ...existing,
    state: RECONCILIATION_ATTENTION_STATES.OPEN,
    remoteKey: reopened ? null : existing.remoteKey,
    reasonCode: safeReason(reasonCode),
    attempts: reopened ? 1 : existing.attempts + 1,
    firstSeenAt: reopened ? timestamp : (existing.firstSeenAt || timestamp),
    lastSeenAt: timestamp,
    lastJobId: jobId,
    acknowledgedAt: reopened ? null : existing.acknowledgedAt,
    acknowledgedBy: reopened ? null : existing.acknowledgedBy,
    resolvedAt: reopened ? null : existing.resolvedAt,
    resolvedBy: reopened ? null : existing.resolvedBy,
    resolutionCode: reopened ? null : existing.resolutionCode,
    reviewCommentAt: reopened ? null : existing.reviewCommentAt,
    reviewCommentCount: reopened ? 0 : existing.reviewCommentCount,
    reopenCount: reopened ? existing.reopenCount + 1 : existing.reopenCount
  };
  try {
    await kvsStore.set(key, next);
    return { success: true, record: next, reopened };
  } catch {
    return { success: false, code: 'RECONCILIATION_ATTENTION_STORAGE_ERROR' };
  }
}

export async function markReconciliationAttentionResolved({
  orgId,
  localKey,
  remoteKey,
  actorAccountId = null,
  resolutionCode = 'HEALTH_CHECK_CONFIRMED',
  now = Date.now()
} = {}) {
  const key = buildReconciliationAttentionKey(orgId, localKey);
  let existing = null;
  try {
    existing = sanitizeRecord(await kvsStore.get(key));
  } catch {
    return { success: false, code: 'RECONCILIATION_ATTENTION_STORAGE_ERROR' };
  }
  if (!existing) {
    return { success: false, code: 'RECONCILIATION_ATTENTION_NOT_FOUND' };
  }
  if (existing.state === RECONCILIATION_ATTENTION_STATES.RESOLVED) {
    return { success: true, record: existing, idempotent: true };
  }
  if (remoteKey !== null && remoteKey !== undefined && !isValidIssueKey(remoteKey)) {
    return { success: false, code: 'RECONCILIATION_ATTENTION_INVALID_REMOTE_KEY' };
  }

  const timestamp = new Date(now).toISOString();
  const next = {
    ...existing,
    state: RECONCILIATION_ATTENTION_STATES.RESOLVED,
    remoteKey: isValidIssueKey(remoteKey) ? remoteKey : existing.remoteKey,
    resolvedAt: timestamp,
    resolvedBy: safeActor(actorAccountId),
    resolutionCode: safeReason(resolutionCode, 'HEALTH_CHECK_CONFIRMED')
  };
  try {
    await kvsStore.set(key, next);
    return { success: true, record: next };
  } catch {
    return { success: false, code: 'RECONCILIATION_ATTENTION_STORAGE_ERROR' };
  }
}

/**
 * Acknowledge only silences notifications. attempts, reasonCode and state stay
 * open so the technical reconciliation problem remains visible.
 */
export async function acknowledgeReconciliationAttention({
  orgId,
  localKey,
  actorAccountId = null,
  now = Date.now()
} = {}) {
  const key = buildReconciliationAttentionKey(orgId, localKey);
  let existing = null;
  try {
    existing = sanitizeRecord(await kvsStore.get(key));
  } catch {
    return { success: false, code: 'RECONCILIATION_ATTENTION_STORAGE_ERROR' };
  }
  if (!existing) {
    return { success: false, code: 'RECONCILIATION_ATTENTION_NOT_FOUND' };
  }
  if (existing.state === RECONCILIATION_ATTENTION_STATES.RESOLVED) {
    return { success: false, code: 'RECONCILIATION_ATTENTION_RESOLVED' };
  }
  if (existing.acknowledgedAt) {
    return { success: true, record: existing, idempotent: true };
  }

  const next = {
    ...existing,
    acknowledgedAt: new Date(now).toISOString(),
    acknowledgedBy: safeActor(actorAccountId)
  };
  try {
    await kvsStore.set(key, next);
    return { success: true, record: next };
  } catch {
    return { success: false, code: 'RECONCILIATION_ATTENTION_STORAGE_ERROR' };
  }
}

export async function markReconciliationReviewComment({
  orgId,
  localKey,
  now = Date.now()
} = {}) {
  const key = buildReconciliationAttentionKey(orgId, localKey);
  let existing = null;
  try {
    existing = sanitizeRecord(await kvsStore.get(key));
  } catch {
    return { success: false, code: 'RECONCILIATION_ATTENTION_STORAGE_ERROR' };
  }
  if (!existing || existing.state !== RECONCILIATION_ATTENTION_STATES.OPEN) {
    return { success: false, code: 'RECONCILIATION_ATTENTION_NOT_OPEN' };
  }
  const next = {
    ...existing,
    reviewCommentAt: new Date(now).toISOString(),
    reviewCommentCount: existing.reviewCommentCount + 1
  };
  try {
    await kvsStore.set(key, next);
    return { success: true, record: next };
  } catch {
    return { success: false, code: 'RECONCILIATION_ATTENTION_STORAGE_ERROR' };
  }
}

export function reconciliationAttentionNeedsNotification(record, threshold = 3) {
  if (!record || record.state !== RECONCILIATION_ATTENTION_STATES.OPEN) {
    return false;
  }
  if (record.acknowledgedAt) {
    return false;
  }
  return record.attempts >= Math.max(1, Number(threshold) || 1);
}

export async function listReconciliationAttention(orgId) {
  const normalizedOrgId = normalizeOrgId(orgId);
  if (typeof kvsStore.queryByPrefix !== 'function') {
    return [];
  }
  const prefix = attentionPrefix(normalizedOrgId);
  const entries = await kvsStore.queryByPrefix(prefix, 1000);
  return entries
    .filter(entry => entry && typeof entry.key === 'string'
      && entry.key.startsWith(prefix))
    .map(entry => sanitizeRecord(entry.value))
    .filter(Boolean)
    .sort((left, right) => {
      const leftTime = Date.parse(left.lastSeenAt || '') || 0;
      const rightTime = Date.parse(right.lastSeenAt || '') || 0;
      return rightTime - leftTime;
    });
}

export function summarizeReconciliationAttention(records, threshold = 3) {
  const items = Array.isArray(records) ? records : [];
  const open = items.filter(record =>
    record.state === RECONCILIATION_ATTENTION_STATES.OPEN);
  return {
    total: items.length,
    open: open.length,
    acknowledged: open.filter(record => Boolean(record.acknowledgedAt)).length,
    notificationRequired: open.filter(record =>
      reconciliationAttentionNeedsNotification(record, threshold)).length,
    resolved: items.filter(record =>
      record.state === RECONCILIATION_ATTENTION_STATES.RESOLVED).length
  };
}
