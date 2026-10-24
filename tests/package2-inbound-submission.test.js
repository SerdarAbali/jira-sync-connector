import { state as runtime } from './helpers/forge-lease-runtime';
import { claimInboundCommentSubmission, readInboundCommentReceipt, recordInboundCommentReceipt } from '../src/services/sync/inbound-comment-submission.js';

const scope = { orgId: 'org-1', remoteIssueKey: 'REMOTE-1', localKey: 'LOCAL-1', commentId: '101' };
let store, requests, fail;
beforeEach(() => {
  store = new Map(); requests = []; fail = null; runtime.basicStore = store;
  const boundary = global.__forge_fetch__;
  global.__forge_fetch__ = async (target, path, options) => {
    const body = JSON.parse(options.body); requests.push({ path, body });
    const reply = (status, data) => ({ ok: status < 400, status, headers: { get: () => null },
      text: async () => data === undefined ? '' : JSON.stringify(data) });
    if (path === '/api/v1/set') {
      if (fail === 'before') throw new Error('storage unavailable');
      if (body.options?.keyPolicy === 'FAIL_IF_EXISTS' && store.has(body.key)) {
        return reply(409, { code: 'KEY_ALREADY_EXISTS', message: 'Key exists' });
      }
      store.set(body.key, body.value);
      if (fail === 'acknowledgement') throw new Error('acknowledgement lost');
      return reply(204);
    }
    if (path === '/api/v1/get') {
      return store.has(body.key) ? reply(200, { key: body.key, value: store.get(body.key) })
        : reply(404, { code: 'KEY_NOT_FOUND', message: 'Missing' });
    }
    return boundary(target, path, options);
  };
});

test('real storage wrapper and SDK serialize a permanent FAIL_IF_EXISTS fence', async () => {
  await claimInboundCommentSubmission(scope);
  const request = requests.find(row => row.path === '/api/v1/set');
  expect(request.body.options.keyPolicy).toBe('FAIL_IF_EXISTS');
  expect(request.body.options.ttl).toBeUndefined();
  expect(request.body.value.state).toBe('submission_may_have_started');
  await expect(claimInboundCommentSubmission(scope)).rejects.toMatchObject({ code: 'COMMENT_RECONCILIATION_REQUIRED' });
});

test('concurrent SDK claims admit one owner only', async () => {
  const results = await Promise.allSettled([claimInboundCommentSubmission(scope), claimInboundCommentSubmission(scope)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(store.size).toBe(1);
});

test.each(['before', 'acknowledgement'])('%s storage failure never grants submission permission', async failure => {
  fail = failure;
  await expect(claimInboundCommentSubmission(scope)).rejects.toMatchObject({ code: 'COMMENT_RECONCILIATION_REQUIRED' });
  if (failure === 'acknowledgement') {
    fail = null;
    await expect(readInboundCommentReceipt(scope)).rejects.toMatchObject({ reason: 'SUBMISSION_OUTCOME_UNCONFIRMED' });
    await expect(claimInboundCommentSubmission(scope)).rejects.toMatchObject({ code: 'COMMENT_RECONCILIATION_REQUIRED' });
  }
});

test('positive receipt survives failed subsequent bookkeeping and contains identifiers only', async () => {
  await claimInboundCommentSubmission(scope);
  await recordInboundCommentReceipt(scope, '201');
  await expect(readInboundCommentReceipt(scope)).resolves.toMatchObject({ destinationCommentId: '201', state: 'destination_confirmed' });
  expect(Object.keys(store.values().next().value).sort()).toEqual([
    'createdAt', 'localKey', 'orgId', 'remoteCommentId', 'remoteIssueKey', 'state'
  ]);
});

test('receipt storage failure leaves the permanent fence effective', async () => {
  await claimInboundCommentSubmission(scope); fail = 'before';
  await expect(recordInboundCommentReceipt(scope, '201')).rejects.toMatchObject({ reason: 'RECEIPT_STORAGE_UNAVAILABLE' });
  fail = null;
  await expect(readInboundCommentReceipt(scope)).rejects.toMatchObject({ reason: 'SUBMISSION_OUTCOME_UNCONFIRMED' });
});

test('destination remapping cannot rearm a claimed source identity', async () => {
  await claimInboundCommentSubmission(scope); await recordInboundCommentReceipt(scope, '201');
  await expect(readInboundCommentReceipt({ ...scope, localKey: 'LOCAL-2' })).rejects.toMatchObject({ code: 'COMMENT_RECONCILIATION_REQUIRED' });
  await expect(claimInboundCommentSubmission({ ...scope, localKey: 'LOCAL-2' })).rejects.toMatchObject({ code: 'COMMENT_RECONCILIATION_REQUIRED' });
});

test('different organizations and different source comments remain isolated', async () => {
  await claimInboundCommentSubmission(scope);
  await claimInboundCommentSubmission({ ...scope, orgId: 'org-2' });
  await claimInboundCommentSubmission({ ...scope, commentId: '102' });
  expect(store.size).toBe(3);
});

test('renaming or moving a source issue cannot bypass its uncertain comment fence', async () => {
  await claimInboundCommentSubmission(scope);
  const moved = { ...scope, remoteIssueKey: 'MOVED-2' };
  await expect(readInboundCommentReceipt(moved)).rejects.toMatchObject({ reason: 'SUBMISSION_OUTCOME_UNCONFIRMED' });
  await expect(claimInboundCommentSubmission(moved)).rejects.toMatchObject({ code: 'COMMENT_RECONCILIATION_REQUIRED' });
  expect(store.size).toBe(1);
});

test('malformed existing receipt fails closed even when no claim is readable', async () => {
  await claimInboundCommentSubmission(scope);
  const key = requests.find(row => row.path === '/api/v1/set').body.key;
  store.clear(); store.set(key.replace('inbound-comment-submission:', 'inbound-comment-result:'), false);
  await expect(readInboundCommentReceipt(scope)).rejects.toMatchObject({ code: 'COMMENT_RECONCILIATION_REQUIRED' });
});
