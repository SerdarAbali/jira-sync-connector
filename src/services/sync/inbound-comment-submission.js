import { createHash } from 'crypto';
import * as storage from '../storage/kvs.js';

const PREFIX = 'inbound-comment-submission:';
const RESULT = 'inbound-comment-result:';

function reconciliation(reason, persisted = true) {
  return Object.assign(new Error('Incoming comment requires reconciliation'), {
    code: 'COMMENT_RECONCILIATION_REQUIRED', reason, persisted
  });
}

function keyFor(scope) {
  if (!/^(org-\d+|legacy)$/.test(scope.orgId || 'legacy')
      || !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(scope.remoteIssueKey)
      || !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(scope.localKey)
      || !/^[A-Za-z0-9_-]{1,100}$/.test(String(scope.commentId))) {
    throw reconciliation('INVALID_SUBMISSION_SCOPE', false);
  }
  // Source/destination key changes never grant a new submission for the same comment.
  return PREFIX + createHash('sha256').update(JSON.stringify([
    scope.orgId || 'legacy', 'remote-to-local', String(scope.commentId)
  ])).digest('hex');
}

function identity(scope) {
  return { orgId: scope.orgId || 'legacy', remoteIssueKey: scope.remoteIssueKey,
    remoteCommentId: String(scope.commentId), localKey: scope.localKey };
}

/** Permanent create-if-absent fence. No TTL, deletion or automatic replay. */
export async function claimInboundCommentSubmission(scope) {
  try {
    await storage.createIfNotExists(keyFor(scope), { ...identity(scope), state: 'submission_may_have_started',
      createdAt: Date.now() });
  } catch {
    // A lost storage acknowledgement may have committed. Never send on error.
    throw reconciliation('CLAIM_UNAVAILABLE_OR_ALREADY_EXISTS', false);
  }
}

/** Read-only recovery can use only a positively recorded destination identity. */
export async function readInboundCommentReceipt(scope) {
  const key = keyFor(scope);
  let claim, receipt;
  try {
    claim = await storage.get(key);
    receipt = await storage.get(key.replace(PREFIX, RESULT));
  } catch { throw reconciliation('SUBMISSION_STORAGE_UNAVAILABLE', false); }
  if (claim == null && receipt == null) return null;
  const matches = record => record && Object.entries(identity(scope)).every(([name, value]) => record[name] === value);
  if (!matches(claim) || !matches(receipt) || receipt.state !== 'destination_confirmed'
      || typeof receipt.destinationCommentId !== 'string'
      || !/^[A-Za-z0-9_-]{1,100}$/.test(receipt.destinationCommentId)) {
    throw reconciliation('SUBMISSION_OUTCOME_UNCONFIRMED');
  }
  return receipt;
}

export async function recordInboundCommentReceipt(scope, destinationCommentId) {
  const id = String(destinationCommentId);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw reconciliation('INVALID_SUCCESS_RESPONSE');
  try {
    await storage.createIfNotExists(keyFor(scope).replace(PREFIX, RESULT), {
      ...identity(scope), state: 'destination_confirmed', destinationCommentId: id, recordedAt: Date.now()
    });
  } catch { throw reconciliation('RECEIPT_STORAGE_UNAVAILABLE'); }
}
