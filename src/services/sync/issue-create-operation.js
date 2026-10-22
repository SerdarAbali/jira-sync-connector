import { randomBytes } from 'crypto';
import * as kvsStore from '../storage/kvs.js';
import { isKeyConflictError } from '../../utils/storage-errors.js';

export const ISSUE_CREATE_STATES = Object.freeze({
  PENDING: 'pending',
  SUCCEEDED: 'succeeded',
  UNKNOWN: 'unknown',
  FAILED_DEFINITIVE: 'failed_definitive'
});

export const ISSUE_CREATE_CODES = Object.freeze({
  ALLOWED: 'CREATE_ALLOWED',
  RETRY_ALLOWED: 'CREATE_RETRY_ALLOWED',
  RECONCILIATION_REQUIRED: 'CREATE_RECONCILIATION_REQUIRED',
  IN_PROGRESS: 'CREATE_IN_PROGRESS',
  STORAGE_ERROR: 'CREATE_OPERATION_STORAGE_ERROR',
  INVALID: 'CREATE_OPERATION_INVALID',
  TARGET_MISMATCH: 'CREATE_TARGET_MISMATCH',
  NOT_FOUND: 'CREATE_OPERATION_NOT_FOUND',
  STALE_ATTEMPT: 'CREATE_ATTEMPT_STALE',
  INVALID_STATE: 'CREATE_STATE_INVALID'
});

export const ISSUE_CREATE_FAILURE_REASONS = Object.freeze({
  JIRA_REJECTED: 'JIRA_REJECTED',
  PRE_SUBMISSION_BLOCKED: 'PRE_SUBMISSION_BLOCKED'
});

const ATTEMPT_TOKEN_BYTES = 32;
const SAFE_FAILURE_REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export const ISSUE_CREATE_DIRECTIONS = Object.freeze({
  LOCAL_TO_REMOTE: 'local-to-remote',
  REMOTE_TO_LOCAL: 'remote-to-local'
});

// A pending record without submissionStartedAt is retryable only after this
// grace period. A live invocation normally marks submission within seconds.
export const CREATE_OPERATION_PENDING_GRACE_MS = 5 * 60 * 1000;
const CREATE_RETRY_CLAIM_TTL_SECONDS = 60;
const SOURCE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-[0-9]+$/;

function orgScope(orgId) {
  return orgId === null || orgId === undefined || orgId === '' ? 'legacy' : String(orgId);
}

function normalizeOperation(value, operationKey) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return { ...value, operationKey };
}

function stripOperationKey(operation) {
  const { operationKey, ...persisted } = operation || {};
  void operationKey;
  return persisted;
}

function sanitizeOperation(operation) {
  if (!operation) {
    return null;
  }
  const { attemptToken, ...safe } = operation;
  void attemptToken;
  return safe;
}

function newAttemptToken() {
  return randomBytes(ATTEMPT_TOKEN_BYTES).toString('hex');
}

function isCurrentAttempt(current, operation) {
  return Boolean(
    current
    && operation
    && current.operationId === operation.operationId
    && typeof operation.attemptToken === 'string'
    && operation.attemptToken.length > 0
    && current.attemptToken === operation.attemptToken
  );
}

function isSafeFailureReason(reasonCode) {
  return typeof reasonCode === 'string' && SAFE_FAILURE_REASON_PATTERN.test(reasonCode);
}

export function isDefinitiveCreateRejection(status) {
  const statusCode = Number(status);
  return Number.isInteger(statusCode)
    && statusCode >= 400
    && statusCode < 500
    && statusCode !== 408
    && statusCode !== 425
    && statusCode !== 429;
}

function isKnownDirection(direction) {
  return direction === ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE
    || direction === ISSUE_CREATE_DIRECTIONS.REMOTE_TO_LOCAL;
}

export function isValidCreateSourceKey(sourceKey) {
  return typeof sourceKey === 'string'
    && sourceKey.length <= 100
    && SOURCE_KEY_PATTERN.test(sourceKey);
}

export function isValidCreateTargetKey(targetKey) {
  return isValidCreateSourceKey(targetKey);
}

export function buildIssueCreateOperationKey({ orgId = null, direction, sourceKey }) {
  if (!isKnownDirection(direction) || !isValidCreateSourceKey(sourceKey)) {
    throw new Error('Invalid issue create operation identity');
  }
  return `issue-create-op:${orgScope(orgId)}:${direction}:${encodeURIComponent(sourceKey)}`;
}

export async function getIssueCreateOperation({ orgId = null, direction, sourceKey }) {
  const operationKey = buildIssueCreateOperationKey({ orgId, direction, sourceKey });
  const value = await kvsStore.get(operationKey);
  return sanitizeOperation(normalizeOperation(value, operationKey));
}

async function conditionalCreate(key, value) {
  if (typeof kvsStore.createIfNotExists === 'function') {
    await kvsStore.createIfNotExists(key, value);
    return;
  }

  // Compatibility for older test doubles only. Production always uses the
  // Forge KVS FAIL_IF_EXISTS path above.
  const existing = await kvsStore.get(key);
  if (existing) {
    const conflict = new Error('create operation exists');
    conflict.code = 'KEY_ALREADY_EXISTS';
    throw conflict;
  }
  await kvsStore.set(key, value);
}

async function conditionalRetryClaim(key, value) {
  if (typeof kvsStore.setIfNotExists === 'function') {
    await kvsStore.setIfNotExists(key, value, CREATE_RETRY_CLAIM_TTL_SECONDS);
    return;
  }

  const existing = await kvsStore.get(key);
  if (existing) {
    const conflict = new Error('create retry already claimed');
    conflict.code = 'KEY_ALREADY_EXISTS';
    throw conflict;
  }
  await kvsStore.set(key, value);
}

function buildOperation({ orgId, direction, sourceKey, now }) {
  const timestamp = new Date(now).toISOString();
  return {
    operationId: randomBytes(16).toString('hex'),
    attemptToken: newAttemptToken(),
    orgId: orgId === null || orgId === undefined ? null : String(orgId),
    sourceKey,
    direction,
    state: ISSUE_CREATE_STATES.PENDING,
    attempt: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp
  };
}
function isSubmissionStarted(operation) {
  return typeof operation?.submissionStartedAt === 'string'
    && operation.submissionStartedAt.length > 0;
}

function pendingAgeMs(operation, now) {
  const startedAt = Date.parse(operation?.startedAt);
  if (!Number.isFinite(startedAt)) {
    return null;
  }
  return Math.max(0, now - startedAt);
}

async function tryRetryExisting({ operationKey, existing, now }) {
  const nextAttempt = (Number(existing.attempt) || 1) + 1;
  const retryKey = `${operationKey}:retry:${existing.operationId}:${nextAttempt}`;

  try {
    await conditionalRetryClaim(retryKey, {
      operationId: existing.operationId,
      attempt: nextAttempt,
      claimedAt: new Date(now).toISOString()
    });
  } catch (error) {
    if (isKeyConflictError(error)) {
      return {
        allowed: false,
        code: ISSUE_CREATE_CODES.IN_PROGRESS,
        operation: normalizeOperation(existing, operationKey)
      };
    }
    return {
      allowed: false,
      code: ISSUE_CREATE_CODES.STORAGE_ERROR,
      operation: normalizeOperation(existing, operationKey)
    };
  }

  const timestamp = new Date(now).toISOString();
  const next = {
    ...stripOperationKey(existing),
    state: ISSUE_CREATE_STATES.PENDING,
    attempt: nextAttempt,
    attemptToken: newAttemptToken(),
    startedAt: timestamp,
    updatedAt: timestamp
  };
  delete next.submissionStartedAt;
  delete next.targetKey;
  delete next.completedAt;
  delete next.unknownAt;
  delete next.failedAt;
  delete next.failureReason;

  await kvsStore.set(operationKey, next);
  return {
    allowed: true,
    code: ISSUE_CREATE_CODES.RETRY_ALLOWED,
    operation: normalizeOperation(next, operationKey)
  };
}

/**
 * Atomically claim the right to submit exactly one create request for a source
 * issue. A previous succeeded/unknown operation is never retried automatically.
 */
export async function beginIssueCreateOperation({
  orgId = null,
  direction,
  sourceKey,
  now = Date.now()
}) {
  let operationKey;
  try {
    operationKey = buildIssueCreateOperationKey({ orgId, direction, sourceKey });
  } catch {
    return { allowed: false, code: ISSUE_CREATE_CODES.INVALID, operation: null };
  }

  const proposed = buildOperation({ orgId, direction, sourceKey, now });

  try {
    await conditionalCreate(operationKey, proposed);
    return {
      allowed: true,
      code: ISSUE_CREATE_CODES.ALLOWED,
      operation: normalizeOperation(proposed, operationKey)
    };
  } catch (error) {
    if (!isKeyConflictError(error)) {
      return { allowed: false, code: ISSUE_CREATE_CODES.STORAGE_ERROR, operation: null };
    }
  }

  let existing;
  try {
    existing = normalizeOperation(await kvsStore.get(operationKey), operationKey);
  } catch {
    return { allowed: false, code: ISSUE_CREATE_CODES.STORAGE_ERROR, operation: null };
  }

  if (!existing) {
    return { allowed: false, code: ISSUE_CREATE_CODES.STORAGE_ERROR, operation: null };
  }

  if (existing.state === ISSUE_CREATE_STATES.SUCCEEDED
      || existing.state === ISSUE_CREATE_STATES.UNKNOWN) {
    return {
      allowed: false,
      code: ISSUE_CREATE_CODES.RECONCILIATION_REQUIRED,
      operation: existing
    };
  }

  if (existing.state === ISSUE_CREATE_STATES.FAILED_DEFINITIVE) {
    try {
      return await tryRetryExisting({ operationKey, existing, now });
    } catch {
      return { allowed: false, code: ISSUE_CREATE_CODES.STORAGE_ERROR, operation: existing };
    }
  }

  if (existing.state === ISSUE_CREATE_STATES.PENDING && !isSubmissionStarted(existing)) {
    const ageMs = pendingAgeMs(existing, now);
    if (ageMs === null || ageMs < CREATE_OPERATION_PENDING_GRACE_MS) {
      return {
        allowed: false,
        code: ISSUE_CREATE_CODES.IN_PROGRESS,
        operation: existing
      };
    }
    try {
      return await tryRetryExisting({ operationKey, existing, now });
    } catch {
      return { allowed: false, code: ISSUE_CREATE_CODES.STORAGE_ERROR, operation: existing };
    }
  }

  return {
    allowed: false,
    code: ISSUE_CREATE_CODES.RECONCILIATION_REQUIRED,
    operation: existing
  };
}

async function readCurrentOperation(operation) {
  if (!operation?.operationKey) {
    return null;
  }
  const current = await kvsStore.get(operation.operationKey);
  return normalizeOperation(current, operation.operationKey);
}

export async function markIssueCreateSubmissionStarted(operation, now = Date.now()) {
  const current = await readCurrentOperation(operation);
  if (!current || current.operationId !== operation?.operationId) {
    return { ok: false, code: ISSUE_CREATE_CODES.NOT_FOUND };
  }
  if (!isCurrentAttempt(current, operation)) {
    return { ok: false, code: ISSUE_CREATE_CODES.STALE_ATTEMPT };
  }
  if (current.state !== ISSUE_CREATE_STATES.PENDING) {
    return { ok: false, code: ISSUE_CREATE_CODES.INVALID_STATE };
  }
  if (isSubmissionStarted(current)) {
    return { ok: true, idempotent: true, operation: current };
  }

  const timestamp = new Date(now).toISOString();
  const next = {
    ...stripOperationKey(current),
    state: ISSUE_CREATE_STATES.PENDING,
    submissionStartedAt: timestamp,
    updatedAt: timestamp
  };
  await kvsStore.set(operation.operationKey, next);
  return { ok: true, idempotent: false, operation: normalizeOperation(next, operation.operationKey) };
}

export async function markIssueCreateSucceeded({
  operation,
  targetKey,
  now = Date.now(),
  allowUnknown = false
}) {
  const current = await readCurrentOperation(operation);
  if (!current || current.operationId !== operation?.operationId) {
    return { success: false, code: ISSUE_CREATE_CODES.NOT_FOUND };
  }
  if (!isCurrentAttempt(current, operation)) {
    return { success: false, code: ISSUE_CREATE_CODES.STALE_ATTEMPT };
  }
  if (!isValidCreateTargetKey(targetKey)) {
    return { success: false, code: ISSUE_CREATE_CODES.TARGET_MISMATCH };
  }

  if (current.state === ISSUE_CREATE_STATES.SUCCEEDED) {
    if (current.targetKey === targetKey) {
      return { success: true, idempotent: true, operation: current };
    }
    return { success: false, code: ISSUE_CREATE_CODES.TARGET_MISMATCH };
  }
  if (current.state === ISSUE_CREATE_STATES.UNKNOWN && !allowUnknown) {
    return {
      success: false,
      code: ISSUE_CREATE_CODES.RECONCILIATION_REQUIRED,
      operation: current
    };
  }
  if (current.state === ISSUE_CREATE_STATES.FAILED_DEFINITIVE) {
    return {
      success: false,
      code: ISSUE_CREATE_CODES.INVALID_STATE,
      operation: current
    };
  }

  const timestamp = new Date(now).toISOString();
  const next = {
    ...stripOperationKey(current),
    state: ISSUE_CREATE_STATES.SUCCEEDED,
    targetKey,
    completedAt: timestamp,
    updatedAt: timestamp
  };

  await kvsStore.set(operation.operationKey, next);
  return { success: true, idempotent: false, operation: normalizeOperation(next, operation.operationKey) };
}

export async function markIssueCreateUnknown(operation, now = Date.now()) {
  const current = await readCurrentOperation(operation);
  if (!current || current.operationId !== operation?.operationId) {
    return { success: false, code: ISSUE_CREATE_CODES.NOT_FOUND };
  }
  if (!isCurrentAttempt(current, operation)) {
    return { success: false, code: ISSUE_CREATE_CODES.STALE_ATTEMPT };
  }
  if (current.state === ISSUE_CREATE_STATES.SUCCEEDED) {
    return { success: true, idempotent: true, operation: current };
  }
  if (current.state === ISSUE_CREATE_STATES.FAILED_DEFINITIVE) {
    return {
      success: false,
      code: ISSUE_CREATE_CODES.INVALID_STATE,
      operation: current
    };
  }
  if (current.state === ISSUE_CREATE_STATES.UNKNOWN) {
    return { success: true, idempotent: true, operation: current };
  }

  const timestamp = new Date(now).toISOString();
  const next = {
    ...stripOperationKey(current),
    state: ISSUE_CREATE_STATES.UNKNOWN,
    unknownAt: timestamp,
    updatedAt: timestamp
  };
  delete next.submissionStartedAt;

  await kvsStore.set(operation.operationKey, next);
  return { success: true, idempotent: false, operation: normalizeOperation(next, operation.operationKey) };
}

export async function markIssueCreateFailedDefinitive(
  operation,
  { reasonCode = ISSUE_CREATE_FAILURE_REASONS.JIRA_REJECTED, now = Date.now() } = {}
) {
  const current = await readCurrentOperation(operation);
  if (!current || current.operationId !== operation?.operationId) {
    return { success: false, code: ISSUE_CREATE_CODES.NOT_FOUND };
  }
  if (!isCurrentAttempt(current, operation)) {
    return { success: false, code: ISSUE_CREATE_CODES.STALE_ATTEMPT };
  }
  if (current.state === ISSUE_CREATE_STATES.SUCCEEDED
      || current.state === ISSUE_CREATE_STATES.UNKNOWN) {
    return { success: false, code: ISSUE_CREATE_CODES.RECONCILIATION_REQUIRED, operation: current };
  }
  if (current.state === ISSUE_CREATE_STATES.FAILED_DEFINITIVE) {
    return { success: true, idempotent: true, operation: current };
  }
  if (current.state !== ISSUE_CREATE_STATES.PENDING) {
    return { success: false, code: ISSUE_CREATE_CODES.INVALID_STATE, operation: current };
  }

  const timestamp = new Date(now).toISOString();
  const next = {
    ...stripOperationKey(current),
    state: ISSUE_CREATE_STATES.FAILED_DEFINITIVE,
    failureReason: isSafeFailureReason(reasonCode)
      ? reasonCode
      : ISSUE_CREATE_FAILURE_REASONS.JIRA_REJECTED,
    failedAt: timestamp,
    updatedAt: timestamp
  };

  await kvsStore.set(operation.operationKey, next);
  return { success: true, idempotent: false, operation: normalizeOperation(next, operation.operationKey) };
}

/**
 * Resolve an ambiguous create with an explicit target key chosen by an
 * administrator. This function never creates or deletes a Jira issue.
 */
export async function resolveIssueCreateOperation({ operation, targetKey, now = Date.now() }) {
  if (!operation || !isValidCreateTargetKey(targetKey)) {
    return { success: false, code: ISSUE_CREATE_CODES.INVALID };
  }
  const current = await readCurrentOperation(operation);
  if (!current || current.operationId !== operation.operationId) {
    return { success: false, code: ISSUE_CREATE_CODES.NOT_FOUND };
  }
  const result = await markIssueCreateSucceeded({
    operation: current,
    targetKey,
    now,
    allowUnknown: true
  });
  if (!result.success) {
    return result;
  }
  return {
    success: true,
    code: result.idempotent ? 'CREATE_ALREADY_RECONCILED' : 'CREATE_RECONCILED',
    idempotent: !!result.idempotent,
    operation: sanitizeOperation(result.operation)
  };
}

