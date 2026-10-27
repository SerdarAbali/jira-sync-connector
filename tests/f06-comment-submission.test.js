// The synchronization authorization gate has its own suite; this suite tests another behaviour.
jest.mock('../src/services/sync/sync-authorization.js', () => require('./helpers/authorized-sync-authorization.js'));

/** Production comment paths + real Forge KVS wrapper/SDK; only HTTP edges modelled. */
const mockFetch = jest.fn();
const mockRequest = jest.fn();
jest.mock('@forge/api', () => ({
  __esModule: true, default: { asApp: () => ({ requestJira: mockRequest }) },
  route: (s, ...v) => s.reduce((a, p, i) => a + p + (v[i] ?? ''), ''),
  fetch: (...args) => mockFetch(...args)
}));
jest.mock('../src/services/storage/mappings.js', () => ({
  getRemoteKey: jest.fn(async () => 'REMOTE-1'),
  getRemoteCommentId: jest.fn(async () => null),
  getOrganizationsWithTokens: jest.fn(), storeCommentMapping: jest.fn()
}));
jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn(), getFullComment: jest.fn(), getOrgName: jest.fn(async () => 'Local')
}));
jest.mock('../src/services/storage/stats.js', () => ({ trackWebhookSync: jest.fn(), trackApiCall: jest.fn() }));
jest.mock('../src/services/storage/flags.js', () => ({ isSyncing: jest.fn(async () => false) }));

import { syncComment, syncAllComments } from '../src/services/sync/comment-sync.js';
import { getFullIssue, getFullComment } from '../src/services/jira/local-client.js';
import { getOrganizationsWithTokens, getRemoteCommentId, storeCommentMapping } from '../src/services/storage/mappings.js';
import { deferCommentVerification, recoverCommentVerifications } from '../src/services/sync/comment-verification-recovery.js';
import { runWithIssueLease } from '../src/services/sync/issue-lease-context.js';
import { acquireIssueLease } from '../src/services/sync/issue-lease.js';
import * as storage from '../src/services/storage/kvs.js';

const org = { id: 'org-1', remoteUrl: 'https://remote.atlassian.net', remoteEmail: 'x@example.invalid',
  remoteApiToken: 'test-only', allowedProjects: ['LOCAL'] };
const issue = { key: 'LOCAL-1', fields: { project: { key: 'LOCAL' } } };
const comment = id => ({ id, body: 'PRIVATE_TEST_BODY', jsdPublic: true, properties: [], author: { displayName: 'Test' } });
const event = (id = '101') => ({ issue, comment: { id } });
const ok = data => ({ ok: true, status: 201, json: async () => data });
const posts = () => mockFetch.mock.calls.filter(([, o]) => o?.method === 'POST');
let store, requests, spies, failure, getFailure, transactionFailure, afterRearm;
beforeEach(() => {
  store = new Map([['organizations', [org, { ...org, id: 'org-2' }]]]); requests = []; failure = null; getFailure = null; transactionFailure = null;
  afterRearm = null;
  // Key-Value Store transactions share this test's basic store model.
  require('./helpers/forge-lease-runtime').state.basicStore = store;
  const leaseTransport = global.__forge_fetch__;
  global.__forge_fetch__ = async (target, path, options) => {
    const body = JSON.parse(options.body); requests.push({ path, body });
    const reply = (status, data) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => data === undefined ? '' : JSON.stringify(data) });
    if (path === '/api/v1/set') {
      if (failure?.(body)) throw new Error('storage unavailable');
      if (body.options?.keyPolicy === 'FAIL_IF_EXISTS' && store.has(body.key)) {
        return reply(409, { code: 'KEY_ALREADY_EXISTS', message: 'Key already exists' });
      }
      store.set(body.key, body.value); return reply(204);
    }
    if (path === '/api/v1/get' && !['issueLeaseMigration:v1'].includes(body.key)) {
      if (getFailure?.(body)) throw new Error('storage unavailable');
      return store.has(body.key) ? reply(200, { key: body.key, value: store.get(body.key) })
        : reply(404, { code: 'KEY_NOT_FOUND', message: 'Missing' });
    }
    if (path === '/api/v1/delete') { store.delete(body.key); return reply(204); }
    if (path === '/api/v1/transaction') {
      // Only Key-Value Store transactions can be failed selectively: entity
      // transactions also carry F07 lease checks.
      if (transactionFailure?.(body)) throw new Error('storage unavailable');
      const committed = await leaseTransport(target, path, options);
      // The pre-submission phase becomes visible here. A regression test may
      // resume a concurrent delivery at exactly this instant.
      if (afterRearm && (body.set || []).some(operation =>
        operation.entityName === 'comment-submission' && operation.value?.state === 'pre_submission')) {
        const hook = afterRearm; afterRearm = null; await hook();
      }
      return committed;
    }
    if (path === '/api/v1/query') {
      const prefix = body.where?.[0]?.values?.[0] ?? '';
      const all = [...store].filter(([key]) => key.startsWith(prefix));
      const start = Number(body.after || 0);
      return reply(200, { data: all.slice(start, start + body.limit).map(([key, value]) => ({ key, value })),
        cursor: start + body.limit < all.length ? String(start + body.limit) : undefined });
    }
    return leaseTransport(target, path, options);
  };
  jest.clearAllMocks();
  getOrganizationsWithTokens.mockResolvedValue([org]); getRemoteCommentId.mockResolvedValue(null);
  getFullIssue.mockResolvedValue(issue); getFullComment.mockImplementation(async (_, id) => comment(id));
  storeCommentMapping.mockReset().mockResolvedValue();
  mockFetch.mockReset().mockImplementation(async (_, o) => ok(o?.method === 'POST' ? { id: '202' } : { comments: [] }));
  mockRequest.mockReset().mockResolvedValue(ok({ comments: [comment('101')] }));
  spies = ['log', 'warn', 'error'].map(m => jest.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => spies.forEach(s => s.mockRestore()));

test('mapped comments are never updated or deleted after a source edit', async () => {
  getRemoteCommentId.mockResolvedValue('202');
  await syncComment(event());
  getFullComment.mockResolvedValue({ ...comment('101'), body: 'Edited source body' });
  await syncComment(event());
  expect(mockFetch.mock.calls.filter(([, options]) => ['PUT', 'DELETE'].includes(options?.method)))
    .toHaveLength(0);
});

test('comment catch-up respects the Sync Comments setting', async () => {
  store.set('syncOptions:org-1', { syncComments: false });
  await syncAllComments('LOCAL-1', 'REMOTE-1', issue, org, null, 'org-1');
  expect(posts()).toHaveLength(0);
});

test('outbound comments use display-name attribution, preserve formatting and verified reply context', async () => {
  const source = {
    id: '101',
    body: {
      type: 'doc',
      version: 1,
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Bold ', marks: [{ type: 'strong' }] },
          { type: 'text', text: 'body', marks: [{ type: 'em' }] }
        ]
      }]
    },
    jsdPublic: true,
    parentId: '100',
    properties: [],
    author: { displayName: 'Ada Lovelace', emailAddress: 'ada@example.invalid' }
  };
  const parent = {
    id: '100',
    body: 'Earlier decision',
    jsdPublic: true,
    properties: [],
    author: { displayName: 'Grace Hopper', emailAddress: 'grace@example.invalid' }
  };
  getFullComment.mockImplementation(async (_, id) => id === '100' ? parent : source);
  await syncComment(event());

  const payload = JSON.parse(posts()[0][1].body);
  expect(payload.body.content[0].content[0].text).toBe('[Comment from Local - User: Ada Lovelace]:');
  expect(payload.body.content[1].content[0].text).toBe('Replying to Grace Hopper: "Earlier decision"');
  expect(payload.body.content[3].content[0].marks).toEqual([{ type: 'strong' }]);
  expect(JSON.stringify(payload)).not.toContain('ada@example.invalid');
  expect(JSON.stringify(payload)).not.toContain('grace@example.invalid');
});

test('outbound missing or deleted authors fall back without leaking email', async () => {
  const source = {
    id: '101', body: 'Customer text', jsdPublic: true, properties: [],
    author: { emailAddress: 'private@example.invalid' }
  };
  getFullComment.mockImplementation(async (_, id) => id === '101' ? source : null);
  await syncComment(event());

  const payload = JSON.parse(posts()[0][1].body);
  expect(payload.body.content[0].content[0].text).toBe('[Comment from Local - User: Unknown User]:');
  expect(JSON.stringify(payload)).not.toContain('private@example.invalid');
});

test('concurrent realtime deliveries create once', async () => {
  await Promise.all([syncComment(event()), syncComment(event())]);
  expect(posts()).toHaveLength(1);
});
test('realtime racing catch-up creates once', async () => {
  await Promise.all([syncComment(event()), syncAllComments('LOCAL-1', 'REMOTE-1', issue, org, null, 'org-1')]);
  expect(posts()).toHaveLength(1);
});
test.each(['timeout', 'missing', 'malformed', 'invalid', 'mapping'])('%s after accepted POST never reposts on redelivery', async mode => {
  mockFetch.mockImplementation(async () => {
    if (mode === 'timeout') throw new Error('timeout after acceptance');
    if (mode === 'malformed') return { ok: true, status: 201, json: async () => { throw new Error('bad json'); } };
    return ok(mode === 'missing' ? {} : { id: mode === 'invalid' ? { id: '202' } : '202' });
  });
  if (mode === 'mapping') storeCommentMapping.mockRejectedValueOnce(new Error('mapping unavailable'));
  const first = await syncComment(event()); await syncComment(event());
  expect(first.status).toBe('COMMENT_RECONCILIATION_REQUIRED');
  expect(posts()).toHaveLength(1);
  if (mode === 'mapping') expect(storeCommentMapping).toHaveBeenLastCalledWith('101', '202', 'org-1');
});
test('F02 recovery races ordinary processing through the same claim', async () => {
  await deferCommentVerification({ direction: 'local-to-remote', orgId: 'org-1', issueKey: 'LOCAL-1', commentId: '101' }, {});
  for (const [key, value] of store) if (key.startsWith('comment-verification')) store.set(key, { ...value, notBefore: 0 });
  await Promise.all([recoverCommentVerifications(() => syncComment(event(), 'org-1')), syncComment(event())]);
  expect(posts()).toHaveLength(1);
});
test('mapped updates preserve existing skip behavior', async () => {
  getRemoteCommentId.mockResolvedValue('202'); await syncComment(event()); expect(posts()).toHaveLength(0);
});
test('distinct comments and organizations remain independent', async () => {
  getOrganizationsWithTokens.mockResolvedValue([org, { ...org, id: 'org-2' }]);
  await Promise.all([syncComment(event('101')), syncComment(event('102'))]); expect(posts()).toHaveLength(4);
});
test('Pause and expired F07 owner prevent submission', async () => {
  store.set('pilotPause', { paused: true }); await syncComment(event()); expect(posts()).toHaveLength(0);
  store.delete('pilotPause');
  const lease = await acquireIssueLease({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' });
  lease.metadata.expiresAt = 0;
  await runWithIssueLease(lease, () => syncComment(event())); expect(posts()).toHaveLength(0);
});
test('restricted ancestor blocks realtime and catch-up', async () => {
  getFullComment.mockImplementation(async (_, id) => id === '100'
    ? { ...comment(id), visibility: { type: 'group', value: 'private' } } : { ...comment(id), parentId: '100' });
  await syncComment(event()); await syncAllComments('LOCAL-1', 'REMOTE-1', issue, org, null, 'org-1');
  expect(posts()).toHaveLength(0);
});
test('claims use permanent conditional SDK writes and contain no content or credentials', async () => {
  await syncComment(event());
  expect(requests.some(r => r.path === '/api/v1/set' && r.body.options?.keyPolicy === 'FAIL_IF_EXISTS' && !r.body.options.ttl)).toBe(true);
  const operations = [...store].filter(([key]) => key.startsWith('comment-submission:'));
  expect(operations.length).toBeGreaterThan(0);
  expect(JSON.stringify(operations)).not.toMatch(/PRIVATE_TEST_BODY|test-only|example.invalid/);
});

test('failure before the claim is safe to resume', async () => {
  failure = body => body.key.startsWith('comment-submission:');
  await syncComment(event()); expect(posts()).toHaveLength(0);
  expect([...store.keys()].some(key => key.startsWith('comment-submission:'))).toBe(false);
  failure = null; await syncComment(event()); expect(posts()).toHaveLength(1);
});
test('claim committed but acknowledgement lost blocks all later automatic submission', async () => {
  failure = body => {
    if (!body.key.startsWith('comment-submission:')) return false;
    store.set(body.key, body.value); return true;
  };
  await syncComment(event()); failure = null;
  await syncComment(event()); expect(posts()).toHaveLength(0);
});
test('crash after durable claim survives arbitrarily delayed redelivery', async () => {
  // The actual SDK accepts a fence write; the process disappears before submit.
  const { commentSubmissionKey } = jest.requireActual('../src/services/sync/comment-submission.js');
  const key = commentSubmissionKey({ orgId: 'org-1', issueKey: 'LOCAL-1', commentId: '101', remoteKey: 'REMOTE-1' });
  await storage.createIfNotExists(key, { state: 'submission_may_have_started', createdAt: 1 });
  await syncComment(event());
  await syncAllComments('LOCAL-1', 'REMOTE-1', issue, org, null, 'org-1');
  expect(posts()).toHaveLength(0);
  expect(store.has(key)).toBe(true);
});
test('destination accepted but receipt persistence fails: claim alone prevents repost', async () => {
  failure = body => body.key.startsWith('comment-submission-result:');
  await syncComment(event()); failure = null;
  const replay = await syncComment(event());
  expect(posts()).toHaveLength(1);
  expect(replay.status).toBe('COMMENT_RECONCILIATION_REQUIRED');
});
test('partial real mapping writes repair both directions without another create', async () => {
  const actual = jest.requireActual('../src/services/storage/mappings.js');
  storeCommentMapping.mockImplementation(actual.storeCommentMapping);
  failure = body => body.key.includes('comment-local-to-remote:');
  await syncComment(event()); failure = null; await syncComment(event());
  expect(posts()).toHaveLength(1);
  expect(await storage.get('org-1:comment-local-to-remote:101')).toBe('202');
  expect(await storage.get('org-1:comment-remote-to-local:202')).toBe('101');
});
test.each([400, 403, 429, 500, 503])('HTTP %i is fenced and reason coded', async status => {
  mockFetch.mockResolvedValue({ ok: false, status, headers: { get: () => '60' } });
  await syncComment(event()); await syncComment(event()); expect(posts()).toHaveLength(1);
  const result = [...store].find(([key]) => key.startsWith('comment-submission-result:'))[1];
  expect(result.state).toBe(status < 429 ? 'rejected' : 'ambiguous');
});
test('lease loss after the claim is fenced but before submission delivers once, later', async () => {
  const lease = await acquireIssueLease({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' });
  failure = body => {
    if (body.key.startsWith('comment-submission:')) lease.metadata.expiresAt = 0;
    return false;
  };
  await runWithIssueLease(lease, () => syncComment(event()));
  // The claim was acquired and the lease was lost before the transport ran.
  expect(posts()).toHaveLength(0);
  expect([...store.keys()].some(key => key.startsWith('comment-submission:'))).toBe(true);
  failure = null;
  // Authorization restored: the claim is not consumed, and exactly one POST follows.
  await syncComment(event()); expect(posts()).toHaveLength(1);
  await syncComment(event()); expect(posts()).toHaveLength(1);
  const result = [...store].find(([key]) => key.startsWith('comment-submission-result:'))[1];
  expect(result).toMatchObject({ state: 'destination_confirmed', destinationCommentId: '202' });
});
test('F07 migration remains blocked with no activation record', async () => {
  require('./helpers/forge-lease-runtime').state.migration = null;
  await syncComment(event()); expect(posts()).toHaveLength(0);
  expect([...store.keys()].some(key => key.startsWith('comment-submission:'))).toBe(false);
});
test('claim storage unavailability fails closed without optimistic fallback', async () => {
  failure = () => true; await syncComment(event()); expect(posts()).toHaveLength(0);
});
test('text similarity cannot block a distinct catch-up source identity', async () => {
  mockFetch.mockResolvedValue(ok({ comments: [{ id: '999', body: { type: 'doc', content: [{ type: 'paragraph',
    content: [{ type: 'text', text: '[Comment from Local - User: Test]\n\nPRIVATE_TEST_BODY' }] }] } }] }));
  await syncAllComments('LOCAL-1', 'REMOTE-1', issue, org, null, 'org-1');
  expect(posts()).toHaveLength(1);
});
test('catch-up redelivery after missing success identity cannot repost', async () => {
  mockFetch.mockResolvedValue(ok({}));
  await syncAllComments('LOCAL-1', 'REMOTE-1', issue, org, null, 'org-1');
  await syncAllComments('LOCAL-1', 'REMOTE-1', issue, org, null, 'org-1');
  expect(posts()).toHaveLength(1);
});
test('attention inspection is bounded and never submits or modifies records', async () => {
  const { inspectCommentSubmissions } = jest.requireActual('../src/services/sync/comment-submission.js');
  mockFetch.mockResolvedValue(ok({})); await syncComment(event());
  const before = JSON.stringify([...store]);
  const { operations: rows } = await inspectCommentSubmissions({ limit: 1 });
  expect(rows).toHaveLength(1); expect(rows[0].reason).toBe('INVALID_SUCCESS_RESPONSE');
  expect(JSON.stringify([...store])).toBe(before); expect(posts()).toHaveLength(1);
});

test('attention inventory paginates beyond completed operations without unbounded reads', async () => {
  const { inspectCommentSubmissions, inspectCommentSubmission } = jest.requireActual('../src/services/sync/comment-submission.js');
  await syncComment(event('101')); await syncComment(event('102')); await syncComment(event('103'));
  let cursor = null; const keys = [];
  do {
    const page = await inspectCommentSubmissions({ limit: 1, cursor });
    expect(page.operations).toHaveLength(1); keys.push(page.operations[0].key); cursor = page.nextCursor;
  } while (cursor);
  expect(new Set(keys).size).toBe(3);
  const exact = await inspectCommentSubmission({ orgId: 'org-1', issueKey: 'LOCAL-1', commentId: '103', remoteKey: 'REMOTE-1' });
  expect(exact.result.destinationCommentId).toBe('202'); expect(posts()).toHaveLength(3);
});

test('Pause activated after the claim is fenced but before submission delivers once, later', async () => {
  failure = body => {
    if (body.key.startsWith('comment-submission:')) store.set('pilotPause', { paused: true });
    return false;
  };
  await syncComment(event()); expect(posts()).toHaveLength(0);
  store.delete('pilotPause'); failure = null;
  await syncComment(event()); expect(posts()).toHaveLength(1);
  await syncComment(event()); expect(posts()).toHaveLength(1);
});
test('a replaced F07 owner does not submit, and a later authorized delivery delivers once', async () => {
  const lease = await acquireIssueLease({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' });
  failure = body => {
    if (body.key.startsWith('comment-submission:')) {
      require('./helpers/forge-lease-runtime').entities.set(lease.key, {
        leaseToken: 'successor', expiresAt: Date.now() + 120000
      });
    }
    return false;
  };
  await runWithIssueLease(lease, () => syncComment(event())); failure = null;
  expect(posts()).toHaveLength(0);
  await syncComment(event()); expect(posts()).toHaveLength(1);
  await syncComment(event()); expect(posts()).toHaveLength(1);
});

test('a phase is never re-armed once the transport may have received the request', async () => {
  const { entities } = require('./helpers/forge-lease-runtime');
  const { commentSubmissionOperationKey } = jest.requireActual('../src/services/sync/comment-submission.js');
  const key = commentSubmissionOperationKey({ orgId: 'org-1', issueKey: 'LOCAL-1', commentId: '101', remoteKey: 'REMOTE-1' });
  mockFetch.mockImplementation(async () => { throw new Error('socket hang up'); });
  await syncComment(event());
  expect(posts()).toHaveLength(1);
  expect(entities.get(key).state).toBe('submission_may_have_started');
  // A later delivery must not treat an ambiguous submission as re-armable.
  mockFetch.mockImplementation(async (_, o) => ok(o?.method === 'POST' ? { id: '202' } : { comments: [] }));
  await syncComment(event());
  expect(posts()).toHaveLength(1);
  expect(entities.get(key).state).toBe('submission_may_have_started');
});

test('a fenced phase blocks redelivery even if the claim record were lost', async () => {
  const { entities } = require('./helpers/forge-lease-runtime');
  const { commentSubmissionKey, commentSubmissionOperationKey } =
    jest.requireActual('../src/services/sync/comment-submission.js');
  const scope = { orgId: 'org-1', issueKey: 'LOCAL-1', commentId: '101', remoteKey: 'REMOTE-1' };
  mockFetch.mockImplementation(async () => { throw new Error('timeout after acceptance'); });
  await syncComment(event());
  expect(entities.get(commentSubmissionOperationKey(scope)).state).toBe('submission_may_have_started');
  store.delete(commentSubmissionKey(scope));
  mockFetch.mockImplementation(async (_, o) => ok(o?.method === 'POST' ? { id: '202' } : { comments: [] }));
  await syncComment(event());
  expect(posts()).toHaveLength(1);
});

test('a re-armed phase with an existing claim delivers once instead of stranding', async () => {
  const { entities } = require('./helpers/forge-lease-runtime');
  const { commentSubmissionKey, commentSubmissionOperationKey } =
    jest.requireActual('../src/services/sync/comment-submission.js');
  const scope = { orgId: 'org-1', issueKey: 'LOCAL-1', commentId: '101', remoteKey: 'REMOTE-1' };
  await storage.createIfNotExists(commentSubmissionKey(scope), {
    orgId: 'org-1', state: 'submission_may_have_started', reason: 'INTERRUPTED_SUBMISSION', createdAt: 1
  });
  entities.set(commentSubmissionOperationKey(scope), { orgId: 'org-1', direction: 'local-to-remote',
    issueKey: 'LOCAL-1', commentId: '101', remoteKey: 'REMOTE-1', state: 'pre_submission',
    token: 'previous', reason: 'INTERRUPTED_SUBMISSION', createdAt: 1, updatedAt: 1 });
  await syncComment(event()); expect(posts()).toHaveLength(1);
  await syncComment(event()); expect(posts()).toHaveLength(1);
  expect(entities.get(commentSubmissionOperationKey(scope)).state).toBe('submission_may_have_started');
});

// Seed a permanent claim plus a phase record so a delivery finds an operation
// that already may have started, without needing a real race to create it.
async function seedFencedOperation(createdAt) {
  const { entities } = require('./helpers/forge-lease-runtime');
  const { commentSubmissionKey, commentSubmissionOperationKey } =
    jest.requireActual('../src/services/sync/comment-submission.js');
  const scope = { orgId: 'org-1', issueKey: 'LOCAL-1', commentId: '101', remoteKey: 'REMOTE-1' };
  await storage.createIfNotExists(commentSubmissionKey(scope), {
    orgId: 'org-1', state: 'submission_may_have_started', reason: 'INTERRUPTED_SUBMISSION', createdAt
  });
  entities.set(commentSubmissionOperationKey(scope), { orgId: 'org-1', direction: 'local-to-remote',
    issueKey: 'LOCAL-1', commentId: '101', remoteKey: 'REMOTE-1', state: 'submission_may_have_started',
    token: 'owner', reason: 'INTERRUPTED_SUBMISSION', createdAt, updatedAt: createdAt });
}

async function dueF02Record() {
  await deferCommentVerification({ direction: 'local-to-remote', orgId: 'org-1', issueKey: 'LOCAL-1', commentId: '101' }, {});
  for (const [key, value] of store) if (key.startsWith('comment-verification')) store.set(key, { ...value, notBefore: 0 });
}

test('a young fence is in progress, so recovery retries instead of escalating', async () => {
  await seedFencedOperation(Date.now());
  // A concurrent delivery that lost this fence only saw the owner's operation.
  expect(await syncComment(event(), 'org-1')).toMatchObject({ status: 'COMMENT_RECONCILIATION_REQUIRED',
    reason: 'SUBMISSION_IN_PROGRESS' });
  expect(posts()).toHaveLength(0);
  await dueF02Record();
  await recoverCommentVerifications(() => syncComment(event(), 'org-1'));
  // Escalating here would strand a comment whose fence owner can still finish.
  expect(store.has('comment-verification-attention:local-to-remote:org-1:LOCAL-1:101')).toBe(false);
  expect(store.get('comment-verification:local-to-remote:org-1:LOCAL-1:101'))
    .toMatchObject({ lastOutcome: 'SUBMISSION_IN_PROGRESS' });
  expect(posts()).toHaveLength(0);
});

test('an old fence still escalates to attention instead of waiting for a retry', async () => {
  await seedFencedOperation(1);
  expect(await syncComment(event(), 'org-1')).toMatchObject({ status: 'COMMENT_RECONCILIATION_REQUIRED',
    reason: 'INTERRUPTED_SUBMISSION' });
  expect(posts()).toHaveLength(0);
  await dueF02Record();
  await recoverCommentVerifications(() => syncComment(event(), 'org-1'));
  expect(store.has('comment-verification-attention:local-to-remote:org-1:LOCAL-1:101')).toBe(true);
  expect(posts()).toHaveLength(0);
});

test('an unacknowledged claim that did commit stays fenced instead of being re-armed', async () => {
  const { entities } = require('./helpers/forge-lease-runtime');
  const { commentSubmissionOperationKey } = jest.requireActual('../src/services/sync/comment-submission.js');
  failure = body => {
    if (!body.key.startsWith('comment-submission:')) return false;
    store.set(body.key, body.value); return true;
  };
  await syncComment(event()); failure = null;
  await syncComment(event()); expect(posts()).toHaveLength(0);
  const key = commentSubmissionOperationKey({ orgId: 'org-1', issueKey: 'LOCAL-1', commentId: '101', remoteKey: 'REMOTE-1' });
  expect(entities.get(key).state).toBe('submission_may_have_started');
});


// --- F02 deferred comment + provably unsent submission -----------------------
// `markDeferredCommentSubmission` writes `write_started` and a submission
// marker before the guarded transport runs. When a Pause or lease failure then
// blocks the request, the F06 phase is re-armed to `pre_submission` and that
// F02 state must be released, or recovery can never retry a comment that
// provably never left the installation.
const deferredKey = 'comment-verification:local-to-remote:org-1:LOCAL-1:101';
const markerKey = 'comment-verification-submission:local-to-remote:org-1:LOCAL-1:101';
const attentionKey = 'comment-verification-attention:local-to-remote:org-1:LOCAL-1:101';

// Pause becomes active only after the durable claim exists, so a deferred
// comment reaches the F06 fence before the guarded transport refuses the POST.
function pauseAfterClaim() {
  failure = body => {
    if (body.key.startsWith('comment-submission:')) store.set('pilotPause', { paused: true });
    return false;
  };
}

// The released record keeps its identity, throttle deadline, and attempt count.
function expectReleased() {
  expect(store.get(deferredKey).state).toBeUndefined();
  expect(store.get(deferredKey)).toMatchObject({ commentId: '101', attempts: expect.any(Number) });
  expect(store.has(markerKey)).toBe(false);
  expect(store.has(attentionKey)).toBe(false);
}

test('a Pause after the claim does not strand a deferred comment', async () => {
  await dueF02Record();
  pauseAfterClaim();
  await recoverCommentVerifications(() => syncComment(event(), 'org-1'));
  expect(posts()).toHaveLength(0);
  expectReleased();
  failure = null; store.delete('pilotPause');
  // Heartbeat recovery submits exactly once after authorization returns.
  await recoverCommentVerifications(() => syncComment(event(), 'org-1'));
  expect(posts()).toHaveLength(1);
  await recoverCommentVerifications(() => syncComment(event(), 'org-1'));
  await syncComment(event());
  expect(posts()).toHaveLength(1);
});

test('lease loss after the claim does not strand a deferred comment', async () => {
  await dueF02Record();
  const lease = await acquireIssueLease({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' });
  failure = body => {
    if (body.key.startsWith('comment-submission:')) lease.metadata.expiresAt = 0;
    return false;
  };
  await runWithIssueLease(lease, () => syncComment(event(), 'org-1'));
  failure = null;
  expect(posts()).toHaveLength(0);
  expectReleased();
  // Restored ownership no longer needs a lease context to deliver the comment.
  await recoverCommentVerifications(() => syncComment(event(), 'org-1'));
  expect(posts()).toHaveLength(1);
  await syncComment(event());
  expect(posts()).toHaveLength(1);
});

test('a replaced F07 owner releases the deferred marker without submitting', async () => {
  await dueF02Record();
  const lease = await acquireIssueLease({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' });
  failure = body => {
    if (body.key.startsWith('comment-submission:')) {
      require('./helpers/forge-lease-runtime').entities.set(lease.key, {
        leaseToken: 'successor', expiresAt: Date.now() + 120000
      });
    }
    return false;
  };
  await runWithIssueLease(lease, () => syncComment(event(), 'org-1'));
  failure = null;
  expect(posts()).toHaveLength(0);
  expectReleased();
  // The authorized successor delivery submits once; the stale worker never did.
  await recoverCommentVerifications(() => syncComment(event(), 'org-1'));
  expect(posts()).toHaveLength(1);
  await recoverCommentVerifications(() => syncComment(event(), 'org-1'));
  expect(posts()).toHaveLength(1);
});


test('a temporary Pause-state read failure does not strand a deferred comment', async () => {
  await dueF02Record();
  failure = body => {
    // Only the guard's Pause read fails; every other storage call succeeds.
    if (body.key.startsWith('comment-submission:')) getFailure = request => request.key === 'pilotPause';
    return false;
  };
  await recoverCommentVerifications(() => syncComment(event(), 'org-1'));
  failure = null; getFailure = null;
  expect(posts()).toHaveLength(0);
  expectReleased();
  await recoverCommentVerifications(() => syncComment(event(), 'org-1'));
  expect(posts()).toHaveLength(1);
  await recoverCommentVerifications(() => syncComment(event(), 'org-1'));
  expect(posts()).toHaveLength(1);
});

test('concurrent recovery and redelivery submit a released deferred comment once', async () => {
  await dueF02Record();
  pauseAfterClaim();
  await recoverCommentVerifications(() => syncComment(event(), 'org-1'));
  failure = null; store.delete('pilotPause');
  expectReleased();
  await Promise.all([
    recoverCommentVerifications(() => syncComment(event(), 'org-1')),
    syncComment(event()),
    syncComment(event())
  ]);
  expect(posts()).toHaveLength(1);
  await Promise.all([recoverCommentVerifications(() => syncComment(event(), 'org-1')), syncComment(event())]);
  expect(posts()).toHaveLength(1);
});

// --- The phase and the F02 boundary are one transition -----------------------
// An ARMED phase is consumable by any delivery, so publishing it while another
// epoch's `write_started`/marker is still set lets that delivery pass the claim
// and then fail `markDeferredCommentSubmission`, which fences the comment for
// good without a Jira POST. The regression tests below suspend a second delivery
// at the exact instant the re-armed phase becomes visible.
const scope101 = { orgId: 'org-1', issueKey: 'LOCAL-1', commentId: '101', remoteKey: 'REMOTE-1' };

async function waitFor(predicate, attempts = 500) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('condition never became true');
}

// A delivery that already passed its F02 readiness check, stalled before it
// reaches the F06 fence; it resumes when the pre-submission phase is published.
function stallFirstDelivery() {
  let calls = 0;
  const stale = getFullComment.getMockImplementation();
  let resume;
  const stalled = new Promise(resolve => { resume = resolve; });
  getFullComment.mockImplementation(async (...args) => {
    calls += 1;
    if (calls === 1) await stalled;
    return stale(...args);
  });
  return { started: () => waitFor(() => calls === 1), resume };
}

test('a concurrent delivery never observes an armed phase with an old marker', async () => {
  await dueF02Record();
  const { entities } = require('./helpers/forge-lease-runtime');
  const { commentSubmissionOperationKey } = jest.requireActual('../src/services/sync/comment-submission.js');
  const lease = await acquireIssueLease({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' });
  failure = body => {
    // A's F07 ownership is replaced after its claim exists, so the guard refuses
    // the POST and A has to return the phase to `pre_submission`.
    if (body.key.startsWith('comment-submission:')) {
      entities.set(lease.key, { leaseToken: 'successor', expiresAt: Date.now() + 120000 });
    }
    return false;
  };
  const stalled = stallFirstDelivery();
  const concurrent = syncComment(event());
  await stalled.started();
  // Resume B the instant the pre-submission phase is written: before the fix the
  // F02 boundary was released afterwards, so B saw a stale marker and fenced the
  // comment permanently without submitting.
  afterRearm = async () => { stalled.resume(); await concurrent; };
  await runWithIssueLease(lease, () => syncComment(event(), 'org-1'));
  failure = null;
  expect(posts()).toHaveLength(1);
  expect(store.has(attentionKey)).toBe(false);
  expect(entities.get(commentSubmissionOperationKey(scope101)).state).toBe('submission_may_have_started');
  // Authorization restored: the identity is repaired without a second POST.
  await syncComment(event());
  expect(posts()).toHaveLength(1);
});

test('overlapping Pause failures still submit once after authorization returns', async () => {
  await dueF02Record();
  pauseAfterClaim();
  const stalled = stallFirstDelivery();
  const concurrent = syncComment(event());
  await stalled.started();
  afterRearm = async () => { stalled.resume(); await concurrent; };
  await recoverCommentVerifications(() => syncComment(event(), 'org-1'));
  failure = null; store.delete('pilotPause');
  // Both invocations were refused before the transport was reached, so both
  // released the boundary: the comment is retryable and unsent.
  expect(posts()).toHaveLength(0);
  expectReleased();
  await recoverCommentVerifications(() => syncComment(event(), 'org-1'));
  expect(posts()).toHaveLength(1);
  await recoverCommentVerifications(() => syncComment(event(), 'org-1'));
  await syncComment(event());
  expect(posts()).toHaveLength(1);
  expect(store.has(attentionKey)).toBe(false);
});

test('a stale invocation publishes nothing once the phase is no longer its own', async () => {
  await dueF02Record();
  const { entities } = require('./helpers/forge-lease-runtime');
  const { commentSubmissionOperationKey } = jest.requireActual('../src/services/sync/comment-submission.js');
  const lease = await acquireIssueLease({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' });
  const key = commentSubmissionOperationKey(scope101);
  failure = body => {
    // A successor reclaims the phase right after A wrote its F02 boundary, and
    // A's F07 ownership is replaced, so the guarded transport refuses the POST.
    if (body.key.startsWith('comment-verification-submission:')) {
      entities.set(key, { ...entities.get(key), state: 'submission_may_have_started', token: 'successor' });
      entities.set(lease.key, { leaseToken: 'successor', expiresAt: Date.now() + 120000 });
    }
    return false;
  };
  let outcome;
  await recoverCommentVerifications(() => runWithIssueLease(lease, async () => {
    outcome = await syncComment(event(), 'org-1');
    return outcome;
  }));
  failure = null;
  // The rejected predicate rolled the transaction back: it released nothing and
  // left the successor's operation in progress instead of escalating.
  expect(outcome).toMatchObject({ status: 'COMMENT_RECONCILIATION_REQUIRED', reason: 'SUBMISSION_IN_PROGRESS' });
  expect(posts()).toHaveLength(0);
  expect(store.has(attentionKey)).toBe(false);
  expect(entities.get(key)).toMatchObject({ state: 'submission_may_have_started', token: 'successor' });
  expect(store.has(markerKey)).toBe(true);
  expect(store.get(deferredKey)).toMatchObject({ state: 'write_started', lastOutcome: 'SUBMISSION_IN_PROGRESS' });
});

test('the phase and the boundary commit in one transaction with an ownership predicate', async () => {
  await dueF02Record();
  pauseAfterClaim();
  await recoverCommentVerifications(() => syncComment(event(), 'org-1'));
  failure = null; store.delete('pilotPause');
  const combined = requests.filter(request => request.path === '/api/v1/transaction').map(request => request.body)
    .find(body => (body.set || []).some(operation => operation.entityName === 'comment-submission'
      && operation.value?.state === 'pre_submission'));
  // One request: the re-armed phase, the released verification record, and the
  // marker deletion. Splitting them would reopen the interleaving window.
  expect(combined.set.some(operation => !operation.entityName && operation.key === deferredKey)).toBe(true);
  expect(combined.delete.map(operation => operation.key)).toEqual([markerKey]);
  const phase = combined.set.find(operation => operation.entityName === 'comment-submission');
  expect(JSON.stringify(phase.conditions)).toMatch(/submission_may_have_started/);
  expectReleased();
});

test('a manual attention record keeps the deferred boundary out of reach', async () => {
  const { prepareDeferredSubmissionRelease } =
    jest.requireActual('../src/services/sync/comment-verification-recovery.js');
  await dueF02Record();
  store.set(deferredKey, { ...store.get(deferredKey), state: 'write_started' });
  store.set(markerKey, true);
  store.set(attentionKey, { reason: 'interrupted-submission' });
  const release = await prepareDeferredSubmissionRelease({ direction: 'local-to-remote',
    orgId: 'org-1', issueKey: 'LOCAL-1', commentId: '101' });
  // Releasing would publish an armed phase that recovery must never retry.
  expect(release).toMatchObject({ status: 'ATTENTION_RETAINED', confirmed: false });
  expect(store.get(deferredKey).state).toBe('write_started');
  expect(store.has(markerKey)).toBe(true);
});

test('a failed phase-and-boundary transaction leaves both stores fenced', async () => {
  await dueF02Record();
  const { entities } = require('./helpers/forge-lease-runtime');
  const { commentSubmissionOperationKey } = jest.requireActual('../src/services/sync/comment-submission.js');
  failure = body => {
    if (body.key.startsWith('comment-submission:')) {
      store.set('pilotPause', { paused: true });
      // The combined transaction cannot commit: neither half may appear.
      transactionFailure = request => [...(request.set || []), ...(request.delete || [])]
        .some(operation => !operation.entityName);
    }
    return false;
  };
  await recoverCommentVerifications(() => syncComment(event(), 'org-1'));
  failure = null; getFailure = null; transactionFailure = null; store.delete('pilotPause');
  expect(posts()).toHaveLength(0);
  expect(entities.get(commentSubmissionOperationKey(scope101)).state).toBe('submission_may_have_started');
  expect(store.has(markerKey)).toBe(true);
  // Recovery escalates and ordinary redelivery stays blocked: no blind replay.
  expect(store.get(attentionKey)).toMatchObject({ state: 'write_started' });
  expect(store.has(deferredKey)).toBe(false);
  await recoverCommentVerifications(() => syncComment(event(), 'org-1'));
  await syncComment(event());
  expect(posts()).toHaveLength(0);
});

test('an ambiguous outcome keeps the deferred marker and never replays', async () => {
  await dueF02Record();
  mockFetch.mockImplementation(async () => { throw new Error('socket hang up'); });
  await recoverCommentVerifications(() => syncComment(event(), 'org-1'));
  expect(posts()).toHaveLength(1);
  // A request may have reached Jira: F02 and the phase stay fenced forever.
  expect(store.has(markerKey)).toBe(true);
  await recoverCommentVerifications(() => syncComment(event(), 'org-1'));
  await syncComment(event());
  expect(posts()).toHaveLength(1);
  expect(store.has(attentionKey)).toBe(true);
});

test('a restricted ancestor still blocks recovery after a re-arm', async () => {
  await dueF02Record();
  pauseAfterClaim();
  await recoverCommentVerifications(() => syncComment(event(), 'org-1'));
  failure = null; store.delete('pilotPause');
  expectReleased();
  getFullComment.mockImplementation(async (_, id) => id === '100'
    ? { ...comment(id), visibility: { type: 'group', value: 'private' } }
    : { ...comment(id), parentId: '100' });
  await recoverCommentVerifications(() => syncComment(event(), 'org-1'));
  expect(posts()).toHaveLength(0);
  expect(store.has(attentionKey)).toBe(false);
});

test('an undeclared custom entity is rejected instead of silently working', async () => {
  const runtime = require('./helpers/forge-lease-runtime');
  const source = require('./helpers/forge-manifest').readManifest();
  // Rename the declaration: the entity name production uses is no longer
  // declared, exactly as it was before this correction.
  runtime.useManifest(source.replace('      - name: comment-submission',
    '      - name: comment-submission-undeclared'));
  await expect(storage.kvs.entity('comment-submission').get('key'))
    .rejects.toThrow(/Undeclared custom entity "comment-submission"/);
  expect(await syncComment(event())).toMatchObject({ status: 'COMMENT_RECONCILIATION_REQUIRED' });
  expect(posts()).toHaveLength(0);
});
