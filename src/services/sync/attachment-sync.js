import { Queue } from '@forge/events';
import {
  getAttachmentMapping,
  storeAttachmentMapping,
  removeAttachmentMapping,
  storeAttachmentMappingHistory,
  getRemoteKey,
  getLocalKey
} from '../storage/mappings.js';
import * as kvsStore from '../storage/kvs.js';
import { getFullIssue } from '../jira/local-client.js';
import { getRemoteIssue } from '../jira/remote-client.js';
import {
  ATTACHMENT_SOURCE,
  AttachmentClientError,
  ATTACHMENT_CLIENT_CODES,
  deleteAttachmentContent,
  downloadAttachmentContent,
  getAttachmentMetadata,
  getAttachmentSettings,
  getIssueAttachments,
  uploadAttachmentContent
} from '../jira/attachment-client.js';
import {
  ATTACHMENT_DIRECTIONS,
  ATTACHMENT_OPERATION_CODES,
  ATTACHMENT_OPERATION_STATES,
  ATTACHMENT_OPERATION_TYPES,
  beginAttachmentDeletionOperation,
  beginAttachmentUploadOperation,
  getAttachmentOperation,
  markAttachmentDeletionFailedDefinitive,
  markAttachmentDeletionSucceeded,
  markAttachmentDeletionUnknown,
  markAttachmentDeletionWriteStarted,
  markAttachmentUploadFailedDefinitive,
  markAttachmentUploadSucceeded,
  markAttachmentUploadUnknown,
  markAttachmentWriteStarted,
  resolveAttachmentUploadOperation,
  sanitizeAttachmentOperation
} from './attachment-operation.js';
import { assertPilotWritesAllowed } from './pilot-pause.js';
import { isValidIssueKey, isValidAttachmentId, normalizeAttachmentMimeType, sanitizeAttachmentFilename } from '../../utils/attachment-url.js';
import { safeErrorSummary } from '../../utils/redaction.js';

export const MAX_ATTACHMENTS_PER_INVOCATION = 3;
const MAX_ATTACHMENT_IDS_PER_QUEUE_EVENT = 20;
const ATTACHMENT_QUEUE_KEY = 'attachment-sync-queue';
const ATTACHMENT_ECHO_TTL_SECONDS = 24 * 60 * 60;

export const ATTACHMENT_SYNC_CODES = Object.freeze({
  DISABLED: 'ATTACHMENT_SYNC_DISABLED',
  PAUSED: 'ATTACHMENT_SYNC_PAUSED',
  UNMAPPED: 'ATTACHMENT_ISSUE_NOT_MAPPED',
  PROJECT_BLOCKED: 'ATTACHMENT_PROJECT_BLOCKED',
  SETTINGS_UNAVAILABLE: 'ATTACHMENT_SETTINGS_UNAVAILABLE',
  SIZE_REJECTED: 'ATTACHMENT_SIZE_REJECTED',
  FILENAME_REJECTED: 'ATTACHMENT_FILENAME_REJECTED',
  TYPE_REJECTED: 'ATTACHMENT_TYPE_REJECTED',
  MAPPING_CONFLICT: 'ATTACHMENT_MAPPING_CONFLICT',
  RECONCILIATION_REQUIRED: 'ATTACHMENT_RECONCILIATION_REQUIRED',
  DELETE_DISABLED: 'ATTACHMENT_DELETE_PROPAGATION_DISABLED',
  DELETE_UNMAPPED: 'ATTACHMENT_DELETE_UNMAPPED',
  DELETE_COMPLETE: 'ATTACHMENT_DELETE_COMPLETE',
  DELETE_ALREADY_COMPLETE: 'ATTACHMENT_DELETE_ALREADY_COMPLETE',
  DELETE_RECONCILIATION_REQUIRED: 'ATTACHMENT_DELETE_RECONCILIATION_REQUIRED',
  DELETE_FAILED: 'ATTACHMENT_DELETE_FAILED'
});

function orgScope(orgId) {
  return orgId === null || orgId === undefined || orgId === '' ? null : String(orgId);
}

function policyFor(syncOptions = {}) {
  return {
    enabled: syncOptions.syncAttachments === true,
    propagateDeletions: syncOptions.syncAttachments === true
      && syncOptions.propagateAttachmentDeletions === true
  };
}

export function getAttachmentSyncPolicy(syncOptions = {}) {
  const policy = policyFor(syncOptions);
  return Object.freeze({
    enabled: policy.enabled,
    propagateDeletions: policy.propagateDeletions,
    code: policy.enabled ? 'ATTACHMENT_SYNC_ENABLED' : ATTACHMENT_SYNC_CODES.DISABLED
  });
}

function normalizeMappingValue(mapping) {
  if (!mapping) return null;
  if (typeof mapping === 'string' || typeof mapping === 'number') {
    return isValidAttachmentId(String(mapping)) ? String(mapping) : null;
  }
  if (typeof mapping === 'object') {
    const value = mapping.destinationAttachmentId
      || mapping.remoteAttachmentId
      || mapping.remoteId
      || mapping.id;
    return isValidAttachmentId(value) ? String(value) : null;
  }
  return null;
}

function configuredMaxBytes(syncOptions) {
  const value = syncOptions?.maxAttachmentSizeBytes;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function warning(syncResult, code) {
  if (syncResult && typeof syncResult.addWarning === 'function') {
    syncResult.addWarning(code);
  }
}

function failure(syncResult, code) {
  if (syncResult && typeof syncResult.addAttachmentFailure === 'function') {
    syncResult.addAttachmentFailure(null, code);
  } else {
    warning(syncResult, code);
  }
}

function skipped(syncResult) {
  if (syncResult && typeof syncResult.addAttachmentSkipped === 'function') {
    syncResult.addAttachmentSkipped(null, 'skipped');
  }
}

function success(syncResult) {
  if (syncResult && typeof syncResult.addAttachmentSuccess === 'function') {
    syncResult.addAttachmentSuccess(null);
  }
}

function mappingForDirection(direction, sourceId, destinationId, orgId) {
  return storeAttachmentMapping(sourceId, destinationId, orgId, direction);
}

function attachmentEchoKey(side, attachmentId, orgId) {
  return `attachment-echo:${orgScope(orgId) || 'legacy'}:${side}:${attachmentId}`;
}

async function isAttachmentEcho({ side, attachmentId, orgId }) {
  if (!isValidAttachmentId(attachmentId)) return false;
  try {
    return Boolean(await kvsStore.get(attachmentEchoKey(side, attachmentId, orgId)));
  } catch {
    return false;
  }
}

async function recordAttachmentEcho({ side, attachmentId, orgId }) {
  if (!isValidAttachmentId(attachmentId)) return;
  const marker = {
    side,
    attachmentId: String(attachmentId),
    createdAt: new Date().toISOString()
  };
  try {
    if (typeof kvsStore.setWithTtl === 'function') {
      await kvsStore.setWithTtl(
        attachmentEchoKey(side, attachmentId, orgId),
        marker,
        ATTACHMENT_ECHO_TTL_SECONDS
      );
    } else {
      await kvsStore.set(attachmentEchoKey(side, attachmentId, orgId), marker);
    }
  } catch {
    // ignoreSelf plus the operation ledger remain in place; no retry occurs.
  }
}

function sourceIsLocal(direction) {
  return direction === ATTACHMENT_DIRECTIONS.LOCAL_TO_REMOTE;
}

function destinations(direction) {
  return sourceIsLocal(direction)
    ? { source: ATTACHMENT_SOURCE.LOCAL, destination: ATTACHMENT_SOURCE.REMOTE }
    : { source: ATTACHMENT_SOURCE.REMOTE, destination: ATTACHMENT_SOURCE.LOCAL };
}

async function verifyMappedPair({ direction, localKey, remoteKey, orgId }) {
  if (!isValidIssueKey(localKey) || !isValidIssueKey(remoteKey)) return false;
  if (sourceIsLocal(direction)) {
    return (await getRemoteKey(localKey, orgId)) === remoteKey;
  }
  return (await getLocalKey(remoteKey, orgId)) === localKey;
}

async function verifyDestinationProject({ direction, localKey, config }) {
  const allowedProjects = Array.isArray(config?.allowedProjects)
    ? config.allowedProjects.filter(Boolean)
    : [];
  if (allowedProjects.length === 0) return false;

  if (direction === ATTACHMENT_DIRECTIONS.REMOTE_TO_LOCAL) {
    const localIssue = await getFullIssue(localKey);
    const projectKey = localIssue?.fields?.project?.key;
    return typeof projectKey === 'string' && allowedProjects.includes(projectKey);
  }

  return true;
}

export async function resolveEffectiveAttachmentLimit({ direction, config, syncOptions = {} }) {
  const { source, destination } = destinations(direction);
  const [sourceSettings, destinationSettings] = await Promise.all([
    getAttachmentSettings({ source, config }),
    getAttachmentSettings({ source: destination, config })
  ]);

  let limit = Math.min(sourceSettings.uploadLimit, destinationSettings.uploadLimit);
  const configured = configuredMaxBytes(syncOptions);
  if (configured) {
    limit = Math.min(limit, configured);
  }

  return {
    limit,
    sourceUploadLimit: sourceSettings.uploadLimit,
    destinationUploadLimit: destinationSettings.uploadLimit,
    configuredLimit: configured
  };
}

async function enqueueAttachmentContinuation({
  orgId,
  direction,
  localKey,
  remoteKey,
  attachmentIds
}) {
  if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) return;
  try {
    const queue = new Queue({ key: ATTACHMENT_QUEUE_KEY });
    for (let offset = 0; offset < attachmentIds.length; offset += MAX_ATTACHMENT_IDS_PER_QUEUE_EVENT) {
      const chunk = attachmentIds.slice(offset, offset + MAX_ATTACHMENT_IDS_PER_QUEUE_EVENT);
      await queue.push({
        body: {
          orgId: orgScope(orgId),
          direction,
          localKey,
          remoteKey,
          attachmentIds: chunk
        }
      });
    }
  } catch {
    console.warn('ATTACHMENT_CONTINUATION_QUEUE_UNAVAILABLE');
  }
}

function collectAttachmentIds(sourceAttachments, explicitIds) {
  const raw = Array.isArray(explicitIds)
    ? explicitIds
    : (Array.isArray(sourceAttachments) ? sourceAttachments.map(item => item?.id) : []);
  const ids = [];
  const seen = new Set();
  for (const value of raw) {
    if (!isValidAttachmentId(value)) continue;
    const id = String(value);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function normalizeMimeMetadata(mimeType) {
  if (typeof mimeType !== 'string' || mimeType.trim() === '') {
    return { ok: true, mimeType: 'application/octet-stream' };
  }
  const normalized = normalizeAttachmentMimeType(mimeType);
  if (normalized === 'application/octet-stream'
      && mimeType.trim().toLowerCase() !== 'application/octet-stream') {
    return { ok: false, code: ATTACHMENT_SYNC_CODES.TYPE_REJECTED };
  }
  return { ok: true, mimeType: normalized };
}

async function markDefinitive(operation, code) {
  try {
    await markAttachmentUploadFailedDefinitive(operation, { failureCode: code });
  } catch {
    // The operation remains pending and will not be retried until its grace expires.
  }
}

async function markUnknown(operation) {
  try {
    await markAttachmentUploadUnknown(operation);
  } catch {
    // Reconciliation flags are best-effort; no upload is retried here.
  }
}

async function processOneUpload({
  direction,
  sourceAttachmentId,
  localKey,
  remoteKey,
  config,
  orgId,
  effectiveLimit,
  syncResult
}) {
  const { source, destination } = destinations(direction);
  if (await isAttachmentEcho({ side: source, attachmentId: sourceAttachmentId, orgId })) {
    skipped(syncResult);
    return { status: 'ATTACHMENT_ECHO_SUPPRESSED', destinationAttachmentId: null };
  }

  const existingMapping = normalizeMappingValue(
    await getAttachmentMapping(sourceAttachmentId, orgId, direction)
  );
  if (existingMapping) {
    skipped(syncResult);
    return {
      status: ATTACHMENT_OPERATION_CODES.ALREADY_SYNCED,
      destinationAttachmentId: existingMapping
    };
  }

  const claim = await beginAttachmentUploadOperation({
    orgId,
    direction,
    sourceAttachmentId,
    localKey,
    remoteKey
  });

  if (!claim.allowed) {
    if (claim.code === ATTACHMENT_OPERATION_CODES.ALREADY_SYNCED
        && isValidAttachmentId(claim.operation?.destinationAttachmentId)) {
      const destinationAttachmentId = String(claim.operation.destinationAttachmentId);
      await mappingForDirection(direction, sourceAttachmentId, destinationAttachmentId, orgId);
      skipped(syncResult);
      return { status: claim.code, destinationAttachmentId };
    }
    if (claim.code === ATTACHMENT_OPERATION_CODES.RECONCILIATION_REQUIRED) {
      warning(syncResult, ATTACHMENT_SYNC_CODES.RECONCILIATION_REQUIRED);
    }
    skipped(syncResult);
    return { status: claim.code, destinationAttachmentId: null };
  }

  const operation = claim.operation;
  let writeStarted = false;

  try {
    const metadata = await getAttachmentMetadata({
      source,
      attachmentId: sourceAttachmentId,
      config
    });

    const filenameResult = sanitizeAttachmentFilename(metadata.filename);
    if (!filenameResult.ok) {
      await markDefinitive(operation, filenameResult.code);
      failure(syncResult, filenameResult.code);
      return { status: filenameResult.code, destinationAttachmentId: null };
    }

    const mimeResult = normalizeMimeMetadata(metadata.mimeType);
    if (!mimeResult.ok) {
      await markDefinitive(operation, mimeResult.code);
      failure(syncResult, mimeResult.code);
      return { status: mimeResult.code, destinationAttachmentId: null };
    }

    if (metadata.size > effectiveLimit.limit) {
      await markDefinitive(operation, ATTACHMENT_SYNC_CODES.SIZE_REJECTED);
      failure(syncResult, ATTACHMENT_SYNC_CODES.SIZE_REJECTED);
      return { status: ATTACHMENT_SYNC_CODES.SIZE_REJECTED, destinationAttachmentId: null };
    }

    await assertPilotWritesAllowed('attachment_download');
    const bytes = await downloadAttachmentContent({
      source,
      attachmentId: sourceAttachmentId,
      config,
      maxBytes: effectiveLimit.limit
    });

    await assertPilotWritesAllowed('attachment_upload');
    // Metadata retrieval, validation and download are complete. Only now may
    // the POST be issued, so persist the write boundary immediately before it.
    const submission = await markAttachmentWriteStarted(operation);
    if (!submission.ok) {
      skipped(syncResult);
      return { status: submission.code, destinationAttachmentId: null };
    }
    writeStarted = true;

    const uploaded = await uploadAttachmentContent({
      source: destination,
      issueKey: sourceIsLocal(direction) ? remoteKey : localKey,
      filename: filenameResult.filename,
      mimeType: mimeResult.mimeType,
      fileBuffer: bytes,
      config,
      maxBytes: effectiveLimit.limit
    });

    const completed = await markAttachmentUploadSucceeded(operation, {
      destinationAttachmentId: uploaded.id
    });
    if (!completed.success) {
      warning(syncResult, ATTACHMENT_SYNC_CODES.RECONCILIATION_REQUIRED);
      return { status: completed.code, destinationAttachmentId: null };
    }

    await recordAttachmentEcho({
      side: destination,
      attachmentId: uploaded.id,
      orgId
    });

    try {
      await mappingForDirection(direction, sourceAttachmentId, uploaded.id, orgId);
    } catch {
      warning(syncResult, ATTACHMENT_SYNC_CODES.RECONCILIATION_REQUIRED);
      return { status: 'ATTACHMENT_MAPPING_WRITE_FAILED', destinationAttachmentId: uploaded.id };
    }

    success(syncResult);
    return { status: 'ATTACHMENT_SYNCED', destinationAttachmentId: uploaded.id };
  } catch (error) {
    const clientCode = error instanceof AttachmentClientError
      ? error.code
      : (writeStarted ? ATTACHMENT_CLIENT_CODES.UPLOAD_OUTCOME_UNKNOWN : 'ATTACHMENT_SYNC_FAILED');

    if (writeStarted && (error?.ambiguous || !(error instanceof AttachmentClientError))) {
      await markUnknown(operation);
      failure(syncResult, ATTACHMENT_SYNC_CODES.RECONCILIATION_REQUIRED);
      return {
        status: ATTACHMENT_SYNC_CODES.RECONCILIATION_REQUIRED,
        destinationAttachmentId: null
      };
    }

    await markDefinitive(operation, clientCode);
    failure(syncResult, clientCode);
    return { status: clientCode, destinationAttachmentId: null };
  }
}


async function syncAttachmentDirection({
  direction,
  localKey,
  remoteKey,
  issue = null,
  sourceAttachments = [],
  config,
  syncResult = null,
  orgId = null,
  syncOptions = {},
  attachmentIds = null
}) {
  const mapping = {};
  const policy = policyFor(syncOptions);
  if (!policy.enabled) {
    return mapping;
  }
  if (syncOptions.dryRun) {
    return mapping;
  }

  if (direction === ATTACHMENT_DIRECTIONS.REMOTE_TO_LOCAL
      && config?.syncDirection !== 'bidirectional') {
    warning(syncResult, ATTACHMENT_SYNC_CODES.UNMAPPED);
    return mapping;
  }

  if (!(await verifyMappedPair({ direction, localKey, remoteKey, orgId }))) {
    warning(syncResult, ATTACHMENT_SYNC_CODES.UNMAPPED);
    return mapping;
  }

  if (direction === ATTACHMENT_DIRECTIONS.LOCAL_TO_REMOTE) {
    const projectKey = issue?.fields?.project?.key;
    const allowedProjects = Array.isArray(config?.allowedProjects)
      ? config.allowedProjects.filter(Boolean)
      : [];
    if (!projectKey || !allowedProjects.includes(projectKey)) {
      warning(syncResult, ATTACHMENT_SYNC_CODES.PROJECT_BLOCKED);
      return mapping;
    }
  } else if (!(await verifyDestinationProject({ direction, localKey, config }))) {
    warning(syncResult, ATTACHMENT_SYNC_CODES.PROJECT_BLOCKED);
    return mapping;
  }

  let effectiveLimit;
  try {
    effectiveLimit = await resolveEffectiveAttachmentLimit({ direction, config, syncOptions });
  } catch (error) {
    warning(syncResult, error?.code || ATTACHMENT_SYNC_CODES.SETTINGS_UNAVAILABLE);
    return mapping;
  }

  const ids = collectAttachmentIds(sourceAttachments, attachmentIds);
  if (ids.length === 0) {
    return mapping;
  }

  const bounded = ids.slice(0, MAX_ATTACHMENTS_PER_INVOCATION);
  const remaining = ids.slice(MAX_ATTACHMENTS_PER_INVOCATION);
  if (remaining.length > 0) {
    await enqueueAttachmentContinuation({
      orgId,
      direction,
      localKey,
      remoteKey,
      attachmentIds: remaining
    });
  }

  for (const sourceAttachmentId of bounded) {
    try {
      const result = await processOneUpload({
        direction,
        sourceAttachmentId,
        localKey,
        remoteKey,
        config,
        orgId,
        effectiveLimit,
        syncResult
      });
      if (result.destinationAttachmentId) {
        mapping[sourceAttachmentId] = result.destinationAttachmentId;
      }
    } catch (error) {
      failure(syncResult, safeErrorSummary(error?.code || 'ATTACHMENT_SYNC_FAILED'));
    }
  }

  return mapping;
}

export async function syncAttachments(
  localIssueKey,
  remoteIssueKey,
  issue,
  config,
  syncResult = null,
  orgId = null,
  forceCheck = false,
  options = {}
) {
  void forceCheck;
  return await syncAttachmentDirection({
    direction: ATTACHMENT_DIRECTIONS.LOCAL_TO_REMOTE,
    localKey: localIssueKey,
    remoteKey: remoteIssueKey,
    issue,
    sourceAttachments: issue?.fields?.attachment,
    config,
    syncResult,
    orgId,
    syncOptions: options.syncOptions || {},
    attachmentIds: options.attachmentIds || null
  });
}

export async function syncRemoteAttachmentsToLocal(
  remoteIssueKey,
  localIssueKey,
  remoteIssue,
  config,
  syncResult = null,
  orgId = null,
  options = {}
) {
  return await syncAttachmentDirection({
    direction: ATTACHMENT_DIRECTIONS.REMOTE_TO_LOCAL,
    localKey: localIssueKey,
    remoteKey: remoteIssueKey,
    issue: remoteIssue,
    sourceAttachments: remoteIssue?.fields?.attachment,
    config,
    syncResult,
    orgId,
    syncOptions: options.syncOptions || {},
    attachmentIds: options.attachmentIds || null
  });
}

/**
 * Propagate one explicit attachment deletion. The counterpart attachment is
 * deleted only when deletion propagation is enabled, the issues remain mapped,
 * and this exact source attachment has an active direction-scoped mapping.
 */
export async function propagateAttachmentDeletion({
  direction,
  sourceAttachmentId,
  localKey,
  remoteKey,
  config,
  orgId = null,
  syncOptions = {}
}) {
  const policy = policyFor(syncOptions);
  if (!policy.enabled || !policy.propagateDeletions) {
    return { status: ATTACHMENT_SYNC_CODES.DELETE_DISABLED };
  }
  if (direction === ATTACHMENT_DIRECTIONS.REMOTE_TO_LOCAL
      && config?.syncDirection !== 'bidirectional') {
    return { status: ATTACHMENT_SYNC_CODES.DELETE_DISABLED };
  }
  if (!isValidAttachmentId(sourceAttachmentId)
      || !(await verifyMappedPair({ direction, localKey, remoteKey, orgId }))) {
    return { status: ATTACHMENT_SYNC_CODES.DELETE_UNMAPPED };
  }

  const mappedDestinationAttachmentId = normalizeMappingValue(
    await getAttachmentMapping(sourceAttachmentId, orgId, direction)
  );
  if (!mappedDestinationAttachmentId) {
    return { status: ATTACHMENT_SYNC_CODES.DELETE_UNMAPPED };
  }

  const claim = await beginAttachmentDeletionOperation({
    orgId,
    direction,
    sourceAttachmentId,
    localKey,
    remoteKey,
    mappedDestinationAttachmentId
  });
  if (!claim.allowed) {
    if (claim.code === ATTACHMENT_OPERATION_CODES.DELETE_ALREADY_DONE) {
      return { status: ATTACHMENT_SYNC_CODES.DELETE_ALREADY_COMPLETE };
    }
    if (claim.code === ATTACHMENT_OPERATION_CODES.DELETE_RECONCILIATION_REQUIRED) {
      return { status: ATTACHMENT_SYNC_CODES.DELETE_RECONCILIATION_REQUIRED };
    }
    return { status: ATTACHMENT_SYNC_CODES.DELETE_FAILED, code: claim.code };
  }

  const { destination } = destinations(direction);
  let writeStarted = false;
  try {
    await assertPilotWritesAllowed('attachment_delete');
    // Persist the DELETE boundary immediately before the request. If the
    // invocation ends here or later without a confirmed result, retries stop.
    const started = await markAttachmentDeletionWriteStarted(claim.operation);
    if (!started.ok) {
      return { status: ATTACHMENT_SYNC_CODES.DELETE_FAILED, code: started.code };
    }
    writeStarted = true;

    const result = await deleteAttachmentContent({
      source: destination,
      attachmentId: mappedDestinationAttachmentId,
      config
    });
    const marked = await markAttachmentDeletionSucceeded(claim.operation);
    if (!marked.success) {
      return {
        status: ATTACHMENT_SYNC_CODES.DELETE_RECONCILIATION_REQUIRED,
        code: marked.code
      };
    }

    await storeAttachmentMappingHistory({
      orgId,
      direction,
      sourceAttachmentId,
      destinationAttachmentId: mappedDestinationAttachmentId,
      localKey,
      remoteKey,
      outcome: result.alreadyDeleted ? 'already_deleted' : 'deleted'
    });
    await removeAttachmentMapping(sourceAttachmentId, orgId, direction);
    return {
      status: result.alreadyDeleted
        ? ATTACHMENT_SYNC_CODES.DELETE_ALREADY_COMPLETE
        : ATTACHMENT_SYNC_CODES.DELETE_COMPLETE
    };
  } catch (error) {
    if (writeStarted && (error?.ambiguous || !(error instanceof AttachmentClientError))) {
      try {
        await markAttachmentDeletionUnknown(claim.operation);
      } catch {
        // Preserve the mapping and do not retry an ambiguous DELETE.
      }
      return { status: ATTACHMENT_SYNC_CODES.DELETE_RECONCILIATION_REQUIRED };
    }
    try {
      await markAttachmentDeletionFailedDefinitive(claim.operation, {
        failureCode: error?.code || 'ATTACHMENT_DELETE_REJECTED'
      });
    } catch {
      // Mapping is retained for a later manual review.
    }
    return { status: ATTACHMENT_SYNC_CODES.DELETE_FAILED, code: error?.code || null };
  }
}

/**
 * Administrator-only reconciliation for an ambiguous upload. The caller must
 * name the exact destination attachment ID. This function performs no content
 * upload and no deletion.
 */
export async function reconcileAttachmentOperation({
  orgId,
  direction,
  sourceAttachmentId,
  destinationAttachmentId,
  config
}) {
  if (!isValidAttachmentId(sourceAttachmentId)
      || !isValidAttachmentId(destinationAttachmentId)
      || (direction !== ATTACHMENT_DIRECTIONS.LOCAL_TO_REMOTE
        && direction !== ATTACHMENT_DIRECTIONS.REMOTE_TO_LOCAL)) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.INVALID };
  }

  const operation = await getAttachmentOperation({
    orgId,
    direction,
    sourceAttachmentId,
    operationType: ATTACHMENT_OPERATION_TYPES.UPLOAD
  });
  if (!operation) {
    return { success: false, code: ATTACHMENT_OPERATION_CODES.NOT_FOUND };
  }
  if (operation.state === ATTACHMENT_OPERATION_STATES.SUCCEEDED) {
    if (operation.destinationAttachmentId !== String(destinationAttachmentId)) {
      return { success: false, code: ATTACHMENT_SYNC_CODES.MAPPING_CONFLICT };
    }
  } else if (operation.state !== ATTACHMENT_OPERATION_STATES.UNKNOWN) {
    return {
      success: false,
      code: ATTACHMENT_OPERATION_CODES.INVALID_STATE,
      operation: sanitizeAttachmentOperation(operation)
    };
  }

  const { localKey, remoteKey } = operation;
  if (!(await verifyMappedPair({ direction, localKey, remoteKey, orgId }))) {
    return { success: false, code: ATTACHMENT_SYNC_CODES.UNMAPPED };
  }

  const existingMapping = normalizeMappingValue(
    await getAttachmentMapping(sourceAttachmentId, orgId, direction)
  );
  if (existingMapping && existingMapping !== String(destinationAttachmentId)) {
    return { success: false, code: ATTACHMENT_SYNC_CODES.MAPPING_CONFLICT };
  }

  const { source, destination } = destinations(direction);
  const destinationIssueKey = sourceIsLocal(direction) ? remoteKey : localKey;

  let destinationAttachments;
  let sourceMetadata;
  let destinationMetadata;
  try {
    destinationAttachments = await getIssueAttachments({
      source: destination,
      issueKey: destinationIssueKey,
      config
    });
    if (!destinationAttachments.some(item => item.id === String(destinationAttachmentId))) {
      return { success: false, code: ATTACHMENT_CLIENT_CODES.NOT_FOUND };
    }
    sourceMetadata = await getAttachmentMetadata({
      source,
      attachmentId: sourceAttachmentId,
      config
    });
    destinationMetadata = await getAttachmentMetadata({
      source: destination,
      attachmentId: destinationAttachmentId,
      config
    });
  } catch (error) {
    return {
      success: false,
      code: error?.code || ATTACHMENT_CLIENT_CODES.METADATA_UNAVAILABLE
    };
  }

  if (sourceMetadata.size !== destinationMetadata.size
      || normalizeAttachmentMimeType(sourceMetadata.mimeType)
        !== normalizeAttachmentMimeType(destinationMetadata.mimeType)) {
    return { success: false, code: 'ATTACHMENT_METADATA_MISMATCH' };
  }

  const resolution = await resolveAttachmentUploadOperation({
    operation,
    destinationAttachmentId
  });
  if (!resolution.success) {
    return {
      success: false,
      code: resolution.code || ATTACHMENT_OPERATION_CODES.INVALID_STATE
    };
  }

  await mappingForDirection(direction, sourceAttachmentId, destinationAttachmentId, orgId);
  return {
    success: true,
    code: resolution.code,
    idempotent: resolution.idempotent === true,
    operation: sanitizeAttachmentOperation(resolution.operation)
  };
}

/**
 * Bounded queue consumer for attachment IDs that did not fit in the invoking
 * function. Payloads contain identifiers and issue keys only.
 */
export async function runAttachmentSyncQueue(event) {
  const body = event?.body || event?.payload;
  if (!body || typeof body !== 'object') {
    return { success: false, code: 'ATTACHMENT_QUEUE_INVALID' };
  }

  const { direction, localKey, remoteKey } = body;
  if ((direction !== ATTACHMENT_DIRECTIONS.LOCAL_TO_REMOTE
      && direction !== ATTACHMENT_DIRECTIONS.REMOTE_TO_LOCAL)
      || !isValidIssueKey(localKey)
      || !isValidIssueKey(remoteKey)) {
    return { success: false, code: 'ATTACHMENT_QUEUE_INVALID' };
  }

  const attachmentIds = collectAttachmentIds([], body.attachmentIds)
    .slice(0, MAX_ATTACHMENT_IDS_PER_QUEUE_EVENT);
  if (attachmentIds.length === 0) {
    return { success: false, code: 'ATTACHMENT_QUEUE_INVALID' };
  }

  const orgId = orgScope(body.orgId);
  const organizations = await kvsStore.get('organizations') || [];
  let org = orgId ? organizations.find(candidate => candidate.id === orgId) : null;
  if (!org && !orgId) {
    const legacyConfig = await kvsStore.get('syncConfig');
    if (legacyConfig?.remoteUrl) {
      org = { ...legacyConfig, id: 'legacy' };
    }
  }
  if (!org) {
    return { success: false, code: 'ATTACHMENT_QUEUE_ORGANIZATION_NOT_FOUND' };
  }

  const storageOrgId = org.id === 'legacy' ? null : org.id;
  const token = await kvsStore.getSecret(
    storageOrgId ? `secret:${storageOrgId}:token` : 'secret:legacy:token'
  );
  if (!token) {
    return { success: false, code: 'ATTACHMENT_QUEUE_CREDENTIALS_UNAVAILABLE' };
  }

  const config = { ...org, remoteApiToken: token };
  const syncOptions = await kvsStore.get(
    storageOrgId ? `syncOptions:${storageOrgId}` : 'syncOptions'
  ) || {};
  const policy = policyFor(syncOptions);
  if (!policy.enabled) {
    return { success: true, skipped: true, code: ATTACHMENT_SYNC_CODES.DISABLED };
  }

  if (direction === ATTACHMENT_DIRECTIONS.LOCAL_TO_REMOTE) {
    const issue = await getFullIssue(localKey);
    if (!issue) {
      return { success: false, code: 'ATTACHMENT_QUEUE_SOURCE_UNAVAILABLE' };
    }
    await syncAttachments(
      localKey,
      remoteKey,
      issue,
      config,
      null,
      storageOrgId,
      true,
      { syncOptions, attachmentIds }
    );
  } else {
    const remoteIssue = await getRemoteIssue(remoteKey, config, ['attachment']);
    if (!remoteIssue) {
      return { success: false, code: 'ATTACHMENT_QUEUE_SOURCE_UNAVAILABLE' };
    }
    await syncRemoteAttachmentsToLocal(
      remoteKey,
      localKey,
      remoteIssue,
      config,
      null,
      storageOrgId,
      { syncOptions, attachmentIds }
    );
  }

  return {
    success: true,
    processed: Math.min(attachmentIds.length, MAX_ATTACHMENTS_PER_INVOCATION)
  };
}
