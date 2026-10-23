import * as storage from '../storage/kvs.js';
import { CommentVerificationDeferred } from '../jira/comment-read.js';
import { isKeyConflictError } from '../../utils/storage-errors.js';

const PREFIX = 'comment-verification:';
const MAX_ATTEMPTS = 5;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function keyFor({ direction, orgId, issueKey, commentId }) {
  if (!['local-to-remote', 'remote-to-local'].includes(direction)
      || !/^(org-\d+|legacy)$/.test(orgId)
      || !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(issueKey)
      || !/^[A-Za-z0-9_-]{1,100}$/.test(String(commentId))) {
    throw new Error('Invalid comment verification identifiers');
  }
  return `${PREFIX}${direction}:${orgId}:${issueKey}:${commentId}`;
}

async function scheduleFor(key, existing, now = Date.now()) {
  const deadlines = await storage.queryByPrefix(key.replace(PREFIX, 'comment-verification-deadline:') + ':', 100);
  // Saturation cannot establish the maximum safely: require manual attention.
  if (deadlines.length >= 100) throw new CommentVerificationDeferred(24 * 60 * 60 * 1000);
  return Math.max(existing?.notBefore || 0, ...deadlines.map(row => row.value.notBefore || 0), now);
}

export async function assertCommentVerificationReady(identifiers, now = Date.now()) {
  const key = keyFor(identifiers);
  const record = await storage.get(key);
  const attention = await storage.get(key.replace(PREFIX, 'comment-verification-attention:'));
  if (attention || record?.state === 'write_started') {
    const error = new Error('Comment verification requires attention');
    error.code = 'COMMENT_RECONCILIATION_REQUIRED';
    error.persisted = true;
    throw error;
  }
  const deadline = await scheduleFor(key, record, now);
  if (deadline > now) throw new CommentVerificationDeferred(deadline - now);
}

export async function deferCommentVerification(identifiers, error) {
  const key = keyFor(identifiers);
  if (await storage.get(key.replace(PREFIX, 'comment-verification-attention:'))) {
    return { status: 'COMMENT_VERIFICATION_ATTENTION' };
  }
  const requested = Date.now() + Math.max(60000, Number(error?.retryAfterMs) || 60000);
  // Immutable deadlines prevent concurrent read/modify/write from shortening
  // server throttling. Duplicate identical deadlines share a key.
  await storage.set(key.replace(PREFIX, 'comment-verification-deadline:') + ':' + requested, { notBefore: requested });
  const existing = await storage.get(key);
  const record = {
    direction: identifiers.direction, orgId: identifiers.orgId,
    issueKey: identifiers.issueKey, commentId: String(identifiers.commentId),
    createdAt: existing?.createdAt || Date.now(), attempts: existing?.attempts || 0,
    notBefore: Math.max(requested, await scheduleFor(key, existing))
  };
  const parentId = error?.parentId || identifiers.parentId || existing?.parentId;
  if (parentId && /^[A-Za-z0-9_-]{1,100}$/.test(String(parentId))) record.parentId = String(parentId);
  if (existing?.state === 'write_started') record.state = existing.state;
  await storage.set(key, record);
  return { status: 'COMMENT_VERIFICATION_DEFERRED' };
}

export async function markDeferredCommentSubmission(identifiers) {
  await assertCommentVerificationReady(identifiers);
  const key = keyFor(identifiers);
  const record = await storage.get(key);
  const attention = await storage.get(key.replace(PREFIX, 'comment-verification-attention:'));
  if (record?.state === 'write_started' || attention?.state === 'write_started') {
    const error = new Error('Comment reconciliation required');
    error.code = 'COMMENT_RECONCILIATION_REQUIRED';
    error.persisted = true;
    throw error;
  }
  if (!record) return;
  try {
    await storage.setIfNotExists(key.replace(PREFIX, 'comment-verification-submission:'), true, 48 * 60 * 60);
  } catch {
    const error = new Error('Comment reconciliation required');
    error.code = 'COMMENT_RECONCILIATION_REQUIRED';
    error.persisted = true;
    throw error;
  }
  // A crash after this boundary cannot turn verification recovery into a
  // blind destination-write retry, even if its normal mapping was not saved.
  await storage.set(key, { ...record, state: 'write_started' });
}

const TERMINAL = new Set(['COMMENT_SYNCED', 'COMMENT_ALREADY_MAPPED', 'COMMENT_REJECTED', 'COMMENT_IGNORED_CONNECTOR', 'CANCELLED']);

// Only explicit terminal outcomes permit deletion, after durable recording.
export async function recoverCommentVerifications(retry, now = Date.now()) {
  const records = await storage.queryByPrefix(PREFIX, 100);
  let recovered = 0;
  let attempted = 0;
  for (const { key, value: snapshot } of records) {
    if (attempted >= 3) break;
    keyFor(snapshot);
    const leaseKey = key.replace(PREFIX, 'comment-verification-worker:');
    try { await storage.setIfNotExists(leaseKey, true, 360); }
    catch (error) { if (isKeyConflictError(error)) continue; throw error; }
    try {
      const record = await storage.get(key);
      if (!record) continue;
      if (record.state === 'terminal') {
        await storage.del(key);
        recovered++;
        continue;
      }
      if (record.state === 'write_started' || record.attempts >= MAX_ATTEMPTS || now - record.createdAt >= MAX_AGE_MS) {
        await storage.set(key.replace(PREFIX, 'comment-verification-attention:'), { ...record,
          reason: record.state === 'write_started' ? 'interrupted-submission'
            : record.attempts >= MAX_ATTEMPTS ? 'verification-exhausted' : 'verification-expired' });
        await storage.del(key);
        continue;
      }
      if (await scheduleFor(key, record, now) > now) continue;
      attempted++;
      const attempt = { ...record, attempts: record.attempts + 1 };
      await storage.set(key, attempt);
      const result = await retry(record);
      const outcome = result?.body?.code || result?.status;
      if (outcome === 'COMMENT_RECONCILIATION_REQUIRED') {
        await storage.set(key.replace(PREFIX, 'comment-verification-attention:'), { ...attempt, state: 'write_started' });
        await storage.del(key);
      } else if (TERMINAL.has(outcome)) {
        await storage.set(key, { ...attempt, state: 'terminal', outcome });
        await storage.del(key);
        recovered++;
      } else {
        const latest = await storage.get(key);
        if (latest) await storage.set(key, { ...latest, lastOutcome: outcome === 'COMMENT_RETRY'
          ? 'COMMENT_RETRY' : outcome === 'COMMENT_VERIFICATION_DEFERRED' ? outcome : 'NO_TERMINAL_OUTCOME' });
      }
      // Undefined, HTTP success alone, pauses, duplicate-in-flight, and errors
      // are not evidence of successful copying. Retain their durable attempt.
    } catch {
      // Keep pending state; never count a failed persistence as completion.
    } finally { await storage.del(leaseKey); }
  }
  return { recovered };
}
