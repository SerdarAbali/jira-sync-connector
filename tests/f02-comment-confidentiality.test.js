const mockStore = new Map();
jest.mock('@forge/api', () => ({
  __esModule: true,
  default: { asApp: () => ({ requestJira: mockRequestJira }) },
  route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
  fetch: (...args) => mockFetch(...args)
}));
const mockRequestJira = jest.fn();
const mockFetch = jest.fn();
jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(async key => mockStore.get(key)),
  set: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  del: jest.fn(async key => { mockStore.delete(key); }),
  getSecret: jest.fn(async () => 'abcdefghijklmnop'),
  createIfNotExists: jest.fn(async (key, value) => {
    if (mockStore.has(key)) throw Object.assign(new Error('conflict'), { code: 'KEY_ALREADY_EXISTS' });
    mockStore.set(key, value);
  }),
  setIfNotExists: jest.fn(async (key, value) => {
    if (mockStore.has(key)) throw Object.assign(new Error('conflict'), { code: 'KEY_ALREADY_EXISTS' });
    mockStore.set(key, value);
  }),
  setWithTtl: jest.fn(async (key, value) => { mockStore.set(key, value); })
  ,queryByPrefix: jest.fn(async prefix => Array.from(mockStore, ([key, value]) => ({ key, value })).filter(row => row.key.startsWith(prefix)))
}));
jest.mock('../src/services/storage/mappings.js', () => ({
  getLocalKey: jest.fn(async () => 'LOCAL-1'),
  getRemoteKey: jest.fn(async () => 'REMOTE-1'),
  getOrganizationsWithTokens: jest.fn(),
  getRemoteCommentId: jest.fn(async () => null),
  getLocalCommentId: jest.fn(async () => 'LOCAL-PARENT'),
  storeCommentMapping: jest.fn(),
  storeMapping: jest.fn(), ensureMappingPair: jest.fn(),
  storeLinkMapping: jest.fn(), getLinkMapping: jest.fn(), removeLinkMapping: jest.fn()
}));
jest.mock('../src/services/storage/flags.js', () => ({
  markSyncing: jest.fn(), clearSyncFlag: jest.fn(),
  isSyncing: jest.fn(async () => false),
  enqueuePendingChildIssue: jest.fn(), consumePendingChildIssues: jest.fn(async () => [])
}));
jest.mock('../src/services/storage/stats.js', () => ({
  logAuditEntry: jest.fn(), trackWebhookSync: jest.fn(), trackApiCall: jest.fn()
}));
jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn(), getFullComment: jest.fn(), getOrgName: jest.fn(async () => 'Local Org'),
  updateLocalIssueDescription: jest.fn()
}));
jest.mock('../src/services/jira/remote-client.js', () => ({
  getRemoteIssue: jest.fn(), getRemoteComment: jest.fn()
}));
jest.mock('../src/services/sync/initial-sync.js', () => ({ recoverInitialSyncJobs: jest.fn(async () => ({ recovered: 0 })) }));
jest.mock('../src/services/sync/source-reconciliation.js', () => ({ runDueReconciliations: jest.fn(async () => ({ scheduled: 0 })) }));
jest.mock('../src/services/sync/transition-sync.js', () => ({ transitionLocalIssue: jest.fn() }));
jest.mock('../src/services/sync/pilot-pause.js', () => ({
  getPilotPause: jest.fn(async () => ({ paused: false })), assertPilotWritesAllowed: jest.fn()
}));

import { syncComment, syncAllComments } from '../src/services/sync/comment-sync.js';
import { processIncomingWebhook } from './helpers/signed-webhook.js';
import { getFullIssue, getFullComment } from '../src/services/jira/local-client.js';
import { getRemoteComment } from '../src/services/jira/remote-client.js';
import { getOrganizationsWithTokens, storeCommentMapping, getRemoteCommentId } from '../src/services/storage/mappings.js';
import { isSyncing, markSyncing, clearSyncFlag } from '../src/services/storage/flags.js';
import { trackWebhookSync, logAuditEntry } from '../src/services/storage/stats.js';
import { getCommentConfidentiality, verifyCommentThread } from '../src/services/sync/comment-confidentiality.js';
import { CommentVerificationDeferred, commentReadBudget } from '../src/services/jira/comment-read.js';
import { recoverCommentVerifications, deferCommentVerification, markDeferredCommentSubmission } from '../src/services/sync/comment-verification-recovery.js';
import { buildWebhookFingerprint, webhookMarkerKey } from '../src/services/sync/webhook-replay.js';
import fixtures from './fixtures/comment-rest-responses.json';
import * as kvs from '../src/services/storage/kvs.js';
import { getPilotPause } from '../src/services/sync/pilot-pause.js';
import { run as runRecoveryHeartbeat } from '../src/triggers/initial-sync-recovery.js';
import { getCommentProjectType } from '../src/services/jira/comment-project.js';

const org = {
  id: 'org-1', name: 'Remote', remoteUrl: 'https://remote.atlassian.net',
  remoteEmail: 'sync@example.invalid', remoteApiToken: 'test-token',
  syncDirection: 'bidirectional', allowedProjects: ['LOCAL']
};
const issue = { key: 'LOCAL-1', fields: { project: { key: 'LOCAL' } } };
const auth = { orgId: 'org-1', signingSecret: 'abcdefghijklmnop' };
const privateText = 'CONFIDENTIAL_F02_BODY';
const safeComment = (id = '101') => ({
  id, body: 'ordinary comment', jsdPublic: true, properties: [],
  author: { displayName: 'Ordinary author' }
});

describe('F02 corrective pass through production source clients', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-23T10:00:00Z')); });
  afterEach(() => { jest.useRealTimers(); });
  async function recoverAt(retry, now = Date.now()) {
    jest.setSystemTime(now);
    return recoverCommentVerifications(retry, now);
  }
  const actualLocal = jest.requireActual('../src/services/jira/local-client.js');
  const actualRemote = jest.requireActual('../src/services/jira/remote-client.js');
  const identifiers = { direction: 'remote-to-local', orgId: 'org-1', issueKey: 'REMOTE-1', commentId: '101' };
  const pendingKey = 'comment-verification:remote-to-local:org-1:REMOTE-1:101';
  const markerKey = () => webhookMarkerKey('org-1', buildWebhookFingerprint(payload({ id: '101' }), 'org-1'));
  const response = data => ({ ok: true, status: 200, json: async () => data });

  function sourceResponses(fixture) {
    const transport = async (url, options) => {
      if (options?.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: '201' }) };
      if (url.includes('/comment/')) return response(fixture.comment);
      return response({ fields: { project: { id: '10', projectTypeKey: fixture.projectTypeKey } } });
    };
    mockFetch.mockImplementation(transport);
    mockRequestJira.mockImplementation(transport);
    getRemoteComment.mockImplementation(actualRemote.getRemoteComment);
    getFullComment.mockImplementation(actualLocal.getFullComment);
  }

  test.each(['software', 'business', 'jsmPublic'])('%s REST fixture synchronizes both directions without invented flags', async name => {
    sourceResponses(fixtures[name]);
    await syncComment({ issue, comment: { id: '101' } });
    const result = await processIncomingWebhook(payload({ id: '101' }), auth);
    expect(writes(mockFetch)).toHaveLength(1);
    expect(writes(mockRequestJira)).toHaveLength(1);
    expect(result.status).toBe(200);
  });

  test('JSM internal REST fixture cannot write in either direction', async () => {
    sourceResponses(fixtures.jsmInternal);
    await syncComment({ issue, comment: { id: '101' } });
    await processIncomingWebhook(payload({ id: '101' }), auth);
    expect(writes(mockFetch)).toHaveLength(0);
    expect(writes(mockRequestJira)).toHaveLength(0);
  });

  test('JSM comment without public evidence remains fail closed', async () => {
    sourceResponses({ ...fixtures.software, projectTypeKey: 'service_desk' });
    await syncComment({ issue, comment: { id: '101' } });
    await processIncomingWebhook(payload({ id: '101' }), auth);
    expect(writes(mockFetch)).toHaveLength(0);
    expect(writes(mockRequestJira)).toHaveLength(0);
  });

  test.each(['direct', 'property'])('real clients block a restricted ancestor through %s parent metadata', async encoding => {
    sourceResponses(fixtures.software);
    const transport = async url => {
      const id = url.match(/comment\/(\d+)/)?.[1];
      if (id === '101') return response({ ...fixtures.software.comment,
        ...(encoding === 'direct' ? { parentId: '100' }
          : { properties: [{ key: 'comment.thread', value: { nested: ['100'] } }] }) });
      if (id === '100') return response({ ...safeComment('100'), parentId: '99' });
      if (id === '99') return response({ ...safeComment('99'), visibility: { type: 'role', value: 'private' } });
      return response({ fields: { project: { projectTypeKey: 'software' } } });
    };
    mockFetch.mockImplementation(transport);
    mockRequestJira.mockImplementation(transport);
    await syncComment({ issue, comment: { id: '101' } });
    await processIncomingWebhook(payload({ id: '101' }), auth);
    expect(writes(mockFetch)).toHaveLength(0);
    expect(writes(mockRequestJira)).toHaveLength(0);
    expect(storeCommentMapping).not.toHaveBeenCalled();
  });

  test.each(['cycle', 'depth', 'malformed'])('unverifiable %s ancestry blocks both paths', async scenario => {
    const source = id => ({ ...safeComment(id), ...(scenario === 'cycle' ? { parentId: id }
      : scenario === 'depth' ? { parentId: String(Number(id) + 1) }
        : { properties: [{ key: 'parent', value: { unexpected: true } }] }) });
    getFullComment.mockImplementation(async (key, id) => source(id));
    getRemoteComment.mockImplementation(async (key, id) => source(id));
    await syncComment({ issue, comment: { id: '101' } });
    await processIncomingWebhook(payload({ id: '101' }), auth);
    expect(writes(mockFetch)).toHaveLength(0);
    expect(writes(mockRequestJira)).toHaveLength(0);
  });

  test('project fallback uses real project response and caches only within the operation', async () => {
    const transport = async url => response(url.includes('/project/')
      ? { projectTypeKey: 'business' } : { fields: { project: { id: '10' } } });
    mockFetch.mockImplementation(transport);
    const budget = commentReadBudget();
    expect(await getCommentProjectType('REMOTE-1', org, budget)).toBe('business');
    expect(await getCommentProjectType('REMOTE-1', org, budget)).toBe('business');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await getCommentProjectType('REMOTE-1', org, commentReadBudget());
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  test('unknown real project response does not authorize ordinary comments', async () => {
    sourceResponses({ ...fixtures.software, projectTypeKey: 'unknown' });
    await syncComment({ issue, comment: { id: '101' } });
    await processIncomingWebhook(payload({ id: '101' }), auth);
    expect(writes(mockFetch)).toHaveLength(0);
    expect(writes(mockRequestJira)).toHaveLength(0);
  });

  test('spent read budget defers without issuing a request', async () => {
    await expect(actualRemote.getRemoteComment('REMOTE-1', '101', org,
      { deadline: Date.now() - 1, cache: new Map() })).rejects.toMatchObject({ code: 'COMMENT_VERIFICATION_DEFERRED' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('real source JSON errors defer without accepting webhook content', async () => {
    sourceResponses(fixtures.software);
    mockFetch.mockResolvedValue({ ok: true, json: async () => { throw new Error('invalid JSON'); } });
    const result = await processIncomingWebhook(payload({ id: '101', body: 'unsafe fallback' }), auth);
    expect(result.status).toBe(202);
    expect(mockStore.has(markerKey())).toBe(false);
    expect(writes(mockRequestJira)).toHaveLength(0);
  });

  test('real remote client defers HTTP 429 immediately and preserves Retry-After', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429, headers: { get: () => '120' } });
    await expect(actualRemote.getRemoteComment('REMOTE-1', '101', org, commentReadBudget()))
      .rejects.toMatchObject({ code: 'COMMENT_VERIFICATION_DEFERRED', retryAfterMs: 120000 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('real client request and JSON decoding share the bounded timeout', async () => {
    jest.useFakeTimers();
    try {
      mockFetch.mockResolvedValue({ ok: true, json: () => new Promise(() => {}) });
      const pending = actualRemote.getRemoteComment('REMOTE-1', '101', org, commentReadBudget());
      const assertion = expect(pending).rejects.toMatchObject({ code: 'COMMENT_VERIFICATION_DEFERRED' });
      await jest.advanceTimersByTimeAsync(4000);
      await assertion;
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
  });

  test('source 503 is durably deferred, marker released, and later recovery revalidates and maps once', async () => {
    sourceResponses(fixtures.software);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const first = await processIncomingWebhook(payload({ id: '101' }), auth);
    expect(first).toMatchObject({ status: 202, body: { code: 'COMMENT_VERIFICATION_DEFERRED' } });
    expect(mockStore.has(markerKey())).toBe(false);
    expect(mockStore.get(pendingKey)).toMatchObject({ ...identifiers, attempts: 0 });
    expect(writes(mockRequestJira)).toHaveLength(0);
    const recovered = await recoverAt(() => processIncomingWebhook(payload({ id: '101' }), auth), Date.now() + 61000);
    expect(recovered.recovered).toBe(1);
    expect(mockStore.has(pendingKey)).toBe(false);
    expect(mockStore.get(markerKey())).toMatchObject({ state: 'completed' });
    expect(writes(mockRequestJira)).toHaveLength(1);
    expect(storeCommentMapping).toHaveBeenCalledWith('201', '101', 'org-1');
  });

  test('actual heartbeat dispatches deferred inbound and outbound production paths', async () => {
    sourceResponses(fixtures.software);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    await processIncomingWebhook(payload({ id: '101' }), auth);
    mockRequestJira.mockResolvedValueOnce({ ok: false, status: 503 });
    await syncComment({ issue, comment: { id: '101' } });
    const pending = Array.from(mockStore).filter(([key]) => key.startsWith('comment-verification:'));
    expect(pending).toHaveLength(2);
    jest.setSystemTime(Math.max(...pending.map(([, value]) => value.notBefore)) + 1);
    // F04: durable recovery must work even when neither webhook credential exists.
    const originalGetSecret = kvs.getSecret.getMockImplementation();
    kvs.getSecret.mockClear().mockImplementation(async key =>
      /:(incomingSecret|webhookSigningSecret)$/.test(key) ? null : originalGetSecret(key));
    let result;
    try { result = await runRecoveryHeartbeat(); }
    finally { kvs.getSecret.mockImplementation(originalGetSecret); }
    expect(kvs.getSecret.mock.calls.some(([key]) => /:(incomingSecret|webhookSigningSecret)$/.test(key))).toBe(false);
    expect(result.comments).toEqual({ recovered: 2 });
    expect(writes(mockFetch)).toHaveLength(1);
    expect(writes(mockRequestJira)).toHaveLength(1);
    expect(pending.every(([key]) => !mockStore.has(key))).toBe(true);
    expect(storeCommentMapping).toHaveBeenCalledTimes(2);
  });

  test('restriction introduced before recovery blocks the later write', async () => {
    sourceResponses(fixtures.software);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    await processIncomingWebhook(payload({ id: '101' }), auth);
    sourceResponses(fixtures.jsmInternal);
    await recoverAt(() => processIncomingWebhook(payload({ id: '101' }), auth), Date.now() + 61000);
    expect(writes(mockRequestJira)).toHaveLength(0);
    expect(mockStore.has(pendingKey)).toBe(false);
  });

  test('unavailable parent defers the whole inbound reply without completing its marker', async () => {
    sourceResponses(fixtures.software);
    mockFetch.mockImplementation(async url => url.includes('/comment/101')
      ? response({ ...safeComment(), parentId: '100' }) : { ok: false, status: 503 });
    const result = await processIncomingWebhook(payload({ id: '101' }), auth);
    expect(result.status).toBe(202);
    expect(mockStore.has(pendingKey)).toBe(true);
    expect(mockStore.has(markerKey())).toBe(false);
    expect(writes(mockRequestJira)).toHaveLength(0);
  });

  test('outbound and catch-up parent read failures persist identifier-only recovery', async () => {
    getFullComment.mockImplementation(async (key, id) => {
      if (id === '101') return { ...safeComment(), parentId: '100' };
      throw new CommentVerificationDeferred();
    });
    expect(await syncComment({ issue, comment: { id: '101' } })).toMatchObject({ status: 'COMMENT_VERIFICATION_DEFERRED' });
    mockRequestJira.mockResolvedValue(response({ comments: [{ ...safeComment(), parentId: '100' }] }));
    mockFetch.mockResolvedValue(response({ comments: [] }));
    await syncAllComments('LOCAL-1', 'REMOTE-1', issue, org, null, 'org-1');
    expect(writes(mockFetch)).toHaveLength(0);
    expect(mockStore.get('comment-verification:local-to-remote:org-1:LOCAL-1:101')).toMatchObject({ commentId: '101', attempts: 0 });
    expect(JSON.stringify(Array.from(mockStore))).not.toContain('ordinary comment');
  });

  test('recovery respects notBefore and stops after five attempts', async () => {
    await deferCommentVerification(identifiers, new CommentVerificationDeferred(120000));
    const retry = jest.fn(async () => ({ status: 503 }));
    await recoverAt(retry, Date.now() + 60000);
    expect(retry).not.toHaveBeenCalled();
    for (let attempt = 0; attempt < 6; attempt++) await recoverAt(retry, Date.now() + 121000);
    expect(retry).toHaveBeenCalledTimes(5);
    expect(mockStore.has(pendingKey)).toBe(false);
    expect(mockStore.has(pendingKey.replace('comment-verification:', 'comment-verification-attention:'))).toBe(true);
  });

  test('concurrent recovery workers submit a pending comment at most once', async () => {
    await deferCommentVerification(identifiers, new CommentVerificationDeferred());
    const retry = jest.fn(async () => { await markDeferredCommentSubmission(identifiers); return { status: 200 }; });
    await Promise.all([recoverAt(retry, Date.now() + 61000),
      recoverAt(retry, Date.now() + 61000)]);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('ambiguous recovered destination response moves to attention without replay', async () => {
    sourceResponses(fixtures.software);
    await deferCommentVerification(identifiers, new CommentVerificationDeferred());
    mockRequestJira.mockImplementation(async (url, options) => options?.method === 'POST'
      ? { ok: false, status: 503, text: async () => '' } : response(fixtures.software.comment));
    const retry = () => processIncomingWebhook(payload({ id: '101' }), auth);
    await recoverAt(retry, Date.now() + 61000);
    await recoverAt(retry, Date.now() + 121000);
    expect(writes(mockRequestJira)).toHaveLength(1);
    expect(mockStore.has(pendingKey.replace('comment-verification:', 'comment-verification-attention:'))).toBe(true);
  });

  test('a crash after submission claim cannot produce an automatic destination retry', async () => {
    await deferCommentVerification(identifiers, new CommentVerificationDeferred());
    jest.setSystemTime(Date.now() + 61000);
    await markDeferredCommentSubmission(identifiers);
    const retry = jest.fn();
    await recoverAt(retry, Date.now() + 61000);
    expect(retry).not.toHaveBeenCalled();
    expect(mockStore.has(pendingKey.replace('comment-verification:', 'comment-verification-attention:'))).toBe(true);
  });
});
const payload = comment => ({
  webhookEvent: 'comment_created', issue: { key: 'REMOTE-1' }, comment
});
const writes = mock => mock.mock.calls.filter(([, options]) => options?.method === 'POST');
let logSpies;

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  mockStore.set('organizations', [org]);
  getOrganizationsWithTokens.mockResolvedValue([org]);
  getFullIssue.mockResolvedValue(issue);
  getFullComment.mockReset().mockImplementation(async (key, id) => safeComment(id));
  getRemoteComment.mockReset().mockImplementation(async (key, id) => safeComment(id));
  getRemoteCommentId.mockResolvedValue(null);
  mockRequestJira.mockReset().mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: '201' }) });
  mockFetch.mockReset().mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: '202' }) });
  logSpies = ['log', 'warn', 'error'].map(method => jest.spyOn(console, method).mockImplementation(() => {}));
});
afterEach(() => { logSpies.forEach(spy => spy.mockRestore()); });

const unsafeMetadata = [
  ['group', { visibility: { type: 'group', value: 'private-team' } }],
  ['role', { visibility: { type: 'role', value: 'Administrators' } }],
  ['empty visibility', { visibility: {} }],
  ['null visibility', { visibility: null }],
  ['malformed visibility', { visibility: 'everyone' }],
  ['internal JSM', { jsdPublic: false }],
  ['internal request', { public: false }],
  ['malformed public flag', { jsdPublic: 'true' }],
  ['undefined visibility', { visibility: undefined }],
  ['malformed public status', { public: null }],
  ['internal property', { properties: [{ key: 'sd.public.comment', value: { internal: true } }] }],
  ['legacy internal property', { properties: [{ key: 'sd.public.comment', value: { internal: 'true' } }] }],
  ['malformed internal property', { properties: [{ key: 'sd.public.comment', value: {} }] }],
  ['malformed properties', { properties: {} }],
  ['malformed property entry', { properties: [null] }],
  ['legacy private property', { properties: [{ key: 'sd.allow.public.comment', value: { allow: false } }] }],
  ['unknown public status', { jsdPublic: undefined, properties: [] }]
];

describe('F02 comment confidentiality at synchronization boundaries', () => {
  test('ordinary outbound comment still creates and maps exactly one destination comment', async () => {
    await syncComment({ issue, comment: { id: '101' } });
    expect(writes(mockFetch)).toHaveLength(1);
    expect(storeCommentMapping).toHaveBeenCalledWith('101', '202', 'org-1');
  });

  test('ordinary inbound comment is verified through REST and retains flags and mapping', async () => {
    await processIncomingWebhook(payload({ id: '101' }), auth);
    expect(getRemoteComment).toHaveBeenCalledWith('REMOTE-1', '101', expect.objectContaining({ id: 'org-1' }), expect.any(Object));
    expect(writes(mockRequestJira)).toHaveLength(1);
    expect(storeCommentMapping).toHaveBeenCalledWith('201', '101', 'org-1');
    expect(markSyncing).toHaveBeenCalledWith('LOCAL-1');
    expect(clearSyncFlag).toHaveBeenCalledWith('LOCAL-1');
  });

  test.each(unsafeMetadata)('%s outbound comment never writes, including duplicate deliveries', async (name, metadata) => {
    getFullComment.mockResolvedValue({ ...safeComment(), ...metadata, body: privateText });
    await syncComment({ issue, comment: { id: '101' } });
    await syncComment({ issue, comment: { id: '101' } });
    expect(writes(mockFetch)).toHaveLength(0);
    expect(storeCommentMapping).not.toHaveBeenCalled();
    expect(JSON.stringify([logSpies.map(spy => spy.mock.calls), trackWebhookSync.mock.calls])).not.toContain(privateText);
  });

  test.each(unsafeMetadata)('%s inbound comment never writes even if webhook claims public', async (name, metadata) => {
    getRemoteComment.mockResolvedValue({ ...safeComment(), ...metadata, body: privateText });
    await processIncomingWebhook(payload(safeComment()), auth);
    await processIncomingWebhook(payload(safeComment()), auth);
    expect(writes(mockRequestJira)).toHaveLength(0);
    expect(storeCommentMapping).not.toHaveBeenCalled();
    expect(markSyncing).not.toHaveBeenCalled();
    expect(JSON.stringify([Array.from(mockStore), logAuditEntry.mock.calls, logSpies.map(spy => spy.mock.calls)])).not.toContain(privateText);
  });

  test.each([null, {}, { ...safeComment(), id: 'wrong' }])('unavailable or mismatched REST comment cannot fall back to webhook text: %p', async source => {
    getRemoteComment.mockResolvedValue(source);
    await processIncomingWebhook(payload(safeComment()), auth);
    expect(writes(mockRequestJira)).toHaveLength(0);
  });

  test.each([null, {}, { ...safeComment(), id: 'wrong' }])('unavailable or mismatched outbound REST comment cannot use event content: %p', async source => {
    getFullComment.mockResolvedValue(source);
    await syncComment({ issue, comment: safeComment() });
    expect(writes(mockFetch)).toHaveLength(0);
  });

  test('a restricted webhook cannot be upgraded to public by an inconsistent REST response', async () => {
    await processIncomingWebhook(payload({ ...safeComment(), visibility: { type: 'role', value: 'private' } }), auth);
    expect(writes(mockRequestJira)).toHaveLength(0);
  });

  test('only authoritative body is copied and duplicate webhook delivery remains suppressed', async () => {
    await processIncomingWebhook(payload({ ...safeComment(), body: privateText }), auth);
    await processIncomingWebhook(payload({ ...safeComment(), body: privateText }), auth);
    expect(writes(mockRequestJira)).toHaveLength(1);
    expect(JSON.stringify(writes(mockRequestJira))).toContain('ordinary comment');
    expect(JSON.stringify(writes(mockRequestJira))).not.toContain(privateText);
    expect(storeCommentMapping).toHaveBeenCalledTimes(1);
  });

  test('existing outbound mappings still prevent copying', async () => {
    getRemoteCommentId.mockResolvedValue('202');
    await syncComment({ issue, comment: { id: '101' } });
    expect(writes(mockFetch)).toHaveLength(0);
  });

  test.each(unsafeMetadata)('outbound reply is blocked by unsafe parent: %s', async (name, metadata) => {
    getFullComment.mockImplementation(async (key, id) => id === '101'
      ? { ...safeComment(id), parentId: '100' }
      : { ...safeComment(id), ...metadata, body: privateText, author: { displayName: privateText } });
    await syncComment({ issue, comment: { id: '101' } });
    expect(writes(mockFetch)).toHaveLength(0);
    expect(JSON.stringify(writes(mockFetch))).not.toContain(privateText);
  });

  test.each(unsafeMetadata)('inbound reply is blocked by unsafe parent: %s', async (name, metadata) => {
    getRemoteComment.mockImplementation(async (key, id) => id === '101'
      ? { ...safeComment(id), parentId: '100' }
      : { ...safeComment(id), ...metadata, body: privateText, author: { displayName: privateText } });
    await processIncomingWebhook(payload(safeComment()), auth);
    expect(writes(mockRequestJira)).toHaveLength(0);
    expect(JSON.stringify(writes(mockRequestJira))).not.toContain(privateText);
  });

  test('unrestricted parent snippets are preserved in both directions', async () => {
    const source = async (key, id) => id === '101'
      ? { ...safeComment(id), parentId: '100' } : { ...safeComment(id), body: 'safe parent snippet' };
    getFullComment.mockImplementation(source);
    getRemoteComment.mockImplementation(source);
    await syncComment({ issue, comment: { id: '101' } });
    await processIncomingWebhook(payload(safeComment()), auth);
    expect(JSON.stringify(writes(mockFetch))).toContain('safe parent snippet');
    expect(JSON.stringify(writes(mockRequestJira))).toContain('safe parent snippet');
  });

  test('historical catch-up skips private comments and private parent context', async () => {
    const parent = { ...safeComment('100'), body: privateText, visibility: { type: 'role', value: 'private' } };
    const child = { ...safeComment('101'), parentId: '100' };
    mockRequestJira.mockResolvedValue({ ok: true, json: async () => ({ comments: [parent, child] }) });
    mockFetch.mockImplementation(async (url, options) => ({
      ok: true, status: options?.method === 'POST' ? 201 : 200,
      json: async () => options?.method === 'POST' ? { id: '202' } : { comments: [] }
    }));
    const result = await syncAllComments('LOCAL-1', 'REMOTE-1', issue, org, null, 'org-1');
    expect(result).toEqual({ synced: 0, skipped: 2, failed: 0 });
    expect(writes(mockFetch)).toHaveLength(0);
    expect(JSON.stringify(writes(mockFetch))).not.toContain(privateText);
  });

  test.each(unsafeMetadata)('historical catch-up cannot bypass confidentiality: %s', async (name, metadata) => {
    mockRequestJira.mockResolvedValue({ ok: true, json: async () => ({
      comments: [{ ...safeComment(), ...metadata, body: privateText }]
    }) });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ comments: [] }) });
    const result = await syncAllComments('LOCAL-1', 'REMOTE-1', issue, org, null, 'org-1');
    expect(result).toEqual({ synced: 0, skipped: 1, failed: 0 });
    expect(writes(mockFetch)).toHaveLength(0);
    expect(storeCommentMapping).not.toHaveBeenCalled();
    expect(JSON.stringify(logSpies.map(spy => spy.mock.calls))).not.toContain(privateText);
  });
});

describe('F02 shared policy', () => {
  test('webhook metadata alone is never sufficient', () => {
    expect(getCommentConfidentiality(safeComment()).allowed).toBe(false);
  });
  test.each([
    { jsdPublic: true }, { public: true },
    { properties: [{ key: 'sd.public.comment', value: { internal: false } }] },
    { properties: [{ key: 'sd.public.comment', value: { internal: 'false' } }] }
  ])('allows explicit public status from authoritative REST: %p', metadata => {
    expect(getCommentConfidentiality({ id: '101', ...metadata }, { authoritative: true }).allowed).toBe(true);
  });
  test('a public JSM flag never overrides group restrictions', () => {
    expect(getCommentConfidentiality({ ...safeComment(), visibility: { type: 'group', value: 'private' } },
      { authoritative: true }).allowed).toBe(false);
  });
  test('conflicting JSM flags fail closed', () => {
    expect(getCommentConfidentiality({ ...safeComment(), public: false }, { authoritative: true }).allowed).toBe(false);
  });
});


describe('F02 corrective pass 3 regressions', () => {
  const identifiers = { direction: 'local-to-remote', orgId: 'org-1', issueKey: 'LOCAL-1', commentId: '101' };
  const pendingKey = 'comment-verification:local-to-remote:org-1:LOCAL-1:101';
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-23T12:00:00Z'));
    isSyncing.mockResolvedValue(false);
    getPilotPause.mockResolvedValue({ paused: false });
  });
  afterEach(() => { jest.useRealTimers(); isSyncing.mockResolvedValue(false); getPilotPause.mockResolvedValue({ paused: false }); });
  async function due() {
    await deferCommentVerification(identifiers, new CommentVerificationDeferred());
    jest.setSystemTime(Date.now() + 61000);
  }

  test.each([
    ['zero', { parentId: 0 }], ['false', { parentId: false }], ['empty parent', { parent: {} }],
    ['contradictory direct', { parentId: '100', parentCommentId: '99' }],
    ['invalid nested identifier', { parent: { id: false } }],
    ['conflicting nested', { parentId: '100', parent: { id: '99' } }],
    ['null parent', { parentId: null }],
    ['conflicting properties', { properties: [{ key: 'parent', value: { id: '100', parentId: '99' } }] }],
    ['invalid property identifier', { properties: [{ key: 'thread', value: { parentId: 0 } }] }]
  ])('N1 malformed ancestry %s blocks production paths', async (name, metadata) => {
    getFullComment.mockImplementation(async (key, id) => ({ ...safeComment(id), ...(id === '101' ? metadata : {}) }));
    getRemoteComment.mockImplementation(async (key, id) => ({ ...safeComment(id), ...(id === '101' ? metadata : {}) }));
    await syncComment({ issue, comment: { id: '101' } });
    await processIncomingWebhook(payload({ id: '101' }), auth);
    expect(writes(mockFetch)).toHaveLength(0);
    expect(writes(mockRequestJira)).toHaveLength(0);
  });

  test('N1 genuinely absent ancestry is safe, inaccessible ancestors defer, and cycles reject', async () => {
    const options = { expectedId: '101', projectType: async () => 'software', readParent: jest.fn() };
    expect((await verifyCommentThread(safeComment(), options)).allowed).toBe(true);
    options.readParent.mockRejectedValue(new CommentVerificationDeferred());
    await expect(verifyCommentThread({ ...safeComment(), parentId: '100' }, options))
      .rejects.toMatchObject({ code: 'COMMENT_VERIFICATION_DEFERRED' });
    options.readParent.mockResolvedValue({ ...safeComment('100'), parentId: '101' });
    expect((await verifyCommentThread({ ...safeComment(), parentId: '100' }, options)).allowed).toBe(false);
  });

  test.each(['syncing', 'issue read', 'pause'])('N2 recovery preserves pending work during %s', async reason => {
    await due();
    if (reason === 'syncing') isSyncing.mockResolvedValue(true);
    if (reason === 'issue read') getFullIssue.mockResolvedValue(null);
    if (reason === 'pause') getPilotPause.mockResolvedValue({ paused: true });
    await runRecoveryHeartbeat();
    expect(mockStore.has(pendingKey)).toBe(true);
    expect(writes(mockFetch)).toHaveLength(0);
  });

  test('N2 undefined and interrupted outcomes remain pending and eventually require attention', async () => {
    await due();
    await recoverCommentVerifications(async () => undefined);
    expect(mockStore.has(pendingKey)).toBe(true);
    await recoverCommentVerifications(async () => { throw new Error('interrupted'); });
    expect(mockStore.has(pendingKey)).toBe(true);
    for (let i = 0; i < 6; i++) await recoverCommentVerifications(async () => undefined);
    expect(mockStore.has(pendingKey.replace('comment-verification:', 'comment-verification-attention:'))).toBe(true);
  });

  test('N2 terminal persistence failure cannot delete pending work or report completion', async () => {
    await due();
    const original = kvs.set.getMockImplementation();
    kvs.set.mockImplementation(async (key, value) => {
      if (value?.state === 'terminal') throw new Error('storage unavailable');
      return original(key, value);
    });
    try {
      const result = await runRecoveryHeartbeat();
      expect(mockStore.has(pendingKey)).toBe(true);
      expect(result.comments.recovered).toBe(0);
      expect(writes(mockFetch)).toHaveLength(1);
    } finally { kvs.set.mockImplementation(original); }
  });

  test('N2 external delivery overlapping recovery remains durable and creates once', async () => {
    const inbound = { ...identifiers, direction: 'remote-to-local', issueKey: 'REMOTE-1' };
    const key = 'comment-verification:remote-to-local:org-1:REMOTE-1:101';
    await deferCommentVerification(inbound, new CommentVerificationDeferred());
    jest.setSystemTime(Date.now() + 61000);
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    getRemoteComment.mockImplementationOnce(() => hold);
    const external = processIncomingWebhook(payload({ id: '101' }), auth);
    // Wait for the external production handler to claim and reach its source read.
    for (let i = 0; i < 100 && !getRemoteComment.mock.calls.length; i++) await Promise.resolve();
    expect(getRemoteComment).toHaveBeenCalled();
    await runRecoveryHeartbeat();
    expect(mockStore.has(key)).toBe(true);
    release(safeComment());
    await external;
    await runRecoveryHeartbeat();
    expect(writes(mockRequestJira)).toHaveLength(1);
    expect(mockStore.has(key)).toBe(false);
  });

  test('N2 interrupted terminal deletion resumes without another destination write', async () => {
    await due();
    const original = kvs.del.getMockImplementation();
    let fail = true;
    kvs.del.mockImplementation(async key => {
      if (key === pendingKey && fail) { fail = false; throw new Error('delete unavailable'); }
      return original(key);
    });
    try {
      const first = await runRecoveryHeartbeat();
      expect(first.comments.recovered).toBe(0);
      expect(mockStore.get(pendingKey)).toMatchObject({ state: 'terminal', outcome: 'COMMENT_SYNCED' });
      await runRecoveryHeartbeat();
      expect(writes(mockFetch)).toHaveLength(1);
      expect(mockStore.has(pendingKey)).toBe(false);
    } finally { kvs.del.mockImplementation(original); }
  });

  test('N3 repeated real-client throttling is durable and blocks external reads until due', async () => {
    const actualRemote = jest.requireActual('../src/services/jira/remote-client.js');
    getRemoteComment.mockImplementation(actualRemote.getRemoteComment);
    mockFetch.mockResolvedValue({ ok: false, status: 429, headers: { get: () => '7200' } });
    const key = 'comment-verification:remote-to-local:org-1:REMOTE-1:101';
    expect((await processIncomingWebhook(payload({ id: '101' }), auth)).status).toBe(202);
    const deadline = mockStore.get(key).notBefore;
    jest.setSystemTime(Date.now() + 60000);
    await processIncomingWebhook(payload({ id: '101' }), auth);
    await runRecoveryHeartbeat();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockStore.get(key).notBefore).toBe(deadline);
    jest.setSystemTime(deadline + 1);
    await runRecoveryHeartbeat();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockStore.get(key).notBefore).toBe(Date.now() + 7200000);
    expect(writes(mockRequestJira)).toHaveLength(0);
  });

  test.each(['catch-up', 'outbound', 'inbound'])('final %s verification rejects a newly restricted ancestor', async direction => {
    let parentReads = 0;
    const read = async (key, id) => id === '101' ? { ...safeComment(), parentId: '100' }
      : { ...safeComment('100'), ...(++parentReads > 1 ? { visibility: { type: 'group', value: 'private' } } : {}) };
    getFullComment.mockImplementation(read);
    getRemoteComment.mockImplementation(read);
    if (direction === 'catch-up') {
      mockRequestJira.mockResolvedValue({ ok: true, json: async () => ({ comments: [{ ...safeComment(), parentId: '100' }] }) });
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ comments: [] }) });
      await syncAllComments('LOCAL-1', 'REMOTE-1', issue, org, null, 'org-1');
    } else if (direction === 'outbound') await syncComment({ issue, comment: { id: '101' } });
    else await processIncomingWebhook(payload({ id: '101' }), auth);
    expect(writes(mockFetch)).toHaveLength(0);
    expect(writes(mockRequestJira)).toHaveLength(0);
  });

  test('N3 duplicate one-minute deferral cannot shorten an existing two-hour deadline', async () => {
    await deferCommentVerification(identifiers, new CommentVerificationDeferred(7200000));
    const deadline = mockStore.get(pendingKey).notBefore;
    jest.setSystemTime(Date.now() + 30000);
    await deferCommentVerification(identifiers, new CommentVerificationDeferred(60000));
    expect(mockStore.get(pendingKey).notBefore).toBe(deadline);
  });

  test('N3 normal delivery and recovery honor the deadline and later reverify restrictions', async () => {
    await deferCommentVerification(identifiers, new CommentVerificationDeferred(7200000));
    await syncComment({ issue, comment: { id: '101' } });
    await runRecoveryHeartbeat();
    expect(writes(mockFetch)).toHaveLength(0);
    jest.setSystemTime(Date.now() + 7200001);
    getFullComment.mockResolvedValue({ ...safeComment(), visibility: { type: 'group', value: 'private' } });
    await runRecoveryHeartbeat();
    expect(writes(mockFetch)).toHaveLength(0);
    expect(mockStore.has(pendingKey)).toBe(false);
  });

  test('N3 concurrent throttling preserves the longest deadline', async () => {
    await Promise.all([deferCommentVerification(identifiers, new CommentVerificationDeferred(7200000)),
      deferCommentVerification(identifiers, new CommentVerificationDeferred(60000))]);
    jest.setSystemTime(Date.now() + 61000);
    await syncComment({ issue, comment: { id: '101' } });
    expect(writes(mockFetch)).toHaveLength(0);
  });

  test('N3 a late stale scheduling write cannot erase a concurrent longer barrier', async () => {
    const original = kvs.set.getMockImplementation();
    let release, reached;
    const holding = new Promise(resolve => { reached = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const shortDeadline = Date.now() + 60000;
    kvs.set.mockImplementation(async (key, value) => {
      if (key === pendingKey && value.notBefore === shortDeadline) { reached(); await held; }
      return original(key, value);
    });
    try {
      const short = deferCommentVerification(identifiers, new CommentVerificationDeferred(60000));
      await holding;
      await deferCommentVerification(identifiers, new CommentVerificationDeferred(7200000));
      release();
      await short;
      jest.setSystemTime(Date.now() + 61000);
      await syncComment({ issue, comment: { id: '101' } });
      await runRecoveryHeartbeat();
      expect(writes(mockFetch)).toHaveLength(0);
      expect(mockStore.has(pendingKey)).toBe(true);
    } finally { release(); kvs.set.mockImplementation(original); }
  });

  test('acceptance defect 1: outbound final omission must retain initially discovered parent (101 -> 100 -> 101)', async () => {
    getFullComment.mockResolvedValueOnce({ ...safeComment(), parentId: '100' })
      .mockResolvedValueOnce(safeComment('100'))
      .mockResolvedValueOnce(safeComment())
      .mockResolvedValue({ ...safeComment('100'), visibility: { type: 'role', value: 'private' } });
    await syncComment({ issue, comment: { id: '101' } });
    expect(getFullComment.mock.calls.slice(0, 3).map(([, id]) => id)).toEqual(['101', '100', '101']);
    expect(writes(mockFetch)).toHaveLength(0);
    expect(storeCommentMapping).not.toHaveBeenCalled();
    expect(getFullComment.mock.calls.map(([, id]) => id)).toEqual(['101', '100', '101', '100']);
  });

  test.each(['restricted', 'contradictory', 'inaccessible', 'safe'])('acceptance defect 1: final omission retains the full known ancestor chain (%s)', async state => {
    const reads = [
      { ...safeComment(), parentId: '100' }, { ...safeComment('100'), parentId: '99' }, safeComment('99'),
      safeComment(), state === 'contradictory' ? { ...safeComment('100'), parentId: '98' } : safeComment('100')
    ];
    getFullComment.mockImplementation(async () => {
      if (reads.length) return reads.shift();
      if (state === 'inaccessible') throw new CommentVerificationDeferred();
      return { ...safeComment('99'), ...(state === 'restricted' ? { visibility: { type: 'role', value: 'private' } } : {}) };
    });
    const result = await syncComment({ issue, comment: { id: '101' } });
    expect(getFullComment.mock.calls.map(([, id]) => id)).toEqual(state === 'contradictory'
      ? ['101', '100', '99', '101', '100'] : ['101', '100', '99', '101', '100', '99']);
    expect(writes(mockFetch)).toHaveLength(state === 'safe' ? 1 : 0);
    if (state === 'inaccessible') {
      expect(result.status).toBe('COMMENT_VERIFICATION_DEFERRED');
      expect(mockStore.has(pendingKey)).toBe(true);
    }
  });

  test.each([30000, 60000, 120000].flatMap(delay => ['event', 'recovery'].map(path => [delay, path])))('acceptance defect 2: stale overlapping %ims deferrals cannot shorten the %s deadline', async (delay, path) => {
    const original = kvs.set.getMockImplementation();
    let release, reached;
    const holding = new Promise(resolve => { reached = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const start = Date.now();
    const effectiveDelay = Math.max(60000, delay);
    kvs.set.mockImplementation(async (key, value) => {
      if (key === pendingKey && value.notBefore === start + effectiveDelay) { reached(); await held; }
      return original(key, value);
    });
    try {
      const stale = deferCommentVerification(identifiers, new CommentVerificationDeferred(delay));
      await holding;
      jest.setSystemTime(start + 30000);
      await deferCommentVerification(identifiers, new CommentVerificationDeferred(delay));
      release();
      await stale;
      jest.setSystemTime(start + effectiveDelay + 1);
      if (path === 'event') await syncComment({ issue, comment: { id: '101' } });
      else await runRecoveryHeartbeat();
      expect(writes(mockFetch)).toHaveLength(0);
      expect(mockStore.has(pendingKey)).toBe(true);
      await syncComment({ issue, comment: { id: '101' } });
      expect(writes(mockFetch)).toHaveLength(0);
      expect(getFullComment).not.toHaveBeenCalled();
      jest.setSystemTime(Math.max(start + effectiveDelay + 30001, mockStore.get(pendingKey).notBefore + 1));
      getFullComment.mockResolvedValue({ ...safeComment(), visibility: { type: 'role', value: 'private' } });
      await runRecoveryHeartbeat();
      expect(getFullComment).toHaveBeenCalled();
      expect(writes(mockFetch)).toHaveLength(0);
      expect(mockStore.has(pendingKey)).toBe(false);
    } finally { release(); kvs.set.mockImplementation(original); }
  });

  test('final verification also blocks fallback when source becomes restricted after a parent rejection', async () => {
    getRemoteComment.mockImplementation(async (key, id) => ({ ...safeComment(id), ...(id === '101' ? { parentId: '100' } : {}) }));
    mockRequestJira.mockImplementationOnce(async () => {
      getRemoteComment.mockResolvedValue({ ...safeComment(), visibility: { type: 'group', value: 'private' } });
      return { ok: false, status: 400, json: async () => ({ errors: { parent: 'Parent comment does not exist' } }),
        text: async () => JSON.stringify({ errors: { parent: 'Parent comment does not exist' } }) };
    });
    const result = await processIncomingWebhook(payload({ id: '101' }), auth);
    expect(writes(mockRequestJira)).toHaveLength(1);
    expect(storeCommentMapping).not.toHaveBeenCalled();
    expect(result.body.code).toBe('COMMENT_REJECTED');
  });

  test('final verification rejects a catch-up comment restricted after listing', async () => {
    mockRequestJira.mockResolvedValue({ ok: true, json: async () => ({ comments: [safeComment()] }) });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ comments: [] }) });
    getFullComment.mockResolvedValue({ ...safeComment(), visibility: { type: 'role', value: 'private' } });
    await syncAllComments('LOCAL-1', 'REMOTE-1', issue, org, null, 'org-1');
    expect(writes(mockFetch)).toHaveLength(0);
  });

  test.each(['outbound', 'inbound'])('final verification rechecks %s visibility after initial verification', async direction => {
    const read = direction === 'outbound' ? getFullComment : getRemoteComment;
    read.mockResolvedValueOnce(safeComment()).mockResolvedValue({ ...safeComment(), visibility: { type: 'role', value: 'private' } });
    if (direction === 'outbound') await syncComment({ issue, comment: { id: '101' } });
    else await processIncomingWebhook(payload({ id: '101' }), auth);
    expect(writes(mockFetch)).toHaveLength(0);
    expect(writes(mockRequestJira)).toHaveLength(0);
  });
});
