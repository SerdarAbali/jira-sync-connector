import { claimInboundCommentSubmission, readInboundCommentReceipt, recordInboundCommentReceipt } from './inbound-comment-submission.js';
import { runWithIssueLease } from './issue-lease-context.js';
const BASE_REMOTE_FIELDS = [
  'summary',
  'description',
  'priority',
  'labels',
  'duedate',
  'components',
  'fixVersions',
  'versions',
  'timetracking',
  'assignee',
  'reporter',
  'parent',
  'status',
  'issuetype',
  'attachment',
  'issuelinks'
];

const BLOCKED_FIELD_KEYS = new Set([
  'project',
  'issuetype',
  'status',
  'summary',
  'description',
  'priority',
  'labels',
  'duedate',
  'components',
  'fixVersions',
  'versions',
  'timetracking',
  'assignee',
  'reporter',
  'parent',
  'resolution',
  'resolutiondate',
  'creator',
  'created',
  'updated',
  'worklog',
  'comment',
  'attachment',
  'subtasks',
  'progress',
  'watches'
]);
import api, { fetch, route } from '../jira/guarded-api.js';
import * as kvsStore from '../storage/kvs.js';
import { recordAuthenticatedWebhookReceipt } from '../storage/webhook-receipt.js';
import { getLocalKey, storeMapping, ensureMappingPair, storeLinkMapping, getLinkMapping, removeLinkMapping, getLocalCommentId, storeCommentMapping, replaceIssueMapping } from '../storage/mappings.js';
import { markSyncing, isSyncing, clearSyncFlag, enqueuePendingChildIssue, consumePendingChildIssues } from '../storage/flags.js';
import { recordRejectedFields } from '../storage/rejected-fields.js';
import { logAuditEntry } from '../storage/stats.js';
import { LOG_EMOJI } from '../../constants.js';
import { textToADF, buildSyncedCommentADF, extractTextFromADF, stripSyncPrefix, sanitizeCommentText, stripCounterpartNoticeFromADF, isConnectorGeneratedComment } from '../../utils/adf.js';
import { getRemoteIssue, getRemoteComment } from '../jira/remote-client.js';
import { getCommentConfidentiality, verifyCommentThread, commentParentId, withParentHints, verifyFreshCommentThread } from './comment-confidentiality.js';
import { commentReadBudget } from '../jira/comment-read.js';
import { getCommentProjectType } from '../jira/comment-project.js';
import { deferCommentVerification, markDeferredCommentSubmission, assertCommentVerificationReady, rejectDeferredCommentAncestry } from './comment-verification-recovery.js';
import { syncRemoteAttachmentsToLocal, propagateAttachmentDeletion, getAttachmentSyncPolicy } from './attachment-sync.js';
import { isValidAttachmentId, isValidIssueKey } from '../../utils/attachment-url.js';
import { transitionLocalIssue } from './transition-sync.js';
import { mapUserToLocal } from '../../utils/mapping.js';
import { createHmac, timingSafeEqual } from 'crypto';
import { claimWebhookEvent, markWebhookCompleted, releaseWebhookEvent } from './webhook-replay.js';
import { hashSynchronizedFields } from './field-normalization.js';
import { resolveLocalDestinationHash } from './destination-state.js';
import { acquireIssueLease, releaseIssueLease } from './issue-lease.js';
import {
  findAppCausedEcho,
  getLatestAccepted,
  evaluateStaleEvent,
  recordLatestAccepted,
  recordDestinationWrite,
  recordConflict,
  SYNC_DECISIONS
} from './sync-state.js';
import { recordSyncDecision } from './sync-observability.js';
import { formatHttpFailure } from '../../utils/http-error.js';
import { getPilotPause, assertPilotWritesAllowed } from './pilot-pause.js';
import {
  COUNTERPART_DELETED_SIDES,
  COUNTERPART_STATUS_VALUES,
  getCounterpartStatus,
  recordCounterpartStatus,
  resolveCounterpartStatus
} from './counterpart-status.js';
import { assertInboundScope, isInboundScopeError, InboundScopeError } from './inbound-scope.js';
import { retainPostCreateAttachments, resumePostCreateAttachments } from './post-create-attachments.js';
import { setCounterpartNotice } from './counterpart-probe.js';
import { maybeAutoReplaceAfterDeletion } from './counterpart-recovery.js';
import {
  beginIssueCreateOperation,
  markIssueCreateSubmissionStarted,
  markIssueCreateSucceeded,
  markIssueCreateUnknown,
  markIssueCreateFailedDefinitive,
  isDefinitiveCreateRejection,
  ISSUE_CREATE_CODES,
  ISSUE_CREATE_DIRECTIONS
} from './issue-create-operation.js';
import {
  evaluatePairWitnessCreateGuard,
  syncDecisionForGuardCode,
  PAIR_WITNESS_GUARD_DECISIONS
} from './pair-witness-guard.js';
import {
  establishPairWitness,
  recordWitnessPersistenceFailure,
  WITNESS_ESTABLISHMENT_OUTCOMES
} from './pair-witness-establishment.js';

const PARENT_MAPPING_RETRY_ATTEMPTS = 6;
const PARENT_MAPPING_RETRY_DELAY_MS = 500;
const PENDING_CHILD_MAX_ATTEMPTS = 3;

function remoteMappedFieldIds(fieldMappings) {
  return Object.keys(fieldMappings || {}).filter(id => id.startsWith('customfield_'));
}

function hashRemoteFields(fields, context) {
  return hashSynchronizedFields(fields, {
    customFieldIds: remoteMappedFieldIds(context?.mappings?.fieldMappings),
    includeStatus: true
  });
}

export const WEBHOOK_ORG_ID_PATTERN = /^org-\d{1,32}(?![\s\S])/;
export const WEBHOOK_EVENT_NAME_PATTERN = /^[A-Za-z0-9:_-]{1,100}$/;
const WEBHOOK_UNAUTHORIZED_BODY = { error: 'Unauthorized' };

function webhookUnauthorized() {
  return { status: 401, body: WEBHOOK_UNAUTHORIZED_BODY };
}

export const KNOWN_WEBHOOK_EVENTS = new Set([
  'jira:issue_created',
  'jira:issue_updated',
  'jira:issue_deleted',
  'comment_created',
  'jira:issue_link_created',
  'jira:issue_link_deleted',
  'issuelink_created',
  'issuelink_deleted',
  'attachment_created',
  'jira:attachment_created',
  'attachment_deleted',
  'jira:attachment_deleted'
]);

// External authentication always verifies the original Forge body string before parsing.
export async function processIncomingWebhook(rawBody, auth) {
  if (typeof rawBody !== 'string' || !auth || !WEBHOOK_ORG_ID_PATTERN.test(auth.orgId)
      || typeof auth.signature !== 'string' || auth.signature.length !== 71 || !/^sha256=[a-fA-F0-9]{64}$/.test(auth.signature)) {
    return webhookUnauthorized();
  }
  let org;
  try {
    const orgs = await kvsStore.get('organizations') || [];
    org = orgs.find(candidate => candidate.id === auth.orgId);
    if (!org) return webhookUnauthorized();
    const secret = await kvsStore.getSecret(`secret:${auth.orgId}:webhookSigningSecret`);
    if (typeof secret !== 'string' || !secret) return webhookUnauthorized();
    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
    const supplied = Buffer.from(auth.signature.slice(7), 'hex');
    if (!timingSafeEqual(expected, supplied)) return webhookUnauthorized();
  } catch {
    return webhookUnauthorized();
  }
  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { return { status: 400, body: { error: 'Invalid JSON body' } }; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || typeof payload.webhookEvent !== 'string' || !KNOWN_WEBHOOK_EVENTS.has(payload.webhookEvent)) {
    return { status: 400, body: { error: 'Invalid webhook payload' } };
  }
  if (org.syncDirection !== 'bidirectional') {
    return { status: 403, body: { error: 'Incoming sync is not enabled' } };
  }
  await recordAuthenticatedWebhookReceipt(org.id, payload.webhookEvent);
  return processIncomingPayload(payload, org);
}

function isRecoveryCommentId(value) {
  return (typeof value === 'string' || (Number.isSafeInteger(value) && value > 0))
    && /^[A-Za-z0-9_-]{1,100}(?![\s\S])/.test(String(value));
}

// Server-only dispatch. The heartbeat supplies persisted identifiers, never URL credentials.
export async function recoverIncomingComment(record) {
  if (!record || record.direction !== 'remote-to-local'
      || !WEBHOOK_ORG_ID_PATTERN.test(record.orgId)
      || !isValidIssueKey(record.issueKey)
      || !isRecoveryCommentId(record.commentId)
      || (record.parentId != null && !isRecoveryCommentId(record.parentId))) {
    return { status: 'CANCELLED' };
  }
  const orgs = await kvsStore.get('organizations') || [];
  const org = orgs.find(candidate => candidate.id === record.orgId);
  if (!org) return { status: 'CANCELLED' };
  return processIncomingPayload({ webhookEvent: 'comment_created', issue: { key: record.issueKey },
    comment: { id: record.commentId, ...(record.parentId ? { parentId: record.parentId } : {}) } },
  org, { commentAncestry: record.ancestry });
}

async function processIncomingPayload(payload, org, recovery = {}) {
  const orgId = org.id;
  const { webhookEvent } = payload;
  if (org.syncDirection !== 'bidirectional') {
    console.warn('Incoming webhook rejected: bidirectional sync not enabled');
    return { status: 403, body: { error: 'Incoming sync is not enabled' } };
  }

  // Acknowledge and discard writes while paused. The event is not queued or
  // replayed later, so resume cannot trigger backfill or recreation.
  const pause = await getPilotPause();
  if (pause.paused) {
    return {
      status: 200,
      body: { message: 'Jira writes are paused', state: 'paused' }
    };
  }

  const remoteApiToken = await kvsStore.getSecret(`secret:${orgId}:token`);
  if (!remoteApiToken) {
    console.error('Incoming webhook missing remote credentials');
    return { status: 500, body: { error: 'Webhook processing unavailable' } };
  }

  const storageOrgId = org.id === 'legacy' ? null : org.id;
  const [userMappings, fieldMappings, statusMappings, issueTypeMappings, syncOptions] = await Promise.all([
    kvsStore.get(storageOrgId ? `userMappings:${storageOrgId}` : 'userMappings'),
    kvsStore.get(storageOrgId ? `fieldMappings:${storageOrgId}` : 'fieldMappings'),
    kvsStore.get(storageOrgId ? `statusMappings:${storageOrgId}` : 'statusMappings'),
    kvsStore.get(storageOrgId ? `issueTypeMappings:${storageOrgId}` : 'issueTypeMappings'),
    kvsStore.get(storageOrgId ? `syncOptions:${storageOrgId}` : 'syncOptions')
  ]);

  const context = {
    commentAncestry: recovery.commentAncestry,
    org: { ...org, remoteApiToken },
    orgId: storageOrgId,
    mappings: {
      userMappings: userMappings?.mappings || userMappings || {},
      fieldMappings: fieldMappings || {},
      statusMappings: statusMappings || {},
      issueTypeMappings: issueTypeMappings || {}
    },
    syncOptions: syncOptions || {},
    userMappingConfig: userMappings?.config || { autoMapUsers: true, fallbackUser: null }
  };

  const { issue } = payload;
  
  if (!issue) {
      if (isAttachmentEvent(webhookEvent)) {
        console.log(`${LOG_EMOJI.WARNING} Attachment webhook missing issue payload`);
      } else if (isIssueLinkEvent(webhookEvent)) {
        console.log(`${LOG_EMOJI.WARNING} Issue-link webhook does not contain a top-level issue payload`);
      } else {
        return { status: 400, body: { error: 'No issue in payload' } };
      }
  }

  // Duplicate suppression uses a deterministic payload fingerprint. A fresh
  // marker is claimed atomically; completed markers suppress duplicates and
  // processing markers prevent concurrent duplicate execution.
  // Comment identity is stable across external delivery and durable recovery.
  const markerPayload = webhookEvent === 'comment_created'
    ? { webhookEvent, issue: { key: payload.issue?.key }, comment: { id: payload.comment?.id } }
    : payload;
  const claim = await claimWebhookEvent(markerPayload, orgId);
  if (claim.status === 'completed') {
    return { status: 200, body: { message: 'Duplicate event ignored', ...(webhookEvent === 'comment_created' ? { code: 'COMMENT_ALREADY_MAPPED' } : {}) } };
  }
  if (claim.status === 'processing') {
    return { status: 409, body: { error: 'Request is already being processed' } };
  }
  if (claim.status === 'storage_error') {
    return { status: 503, body: { error: 'Webhook processing temporarily unavailable' } };
  }
  const markerKey = claim.status === 'claimed' ? claim.key : null;
  const markerToken = claim.status === 'claimed' ? claim.token : null;

  // 2. Route Event
  let routeResult = null;
  try {
    if (webhookEvent === 'jira:issue_created') {
      routeResult = await handleRemoteIssueCreated(issue, context);
    } else if (webhookEvent === 'jira:issue_updated') {
      await handleRemoteIssueUpdated(issue, context, payload);
    } else if (webhookEvent === 'jira:issue_deleted') {
      await handleRemoteIssueDeleted(issue, context);
    } else if (webhookEvent === 'comment_created') {
      routeResult = await handleRemoteCommentCreated(payload, context);
    } else if (webhookEvent === 'jira:issue_link_created' || webhookEvent === 'issuelink_created') {
      routeResult = await handleRemoteIssueLinkCreated(payload, context);
    } else if (webhookEvent === 'jira:issue_link_deleted' || webhookEvent === 'issuelink_deleted') {
      routeResult = await handleRemoteIssueLinkDeleted(payload, context);
    } else if (webhookEvent === 'attachment_created' || webhookEvent === 'jira:attachment_created') {
      console.log(`${LOG_EMOJI.ATTACHMENT} Routing attachment event for ${payload.issue?.key || 'unknown issue'}`);
      routeResult = await handleRemoteAttachmentCreated(payload, context);
    } else if (webhookEvent === 'attachment_deleted' || webhookEvent === 'jira:attachment_deleted') {
      routeResult = await handleRemoteAttachmentDeleted(payload, context);
    } else {
      console.log(`ℹ️ Ignoring event: ${webhookEvent}`);
    }

    if (webhookEvent === 'comment_created' && routeResult?.status === 'COMMENT_RETRY') {
      if (markerKey) await releaseWebhookEvent(markerKey, markerToken);
      return { status: 202, body: { code: 'COMMENT_RETRY' } };
    }

    if (markerKey) {
      try {
        const completion = await markWebhookCompleted(markerKey, markerToken);
        if (!completion?.completed) {
          await releaseWebhookEvent(markerKey, markerToken);
          return { status: 503, body: { error: 'Webhook processing temporarily unavailable' } };
        }
      } catch {
        await releaseWebhookEvent(markerKey, markerToken);
        return { status: 503, body: { error: 'Webhook processing temporarily unavailable' } };
      }
    }

    const responseBody = { message: 'Processed' };
    if (webhookEvent === 'comment_created' && typeof routeResult?.status === 'string') responseBody.code = routeResult.status;
    if (routeResult?.status === 'COMMENT_RECONCILIATION_REQUIRED') {
      responseBody.code = routeResult.status;
    }
    if (typeof routeResult?.code === 'string') {
      responseBody.code = routeResult.code;
    }
    return { status: 200, body: responseBody };
  } catch (error) {
    if (isInboundScopeError(error)) {
      if (error.retryable) {
        try {
          if (webhookEvent === 'comment_created') await deferIncomingCommentVerification(payload, orgId, error);
        } catch (failure) {
          if (markerKey) await releaseWebhookEvent(markerKey, markerToken);
          if (failure.code === 'COMMENT_REJECTED') return { status: 200, body: { code: failure.code } };
          return { status: 503, body: { code: error.code, reason: 'RECOVERY_STORAGE_UNAVAILABLE' } };
        }
        if (markerKey) await releaseWebhookEvent(markerKey, markerToken);
        return { status: 503, body: { code: error.code, reason: error.reason } };
      }
      if (markerKey) await releaseWebhookEvent(markerKey, markerToken);
      return { status: 200, body: { code: error.code, reason: error.reason } };
    }
    if (webhookEvent === 'comment_created' && error?.code === 'COMMENT_REJECTED') {
      if (markerKey) {
        const completion = await markWebhookCompleted(markerKey, markerToken);
        if (!completion?.completed) return { status: 503, body: { error: 'Webhook processing temporarily unavailable' } };
      }
      return { status: 200, body: { code: 'COMMENT_REJECTED' } };
    }
    if (webhookEvent === 'comment_created' && error?.code === 'COMMENT_VERIFICATION_DEFERRED') {
      try {
        await deferIncomingCommentVerification(payload, orgId, error);
        if (markerKey) await releaseWebhookEvent(markerKey, markerToken);
        return { status: 202, body: { code: 'COMMENT_VERIFICATION_DEFERRED', message: 'Verification deferred' } };
      } catch (failure) {
        if (markerKey) await releaseWebhookEvent(markerKey, markerToken);
        if (failure.code === 'COMMENT_REJECTED') return { status: 200, body: { code: failure.code } };
        return { status: 503, body: { error: 'Verification recovery unavailable' } };
      }
    }
    if (error?.code === 'COMMENT_RECONCILIATION_REQUIRED') {
      // The comment may have been created. Do not release the replay marker
      // for a blind retry; a content-free reconciliation record is already
      // persisted (or persistence itself failed, which is also unsafe to retry).
      if (markerKey && error.persisted !== false) {
        try {
          await markWebhookCompleted(markerKey, markerToken);
        } catch {
          // Leave the processing marker to expire; never release it here.
        }
      }
      return {
        status: error.persisted === false ? 503 : 202,
        body: {
          message: 'Comment reconciliation required',
          code: 'COMMENT_RECONCILIATION_REQUIRED'
        }
      };
    }

    if (markerKey) {
      await releaseWebhookEvent(markerKey, markerToken);
    }
    if (error?.code === 'MAPPING_CONFLICT') {
      await recordSyncDecision({
        decision: SYNC_DECISIONS.MAPPING_CONFLICT,
        orgId,
        localKey: error.details?.localKey || null,
        remoteKey: error.details?.remoteKey || payload?.issue?.key || null,
        reason: 'mapping_conflict'
      });
      return { status: 409, body: { error: 'MAPPING_CONFLICT' } };
    }
    if (error?.code === 'PILOT_PAUSED') {
      return { status: 200, body: { message: 'Jira writes are paused', state: 'paused' } };
    }
    console.error(`${LOG_EMOJI.ERROR} Error processing incoming webhook:`, error);
    return { status: 500, body: { error: 'Webhook processing unavailable' } };
  }
}

const MAX_ISSUE_WRITE_ATTEMPTS = 4;

/**
 * Extract the field keys Jira rejected from an error response body.
 * Jira returns e.g. { "errorMessages": [], "errors": { "customfield_10021": "..." } }.
 */
function extractRejectedFields(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && parsed.errors && typeof parsed.errors === 'object') {
      return Object.keys(parsed.errors);
    }
  } catch {
    // Non-JSON error body; cannot extract individual field names.
  }
  return [];
}

/**
 * Writes an issue via the Jira REST API, stripping any fields Jira rejects
 * (read-only, unknown, or not-on-screen fields) and retrying.
 * This prevents a single unmappable field from blocking an entire sync.
 *
 * @returns {{ ok: boolean, response?: any, status?: number, skippedFields: string[], failure?: string }}
 */
async function writeJiraIssueWithRecovery({ method, issueKey, payload, context, originalLocalKey = null }) {
  const pauseOperation = issueKey ? 'issue_update_local' : 'issue_create_local';
  const skippedFields = [];
  const allowFieldRetry = Boolean(issueKey);
  let fields = { ...(payload.fields || {}) };

  for (let attempt = 0; attempt < MAX_ISSUE_WRITE_ATTEMPTS; attempt++) {
    const url = issueKey
      ? route`/rest/api/3/issue/${issueKey}`
      : route`/rest/api/3/issue`;

    // Re-checked on every attempt: the field-stripping retry must not submit a
    // write after the administrator paused the connector.
    await assertPilotWritesAllowed(pauseOperation);
    await assertInboundScope({ orgId: context.orgId, issueKeys: [issueKey, originalLocalKey, fields.parent?.key].filter(Boolean),
      projectKey: issueKey ? null : fields.project?.key, includeCurrentParents: Boolean(issueKey && 'parent' in fields) });
    const response = await api.asApp().requestJira(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, fields })
    });

    if (response.ok) {
      return { ok: true, response, status: response.status, skippedFields };
    }

    const bodyText = await response.text();
    const rejected = extractRejectedFields(bodyText);
    const removable = rejected.filter((fieldId) => fieldId in fields);

    if (allowFieldRetry && attempt < MAX_ISSUE_WRITE_ATTEMPTS - 1 && removable.length > 0) {
      removable.forEach((fieldId) => {
        delete fields[fieldId];
        skippedFields.push(fieldId);
      });
      console.log(
        `${LOG_EMOJI.WARNING} Jira rejected field(s) [${removable.join(', ')}] — stripped and retrying (attempt ${attempt + 1}).`
      );
      continue;
    }

    return { ok: false, status: response.status, skippedFields, failure: formatHttpFailure(response.status) };
  }

  return { ok: false, skippedFields, failure: 'remote_write_failed' };
}

export async function handleRemoteIssueCreated(remoteIssue, context, options = {}) {
  const { org, orgId } = context;
  console.log(`${LOG_EMOJI.SYNC} Received remote issue create: ${remoteIssue.key}`);

  const existingLocalKey = await getLocalKey(remoteIssue.key, orgId);
  const replacementOfLocalKey = options.replacementOfLocalKey || null;
  if (existingLocalKey) {
    const existingStatus = await getCounterpartStatus({
      orgId,
      localKey: existingLocalKey,
      remoteKey: remoteIssue.key
    });
    if (replacementOfLocalKey && replacementOfLocalKey === existingLocalKey) {
      console.log(`♻️ Creating a replacement local issue for ${remoteIssue.key}`);
    } else if (existingStatus?.deletedSide === COUNTERPART_DELETED_SIDES.LOCAL
        && existingStatus.state === 'active') {
      console.warn(`${LOG_EMOJI.WARNING} Ignoring remote create for ${remoteIssue.key}: local counterpart was deleted`);
      return { status: 'COUNTERPART_CONFIRMED_DELETED' };
    } else {
      console.log(`ℹ️ Issue ${remoteIssue.key} already mapped to ${existingLocalKey}. Treating as update.`);
      const result = await handleRemoteIssueUpdated(remoteIssue, context);
      if (context.syncOptions?.syncAttachments === true) {
        const attachments = await resumePostCreateAttachments({ orgId, localKey: existingLocalKey, remoteKey: remoteIssue.key });
        if (attachments.pending) return { ...result, code: 'POST_CREATE_ATTACHMENTS_PENDING' };
      }
      return result;
    }
  }

  const targetProject = Array.isArray(org.allowedProjects) && org.allowedProjects.length > 0
    ? org.allowedProjects[0]
    : null;

  if (!targetProject) throw new InboundScopeError('PROJECTS_MISSING');
  if (replacementOfLocalKey) await assertInboundScope({ orgId, issueKeys: [replacementOfLocalKey] });

  await assertInboundScope({ orgId, projectKey: targetProject });
  const resolvedRemoteIssue = await loadRemoteIssue(remoteIssue, context);
  if (!resolvedRemoteIssue) {
    throw new Error(`Unable to load remote issue ${remoteIssue.key} for creation`);
  }

  const parentReady = await ensureParentReadyForCreate(resolvedRemoteIssue, context, options);
  if (!parentReady) {
    console.log(`${LOG_EMOJI.INFO} Deferring creation of ${remoteIssue.key} until parent mapping is available`);
    return;
  }

  const sourceHash = hashRemoteFields(resolvedRemoteIssue.fields, context);
  const echo = await findAppCausedEcho({
    orgId,
    localKey: null,
    remoteKey: remoteIssue.key,
    observedSide: 'remote',
    fieldHash: sourceHash
  });
  if (echo.echo) {
    await recordSyncDecision({
      decision: SYNC_DECISIONS.SKIPPED_ECHO,
      orgId,
      remoteKey: remoteIssue.key,
      direction: 'remote-to-local',
      reason: 'app-caused-create-marker'
    });
    return;
  }

  const lease = await acquireIssueLease({
    orgId,
    remoteKey: remoteIssue.key,
    sourceKey: remoteIssue.key,
    direction: 'remote-to-local'
  });
  if (!lease.acquired) {
    await recordSyncDecision({
      decision: lease.status === 'LEASE_STORAGE_ERROR' ? SYNC_DECISIONS.FAILED : SYNC_DECISIONS.SKIPPED_LOCKED,
      orgId,
      remoteKey: remoteIssue.key,
      direction: 'remote-to-local',
      reason: lease.status === 'LEASE_STORAGE_ERROR' ? 'lease-storage-error' : 'issue-lease-held'
    });
    return;
  }

  return await runWithIssueLease(lease, async () => {
  try {
  const payload = await buildCreatePayload(resolvedRemoteIssue, targetProject, context);

  await assertInboundScope({ orgId, projectKey: targetProject, issueKeys: [replacementOfLocalKey, payload.fields.parent?.key].filter(Boolean) });

  // Pairing-witness veto. The remote issue is the source, so its own property is
  // the evidence that a local counterpart may already exist after Forge storage
  // was lost. Runs inside the lease and before the create claim.
  const witnessGate = await evaluatePairWitnessCreateGuard({
    orgId,
    org: context.org,
    direction: ISSUE_CREATE_DIRECTIONS.REMOTE_TO_LOCAL,
    sourceKey: remoteIssue.key,
    sourceIssueId: resolvedRemoteIssue.id,
    operationSuffix: options.operationSuffix || null,
    replacementKey: replacementOfLocalKey
  });
  if (witnessGate.decision === PAIR_WITNESS_GUARD_DECISIONS.BLOCK) {
    console.warn(`${LOG_EMOJI.WARNING} Local create blocked by pairing witness for ${remoteIssue.key}: ${witnessGate.code}`);
    await recordSyncDecision({
      decision: syncDecisionForGuardCode(witnessGate.code),
      orgId,
      localKey: replacementOfLocalKey || null,
      remoteKey: remoteIssue.key,
      direction: ISSUE_CREATE_DIRECTIONS.REMOTE_TO_LOCAL,
      reason: witnessGate.code,
      statusCode: witnessGate.statusCode
    });
    return { status: witnessGate.code, code: witnessGate.code };
  }

  const createClaim = await beginIssueCreateOperation({
    orgId,
    direction: ISSUE_CREATE_DIRECTIONS.REMOTE_TO_LOCAL,
    sourceKey: remoteIssue.key,
    operationSuffix: options.operationSuffix || null
  });

  if (!createClaim.allowed) {
    console.warn(`${LOG_EMOJI.WARNING} Issue create blocked for ${remoteIssue.key} (${orgId || 'legacy'}): ${createClaim.code}`);
    await recordSyncDecision({
      decision: createClaim.code === ISSUE_CREATE_CODES.RECONCILIATION_REQUIRED
        ? SYNC_DECISIONS.AMBIGUOUS_WRITE
        : SYNC_DECISIONS.SKIPPED_LOCKED,
      orgId,
      remoteKey: remoteIssue.key,
      direction: ISSUE_CREATE_DIRECTIONS.REMOTE_TO_LOCAL,
      reason: createClaim.code
    });
    return { status: createClaim.code, code: createClaim.code };
  }

  await assertInboundScope({ orgId, projectKey: targetProject, issueKeys: [replacementOfLocalKey, payload.fields.parent?.key].filter(Boolean) });
  const submission = await markIssueCreateSubmissionStarted(createClaim.operation);
  if (!submission.ok) {
    return { status: submission.code, code: submission.code };
  }

  let result;
  try {
    result = await writeJiraIssueWithRecovery({ method: 'POST', payload, context, originalLocalKey: replacementOfLocalKey });
  } catch (error) {
    if (isInboundScopeError(error)) await markIssueCreateFailedDefinitive(submission.operation, { reasonCode: error.code });
    else await markIssueCreateUnknown(submission.operation);
    throw error;
  }

  if (!result.ok) {
    const status = Number(result.status);
    if (isDefinitiveCreateRejection(status)) {
      await markIssueCreateFailedDefinitive(submission.operation, {
        reasonCode: 'JIRA_HTTP_REJECTED'
      });
    } else {
      await markIssueCreateUnknown(submission.operation);
    }
    throw new Error(`Failed to create local issue: ${result.failure || 'remote_write_failed'}`);
  }
  if (result.skippedFields.length > 0) {
    console.log(`${LOG_EMOJI.WARNING} Created local issue without unmappable field(s): ${result.skippedFields.join(', ')}`);
    await recordRejectedFields(orgId, result.skippedFields);
  }

  let data;
  try {
    data = await result.response.json();
  } catch (error) {
    await markIssueCreateUnknown(submission.operation);
    throw error;
  }
  const localKey = data?.key;
  if (!localKey) {
    await markIssueCreateUnknown(submission.operation);
    throw new Error('Create response did not include an issue key');
  }

  let operationResolution;
  try {
    operationResolution = await markIssueCreateSucceeded({
      operation: submission.operation,
      targetKey: localKey
    });
  } catch (error) {
    await recordWitnessPersistenceFailure({
      orgId,
      localKey,
      remoteKey: remoteIssue.key,
      targetKey: localKey,
      outcome: WITNESS_ESTABLISHMENT_OUTCOMES.LEDGER_PERSISTENCE_FAILED,
      reason: error?.code || 'LEDGER_WRITE_FAILED'
    });
    throw error;
  }
  if (!operationResolution.success) {
    await recordWitnessPersistenceFailure({
      orgId,
      localKey,
      remoteKey: remoteIssue.key,
      targetKey: localKey,
      outcome: WITNESS_ESTABLISHMENT_OUTCOMES.LEDGER_PERSISTENCE_FAILED,
      reason: operationResolution.code
    });
    throw new Error(operationResolution.code || 'CREATE_OPERATION_RESOLUTION_FAILED');
  }

  console.log(`${LOG_EMOJI.SUCCESS} Created local issue ${localKey} from remote ${remoteIssue.key}`);

  try {
    if (replacementOfLocalKey) {
      await replaceIssueMapping({
        oldLocalKey: replacementOfLocalKey,
        oldRemoteKey: remoteIssue.key,
        newLocalKey: localKey,
        newRemoteKey: remoteIssue.key,
        orgId
      });
    } else {
      await storeMapping(localKey, remoteIssue.key, orgId);
    }
  } catch (error) {
    await recordWitnessPersistenceFailure({
      orgId,
      localKey,
      remoteKey: remoteIssue.key,
      targetKey: localKey,
      outcome: WITNESS_ESTABLISHMENT_OUTCOMES.MAPPING_PERSISTENCE_FAILED,
      reason: error?.code || 'MAPPING_WRITE_FAILED'
    });
    throw error;
  }

  // Mirror the pair into Jira. A witness failure never retries this create and
  // never changes the ledger/mapping outcome; it records attention.
  try {
    const witness = await establishPairWitness({
      orgId,
      org: context.org,
      localKey,
      remoteKey: remoteIssue.key,
      localIssueId: data.id,
      remoteIssueId: resolvedRemoteIssue.id,
      direction: ISSUE_CREATE_DIRECTIONS.REMOTE_TO_LOCAL,
      replacement: replacementOfLocalKey
        ? {
          localKey: replacementOfLocalKey,
          remoteKey: remoteIssue.key
        }
        : null
    });
    if (!witness.success) {
      await recordSyncDecision({
        decision: SYNC_DECISIONS.FAILED,
        orgId,
        localKey,
        remoteKey: remoteIssue.key,
        direction: ISSUE_CREATE_DIRECTIONS.REMOTE_TO_LOCAL,
        reason: witness.outcome
      });
    }
  } catch {
    await recordSyncDecision({
      decision: SYNC_DECISIONS.FAILED,
      orgId,
      localKey,
      remoteKey: remoteIssue.key,
      direction: ISSUE_CREATE_DIRECTIONS.REMOTE_TO_LOCAL,
      reason: WITNESS_ESTABLISHMENT_OUTCOMES.FAILED
    });
  }
  if (context.syncOptions.syncAttachments === true) {
    await retainPostCreateAttachments({ orgId, localKey, remoteKey: remoteIssue.key,
      attachmentIds: (resolvedRemoteIssue.fields.attachment || []).map(item => item?.id) });
  }
  await recordLatestAccepted({
    orgId,
    direction: 'remote-to-local',
    localKey,
    remoteKey: remoteIssue.key,
    sourceUpdated: resolvedRemoteIssue.fields?.updated,
    fieldHash: sourceHash
  });
  const localDestination = await resolveLocalDestinationHash({
    localKey,
    mappings: context.mappings
  });
  if (localDestination.available) {
    await recordDestinationWrite({
      orgId,
      localKey,
      remoteKey: remoteIssue.key,
      direction: 'remote-to-local',
      observedSide: 'local',
      sourceUpdated: resolvedRemoteIssue.fields?.updated,
      fieldHash: localDestination.hash
    });
  } else {
    await recordSyncDecision({
      decision: 'echo_hash_unavailable',
      orgId,
      localKey,
      remoteKey: remoteIssue.key,
      direction: 'remote-to-local',
      sourceUpdated: resolvedRemoteIssue.fields?.updated,
      reason: localDestination.reason
    });
  }
  await processPendingChildIssues(remoteIssue.key, context);

  const attachments = context.syncOptions?.syncAttachments === true
    ? await resumePostCreateAttachments({ orgId, localKey, remoteKey: remoteIssue.key }) : null;
  return { status: 'CREATED', localKey, ...(attachments?.pending ? { code: 'POST_CREATE_ATTACHMENTS_PENDING' } : {}) };
  } finally {
    await releaseIssueLease({ key: lease.key, token: lease.token });
  }
  });
}

async function handleRemoteIssueUpdated(remoteIssue, context, payload = null) {
  const { orgId, mappings } = context;
  const localKey = await getLocalKey(remoteIssue.key, orgId);
  if (!localKey) {
    console.log(`⚠️ Remote issue ${remoteIssue.key} not mapped. Ignoring update.`);
    return { status: 'SKIPPED_UNMAPPED' };
  }

  await assertInboundScope({ orgId, issueKeys: [localKey] });

  const updateCounterpartStatus = await getCounterpartStatus({
    orgId,
    localKey,
    remoteKey: remoteIssue.key
  });
  if (updateCounterpartStatus?.state === 'active') {
    if (updateCounterpartStatus.deletedSide === COUNTERPART_DELETED_SIDES.LOCAL) {
      await recordSyncDecision({
        decision: SYNC_DECISIONS.SKIPPED_LOCKED,
        orgId,
        localKey,
        remoteKey: remoteIssue.key,
        direction: 'remote-to-local',
        reason: 'counterpart-confirmed-deleted'
      });
      return { status: 'COUNTERPART_CONFIRMED_DELETED' };
    }
    // A delivered update is positive evidence that the remote counterpart is
    // alive. Resolve only classification metadata; no Jira content is stored.
    await resolveCounterpartStatus({
      orgId,
      localKey,
      remoteKey: remoteIssue.key
    });
  }

  if (payload && shouldSkipUpdateForAttachmentOnly(payload)) {
    console.log(`${LOG_EMOJI.INFO} Skipping field update for ${localKey}; changelog contains attachment changes only.`);
    return { status: 'SKIPPED_ATTACHMENT_ONLY' };
  }

  try {
    if (typeof ensureMappingPair === 'function') {
      await ensureMappingPair(localKey, remoteIssue.key, orgId);
    }
  } catch (error) {
    if (error?.code === 'MAPPING_CONFLICT') throw error;
    console.warn(`Mapping pair repair check failed for ${localKey}`);
  }

  const resolvedRemoteIssue = await loadRemoteIssue(remoteIssue, context);
  if (!resolvedRemoteIssue) {
    console.log(`${LOG_EMOJI.WARNING} Could not fetch remote issue ${remoteIssue.key}. Skipping update.`);
    return { status: 'SKIPPED_UNREADABLE' };
  }

  const sourceUpdated = resolvedRemoteIssue.fields?.updated || null;
  const sourceHash = hashRemoteFields(resolvedRemoteIssue.fields, context);

  const echo = await findAppCausedEcho({
    orgId,
    localKey,
    remoteKey: remoteIssue.key,
    observedSide: 'remote',
    fieldHash: sourceHash
  });
  if (echo.echo && !payloadHasNonFieldContentChange(payload)) {
    await recordSyncDecision({
      decision: SYNC_DECISIONS.SKIPPED_ECHO,
      orgId,
      localKey,
      remoteKey: remoteIssue.key,
      direction: 'remote-to-local',
      sourceUpdated,
      fieldHash: sourceHash,
      reason: 'app-caused-write-marker'
    });
    return { status: 'SYNC_ECHO_SKIPPED' };
  }

  if (await isSyncing(localKey)) {
    await recordSyncDecision({
      decision: SYNC_DECISIONS.SKIPPED_LOCKED,
      orgId,
      localKey,
      remoteKey: remoteIssue.key,
      direction: 'remote-to-local',
      reason: 'legacy-syncing-flag'
    });
    return { status: 'SYNC_ALREADY_IN_PROGRESS' };
  }

  const lease = await acquireIssueLease({
    orgId,
    localKey,
    remoteKey: remoteIssue.key,
    direction: 'remote-to-local'
  });
  if (!lease.acquired) {
    await recordSyncDecision({
      decision: lease.status === 'LEASE_STORAGE_ERROR' ? SYNC_DECISIONS.FAILED : SYNC_DECISIONS.SKIPPED_LOCKED,
      orgId,
      localKey,
      remoteKey: remoteIssue.key,
      direction: 'remote-to-local',
      reason: lease.status === 'LEASE_STORAGE_ERROR' ? 'lease-storage-error' : 'issue-lease-held'
    });
    return { status: lease.status };
  }


  return await runWithIssueLease(lease, async () => {
  await markSyncing(localKey);
  try {
    const latest = await getLatestAccepted({
      orgId,
      direction: 'remote-to-local',
      localKey,
      remoteKey: remoteIssue.key
    });
    const ordering = evaluateStaleEvent({ latest, sourceUpdated, fieldHash: sourceHash });

    if (ordering.decision === 'stale' || ordering.decision === 'duplicate' || ordering.decision === 'conflict') {
      const decision = ordering.decision === 'stale'
        ? SYNC_DECISIONS.SKIPPED_STALE
        : ordering.decision === 'duplicate'
          ? SYNC_DECISIONS.DUPLICATE
          : SYNC_DECISIONS.CONFLICT;
      const safeReason = ordering.decision === 'conflict'
        ? 'equal_timestamp_different_hash'
        : ordering.decision === 'stale'
          ? 'older_than_last_applied'
          : 'same_timestamp_same_hash';
      if (ordering.decision === 'conflict') {
        await recordConflict({
          orgId,
          localKey,
          remoteKey: remoteIssue.key,
          direction: 'remote-to-local',
          remoteTimestamp: sourceUpdated,
          sourceHash,
          destinationHash: latest?.fieldHash || null,
          reason: safeReason
        });
      } else {
        await recordSyncDecision({
          decision,
          orgId,
          localKey,
          remoteKey: remoteIssue.key,
          direction: 'remote-to-local',
          sourceUpdated,
          fieldHash: sourceHash,
          reason: safeReason
        });
      }
      return { status: ordering.status };
    }

    if (ordering.decision === 'unverified') {
      await recordSyncDecision({
        decision: SYNC_DECISIONS.APPLIED,
        orgId,
        localKey,
        remoteKey: remoteIssue.key,
        direction: 'remote-to-local',
        sourceUpdated,
        reason: 'ordering-unverified-processing-safely'
      });
    }

    const updatePayload = await buildUpdatePayload(resolvedRemoteIssue, context);
    await assertInboundScope({ orgId, issueKeys: [localKey, updatePayload.fields.parent?.key].filter(Boolean),
      includeCurrentParents: 'parent' in updatePayload.fields });
    await syncIncomingLinksForIssue(resolvedRemoteIssue, localKey, context);
    if (Object.keys(updatePayload.fields).length === 0) {
      console.log(`ℹ️ No fields to update for ${localKey}`);
      return { status: 'NO_FIELDS' };
    }

    const result = await writeJiraIssueWithRecovery({ method: 'PUT', issueKey: localKey, payload: updatePayload, context });
    if (!result.ok) {
      throw new Error(`Failed to update local issue: ${result.failure || 'remote_write_failed'}`);
    }
    if (result.skippedFields.length > 0) {
      console.log(`${LOG_EMOJI.WARNING} Updated local issue without unmappable field(s): ${result.skippedFields.join(', ')}`);
      await recordRejectedFields(orgId, result.skippedFields);
    }
    console.log(`${LOG_EMOJI.SUCCESS} Updated local issue ${localKey}`);

    if (resolvedRemoteIssue.fields?.status) {
      await transitionLocalIssue(localKey, resolvedRemoteIssue.fields.status, mappings.statusMappings, null, { orgId });
    }

    const localDestination = await resolveLocalDestinationHash({
      localKey,
      mappings: context.mappings
    });
    await recordLatestAccepted({
      orgId,
      direction: 'remote-to-local',
      localKey,
      remoteKey: remoteIssue.key,
      sourceUpdated,
      fieldHash: sourceHash
    });
    if (localDestination.available) {
      await recordDestinationWrite({
        orgId,
        localKey,
        remoteKey: remoteIssue.key,
        direction: 'remote-to-local',
        observedSide: 'local',
        sourceUpdated,
        fieldHash: localDestination.hash
      });
    } else {
      await recordSyncDecision({
        decision: 'echo_hash_unavailable',
        orgId,
        localKey,
        remoteKey: remoteIssue.key,
        direction: 'remote-to-local',
        sourceUpdated,
        reason: localDestination.reason
      });
    }
    await recordSyncDecision({
      decision: SYNC_DECISIONS.APPLIED,
      orgId,
      localKey,
      remoteKey: remoteIssue.key,
      direction: 'remote-to-local',
      sourceUpdated,
      fieldHash: sourceHash,
      reason: 'destination-write-succeeded'
    });
    return { status: 'APPLIED' };
  } finally {
    await clearSyncFlag(localKey);
    await releaseIssueLease({ key: lease.key, token: lease.token });
  }
  });
}

async function handleRemoteIssueDeleted(remoteIssue, context) {
  // Deletion propagation is intentionally disabled for corporate pilot safety.
  // A remote deletion must not delete the local issue; the mapping is kept for
  // future reconciliation. Only safe metadata and a survivor notice are written.
  const localKey = await getLocalKey(remoteIssue.key, context.orgId);
  if (!localKey) {
    return;
  }

  await assertInboundScope({ orgId: context.orgId, issueKeys: [localKey] });
  const reason = 'Deletion propagation disabled for corporate pilot safety';
  console.warn(`${reason}: org=${context.orgId || 'legacy'} remote=${remoteIssue.key} local=${localKey}`);
  const statusRecord = await recordCounterpartStatus({
    orgId: context.orgId,
    localKey,
    remoteKey: remoteIssue.key,
    status: COUNTERPART_STATUS_VALUES.CONFIRMED_DELETED,
    deletedSide: COUNTERPART_DELETED_SIDES.REMOTE,
    source: 'issue_deleted_event',
    reasonCode: 'REMOTE_ISSUE_DELETED'
  });
  await logAuditEntry({
    action: 'remote-delete-blocked',
    sourceIssue: localKey,
    targetIssue: remoteIssue.key,
    orgId: context.orgId,
    orgName: context.org?.name,
    success: false,
    errors: [reason]
  });
  if (statusRecord.success) {
    await setCounterpartNotice({
      side: 'local',
      key: localKey,
      localKey,
      remoteKey: remoteIssue.key,
      status: COUNTERPART_STATUS_VALUES.CONFIRMED_DELETED,
      scope: { orgId: context.orgId }
    });
    await maybeAutoReplaceAfterDeletion({
      orgId: context.orgId,
      org: context.org,
      localKey,
      remoteKey: remoteIssue.key,
      deletedSide: COUNTERPART_DELETED_SIDES.REMOTE
    });
  }
}

const PARENT_RELATED_COMMENT_REJECTION_STATUSES = new Set([400, 404, 422]);
const AMBIGUOUS_COMMENT_STATUSES = new Set([408, 425, 429]);

function createAmbiguousCommentWriteError(status = null, reason = 'ambiguous-comment-write') {
  const error = new Error('Ambiguous comment write outcome');
  error.code = 'COMMENT_WRITE_AMBIGUOUS';
  error.status = Number.isFinite(Number(status)) ? Number(status) : null;
  error.reason = reason;
  return error;
}

function createRejectedCommentWriteError(status) {
  const error = new Error(`Failed to sync incoming comment: ${formatHttpFailure(status)}`);
  error.code = 'COMMENT_WRITE_REJECTED';
  error.status = Number.isFinite(Number(status)) ? Number(status) : null;
  return error;
}

function createCommentReconciliationError(persisted = true) {
  const error = new Error('Incoming comment requires reconciliation');
  error.code = 'COMMENT_RECONCILIATION_REQUIRED';
  error.persisted = persisted;
  return error;
}

function isAmbiguousCommentStatus(status) {
  const code = Number(status);
  return !Number.isFinite(code)
    || code < 400
    || code >= 500
    || AMBIGUOUS_COMMENT_STATUSES.has(code);
}

function requireCommentResponse(response) {
  if (!response || typeof response.ok !== 'boolean') {
    throw createAmbiguousCommentWriteError(null, 'malformed-comment-response');
  }
  return response;
}

async function readCommentResponseBody(response) {
  try {
    if (response && typeof response.json === 'function') {
      return await response.json();
    }
    if (response && typeof response.text === 'function') {
      const text = await response.text();
      if (!text) {
        return null;
      }
      try {
        return JSON.parse(text);
      } catch {
        return { text };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function isParentRelatedCommentRejection(status, body) {
  if (!PARENT_RELATED_COMMENT_REJECTION_STATUSES.has(Number(status)) || !body || typeof body !== 'object') {
    return false;
  }

  if (body.errors && typeof body.errors === 'object') {
    const parentField = Object.keys(body.errors).some(key =>
      String(key).toLowerCase().includes('parent')
    );
    if (parentField) {
      return true;
    }
  }

  const messages = [];
  if (Array.isArray(body.errorMessages)) {
    messages.push(...body.errorMessages);
  }
  if (typeof body.message === 'string') {
    messages.push(body.message);
  }
  if (typeof body.error === 'string') {
    messages.push(body.error);
  }
  if (body.error && typeof body.error === 'object' && typeof body.error.message === 'string') {
    messages.push(body.error.message);
  }

  return messages.some(message => /\bparent\b/i.test(String(message)));
}

async function persistCommentReconciliation({
  context,
  localKey,
  remoteIssueKey,
  comment,
  parentLocalId,
  status,
  reason
}) {
  const key = buildIncomingCommentReconciliationKey(context.orgId, comment.id);
  const record = {
    state: 'reconciliation_required',
    orgId: context.orgId || null,
    localIssueKey: localKey,
    remoteIssueKey,
    remoteCommentId: String(comment.id),
    parentLocalId: parentLocalId || null,
    failedStatus: Number.isFinite(Number(status)) ? Number(status) : null,
    reason,
    createdAt: new Date().toISOString()
  };

  try {
    await kvsStore.set(key, record);
    return key;
  } catch {
    throw createCommentReconciliationError(false);
  }
}

async function handleRemoteCommentCreated(payload, context) {
  if (!shouldSyncIncomingComments(context.syncOptions)) {
    console.log(`⏭️ Incoming comments disabled for ${context.orgId || 'organization'}`);
    return { status: 'COMMENT_RETRY' };
  }

  const remoteIssueKey = payload.issue?.key;
  let comment = payload.comment;

  if (!remoteIssueKey || !comment) {
    console.log(`${LOG_EMOJI.WARNING} Comment event missing issue or comment data`);
    return { status: 'COMMENT_RETRY' };
  }

  if (getCommentConfidentiality(comment).code === 'COMMENT_RESTRICTED') {
    console.log('Comment copy skipped: confidentiality not verified');
    return { status: 'COMMENT_REJECTED' };
  }

  if (comment.author?.accountType === 'app') {
    console.log(`${LOG_EMOJI.INFO} Skipping SyncApp-authored comment ${comment.id} on ${remoteIssueKey}`);
    return { status: 'COMMENT_IGNORED_CONNECTOR' };
  }

  if (isConnectorGeneratedComment(comment.body)) {
    console.log(`${LOG_EMOJI.INFO} Skipping comment from SyncApp to avoid loops`);
    return { status: 'COMMENT_IGNORED_CONNECTOR' };
  }

  const localKey = await getLocalKey(remoteIssueKey, context.orgId);
  if (!localKey) {
    console.log(`${LOG_EMOJI.WARNING} No local mapping for remote comment on ${remoteIssueKey}`);
    return { status: 'COMMENT_RETRY' };
  }

  await assertInboundScope({ orgId: context.orgId, issueKeys: [localKey] });
  const submissionScope = { orgId: context.orgId, remoteIssueKey, localKey, commentId: comment.id };
  const dedupKey = buildIncomingCommentKey(context.orgId, comment.id);
  const alreadyProcessed = await kvsStore.get(dedupKey);
  if (alreadyProcessed) {
    console.log(`${LOG_EMOJI.INFO} Comment ${comment.id} already processed, skipping duplicate event`);
    const receipt = await readInboundCommentReceipt(submissionScope);
    if (receipt) await storeCommentMapping(receipt.destinationCommentId, comment.id, context.orgId);
    return { status: 'COMMENT_ALREADY_MAPPED' };
  }

  const reconciliationKey = buildIncomingCommentReconciliationKey(context.orgId, comment.id);
  const reconciliationRequired = await kvsStore.get(reconciliationKey);
  if (reconciliationRequired) {
    console.warn(`${LOG_EMOJI.WARNING} Comment ${comment.id} requires reconciliation; not replaying ambiguous write`);
    return { status: 'COMMENT_RECONCILIATION_REQUIRED' };
  }

  const receipt = await readInboundCommentReceipt(submissionScope);
  if (receipt) {
    await kvsStore.set(dedupKey, { processedAt: new Date().toISOString(),
      localCommentId: receipt.destinationCommentId, remoteCommentId: comment.id });
    await storeCommentMapping(receipt.destinationCommentId, comment.id, context.orgId);
    return { status: 'COMMENT_ALREADY_MAPPED' };
  }

  // Always use the authoritative REST body and metadata. Never merge omitted
  // REST fields with webhook content or fall back to that content on failure.
  await assertCommentVerificationReady({ direction: 'remote-to-local', orgId: context.org.id, issueKey: remoteIssueKey, commentId: comment.id });
  const budget = commentReadBudget();
  const verifiedComment = await getRemoteComment(remoteIssueKey, comment.id, context.org, budget);
  const source = withParentHints(verifiedComment, comment);
  const verification = await verifyCommentThread(source, {
    expectedId: comment.id,
    readParent: id => getRemoteComment(remoteIssueKey, id, context.org, budget),
    projectType: () => getCommentProjectType(remoteIssueKey, context.org, budget),
    parentIdFor: extractParentIdFromRemoteComment, knownAncestry: new Map(context.commentAncestry || [])
  });
  if (!verification.allowed) {
    console.log('Comment copy skipped: confidentiality not verified');
    return { status: 'COMMENT_REJECTED' };
  }
  const finalBudget = commentReadBudget();
  let final;
  try {
    final = await verifyFreshCommentThread({
      readComment: () => getRemoteComment(remoteIssueKey, comment.id, context.org, finalBudget), expectedId: comment.id,
      readParent: id => getRemoteComment(remoteIssueKey, id, context.org, finalBudget),
      projectType: () => getCommentProjectType(remoteIssueKey, context.org, finalBudget), hints: source, knownAncestry: verification.ancestry
    });
  } catch (error) {
    error.parentId = extractParentIdFromRemoteComment(source);
    error.ancestry = Array.from(new Map([...(verification.ancestry || []), ...(error.ancestry || [])]));
    throw error;
  }
  if (!final.allowed) return { status: 'COMMENT_REJECTED' };
  comment = final.comment;
  if (comment.author?.accountType === 'app' || isConnectorGeneratedComment(comment.body)) return { status: 'COMMENT_IGNORED_CONNECTOR' };

  const authorName = comment.author?.displayName || comment.author?.emailAddress || 'Unknown User';
  let commentText = '';
  if (comment.body && typeof comment.body === 'object') {
    commentText = extractTextFromADF(comment.body);
  } else {
    commentText = comment.body || '';
  }
  commentText = sanitizeCommentText(stripSyncPrefix(commentText));

  const parentContext = await resolveLocalParentForIncomingComment(final.parent, context);
  const body = buildSyncedCommentADF({
    orgName: context.org.name,
    userName: authorName,
    parentAuthor: parentContext?.parentAuthor || null,
    parentSnippet: parentContext?.parentSnippet || null,
    responseText: commentText
  });

  let verifiedAncestry = final.ancestry;
  await markSyncing(localKey);
  try {
    let response;
    try {
      const submissionContext = { ...context, submissionScope, commentSubmission: { direction: 'remote-to-local', orgId: context.org.id,
        issueKey: remoteIssueKey, commentId: comment.id } };
      response = await createLocalComment(localKey, body, parentContext.localParentId, submissionContext, async () => {
        const fallback = await verifyFreshCommentThread({
          readComment: () => getRemoteComment(remoteIssueKey, comment.id, context.org, finalBudget), expectedId: comment.id,
          readParent: id => getRemoteComment(remoteIssueKey, id, context.org, finalBudget),
          projectType: () => getCommentProjectType(remoteIssueKey, context.org, finalBudget), hints: final.comment, knownAncestry: final.ancestry
        });
        if (!fallback.allowed) throw Object.assign(new Error('Comment confidentiality rejected'), { code: 'COMMENT_REJECTED' });
        verifiedAncestry = fallback.ancestry;
        const parent = await resolveLocalParentForIncomingComment(fallback.parent, context);
        return buildSyncedCommentADF({ orgName: context.org.name,
          userName: fallback.comment.author?.displayName || fallback.comment.author?.emailAddress || 'Unknown User',
          parentAuthor: parent.parentAuthor, parentSnippet: parent.parentSnippet,
          responseText: sanitizeCommentText(stripSyncPrefix(typeof fallback.comment.body === 'object'
            ? extractTextFromADF(fallback.comment.body) : fallback.comment.body || '')) });
      });
    } catch (error) {
      if (isInboundScopeError(error) || error?.code === 'COMMENT_VERIFICATION_DEFERRED') {
        error.parentId = extractParentIdFromRemoteComment(final.comment) || verification.ancestry?.get(String(comment.id));
        error.ancestry = error.ancestry || Array.from(verifiedAncestry || verification.ancestry || []);
      }
      if (error?.code === 'COMMENT_WRITE_AMBIGUOUS') {
        await persistCommentReconciliation({
          context,
          localKey,
          remoteIssueKey,
          comment,
          parentLocalId: parentContext.localParentId,
          status: error.status,
          reason: error.reason || 'ambiguous-comment-write'
        });
        throw createCommentReconciliationError();
      }
      throw error;
    }

    let createdComment;
    try {
      createdComment = await response.json();
    } catch {
      await persistCommentReconciliation({
        context,
        localKey,
        remoteIssueKey,
        comment,
        parentLocalId: parentContext.localParentId,
        status: response.status,
        reason: 'malformed-comment-create-response'
      });
      throw createCommentReconciliationError();
    }

    if (!createdComment || typeof createdComment !== 'object' || createdComment.id === undefined || createdComment.id === null) {
      await persistCommentReconciliation({
        context,
        localKey,
        remoteIssueKey,
        comment,
        parentLocalId: parentContext.localParentId,
        status: response.status,
        reason: 'malformed-comment-create-response'
      });
      throw createCommentReconciliationError();
    }

    const localCommentId = createdComment.id;
    await recordInboundCommentReceipt(submissionScope, localCommentId);
    const parentMarkers = {
      parentId: createdComment?.parentId || null,
      jsdParentId: createdComment?.jsdParentId || null,
      propertiesCount: Array.isArray(createdComment?.properties) ? createdComment.properties.length : 0
    };
    console.log(`${LOG_EMOJI.INFO} Created local comment with ${parentMarkers.propertiesCount} parent marker(s)`);
    const replyLabel = parentContext.parentAuthor
      ? ` (reply to ${parentContext.parentAuthor})`
      : parentContext.localParentId
        ? ` (reply to local comment ${parentContext.localParentId})`
        : parentContext.remoteParentId
          ? ` (reply to remote comment ${parentContext.remoteParentId})`
          : '';
    console.log(`${LOG_EMOJI.COMMENT} Synced comment ${comment.id} from ${remoteIssueKey} to ${localKey}${replyLabel}`);

    await kvsStore.set(dedupKey, {
      processedAt: new Date().toISOString(),
      localCommentId,
      remoteCommentId: comment.id,
      parentLocalId: parentContext.localParentId || null,
      parentRemoteId: parentContext.remoteParentId || null
    });

    if (localCommentId) {
      await storeCommentMapping(localCommentId, comment.id, context.orgId);
    }
  } finally {
    await clearSyncFlag(localKey);
  }
  return { status: 'COMMENT_SYNCED' };
}

async function createLocalComment(localIssueKey, body, parentLocalId = null, context, beforeFallback) {
  if (!parentLocalId) {
    return await postCommentOnce(localIssueKey, { body }, 'top-level', context);
  }

  const initialResponse = requireCommentResponse(
    await postLocalComment(localIssueKey, { body, parent: { id: parentLocalId } }, context)
  );
  if (initialResponse.ok) {
    return initialResponse;
  }

  const initialBody = await readCommentResponseBody(initialResponse);
  if (isParentRelatedCommentRejection(initialResponse.status, initialBody)) {
    console.log(`${LOG_EMOJI.WARNING} Parent-specific comment was rejected on ${localIssueKey}. Retrying once as top-level comment.`);
    const freshBody = await beforeFallback();
    return await postCommentOnce(localIssueKey, { body: freshBody }, 'parent-fallback', context);
  }

  if (isAmbiguousCommentStatus(initialResponse.status)) {
    throw createAmbiguousCommentWriteError(initialResponse.status, 'parent-specific-comment-ambiguous');
  }

  throw createRejectedCommentWriteError(initialResponse.status);
}

async function postCommentOnce(localIssueKey, payload, reason, context) {
  const response = requireCommentResponse(await postLocalComment(localIssueKey, payload, context));
  if (response.ok) {
    return response;
  }

  if (isAmbiguousCommentStatus(response.status)) {
    throw createAmbiguousCommentWriteError(response.status, reason);
  }

  throw createRejectedCommentWriteError(response.status);
}

async function postLocalComment(localIssueKey, payload, context) {
  await assertInboundScope({ orgId: context.orgId, issueKeys: [localIssueKey] });
  await assertPilotWritesAllowed('comment_create_local');
  // Reject current scope before either F02's submission marker or the permanent
  // claim. A provably unsent denial must leave both boundaries unconsumed.
  await assertInboundScope({ orgId: context.orgId, issueKeys: [localIssueKey] });
  if (!context.commentSubmissionStarted) {
    await markDeferredCommentSubmission(context.commentSubmission);
    await claimInboundCommentSubmission(context.submissionScope);
    context.commentSubmissionStarted = true;
  }
  // Retain the transport-side check: revocation during claim persistence still
  // blocks POST. An already acquired claim is conservatively retained.
  await assertInboundScope({ orgId: context.orgId, issueKeys: [localIssueKey] });
  try {
    return await api.asApp().requestJira(route`/rest/api/3/issue/${localIssueKey}/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    if (error?.code === 'PILOT_PAUSED') {
      throw error;
    }
    throw createAmbiguousCommentWriteError(null, 'comment-write-exception');
  }
}

async function resolveLocalParentForIncomingComment(parent, context) {
  if (!parent) return { remoteParentId: null, localParentId: null, parentAuthor: null, parentSnippet: null };
  const remoteParentId = String(parent.id);
  const localParentId = await getLocalCommentId(remoteParentId, context.orgId);
  return {
    remoteParentId,
    localParentId: localParentId ? String(localParentId) : null,
    parentAuthor: parent.author?.displayName || parent.author?.emailAddress || null,
    parentSnippet: extractPlainTextFromRemoteComment(parent)
  };
}

function extractParentIdFromRemoteComment(comment) {
  return commentParentId(comment);
}

function extractPlainTextFromRemoteComment(comment) {
  if (!comment) {
    return '';
  }

  if (comment.body && typeof comment.body === 'object') {
    const raw = extractTextFromADF(comment.body);
    return summarizeText(sanitizeCommentText(stripSyncPrefix(raw)));
  }

  if (typeof comment.body === 'string') {
    return summarizeText(sanitizeCommentText(stripSyncPrefix(comment.body)));
  }

  return '';
}

function summarizeText(text, maxLength = 140) {
  if (!text) {
    return '';
  }

  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.substring(0, maxLength - 3)}...`;
}

function shouldSyncIncomingComments(syncOptions) {
  if (!syncOptions) {
    return true;
  }
  if (typeof syncOptions.incomingComments === 'boolean') {
    return syncOptions.incomingComments;
  }
  if (typeof syncOptions.syncComments === 'boolean') {
    return syncOptions.syncComments;
  }
  return true;
}

function buildIncomingCommentKey(orgId, commentId) {
  const prefix = orgId || 'legacy';
  return `${prefix}:incoming-comment:${commentId}`;
}

function buildIncomingCommentReconciliationKey(orgId, commentId) {
  const prefix = orgId || 'legacy';
  return `${prefix}:incoming-comment-reconciliation:${commentId}`;
}

async function buildCreatePayload(remoteIssue, targetProjectKey, context) {
  const remoteFields = remoteIssue.fields || {};
  const fields = {
    project: { key: targetProjectKey },
    summary: remoteFields.summary,
    description: normalizeDescription(remoteFields.description),
    issuetype: determineLocalIssueType(remoteFields.issuetype, context.mappings.issueTypeMappings)
  };

  applyCommonFieldMirroring(fields, remoteFields, context);
  applyCustomFieldMappings(fields, remoteFields, context.mappings.fieldMappings);
  await applyParentMapping(fields, remoteFields, context);

  return { fields };
}

async function buildUpdatePayload(remoteIssue, context) {
  const remoteFields = remoteIssue.fields || {};
  const fields = {
    summary: remoteFields.summary,
    description: normalizeDescription(remoteFields.description)
  };

  const issueType = determineLocalIssueType(remoteFields.issuetype, context.mappings.issueTypeMappings);
  if (issueType) {
    fields.issuetype = issueType;
  }

  applyCommonFieldMirroring(fields, remoteFields, context);
  applyCustomFieldMappings(fields, remoteFields, context.mappings.fieldMappings);
  await applyParentMapping(fields, remoteFields, context);

  // Ensure attachment field is never sent in update payload
  if (fields.attachment) {
    delete fields.attachment;
  }

  console.log(`📦 Update payload contains ${Object.keys(fields).length} field(s)`);

  return { fields };
}

async function loadRemoteIssue(remoteIssue, context) {
  const fieldList = buildRemoteFieldList(context.mappings.fieldMappings);
  const fetched = await getRemoteIssue(remoteIssue.key, context.org, fieldList);
  if (fetched && fetched.fields) {
    return fetched;
  }

  console.log(`${LOG_EMOJI.WARNING} Falling back to webhook payload for ${remoteIssue.key}`);
  return remoteIssue;
}

function buildRemoteFieldList(fieldMappings) {
  const fields = new Set(BASE_REMOTE_FIELDS);
  for (const key of Object.keys(fieldMappings || {})) {
    if (key) {
      fields.add(key);
    }
  }
  return Array.from(fields);
}

function determineLocalIssueType(remoteIssueType, issueTypeMappings) {
  if (!remoteIssueType) {
    return { name: 'Task' };
  }

  if (issueTypeMappings) {
    const mapping = issueTypeMappings[remoteIssueType.id] || Object.values(issueTypeMappings).find(m => m.remoteName === remoteIssueType.name);
    if (mapping) {
      if (mapping.localId) {
        return { id: mapping.localId };
      }
      if (mapping.localName) {
        return { name: mapping.localName };
      }
    }
  }

  return { name: remoteIssueType.name || 'Task' };
}

function normalizeDescription(value) {
  if (!value) {
    return textToADF('');
  }
  if (typeof value === 'object') {
    const cloned = stripCounterpartNoticeFromADF(JSON.parse(JSON.stringify(value)));
    const sanitized = stripMediaNodes(cloned);
    if (!sanitized || !Array.isArray(sanitized.content) || sanitized.content.length === 0) {
      return textToADF('');
    }
    return sanitized;
  }
  if (typeof value === 'string') {
    return textToADF(value);
  }
  return textToADF('');
}

function stripMediaNodes(adfNode) {
  if (!adfNode || typeof adfNode !== 'object') {
    return adfNode;
  }

  // Remove media-related nodes entirely
  const mediaTypes = new Set(['media', 'mediaSingle', 'mediaGroup']);
  if (mediaTypes.has(adfNode.type)) {
    return null;
  }

  if (Array.isArray(adfNode.content)) {
    const cleaned = adfNode.content
      .map(child => stripMediaNodes(child))
      .filter(child => child !== null);
    adfNode.content = cleaned;
  }

  return adfNode;
}

function applyCommonFieldMirroring(targetFields, remoteFields, context) {
  if (remoteFields.priority) {
    targetFields.priority = { name: remoteFields.priority.name };
  }

  if ('labels' in remoteFields) {
    targetFields.labels = Array.isArray(remoteFields.labels) ? [...remoteFields.labels] : [];
  }

  if ('duedate' in remoteFields) {
    targetFields.duedate = remoteFields.duedate || null;
  }

  if ('components' in remoteFields) {
    const components = remoteFields.components || [];
    targetFields.components = components.map(component => ({ name: component.name }));
  }

  if ('fixVersions' in remoteFields) {
    const versions = remoteFields.fixVersions || [];
    targetFields.fixVersions = versions.map(version => ({ name: version.name }));
  }

  if ('versions' in remoteFields) {
    const versions = remoteFields.versions || [];
    targetFields.versions = versions.map(version => ({ name: version.name }));
  }

  if (remoteFields.timetracking && Object.keys(remoteFields.timetracking).length > 0) {
    targetFields.timetracking = deepClone(remoteFields.timetracking);
  }

  if ('assignee' in remoteFields) {
    if (remoteFields.assignee === null) {
      targetFields.assignee = null;
    } else if (remoteFields.assignee?.accountId) {
      const mapped = mapUserToLocal(remoteFields.assignee.accountId, context.mappings.userMappings);
      if (mapped) {
        targetFields.assignee = { accountId: mapped };
      }
      else {
        console.log(`${LOG_EMOJI.WARNING} No local mapping for remote assignee ${remoteFields.assignee.accountId}`);
      }
    }
  }

  if ('reporter' in remoteFields) {
    if (remoteFields.reporter === null) {
      targetFields.reporter = null;
    } else if (remoteFields.reporter?.accountId) {
      const mapped = mapUserToLocal(remoteFields.reporter.accountId, context.mappings.userMappings);
      if (mapped) {
        targetFields.reporter = { accountId: mapped };
      }
      else {
        console.log(`${LOG_EMOJI.WARNING} No local mapping for remote reporter ${remoteFields.reporter.accountId}`);
      }
    }
  }
}

function applyCustomFieldMappings(targetFields, remoteFields, fieldMappings) {
  if (!fieldMappings) {
    return;
  }

  for (const [remoteFieldId, mapping] of Object.entries(fieldMappings)) {
    const localFieldId = typeof mapping === 'string' ? mapping : mapping.localId;
    if (!localFieldId || BLOCKED_FIELD_KEYS.has(localFieldId) || localFieldId === 'attachment') {
      continue;
    }

    if (!(remoteFieldId in remoteFields)) {
      continue;
    }

    const value = remoteFields[remoteFieldId];
    if (value === undefined) {
      continue;
    }

     if (isRankLikeString(value) || containsRankMetadata(value)) {
       console.log(`⏭️ Skipping rank-like field ${remoteFieldId} → ${localFieldId}`);
       continue;
     }

    if (isAttachmentLikeValue(value)) {
      console.log(`${LOG_EMOJI.WARNING} Skipping attachment-like field ${remoteFieldId} → ${localFieldId}`);
      continue;
    }

    targetFields[localFieldId] = deepClone(value);
  }
}

function deepClone(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    console.log(`${LOG_EMOJI.WARNING} Could not deep clone field value, passing by reference`);
    return value;
  }
}

function isRankLikeString(value) {
  return typeof value === 'string' && /^\d+\|[A-Za-z0-9]+:/.test(value);
}

function containsRankMetadata(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some(item => containsRankMetadata(item));
  }

  return value.rankBeforeIssue !== undefined || value.rankAfterIssue !== undefined || value.lexoRank !== undefined;
}

function isAttachmentLikeValue(value) {
  if (!value) {
    return false;
  }

  const looksLikeAttachment = (candidate) => {
    return (
      candidate &&
      typeof candidate === 'object' &&
      typeof candidate.filename === 'string' &&
      (candidate.content !== undefined || candidate.mimeType !== undefined || candidate.size !== undefined)
    );
  };

  if (Array.isArray(value)) {
    return value.length > 0 && value.every(looksLikeAttachment);
  }

  return looksLikeAttachment(value);
}

async function applyParentMapping(targetFields, remoteFields, context) {
  if (!('parent' in remoteFields)) {
    return;
  }

  if (remoteFields.parent === null) {
    targetFields.parent = null;
    return;
  }

  const parentKey = remoteFields.parent?.key;
  if (!parentKey) {
    return;
  }

  const hintedLocalParent = remoteFields.localParentKey;
  const localParentKey = hintedLocalParent || await getLocalKey(parentKey, context.orgId);
  if (localParentKey) {
    targetFields.parent = { key: localParentKey };
    console.log(`${LOG_EMOJI.LINK} Mapped parent ${parentKey} → ${localParentKey}`);
  } else {
    console.log(`${LOG_EMOJI.WARNING} Parent ${parentKey} not synced locally yet - child will be standalone`);
  }
}

async function handleRemoteAttachmentCreated(payload, context) {
  const attachmentId = payload?.attachment?.id ?? payload?.attachmentId;
  if (!isValidAttachmentId(attachmentId)) {
    return { status: 'ATTACHMENT_ID_INVALID', code: 'INVALID_ATTACHMENT_ID' };
  }

  const remoteKey = isValidIssueKey(payload?.issue?.key)
    ? payload.issue.key
    : await fetchRemoteIssueKeyById(context.org, payload?.issue?.id);
  if (!remoteKey) {
    return { status: 'ATTACHMENT_ISSUE_UNRESOLVED', code: 'ATTACHMENT_ISSUE_UNRESOLVED' };
  }

  const localKey = await getLocalKey(remoteKey, context.orgId);
  if (!localKey) {
    return { status: 'ATTACHMENT_ISSUE_UNMAPPED', code: 'ATTACHMENT_ISSUE_NOT_MAPPED' };
  }

  if (!getAttachmentSyncPolicy(context.syncOptions).enabled) {
    return { status: 'ATTACHMENT_SYNC_DISABLED', code: 'ATTACHMENT_SYNC_DISABLED' };
  }

  await assertInboundScope({ orgId: context.orgId, issueKeys: [localKey] });
  try {
    await syncRemoteAttachmentsToLocal(
      remoteKey,
      localKey,
      { key: remoteKey, fields: { attachment: [{ id: String(attachmentId) }] } },
      context.org,
      null,
      context.orgId,
      {
        syncOptions: context.syncOptions,
        attachmentIds: [String(attachmentId)]
      }
    );
    return { status: 'ATTACHMENT_SYNCED', code: 'ATTACHMENT_SYNCED' };
  } catch (error) {
    if (isInboundScopeError(error)) throw error;
    return {
      status: 'ATTACHMENT_RECONCILIATION_REQUIRED',
      code: 'ATTACHMENT_RECONCILIATION_REQUIRED'
    };
  }
}

async function handleRemoteAttachmentDeleted(payload, context) {
  const attachmentId = payload?.attachment?.id ?? payload?.attachmentId;
  if (!isValidAttachmentId(attachmentId)) {
    return { status: 'ATTACHMENT_ID_INVALID', code: 'INVALID_ATTACHMENT_ID' };
  }

  const remoteKey = isValidIssueKey(payload?.issue?.key)
    ? payload.issue.key
    : await fetchRemoteIssueKeyById(context.org, payload?.issue?.id);
  if (!remoteKey) {
    return { status: 'ATTACHMENT_ISSUE_UNRESOLVED', code: 'ATTACHMENT_ISSUE_UNRESOLVED' };
  }

  const localKey = await getLocalKey(remoteKey, context.orgId);
  if (!localKey) {
    return { status: 'ATTACHMENT_ISSUE_UNMAPPED', code: 'ATTACHMENT_ISSUE_NOT_MAPPED' };
  }

  await assertInboundScope({ orgId: context.orgId, issueKeys: [localKey] });
  const result = await propagateAttachmentDeletion({
    direction: 'remote-to-local',
    sourceAttachmentId: String(attachmentId),
    localKey,
    remoteKey,
    config: context.org,
    orgId: context.orgId,
    syncOptions: context.syncOptions
  });
  return { status: result.status, code: result.status };
}

async function fetchRemoteIssueKeyById(org, issueId) {
  const normalizedId = issueId === undefined || issueId === null ? '' : String(issueId);
  if (!/^\d+$/.test(normalizedId)) {
    return null;
  }

  const auth = Buffer.from(`${org.remoteEmail}:${org.remoteApiToken}`).toString('base64');

  try {
    const response = await fetch(
      `${org.remoteUrl}/rest/api/3/issue/${normalizedId}?fields=issuelinks`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Accept': 'application/json'
        }
      }
    );

    if (!response.ok) {
      console.log(`${LOG_EMOJI.WARNING} Could not resolve remote issue ID ${normalizedId}`);
      return null;
    }

    const issue = await response.json();
    return issue?.key || null;
  } catch (error) {
    console.log(`${LOG_EMOJI.WARNING} Error resolving remote issue ID ${normalizedId}`);
    return null;
  }
}

/**
 * Jira system webhooks deliver issue links as numeric source/destination IDs
 * with an issueLinkType. Forge events deliver outward/inward issue objects and
 * type. Normalize both shapes without inferring anything from issue content.
 */
async function resolveIncomingIssueLink(payload, context) {
  const link = payload?.issueLink;
  if (!link || typeof link !== 'object') {
    return null;
  }

  const remoteOutwardKey = link.outwardIssue?.key
    || link.sourceIssueKey
    || await fetchRemoteIssueKeyById(context.org, link.sourceIssueId ?? payload.sourceIssueId);
  const remoteInwardKey = link.inwardIssue?.key
    || link.destinationIssueKey
    || await fetchRemoteIssueKeyById(context.org, link.destinationIssueId ?? payload.destinationIssueId);

  if (!remoteOutwardKey || !remoteInwardKey) {
    return null;
  }

  return {
    id: link.id ?? payload.issueLinkId ?? null,
    remoteOutwardKey,
    remoteInwardKey,
    linkTypeName: link.type?.name
      || link.issueLinkType?.name
      || payload.issueLinkType?.name
      || null
  };
}

function linkConnectsIssues(link, sourceKey, destinationKey, linkTypeName) {
  if (!link || !link.type) {
    return false;
  }
  if (linkTypeName && link.type.name !== linkTypeName) {
    return false;
  }

  const outwardKey = link.outwardIssue?.key;
  const inwardKey = link.inwardIssue?.key;
  const endpoints = [outwardKey, inwardKey].filter(Boolean);

  if (!endpoints.includes(destinationKey)) {
    return false;
  }

  return endpoints.includes(sourceKey) || endpoints.length === 1;
}

async function findMappedLocalLink(sourceKey, destinationKey, linkTypeName, orgId) {
  const localLinks = await fetchLocalIssueLinks(sourceKey);
  if (!localLinks) {
    return null;
  }

  const candidates = localLinks.filter(link => linkConnectsIssues(
    link,
    sourceKey,
    destinationKey,
    linkTypeName
  ));

  for (const candidate of candidates) {
    if (candidate?.id === undefined || candidate?.id === null) {
      continue;
    }

    const localLinkId = String(candidate.id);
    const storedMapping = await getLinkMapping(localLinkId, orgId);
    if (storedMapping) {
      return { localLinkId };
    }
  }

  return null;
}

async function deleteLocalIssueLink(localLinkId, context, issueKeys) {
  await assertInboundScope({ orgId: context.orgId, issueKeys });
  await assertPilotWritesAllowed('link_delete_local');

  let response;
  try {
    // Deliberately a single attempt. A DELETE timeout or 5xx may mean Jira
    // already deleted the link, so the caller must not auto-retry.
    response = await api.asApp().requestJira(
      route`/rest/api/3/issueLink/${localLinkId}`,
      { method: 'DELETE' }
    );
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Local issue-link DELETE outcome is ambiguous`);
    return { outcome: 'ambiguous' };
  }

  if (response?.ok || response?.status === 204) {
    return { outcome: 'deleted' };
  }
  if (response?.status === 404) {
    return { outcome: 'already_deleted' };
  }
  if (!response || response.status >= 500) {
    return { outcome: 'ambiguous' };
  }

  return { outcome: 'failed', status: response.status };
}

async function handleRemoteIssueLinkCreated(payload, context) {
  if (!shouldSyncIncomingLinks(context.syncOptions)) {
    console.log(`⏭️ Incoming links disabled for ${context.orgId || 'organization'}`);
    return;
  }

  const link = await resolveIncomingIssueLink(payload, context);
  if (!link) {
    console.log(`${LOG_EMOJI.WARNING} Link event missing usable issueLink payload`);
    return;
  }

  const linkTypeName = link.linkTypeName || 'Relates';
  if (!link.linkTypeName) {
    console.log(`${LOG_EMOJI.WARNING} Link event missing type name, defaulting to Relates`);
  }

  const localOutwardKey = await getLocalKey(link.remoteOutwardKey, context.orgId);
  const localInwardKey = await getLocalKey(link.remoteInwardKey, context.orgId);

  if (!localOutwardKey || !localInwardKey) {
    console.log(`${LOG_EMOJI.WARNING} Cannot sync link ${link.remoteOutwardKey} ⇄ ${link.remoteInwardKey} - missing local mapping(s)`);
    return;
  }

  await assertInboundScope({ orgId: context.orgId, issueKeys: [localOutwardKey, localInwardKey] });
  const existingLinks = await fetchLocalIssueLinks(localOutwardKey);
  if (!existingLinks) {
    console.log(`${LOG_EMOJI.WARNING} Could not load local issue ${localOutwardKey} links`);
    return;
  }

  if (linkCollectionContains(existingLinks, localInwardKey, linkTypeName)) {
    console.log(`${LOG_EMOJI.SKIP} Link ${localOutwardKey} ⇄ ${localInwardKey} (${linkTypeName}) already exists locally`);
    return;
  }

  const created = await createLocalIssueLink(localOutwardKey, localInwardKey, linkTypeName, context);
  if (!created) {
    return;
  }

  await recordInboundLinkMapping(localOutwardKey, localInwardKey, linkTypeName, context.orgId);
}

async function handleRemoteIssueLinkDeleted(payload, context) {
  if (!shouldSyncIncomingLinks(context.syncOptions)) {
    console.log(`⏭️ Incoming links disabled for ${context.orgId || 'organization'}`);
    return;
  }

  const link = await resolveIncomingIssueLink(payload, context);
  if (!link) {
    console.log(`${LOG_EMOJI.WARNING} Link deletion event missing usable issueLink payload`);
    return;
  }

  const localSourceKey = await getLocalKey(link.remoteOutwardKey, context.orgId);
  const localDestinationKey = await getLocalKey(link.remoteInwardKey, context.orgId);

  if (!localSourceKey || !localDestinationKey) {
    console.log(`${LOG_EMOJI.WARNING} Cannot delete link ${link.remoteOutwardKey} ⇄ ${link.remoteInwardKey} - missing issue mapping(s)`);
    return;
  }

  await assertInboundScope({ orgId: context.orgId, issueKeys: [localSourceKey, localDestinationKey] });
  // A link can only be removed through its stored local link mapping. Issue
  // keys alone, summaries, or pending-link retries are never sufficient.
  const mappedLink = await findMappedLocalLink(
    localSourceKey,
    localDestinationKey,
    link.linkTypeName,
    context.orgId
  );

  if (!mappedLink) {
    console.log(`${LOG_EMOJI.INFO} No stored link mapping for ${localSourceKey} ⇄ ${localDestinationKey}; no local DELETE attempted`);
    return;
  }

  const deletion = await deleteLocalIssueLink(mappedLink.localLinkId, context, [localSourceKey, localDestinationKey]);

  if (deletion.outcome === 'deleted' || deletion.outcome === 'already_deleted') {
    await removeLinkMapping(mappedLink.localLinkId, context.orgId);
    console.log(`${LOG_EMOJI.SUCCESS} Removed local issue link ${mappedLink.localLinkId} (${deletion.outcome})`);
    return;
  }

  if (deletion.outcome === 'ambiguous') {
    console.warn(`${LOG_EMOJI.WARNING} Local issue-link DELETE is ambiguous; mapping retained for reconciliation`);
    return { code: 'LINK_DELETE_AMBIGUOUS' };
  }

  console.error(`${LOG_EMOJI.ERROR} Local issue-link DELETE failed; mapping retained`);
  return { code: 'LINK_DELETE_FAILED' };
}

async function syncIncomingLinksForIssue(remoteIssue, localIssueKey, context) {
  if (!shouldSyncIncomingLinks(context.syncOptions)) {
    return;
  }

  const remoteLinks = remoteIssue?.fields?.issuelinks;
  if (!Array.isArray(remoteLinks) || remoteLinks.length === 0) {
    return;
  }

  const localLinks = await fetchLocalIssueLinks(localIssueKey);
  if (localLinks === null) {
    return;
  }

  const workingLocalLinks = [...localLinks];

  for (const remoteLink of remoteLinks) {
    const linkTypeName = remoteLink?.type?.name || 'Relates';
    const remoteLinkedIssueKey = remoteLink.outwardIssue?.key || remoteLink.inwardIssue?.key;
    if (!remoteLinkedIssueKey) {
      continue;
    }

    const localLinkedKey = await getLocalKey(remoteLinkedIssueKey, context.orgId);
    if (!localLinkedKey) {
      console.log(`${LOG_EMOJI.INFO} Skipping link ${remoteIssue.key} ⇄ ${remoteLinkedIssueKey} - linked issue not synced locally`);
      continue;
    }

    if (linkCollectionContains(workingLocalLinks, localLinkedKey, linkTypeName)) {
      continue;
    }

    const direction = remoteLink.outwardIssue ? 'outward' : 'inward';
    const outwardKey = direction === 'outward' ? localIssueKey : localLinkedKey;
    const inwardKey = direction === 'outward' ? localLinkedKey : localIssueKey;

    const created = await createLocalIssueLink(outwardKey, inwardKey, linkTypeName, context);
    if (created) {
      console.log(`${LOG_EMOJI.SUCCESS} Synced incoming link ${localIssueKey} ⇄ ${localLinkedKey} (${linkTypeName})`);
      workingLocalLinks.push({
        type: { name: linkTypeName },
        outwardIssue: direction === 'outward' ? { key: localLinkedKey } : null,
        inwardIssue: direction === 'inward' ? { key: localLinkedKey } : null
      });
      await recordInboundLinkMapping(localIssueKey, localLinkedKey, linkTypeName, context.orgId);
    }
  }
}

async function processPendingChildIssues(remoteParentKey, context, pendingChildKeys = null, attempt = 1) {
  const childKeys = pendingChildKeys || await consumePendingChildIssues(remoteParentKey, context.orgId);
  if (!childKeys || childKeys.length === 0) {
    return;
  }

  console.log(`${LOG_EMOJI.INFO} Processing ${childKeys.length} pending child issue(s) waiting for ${remoteParentKey} (attempt ${attempt}/${PENDING_CHILD_MAX_ATTEMPTS})`);
  const failures = [];

  for (const childKey of childKeys) {
    try {
      const childIssue = await getRemoteIssue(childKey, context.org, buildRemoteFieldList(context.mappings.fieldMappings));
      if (!childIssue) {
        console.log(`${LOG_EMOJI.WARNING} Could not refetch pending child issue ${childKey}, will retry`);
        failures.push(childKey);
        continue;
      }

      await handleRemoteIssueCreated(childIssue, context, {
        allowQueueOnMissingParent: false,
        retrySource: 'pending-child',
        retryAttempt: attempt
      });
    } catch (error) {
      console.error(`${LOG_EMOJI.ERROR} Error processing pending child issue ${childKey}:`, error);
      failures.push(childKey);
    }
  }

  if (failures.length === 0) {
    return;
  }

  if (attempt >= PENDING_CHILD_MAX_ATTEMPTS) {
    console.warn(`${LOG_EMOJI.WARNING} Pending child issues for ${remoteParentKey} still failing after ${attempt} attempts; re-queueing ${failures.length} item(s)`);
    for (const failedKey of failures) {
      await enqueuePendingChildIssue(remoteParentKey, failedKey, context.orgId);
    }
    return;
  }

  await sleep(PARENT_MAPPING_RETRY_DELAY_MS);
  await processPendingChildIssues(remoteParentKey, context, failures, attempt + 1);
}


async function ensureParentReadyForCreate(remoteIssue, context, options = {}) {
  const allowQueue = options.allowQueueOnMissingParent !== false;
  if (!isSubtaskIssue(remoteIssue)) {
    return true;
  }

  const parentKey = remoteIssue.fields?.parent?.key;
  if (!parentKey) {
    console.log(`${LOG_EMOJI.WARNING} Subtask ${remoteIssue.key} is missing parent reference in payload`);
    return true;
  }

  const localParentKey = await waitForLocalParentKey(parentKey, context.orgId);
  if (localParentKey) {
    remoteIssue.localParentKey = localParentKey;
    return true;
  }

  if (!allowQueue) {
    console.log(`${LOG_EMOJI.WARNING} Parent ${parentKey} still unavailable locally; cannot create ${remoteIssue.key} yet`);
    return false;
  }

  await enqueuePendingChildIssue(parentKey, remoteIssue.key, context.orgId);
  console.log(`${LOG_EMOJI.INFO} Queued subtask ${remoteIssue.key} until parent ${parentKey} syncs locally`);
  return false;
}

async function waitForLocalParentKey(remoteParentKey, orgId) {
  for (let attempt = 1; attempt <= PARENT_MAPPING_RETRY_ATTEMPTS; attempt++) {
    const localKey = await getLocalKey(remoteParentKey, orgId);
    if (localKey) {
      if (attempt === 1) {
        console.log(`${LOG_EMOJI.INFO} Parent ${remoteParentKey} already mapped to ${localKey}`);
      } else {
        const waited = (attempt - 1) * PARENT_MAPPING_RETRY_DELAY_MS;
        console.log(`${LOG_EMOJI.INFO} Parent ${remoteParentKey} mapped to ${localKey} after waiting ${waited}ms`);
      }
      return localKey;
    }

    if (attempt < PARENT_MAPPING_RETRY_ATTEMPTS) {
      console.log(`${LOG_EMOJI.INFO} Waiting for parent ${remoteParentKey} mapping (attempt ${attempt}/${PARENT_MAPPING_RETRY_ATTEMPTS})`);
      await sleep(PARENT_MAPPING_RETRY_DELAY_MS);
    }
  }

  return null;
}

function isSubtaskIssue(remoteIssue) {
  const issueType = remoteIssue?.fields?.issuetype;
  if (!issueType) {
    return false;
  }

  if (issueType.subtask === true) {
    return true;
  }

  const name = issueType.name || '';
  return name.toLowerCase() === 'sub-task' || name.toLowerCase() === 'subtask';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shouldSyncIncomingLinks(syncOptions) {
  if (!syncOptions) {
    return true;
  }
  if (typeof syncOptions.incomingLinks === 'boolean') {
    return syncOptions.incomingLinks;
  }
  if (typeof syncOptions.syncLinks === 'boolean') {
    return syncOptions.syncLinks;
  }
  return true;
}

function payloadHasNonFieldContentChange(payload) {
  const items = payload?.changelog?.items;
  if (!Array.isArray(items)) return false;
  return items.some(item => ['link', 'attachment', 'comment'].includes(String(item?.field || '').toLowerCase()));
}

function shouldSkipUpdateForAttachmentOnly(payload) {
  const items = payload?.changelog?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return false;
  }

  return items.every(item => {
    const fieldName = item?.field?.toLowerCase?.();
    return fieldName === 'attachment';
  });
}

function isAttachmentEvent(webhookEvent) {
  return webhookEvent === 'attachment_created' || webhookEvent === 'jira:attachment_created' ||
         webhookEvent === 'attachment_deleted' || webhookEvent === 'jira:attachment_deleted';
}

function isIssueLinkEvent(webhookEvent) {
  return webhookEvent === 'jira:issue_link_created' || webhookEvent === 'jira:issue_link_deleted' ||
         webhookEvent === 'issuelink_created' || webhookEvent === 'issuelink_deleted';
}

async function fetchLocalIssueLinks(issueKey) {
  try {
    const response = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=issuelinks`);
    if (!response.ok) {
      console.error(`${LOG_EMOJI.ERROR} Failed to fetch local issue ${issueKey} links: ${response.status}`);
      return null;
    }
    const issue = await response.json();
    return issue.fields?.issuelinks || [];
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error fetching local issue ${issueKey}:`, error);
    return null;
  }
}

function linkCollectionContains(links, targetKey, linkTypeName) {
  return Boolean(findMatchingLink(links, targetKey, linkTypeName));
}

function findMatchingLink(links, targetKey, linkTypeName) {
  if (!Array.isArray(links)) {
    return null;
  }
  return links.find(link => matchesLink(link, targetKey, linkTypeName));
}

function matchesLink(link, targetKey, linkTypeName) {
  if (!link || !link.type) {
    return false;
  }
  if (linkTypeName && link.type.name !== linkTypeName) {
    return false;
  }
  const otherKey = link.outwardIssue?.key || link.inwardIssue?.key;
  return otherKey === targetKey;
}

async function createLocalIssueLink(outwardKey, inwardKey, linkTypeName, context) {
  await assertInboundScope({ orgId: context.orgId, issueKeys: [outwardKey, inwardKey] });
  await assertPilotWritesAllowed('link_create_local');
  const payload = {
    type: { name: linkTypeName },
    inwardIssue: { key: inwardKey },
    outwardIssue: { key: outwardKey }
  };

  try {
    const response = await api.asApp().requestJira(route`/rest/api/3/issueLink`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (response.ok || response.status === 201) {
      console.log(`${LOG_EMOJI.SUCCESS} Created local issue link ${outwardKey} ⇄ ${inwardKey} (${linkTypeName})`);
      return true;
    }

    console.error(`${LOG_EMOJI.ERROR} Failed to create local issue link`);
    return false;
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error creating local issue link:`, error);
    return false;
  }
}

async function recordInboundLinkMapping(sourceKey, targetKey, linkTypeName, orgId) {
  const updatedLinks = await fetchLocalIssueLinks(sourceKey);
  if (!updatedLinks) {
    return;
  }
  const createdLink = findMatchingLink(updatedLinks, targetKey, linkTypeName);
  if (createdLink?.id) {
    await storeLinkMapping(createdLink.id, 'inbound', orgId);
    console.log(`${LOG_EMOJI.INFO} Recorded inbound link mapping for ${sourceKey} ⇄ ${targetKey}`);
  }
}

async function deferIncomingCommentVerification(payload, orgId, error) {
  const hint = extractParentIdFromRemoteComment(payload.comment);
  if (hint === '!unverifiable' || error.parentId === '!unverifiable'
      || (hint && error.parentId && hint !== error.parentId)) {
    await rejectDeferredCommentAncestry({ direction: 'remote-to-local', orgId, issueKey: payload.issue?.key,
      commentId: String(payload.comment?.id) });
    throw Object.assign(new Error('Comment ancestry rejected'), { code: 'COMMENT_REJECTED' });
  }
  return deferCommentVerification({ direction: 'remote-to-local', orgId,
    issueKey: payload.issue?.key, commentId: payload.comment?.id,
    parentId: error.parentId || hint, ancestry: error.ancestry }, error);
}
