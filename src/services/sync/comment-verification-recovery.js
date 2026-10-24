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
  if (identifiers.ancestry || existing?.ancestry) {
    const ancestry = new Map();
    for (const pairs of [existing?.ancestry || [], identifiers.ancestry || []]) {
      if (!Array.isArray(pairs) || pairs.length > 8) throw new Error('Invalid comment ancestry identifiers');
      for (const pair of pairs) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string'
            || !/^[A-Za-z0-9_-]{1,100}$/.test(pair[0])
            || (pair[1] !== null && (typeof pair[1] !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(pair[1])))) {
          throw new Error('Invalid comment ancestry identifiers');
        }
        const previous = ancestry.get(pair[0]);
        if (previous && pair[1] && previous !== pair[1]) throw new Error('Conflicting comment ancestry identifiers');
        ancestry.set(pair[0], pair[1] || previous || null);
      }
    }
    if (ancestry.size > 8) throw new Error('Invalid comment ancestry identifiers');
    record.ancestry = Array.from(ancestry);
  }
  if (existing?.state === 'write_started') record.state = existing.state;
  await storage.set(key, record);
  return { status: 'COMMENT_VERIFICATION_DEFERRED' };
}

// A contradictory hint cannot leave an older deferred job free to copy later.
export async function rejectDeferredCommentAncestry(identifiers) {
  const key = keyFor(identifiers);
  const existing = await storage.get(key);
  await storage.set(key.replace(PREFIX, 'comment-verification-attention:'), {
    ...(existing || identifiers), reason: 'COMMENT_ANCESTRY_REJECTED'
  });
  await storage.del(key);
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

/**
 * Plan the release of F02's submission boundary of a deferred comment after the
 * outbound submission protocol proved that no request reached Jira.
 *
 * `write_started` and `comment-verification-submission:` exist so that recovery
 * never becomes a blind destination-write retry after a crash or an ambiguous
 * transport outcome. They may only be dropped for the invocation that owns the
 * permanent comment-submission claim and proved that the Jira transport was
 * never reached, and that proof has to become durable *together with* F06's
 * `pre_submission` phase: an ARMED phase is consumable by any delivery, so a
 * delivery that consumes it while `write_started` is still set can only fence the
 * comment permanently (`PRE_SUBMISSION_GUARD_BLOCKED`) without ever submitting.
 *
 * The returned `stage(transaction)` therefore appends the verification-record
 * rewrite and the marker deletion to the caller's transaction, which already
 * carries the token-and-state predicate that returns the phase to
 * `pre_submission`. Phase and boundary commit or roll back together — Forge
 * commits custom-entity and Key-Value Store operations of one transaction
 * atomically — so no interleaving can observe one without the other, and a stale
 * invocation whose predicate no longer matches publishes nothing.
 *
 * Identity (ancestry, parent, scope), the throttle deadline, and the attempt
 * budget are preserved; a later delivery still has to pass the same freshness,
 * confidentiality, Pause, lease, and claim checks.
 *
 * `confirmed: false` means the boundary must not be released — a manual attention
 * record exists, or the direction is not an outbound copy — and the caller must
 * leave the phase fenced instead of publishing an ARMED phase. Callers must
 * treat a rejection as "keep the marker": recovery stays conservative and
 * requires reconciliation rather than replaying blindly.
 */
export async function prepareDeferredSubmissionRelease(identifiers) {
  // Only outbound copies are fenced by comment-submission.js.
  if (identifiers?.direction !== 'local-to-remote') {
    return { status: 'NOT_APPLICABLE', confirmed: false, stage() {} };
  }
  const key = keyFor(identifiers);
  if (await storage.get(key.replace(PREFIX, 'comment-verification-attention:'))) {
    return { status: 'ATTENTION_RETAINED', confirmed: false, stage() {} };
  }
  const record = await storage.get(key);
  const releasing = record?.state === 'write_started';
  return {
    status: releasing ? 'RELEASED' : 'MARKER_RELEASED',
    confirmed: true,
    // Staged into the caller's transaction: never a separate commit.
    stage(transaction) {
      if (releasing) {
        const { state, ...pending } = record;
        transaction.set(key, { ...pending, submissionReleasedAt: Date.now() });
      }
      // Deleting succeeds whether the marker exists or not, and the marker can
      // only belong to this scope's identity.
      transaction.delete(key.replace(PREFIX, 'comment-verification-submission:'));
    }
  };
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
      // A delivery that lost a young fence only observed another invocation's
      // operation in flight; it is not evidence that a destination write started.
      // Keep the attempt pending so the fence owner can finish and the next pass
      // records the real outcome. An older fence still escalates to attention.
      const inProgress = outcome === 'COMMENT_RECONCILIATION_REQUIRED'
        && result?.reason === 'SUBMISSION_IN_PROGRESS';
      if (outcome === 'COMMENT_RECONCILIATION_REQUIRED' && !inProgress) {
        await storage.set(key.replace(PREFIX, 'comment-verification-attention:'), { ...attempt, state: 'write_started' });
        await storage.del(key);
      } else if (TERMINAL.has(outcome)) {
        await storage.set(key, { ...attempt, state: 'terminal', outcome });
        await storage.del(key);
        recovered++;
      } else {
        const latest = await storage.get(key);
        if (latest) await storage.set(key, { ...latest, lastOutcome: outcome === 'COMMENT_RETRY' ? 'COMMENT_RETRY'
          : inProgress ? 'SUBMISSION_IN_PROGRESS'
          : outcome === 'COMMENT_VERIFICATION_DEFERRED' ? outcome : 'NO_TERMINAL_OUTCOME' });
      }
      // Undefined, HTTP success alone, pauses, duplicate-in-flight, and errors
      // are not evidence of successful copying. Retain their durable attempt.
    } catch {
      // Keep pending state; never count a failed persistence as completion.
    } finally { await storage.del(leaseKey); }
  }
  return { recovered };
}
