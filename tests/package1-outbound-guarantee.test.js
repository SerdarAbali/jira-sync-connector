// The synchronization authorization gate has its own suite; this suite tests another behaviour.
jest.mock('../src/services/sync/sync-authorization.js', () => require('./helpers/authorized-sync-authorization.js'));

/** Production entry points and services; only platform storage/HTTP are modelled. */
const mockStore = new Map();
const mockCommentMaps = new Map();
const mockAttachmentMaps = new Map();
const mockQueuePush = jest.fn();
jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  return { __esModule: true, default: { asApp: () => ({ requestJira }) },
    route: (s, ...v) => s.reduce((a, p, i) => a + p + (v[i] ?? ''), ''), fetch: jest.fn() };
});
jest.mock('@forge/events', () => ({ Queue: jest.fn(() => ({ push: mockQueuePush })) }));
jest.mock('../src/services/storage/kvs.js', () => {
  const create = jest.fn(async (key, value) => {
    if (mockStore.has(key)) throw Object.assign(new Error('exists'), { code: 'KEY_ALREADY_EXISTS' });
    mockStore.set(key, value);
  });
  return { get: jest.fn(async key => mockStore.get(key) ?? null),
    set: jest.fn(async (key, value) => { mockStore.set(key, value); }),
    del: jest.fn(async key => { mockStore.delete(key); }),
    createIfNotExists: create, setIfNotExists: create,
    getSecret: jest.fn(async () => 'test-only'),
    queryByPrefix: jest.fn(async prefix => [...mockStore].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value }))) };
});
jest.mock('../src/services/storage/mappings.js', () => ({
  isValidIssueKey: jest.requireActual('../src/services/storage/mappings.js').isValidIssueKey,
  getOrganizationsWithTokens: jest.fn(), getRemoteKey: jest.fn(), getLocalKey: jest.fn(),
  getRemoteCommentId: jest.fn(async id => mockCommentMaps.get(id) ?? null),
  storeCommentMapping: jest.fn(async (id, remote) => { mockCommentMaps.set(id, remote); }),
  getAttachmentMapping: jest.fn(async (id, org, direction) => mockAttachmentMaps.get(`${direction}:${id}`) ?? null),
  storeAttachmentMapping: jest.fn(async (id, remote, org, direction) => { mockAttachmentMaps.set(`${direction}:${id}`, remote); }),
  removeAttachmentMapping: jest.fn(), storeAttachmentMappingHistory: jest.fn(),
  getLinkMapping: jest.fn(async () => null), storeLinkMapping: jest.fn(), removeLinkMapping: jest.fn(),
  storeMapping: jest.fn(), replaceIssueMapping: jest.fn(), setLastSyncedLocalUpdated: jest.fn(),
  getLastSyncedLocalUpdated: jest.fn(async () => null)
}));
jest.mock('../src/services/storage/stats.js', () => ({
  trackApiCall: jest.fn(), trackWebhookSync: jest.fn(), logAuditEntry: jest.fn()
}));
jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn(), getFullComment: jest.fn(), getOrgName: jest.fn(async () => 'Local'),
  updateLocalIssueDescription: jest.fn(), probeLocalIssue: jest.fn()
}));
jest.mock('../src/services/jira/remote-client.js', () => ({ getRemoteIssue: jest.fn(), probeRemoteIssue: jest.fn() }));
jest.mock('../src/services/jira/attachment-client.js', () => ({
  ...jest.requireActual('../src/services/jira/attachment-client.js'),
  getAttachmentMetadata: jest.fn(), getAttachmentSettings: jest.fn(), getIssueAttachments: jest.fn(),
  downloadAttachmentContent: jest.fn(), uploadAttachmentContent: jest.fn(), deleteAttachmentContent: jest.fn()
}));

import api, { fetch } from '@forge/api';
import * as storage from '../src/services/storage/kvs.js';
import * as mappings from '../src/services/storage/mappings.js';
import { getFullIssue, getFullComment } from '../src/services/jira/local-client.js';
import { getRemoteIssue } from '../src/services/jira/remote-client.js';
import * as attachments from '../src/services/jira/attachment-client.js';
import { syncComment, syncAllComments } from '../src/services/sync/comment-sync.js';
import { run as commentTrigger } from '../src/triggers/comment.js';
import { run as attachmentTrigger } from '../src/triggers/attachment.js';
import { run as linkDeleted } from '../src/triggers/link-deleted.js';
import { run as linkCreated } from '../src/triggers/link.js';
import { run as issueDeleted } from '../src/triggers/issue-deleted.js';
import { run as issueTrigger } from '../src/triggers/issue.js';
import { syncAttachments, runAttachmentSyncQueue, propagateAttachmentDeletion } from '../src/services/sync/attachment-sync.js';
import { syncIssueLinks } from '../src/services/sync/link-sync.js';
import { createRemoteIssue, updateRemoteIssue, processPendingLinksForNewlySyncedIssue } from '../src/services/sync/issue-sync.js';
import { retryAllPendingLinks, performScheduledSync } from '../src/services/scheduled/scheduled-sync.js';
import { setCounterpartNotice, clearCounterpartNotice } from '../src/services/sync/counterpart-probe.js';
import { transitionRemoteIssue } from '../src/services/sync/transition-sync.js';
import { defineSyncResolvers } from '../src/resolvers/sync.js';
import { run as recoveryHeartbeat } from '../src/triggers/initial-sync-recovery.js';
import { run as initialConsumer } from '../src/triggers/initial-sync.js';
import { previewInitialSync, startInitialSync, getInitialSyncJob, pauseInitialSync, resumeInitialSync } from '../src/services/sync/initial-sync.js';
import { runDueReconciliations, getReconciliationJob } from '../src/services/sync/source-reconciliation.js';
import { getAttachmentOperation } from '../src/services/sync/attachment-operation.js';
import { inspectCommentSubmission } from '../src/services/sync/comment-submission.js';
import { prependCounterpartNoticeToADF } from '../src/utils/adf.js';

const request = api.asApp().requestJira;
const org = { id: 'org-1', allowedProjects: ['LOCAL'], jqlFilter: 'labels = selected',
  remoteUrl: 'https://remote.atlassian.net', remoteEmail: 'test@example.invalid', remoteApiToken: 'test-only',
  remoteProjectKey: 'REMOTE', syncDirection: 'bidirectional' };
const opts = { syncComments: false, syncAttachments: false, syncLinks: false, syncCrossReference: false };
const attachmentOpts = { syncAttachments: true, propagateAttachmentDeletions: true };
const fieldMappings = { userMappings: {}, fieldMappings: {}, statusMappings: {}, issueTypeMappings: {} };
const doc = { type: 'doc', version: 1, content: [] };
const issue = key => ({ id: key === 'LOCAL-2' ? '10002' : '10001', key,
  fields: { project: { key: 'LOCAL', projectTypeKey: 'software' }, summary: 'Source',
    description: doc, issuetype: { id: '1', name: 'Task' }, updated: '2026-10-24T01:00:00.000Z',
    status: { name: 'In Progress' }, labels: [], attachment: [{ id: '42' }], issuelinks: [] } });
const linkedIssue = () => ({ ...issue('LOCAL-1'), fields: { ...issue('LOCAL-1').fields,
  issuelinks: [{ id: '7', type: { name: 'Blocks', outward: 'blocks' }, outwardIssue: { key: 'LOCAL-2' } }] } });
const comment = (id = '101') => ({ id, body: `Content ${id}`, jsdPublic: true, properties: [], author: { displayName: 'User' } });
const ok = value => ({ ok: true, status: 200, json: async () => value, text: async () => '' });
let eligible, searchMode, searchHook, transportHook, spies, resolvers, listResults;
const scope = { orgId: 'org-1', issueKey: 'LOCAL-1', commentId: '101', remoteKey: 'REMOTE-1' };
const mutationCount = () => fetch.mock.calls.filter(([, o]) => ['POST', 'PUT', 'DELETE'].includes(o?.method)).length
  + attachments.uploadAttachmentContent.mock.calls.length + attachments.deleteAttachmentContent.mock.calls.length;
const settle = promise => promise.catch(error => ({ error }));
function seedPending() {
  const pending = [{ linkId: '7', linkedIssueKey: 'LOCAL-2', direction: 'outward', linkTypeName: 'Blocks', orgId: org.id }];
  mockStore.set('pending-links:LOCAL-1', pending); mockStore.set('pending-link-idx:LOCAL-1', pending);
}
async function pendingNew() { seedPending(); return processPendingLinksForNewlySyncedIssue('LOCAL-2', 'REMOTE-2', org, org.id); }
function seedRecovery() {
  mockStore.set('comment-verification:local-to-remote:org-1:LOCAL-1:101', {
    orgId: org.id, direction: 'local-to-remote', issueKey: 'LOCAL-1', commentId: '101',
    createdAt: Date.now() - 1000, attempts: 0, notBefore: 0
  });
}

beforeEach(() => {
  jest.clearAllMocks(); mockStore.clear(); mockCommentMaps.clear(); mockAttachmentMaps.clear();
  require('./helpers/forge-lease-runtime').state.basicStore = mockStore;
  listResults = []; eligible = new Set(['LOCAL-1', 'LOCAL-2']); searchMode = 'normal'; searchHook = null; transportHook = null;
  mockStore.set('organizations', [{ ...org }]); mockStore.set('syncOptions:org-1', opts);
  mockStore.set('scheduledSyncConfig', { enabled: true, syncScope: 'all' });
  mappings.getOrganizationsWithTokens.mockImplementation(async () => mockStore.get('organizations'));
  mappings.getRemoteKey.mockImplementation(async key => key?.startsWith('LOCAL-') ? key.replace('LOCAL-', 'REMOTE-') : null);
  mappings.getLocalKey.mockImplementation(async key => key?.startsWith('REMOTE-') ? key.replace('REMOTE-', 'LOCAL-') : null);
  getFullIssue.mockImplementation(async key => issue(key));
  getFullComment.mockImplementation(async (_, id) => comment(id));
  getRemoteIssue.mockResolvedValue({ key: 'REMOTE-1', fields: { summary: 'Old', description: doc, status: { name: 'To Do' } } });
  attachments.getAttachmentSettings.mockResolvedValue({ enabled: true, uploadLimit: 100000 });
  attachments.getAttachmentMetadata.mockResolvedValue({ id: '42', filename: 'file.txt', mimeType: 'text/plain', size: 4 });
  attachments.getIssueAttachments.mockResolvedValue([]);
  attachments.downloadAttachmentContent.mockResolvedValue(Buffer.from('data'));
  attachments.uploadAttachmentContent.mockResolvedValue({ id: '99' });
  attachments.deleteAttachmentContent.mockResolvedValue({ alreadyDeleted: false });
  request.mockImplementation(async (path, options) => {
    if (String(path).includes('/search/jql')) {
      const key = JSON.parse(options.body).jql.match(/key = "([^"]+)"/)?.[1];
      if (searchHook) await searchHook(key, options);
      if (searchMode === 'error') throw new Error('search unavailable');
      if (searchMode === 'incomplete') return ok({ issues: [], isLast: false });
      return ok({ issues: key ? (eligible.has(key) ? [{ key }] : []) : listResults, isLast: true });
    }
    if (String(path).includes('/comment')) return ok({ comments: [comment()] });
    return ok(issue(String(path).includes('10002') ? 'LOCAL-2' : 'LOCAL-1'));
  });
  fetch.mockImplementation(async (url, options) => {
    if (transportHook) await transportHook(url, options);
    if (options?.method === 'POST' && url.includes('/comment')) return ok({ id: '202' });
    if (options?.method === 'POST' && url.includes('/issue?')) return ok({ id: '20001', key: 'REMOTE-1' });
    if (url.includes('/transitions')) return ok({ transitions: [{ id: '1', to: { id: '2', name: 'In Progress' } }] });
    return ok({ fields: { description: doc, status: { name: 'To Do' }, issuelinks: [
      { id: '77', type: { name: 'Blocks' }, outwardIssue: { key: 'REMOTE-2' } }
    ] } });
  });
  resolvers = {}; defineSyncResolvers({ define: (name, fn) => { resolvers[name] = fn; } });
  spies = ['log', 'warn', 'error'].map(name => jest.spyOn(console, name).mockImplementation(() => {}));
});
afterEach(() => spies.forEach(spy => spy.mockRestore()));

const operations = [
  ['comment webhook', () => { mockStore.set('syncOptions:org-1', { syncComments: true }); return commentTrigger({ issue: issue('LOCAL-1'), comment: { id: '101' } }); }],
  ['reply', () => { mockStore.set('syncOptions:org-1', { syncComments: true }); getFullComment.mockImplementation(async (_, id) => ({ ...comment(id), ...(id === '101' ? { parentId: '100' } : {}) })); return syncComment({ issue: issue('LOCAL-1'), comment: { id: '101', parentId: '100' } }); }],
  ['comment catch-up', () => syncAllComments('LOCAL-1', 'REMOTE-1', issue('LOCAL-1'), org, null, org.id)],
  ['comment recovery', async () => { mockStore.set('syncOptions:org-1', { syncComments: true }); seedRecovery(); return recoveryHeartbeat(); }],
  ['attachment webhook', () => { mockStore.set('syncOptions:org-1', attachmentOpts); return attachmentTrigger({ eventType: 'avi:jira:created:attachment', attachment: { id: '42', issueId: '10001' } }); }],
  ['attachment continuation', () => { mockStore.set('syncOptions:org-1', attachmentOpts); return runAttachmentSyncQueue({ body: { orgId: org.id, direction: 'local-to-remote', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', attachmentIds: ['42'] } }); }],
  ['attachment deletion', () => { mockAttachmentMaps.set('local-to-remote:42', '99'); return propagateAttachmentDeletion({ direction: 'local-to-remote', sourceAttachmentId: '42', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', config: org, orgId: org.id, syncOptions: attachmentOpts }); }],
  ['issue links', () => syncIssueLinks('LOCAL-1', 'REMOTE-1', linkedIssue(), org, null, org.id)],
  ['newly mapped pending links', pendingNew],
  ['manual pending links', () => { seedPending(); fetch.mockResolvedValue(ok({ fields: { issuelinks: [] } })); return resolvers.retryPendingLinks(); }],
  ['scheduled pending links', () => { seedPending(); fetch.mockImplementation(async (_, options) => ok(options?.method === 'POST' ? {} : { fields: { issuelinks: [] } })); return performScheduledSync(); }],
  ['link deletion webhook', () => linkDeleted({ eventType: 'avi:jira:deleted:issuelink', selfGenerated: false, id: '7', sourceIssueId: '10001', destinationIssueId: '10002', issueLinkType: { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' } })],
  ['counterpart notice', () => setCounterpartNotice({ side: 'remote', key: 'REMOTE-1', org, localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', status: 'confirmed_deleted' })],
  ['counterpart notice removal', () => { fetch.mockResolvedValue(ok({ fields: { description: prependCounterpartNoticeToADF(doc, { localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', status: 'deleted' }) } })); return clearCounterpartNotice({ side: 'remote', key: 'REMOTE-1', org, scope: { orgId: org.id, localKey: 'LOCAL-1' } }); }],
  ['status transition', () => transitionRemoteIssue('REMOTE-1', 'In Progress', org, {}, null, { orgId: org.id, localKey: 'LOCAL-1' })],
  ['issue create', () => createRemoteIssue(issue('LOCAL-1'), org, fieldMappings, null, opts)],
  ['issue update', () => updateRemoteIssue('LOCAL-1', 'REMOTE-1', issue('LOCAL-1'), org, fieldMappings, null, opts)],
  ['manual issue update', () => resolvers.forceSyncIssue({ payload: { issueKey: 'LOCAL-1', orgId: org.id } })],
  ['issue webhook', () => issueTrigger({ eventType: 'avi:jira:updated:issue', issue: { key: 'LOCAL-1' } })]
];

describe.each(operations)('%s source-selection boundary', (name, run) => {
  test('eligible source can synchronize', async () => {
    if (name === 'manual pending links') fetch.mockResolvedValue(ok({ fields: { issuelinks: [] } }));
    await settle(run());
    expect(mutationCount()).toBeGreaterThan(0);
  });
  test.each(['excluded', 'error', 'incomplete'])('%s source cannot mutate or advance successful sync state', async mode => {
    if (mode === 'excluded') eligible.clear(); else searchMode = mode;
    const result = await settle(run());
    expect(mutationCount()).toBe(0);
    expect(mappings.setLastSyncedLocalUpdated).not.toHaveBeenCalled();
    expect(mappings.storeCommentMapping).not.toHaveBeenCalled();
    expect(mappings.storeAttachmentMapping).not.toHaveBeenCalled();
    expect(mappings.storeLinkMapping).not.toHaveBeenCalled();
    expect(mappings.removeLinkMapping).not.toHaveBeenCalled();
    if (name === 'manual issue update') expect(result.results[0].success).toBe(false);
    if (name === 'attachment webhook') expect(result.processed).toBe(0);
    if (name === 'manual pending links') expect(result.results.success).toBe(0);
    if (name === 'scheduled pending links') expect(result.lastSuccessfulJiraWrite).toBeNull();
  });
});

test.each(['LOCAL-1', 'LOCAL-2'])('links cannot expose excluded endpoint %s', async key => {
  eligible.delete(key);
  await settle(syncIssueLinks('LOCAL-1', 'REMOTE-1', linkedIssue(), org, null, org.id));
  expect(mutationCount()).toBe(0);
});

test('link-created webhook cannot reuse a rejected target mapping', async () => {
  eligible.delete('LOCAL-2'); mockStore.set('syncOptions:org-1', { ...opts, syncLinks: true });
  getFullIssue.mockImplementation(async key => key === 'LOCAL-1' ? linkedIssue() : issue(key));
  await linkCreated({ eventType: 'avi:jira:created:issuelink', selfGenerated: false, id: '7', sourceIssueId: '10001', destinationIssueId: '10002', issueLinkType: { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' } });
  expect(fetch.mock.calls.filter(([url, o]) => o?.method === 'POST' && url.endsWith('/issueLink'))).toHaveLength(0);
});

test('deleted local source cannot authorize a remote counterpart notice', async () => {
  getFullIssue.mockResolvedValue(null);
  await issueDeleted({ issue: { key: 'LOCAL-1' } });
  expect(mutationCount()).toBe(0);
  expect([...mockStore.keys()].some(key => key.startsWith('counterpart-status:'))).toBe(true);
});

test('JQL configuration drift during verification blocks comment submission without consuming its fence', async () => {
  mockStore.set('syncOptions:org-1', { syncComments: true });
  searchHook = async () => { mockStore.set('organizations', [{ ...org, jqlFilter: 'labels = changed' }]); };
  await syncComment({ issue: issue('LOCAL-1'), comment: { id: '101' } });
  expect(mutationCount()).toBe(0);
  expect(await inspectCommentSubmission(scope)).toBeNull();
});

test('concurrent excluded comments never consume a submission or export a reply', async () => {
  eligible.clear(); mockStore.set('syncOptions:org-1', { syncComments: true });
  await Promise.all([syncComment({ issue: issue('LOCAL-1'), comment: { id: '101' } }), settle(syncAllComments('LOCAL-1', 'REMOTE-1', issue('LOCAL-1'), org, null, org.id))]);
  expect(mutationCount()).toBe(0);
  expect(await inspectCommentSubmission(scope)).toBeNull();
});

test('attachment eligibility revoked during download never marks a submission started', async () => {
  attachments.downloadAttachmentContent.mockImplementation(async () => { eligible.clear(); return Buffer.from('data'); });
  await settle(syncAttachments('LOCAL-1', 'REMOTE-1', issue('LOCAL-1'), org, null, org.id, true, { syncOptions: attachmentOpts }));
  expect(mutationCount()).toBe(0);
  const operation = await getAttachmentOperation({ orgId: org.id, direction: 'local-to-remote', sourceAttachmentId: '42' });
  expect(operation.state).toBe('failed_definitive');
  expect(operation.writeStartedAt).toBeUndefined();
});

test('queued attachment resumes under changed JQL, not its original caller configuration', async () => {
  mockStore.set('organizations', [{ ...org, jqlFilter: 'labels = changed' }]); eligible.clear();
  mockStore.set('syncOptions:org-1', attachmentOpts);
  await settle(runAttachmentSyncQueue({ body: { orgId: org.id, direction: 'local-to-remote', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', attachmentIds: ['42'] } }));
  expect(mutationCount()).toBe(0);
  expect(request.mock.calls.some(([, o]) => o?.body?.includes('labels = changed'))).toBe(true);
});

test('ineligible pending links retain retry evidence and do not exhaust the attempt budget', async () => {
  seedPending(); eligible.delete('LOCAL-2');
  fetch.mockResolvedValue(ok({ fields: { issuelinks: [] } }));
  await retryAllPendingLinks(org, {}, null);
  expect(mutationCount()).toBe(0);
  expect(mockStore.get('pending-links:LOCAL-1')[0].attempts).toBeUndefined();
  expect(mockStore.get('pending-links:LOCAL-1')[0].reconciliationRequired).toBeUndefined();
});

test('a late comment rejection rearms only its own unsent fence, then an eligible delivery submits once', async () => {
  mockStore.set('syncOptions:org-1', { syncComments: true });
  const create = storage.createIfNotExists.getMockImplementation();
  storage.createIfNotExists.mockImplementationOnce(async (key, value) => {
    await create(key, value); eligible.clear();
  });
  const first = await syncComment({ issue: issue('LOCAL-1'), comment: { id: '101' } });
  expect(first.status).toBe('COMMENT_RETRY'); expect(mutationCount()).toBe(0);
  expect((await inspectCommentSubmission(scope)).state).toBe('pre_submission');
  eligible.add('LOCAL-1');
  await syncComment({ issue: issue('LOCAL-1'), comment: { id: '101' } });
  expect(mutationCount()).toBe(1);
});

test('eligible concurrent deliveries still submit a comment at most once', async () => {
  mockStore.set('syncOptions:org-1', { syncComments: true });
  await Promise.all([syncComment({ issue: issue('LOCAL-1'), comment: { id: '101' } }), syncAllComments('LOCAL-1', 'REMOTE-1', issue('LOCAL-1'), org, null, org.id)]);
  expect(mutationCount()).toBe(1);
});

test.each(['LOCAL-1', 'LOCAL-2'])('link deletion requires selected endpoint %s despite both historical mappings', async key => {
  eligible.delete(key);
  await linkDeleted({ eventType: 'avi:jira:deleted:issuelink', selfGenerated: false, id: '7', sourceIssueId: '10001', destinationIssueId: '10002', issueLinkType: { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' } });
  expect(mutationCount()).toBe(0);
  expect(mappings.removeLinkMapping).not.toHaveBeenCalled();
});

test('pending unknown link outcome stays fenced after eligibility changes and returns', async () => {
  seedPending(); mockStore.get('pending-links:LOCAL-1')[0].reconciliationRequired = true;
  eligible.clear(); fetch.mockResolvedValue(ok({ fields: { issuelinks: [] } }));
  await retryAllPendingLinks(org, {}, null);
  eligible.add('LOCAL-1'); eligible.add('LOCAL-2');
  await retryAllPendingLinks(org, {}, null);
  expect(mutationCount()).toBe(0);
  expect(mappings.storeLinkMapping).not.toHaveBeenCalled();
});

test('a second attachment in the same invocation rechecks eligibility independently', async () => {
  attachments.uploadAttachmentContent.mockImplementation(async () => { eligible.clear(); return { id: '99' }; });
  const source = { ...issue('LOCAL-1'), fields: { ...issue('LOCAL-1').fields, attachment: [{ id: '42' }, { id: '43' }] } };
  await settle(syncAttachments('LOCAL-1', 'REMOTE-1', source, org, null, org.id, true, { syncOptions: attachmentOpts }));
  expect(attachments.uploadAttachmentContent).toHaveBeenCalledTimes(1);
});

test('notice eligibility changing during destination read blocks the remote PUT', async () => {
  transportHook = async (_, options) => { if (options?.method === 'GET') eligible.clear(); };
  const result = await settle(setCounterpartNotice({ side: 'remote', key: 'REMOTE-1', org, localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', status: 'unavailable' }));
  expect(mutationCount()).toBe(0); expect(result.success).not.toBe(true);
});

test('transition eligibility changing during destination reads blocks the status POST', async () => {
  transportHook = async () => { eligible.clear(); };
  const result = await settle(transitionRemoteIssue('REMOTE-1', 'In Progress', org, {}, null, { orgId: org.id, localKey: 'LOCAL-1' }));
  expect(mutationCount()).toBe(0); expect(result).not.toBe(true);
});

test('scope reads cannot bypass a Pause activated after the comment claim', async () => {
  mockStore.set('syncOptions:org-1', { syncComments: true });
  let searches = 0;
  searchHook = async () => { if (++searches === 2) mockStore.set('pilotPause', { paused: true }); };
  const result = await syncComment({ issue: issue('LOCAL-1'), comment: { id: '101' } });
  expect(result.status).toBe('COMMENT_RETRY');
  expect(mutationCount()).toBe(0);
  expect((await inspectCommentSubmission(scope)).state).toBe('pre_submission');
});

test('scope denial after a create claim is definitive and leaves submission unstarted', async () => {
  const create = storage.createIfNotExists.getMockImplementation();
  storage.createIfNotExists.mockImplementationOnce(async (key, value) => { await create(key, value); eligible.clear(); });
  await settle(createRemoteIssue(issue('LOCAL-1'), org, fieldMappings, null, opts));
  expect(mutationCount()).toBe(0);
  const operation = [...mockStore].find(([key]) => key.startsWith('issue-create-op:'))?.[1];
  expect(operation.state).toBe('failed_definitive');
  expect(operation.submissionStartedAt).toBeUndefined();
  expect(mappings.setLastSyncedLocalUpdated).not.toHaveBeenCalled();
});

test('a denied transition after a valid field PUT does not advance the issue synchronization timestamp', async () => {
  transportHook = async (_, options) => { if (options?.method === 'PUT') eligible.clear(); };
  const result = await settle(updateRemoteIssue('LOCAL-1', 'REMOTE-1', issue('LOCAL-1'), org, fieldMappings, null, opts));
  expect(result.error?.code).toBe('OUTBOUND_SCOPE_BLOCKED');
  expect(mutationCount()).toBe(1); // The earlier eligible field PUT is not rolled back.
  expect(fetch.mock.calls.filter(([url, options]) => options?.method === 'POST' && url.includes('/transitions'))).toHaveLength(0);
  expect(mappings.setLastSyncedLocalUpdated).not.toHaveBeenCalled();
  expect([...mockStore.keys()].some(key => key.startsWith('sync-latest:'))).toBe(false);
});

test('manual update does not report success for a pre-PUT scope rejection after entry verification', async () => {
  let searches = 0; searchHook = async () => { if (++searches === 2) eligible.clear(); };
  const result = await resolvers.forceSyncIssue({ payload: { issueKey: 'LOCAL-1', orgId: org.id } });
  expect(result.results[0].success).toBe(false);
  expect(mutationCount()).toBe(0);
  expect(mappings.setLastSyncedLocalUpdated).not.toHaveBeenCalled();
});

async function initialJob() {
  listResults = [issue('LOCAL-1')];
  mappings.getRemoteKey.mockImplementation(async key => mockStore.get(`destination:${key}`) ?? null);
  mappings.storeMapping.mockImplementation(async (key, remote) => { mockStore.set(`destination:${key}`, remote); });
  const previewResult = await previewInitialSync({ orgId: org.id });
  expect(previewResult.success ? { success: true } : previewResult).toEqual({ success: true });
  const { preview } = previewResult;
  const started = await startInitialSync({ orgId: org.id, approved: true,
    previewChecksum: preview.previewChecksum, configurationChecksum: preview.configurationChecksum });
  expect(started.success).toBe(true);
  return getInitialSyncJob(org.id);
}

test.each(['eligible', 'excluded', 'error', 'incomplete'])('approved initial consumer verifies %s sources before creating and checkpointing', async mode => {
  const job = await initialJob();
  if (mode === 'excluded') eligible.clear();
  if (mode === 'error' || mode === 'incomplete') searchMode = mode;
  await initialConsumer({ body: { type: 'initial-sync', orgId: org.id, jobId: job.jobId } });
  const latest = await getInitialSyncJob(org.id);
  if (mode === 'eligible') {
    expect(mutationCount()).toBeGreaterThan(0); expect(latest.progress.processed).toBe(1);
  } else {
    expect(mutationCount()).toBe(0); expect(latest.progress.processed).toBe(0);
    expect(latest.cursor).toEqual(job.cursor);
    expect(mappings.setLastSyncedLocalUpdated).not.toHaveBeenCalled();
  }
});

test('initial sync stops without checkpointing when a post-create comment loses eligibility', async () => {
  mockStore.set('syncOptions:org-1', { ...opts, syncComments: true });
  const job = await initialJob();
  getFullComment.mockImplementation(async (_, id) => { eligible.clear(); return comment(id); });
  await initialConsumer({ body: { type: 'initial-sync', orgId: org.id, jobId: job.jobId } });
  const latest = await getInitialSyncJob(org.id);
  expect(fetch.mock.calls.filter(([url, options]) => options?.method === 'POST' && url.includes('/comment'))).toHaveLength(0);
  expect(latest.progress.processed).toBe(0);
  expect(latest.cursor).toEqual(job.cursor);
  expect(mappings.storeMapping).toHaveBeenCalled(); // Retain the real, earlier successful creation.
  expect(mappings.setLastSyncedLocalUpdated).not.toHaveBeenCalled();
});

test('an approved paused job cannot resume under changed JQL', async () => {
  const job = await initialJob();
  await pauseInitialSync({ orgId: org.id });
  mockStore.set('organizations', [{ ...org, jqlFilter: 'labels = changed' }]);
  const resumed = await resumeInitialSync({ orgId: org.id });
  expect(resumed.success).toBe(false);
  expect((await getInitialSyncJob(org.id)).cursor).toEqual(job.cursor);
  expect(mutationCount()).toBe(0);
});

test.each(['eligible', 'excluded', 'error', 'incomplete'])('recurring reconciliation consumer rechecks %s candidates at execution', async mode => {
  listResults = [issue('LOCAL-1')];
  mappings.getRemoteKey.mockImplementation(async key => mockStore.get(`destination:${key}`) ?? null);
  mappings.storeMapping.mockImplementation(async (key, remote) => { mockStore.set(`destination:${key}`, remote); });
  mockStore.set('reconciliationSettings:org-1', { recurringReconciliationEnabled: true });
  const scheduled = await runDueReconciliations(); expect(scheduled.scheduled).toBe(1);
  const job = await getReconciliationJob(org.id);
  // A stale preview still offers the candidate; the shared write boundary must reject it.
  searchHook = async key => { if (key && mode === 'excluded') eligible.clear(); };
  if (mode === 'error' || mode === 'incomplete') {
    searchHook = async key => { if (key) searchMode = mode; };
  }
  const processed = await initialConsumer({ body: { type: 'reconciliation', orgId: org.id, jobId: job.jobId } });
  if (mode === 'eligible') expect(processed.success ? { success: true } : processed).toEqual({ success: true });
  const latest = await getReconciliationJob(org.id);
  if (mode === 'eligible') expect(mutationCount()).toBeGreaterThan(0);
  else {
    expect(mutationCount()).toBe(0);
    expect(latest.attemptedKeys || []).toHaveLength(0);
    expect(mappings.setLastSyncedLocalUpdated).not.toHaveBeenCalled();
  }
});

test.each(['create', 'update'])('%s rechecks a mapped parent at the field-write boundary', async kind => {
  const child = { ...issue('LOCAL-1'), fields: { ...issue('LOCAL-1').fields, parent: { key: 'LOCAL-2' } } };
  let rootChecks = 0;
  searchHook = async key => { if (key === 'LOCAL-1' && ++rootChecks >= 2) eligible.delete('LOCAL-2'); };
  await settle(kind === 'create'
    ? createRemoteIssue(child, org, fieldMappings, null, opts)
    : updateRemoteIssue('LOCAL-1', 'REMOTE-1', child, org, fieldMappings, null, opts));
  expect(mutationCount()).toBe(0);
  expect(mappings.setLastSyncedLocalUpdated).not.toHaveBeenCalled();
});

test('a stale caller with no JQL cannot bypass a newly configured filter', async () => {
  eligible.clear();
  await settle(syncAttachments('LOCAL-1', 'REMOTE-1', issue('LOCAL-1'), { ...org, jqlFilter: '' }, null, org.id, true, { syncOptions: attachmentOpts }));
  expect(mutationCount()).toBe(0);
  expect(request.mock.calls.some(([, options]) => options?.body?.includes('labels = selected'))).toBe(true);
});

test('link verification cannot combine endpoints from different selection configurations', async () => {
  searchHook = async key => { if (key === 'LOCAL-2') mockStore.set('organizations', [{ ...org, jqlFilter: 'labels = changed' }]); };
  await settle(syncIssueLinks('LOCAL-1', 'REMOTE-1', linkedIssue(), org, null, org.id));
  expect(mutationCount()).toBe(0);
});

test('a confirmed historical pending link can repair storage after exclusion without a new write', async () => {
  seedPending(); eligible.clear();
  const result = await retryAllPendingLinks(org, {}, null);
  expect(mutationCount()).toBe(0);
  expect(result.success).toBe(1);
  expect(mappings.storeLinkMapping).toHaveBeenCalledWith('7', 'synced', org.id);
  expect(mappings.setLastSyncedLocalUpdated).not.toHaveBeenCalled();
});

test('counterpart notices cannot use a missing or conflicting reverse mapping as source authority', async () => {
  mappings.getLocalKey.mockResolvedValue('LOCAL-2'); mappings.getRemoteKey.mockResolvedValue('REMOTE-2');
  const result = await setCounterpartNotice({ side: 'remote', key: 'REMOTE-1', org, localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', status: 'unavailable' });
  expect(result).toMatchObject({ success: false, code: 'OUTBOUND_SCOPE_UNVERIFIABLE', reason: 'SOURCE_MAPPING_UNAVAILABLE' });
  expect(mutationCount()).toBe(0);
});
