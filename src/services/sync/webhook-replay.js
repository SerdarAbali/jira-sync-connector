import { createHash, randomBytes } from 'crypto';
import * as kvsStore from '../storage/kvs.js';
import { isKeyConflictError } from '../../utils/storage-errors.js';

export { isKeyConflictError };

export const PROCESSING_LEASE_SECONDS = 60;
export const COMPLETED_MARKER_TTL_SECONDS = 300;

function stablePrimitive(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  return null;
}

/**
 * Build a deterministic fingerprint from stable payload identifiers. This is
 * duplicate suppression, not signed replay authentication. The secret and the
 * complete body are never included.
 *
 * Returns null when the payload lacks an entity identifier; such events are
 * processed normally rather than being falsely classified as duplicates.
 */
export function buildWebhookFingerprint(payload, orgId) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (typeof orgId !== 'string' || !orgId) return null;

  const event = stablePrimitive(payload.webhookEvent);
  if (!event) return null;

  const issue = payload.issue && typeof payload.issue === 'object' ? payload.issue : {};
  const fields = issue.fields && typeof issue.fields === 'object' ? issue.fields : {};
  const comment = payload.comment && typeof payload.comment === 'object' ? payload.comment : {};
  const attachment = payload.attachment && typeof payload.attachment === 'object' ? payload.attachment : {};
  const issueLink = payload.issueLink && typeof payload.issueLink === 'object' ? payload.issueLink : {};

  const issueId = stablePrimitive(issue.id) || stablePrimitive(payload.issueId);
  const issueKey = stablePrimitive(issue.key) || stablePrimitive(payload.issueKey);
  const commentId = stablePrimitive(comment.id) || stablePrimitive(payload.commentId);
  const attachmentId = stablePrimitive(attachment.id) || stablePrimitive(payload.attachmentId);
  const issueLinkId = stablePrimitive(issueLink.id) || stablePrimitive(payload.issueLinkId);
  const timestamp = stablePrimitive(payload.timestamp)
    || stablePrimitive(fields.updated)
    || stablePrimitive(payload.updated);

  // Each event family has its own reliable identity. Falling back to an issue
  // id for a comment/attachment/link would collapse distinct events into one
  // false duplicate. An update without a timestamp is likewise untracked.
  let identityKind = null;
  if (event === 'jira:issue_created') {
    identityKind = (issueId || issueKey) ? 'issue-created' : null;
  } else if (event === 'jira:issue_updated') {
    identityKind = (issueId || issueKey) && timestamp ? 'issue-updated' : null;
  } else if (event === 'jira:issue_deleted') {
    identityKind = (issueId || issueKey) ? 'issue-deleted' : null;
  } else if (event === 'comment_created') {
    identityKind = commentId ? 'comment-created' : null;
  } else if (event === 'attachment_created' || event === 'jira:attachment_created' || event === 'attachment_deleted' || event === 'jira:attachment_deleted') {
    identityKind = attachmentId ? 'attachment-event' : null;
  } else if (event === 'jira:issue_link_created' || event === 'jira:issue_link_deleted'
    || event === 'issuelink_created' || event === 'issuelink_deleted') {
    identityKind = issueLinkId ? 'issue-link-event' : null;
  } else {
    identityKind = (issueId || issueKey) ? 'generic' : null;
  }

  if (!identityKind) return null;

  const canonical = JSON.stringify([
    ['orgId', orgId],
    ['event', event],
    ['identity', identityKind],
    ['issueId', issueId],
    ['issueKey', issueKey],
    ['commentId', commentId],
    ['attachmentId', attachmentId],
    ['issueLinkId', issueLinkId],
    ['timestamp', timestamp]
  ]);

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function webhookMarkerKey(orgId, fingerprint) {
  return `webhook-replay:${orgId}:${fingerprint}`;
}

/**
 * Returns:
 * - claimed: this request owns a new processing marker
 * - completed: the same fingerprint already completed successfully
 * - processing: another request owns an active processing marker
 * - storage_error: the marker store failed for a reason other than conflict
 * - untracked: the payload has insufficient stable identity for deduplication
 */
export async function claimWebhookEvent(payload, orgId) {
  const fingerprint = buildWebhookFingerprint(payload, orgId);
  if (!fingerprint) {
    return { status: 'untracked' };
  }

  const key = webhookMarkerKey(orgId, fingerprint);
  const now = Date.now();
  const token = randomBytes(24).toString('hex');
  const marker = {
    state: 'processing',
    fingerprint,
    token,
    claimedAt: new Date(now).toISOString(),
    leaseExpiresAt: new Date(now + PROCESSING_LEASE_SECONDS * 1000).toISOString()
  };

  try {
    await kvsStore.setIfNotExists(key, marker, PROCESSING_LEASE_SECONDS);
    return { status: 'claimed', key, token };
  } catch (error) {
    if (!isKeyConflictError(error)) {
      return { status: 'storage_error' };
    }

    let existing;
    try {
      existing = await kvsStore.get(key);
    } catch {
      return { status: 'storage_error' };
    }

    if (existing?.state === 'completed') {
      return { status: 'completed' };
    }

    // A missing marker after a conflict is a TTL race. Treat it as active
    // processing rather than risk executing a concurrent duplicate.
    return { status: 'processing' };
  }
}

export async function markWebhookCompleted(key, token = null) {
  if (token) {
    try {
      const existing = await kvsStore.get(key);
      if (existing?.token && existing.token !== token) {
        return { completed: false, status: 'not-owner' };
      }
    } catch {
      return { completed: false, status: 'storage-error' };
    }
  }
  await kvsStore.setWithTtl(key, {
    state: 'completed',
    completedAt: new Date().toISOString()
  }, COMPLETED_MARKER_TTL_SECONDS);
  return { completed: true, status: 'completed' };
}

export async function releaseWebhookEvent(key, token = null) {
  try {
    if (token) {
      const existing = await kvsStore.get(key);
      if (existing?.token && existing.token !== token) {
        return { released: false, status: 'not-owner' };
      }
    }
    await kvsStore.del(key);
    return { released: true, status: 'released' };
  } catch {
    // The short processing lease is the fallback so Jira can retry.
    return { released: false, status: 'storage-error' };
  }
}
