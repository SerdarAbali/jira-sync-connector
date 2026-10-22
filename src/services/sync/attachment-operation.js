import { randomBytes, createHash } from 'crypto';
import * as kvsStore from '../storage/kvs.js';
import { isKeyConflictError } from '../../utils/storage-errors.js';
import {
  isValidAttachmentId,
  isValidIssueKey,
  validateAttachmentId
} from '../../utils/attachment-url.js';

export const ATTACHMENT_DIRECTIONS = Object.freeze({
  LOCAL_TO_REMOTE: 'local-to-remote',
  REMOTE_TO_LOCAL: 'remote-to-local'
});

export const ATTACHMENT_OPERATION_TYPES = Object.freeze({
  UPLOAD: 'upload',
  DELETION: 'deletion'
});

export const ATTACHMENT_OPERATION_STATES = Object.freeze({
  PENDING: 'pending',
  SUCCEEDED: 'succeeded',
  UNKNOWN: 'unknown',
  FAILED_DEFINITIVE: 'failed_definitive'
});

export const ATTACHMENT_OPERATION_CODES = Object.freeze({
  ALLOWED: 'ATTACHMENT_UPLOAD_ALLOWED',
  RETRY_ALLOWED: 'ATTACHMENT_UPLOAD_RETRY_ALLOWED',
  ALREADY_SYNCED: 'ATTACHMENT_ALREADY_SYNCED',
  RECONCILIATION_REQUIRED: 'ATTACHMENT_RECONCILIATION_REQUIRED',
  IN_PROGRESS: 'ATTACHMENT_UPLOAD_IN_PROGRESS',
  STORAGE_ERROR: 'ATTACHMENT_OPERATION_STORAGE_ERROR',
  INVALID: 'ATTACHMENT_OPERATION_INVALID',
  NOT_FOUND: 'ATTACHMENT_OPERATION_NOT_FOUND',
  STALE_ATTEMPT: 'ATTACHMENT_ATTEMPT_STALE',
  INVALID_STATE: 'ATTACHMENT_STATE_INVALID',
  DELETE_ALREADY_DONE: 'ATTACHMENT_DELETE_ALREADY_DONE',
  DELETE_RECONCILIATION_REQUIRED: 'ATTACHMENT_DELETE_RECONCILIATION_REQUIRED'
});

const ATTEMPT_TOKEN_BYTES = 32;
const OPERATION_ID_BYTES = 16;
const ATTEMPT_CLAIM_TTL_SECONDS = 60;
const PENDING_GRACE_MS = 5 * 60 * 1000;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function orgScope(orgId) {
  return orgId === null || orgId === undefined || orgId === '' ? 'legacy' : String(orgId);
}

function isKnownDirection(direction) {
  return direction === ATTACHMENT_DIRECTIONS.LOCAL_TO_REMOTE
    || direction === ATTACHMENT_DIRECTIONS.REMOTE_TO_LOCAL;
}

function isKnownType(type) {
  return type === ATTACHMENT_OPERATION_TYPES.UPLOAD
    || type === ATTACHMENT_OPERATION_TYPES.DELETION;
}

export function buildAttachmentOperationKey({
  orgId = null,
  direction,
  sourceAttachmentId,
  operationType = ATTACHMENT_OPERATION_TYPES.UPLOAD
}) {
  if (!isKnownDirection(direction) || !isKnownType(operationType)) {
    throw new Error('Invalid attachment operation scope');
  }
  const id = validateAttachmentId(sourceAttachmentId);
  const suffix = operationType === ATTACHMENT_OPERATION_TYPES.DELETION ? ':deletion' : '';
  return `attachment-operation:${orgScope(orgId)}:${direction}:${id}${suffix}`;
}

function buildClaimKey(options) {
  return `${buildAttachmentOperationKey(options)}:claim`;
}

function newToken(bytes = ATTEMPT_TOKEN_BYTES) {
  return randomBytes(bytes).toString('hex');
}

export function hashAttachmentFilename(filename) {
  return createHash('sha256').update(String(filename || ''), 'utf8').digest('hex');
}

function normalizeOperation(value, operationKey) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return { ...value, operationKey };
}

function persisted(operation) {
  const { operationKey, ...record } = operation || {};
  void operationKey;
  return record;
}

function isCurrentAttempt(current, operation) {
  return Boolean(
    current
    && operation
    && current.operationId === operation.operationId
    && typeof operation.attemptToken === 'string'
    && operation.attemptToken.length > 0
    && current.attemptToken === operation.attemptToken
    && current.attempt === operation.attempt
  );
}

// A write-start marker means the request may have reached Jira. Once present,
// an unconfirmed attempt is reconciliation-only and must never be retried
// automatically, even after the pending grace period.
function isWriteStarted(operation) {
  return Boolean(
    (typeof operation?.writeStartedAt === 'string' && operation.writeStartedAt.length > 0)
    || (typeof operation?.submissionStartedAt === 'string' && operation.submissionStartedAt.length > 0)
  );
}

function withoutWriteStart(record) {
  const next = { ...record };
  delete next.writeStartedAt;
  delete next.submissionStartedAt;
  return next;
}

export function sanitizeAttachmentOperation(operation) {
  if (!operation) return null;
  const { attemptToken, operationKey, ...safe } = operation;
  void attemptToken;
  void operationKey;
  return {
    operationId: safe.operationId,
    operationType: safe.operationType,
    orgId: safe.orgId ?? null,
    direction: safe.direction,
    sourceAttachmentId: safe.sourceAttachmentId,
    state: safe.state,
    attempt: safe.attempt,
    localKey: safe.localKey || null,
    remoteKey: safe.remoteKey || null,
    destinationAttachmentId: safe.destinationAttachmentId || null,
    failureCode: safe.failureCode || null,
    reconciliationRequired: safe.reconciliationRequired === true,
    createdAt: safe.createdAt || null,
    updatedAt: safe.updatedAt || null
  };
}

function buildBaseOperation({
  orgId,
  direction,
  sourceAttachmentId,
  operationType,
  localKey,
  remoteKey,
  now
}) {
  if (!isKnownDirection(direction)
    || !isKnownType(operationType)
    || !isValidAttachmentId(sourceAttachmentId)
    || !isValidIssueKey(localKey)
    || !isValidIssueKey(remoteKey)) {
    return null;
  }

  const timestamp = new Date(now).toISOString();
  return {
    operationId: newToken(OPERATION_ID_BYTES),
    operationType,
    orgId: orgId === null || orgId === undefined ? null : String(orgId),
    direction,
    sourceAttachmentId: String(sourceAttachmentId),
    localKey,
    remoteKey,
    state: ATTACHMENT_OPERATION_STATES.PENDING,
    attempt: 1,
    attemptToken: newToken(),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function readCurrent(operationKey) {
  const current = await kvsStore.get(operationKey);
  return normalizeOperation(current, operationKey);
}

async function atomicCreate(key, value) {
  if (typeof kvsStore.createIfNotExists === 'function') {
    await kvsStore.createIfNotExists(key, value);
    return;
  }
  const existing = await kvsStore.get(key);
  if (existing) {
    const conflict = new Error('key already exists');
    conflict.code = 'KEY_ALREADY_EXISTS';
    throw conflict;
  }
  await kvsStore.set(key, value);
}

async function tryClaimAttempt(claimKey, token, now) {
  try {
    if (typeof kvsStore.setIfNotExists === 'function') {
      await kvsStore.setIfNotExists(claimKey, {
        claimToken: token,
        claimedAt: new Date(now).toISOString()
      }, ATTEMPT_CLAIM_TTL_SECONDS);
    } else {
      await atomicCreate(claimKey, { claimToken: token });
    }
    return true;
  } catch (error) {
    if (isKeyConflictError(error)) return false;
    throw error;
  }
}

function mayRetryExisting(existing, now) {
  if (!existing) return false;
  if (existing.state === ATTACHMENT_OPERATION_STATES.FAILED_DEFINITIVE) return true;
  if (existing.state !== ATTACHMENT_OPERATION_STATES.PENDING) return false;
  if (isWriteStarted(existing)) return false;
  const startedAt = Date.parse(existing.updatedAt || existing.createdAt || '');
  return Number.isFinite(startedAt) && (now - startedAt) >= PENDING_GRACE_MS;
}

export async function beginAttachmentUploadOperation({
  orgId = null,
  direction,
  sourceAttachmentId,
  localKey,
  remoteKey,
  now = Date.now()
}) {
  let operationKey;
  let claimKey;
  try {
    const scope = {
      orgId,
      direction,
      sourceAttachmentId,
      operationType: ATTACHMENT_OPERATION_TYPES.UPLOAD
    };
    operationKey = buildAttachmentOperationKey(scope);
    claimKey = buildClaimKey(scope);
  } catch {
    return { allowed: false, code: ATTACHMENT_OPERATION_CODES.INVALID, operation: null };
  }

  const proposed = buildBaseOperation({
    orgId,
    direction,
    sourceAttachmentId,
    operationType: ATTACHMENT_OPERATION_TYPES.UPLOAD,
    localKey,
    remoteKey,
    now
  });
  if (!proposed) {
    return { allowed: false, code: ATTACHMENT_OPERATION_CODES.INVALID, operation: null };
  }

  try {
    await atomicCreate(operationKey, proposed);
    return {
      allowed: true,
      code: ATTACHMENT_OPERATION_CODES.ALLOWED,
      operation: normalizeOperation(proposed, operationKey)
    };
  } catch (error) {
    if (!isKeyConflictError(error)) {
      return { allowed: false, code: ATTACHMENT_OPERATION_CODES.STORAGE_ERROR, operation: null };
    }
  }

  let existing;
  try {
    existing = await readCurrent(operationKey);
  } catch {
    return { allowed: false, code: ATTACHMENT_OPERATION_CODES.STORAGE_ERROR, operation: null };
  }
  if (!existing) {
    return { allowed: false, code: ATTACHMENT_OPERATION_CODES.STORAGE_ERROR, operation: null };
  }
  if (existing.state === ATTACHMENT_OPERATION_STATES.SUCCEEDED) {
    return { allowed: false, code: ATTACHMENT_OPERATION_CODES.ALREADY_SYNCED, operation: existing };
  }
  if (existing.state === ATTACHMENT_OPERATION_STATES.UNKNOWN) {
    return {
      allowed: false,
      code: ATTACHMENT_OPERATION_CODES.RECONCILIATION_REQUIRED,
      operation: existing
    };
  }
  if (existing.state === ATTACHMENT_OPERATION_STATES.PENDING && isWriteStarted(existing)) {
    return {
      allowed: false,
      code: ATTACHMENT_OPERATION_CODES.RECONCILIATION_REQUIRED,
      operation: existing
    };
  }
  if (!mayRetryExisting(existing, now)) {
    return { allowed: false, code: ATTACHMENT_OPERATION_CODES.IN_PROGRESS, operation: existing };
  }

  try {
    const claimed = await tryClaimAttempt(claimKey, newToken(), now);
    if (!claimed) {
      return { allowed: false, code: ATTACHMENT_OPERATION_CODES.IN_PROGRESS, operation: existing };
    }
  } catch {
    return { allowed: false, code: ATTACHMENT_OPERATION_CODES.STORAGE_ERROR, operation: existing };
  }

  const current = await readCurrent(operationKey);
  if (!current || isWriteStarted(current) || !mayRetryExisting(current, now)) {
    return {
      allowed: false,
      code: current?.state === ATTACHMENT_OPERATION_STATES.UNKNOWN || isWriteStarted(current)
        ? ATTACHMENT_OPERATION_CODES.RECONCILIATION_REQUIRED
        : ATTACHMENT_OPERATION_CODES.IN_PROGRESS,
      operation: current
    };
  }

  const timestamp = new Date(now).toISOString();
  const next = {
    ...withoutWriteStart(persisted(current)),
    state: ATTACHMENT_OPERATION_STATES.PENDING,
    attempt: Number(current.attempt || 0) + 1,
    attemptToken: newToken(),
    startedAt: timestamp,
    updatedAt: timestamp
  };
  delete next.destinationAttachmentId;
  delete next.completedAt;
  delete next.unknownAt;
  delete next.failedAt;
  delete next.failureCode;
  delete next.reconciliationRequired;

  await kvsStore.set(operationKey, next);
  return {
    allowed: true,
    code: ATTACHMENT_OPERATION_CODES.RETRY_ALLOWED,
    operation: normalizeOperation(next, operationKey)
  };
}

/**
 * Persist the exact point at which an upload POST or deletion DELETE may be
 * issued. Metadata retrieval, validation and download must happen before this
 * call. The marker is deliberately separate from pending: a pending operation
 * without it can be retried after the grace period, while a marked operation
 * without a confirmed result is reconciliation-only.
 */
export async function markAttachmentWriteStarted(operation, now = Date.now()) {
  const current = await readCurrent(operation?.operationKey);
  if (!current || current.operationId !== operation?.operationId) {
    return { ok: false, code: ATTACHMENT_OPERATION_CODES.NOT_FOUND };
  }
  if (!isCurrentAttempt(current, operation)) {
    return { ok: false, code: ATTACHMENT_OPERATION_CODES.STALE_ATTEMPT };
  }
  if (current.state !== ATTACHMENT_OPERATION_STATES.PENDING) {
    return { ok: false, code: ATTACHMENT_OPERATION_CODES.INVALID_STATE, operation: current };
  }
  if (isWriteStarted(current)) {
    return { ok: true, idempotent: true, operation: current };
  }

  const timestamp = new Date(now).toISOString();
  const next = {
    ...persisted(current),
    state: ATTACHMENT_OPERATION_STATES.PENDING,
    writeStartedAt: timestamp,
    // Kept for compatibility with the existing operation record shape.
    submissionStartedAt: timestamp,
    updatedAt: timestamp
  };
  await kvsStore.set(operation.operationKey, next);
  return { ok: true, idempotent: false, operation: normalizeOperation(next, operation.operationKey) };
}

// Existing name retained for callers and tests of the upload marker.
export async function markAttachmentSubmissionStarted(operation, now = Date.now()) {
  return await markAttachmentWriteStarted(operation, now);
}

// Deletion uses the same durable marker so a DELETE with no recorded result is
// never retried. Both names are exported for explicit call sites.
export async function markAttachmentDeletionWriteStarted(operation, now = Date.now()) {
  return await markAttachmentWriteStarted(operation, now);
}

export async function markAttachmentDeletionSubmissionStarted(operation, now = Date.now()) {
  return await markAttachmentWriteStarted(operation, now);
}

export async function markAttachmentUploadSucceeded(
  operation,
  { destinationAttachmentId, now = Date.now() } = {}
) {
  if (!isValidAttachmentId(destinationAttachmentId)) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.INVALID };
  }
  const current = await readCurrent(operation?.operationKey);
  if (!current || current.operationId !== operation?.operationId) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.NOT_FOUND };
  }
  if (!isCurrentAttempt(current, operation)) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.STALE_ATTEMPT };
  }
  if (current.state === ATTACHMENT_OPERATION_STATES.SUCCEEDED) {
    const matches = current.destinationAttachmentId === String(destinationAttachmentId);
    return {
      success: matches,
      idempotent: true,
      code: matches
        ? ATTACHMENT_OPERATION_CODES.ALREADY_SYNCED
        : ATTACHMENT_OPERATION_CODES.INVALID_STATE,
      operation: current
    };
  }
  if (current.state !== ATTACHMENT_OPERATION_STATES.PENDING) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.INVALID_STATE, operation: current };
  }

  const timestamp = new Date(now).toISOString();
  const next = {
    ...persisted(current),
    state: ATTACHMENT_OPERATION_STATES.SUCCEEDED,
    destinationAttachmentId: String(destinationAttachmentId),
    completedAt: timestamp,
    updatedAt: timestamp
  };
  delete next.writeStartedAt;
  delete next.submissionStartedAt;
  delete next.reconciliationRequired;

  await kvsStore.set(operation.operationKey, next);
  return {
    success: true,
    idempotent: false,
    code: ATTACHMENT_OPERATION_CODES.ALREADY_SYNCED,
    operation: normalizeOperation(next, operation.operationKey)
  };
}

export async function markAttachmentUploadUnknown(operation, now = Date.now()) {
  const current = await readCurrent(operation?.operationKey);
  if (!current || current.operationId !== operation?.operationId) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.NOT_FOUND };
  }
  if (!isCurrentAttempt(current, operation)) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.STALE_ATTEMPT };
  }
  if (current.state === ATTACHMENT_OPERATION_STATES.UNKNOWN
      || current.state === ATTACHMENT_OPERATION_STATES.SUCCEEDED) {
    return { success: true, idempotent: true, operation: current };
  }
  if (current.state !== ATTACHMENT_OPERATION_STATES.PENDING) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.INVALID_STATE, operation: current };
  }

  const timestamp = new Date(now).toISOString();
  const next = {
    ...persisted(current),
    state: ATTACHMENT_OPERATION_STATES.UNKNOWN,
    reconciliationRequired: true,
    unknownAt: timestamp,
    updatedAt: timestamp
  };
  delete next.writeStartedAt;
  delete next.submissionStartedAt;

  await kvsStore.set(operation.operationKey, next);
  return { success: true, idempotent: false, operation: normalizeOperation(next, operation.operationKey) };
}

export async function markAttachmentUploadFailedDefinitive(
  operation,
  { failureCode = 'ATTACHMENT_UPLOAD_REJECTED', now = Date.now() } = {}
) {
  const current = await readCurrent(operation?.operationKey);
  if (!current || current.operationId !== operation?.operationId) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.NOT_FOUND };
  }
  if (!isCurrentAttempt(current, operation)) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.STALE_ATTEMPT };
  }
  if (current.state === ATTACHMENT_OPERATION_STATES.UNKNOWN
      || current.state === ATTACHMENT_OPERATION_STATES.SUCCEEDED) {
    return {
      success: false,
      code: ATTACHMENT_OPERATION_CODES.RECONCILIATION_REQUIRED,
      operation: current
    };
  }
  if (current.state === ATTACHMENT_OPERATION_STATES.FAILED_DEFINITIVE) {
    return { success: true, idempotent: true, operation: current };
  }
  if (current.state !== ATTACHMENT_OPERATION_STATES.PENDING) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.INVALID_STATE, operation: current };
  }

  const timestamp = new Date(now).toISOString();
  const next = {
    ...persisted(current),
    state: ATTACHMENT_OPERATION_STATES.FAILED_DEFINITIVE,
    failureCode: SAFE_CODE_PATTERN.test(failureCode)
      ? failureCode
      : 'ATTACHMENT_UPLOAD_REJECTED',
    failedAt: timestamp,
    updatedAt: timestamp
  };
  delete next.writeStartedAt;
  delete next.submissionStartedAt;

  await kvsStore.set(operation.operationKey, next);
  return { success: true, idempotent: false, operation: normalizeOperation(next, operation.operationKey) };
}

export async function getAttachmentOperation({
  orgId = null,
  direction,
  sourceAttachmentId,
  operationType = ATTACHMENT_OPERATION_TYPES.UPLOAD
}) {
  const key = buildAttachmentOperationKey({
    orgId,
    direction,
    sourceAttachmentId,
    operationType
  });
  return normalizeOperation(await kvsStore.get(key), key);
}

/**
 * Administrator reconciliation records an explicit destination ID for an
 * ambiguous upload. It never downloads, uploads or deletes attachment content.
 */
export async function resolveAttachmentUploadOperation({
  operation,
  destinationAttachmentId,
  now = Date.now()
}) {
  if (!operation?.operationKey || !isValidAttachmentId(destinationAttachmentId)) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.INVALID };
  }
  const current = await readCurrent(operation.operationKey);
  if (!current || current.operationId !== operation.operationId) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.NOT_FOUND };
  }
  if (current.state === ATTACHMENT_OPERATION_STATES.SUCCEEDED) {
    const matches = current.destinationAttachmentId === String(destinationAttachmentId);
    return {
      success: matches,
      idempotent: true,
      code: matches
        ? ATTACHMENT_OPERATION_CODES.ALREADY_SYNCED
        : ATTACHMENT_OPERATION_CODES.INVALID_STATE,
      operation: current
    };
  }
  if (current.state !== ATTACHMENT_OPERATION_STATES.UNKNOWN) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.INVALID_STATE, operation: current };
  }

  const timestamp = new Date(now).toISOString();
  const next = {
    ...persisted(current),
    state: ATTACHMENT_OPERATION_STATES.SUCCEEDED,
    destinationAttachmentId: String(destinationAttachmentId),
    adminReconciledAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp
  };
  delete next.attemptToken;
  delete next.reconciliationRequired;
  delete next.writeStartedAt;
  delete next.submissionStartedAt;

  await kvsStore.set(operation.operationKey, next);
  return {
    success: true,
    idempotent: false,
    code: 'ATTACHMENT_RECONCILED',
    operation: normalizeOperation(next, operation.operationKey)
  };
}

/**
 * Claim at most one DELETE attempt. Ambiguous outcomes remain unknown and are
 * never retried automatically; only a definitive rejection may be retried.
 */
export async function beginAttachmentDeletionOperation({
  orgId = null,
  direction,
  sourceAttachmentId,
  localKey,
  remoteKey,
  mappedDestinationAttachmentId,
  now = Date.now()
}) {
  if (!isValidAttachmentId(mappedDestinationAttachmentId)) {
    return { allowed: false, code: ATTACHMENT_OPERATION_CODES.INVALID, operation: null };
  }
  let operationKey;
  let claimKey;
  try {
    const scope = {
      orgId,
      direction,
      sourceAttachmentId,
      operationType: ATTACHMENT_OPERATION_TYPES.DELETION
    };
    operationKey = buildAttachmentOperationKey(scope);
    claimKey = buildClaimKey(scope);
  } catch {
    return { allowed: false, code: ATTACHMENT_OPERATION_CODES.INVALID, operation: null };
  }

  const proposed = buildBaseOperation({
    orgId,
    direction,
    sourceAttachmentId,
    operationType: ATTACHMENT_OPERATION_TYPES.DELETION,
    localKey,
    remoteKey,
    now
  });
  if (!proposed) {
    return { allowed: false, code: ATTACHMENT_OPERATION_CODES.INVALID, operation: null };
  }
  proposed.mappedDestinationAttachmentId = String(mappedDestinationAttachmentId);

  try {
    await atomicCreate(operationKey, proposed);
    return {
      allowed: true,
      code: ATTACHMENT_OPERATION_CODES.ALLOWED,
      operation: normalizeOperation(proposed, operationKey)
    };
  } catch (error) {
    if (!isKeyConflictError(error)) {
      return { allowed: false, code: ATTACHMENT_OPERATION_CODES.STORAGE_ERROR, operation: null };
    }
  }

  const existing = await readCurrent(operationKey);
  if (!existing) {
    return { allowed: false, code: ATTACHMENT_OPERATION_CODES.STORAGE_ERROR, operation: null };
  }
  if (existing.state === ATTACHMENT_OPERATION_STATES.SUCCEEDED) {
    return {
      allowed: false,
      code: ATTACHMENT_OPERATION_CODES.DELETE_ALREADY_DONE,
      operation: existing
    };
  }
  if (existing.state === ATTACHMENT_OPERATION_STATES.UNKNOWN) {
    return {
      allowed: false,
      code: ATTACHMENT_OPERATION_CODES.DELETE_RECONCILIATION_REQUIRED,
      operation: existing
    };
  }
  if (existing.state === ATTACHMENT_OPERATION_STATES.PENDING && isWriteStarted(existing)) {
    return {
      allowed: false,
      code: ATTACHMENT_OPERATION_CODES.DELETE_RECONCILIATION_REQUIRED,
      operation: existing
    };
  }
  if (!mayRetryExisting(existing, now)) {
    return { allowed: false, code: ATTACHMENT_OPERATION_CODES.IN_PROGRESS, operation: existing };
  }

  try {
    const claimed = await tryClaimAttempt(claimKey, newToken(), now);
    if (!claimed) {
      return { allowed: false, code: ATTACHMENT_OPERATION_CODES.IN_PROGRESS, operation: existing };
    }
  } catch {
    return { allowed: false, code: ATTACHMENT_OPERATION_CODES.STORAGE_ERROR, operation: existing };
  }

  const current = await readCurrent(operationKey);
  if (!current || isWriteStarted(current) || !mayRetryExisting(current, now)) {
    return {
      allowed: false,
      code: current?.state === ATTACHMENT_OPERATION_STATES.UNKNOWN || isWriteStarted(current)
        ? ATTACHMENT_OPERATION_CODES.DELETE_RECONCILIATION_REQUIRED
        : ATTACHMENT_OPERATION_CODES.IN_PROGRESS,
      operation: current
    };
  }

  const timestamp = new Date(now).toISOString();
  const next = {
    ...persisted(current),
    state: ATTACHMENT_OPERATION_STATES.PENDING,
    attempt: Number(current.attempt || 0) + 1,
    attemptToken: newToken(),
    mappedDestinationAttachmentId: String(mappedDestinationAttachmentId),
    startedAt: timestamp,
    updatedAt: timestamp
  };
  delete next.writeStartedAt;
  delete next.submissionStartedAt;
  delete next.completedAt;
  delete next.unknownAt;
  delete next.failedAt;
  delete next.failureCode;

  await kvsStore.set(operationKey, next);
  return {
    allowed: true,
    code: ATTACHMENT_OPERATION_CODES.RETRY_ALLOWED,
    operation: normalizeOperation(next, operationKey)
  };
}

export async function markAttachmentDeletionSucceeded(operation, now = Date.now()) {
  const current = await readCurrent(operation?.operationKey);
  if (!current || current.operationId !== operation?.operationId) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.NOT_FOUND };
  }
  if (!isCurrentAttempt(current, operation)) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.STALE_ATTEMPT };
  }
  if (current.state === ATTACHMENT_OPERATION_STATES.SUCCEEDED) {
    return { success: true, idempotent: true, operation: current };
  }
  if (current.state !== ATTACHMENT_OPERATION_STATES.PENDING) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.INVALID_STATE, operation: current };
  }

  const timestamp = new Date(now).toISOString();
  const next = {
    ...persisted(current),
    state: ATTACHMENT_OPERATION_STATES.SUCCEEDED,
    completedAt: timestamp,
    updatedAt: timestamp
  };
  delete next.writeStartedAt;
  delete next.submissionStartedAt;

  await kvsStore.set(operation.operationKey, next);
  return { success: true, idempotent: false, operation: normalizeOperation(next, operation.operationKey) };
}

export async function markAttachmentDeletionUnknown(operation, now = Date.now()) {
  const current = await readCurrent(operation?.operationKey);
  if (!current || current.operationId !== operation?.operationId) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.NOT_FOUND };
  }
  if (!isCurrentAttempt(current, operation)) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.STALE_ATTEMPT };
  }
  if (current.state === ATTACHMENT_OPERATION_STATES.UNKNOWN) {
    return { success: true, idempotent: true, operation: current };
  }
  if (current.state !== ATTACHMENT_OPERATION_STATES.PENDING) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.INVALID_STATE, operation: current };
  }

  const timestamp = new Date(now).toISOString();
  const next = {
    ...persisted(current),
    state: ATTACHMENT_OPERATION_STATES.UNKNOWN,
    reconciliationRequired: true,
    unknownAt: timestamp,
    updatedAt: timestamp
  };
  delete next.writeStartedAt;
  delete next.submissionStartedAt;

  await kvsStore.set(operation.operationKey, next);
  return { success: true, idempotent: false, operation: normalizeOperation(next, operation.operationKey) };
}

export async function markAttachmentDeletionFailedDefinitive(
  operation,
  { failureCode = 'ATTACHMENT_DELETE_REJECTED', now = Date.now() } = {}
) {
  const current = await readCurrent(operation?.operationKey);
  if (!current || current.operationId !== operation?.operationId) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.NOT_FOUND };
  }
  if (!isCurrentAttempt(current, operation)) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.STALE_ATTEMPT };
  }
  if (current.state === ATTACHMENT_OPERATION_STATES.UNKNOWN
      || current.state === ATTACHMENT_OPERATION_STATES.SUCCEEDED) {
    return {
      success: false,
      code: ATTACHMENT_OPERATION_CODES.DELETE_RECONCILIATION_REQUIRED,
      operation: current
    };
  }
  if (current.state !== ATTACHMENT_OPERATION_STATES.PENDING) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.INVALID_STATE, operation: current };
  }

  const timestamp = new Date(now).toISOString();
  const next = {
    ...persisted(current),
    state: ATTACHMENT_OPERATION_STATES.FAILED_DEFINITIVE,
    failureCode: SAFE_CODE_PATTERN.test(failureCode)
      ? failureCode
      : 'ATTACHMENT_DELETE_REJECTED',
    failedAt: timestamp,
    updatedAt: timestamp
  };
  delete next.writeStartedAt;
  delete next.submissionStartedAt;

  await kvsStore.set(operation.operationKey, next);
  return { success: true, idempotent: false, operation: normalizeOperation(next, operation.operationKey) };
}
