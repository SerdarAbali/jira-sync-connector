const mockStore = new Map();
const mockSecretStore = new Map();

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  const fetchMock = jest.fn();
  return {
    __esModule: true,
    default: {
      asApp: () => ({ requestJira }),
      asUser: () => ({ requestJira })
    },
    route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch: fetchMock
  };
});

jest.mock('@forge/resolver', () => {
  class FakeResolver {
    constructor() { this.functions = {}; }
    define(name, fn) { this.functions[name] = fn; }
    getDefinitions() { return async () => undefined; }
  }
  return { __esModule: true, default: FakeResolver };
});

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(async key => (mockStore.has(key) ? mockStore.get(key) : null)),
  set: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  del: jest.fn(async key => { mockStore.delete(key); }),
  getSecret: jest.fn(async key => (mockSecretStore.has(key) ? mockSecretStore.get(key) : null)),
  setSecret: jest.fn(async (key, value) => { mockSecretStore.set(key, value); }),
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
  getRemoteKey: jest.fn(async () => null),
  getLocalKey: jest.fn(async () => null),
  storeMapping: jest.fn(),
  ensureMappingPair: jest.fn(),
  getOrganizationsWithTokens: jest.fn(async () => []),
  setLastSyncedLocalUpdated: jest.fn(),
  storeAttachmentMapping: jest.fn(),
  removeAttachmentMapping: jest.fn(),
  getAttachmentMapping: jest.fn(async () => null),
  storeLinkMapping: jest.fn(),
  removeLinkMapping: jest.fn(),
  getLocalCommentId: jest.fn(),
  getRemoteCommentId: jest.fn(async () => null),
  storeCommentMapping: jest.fn()
}));

jest.mock('../src/services/storage/flags.js', () => ({
  markSyncing: jest.fn(),
  clearSyncFlag: jest.fn(),
  isSyncing: jest.fn(async () => false),
  findPendingLinksToIssue: jest.fn(async () => []),
  removePendingLink: jest.fn(),
  storePendingLink: jest.fn(),
  enqueuePendingChildIssue: jest.fn(),
  consumePendingChildIssues: jest.fn(async () => [])
}));

jest.mock('../src/services/storage/stats.js', () => ({
  logAuditEntry: jest.fn(),
  trackWebhookSync: jest.fn(async () => undefined),
  trackApiCall: jest.fn()
}));

jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn(),
  getFullComment: jest.fn(),
  getOrgName: jest.fn(async () => 'Local Org'),
  updateLocalIssueDescription: jest.fn(),
  uploadAttachment: jest.fn(),
  downloadAttachment: jest.fn(async () => Buffer.from('file'))
}));

jest.mock('../src/services/jira/remote-client.js', () => ({
  getRemoteIssue: jest.fn(),
  getRemoteComment: jest.fn(),
  uploadAttachment: jest.fn(),
  getRemoteIssueAttachments: jest.fn(async () => [])
}));


import api, { fetch } from '@forge/api';
import {
  PILOT_PAUSE_KEY,
  PAUSE_REASON_PATTERN,
  PilotPausedError,
  getPilotPause,
  pausePilot,
  resumePilot,
  getPilotStatus,
  assertPilotWritesAllowed
} from '../src/services/sync/pilot-pause.js';
import { createIssueForOrg, updateIssueForOrg } from '../src/services/sync/issue-sync.js';
import { transitionRemoteIssue, transitionLocalIssue } from '../src/services/sync/transition-sync.js';
import { syncAllComments } from '../src/services/sync/comment-sync.js';
import { createLinkOnRemote } from '../src/services/sync/link-sync.js';
import { syncAttachments } from '../src/services/sync/attachment-sync.js';
import { processIncomingWebhook } from '../src/services/sync/incoming-sync.js';
import { definePilotResolvers } from '../src/resolvers/pilot.js';
import { defineDiagnosticsResolvers } from '../src/resolvers/diagnostics.js';
import { RESOLVER_POLICIES } from '../src/resolvers/authorization-policy.js';
import { createAuthorizedHandler, forbiddenResponse } from '../src/resolvers/authorization.js';
import { getOrganizationsWithTokens } from '../src/services/storage/mappings.js';
import { getRemoteIssueAttachments, uploadAttachment as uploadRemoteAttachment } from '../src/services/jira/remote-client.js';
import { downloadAttachment } from '../src/services/jira/local-client.js';

const requestJira = api.asApp().requestJira;
const fetchMock = fetch;

const ORG = {
  id: 'org-1',
  name: 'Target Org',
  remoteUrl: 'https://remote.example',
  remoteEmail: 'remote@example.com',
  remoteApiToken: 'remote-token',
  remoteProjectKey: 'REMOTE',
  allowedProjects: ['LOCAL'],
  syncDirection: 'push'
};

const MAPPINGS = {
  userMappings: {},
  fieldMappings: {},
  statusMappings: {},
  issueTypeMappings: {}
};

function localIssue(overrides = {}) {
  return {
    key: 'LOCAL-1',
    fields: {
      summary: 'Local issue',
      description: null,
      project: { key: 'LOCAL' },
      updated: '2026-10-21T12:00:00.000Z',
      issuetype: { name: 'Task' },
      status: { name: 'Open' },
      attachment: [],
      issuelinks: [],
      ...overrides
    }
  };
}

function seedOrganization(syncDirection = 'push') {
  mockStore.set('organizations', [{ ...ORG, syncDirection }]);
  mockSecretStore.set('secret:org-1:token', 'remote-token');
  mockSecretStore.set('secret:org-1:incomingSecret', 'abcdefghijklmnop');
}

function webhookAuth() {
  return { orgId: 'org-1', credential: 'abcdefghijklmnop' };
}

beforeEach(() => {
  mockStore.clear();
  mockSecretStore.clear();
  jest.clearAllMocks();
  getOrganizationsWithTokens.mockResolvedValue([]);
  getRemoteIssueAttachments.mockResolvedValue([]);
  downloadAttachment.mockResolvedValue(Buffer.from('file'));
});

describe('Batch 7 global emergency pause state', () => {
  test('a missing pause record is active and preserves upgraded behavior', async () => {
    expect(await getPilotPause()).toEqual({
      paused: false,
      pausedAt: null,
      pausedBy: null,
      reasonCode: null
    });
    await expect(assertPilotWritesAllowed('issue_create_remote')).resolves.toBeUndefined();
  });

  test('pause stores only safe status fields and a strict reason code', async () => {
    const state = await pausePilot('emergency_stop', 'admin-1');

    expect(state.paused).toBe(true);
    expect(state.pausedBy).toBe('admin-1');
    expect(state.reasonCode).toBe('emergency_stop');
    expect(new Date(state.pausedAt).toString()).not.toBe('Invalid Date');
    expect(PAUSE_REASON_PATTERN.test('emergency_stop')).toBe(true);
    expect(PAUSE_REASON_PATTERN.test('not allowed spaces')).toBe(false);
    await expect(pausePilot('bad reason!', 'admin-1')).rejects.toMatchObject({
      code: 'INVALID_PAUSE_REASON'
    });
  });

  test('resume clears pause fields without queueing or triggering synchronization', async () => {
    await pausePilot('maintenance', 'admin-1');
    const keysBeforeResume = [...mockStore.keys()].filter(key => key !== PILOT_PAUSE_KEY).sort();
    const resumeState = await resumePilot('admin-2');

    expect(resumeState).toEqual({
      paused: false,
      pausedAt: null,
      pausedBy: null,
      reasonCode: null
    });
    expect([...mockStore.keys()].filter(key => key !== PILOT_PAUSE_KEY).sort()).toEqual(keysBeforeResume);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(requestJira).not.toHaveBeenCalled();
  });

  test('pause and resume preserve mappings, secrets, and organization configuration', async () => {
    mockStore.set('organizations', [{ ...ORG, syncDirection: 'bidirectional' }]);
    mockStore.set('org-1:local-to-remote:LOCAL-1', 'REMOTE-1');
    mockStore.set('org-1:remote-to-local:REMOTE-1', 'LOCAL-1');
    mockStore.set('fieldMappings:org-1', { customfield_1: 'customfield_2' });
    mockSecretStore.set('secret:org-1:token', 'remote-token');
    mockSecretStore.set('secret:org-1:incomingSecret', 'abcdefghijklmnop');

    const originalOrganizations = JSON.parse(JSON.stringify(mockStore.get('organizations')));
    const originalLocalMapping = mockStore.get('org-1:local-to-remote:LOCAL-1');
    const originalRemoteMapping = mockStore.get('org-1:remote-to-local:REMOTE-1');
    const originalFields = JSON.parse(JSON.stringify(mockStore.get('fieldMappings:org-1')));
    const originalToken = mockSecretStore.get('secret:org-1:token');
    const originalSecret = mockSecretStore.get('secret:org-1:incomingSecret');

    await pausePilot('maintenance', 'admin-1');
    await resumePilot('admin-2');

    expect(mockStore.get('organizations')).toEqual(originalOrganizations);
    expect(mockStore.get('org-1:local-to-remote:LOCAL-1')).toBe(originalLocalMapping);
    expect(mockStore.get('org-1:remote-to-local:REMOTE-1')).toBe(originalRemoteMapping);
    expect(mockStore.get('fieldMappings:org-1')).toEqual(originalFields);
    expect(mockSecretStore.get('secret:org-1:token')).toBe(originalToken);
    expect(mockSecretStore.get('secret:org-1:incomingSecret')).toBe(originalSecret);
    expect([...mockStore.keys()].some(key => key.startsWith('pending-links:'))).toBe(false);
  });

  test('status is read-only and reports existing syncDirection values unchanged', async () => {
    mockStore.set('organizations', [
      { ...ORG, id: 'org-1', name: 'Push Org', syncDirection: 'push' },
      { ...ORG, id: 'org-2', name: 'Bidirectional Org', syncDirection: 'bidirectional' }
    ]);
    await pausePilot('maintenance', 'admin-1');

    const status = await getPilotStatus();
    expect(status).toEqual(expect.objectContaining({
      state: 'paused',
      paused: true,
      pausedBy: 'admin-1',
      reasonCode: 'maintenance'
    }));
    expect(status.organizations).toEqual([
      { id: 'org-1', name: 'Push Org', syncDirection: 'push' },
      { id: 'org-2', name: 'Bidirectional Org', syncDirection: 'bidirectional' }
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(requestJira).not.toHaveBeenCalled();
  });
});



describe('Batch 7 direction behavior remains unchanged', () => {
  test('push organizations still reject incoming webhooks', async () => {
    seedOrganization('push');

    const result = await processIncomingWebhook({
      webhookEvent: 'jira:issue_created',
      issue: { key: 'REMOTE-1', fields: {} }
    }, webhookAuth());

    expect(result).toEqual({ status: 403, body: { error: 'Incoming sync is not enabled' } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(requestJira).not.toHaveBeenCalled();
  });

  test('bidirectional organizations still process inbound events while active', async () => {
    seedOrganization('bidirectional');

    const result = await processIncomingWebhook({
      webhookEvent: 'jira:worklog_updated',
      issue: { key: 'REMOTE-1', fields: {} }
    }, webhookAuth());

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ message: 'Processed' });
  });
});

describe('Batch 7 pause blocks Jira write categories', () => {
  beforeEach(async () => {
    await pausePilot('emergency_stop', 'admin-1');
  });

  test('issue create and update are blocked before leases or Jira writes', async () => {
    await expect(createIssueForOrg(localIssue(), ORG, MAPPINGS, {}))
      .rejects.toMatchObject({ code: 'PILOT_PAUSED', operation: 'issue_create_remote' });
    await expect(updateIssueForOrg('LOCAL-1', 'REMOTE-1', localIssue(), ORG, MAPPINGS, {}))
      .rejects.toMatchObject({ code: 'PILOT_PAUSED', operation: 'issue_update_remote' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(requestJira).not.toHaveBeenCalled();
  });

  test('remote transitions are blocked before the POST', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ fields: { status: { name: 'Open' } } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ transitions: [{ id: '31', to: { id: '3', name: 'Done' } }] }) });

    const result = await transitionRemoteIssue('REMOTE-1', 'Done', ORG, {});

    expect(result).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  });

  test('local transitions are blocked before the POST', async () => {
    requestJira
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ fields: { status: { name: 'Open', id: '1' } } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ transitions: [{ id: '31', to: { id: '3', name: 'Done' } }] }) });

    const result = await transitionLocalIssue('LOCAL-1', { id: '3', name: 'Done' }, {});

    expect(result).toBe(false);
    expect(requestJira).toHaveBeenCalledTimes(2);
    expect(requestJira.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  });

  test('outgoing comments are blocked before the POST', async () => {
    requestJira.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        comments: [{
          id: '10001',
          body: { type: 'doc', content: [] },
          author: { displayName: 'Local User', accountType: 'atlassian' }
        }]
      })
    });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ comments: [] }) });

    const result = await syncAllComments('LOCAL-1', 'REMOTE-1', localIssue(), ORG, null, 'org-1');

    expect(result.failed).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });

  test('outgoing links are blocked before the POST', async () => {
    await expect(createLinkOnRemote(ORG, 'REMOTE-1', 'REMOTE-2', 'Relates', 'outward'))
      .rejects.toMatchObject({ code: 'PILOT_PAUSED', operation: 'link_create_remote' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('outgoing attachments are blocked before the upload', async () => {
    const issue = localIssue({
      attachment: [{ id: 'att-1', filename: 'file.txt', size: 4, content: 'https://local.example/file' }]
    });

    const result = await syncAttachments('LOCAL-1', 'REMOTE-1', issue, ORG, null, 'org-1');

    expect(result).toEqual({});
    expect(uploadRemoteAttachment).not.toHaveBeenCalled();
    expect(getRemoteIssueAttachments).toHaveBeenCalled();
  });

  test('inbound webhook writes are acknowledged and dropped for every covered event', async () => {
    seedOrganization('bidirectional');
    const events = [
      'jira:issue_created',
      'jira:issue_updated',
      'comment_created',
      'attachment_created',
      'jira:issue_link_created'
    ];

    for (const webhookEvent of events) {
      const result = await processIncomingWebhook({
        webhookEvent,
        issue: { key: 'REMOTE-1', fields: {} },
        comment: { id: '1' },
        attachment: { id: '1' },
        issueLink: { id: '1' }
      }, webhookAuth());

      expect(result).toEqual({
        status: 200,
        body: { message: 'Jira writes are paused', state: 'paused' }
      });
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(requestJira).not.toHaveBeenCalled();
    expect([...mockStore.keys()].some(key => key.startsWith('webhook-replay:'))).toBe(false);
  });

});

describe('Batch 7 reads, diagnostics and authorization', () => {
  test('read-only diagnostics remain available while paused', async () => {
    await pausePilot('maintenance', 'admin-1');
    getOrganizationsWithTokens.mockResolvedValue([{ ...ORG, remoteApiToken: 'remote-token' }]);
    fetchMock.mockImplementation(async url => {
      if (url.endsWith('/myself')) return { ok: true, json: async () => ({}) };
      if (url.includes('/project/')) return { ok: true, json: async () => ({}) };
      if (url.includes('/mypermissions')) {
        return {
          ok: true,
          json: async () => ({
            permissions: {
              CREATE_ISSUES: { havePermission: true },
              EDIT_ISSUES: { havePermission: true }
            }
          })
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    requestJira.mockResolvedValue({
      ok: true,
      json: async () => ({ permissions: { CREATE_ISSUES: { havePermission: true } } })
    });

    const definitions = {};
    defineDiagnosticsResolvers({ define: (name, fn) => { definitions[name] = fn; } });
    const result = await definitions.runHealthCheck({ payload: { orgId: 'org-1' } });

    expect(result.success).toBe(true);
    expect(result.steps.length).toBeGreaterThan(0);
  });

  test('pause and resume require existing administrator authorization', async () => {
    const definitions = {};
    definePilotResolvers({ define: (name, fn) => { definitions[name] = fn; } });

    expect(RESOLVER_POLICIES.getPilotStatus).toBe('ADMIN_READ');
    expect(RESOLVER_POLICIES.pausePilot).toBe('ADMIN_WRITE');
    expect(RESOLVER_POLICIES.resumePilot).toBe('ADMIN_WRITE');

    const denied = createAuthorizedHandler('pausePilot', definitions.pausePilot, {
      checkPermission: jest.fn(async () => false),
      recordAudit: jest.fn(async () => undefined)
    });
    await expect(denied({ context: { accountId: 'non-admin' }, payload: { reasonCode: 'maintenance' } }))
      .resolves.toEqual(forbiddenResponse());
    expect(mockStore.has(PILOT_PAUSE_KEY)).toBe(false);

    const allowed = createAuthorizedHandler('pausePilot', definitions.pausePilot, {
      checkPermission: jest.fn(async () => true),
      recordAudit: jest.fn(async () => undefined)
    });
    const result = await allowed({ context: { accountId: 'admin-1' }, payload: { reasonCode: 'maintenance' } });
    expect(result).toEqual(expect.objectContaining({ success: true, paused: true, pausedBy: 'admin-1' }));
  });

  test('PilotPausedError is a stable fail-closed error code', () => {
    const error = new PilotPausedError('comment_create_remote');
    expect(error.code).toBe('PILOT_PAUSED');
    expect(error.operation).toBe('comment_create_remote');
  });
});
