import { assertJiraSubmissionAllowed, fetch } from '../jira/guarded-api.js';
import { createHash, randomBytes } from 'crypto';
import kvs, { Filter, FilterConditions as C } from '@forge/kvs';
import * as storage from '../storage/kvs.js';
import { storeCommentMapping } from '../storage/mappings.js';
import { isKeyConflictError } from '../../utils/storage-errors.js';
import { prepareDeferredSubmissionRelease } from './comment-verification-recovery.js';

const PREFIX = 'comment-submission:';
const RESULT_PREFIX = 'comment-submission-result:';

// Phase record for one submission operation. Basic KVS keys support only
// create-if-absent, so the difference between "claimed, with no request handed
// to the transport" and "submission may have started" is held in an entity that
// supports atomic conditional updates. The record is permanent: only its phase
// may change, and it is never deleted.
const OPERATION_ENTITY = 'comment-submission';
const ARMED = 'pre_submission';
const FENCED = 'submission_may_have_started';
// Raised by the submission guards, which all run before the SDK transport is
// handed the request. Only these prove that no submission attempt occurred.
export const PRE_SUBMISSION_CODES = new Set(['PILOT_PAUSED', 'PAUSE_STATE_UNAVAILABLE', 'LEASE_NOT_OWNED',
  'LEASE_OWNERSHIP_UNAVAILABLE', 'LEASE_MIGRATION_REQUIRED']);
// A fence younger than this may still belong to a delivery that is running in
// another invocation. Inspection reports such a fence as in progress, and F02
// recovery keeps it pending instead of escalating to manual attention.
const IN_PROGRESS_MS = 6 * 60 * 1000;

export function commentSubmissionKey({ orgId = null, issueKey, commentId, remoteKey }) {
  const organization = orgId || 'legacy';
  if (!/^(org-\d+|legacy)$/.test(organization)
      || !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(issueKey)
      || !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(remoteKey)
      || !/^[A-Za-z0-9_-]{1,100}$/.test(String(commentId))) {
    throw new Error('Invalid comment submission scope');
  }
  return PREFIX + createHash('sha256').update(JSON.stringify([
    organization, 'local-to-remote', String(commentId), remoteKey
  ])).digest('hex');
}

/** Entity-safe key for the phase record belonging to one submission scope. */
export function commentSubmissionOperationKey(scope) {
  return operationKey(commentSubmissionKey(scope));
}

function operationKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

function attention(reason, persisted = true) {
  return Object.assign(new Error('Comment submission requires reconciliation'), {
    code: 'COMMENT_RECONCILIATION_REQUIRED', reason, persisted
  });
}

function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id);
}

async function repairMapping(scope, destinationCommentId) {
  try {
    await storeCommentMapping(scope.commentId, destinationCommentId, scope.orgId === 'legacy' ? null : scope.orgId);
  } catch {
    throw attention('MAPPING_STORAGE_UNAVAILABLE');
  }
}

function operationToken() {
  return randomBytes(32).toString('hex');
}

/** Fixed-shape record: identifiers and bounded state only, never content. */
function operationRecord(scope, { state, token, reason, createdAt }) {
  return {
    orgId: scope.orgId || 'legacy', direction: 'local-to-remote',
    issueKey: scope.issueKey, commentId: String(scope.commentId), remoteKey: scope.remoteKey,
    state, token, reason, createdAt, updatedAt: Date.now()
  };
}

function claimRecord(record) {
  return { orgId: record.orgId, direction: record.direction, issueKey: record.issueKey,
    commentId: record.commentId, remoteKey: record.remoteKey, state: FENCED,
    reason: record.reason, createdAt: record.createdAt };
}

async function readOperation(key) {
  try {
    return await kvs.entity(OPERATION_ENTITY).get(key);
  } catch {
    throw attention('CLAIM_STORAGE_UNAVAILABLE', false);
  }
}

/**
 * Atomic conditional phase write. False means the predicate no longer matches,
 * so another invocation owns the operation.
 */
async function transition(key, value, conditions) {
  try {
    await kvs.transact().set(key, value, { entityName: OPERATION_ENTITY, conditions }).execute();
    return true;
  } catch (error) {
    if (isKeyConflictError(error)) return false;
    throw error;
  }
}

/**
 * Read the F02 submission boundary of this scope and return the plan that
 * releases it. A failure to read it keeps the phase fenced: an unreadable
 * boundary cannot be released, and publishing ARMED without the release is what
 * lets a concurrent delivery fence the comment permanently without submitting.
 */
async function planDeferredRelease(scope) {
  try {
    return await prepareDeferredSubmissionRelease({ direction: 'local-to-remote',
      orgId: scope.orgId || 'legacy', issueKey: scope.issueKey, commentId: scope.commentId });
  } catch {
    return { status: 'RELEASE_UNAVAILABLE', confirmed: false, stage() {} };
  }
}

/**
 * Publish the pre-submission phase of a fence this invocation owns together with
 * the optional release of F02's submission boundary. Only called after proving
 * the Jira transport was never reached, so no destination write can be
 * duplicated. The claim key itself is never removed.
 *
 * Both durable states are written by one transaction, so there is no ordering
 * window: an ARMED phase is never observable while `write_started` is still set.
 * The token-and-state predicate rejects the whole transaction when another
 * invocation owns the operation, so a stale invocation publishes nothing.
 */
async function rearm(key, record, release = null) {
  try {
    const transaction = kvs.transact().set(key, { ...record, state: ARMED, token: operationToken(),
      updatedAt: Date.now() },
    { entityName: OPERATION_ENTITY,
      conditions: new Filter().and('token', C.equalTo(record.token)).and('state', C.equalTo(FENCED)) });
    release?.stage(transaction);
    await transaction.execute();
    return 'ARMED';
  } catch (error) {
    return isKeyConflictError(error) ? 'OWNERSHIP_LOST' : 'UNAVAILABLE';
  }
}

/**
 * Reason reported for a fenced operation that produced no receipt. A young fence
 * may be a concurrent delivery that is still running, so it must not be reported
 * as an interrupted submission: that reason escalates the operation to manual
 * attention while the fence owner is still able to finish. An old fence cannot be
 * attributed to a live delivery and keeps the conservative reason.
 */
async function fencedReason(key, fallback, now = Date.now()) {
  let claim;
  try { claim = await storage.get(key); } catch { return fallback; }
  const createdAt = Number(claim?.createdAt);
  return Number.isFinite(createdAt) && createdAt > 0 && now - createdAt < IN_PROGRESS_MS
    ? 'SUBMISSION_IN_PROGRESS' : fallback;
}

/**
 * A fenced operation may only repair a recorded destination identity. It never
 * authorizes another POST, regardless of the recorded reason.
 */
async function resumeOrAttention(scope, resultKey, fallback = 'INTERRUPTED_SUBMISSION') {
  let result;
  try { result = await storage.get(resultKey); } catch { throw attention('RESULT_STORAGE_UNAVAILABLE'); }
  if (result?.state === 'destination_confirmed' && validId(result.destinationCommentId)) {
    // Repair both mapping directions after partial/failed mapping storage.
    // This path cannot submit Jira content, even if mapping persistence fails.
    await repairMapping(scope, result.destinationCommentId);
    return { destinationCommentId: result.destinationCommentId, repaired: true };
  }
  throw attention(result?.reason || fallback);
}

/**
 * Durable fence with a recoverable pre-submission phase. The claim key stays
 * permanent and is never deleted. Only the invocation that holds the fenced
 * phase and has proved that no request reached the Jira transport may return the
 * phase to ARMED, so a later authorized delivery submits exactly once instead of
 * losing the operation forever. Anything that may have reached Jira stays FENCED.
 */
export async function submitOutboundComment(scope, submit) {
  const key = commentSubmissionKey(scope);
  const resultKey = key.replace(PREFIX, RESULT_PREFIX);
  const entityKey = operationKey(key);
  await assertJiraSubmissionAllowed(`/rest/api/3/issue/${scope.remoteKey}/comment`, { method: 'POST' });

  const operation = await readOperation(entityKey);
  if (operation?.state === FENCED) return resumeOrAttention(scope, resultKey, await fencedReason(key, operation.reason));
  if (operation && operation.state !== ARMED) return resumeOrAttention(scope, resultKey);

  let claim;
  try { claim = await storage.get(key); } catch { throw attention('CLAIM_STORAGE_UNAVAILABLE', false); }
  // A claim with no phase record cannot prove that submission never started.
  if (!operation && claim) return resumeOrAttention(scope, resultKey);

  const record = operationRecord(scope, { state: FENCED, token: operationToken(),
    reason: 'INTERRUPTED_SUBMISSION', createdAt: operation?.createdAt || Date.now() });
  // Only the owner of an armed phase (it proved no transport started) or of a
  // fresh operation may consume it. The token predicate makes concurrent fences
  // exclusive, so at most one invocation proceeds to the claim write.
  const conditions = operation
    ? new Filter().and('token', C.equalTo(operation.token)).and('state', C.equalTo(ARMED))
    : new Filter().and('token', C.notExists());
  let fenced;
  try {
    fenced = await transition(entityKey, record, conditions);
  } catch {
    // The transaction may have committed; the phase stays fenced in either case.
    throw attention('CLAIM_STORAGE_UNAVAILABLE');
  }
  if (!fenced) return resumeOrAttention(scope, resultKey, 'SUBMISSION_IN_PROGRESS');

  if (!claim) {
    try {
      await storage.createIfNotExists(key, claimRecord(record));
    } catch (error) {
      // A write may commit before its acknowledgement is lost. Only a claim that
      // is provably absent may be re-armed by this invocation; otherwise the
      // permanent claim stands and requires inspection.
      let durable = isKeyConflictError(error);
      if (!durable) { try { durable = Boolean(await storage.get(key)); } catch { durable = true; } }
      if (durable) throw attention('CLAIM_STORAGE_UNAVAILABLE');
      if (await rearm(entityKey, record) !== 'ARMED') throw attention('CLAIM_REARM_UNAVAILABLE');
      throw attention('CLAIM_STORAGE_UNAVAILABLE', false);
    }
  }

  let transportStarted = false;
  // The hook runs after the guards pass and immediately before the SDK request.
  // While it stays false, no submission attempt was made in this invocation.
  const send = (url, options) => fetch(url, options, () => { transportStarted = true; });

  let result;
  try {
    const response = await submit(send);
    if (!response?.ok) {
      // 4xx rejection is distinguished from uncertain transport/5xx outcomes.
      // Neither authorizes automatic replay of this operation.
      result = { state: response?.status >= 400 && response.status < 500 && response.status !== 429
        ? 'rejected' : 'ambiguous', reason: response?.status >= 400 && response.status < 500 && response.status !== 429
        ? 'DESTINATION_REJECTED' : 'AMBIGUOUS_HTTP_RESPONSE', httpStatus: response?.status || 0 };
    } else {
      let data;
      try { data = await response.json(); } catch { /* unknown success body */ }
      result = validId(data?.id)
        ? { state: 'destination_confirmed', destinationCommentId: data.id }
        : { state: 'ambiguous', reason: 'INVALID_SUCCESS_RESPONSE' };
    }
  } catch (error) {
    if (!transportStarted && PRE_SUBMISSION_CODES.has(error?.code)) {
      // Pause or lease loss after the claim was fenced but before the transport
      // was reached. The phase and F02's submission boundary return to their
      // retryable state in ONE transaction, so the ARMED phase a later delivery
      // may consume is published together with the release of `write_started`.
      // Re-arming first would publish a phase that carries another epoch's
      // marker: a concurrent delivery that consumed it could only fence the
      // comment permanently without submitting anything.
      //
      // A boundary that must not be released (a manual attention record exists)
      // or cannot be read keeps the phase fenced and requires reconciliation;
      // the comment is never silently lost because F02 keeps its marker.
      const release = await planDeferredRelease(scope);
      if (!release.confirmed) throw attention('MARKER_RELEASE_UNAVAILABLE');
      const outcome = await rearm(entityKey, record, release);
      // A rejected predicate means another invocation owns the operation. The
      // transaction rolled back, so this invocation released nothing.
      if (outcome === 'OWNERSHIP_LOST') throw attention('SUBMISSION_IN_PROGRESS');
      if (outcome !== 'ARMED') throw attention('CLAIM_REARM_UNAVAILABLE');
      throw error;
    }
    const definitive = ['PILOT_PAUSED', 'PAUSE_STATE_UNAVAILABLE', 'LEASE_NOT_OWNED',
      'LEASE_OWNERSHIP_UNAVAILABLE', 'LEASE_MIGRATION_REQUIRED', 'COMMENT_VERIFICATION_DEFERRED',
      'COMMENT_RECONCILIATION_REQUIRED'].includes(error?.code);
    result = { state: definitive ? 'not_submitted' : 'ambiguous',
      reason: definitive ? 'PRE_SUBMISSION_GUARD_BLOCKED' : 'AMBIGUOUS_TRANSPORT' };
  }
  // If this save fails, the permanent claim still prevents automatic replay.
  try {
    await storage.createIfNotExists(resultKey, { ...result, recordedAt: Date.now() });
  } catch {
    throw attention('RECEIPT_STORAGE_UNAVAILABLE');
  }
  if (result.state !== 'destination_confirmed') throw attention(result.reason);
  // Save the destination identity BEFORE any fallible mapping writes.
  await repairMapping(scope, result.destinationCommentId);
  return { destinationCommentId: result.destinationCommentId, repaired: false };
}

function inspected(key, claim, result, now, phase) {
  return { key, ...claim, ...(phase ? { state: phase } : {}), result: result || null,
    reason: result?.reason || (result?.state === 'destination_confirmed' ? 'MAPPING_REPAIR_AVAILABLE'
      : phase === ARMED ? 'PRE_SUBMISSION_ARMED'
      : now - claim.createdAt < IN_PROGRESS_MS ? 'SUBMISSION_IN_PROGRESS' : 'INTERRUPTED_SUBMISSION') };
}

function phaseView(operation) {
  const { token, ...view } = operation; // the fencing token is an internal detail
  return view;
}

/** Exact-scope read for administrator review. Never authorizes another POST. */
export async function inspectCommentSubmission(scope, now = Date.now()) {
  const key = commentSubmissionKey(scope);
  const operation = await kvs.entity(OPERATION_ENTITY).get(operationKey(key));
  const claim = await storage.get(key);
  const result = await storage.get(key.replace(PREFIX, RESULT_PREFIX));
  // A re-armed phase keeps its claim, so the phase decides whether a later
  // authorized delivery may still submit; a claim with no phase record is fenced.
  if (!claim && !operation) return null;
  if (!claim) return inspected(null, phaseView(operation), result, now, operation.state);
  return inspected(key, claim, result, now, operation?.state || FENCED);
}

/** Bounded, paginated read-only inventory; no scans of comment bodies. */
export async function inspectCommentSubmissions({ limit = 25, cursor = null, now = Date.now() } = {}) {
  const query = storage.kvs.query().where('key', storage.WhereConditions.beginsWith(PREFIX))
    .limit(Math.min(100, Math.max(1, Math.floor(limit) || 25)));
  if (cursor) query.cursor(cursor);
  const { results, nextCursor } = await query.getMany();
  const operations = [];
  for (const { key, value } of results) {
    const result = await storage.get(key.replace(PREFIX, RESULT_PREFIX));
    operations.push(inspected(key, value, result, now));
  }
  return { operations, nextCursor: nextCursor || null };
}
