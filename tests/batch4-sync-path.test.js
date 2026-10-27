// The synchronization authorization gate has its own suite; this suite tests another behaviour.
jest.mock('../src/services/sync/sync-authorization.js', () => require('./helpers/authorized-sync-authorization.js'));
jest.mock('../src/services/sync/pair-witness-guard.js', () => require('./helpers/pair-witness-create-mocks.js').guardModule);
jest.mock('../src/services/sync/pair-witness-establishment.js', () => require('./helpers/pair-witness-create-mocks.js').establishmentModule);

import { entities } from './helpers/forge-lease-runtime';
const mockStore = new Map();

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  const fetchMock = jest.fn();
  return {
    __esModule: true,
    default: { asApp: () => ({ requestJira }) },
    route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch: fetchMock
  };
});

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(async key => (mockStore.has(key) ? mockStore.get(key) : null)),
  set: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  del: jest.fn(async key => { mockStore.delete(key); }),
  getSecret: jest.fn(async key => (key.includes('webhookSigningSecret') ? 'abcdefghijklmnop' : 'token')),
  setIfNotExists: jest.fn(async (key, value) => {
    if (mockStore.has(key)) {
      const error = new Error('already exists');
      error.code = 'KEY_ALREADY_EXISTS';
      throw error;
    }
    mockStore.set(key, value);
  }),
  setWithTtl: jest.fn(async (key, value) => { mockStore.set(key, value); })
}));

jest.mock('../src/services/storage/mappings.js', () => ({
  getRemoteKey: jest.fn(),
  getLocalKey: jest.fn(),
  storeMapping: jest.fn(),
  ensureMappingPair: jest.fn(),
  getOrganizationsWithTokens: jest.fn(),
  setLastSyncedLocalUpdated: jest.fn(),
  storeAttachmentMapping: jest.fn(),
  getAttachmentMapping: jest.fn(),
  storeLinkMapping: jest.fn(),
  getLocalCommentId: jest.fn(),
  storeCommentMapping: jest.fn()
}));

jest.mock('../src/services/storage/flags.js', () => ({
  markSyncing: jest.fn(),
  clearSyncFlag: jest.fn(),
  isSyncing: jest.fn(),
  findPendingLinksToIssue: jest.fn(),
  removePendingLink: jest.fn(),
  enqueuePendingChildIssue: jest.fn(),
  consumePendingChildIssues: jest.fn()
}));

jest.mock('../src/services/storage/stats.js', () => ({
  logAuditEntry: jest.fn(async () => undefined),
  trackWebhookSync: jest.fn(),
  trackApiCall: jest.fn()
}));

jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn(),
  getFullComment: jest.fn(),
  getOrgName: jest.fn(async () => 'Local Org'),
  updateLocalIssueDescription: jest.fn(async () => true),
  uploadAttachment: jest.fn()
}));

jest.mock('../src/services/jira/remote-client.js', () => ({
  getRemoteIssue: jest.fn(),
  getRemoteComment: jest.fn()
}));

jest.mock('../src/services/sync/attachment-sync.js', () => ({ syncAttachments: jest.fn(async () => ({})) }));
jest.mock('../src/services/sync/link-sync.js', () => ({
  syncIssueLinks: jest.fn(async () => ({ synced: 0 })),
  createLinkOnRemote: jest.fn(async () => ({ success: true }))
}));
jest.mock('../src/services/sync/comment-sync.js', () => ({ syncAllComments: jest.fn(async () => ({ synced: 0, skipped: 0 })) }));
jest.mock('../src/services/sync/transition-sync.js', () => ({
  transitionRemoteIssue: jest.fn(async () => false),
  transitionLocalIssue: jest.fn(async () => false)
}));
jest.mock('../src/services/storage/rejected-fields.js', () => ({ recordRejectedFields: jest.fn() }));

import { updateIssueForOrg, createIssueForOrg } from '../src/services/sync/issue-sync.js';
import api, { fetch } from '@forge/api';
import { processIncomingWebhook } from './helpers/signed-webhook.js';
import { acquireIssueLease } from '../src/services/sync/issue-lease.js';
import { latestAcceptedKey, echoMarkerKey, getLatestAccepted, findAppCausedEcho } from '../src/services/sync/sync-state.js';
import { hashSynchronizedFields } from '../src/services/sync/field-normalization.js';
import { prependCrossReferenceToADF, adfPreservesOriginalContent } from '../src/utils/adf.js';
import { storeMapping, getLocalKey } from '../src/services/storage/mappings.js';
import { getRemoteIssue } from '../src/services/jira/remote-client.js';
import { getFullIssue } from '../src/services/jira/local-client.js';
import { markSyncing } from '../src/services/storage/flags.js';
import { run as runBulkSync } from '../src/triggers/bulk-sync.js';
import { defineDiagnosticsResolvers } from '../src/resolvers/diagnostics.js';

const mockFetch = fetch;
const mockRequestJira = api.asApp().requestJira;

const ORG = {
  id: 'org-1',
  name: 'Remote Org',
  remoteUrl: 'https://remote.example.invalid',
  remoteEmail: 'sync@example.invalid',
  remoteApiToken: 'test-token',
  remoteProjectKey: 'REMOTE'
};

const DESCRIPTION = {
  type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep this' }] }]
};

function localIssue(overrides = {}) {
  return {
    key: 'LOCAL-1',
    fields: {
      project: { key: 'LOCAL' },
      summary: 'Test issue',
      description: DESCRIPTION,
      issuetype: { name: 'Task', id: '10001' },
      status: { name: 'To Do' },
      updated: '2026-10-21T12:00:00.000Z',
      labels: [],
      ...overrides
    }
  };
}

function mappings() {
  return { userMappings: {}, fieldMappings: {}, statusMappings: {}, issueTypeMappings: {}, projectMappings: {} };
}

function authContext() {
  mockStore.set('organizations', [{
    ...ORG,
    syncDirection: 'bidirectional',
    allowedProjects: ['LOCAL']
  }]);
  mockStore.set('syncOptions:org-1', { syncLinks: false, syncComments: false, syncAttachments: false });
}

beforeEach(() => {
  mockStore.clear();
  authContext();
  jest.clearAllMocks();
  getFullIssue.mockResolvedValue({ key: 'LOCAL-1', fields: { project: { key: 'LOCAL' } } });
  mockFetch.mockResolvedValue({ ok: true, status: 204, text: async () => '', json: async () => ({}) });
  mockRequestJira.mockResolvedValue({ ok: true, status: 204, text: async () => '', json: async () => ({}) });
  getLocalKey.mockResolvedValue('LOCAL-1');
  storeMapping.mockResolvedValue({ localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', idempotent: false });
});


describe('Batch 4 issue write paths', () => {
  test('F07: worker resumed after 120-second expiry and successor acquisition submits no PUT', async () => {
    const clock = jest.spyOn(Date, 'now');
    const start = Date.now();
    clock.mockReturnValue(start);
    let resume;
    let reached;
    const held = new Promise(resolve => { resume = resolve; });
    const entered = new Promise(resolve => { reached = resolve; });
    markSyncing.mockImplementationOnce(async () => { reached(); await held; });
    const worker = updateIssueForOrg('LOCAL-1', 'REMOTE-1', localIssue(), ORG, mappings(), {
      syncAttachments: false, syncLinks: false, syncComments: false
    });
    try {
      await entered;
      const [key, lease] = [...entities.entries()][0];
      // Model one permitted TTL-cleanup schedule, not guaranteed immediate
      // removal. 121 seconds is still inside a 900-second Forge invocation.
      clock.mockReturnValue(start + 121000);
      expect(lease.expiresAt).toBeLessThan(Date.now());
      // Leave the expired row physically present: takeover must not need TTL cleanup.
      const successor = await acquireIssueLease({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' });
      expect(successor.acquired).toBe(true);
      resume();
      await worker;
      const writes = mockFetch.mock.calls.filter(([, options]) => options?.method === 'PUT');
      expect(writes).toHaveLength(0);
      expect(entities.get(key)?.leaseToken).toBe(successor.token);
    } finally {
      resume();
      await worker;
      clock.mockRestore();
    }
  });

  test('19. a failed destination write does not advance the latest accepted timestamp', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'rejected' });
    const result = await updateIssueForOrg('LOCAL-1', 'REMOTE-1', localIssue(), ORG, mappings(), { syncAttachments: false, syncLinks: false, syncComments: false });
    expect(result).toBeNull();
    expect(await getLatestAccepted({ orgId: 'org-1', direction: 'local-to-remote', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' })).toBeNull();
  });

  test('28. a positively detected conflict performs zero destination writes', async () => {
    mockStore.set(latestAcceptedKey({ orgId: 'org-1', direction: 'local-to-remote', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' }), {
      sourceUpdated: '2026-10-21T12:00:00.000Z',
      fieldHash: 'different-hash'
    });
    const result = await updateIssueForOrg('LOCAL-1', 'REMOTE-1', localIssue(), ORG, mappings(), { syncAttachments: false, syncLinks: false, syncComments: false });
    expect(result).toEqual(expect.objectContaining({ skipped: true, status: 'SYNC_CONFLICT_REVIEW_REQUIRED' }));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('30. a non-conflicting update still synchronizes and advances state', async () => {
    const result = await updateIssueForOrg('LOCAL-1', 'REMOTE-1', localIssue(), ORG, mappings(), { syncAttachments: false, syncLinks: false, syncComments: false });
    expect(result).not.toEqual(expect.objectContaining({ skipped: true }));
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/rest/api/3/issue/REMOTE-1'), expect.objectContaining({ method: 'PUT' }));
    expect(await getLatestAccepted({ orgId: 'org-1', direction: 'local-to-remote', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' }))
      .toEqual(expect.objectContaining({ sourceUpdated: '2026-10-21T12:00:00.000Z' }));
  });

  test('30b. a held issue lease prevents concurrent destination writes', async () => {
    await acquireIssueLease({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' });
    const result = await updateIssueForOrg('LOCAL-1', 'REMOTE-1', localIssue(), ORG, mappings(), { syncAttachments: false, syncLinks: false, syncComments: false });
    expect(result).toEqual(expect.objectContaining({ skipped: true, status: 'SYNC_ALREADY_IN_PROGRESS' }));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('30c. a successful update records a full-remote-state marker that matches the later remote echo', async () => {
    const remoteEchoFields = {
      summary: 'Test issue',
      description: DESCRIPTION,
      issuetype: { name: 'Task' },
      priority: null,
      labels: [],
      components: [],
      fixVersions: [],
      versions: [],
      assignee: { accountId: 'remote-account' },
      reporter: { accountId: 'remote-account' },
      parent: null
    };
    mockFetch.mockImplementation(async (url, options = {}) => {
      if (options.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ key: 'REMOTE-1', fields: remoteEchoFields }) };
      }
      return { ok: true, status: 204 };
    });
    getRemoteIssue.mockResolvedValue({ key: 'REMOTE-1', fields: remoteEchoFields });

    await updateIssueForOrg('LOCAL-1', 'REMOTE-1', localIssue(), ORG, mappings(), { syncAttachments: false, syncLinks: false, syncComments: false });

    const marker = mockStore.get(echoMarkerKey({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', observedSide: 'remote' }));
    expect(marker).toEqual(expect.objectContaining({
      fieldHash: hashSynchronizedFields(remoteEchoFields, { includeStatus: true })
    }));
    await expect(findAppCausedEcho({
      orgId: 'org-1',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      observedSide: 'remote',
      fieldHash: hashSynchronizedFields(remoteEchoFields, { includeStatus: true })
    })).resolves.toEqual(expect.objectContaining({ echo: true }));
    expect(JSON.stringify(marker)).not.toContain('Keep this');
  });

  test('30d. if the complete remote state cannot be read, no misleading echo marker is written', async () => {
    getRemoteIssue.mockResolvedValue(null);
    mockFetch.mockImplementation(async (url, options = {}) => {
      if (options.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: true, status: 204 };
    });

    await updateIssueForOrg('LOCAL-1', 'REMOTE-1', localIssue(), ORG, mappings(), { syncAttachments: false, syncLinks: false, syncComments: false });

    const marker = mockStore.get(echoMarkerKey({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', observedSide: 'remote' }));
    expect(marker).toBeUndefined();
    const decisions = Array.from(mockStore.values()).filter(value => value?.decision === 'echo_hash_unavailable');
    expect(decisions.length).toBeGreaterThan(0);
  });

  test('44. Org A -> Org B issue creation still succeeds under mocks', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ key: 'REMOTE-9' }) })
      .mockResolvedValueOnce({ ok: true, status: 204 });
    const issue = localIssue();
    const result = await createIssueForOrg(issue, ORG, mappings(), { syncAttachments: false, syncLinks: false, syncComments: false });
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/rest/api/3/issue?notifyUsers=false'), expect.objectContaining({ method: 'POST' }));
    expect(storeMapping).toHaveBeenCalledWith('LOCAL-1', 'REMOTE-9', 'org-1');
    expect(result).toEqual(expect.objectContaining({ key: 'REMOTE-9' }));
  });
});


describe('Batch 4 inbound and safety regressions', () => {
  const credential = 'abcdefghijklmnop';

  test('45. Org B -> Org A issue update still succeeds under mocks', async () => {
    authContext();
    const localDestinationFields = {
      project: { key: 'LOCAL' },
      summary: 'Remote change',
      description: DESCRIPTION,
      issuetype: { name: 'Task', id: '10001' },
      status: { name: 'In Progress' },
      labels: ['remote'],
      assignee: null,
      reporter: null
    };
    getFullIssue.mockResolvedValue({ key: 'LOCAL-1', fields: localDestinationFields });
    getRemoteIssue.mockResolvedValue({
      key: 'REMOTE-1',
      fields: {
        summary: 'Remote change',
        description: DESCRIPTION,
        issuetype: { name: 'Task', id: '10001' },
        status: { name: 'In Progress' },
        updated: '2026-10-21T12:00:05.000Z',
        labels: ['remote']
      }
    });

    const response = await processIncomingWebhook({
      webhookEvent: 'jira:issue_updated',
      timestamp: 1780000005000,
      issue: {
        id: '20001',
        key: 'REMOTE-1',
        fields: { updated: '2026-10-21T12:00:05.000Z' }
      }
    }, { orgId: 'org-1', signingSecret: credential });

    expect(response.status).toBe(200);
    expect(mockRequestJira).toHaveBeenCalledWith(
      expect.stringContaining('/rest/api/3/issue/LOCAL-1'),
      expect.objectContaining({ method: 'PUT' })
    );
    const marker = mockStore.get(echoMarkerKey({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', observedSide: 'local' }));
    expect(marker).toEqual(expect.objectContaining({
      fieldHash: hashSynchronizedFields(localDestinationFields, { includeStatus: true })
    }));
    await expect(findAppCausedEcho({
      orgId: 'org-1',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      observedSide: 'local',
      fieldHash: hashSynchronizedFields(localDestinationFields, { includeStatus: true })
    })).resolves.toEqual(expect.objectContaining({ echo: true }));
  });

  test('F07: inbound worker resumed after takeover submits no local write', async () => {
    authContext();
    getFullIssue.mockResolvedValue({ key: 'LOCAL-1', fields: { project: { key: 'LOCAL' }, summary: 'Local' } });
    getRemoteIssue.mockResolvedValue({ key: 'REMOTE-1', fields: localIssue({ summary: 'Remote change' }).fields });
    let resume, reached;
    const held = new Promise(resolve => { resume = resolve; });
    const entered = new Promise(resolve => { reached = resolve; });
    markSyncing.mockImplementationOnce(async () => { reached(); await held; });
    const clock = jest.spyOn(Date, 'now');
    const start = Date.now(); clock.mockReturnValue(start);
    const worker = processIncomingWebhook({ webhookEvent: 'jira:issue_updated', timestamp: start,
      issue: { id: '20001', key: 'REMOTE-1', fields: { updated: '2026-10-21T12:00:00.000Z' } }
    }, { orgId: 'org-1', signingSecret: credential });
    try {
      await entered;
      clock.mockReturnValue(start + 121000);
      const successor = await acquireIssueLease({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' });
      expect(successor.acquired).toBe(true);
      resume(); await worker;
      expect(mockRequestJira.mock.calls.filter(([, options]) => options?.method === 'PUT' || options?.method === 'POST')).toHaveLength(0);
      expect(entities.get(successor.key)?.leaseToken).toBe(successor.token);
    } finally {
      resume(); await worker; clock.mockRestore();
    }
  });

  test('46. cross-reference description preservation still holds', () => {
    const result = prependCrossReferenceToADF(DESCRIPTION, 'LOCAL-1', 'REMOTE-1', 'A', 'B');
    expect(adfPreservesOriginalContent(DESCRIPTION, result)).toBe(true);
    expect(JSON.stringify(result)).toContain('Keep this');
  });

  test('47. deletion propagation remains disabled', async () => {
    authContext();
    const response = await processIncomingWebhook({
      webhookEvent: 'jira:issue_deleted',
      timestamp: 1780000006000,
      issue: { id: '20001', key: 'REMOTE-1' }
    }, { orgId: 'org-1', signingSecret: credential });

    expect(response.status).toBe(200);
    expect(mockRequestJira).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('48. bulk sync consumer remains disabled', async () => {
    const result = await runBulkSync({ body: { orgId: 'org-1', syncMissingData: true } }, {});
    expect(result).toEqual(expect.objectContaining({ success: false, code: 'BULK_SYNC_CONSUMER_DISABLED' }));
    expect(mockRequestJira).not.toHaveBeenCalled();
  });

  test('49. destructive system test remains disabled', async () => {
    const definitions = {};
    defineDiagnosticsResolvers({ define: (name, fn) => { definitions[name] = fn; } });
    const result = await definitions.runSystemTest();
    expect(result).toEqual(expect.objectContaining({ disabled: true, code: 'SYSTEM_TEST_DISABLED' }));
    expect(result.message).toContain('No Jira writes or deletes');
  });

  test('50. existing mapping is not replaced by a different issue pair', async () => {
    const latest = await getLatestAccepted({ orgId: 'org-1', direction: 'local-to-remote', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' });
    expect(latest).toBeNull();
    expect(storeMapping).not.toHaveBeenCalled();
  });
});

describe('Package 2 B03: status-aware echo boundaries', () => {
  const state = require('../src/services/sync/sync-state.js');
  const destination = require('../src/services/sync/destination-state.js');
  const outbound = require('../src/services/sync/issue-sync.js');
  const transitions = require('../src/services/sync/transition-sync.js');
  const maps = require('../src/services/storage/mappings.js');

  test.each(['local', 'remote'])('%s status-only edits survive a real destination fingerprint', async side => {
    const original = localIssue({ status: { id: '1', name: 'To Do' } });
    getFullIssue.mockResolvedValue(original);
    getRemoteIssue.mockResolvedValue({ ...original, key: 'REMOTE-1' });
    const prior = side === 'local'
      ? await destination.resolveLocalDestinationHash({ localKey: 'LOCAL-1' })
      : await destination.resolveRemoteDestinationHash({ org: ORG, remoteKey: 'REMOTE-1' });
    await state.recordDestinationWrite({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1',
      observedSide: side, fieldHash: prior.hash });
    const changed = localIssue({ status: { id: '2', name: 'In Progress' }, updated: '2026-10-21T12:00:05.000Z' });
    if (side === 'local') {
      getFullIssue.mockResolvedValue(changed);
      maps.getOrganizationsWithTokens.mockResolvedValue([{ ...ORG, allowedProjects: ['LOCAL'] }]);
      maps.getRemoteKey.mockResolvedValue('REMOTE-1');
      await outbound.syncIssue({ issue: { key: 'LOCAL-1' }, changelog: { items: [{ field: 'status' }] } });
      expect(transitions.transitionRemoteIssue).toHaveBeenCalled();
      expect(mockFetch.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(true);
    } else {
      getRemoteIssue.mockResolvedValue({ ...changed, key: 'REMOTE-1' });
      await processIncomingWebhook({ webhookEvent: 'jira:issue_updated', issue: { key: 'REMOTE-1', fields: changed.fields },
        changelog: { items: [{ field: 'status' }] } }, { orgId: 'org-1', signingSecret: 'abcdefghijklmnop' });
      expect(transitions.transitionLocalIssue).toHaveBeenCalled();
      expect(mockRequestJira.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(true);
    }
  });

  test.each(['local', 'remote'])('%s genuine echoes remain suppressed', async side => {
    const original = localIssue({ status: { id: '1', name: 'To Do' } });
    getFullIssue.mockResolvedValue(original);
    getRemoteIssue.mockResolvedValue({ ...original, key: 'REMOTE-1' });
    const prior = side === 'local'
      ? await destination.resolveLocalDestinationHash({ localKey: 'LOCAL-1' })
      : await destination.resolveRemoteDestinationHash({ org: ORG, remoteKey: 'REMOTE-1' });
    await state.recordDestinationWrite({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', observedSide: side, fieldHash: prior.hash });
    if (side === 'local') {
      maps.getOrganizationsWithTokens.mockResolvedValue([{ ...ORG, allowedProjects: ['LOCAL'] }]);
      maps.getRemoteKey.mockResolvedValue('REMOTE-1');
      await outbound.syncIssue({ issue: { key: 'LOCAL-1' } });
    } else {
      await processIncomingWebhook({ webhookEvent: 'jira:issue_updated', issue: { key: 'REMOTE-1', fields: original.fields } },
        { orgId: 'org-1', signingSecret: 'abcdefghijklmnop' });
    }
    expect(mockFetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0);
    expect(mockRequestJira.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0);
  });

  test('destination marker observes the remote status after the mapped transition', async () => {
    const remote = localIssue({ status: { id: '10', name: 'Open' } });
    getRemoteIssue.mockImplementation(async () => ({ ...remote, key: 'REMOTE-1' }));
    transitions.transitionRemoteIssue.mockImplementationOnce(async () => {
      remote.fields.status = { id: '20', name: 'Active' }; return true;
    });
    await outbound.updateIssueForOrg('LOCAL-1', 'REMOTE-1', localIssue(), ORG, mappings(),
      { syncAttachments: false, syncLinks: false, syncComments: false });
    expect(mockStore.get(echoMarkerKey({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', observedSide: 'remote' })).fieldHash)
      .toBe(hashSynchronizedFields(remote.fields));
  });

  test('different status identifiers with the same name are distinct', () => {
    expect(hashSynchronizedFields({ status: { id: '1', name: 'Active' } }))
      .not.toBe(hashSynchronizedFields({ status: { id: '2', name: 'Active' } }));
  });
});
