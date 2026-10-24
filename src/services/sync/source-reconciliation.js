import { randomBytes } from 'crypto';
import { Queue } from '@forge/events';
import * as kvsStore from '../storage/kvs.js';
import {
  getOrganizationsWithTokens,
  getRemoteKey,
  getLocalKey,
  isValidIssueKey
} from '../storage/mappings.js';
import {
  INITIAL_SYNC_QUEUE_KEY,
  INITIAL_SYNC_MAX_ITEMS_PER_EVENT,
  previewReconciliationCandidates,
  processReconciliationCandidate
} from './initial-sync.js';
import {
  getReconciliationSettings,
  saveReconciliationSettings,
  reconciliationIntervalMs
} from './reconciliation-settings.js';
import {
  RECONCILIATION_ATTENTION_STATES,
  acknowledgeReconciliationAttention,
  getReconciliationAttention,
  listReconciliationAttention,
  markReconciliationAttentionResolved,
  markReconciliationReviewComment,
  recordReconciliationFailure,
  reconciliationAttentionNeedsNotification,
  summarizeReconciliationAttention
} from './reconciliation-attention.js';
import { getPilotPause } from './pilot-pause.js';
import { addLocalIssueComment, probeLocalIssue } from '../jira/local-client.js';
import { probeRemoteIssue } from '../jira/remote-client.js';
import { buildReconciliationReviewCommentADF } from '../../utils/adf.js';
import { isKeyConflictError } from '../../utils/storage-errors.js';

/**
 * Recurring LOCAL-TO-REMOTE SOURCE RECONCILIATION.
 *
 * Only the configured local Jira scope is scanned. Remote Jira is never scanned
 * and this is not full bidirectional reconciliation. Each opt-in run reuses the
 * safe initial-sync preview/classification and create operation, persists a
 * cursor, and advances nextRunAt only after the attempt reaches a terminal state.
 */
export const RECONCILIATION_QUEUE_JOB_TYPE = 'reconciliation';
export const RECONCILIATION_JOB_PREFIX = 'reconciliationJob:';
export const RECONCILIATION_SCHEDULE_PREFIX = 'reconciliationSchedule:';
export const RECONCILIATION_LOCK_PREFIX = 'reconciliationLock:';
export const RECONCILIATION_RECOVERY_AGE_MS = 2 * 60 * 1000;
export const RECONCILIATION_PROCESSING_LEASE_SECONDS = 15 * 60;

export const RECONCILIATION_STATES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  DEFERRED: 'deferred'
});

export const RECONCILIATION_ACTIVE_STATES = Object.freeze([
  RECONCILIATION_STATES.QUEUED,
  RECONCILIATION_STATES.RUNNING
]);

export const RECONCILIATION_OUTCOMES = Object.freeze({
  SUCCESS: 'success',
  ATTENTION_REQUIRED: 'attention_required',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  DEFERRED: 'deferred'
});

export const RECONCILIATION_REASONS = Object.freeze({
  SCHEDULE_DUE: 'SCHEDULE_DUE',
  RECOVERY_REQUEUE: 'RECOVERY_REQUEUE',
  SCHEDULED: 'SCHEDULED',
  RECURRING_DISABLED: 'RECURRING_DISABLED',
  GLOBAL_PAUSE_ACTIVE: 'GLOBAL_PAUSE_ACTIVE',
  QUEUE_ENQUEUE_FAILED: 'QUEUE_ENQUEUE_FAILED',
  PREVIEW_FAILED: 'PREVIEW_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  LEASE_LOST: 'LEASE_LOST',
  LEASE_STORAGE_ERROR: 'LEASE_STORAGE_ERROR'
});

const ORG_ID_PATTERN = /^(?:org-[0-9]+|legacy)$/;
const SAFE_REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function normalizeOrgId(orgId) {
  if (typeof orgId !== 'string' || !ORG_ID_PATTERN.test(orgId)) {
    const error = new Error('A valid organization is required.');
    error.code = 'RECONCILIATION_INVALID_ORGANIZATION';
    throw error;
  }
  return orgId;
}

function scopeSegment(orgId) {
  return orgId === 'legacy' ? 'legacy' : orgId;
}

export function buildReconciliationJobKey(orgId) {
  return `${RECONCILIATION_JOB_PREFIX}${scopeSegment(normalizeOrgId(orgId))}`;
}

export function buildReconciliationScheduleKey(orgId) {
  return `${RECONCILIATION_SCHEDULE_PREFIX}${scopeSegment(normalizeOrgId(orgId))}`;
}

function buildReconciliationLockKey(orgId) {
  return `${RECONCILIATION_LOCK_PREFIX}${scopeSegment(normalizeOrgId(orgId))}`;
}

function isActiveJob(job) {
  return Boolean(job) && RECONCILIATION_ACTIVE_STATES.includes(job.state);
}

function safeReason(value, fallback = RECONCILIATION_REASONS.INTERNAL_ERROR) {
  return typeof value === 'string' && SAFE_REASON_PATTERN.test(value)
    ? value
    : fallback;
}

function safeTimestamp(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeCounts(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  return {
    discovered: safeCount(input.discovered),
    eligible: safeCount(input.eligible),
    created: safeCount(input.created),
    updated: safeCount(input.updated),
    alreadyMapped: safeCount(input.alreadyMapped),
    skipped: safeCount(input.skipped),
    reconciliationRequired: safeCount(input.reconciliationRequired),
    failed: safeCount(input.failed),
    blocked: safeCount(input.blocked),
    mappingConflicts: safeCount(input.mappingConflicts),
    attended: safeCount(input.attended),
    cancelled: safeCount(input.cancelled)
  };
}

function safeJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    return null;
  }
  return {
    version: 1,
    jobId: job.jobId,
    type: RECONCILIATION_QUEUE_JOB_TYPE,
    orgId: job.orgId,
    state: job.state,
    createdAt: safeTimestamp(job.createdAt),
    updatedAt: safeTimestamp(job.updatedAt),
    scheduledFor: safeTimestamp(job.scheduledFor),
    startedAt: safeTimestamp(job.startedAt),
    completedAt: safeTimestamp(job.completedAt),
    failedAt: safeTimestamp(job.failedAt),
    cancelledAt: safeTimestamp(job.cancelledAt),
    lastAttemptedKey: typeof job.lastAttemptedKey === 'string'
      ? job.lastAttemptedKey
      : null,
    previewChecksum: typeof job.previewChecksum === 'string'
      ? job.previewChecksum
      : null,
    configurationChecksum: typeof job.configurationChecksum === 'string'
      ? job.configurationChecksum
      : null,
    counts: safeCounts(job.counts),
    progress: {
      total: safeCount(job.progress?.total),
      processed: safeCount(job.progress?.processed),
      remaining: safeCount(job.progress?.remaining)
    },
    outcome: typeof job.outcome === 'string' ? job.outcome : null,
    reasonCode: job.reasonCode ? safeReason(job.reasonCode) : null,
    trigger: job.trigger === 'recovery' ? 'recovery' : 'schedule'
  };
}

function safeSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    return {
      version: 1,
      nextRunAt: null,
      lastCompletedAt: null,
      lastOutcome: null,
      lastJobId: null,
      consecutiveFailures: 0,
      lastCounts: safeCounts(null)
    };
  }
  return {
    version: 1,
    nextRunAt: safeTimestamp(schedule.nextRunAt),
    lastCompletedAt: safeTimestamp(schedule.lastCompletedAt),
    lastOutcome: typeof schedule.lastOutcome === 'string'
      ? schedule.lastOutcome
      : null,
    lastJobId: typeof schedule.lastJobId === 'string'
      ? schedule.lastJobId
      : null,
    consecutiveFailures: safeCount(schedule.consecutiveFailures),
    lastCounts: safeCounts(schedule.lastCounts)
  };
}

async function loadRawReconciliationJob(orgId) {
  const normalizedOrgId = normalizeOrgId(orgId);
  const stored = await kvsStore.get(buildReconciliationJobKey(normalizedOrgId));
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)
      || stored.orgId !== normalizedOrgId) {
    return null;
  }
  return stored;
}

export async function getReconciliationJob(orgId) {
  return safeJob(await loadRawReconciliationJob(orgId));
}

export async function getReconciliationSchedule(orgId) {
  const normalizedOrgId = normalizeOrgId(orgId);
  const stored = await kvsStore.get(buildReconciliationScheduleKey(normalizedOrgId));
  return safeSchedule(stored);
}

function newJobId(now = Date.now()) {
  return `reconciliation-${now}-${randomBytes(8).toString('hex')}`;
}

async function acquireReconciliationLease({ orgId, jobId, now = Date.now() } = {}) {
  const normalizedOrgId = normalizeOrgId(orgId);
  if (typeof jobId !== 'string' || !jobId
      || typeof kvsStore.setIfNotExists !== 'function') {
    return { acquired: false, status: 'LEASE_STORAGE_ERROR' };
  }
  const key = buildReconciliationLockKey(normalizedOrgId);
  const leaseToken = randomBytes(32).toString('hex');
  const acquiredAt = new Date(now).toISOString();
  const expiresAt = new Date(
    now + RECONCILIATION_PROCESSING_LEASE_SECONDS * 1000
  ).toISOString();
  try {
    await kvsStore.setIfNotExists(
      key,
      { jobId, leaseToken, acquiredAt, expiresAt },
      RECONCILIATION_PROCESSING_LEASE_SECONDS
    );
    return { acquired: true, status: 'ACQUIRED', key, jobId, leaseToken };
  } catch (error) {
    if (isKeyConflictError(error)) {
      return { acquired: false, status: 'LEASE_CONTENDED' };
    }
    return { acquired: false, status: 'LEASE_STORAGE_ERROR' };
  }
}

async function verifyReconciliationLease(lease) {
  if (!lease || typeof lease.key !== 'string'
      || typeof lease.jobId !== 'string'
      || typeof lease.leaseToken !== 'string') {
    return { owned: false, status: 'LEASE_LOST' };
  }
  try {
    const current = await kvsStore.get(lease.key);
    if (!current || current.jobId !== lease.jobId
        || current.leaseToken !== lease.leaseToken) {
      return { owned: false, status: 'LEASE_LOST' };
    }
    return { owned: true, status: 'OWNED' };
  } catch {
    return { owned: false, status: 'LEASE_STORAGE_ERROR' };
  }
}

async function releaseReconciliationLease(lease) {
  const ownership = await verifyReconciliationLease(lease);
  if (!ownership.owned) {
    return { released: false, status: ownership.status };
  }
  try {
    await kvsStore.del(lease.key);
    return { released: true, status: 'RELEASED' };
  } catch {
    return { released: false, status: 'LEASE_STORAGE_ERROR' };
  }
}

async function enqueueReconciliation(orgId, jobId) {
  const queue = new Queue({ key: INITIAL_SYNC_QUEUE_KEY });
  await queue.push({
    body: {
      type: RECONCILIATION_QUEUE_JOB_TYPE,
      orgId,
      jobId
    }
  });
}



function isTerminalJob(job) {
  return Boolean(job) && [
    RECONCILIATION_STATES.COMPLETED,
    RECONCILIATION_STATES.FAILED,
    RECONCILIATION_STATES.CANCELLED
  ].includes(job.state);
}

/**
 * The only place a future nextRunAt is written. It must be called only after a
 * run completes, fails definitively, or is cancelled. Deferred runs and queue
 * enqueues deliberately do not call this function.
 */
async function finalizeReconciliationSchedule({ orgId, job, now = Date.now() } = {}) {
  if (!isTerminalJob(job)) {
    return null;
  }
  const settings = await getReconciliationSettings(orgId);
  const previous = await getReconciliationSchedule(orgId);
  const nextRunAt = settings.recurringReconciliationEnabled
    ? new Date(now + reconciliationIntervalMs(settings)).toISOString()
    : null;
  const failed = job.state === RECONCILIATION_STATES.FAILED;
  const next = {
    version: 1,
    orgId,
    nextRunAt,
    lastCompletedAt: new Date(now).toISOString(),
    lastOutcome: job.state === RECONCILIATION_STATES.CANCELLED
      ? RECONCILIATION_OUTCOMES.CANCELLED
      : failed
        ? RECONCILIATION_OUTCOMES.FAILED
        : (job.outcome || RECONCILIATION_OUTCOMES.SUCCESS),
    lastJobId: job.jobId,
    consecutiveFailures: failed ? previous.consecutiveFailures + 1 : 0,
    lastCounts: safeCounts(job.counts)
  };
  await kvsStore.set(buildReconciliationScheduleKey(orgId), next);
  return safeSchedule(next);
}

async function listConfiguredOrganizations() {
  const organizations = await kvsStore.get('organizations');
  const ids = Array.isArray(organizations)
    ? organizations
      .map(org => org?.id)
      .filter(id => typeof id === 'string' && ORG_ID_PATTERN.test(id))
    : [];
  if (ids.length > 0) {
    return [...new Set(ids)];
  }
  const legacy = await kvsStore.get('syncConfig');
  return legacy && legacy.remoteUrl ? ['legacy'] : [];
}

async function cancelJobForDisabledSetting(orgId, job, now = Date.now()) {
  if (!isActiveJob(job)) {
    return null;
  }
  const timestamp = new Date(now).toISOString();
  const next = {
    ...job,
    state: RECONCILIATION_STATES.CANCELLED,
    reasonCode: RECONCILIATION_REASONS.RECURRING_DISABLED,
    cancelledAt: timestamp,
    updatedAt: timestamp,
    outcome: RECONCILIATION_OUTCOMES.CANCELLED
  };
  await kvsStore.set(buildReconciliationJobKey(orgId), next);
  await finalizeReconciliationSchedule({ orgId, job: next, now });
  return safeJob(next);
}

/**
 * Called by the existing hourly initial-sync recovery trigger. It only creates
 * one queued reconciliation job per due organization and never advances the
 * schedule at enqueue time.
 */
export async function runDueReconciliations({ now = Date.now() } = {}) {
  const result = {
    success: true,
    organizations: 0,
    scheduled: 0,
    recovered: 0,
    cancelled: 0,
    deferred: 0
  };

  let pause;
  try {
    pause = await getPilotPause();
  } catch {
    result.success = false;
    return result;
  }
  if (pause.paused) {
    result.deferred = 1;
    return result;
  }

  let orgIds = [];
  try {
    orgIds = await listConfiguredOrganizations();
  } catch {
    result.success = false;
    return result;
  }
  result.organizations = orgIds.length;

  for (const orgId of orgIds) {
    try {
      const settings = await getReconciliationSettings(orgId);
      const existingJob = await loadRawReconciliationJob(orgId);

      if (!settings.recurringReconciliationEnabled) {
        if (isActiveJob(existingJob)) {
          await cancelJobForDisabledSetting(orgId, existingJob, now);
          result.cancelled += 1;
        }
        continue;
      }

      if (isActiveJob(existingJob)) {
        const updatedAt = Date.parse(existingJob.updatedAt || '');
        if (Number.isFinite(updatedAt)
            && now - updatedAt >= RECONCILIATION_RECOVERY_AGE_MS) {
          const recoveredJob = {
            ...existingJob,
            trigger: 'recovery',
            updatedAt: new Date(now).toISOString()
          };
          await kvsStore.set(buildReconciliationJobKey(orgId), recoveredJob);
          try {
            await enqueueReconciliation(orgId, existingJob.jobId);
            result.recovered += 1;
          } catch {
            await kvsStore.set(buildReconciliationJobKey(orgId), {
              ...recoveredJob,
              reasonCode: RECONCILIATION_REASONS.QUEUE_ENQUEUE_FAILED
            });
          }
        }
        continue;
      }

      const schedule = await getReconciliationSchedule(orgId);
      const nextRun = schedule.nextRunAt ? Date.parse(schedule.nextRunAt) : null;
      if (Number.isFinite(nextRun) && nextRun > now) {
        continue;
      }

      const timestamp = new Date(now).toISOString();
      const job = {
        version: 1,
        jobId: newJobId(now),
        type: RECONCILIATION_QUEUE_JOB_TYPE,
        orgId,
        state: RECONCILIATION_STATES.QUEUED,
        trigger: 'schedule',
        createdAt: timestamp,
        updatedAt: timestamp,
        scheduledFor: schedule.nextRunAt || timestamp,
        startedAt: null,
        completedAt: null,
        failedAt: null,
        cancelledAt: null,
        previewChecksum: null,
        configurationChecksum: null,
        counts: safeCounts(null),
        progress: { total: 0, processed: 0, remaining: 0 },
        attemptedKeys: [],
        lastAttemptedKey: null,
        outcome: null,
        reasonCode: RECONCILIATION_REASONS.SCHEDULE_DUE
      };
      await kvsStore.set(buildReconciliationJobKey(orgId), job);

      try {
        await enqueueReconciliation(orgId, job.jobId);
        result.scheduled += 1;
      } catch {
        const failed = {
          ...job,
          state: RECONCILIATION_STATES.FAILED,
          reasonCode: RECONCILIATION_REASONS.QUEUE_ENQUEUE_FAILED,
          outcome: RECONCILIATION_OUTCOMES.FAILED,
          failedAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString()
        };
        await kvsStore.set(buildReconciliationJobKey(orgId), failed);
        // Deliberately no schedule write. The enqueue never reached a worker,
        // so no source candidate was processed and the run remains due for the
        // next hourly heartbeat.
      }
    } catch {
      // One organization must not prevent the other organizations from being
      // scheduled. The schedule remains due for the next hourly heartbeat.
    }
  }

  return result;
}


function applyCandidateOutcome(job, outcome) {
  const next = {
    ...job,
    counts: safeCounts(job.counts),
    progress: {
      total: safeCount(job.progress?.total),
      processed: safeCount(job.progress?.processed),
      remaining: safeCount(job.progress?.remaining)
    }
  };
  const reasonCode = safeReason(outcome?.reasonCode, 'UNSPECIFIED');
  if (outcome?.outcome === 'created') {
    next.counts.created += 1;
  } else if (outcome?.outcome === 'updated') {
    next.counts.updated += 1;
  } else if (outcome?.outcome === 'reconciliation') {
    next.counts.reconciliationRequired += 1;
    next.counts.attended += 1;
  } else if (outcome?.outcome === 'failed') {
    next.counts.failed += 1;
    next.counts.attended += 1;
  } else if (outcome?.outcome === 'skipped'
      && (reasonCode === 'ALREADY_MAPPED' || reasonCode === 'ALREADY_CURRENT')) {
    next.counts.alreadyMapped += 1;
  } else {
    next.counts.skipped += 1;
    next.counts.attended += 1;
  }
  next.progress.processed += 1;
  next.progress.total = Math.max(next.progress.total, next.progress.processed);
  next.progress.remaining = Math.max(0, next.progress.total - next.progress.processed);
  next.lastAttemptedKey = typeof outcome?.issueKey === 'string'
    ? outcome.issueKey
    : null;
  next.updatedAt = new Date().toISOString();
  return next;
}

async function resolveAttentionAfterSuccess({ orgId, issueKey } = {}) {
  try {
    const remoteKey = await getRemoteKey(issueKey, orgId === 'legacy' ? null : orgId);
    return await markReconciliationAttentionResolved({
      orgId,
      localKey: issueKey,
      remoteKey: isValidIssueKey(remoteKey) ? remoteKey : null,
      resolutionCode: 'SOURCE_RECONCILED'
    });
  } catch {
    return { success: false, code: 'RECONCILIATION_ATTENTION_STORAGE_ERROR' };
  }
}

async function recordAttentionAfterFailure({
  orgId,
  issueKey,
  reasonCode,
  jobId,
  settings
} = {}) {
  const recorded = await recordReconciliationFailure({
    orgId,
    localKey: issueKey,
    reasonCode,
    jobId
  });
  if (!recorded.success) {
    return recorded;
  }
  const record = recorded.record;
  if (settings.reconciliationCommentOnReview
      && !record.reviewCommentAt
      && !record.acknowledgedAt
      && reconciliationAttentionNeedsNotification(
        record,
        settings.reconciliationFailureThreshold
      )) {
    const comment = await addLocalIssueComment(
      issueKey,
      buildReconciliationReviewCommentADF({
        localKey: issueKey,
        reasonCode: record.reasonCode,
        attempts: record.attempts
      })
    );
    if (comment.success) {
      await markReconciliationReviewComment({ orgId, localKey: issueKey });
    }
  }
  return recorded;
}

async function applyAttentionOutcome({
  orgId,
  job,
  outcome,
  settings
} = {}) {
  const issueKey = outcome?.issueKey;
  if (!isValidIssueKey(issueKey)) {
    return;
  }
  const reasonCode = safeReason(outcome?.reasonCode, 'UNSPECIFIED');
  if (outcome?.outcome === 'created'
      || outcome?.outcome === 'updated'
      || (outcome?.outcome === 'skipped'
        && (reasonCode === 'ALREADY_MAPPED' || reasonCode === 'ALREADY_CURRENT'))) {
    await resolveAttentionAfterSuccess({ orgId, issueKey });
    return;
  }
  if (outcome?.outcome === 'global_pause') {
    return;
  }
  await recordAttentionAfterFailure({
    orgId,
    issueKey,
    reasonCode,
    jobId: job.jobId,
    settings
  });
}

function completeReconciliationJob(job) {
  const timestamp = new Date().toISOString();
  const attentionRequired = job.counts.failed > 0
    || job.counts.reconciliationRequired > 0
    || job.counts.skipped > 0;
  return {
    ...job,
    state: RECONCILIATION_STATES.COMPLETED,
    outcome: attentionRequired
      ? RECONCILIATION_OUTCOMES.ATTENTION_REQUIRED
      : RECONCILIATION_OUTCOMES.SUCCESS,
    reasonCode: null,
    completedAt: timestamp,
    updatedAt: timestamp,
    progress: {
      ...job.progress,
      processed: Math.max(job.progress.processed, job.progress.total),
      total: Math.max(job.progress.processed, job.progress.total),
      remaining: 0
    }
  };
}

async function failReconciliationJob({
  orgId,
  job,
  code,
  lease,
  now = Date.now(),
  advanceSchedule = true
} = {}) {
  if (!job) {
    return null;
  }
  const ownership = await verifyReconciliationLease(lease);
  if (!ownership.owned) {
    return null;
  }
  const timestamp = new Date(now).toISOString();
  const failed = {
    ...job,
    state: RECONCILIATION_STATES.FAILED,
    outcome: RECONCILIATION_OUTCOMES.FAILED,
    reasonCode: safeReason(code),
    failedAt: timestamp,
    updatedAt: timestamp
  };
  await kvsStore.set(buildReconciliationJobKey(orgId), failed);
  if (advanceSchedule) {
    await finalizeReconciliationSchedule({ orgId, job: failed, now });
  }
  return failed;
}

async function deferReconciliationJob({ orgId, job, code, lease, now = Date.now() } = {}) {
  if (!job) {
    return null;
  }
  const ownership = await verifyReconciliationLease(lease);
  if (!ownership.owned) {
    return null;
  }
  const timestamp = new Date(now).toISOString();
  const deferred = {
    ...job,
    state: RECONCILIATION_STATES.DEFERRED,
    outcome: RECONCILIATION_OUTCOMES.DEFERRED,
    reasonCode: safeReason(code, RECONCILIATION_REASONS.GLOBAL_PAUSE_ACTIVE),
    updatedAt: timestamp
  };
  await kvsStore.set(buildReconciliationJobKey(orgId), deferred);
  // Deliberately no schedule write: a deferred run did not complete, fail
  // definitively, or get cancelled, so nextRunAt remains due.
  return deferred;
}


/**
 * Bounded reconciliation worker. It is invoked from the existing initial-sync
 * queue consumer when the event body type is "reconciliation". Re-previewing on
 * every invocation naturally observes mapping and configuration changes while
 * attemptedKeys prevents an issue from retrying forever inside one cycle.
 */
export async function processReconciliationJob({
  orgId,
  jobId,
  maxItems = INITIAL_SYNC_MAX_ITEMS_PER_EVENT,
  now = Date.now()
} = {}) {
  let normalizedOrgId;
  try {
    normalizedOrgId = normalizeOrgId(orgId);
  } catch (error) {
    return { success: false, code: 'RECONCILIATION_INVALID_ORGANIZATION', processed: 0 };
  }
  if (typeof jobId !== 'string' || !jobId) {
    return { success: false, code: 'RECONCILIATION_INVALID_JOB', processed: 0 };
  }

  let lease;
  try {
    lease = await acquireReconciliationLease({
      orgId: normalizedOrgId,
      jobId,
      now
    });
  } catch {
    return { success: false, code: RECONCILIATION_REASONS.LEASE_STORAGE_ERROR, processed: 0 };
  }
  if (!lease.acquired) {
    if (lease.status === 'LEASE_STORAGE_ERROR') {
      return { success: false, code: RECONCILIATION_REASONS.LEASE_STORAGE_ERROR, processed: 0 };
    }
    return { success: true, code: 'RECONCILIATION_JOB_LOCKED', processed: 0 };
  }

  let job = null;
  let processedThisRun = 0;
  try {
    const settings = await getReconciliationSettings(normalizedOrgId);
    job = await loadRawReconciliationJob(normalizedOrgId);
    if (!job || job.jobId !== jobId) {
      return { success: false, code: 'RECONCILIATION_JOB_NOT_FOUND', processed: 0 };
    }
    if (isTerminalJob(job) || job.state === RECONCILIATION_STATES.DEFERRED) {
      return { success: true, state: job.state, processed: 0 };
    }

    if (!settings.recurringReconciliationEnabled) {
      const cancelled = await cancelJobForDisabledSetting(normalizedOrgId, job, now);
      return { success: true, state: cancelled?.state || RECONCILIATION_STATES.CANCELLED };
    }

    const pause = await getPilotPause();
    if (pause.paused) {
      const deferred = await deferReconciliationJob({
        orgId: normalizedOrgId,
        job,
        code: RECONCILIATION_REASONS.GLOBAL_PAUSE_ACTIVE,
        lease,
        now
      });
      return {
        success: true,
        state: deferred?.state || RECONCILIATION_STATES.DEFERRED,
        code: RECONCILIATION_REASONS.GLOBAL_PAUSE_ACTIVE,
        processed: 0
      };
    }

    if (job.state === RECONCILIATION_STATES.QUEUED) {
      job = {
        ...job,
        state: RECONCILIATION_STATES.RUNNING,
        startedAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        reasonCode: null
      };
      await kvsStore.set(buildReconciliationJobKey(normalizedOrgId), job);
    }

    const ownershipBeforePreview = await verifyReconciliationLease(lease);
    if (!ownershipBeforePreview.owned) {
      return {
        success: false,
        code: ownershipBeforePreview.status === 'LEASE_STORAGE_ERROR'
          ? RECONCILIATION_REASONS.LEASE_STORAGE_ERROR
          : RECONCILIATION_REASONS.LEASE_LOST,
        processed: 0
      };
    }

    const previewResult = await previewReconciliationCandidates({
      orgId: normalizedOrgId
    });
    if (!previewResult.success || !previewResult.preview) {
      await failReconciliationJob({
        orgId: normalizedOrgId,
        job,
        code: previewResult.code || RECONCILIATION_REASONS.PREVIEW_FAILED,
        lease,
        now
      });
      return {
        success: false,
        code: previewResult.code || RECONCILIATION_REASONS.PREVIEW_FAILED,
        processed: 0
      };
    }

    const preview = previewResult.preview;
    const previewOwnership = await verifyReconciliationLease(lease);
    if (!previewOwnership.owned) {
      return {
        success: false,
        code: previewOwnership.status === 'LEASE_STORAGE_ERROR'
          ? RECONCILIATION_REASONS.LEASE_STORAGE_ERROR
          : RECONCILIATION_REASONS.LEASE_LOST,
        processed: 0
      };
    }
    const eligible = Array.isArray(preview.classification?.eligible?.issueKeys)
      ? preview.classification.eligible.issueKeys.filter(isValidIssueKey)
      : [];
    const reconciliationCandidates = Array.isArray(
      preview.classification?.reconciliationCandidates?.issueKeys
    )
      ? preview.classification.reconciliationCandidates.issueKeys.filter(isValidIssueKey)
      : (Array.isArray(preview.reconciliation?.candidateKeys)
        ? preview.reconciliation.candidateKeys.filter(isValidIssueKey)
        : eligible);
    const mappedCurrent = Array.isArray(preview.classification?.mappedCurrent?.issueKeys)
      ? preview.classification.mappedCurrent.issueKeys.filter(isValidIssueKey)
      : [];
    if (reconciliationCandidates.length > 0 && !preview.org?.remoteApiToken) {
      await failReconciliationJob({
        orgId: normalizedOrgId,
        job,
        code: 'CREDENTIAL_MISSING',
        lease,
        now
      });
      return { success: false, code: 'CREDENTIAL_MISSING', processed: 0 };
    }

    const attempted = new Set(
      Array.isArray(job.attemptedKeys) ? job.attemptedKeys.filter(isValidIssueKey) : []
    );
    const candidates = reconciliationCandidates.filter(issueKey => !attempted.has(issueKey));
    job = {
      ...job,
      previewChecksum: preview.previewChecksum || null,
      configurationChecksum: preview.configurationChecksum || null,
      counts: {
        ...safeCounts(job.counts),
        discovered: safeCount(preview.totalIssues),
        eligible: Math.max(safeCount(job.counts?.eligible), reconciliationCandidates.length),
        alreadyMapped: Math.max(safeCount(job.counts?.alreadyMapped), mappedCurrent.length),
        blocked: safeCount(preview.counts?.blockedByValidation),
        mappingConflicts: safeCount(preview.counts?.mappingConflicts)
      },
      progress: {
        total: safeCount(job.progress?.processed) + candidates.length,
        processed: safeCount(job.progress?.processed),
        remaining: candidates.length
      },
      updatedAt: new Date(now).toISOString()
    };

    if (candidates.length === 0) {
      const completed = completeReconciliationJob(job);
      await kvsStore.set(buildReconciliationJobKey(normalizedOrgId), completed);
      await finalizeReconciliationSchedule({
        orgId: normalizedOrgId,
        job: completed,
        now
      });
      return {
        success: true,
        state: completed.state,
        outcome: completed.outcome,
        processed: 0,
        counts: safeCounts(completed.counts)
      };
    }

    const limit = Math.max(
      1,
      Math.min(
        Number(maxItems) || INITIAL_SYNC_MAX_ITEMS_PER_EVENT,
        INITIAL_SYNC_MAX_ITEMS_PER_EVENT
      )
    );



    while (processedThisRun < limit && candidates.length > 0) {
      const ownership = await verifyReconciliationLease(lease);
      if (!ownership.owned) {
        return {
          success: false,
          code: ownership.status === 'LEASE_STORAGE_ERROR'
            ? RECONCILIATION_REASONS.LEASE_STORAGE_ERROR
            : RECONCILIATION_REASONS.LEASE_LOST,
          processed: processedThisRun
        };
      }

      const issueKey = candidates.shift();
      const outcome = await processReconciliationCandidate({
        orgId: normalizedOrgId,
        org: preview.org,
        configuration: preview.configuration,
        issueKey
      });

      if (['OUTBOUND_SCOPE_BLOCKED', 'OUTBOUND_SCOPE_UNVERIFIABLE'].includes(outcome?.reasonCode)) {
        await failReconciliationJob({ orgId: normalizedOrgId, job, code: outcome.reasonCode, lease, now });
        return { success: false, code: outcome.reasonCode, processed: processedThisRun };
      }

      if (outcome?.outcome === 'global_pause') {
        const deferred = await deferReconciliationJob({
          orgId: normalizedOrgId,
          job,
          code: RECONCILIATION_REASONS.GLOBAL_PAUSE_ACTIVE,
          lease,
          now
        });
        return {
          success: true,
          state: deferred?.state || RECONCILIATION_STATES.DEFERRED,
          code: RECONCILIATION_REASONS.GLOBAL_PAUSE_ACTIVE,
          processed: processedThisRun
        };
      }

      const checkpoint = await loadRawReconciliationJob(normalizedOrgId);
      if (!checkpoint || checkpoint.jobId !== jobId) {
        return { success: false, code: 'RECONCILIATION_JOB_NOT_FOUND', processed: processedThisRun };
      }
      if (checkpoint.state !== RECONCILIATION_STATES.RUNNING) {
        job = checkpoint;
        break;
      }

      job = applyCandidateOutcome(checkpoint, outcome);
      const checkpointKeys = Array.isArray(checkpoint.attemptedKeys)
        ? checkpoint.attemptedKeys.filter(isValidIssueKey)
        : [];
      if (isValidIssueKey(issueKey) && !checkpointKeys.includes(issueKey)) {
        checkpointKeys.push(issueKey);
      }
      job.attemptedKeys = checkpointKeys;
      attempted.add(issueKey);

      await applyAttentionOutcome({
        orgId: normalizedOrgId,
        job,
        outcome,
        settings
      });

      const latest = await loadRawReconciliationJob(normalizedOrgId);
      if (!latest || latest.jobId !== jobId) {
        return { success: false, code: 'RECONCILIATION_JOB_NOT_FOUND', processed: processedThisRun };
      }
      if (latest.state !== RECONCILIATION_STATES.RUNNING) {
        job = latest;
        break;
      }

      job.updatedAt = new Date().toISOString();
      await kvsStore.set(buildReconciliationJobKey(normalizedOrgId), job);
      processedThisRun += 1;
    }

    const latestJob = await loadRawReconciliationJob(normalizedOrgId);
    if (!latestJob || latestJob.jobId !== jobId) {
      return { success: false, code: 'RECONCILIATION_JOB_NOT_FOUND', processed: processedThisRun };
    }
    job = latestJob;

    if (job.state === RECONCILIATION_STATES.CANCELLED) {
      await finalizeReconciliationSchedule({
        orgId: normalizedOrgId,
        job,
        now
      });
      return {
        success: true,
        state: job.state,
        outcome: job.outcome,
        processed: processedThisRun
      };
    }
    if (job.state !== RECONCILIATION_STATES.RUNNING) {
      return {
        success: true,
        state: job.state,
        outcome: job.outcome || null,
        processed: processedThisRun
      };
    }

    const attemptedAfter = new Set(
      Array.isArray(job.attemptedKeys) ? job.attemptedKeys.filter(isValidIssueKey) : []
    );
    const remaining = reconciliationCandidates.filter(
      issueKey => !attemptedAfter.has(issueKey)
    );
    job.progress = {
      total: Math.max(
        safeCount(job.progress?.processed) + remaining.length,
        safeCount(job.progress?.total)
      ),
      processed: safeCount(job.progress?.processed),
      remaining: remaining.length
    };

    if (remaining.length > 0) {
      const continuationOwnership = await verifyReconciliationLease(lease);
      if (!continuationOwnership.owned) {
        return {
          success: false,
          code: continuationOwnership.status === 'LEASE_STORAGE_ERROR'
            ? RECONCILIATION_REASONS.LEASE_STORAGE_ERROR
            : RECONCILIATION_REASONS.LEASE_LOST,
          processed: processedThisRun
        };
      }
      job.updatedAt = new Date().toISOString();
      await kvsStore.set(buildReconciliationJobKey(normalizedOrgId), job);
      try {
        await enqueueReconciliation(normalizedOrgId, jobId);
      } catch {
        await failReconciliationJob({
          orgId: normalizedOrgId,
          job,
          code: RECONCILIATION_REASONS.QUEUE_ENQUEUE_FAILED,
          lease,
          now,
          advanceSchedule: false
        });
        return {
          success: false,
          code: RECONCILIATION_REASONS.QUEUE_ENQUEUE_FAILED,
          processed: processedThisRun
        };
      }
      return {
        success: true,
        state: RECONCILIATION_STATES.RUNNING,
        continued: true,
        processed: processedThisRun,
        counts: safeCounts(job.counts)
      };
    }

    const completed = completeReconciliationJob(job);
    const completionOwnership = await verifyReconciliationLease(lease);
    if (!completionOwnership.owned) {
      return {
        success: false,
        code: completionOwnership.status === 'LEASE_STORAGE_ERROR'
          ? RECONCILIATION_REASONS.LEASE_STORAGE_ERROR
          : RECONCILIATION_REASONS.LEASE_LOST,
        processed: processedThisRun
      };
    }
    await kvsStore.set(buildReconciliationJobKey(normalizedOrgId), completed);
    await finalizeReconciliationSchedule({
      orgId: normalizedOrgId,
      job: completed,
      now
    });
    return {
      success: true,
      state: completed.state,
      outcome: completed.outcome,
      processed: processedThisRun,
      counts: safeCounts(completed.counts)
    };
  } catch (error) {
    if (job) {
      await failReconciliationJob({
        orgId: normalizedOrgId,
        job,
        code: error?.code || RECONCILIATION_REASONS.INTERNAL_ERROR,
        lease,
        now
      }).catch(() => null);
    }
    return {
      success: false,
      code: safeReason(error?.code, RECONCILIATION_REASONS.INTERNAL_ERROR),
      processed: processedThisRun
    };
  } finally {
    await releaseReconciliationLease(lease);
  }
}

async function loadOrganizationForHealthCheck(orgId) {
  const organizations = await getOrganizationsWithTokens();
  const organization = Array.isArray(organizations)
    ? organizations.find(candidate => candidate?.id === orgId)
    : null;
  if (!organization || !organization.remoteUrl
      || !organization.remoteEmail || !organization.remoteApiToken) {
    return null;
  }
  return organization;
}

/**
 * Resolve is intentionally stronger than Acknowledge. It performs fresh local
 * and remote probes and verifies both mapping directions before marking the
 * attention record resolved. A failed probe leaves the record open.
 */
export async function resolveRecurringReconciliationAttention({
  orgId,
  localKey,
  actorAccountId = null
} = {}) {
  const normalizedOrgId = normalizeOrgId(orgId);
  if (!isValidIssueKey(localKey)) {
    return { success: false, code: 'RECONCILIATION_INVALID_ISSUE_KEY' };
  }
  const record = await getReconciliationAttention({
    orgId: normalizedOrgId,
    localKey
  });
  if (!record) {
    return { success: false, code: 'RECONCILIATION_ATTENTION_NOT_FOUND' };
  }
  if (record.state === RECONCILIATION_ATTENTION_STATES.RESOLVED) {
    return {
      success: true,
      record,
      idempotent: true,
      healthCheck: { confirmed: true }
    };
  }

  const organization = await loadOrganizationForHealthCheck(normalizedOrgId);
  if (!organization) {
    return { success: false, code: 'RECONCILIATION_HEALTH_CHECK_CONFIGURATION_MISSING' };
  }
  const mappingOrgId = normalizedOrgId === 'legacy' ? null : normalizedOrgId;
  const remoteKey = await getRemoteKey(localKey, mappingOrgId);
  if (!isValidIssueKey(remoteKey)) {
    return { success: false, code: 'RECONCILIATION_HEALTH_CHECK_MAPPING_MISSING' };
  }
  const reverseLocalKey = await getLocalKey(remoteKey, mappingOrgId);
  if (reverseLocalKey !== localKey) {
    return { success: false, code: 'RECONCILIATION_HEALTH_CHECK_MAPPING_UNCONFIRMED' };
  }

  const [localProbe, remoteProbe] = await Promise.all([
    probeLocalIssue(localKey),
    probeRemoteIssue(remoteKey, organization)
  ]);
  if (localProbe?.reachable !== true || remoteProbe?.reachable !== true) {
    return {
      success: false,
      code: 'RECONCILIATION_HEALTH_CHECK_FAILED',
      healthCheck: {
        localReachable: localProbe?.reachable === true,
        remoteReachable: remoteProbe?.reachable === true,
        localStatus: Number.isInteger(localProbe?.statusCode) ? localProbe.statusCode : null,
        remoteStatus: Number.isInteger(remoteProbe?.statusCode) ? remoteProbe.statusCode : null
      }
    };
  }

  const resolved = await markReconciliationAttentionResolved({
    orgId: normalizedOrgId,
    localKey,
    remoteKey,
    actorAccountId,
    resolutionCode: 'HEALTH_CHECK_CONFIRMED'
  });
  return {
    ...resolved,
    healthCheck: {
      confirmed: true,
      localReachable: true,
      remoteReachable: true,
      mappingConfirmed: true
    }
  };
}

export async function acknowledgeRecurringReconciliationAttention({
  orgId,
  localKey,
  actorAccountId = null
} = {}) {
  const normalizedOrgId = normalizeOrgId(orgId);
  if (!isValidIssueKey(localKey)) {
    return { success: false, code: 'RECONCILIATION_INVALID_ISSUE_KEY' };
  }
  return await acknowledgeReconciliationAttention({
    orgId: normalizedOrgId,
    localKey,
    actorAccountId
  });
}

export async function listRecurringReconciliationAttention({ orgId } = {}) {
  const normalizedOrgId = normalizeOrgId(orgId);
  const settings = await getReconciliationSettings(normalizedOrgId);
  const items = await listReconciliationAttention(normalizedOrgId);
  return {
    success: true,
    items,
    summary: summarizeReconciliationAttention(
      items,
      settings.reconciliationFailureThreshold
    )
  };
}


export async function getRecurringReconciliationStatus({ orgId } = {}) {
  try {
    const normalizedOrgId = normalizeOrgId(orgId);
    const [settings, schedule, job, attentionResult] = await Promise.all([
      getReconciliationSettings(normalizedOrgId),
      getReconciliationSchedule(normalizedOrgId),
      getReconciliationJob(normalizedOrgId),
      listRecurringReconciliationAttention({ orgId: normalizedOrgId })
    ]);
    const nextRunMs = schedule.nextRunAt ? Date.parse(schedule.nextRunAt) : null;
    return {
      success: true,
      settings,
      schedule: {
        ...schedule,
        isDue: settings.recurringReconciliationEnabled
          && (!Number.isFinite(nextRunMs) || nextRunMs <= Date.now())
      },
      activeJob: isActiveJob(job) ? job : null,
      lastJob: job,
      attention: attentionResult.items,
      attentionSummary: attentionResult.summary
    };
  } catch (error) {
    return {
      success: false,
      code: safeReason(error?.code, 'RECONCILIATION_STATUS_FAILED')
    };
  }
}

/**
 * Save opt-in settings. Disabling cancels an active run without reversing any
 * completed Jira writes. This function never writes a future nextRunAt; only a
 * terminal reconciliation attempt can do that.
 */
export async function saveRecurringReconciliationSettings({
  orgId,
  settings
} = {}) {
  try {
    const normalizedOrgId = normalizeOrgId(orgId);
    const next = await saveReconciliationSettings({
      orgId: normalizedOrgId,
      settings
    });

    let cancelledJob = null;
    if (!next.recurringReconciliationEnabled) {
      const job = await loadRawReconciliationJob(normalizedOrgId);
      if (isActiveJob(job)) {
        cancelledJob = await cancelJobForDisabledSetting(normalizedOrgId, job);
      }
    }

    return {
      success: true,
      settings: next,
      cancelledJob
    };
  } catch (error) {
    return {
      success: false,
      code: safeReason(error?.code, 'RECONCILIATION_SAVE_SETTINGS_FAILED'),
      error: error?.message || 'Recurring reconciliation settings could not be saved.'
    };
  }
}
