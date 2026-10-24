import { createHmac } from 'crypto';
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
  createIfNotExists: jest.fn(async (key, value) => { if (mockStore.has(key)) throw Object.assign(new Error('conflict'), { code: 'KEY_ALREADY_EXISTS' }); mockStore.set(key, value); }),
  del: jest.fn(async key => { mockStore.delete(key); }),
  getSecret: jest.fn(async () => 'abcdefghijklmnop'),
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
  getAttachmentMapping: jest.fn(async () => '201'), storeAttachmentMapping: jest.fn(), removeAttachmentMapping: jest.fn(), storeAttachmentMappingHistory: jest.fn(),
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


jest.mock('../src/services/jira/attachment-client.js', () => ({
  ...jest.requireActual('../src/services/jira/attachment-client.js'),
  getAttachmentSettings: jest.fn(async () => ({ enabled: true, uploadLimit: 1000 })),
  getAttachmentMetadata: jest.fn(async () => ({ id: '42', filename: 'safe.pdf', mimeType: 'application/pdf', size: 4 })),
  downloadAttachmentContent: jest.fn(async () => Buffer.from('data')),
  uploadAttachmentContent: jest.fn(async () => ({ id: '77' }))
}));

import { processIncomingWebhook } from './helpers/signed-webhook.js';
import { handleRemoteIssueCreated } from '../src/services/sync/incoming-sync.js';
import { run as runWebhook } from '../src/webtriggers/incoming-webhook.js';
import { getFullIssue, getFullComment } from '../src/services/jira/local-client.js';
import { getRemoteIssue, getRemoteComment } from '../src/services/jira/remote-client.js';
import { getLocalKey, getLinkMapping, removeLinkMapping, getOrganizationsWithTokens } from '../src/services/storage/mappings.js';
import { transitionLocalIssue } from '../src/services/sync/transition-sync.js';
import { assertInboundScope } from '../src/services/sync/inbound-scope.js';
import { recoverCommentVerifications } from '../src/services/sync/comment-verification-recovery.js';
import { run as runRecoveryHeartbeat } from '../src/triggers/initial-sync-recovery.js';
import { getPilotPause } from '../src/services/sync/pilot-pause.js';
import * as kvs from '../src/services/storage/kvs.js';
import { uploadAttachmentContent } from '../src/services/jira/attachment-client.js';
import { storeMapping, getAttachmentMapping, storeAttachmentMapping } from '../src/services/storage/mappings.js';
import { syncComment } from '../src/services/sync/comment-sync.js';

const org = { id: 'org-1', name: 'Remote', remoteUrl: 'https://remote.atlassian.net', remoteEmail: 'sync@example.invalid',
  remoteApiToken: 'test-token', syncDirection: 'bidirectional', allowedProjects: ['LOCAL'], jqlFilter: '' };
const auth = { orgId: 'org-1', signingSecret: 'abcdefghijklmnop' };
const remote = { key: 'REMOTE-1', fields: { summary: 'Update', description: null, issuetype: { name: 'Task' }, status: { name: 'Open' }, labels: [] } };
let projects, scopeUnavailable, spies;
const writes = () => mockRequestJira.mock.calls.filter(([, o]) => ['POST','PUT','DELETE'].includes(o?.method));
const comment = { id: '101', body: 'Ordinary public comment', jsdPublic: true, properties: [] };
const event = type => ({ webhookEvent: type, issue: remote, comment });
const blocked = result => expect(result).toMatchObject({ status: 200, body: { code: 'INBOUND_SCOPE_BLOCKED' } });

beforeEach(() => {
  jest.clearAllMocks(); mockStore.clear(); mockStore.set('organizations', [{ ...org }]);
  mockStore.set('syncOptions:org-1', { syncComments: true, syncAttachments: true, propagateAttachmentDeletions: true });
  mockStore.set('syncOptions:org-2', { syncComments: true, syncAttachments: true, propagateAttachmentDeletions: true });
  projects = { 'LOCAL-1': 'LOCAL', 'LOCAL-2': 'LOCAL' }; scopeUnavailable = false;
  getLocalKey.mockImplementation(async key => key === 'REMOTE-2' ? 'LOCAL-2' : key === 'REMOTE-NEW' ? null : 'LOCAL-1');
  getOrganizationsWithTokens.mockResolvedValue([org]);
  getRemoteIssue.mockResolvedValue(remote); getFullComment.mockResolvedValue(comment); getRemoteComment.mockResolvedValue(comment);
  getLinkMapping.mockResolvedValue('synced');
  mockFetch.mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: '301', comments: [] }) });
  mockRequestJira.mockReset().mockImplementation(async (url, options = {}) => {
    if (['POST','PUT','DELETE'].includes(options.method)) return { ok: true, status: 201, json: async () => ({ id: '201', key: 'LOCAL-3' }) };
    if (scopeUnavailable) throw new Error('temporary read failure');
    const key = String(url).match(/issue\/(LOCAL-\d+)/)?.[1];
    return { ok: true, status: 200, json: async () => ({ key, fields: { project: { key: projects[key] }, status: { name: 'Open' },
      issuelinks: [{ id: '7', type: { name: 'Relates' }, outwardIssue: { key: 'LOCAL-2' } }] } }) };
  });
  getFullIssue.mockImplementation(jest.requireActual('../src/services/jira/local-client.js').getFullIssue);
  spies = ['log','warn','error'].map(method => jest.spyOn(console, method).mockImplementation(() => {}));
});
afterEach(() => spies.forEach(spy => spy.mockRestore()));

for (const type of ['jira:issue_updated','comment_created']) {
  test.each([['removed', ['OTHER']], ['empty', []], ['missing', undefined], ['malformed', 'LOCAL'], ['mixed malformed', ['LOCAL', null]]])(
    `%s configuration blocks mapped ${type}`, async (name, allowedProjects) => {
      mockStore.set('organizations', [{ ...org, allowedProjects }]);
      const result = await processIncomingWebhook(event(type), auth);
      expect(writes()).toHaveLength(0); blocked(result);
      expect(mockStore.get('organizations')[0].allowedProjects).toEqual(allowedProjects);
    });
  test(`allowed project preserves ${type}`, async () => {
    const result = await processIncomingWebhook(event(type), auth);
    expect(result.status).toBe(200); expect(writes()).toHaveLength(1);
  });
  test(`authoritative moved project blocks ${type} despite old LOCAL key`, async () => {
    projects['LOCAL-1'] = 'OTHER';
    blocked(await processIncomingWebhook(event(type), auth)); expect(writes()).toHaveLength(0);
  });
  test(`temporary scope read failure is retryable for ${type}`, async () => {
    scopeUnavailable = true;
    expect(await processIncomingWebhook(event(type), auth)).toMatchObject({ status: 503, body: { code: 'INBOUND_SCOPE_UNVERIFIABLE' } });
    expect(writes()).toHaveLength(0);
    expect(Array.from(mockStore).filter(([key]) => key.startsWith('webhook-replay:')).some(([, value]) => value.state === 'completed')).toBe(false);
  });
}

test('current organization config is rechecked after comment verification', async () => {
  getRemoteComment.mockImplementation(async () => { mockStore.set('organizations', [{ ...org, allowedProjects: [] }]); return comment; });
  blocked(await processIncomingWebhook(event('comment_created'), auth)); expect(writes()).toHaveLength(0);
});

test('dispatcher enforces current scope for pre-existing mappings', async () => {
  projects['LOCAL-1'] = 'OTHER';
  const result = await runWebhook({ method: 'POST', headers: { 'Content-Type': ['application/json'], 'X-Hub-Signature': [`sha256=${createHmac('sha256', auth.signingSecret).update(JSON.stringify(event('comment_created')), 'utf8').digest('hex')}`] }, queryParameters: {},
    userPath: '/signed/org-1', body: JSON.stringify(event('comment_created')) });
  expect(result.statusCode).toBe(200); expect(JSON.parse(result.body).code).toBe('INBOUND_SCOPE_BLOCKED'); expect(writes()).toHaveLength(0);
});

test.each(['issuelink_created','issuelink_deleted'])('both endpoints must authorize %s', async type => {
  projects['LOCAL-2'] = 'OTHER';
  const payload = { webhookEvent: type, issueLink: { outwardIssue: { key: 'REMOTE-1' }, inwardIssue: { key: 'REMOTE-2' }, type: { name: 'Relates' } } };
  blocked(await processIncomingWebhook(payload, auth)); expect(writes()).toHaveLength(0); expect(removeLinkMapping).not.toHaveBeenCalled();
});

test.each(['attachment_created','attachment_deleted','jira:issue_deleted'])('%s cannot modify a disallowed mapped issue', async type => {
  projects['LOCAL-1'] = 'OTHER';
  blocked(await processIncomingWebhook({ ...event(type), attachment: { id: '101' } }, auth)); expect(writes()).toHaveLength(0);
});

test('disallowed related parent blocks field, transition and secondary link writes', async () => {
  projects['LOCAL-2'] = 'OTHER';
  const issue = { ...remote, fields: { ...remote.fields, parent: { key: 'REMOTE-2' },
    issuelinks: [{ type: { name: 'Relates' }, outwardIssue: { key: 'REMOTE-2' } }] } };
  getRemoteIssue.mockResolvedValue(issue);
  blocked(await processIncomingWebhook({ webhookEvent: 'jira:issue_updated', issue }, auth));
  expect(writes()).toHaveLength(0); expect(transitionLocalIssue).not.toHaveBeenCalled();
});

test('organizations are scoped independently', async () => {
  mockStore.set('organizations', [{ ...org, allowedProjects: [] }, { ...org, id: 'org-2' }]);
  blocked(await processIncomingWebhook(event('comment_created'), auth));
  expect((await processIncomingWebhook(event('comment_created'), { ...auth, orgId: 'org-2' })).status).toBe(200);
  expect(writes()).toHaveLength(1);
});

test('authorized outbound comments retain their existing behavior', async () => {
  await syncComment({ issue: { key: 'LOCAL-1' }, comment: { id: '101' } });
  expect(mockFetch.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1);
});

test('new issue creation rechecks target project before submission', async () => {
  getRemoteIssue.mockImplementation(async () => { mockStore.set('organizations', [{ ...org, allowedProjects: [] }]); return { ...remote, key: 'REMOTE-NEW' }; });
  blocked(await processIncomingWebhook({ webhookEvent: 'jira:issue_created', issue: { key: 'REMOTE-NEW' } }, auth));
  expect(writes()).toHaveLength(0);
});

test('a mapped destination moved into an allowed project is authorized despite its old key', async () => {
  mockStore.set('organizations', [{ ...org, allowedProjects: ['OTHER'] }]);
  projects['LOCAL-1'] = 'OTHER';
  expect((await processIncomingWebhook(event('comment_created'), auth)).status).toBe(200);
  expect(writes()).toHaveLength(1);
});

test('blocked delivery retains its mapping and a later delivery can use reauthorized scope', async () => {
  mockStore.set('organizations', [{ ...org, allowedProjects: [] }]);
  blocked(await processIncomingWebhook(event('comment_created'), auth));
  mockStore.set('organizations', [org]);
  const result = await processIncomingWebhook(event('comment_created'), auth);
  expect(result.body.code).toBe('COMMENT_SYNCED'); expect(writes()).toHaveLength(1);
});

test('a temporary comment scope failure remains durably recoverable with no write-started guard', async () => {
  scopeUnavailable = true;
  const result = await processIncomingWebhook(event('comment_created'), auth);
  expect(result.status).toBe(503);
  expect(mockStore.get('comment-verification:remote-to-local:org-1:REMOTE-1:101')).toMatchObject({ attempts: 0 });
  expect(Array.from(mockStore).some(([key]) => key.startsWith('comment-verification-submission:'))).toBe(false);
  scopeUnavailable = false;
  jest.useFakeTimers();
  try {
    const key = 'comment-verification:remote-to-local:org-1:REMOTE-1:101';
    jest.setSystemTime(mockStore.get(key).notBefore + 1);
    await recoverCommentVerifications(() => processIncomingWebhook(event('comment_created'), auth));
    expect(writes()).toHaveLength(1);
    expect(mockStore.has(key)).toBe(false);
  } finally { jest.useRealTimers(); }
});

test('transitions recheck the allow-list immediately before their POST', async () => {
  const actual = jest.requireActual('../src/services/sync/transition-sync.js');
  const transport = mockRequestJira.getMockImplementation();
  mockRequestJira.mockImplementation(async (url, options) => {
    if (url.endsWith('/transitions') && options?.method === 'GET') {
      mockStore.set('organizations', [{ ...org, allowedProjects: [] }]);
      return { ok: true, json: async () => ({ transitions: [{ id: '31', to: { id: '3', name: 'Done' } }] }) };
    }
    return transport(url, options);
  });
  await expect(actual.transitionLocalIssue('LOCAL-1', { name: 'Done' }, {}, null, { orgId: 'org-1' }))
    .rejects.toMatchObject({ code: 'INBOUND_SCOPE_BLOCKED' });
  expect(writes()).toHaveLength(0);
});

test('replacement creation cannot use a stale target-project configuration', async () => {
  const context = { org, orgId: 'org-1', mappings: { userMappings: {}, fieldMappings: {}, statusMappings: {}, issueTypeMappings: {} }, syncOptions: {} };
  mockStore.set('organizations', [{ ...org, allowedProjects: [] }]);
  await expect(handleRemoteIssueCreated(remote, context, { replacementOfLocalKey: 'LOCAL-1', operationSuffix: 'replacement' }))
    .rejects.toMatchObject({ code: 'INBOUND_SCOPE_BLOCKED' });
  expect(writes()).toHaveLength(0);
});

test('existing mapped inbound updates preserve the documented source-JQL distinction', async () => {
  mockStore.set('organizations', [{ ...org, jqlFilter: 'status = "Open"' }]);
  expect((await processIncomingWebhook(event('jira:issue_updated'), auth)).status).toBe(200);
  expect(writes()).toHaveLength(1);
  expect(mockRequestJira.mock.calls.some(([url]) => String(url).includes('/search'))).toBe(false);
});

test.each([null, {}, false, ['LOCAL']])('malformed JQL configuration fails closed: %p', async jqlFilter => {
  mockStore.set('organizations', [{ ...org, jqlFilter }]);
  blocked(await processIncomingWebhook(event('comment_created'), auth)); expect(writes()).toHaveLength(0);
});

test('replacement cannot reroute a disallowed existing destination into another allowed project', async () => {
  const context = { org: { ...org, allowedProjects: ['OTHER'] }, orgId: 'org-1', mappings: { userMappings: {}, fieldMappings: {}, statusMappings: {}, issueTypeMappings: {} }, syncOptions: {} };
  mockStore.set('organizations', [{ ...org, allowedProjects: ['OTHER'] }]);
  await expect(handleRemoteIssueCreated(remote, context, { replacementOfLocalKey: 'LOCAL-1', operationSuffix: 'replacement' }))
    .rejects.toMatchObject({ code: 'INBOUND_SCOPE_BLOCKED' });
  expect(writes()).toHaveLength(0);
});

test('new unmapped creation without allowed projects returns a definitive block', async () => {
  mockStore.set('organizations', [{ ...org, allowedProjects: [] }]);
  blocked(await processIncomingWebhook({ webhookEvent: 'jira:issue_created', issue: { key: 'REMOTE-NEW' } }, auth));
  expect(writes()).toHaveLength(0);
});

test('detaching an out-of-scope current parent blocks hierarchy and secondary writes', async () => {
  projects['LOCAL-2'] = 'OTHER';
  const actualRead = getFullIssue.getMockImplementation();
  getFullIssue.mockImplementation(async key => {
    const issue = await actualRead(key);
    return key === 'LOCAL-1' ? { ...issue, fields: { ...issue.fields, parent: { key: 'LOCAL-2' } } } : issue;
  });
  const issue = { ...remote, fields: { ...remote.fields, parent: null } };
  getRemoteIssue.mockResolvedValue(issue);
  blocked(await processIncomingWebhook({ webhookEvent: 'jira:issue_updated', issue }, auth));
  expect(writes()).toHaveLength(0);
});


test('scope reads have a bounded wait and remain retryable without local writes', async () => {
  jest.useFakeTimers();
  try {
    getFullIssue.mockImplementation(() => new Promise(() => {}));
    const result = assertInboundScope({ orgId: 'org-1', issueKeys: ['LOCAL-1'] });
    const assertion = expect(result).rejects.toMatchObject({ code: 'INBOUND_SCOPE_UNVERIFIABLE', retryable: true });
    await jest.advanceTimersByTimeAsync(4000);
    await assertion;
    expect(writes()).toHaveLength(0);
  } finally { jest.useRealTimers(); }
});

test('configuration changes during an authoritative destination read fail closed', async () => {
  const actualRead = getFullIssue.getMockImplementation();
  getFullIssue.mockImplementation(async key => {
    const issue = await actualRead(key);
    mockStore.set('organizations', [{ ...org, allowedProjects: ['OTHER'] }]);
    return issue;
  });
  await expect(assertInboundScope({ orgId: 'org-1', issueKeys: ['LOCAL-1'] }))
    .rejects.toMatchObject({ code: 'INBOUND_SCOPE_UNVERIFIABLE', reason: 'SCOPE_CHANGED' });
  expect(writes()).toHaveLength(0);
});


describe('F03 independent review corrections', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-23T12:00:00Z')); });
  afterEach(() => {
    jest.useRealTimers(); storeMapping.mockReset(); getAttachmentMapping.mockResolvedValue('201');
    getPilotPause.mockResolvedValue({ paused: false });
    jest.requireMock('../src/services/storage/mappings.js').getRemoteKey.mockResolvedValue('REMOTE-1');
  });

  test('finding 1: scope deferral preserves webhook parent through production heartbeat', async () => {
    scopeUnavailable = true;
    const payload = { ...event('comment_created'), comment: { ...comment, parentId: '100' } };
    expect((await processIncomingWebhook(payload, auth)).status).toBe(503);
    scopeUnavailable = false;
    getRemoteComment.mockImplementation(async (key, id) => id === '101' ? comment
      : { ...comment, id: '100', visibility: { type: 'role', value: 'private' } });
    jest.setSystemTime(Date.now() + 61000);
    await runRecoveryHeartbeat();
    expect(writes()).toHaveLength(0);
    expect(getRemoteComment.mock.calls.map(([, id]) => id)).toEqual(['101', '100']);
    const record = mockStore.get('comment-verification:remote-to-local:org-1:REMOTE-1:101');
    if (record) expect(JSON.stringify(record)).not.toContain('Ordinary public comment');
  });

  test('finding 2: replacement rechecks original project after remote read revokes it', async () => {
    projects['LOCAL-1'] = 'OTHER';
    const current = { ...org, allowedProjects: ['LOCAL', 'OTHER'] };
    mockStore.set('organizations', [current]);
    getRemoteIssue.mockImplementation(async () => {
      mockStore.set('organizations', [{ ...org, allowedProjects: ['LOCAL'] }]); return remote;
    });
    const context = { org: current, orgId: 'org-1', mappings: { userMappings: {}, fieldMappings: {}, statusMappings: {}, issueTypeMappings: {} }, syncOptions: {} };
    let result;
    try { result = await handleRemoteIssueCreated(remote, context, { replacementOfLocalKey: 'LOCAL-1' }); }
    catch (error) { result = error; }
    expect(writes()).toHaveLength(0);
    expect(result.code).toBe('INBOUND_SCOPE_BLOCKED');
  });

  async function createWithDeferredAttachment() {
    let mapped = null;
    getLocalKey.mockImplementation(async () => mapped);
    getRemoteKeyForCreate();
    storeMapping.mockImplementation(async localKey => { mapped = localKey; scopeUnavailable = true; });
    getAttachmentMapping.mockResolvedValue(null);
    const issue = { ...remote, key: 'REMOTE-9', fields: { ...remote.fields, attachment: [{ id: '42' }] } };
    getRemoteIssue.mockResolvedValue(issue);
    const payload = { webhookEvent: 'jira:issue_created', issue };
    expect((await processIncomingWebhook(payload, auth)).status).toBe(503);
    expect(writes().filter(([url]) => url === '/rest/api/3/issue')).toHaveLength(1);
    scopeUnavailable = false;
    return payload;
  }
  function getRemoteKeyForCreate() {
    jest.requireMock('../src/services/storage/mappings.js').getRemoteKey.mockResolvedValue('REMOTE-9');
    projects['LOCAL-3'] = 'LOCAL';
  }

  test('finding 3: redelivery resumes post-create attachment without recreating the issue', async () => {
    const payload = await createWithDeferredAttachment();
    await processIncomingWebhook(payload, auth);
    expect(uploadAttachmentContent).toHaveBeenCalledTimes(1);
    expect(storeAttachmentMapping).toHaveBeenCalled();
    expect(writes().filter(([url]) => url === '/rest/api/3/issue')).toHaveLength(1);
  });

  test('finding 3: heartbeat recovers post-create attachment without webhook redelivery', async () => {
    await createWithDeferredAttachment();
    jest.setSystemTime(Date.now() + 61000);
    await runRecoveryHeartbeat();
    expect(uploadAttachmentContent).toHaveBeenCalledTimes(1);
    expect(writes().filter(([url]) => url === '/rest/api/3/issue')).toHaveLength(1);
  });

  test('finding 1: final scope deferral retains REST-discovered grandparent constraints', async () => {
    let childReads = 0;
    getRemoteComment.mockImplementation(async (key, id) => {
      if (id === '101') { childReads++; return { ...comment, parentId: '100' }; }
      if (id === '100') return { ...comment, id, parentId: '99' };
      if (childReads === 2) scopeUnavailable = true;
      return { ...comment, id };
    });
    expect((await processIncomingWebhook(event('comment_created'), auth)).status).toBe(503);
    const record = mockStore.get('comment-verification:remote-to-local:org-1:REMOTE-1:101');
    expect(record.ancestry).toContainEqual(['100', '99']);
    expect(JSON.stringify(record)).not.toContain('Ordinary public comment');
    scopeUnavailable = false;
    getRemoteComment.mockClear().mockImplementation(async (key, id) => ({ ...comment, id,
      ...(id === '99' ? { visibility: { type: 'role', value: 'private' } } : {}) }));
    jest.setSystemTime(Date.now() + 61000);
    await runRecoveryHeartbeat();
    expect(getRemoteComment.mock.calls.map(([, id]) => id)).toEqual(['101', '100', '99']);
    expect(writes()).toHaveLength(0);
  });

  test('finding 1: transient final ancestor read retains newly discovered ancestry', async () => {
    let childReads = 0;
    getRemoteComment.mockImplementation(async (key, id) => {
      if (id === '101') { childReads++; return { ...comment, parentId: '100' }; }
      if (id === '100') return { ...comment, id, ...(childReads === 2 ? { parentId: '99' } : {}) };
      throw Object.assign(new Error('Temporary ancestor read failure'), { code: 'COMMENT_VERIFICATION_DEFERRED' });
    });
    expect((await processIncomingWebhook(event('comment_created'), auth)).status).toBe(202);
    const record = mockStore.get('comment-verification:remote-to-local:org-1:REMOTE-1:101');
    expect(record.ancestry).toContainEqual(['100', '99']);
    getRemoteComment.mockClear().mockImplementation(async (key, id) => ({ ...comment, id,
      ...(id === '99' ? { visibility: { type: 'role', value: 'private' } } : {}) }));
    jest.setSystemTime(Date.now() + 61000);
    await runRecoveryHeartbeat();
    expect(getRemoteComment.mock.calls.map(([, id]) => id)).toEqual(['101', '100', '99']);
    expect(writes()).toHaveLength(0);
  });

  test('finding 1: conflicting ancestry cannot become a parentless deferred job', async () => {
    scopeUnavailable = true;
    const result = await processIncomingWebhook({ ...event('comment_created'), comment: { ...comment, parentId: '100', parentCommentId: '99' } }, auth);
    expect(result.body.code).toBe('COMMENT_REJECTED');
    expect(mockStore.has('comment-verification:remote-to-local:org-1:REMOTE-1:101')).toBe(false);
    expect(writes()).toHaveLength(0);
  });

  test('finding 2: original authorization remains mandatory at the final write boundary', async () => {
    projects['LOCAL-1'] = 'OTHER';
    const current = { ...org, allowedProjects: ['LOCAL', 'OTHER'] };
    mockStore.set('organizations', [current]);
    const original = kvs.set.getMockImplementation();
    kvs.set.mockImplementation(async (key, value) => {
      await original(key, value);
      if (key.startsWith('issue-create-op:') && value.submissionStartedAt) mockStore.set('organizations', [org]);
    });
    try {
      const context = { org: current, orgId: 'org-1', mappings: { userMappings: {}, fieldMappings: {}, statusMappings: {}, issueTypeMappings: {} }, syncOptions: {} };
      let result;
      try { result = await handleRemoteIssueCreated(remote, context, { replacementOfLocalKey: 'LOCAL-1' }); }
      catch (error) { result = error; }
      expect(writes()).toHaveLength(0);
      expect(result.code).toBe('INBOUND_SCOPE_BLOCKED');
    } finally { kvs.set.mockImplementation(original); }
  });

  test('finding 2: temporary original-project read failure remains retryable', async () => {
    const current = { ...org, allowedProjects: ['LOCAL', 'OTHER'] };
    mockStore.set('organizations', [current]);
    getRemoteIssue.mockImplementation(async () => { scopeUnavailable = true; return remote; });
    const context = { org: current, orgId: 'org-1', mappings: { userMappings: {}, fieldMappings: {}, statusMappings: {}, issueTypeMappings: {} }, syncOptions: {} };
    await expect(handleRemoteIssueCreated(remote, context, { replacementOfLocalKey: 'LOCAL-1' }))
      .rejects.toMatchObject({ code: 'INBOUND_SCOPE_UNVERIFIABLE', retryable: true });
    expect(writes()).toHaveLength(0);
  });

  test('finding 3: duplicate delivery and heartbeat cannot duplicate a completed attachment', async () => {
    const payload = await createWithDeferredAttachment();
    await processIncomingWebhook(payload, auth);
    await processIncomingWebhook(payload, auth);
    await runRecoveryHeartbeat();
    expect(uploadAttachmentContent).toHaveBeenCalledTimes(1);
    expect(writes().filter(([url]) => url === '/rest/api/3/issue')).toHaveLength(1);
  });

  test('finding 3: ambiguous attachment submission is retained for attention, never replayed', async () => {
    const payload = await createWithDeferredAttachment();
    uploadAttachmentContent.mockRejectedValueOnce(new Error('connection reset after submission'));
    await runRecoveryHeartbeat();
    await processIncomingWebhook(payload, auth);
    await runRecoveryHeartbeat();
    expect(uploadAttachmentContent).toHaveBeenCalledTimes(1);
    expect(Array.from(mockStore.keys()).some(key => key.startsWith('post-create-attachment-attention:'))).toBe(true);
    expect(writes().filter(([url]) => url === '/rest/api/3/issue')).toHaveLength(1);
  });

  test('finding 3: pause preserves work and restoration resumes it safely', async () => {
    await createWithDeferredAttachment();
    getPilotPause.mockResolvedValue({ paused: true });
    await runRecoveryHeartbeat();
    expect(uploadAttachmentContent).not.toHaveBeenCalled();
    expect(Array.from(mockStore.keys()).some(key => key.startsWith('post-create-attachment:'))).toBe(true);
    getPilotPause.mockResolvedValue({ paused: false });
    await runRecoveryHeartbeat();
    expect(uploadAttachmentContent).toHaveBeenCalledTimes(1);
  });

  test('finding 3: permanently revoked scope exhausts into durable attention without uploads', async () => {
    await createWithDeferredAttachment();
    mockStore.set('organizations', [{ ...org, allowedProjects: [] }]);
    for (let i = 0; i < 7; i++) { jest.setSystemTime(Date.now() + 3600000); await runRecoveryHeartbeat(); }
    expect(uploadAttachmentContent).not.toHaveBeenCalled();
    expect(Array.from(mockStore.keys()).some(key => key.startsWith('post-create-attachment-attention:'))).toBe(true);
    expect(Array.from(mockStore.keys()).some(key => key.startsWith('post-create-attachment:'))).toBe(false);
  });

  test('finding 3: temporarily revoked scope can resume after permissions are restored', async () => {
    await createWithDeferredAttachment();
    mockStore.set('organizations', [{ ...org, allowedProjects: [] }]);
    await runRecoveryHeartbeat();
    expect(uploadAttachmentContent).not.toHaveBeenCalled();
    mockStore.set('organizations', [org]);
    await runRecoveryHeartbeat();
    expect(uploadAttachmentContent).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(Array.from(mockStore).filter(([key]) => key.startsWith('post-create-attachment')))).not.toContain('test-token');
  });


  test('finding 1: conflicting hints quarantine an already deferred job', async () => {
    scopeUnavailable = true;
    await processIncomingWebhook({ ...event('comment_created'), comment: { ...comment, parentId: '100' } }, auth);
    expect(mockStore.has('comment-verification:remote-to-local:org-1:REMOTE-1:101')).toBe(true);
    const result = await processIncomingWebhook({ ...event('comment_created'), comment: { ...comment, parentId: '100', parentCommentId: '99' } }, auth);
    expect(result.body.code).toBe('COMMENT_REJECTED');
    scopeUnavailable = false;
    jest.setSystemTime(Date.now() + 61000);
    await runRecoveryHeartbeat();
    expect(writes()).toHaveLength(0);
    expect(mockStore.get('comment-verification-attention:remote-to-local:org-1:REMOTE-1:101').reason).toBe('COMMENT_ANCESTRY_REJECTED');
  });

  test('finding 3: overlapping recovery and redelivery submit an attachment once', async () => {
    const payload = await createWithDeferredAttachment();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    uploadAttachmentContent.mockImplementationOnce(() => held);
    const worker = runRecoveryHeartbeat();
    for (let i = 0; i < 300 && !uploadAttachmentContent.mock.calls.length; i++) await Promise.resolve();
    expect(uploadAttachmentContent).toHaveBeenCalledTimes(1);
    await processIncomingWebhook(payload, auth);
    release({ id: '77' });
    await worker;
    await runRecoveryHeartbeat();
    expect(uploadAttachmentContent).toHaveBeenCalledTimes(1);
    expect(writes().filter(([url]) => url === '/rest/api/3/issue')).toHaveLength(1);
  });

});
