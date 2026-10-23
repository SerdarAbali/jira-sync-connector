const mockStore = new Map();
const mockSecretStore = new Map();

jest.mock('@forge/events', () => ({
  Queue: jest.fn(() => ({ push: jest.fn() }))
}));

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

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(async key => (mockStore.has(key) ? mockStore.get(key) : null)),
  set: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  del: jest.fn(async key => { mockStore.delete(key); }),
  createIfNotExists: jest.fn(async (key, value) => {
    if (mockStore.has(key)) {
      const error = new Error('key already exists');
      error.code = 'KEY_ALREADY_EXISTS';
      throw error;
    }
    mockStore.set(key, value);
  }),
  setIfNotExists: jest.fn(async (key, value) => {
    if (mockStore.has(key)) {
      const error = new Error('key already exists');
      error.code = 'KEY_ALREADY_EXISTS';
      throw error;
    }
    mockStore.set(key, value);
  }),
  setWithTtl: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  getSecret: jest.fn(async key => (mockSecretStore.has(key) ? mockSecretStore.get(key) : null)),
  setSecret: jest.fn(async (key, value) => { mockSecretStore.set(key, value); })
}));


jest.mock('../src/services/storage/mappings.js', () => ({
  getRemoteKey: jest.fn(async () => null),
  getLocalKey: jest.fn(async () => null),
  storeMapping: jest.fn(async () => ({ idempotent: false })),
  replaceIssueMapping: jest.fn(),
  ensureMappingPair: jest.fn(),
  getOrganizationsWithTokens: jest.fn(async () => []),
  setLastSyncedLocalUpdated: jest.fn(),
  storeAttachmentMapping: jest.fn(),
  removeAttachmentMapping: jest.fn(),
  getAttachmentMapping: jest.fn(async () => null),
  storeLinkMapping: jest.fn(),
  removeLinkMapping: jest.fn(),
  getLinkMapping: jest.fn(async () => null),
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
  logAuditEntry: jest.fn(async () => undefined),
  trackWebhookSync: jest.fn(async () => undefined),
  trackApiCall: jest.fn()
}));

jest.mock('../src/services/storage/rejected-fields.js', () => ({
  recordRejectedFields: jest.fn(async () => undefined),
  getRejectedFields: jest.fn(async () => []),
  clearRejectedField: jest.fn()
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
  downloadRemoteAttachment: jest.fn(),
  getRemoteIssueAttachments: jest.fn(async () => [])
}));

jest.mock('../src/services/sync/attachment-sync.js', () => ({
  syncAttachments: jest.fn(async () => ({}))
}));

jest.mock('../src/services/sync/transition-sync.js', () => ({
  transitionRemoteIssue: jest.fn(async () => false),
  transitionLocalIssue: jest.fn(async () => false)
}));


const mockFetch = fetch;

const LOCAL_ONLY_SYNC_OPTIONS = {
  syncAttachments: false,
  syncLinks: false,
  syncComments: false,
  syncCrossReference: false
};

function makeOrg(overrides = {}) {
  return {
    id: 'org-1',
    name: 'Target Org',
    remoteUrl: 'https://remote.example',
    remoteEmail: 'sync@example.com',
    remoteApiToken: 'remote-token',
    remoteProjectKey: 'OTHER',
    allowedProjects: ['LOCAL'],
    ...overrides
  };
}

function localIssue(key = 'LOCAL-1') {
  return {
    key,
    fields: {
      project: { key: 'LOCAL' },
      summary: 'Manual sync issue',
      description: null,
      issuetype: { name: 'Task', id: '1' },
      status: { name: 'To Do' },
      updated: '2026-10-22T10:00:00.000Z',
      labels: [],
      attachment: [],
      issuelinks: []
    }
  };
}

function orgScopedKey(key, orgId) {
  return orgId === 'legacy' ? key : `${key}:${orgId}`;
}

function seedOrg(orgId, { projectMappings = {}, syncOptions = {} } = {}) {
  mockStore.set(orgScopedKey('userMappings', orgId), {});
  mockStore.set(orgScopedKey('fieldMappings', orgId), {});
  mockStore.set(orgScopedKey('statusMappings', orgId), {});
  mockStore.set(orgScopedKey('issueTypeMappings', orgId), {});
  mockStore.set(orgScopedKey('projectMappings', orgId), projectMappings);
  mockStore.set(orgScopedKey('syncOptions', orgId), { ...LOCAL_ONLY_SYNC_OPTIONS, ...syncOptions });
}

function captureResolvers() {
  const definitions = {};
  defineSyncResolvers({ define: (name, fn) => { definitions[name] = fn; } });
  return definitions;
}

function invokeForceSync(payload) {
  return captureResolvers().forceSyncIssue({ payload });
}

function createCalls() {
  return mockFetch.mock.calls.filter(([url, init]) =>
    typeof url === 'string'
      && url.endsWith('/rest/api/3/issue?notifyUsers=false')
      && init?.method === 'POST'
  );
}

function createdProjectKeys() {
  return createCalls().map(([, init]) => JSON.parse(init.body).fields.project.key);
}

beforeEach(() => {
  mockStore.clear();
  mockSecretStore.clear();
  jest.clearAllMocks();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({ key: 'CREATED-1' }),
    text: async () => ''
  });
  getRemoteKey.mockResolvedValue(null);
  getFullIssue.mockResolvedValue(localIssue());
  storeMapping.mockResolvedValue({ idempotent: false });
});


describe('F08 manual sync project routing', () => {
  test('manual create routes a mapped source project to its mapped target, not the org default', async () => {
    getOrganizationsWithTokens.mockResolvedValue([makeOrg()]);
    seedOrg('org-1', { projectMappings: { LOCAL: 'TARGET' } });

    const result = await invokeForceSync({ issueKey: 'LOCAL-1', orgId: 'org-1' });

    expect(result.success).toBe(true);
    expect(createdProjectKeys()).toEqual(['TARGET']);
    expect(storeMapping).toHaveBeenCalledWith('LOCAL-1', 'CREATED-1', 'org-1');
  });

  test('manual sync resolves project mappings independently for each organization', async () => {
    getOrganizationsWithTokens.mockResolvedValue([
      makeOrg(),
      makeOrg({
        id: 'org-2',
        name: 'Second Org',
        remoteUrl: 'https://remote2.example',
        remoteProjectKey: 'OTHER2'
      })
    ]);
    seedOrg('org-1', { projectMappings: { LOCAL: 'TARGET' } });
    seedOrg('org-2');

    const result = await invokeForceSync({ issueKey: 'LOCAL-1' });

    expect(result.success).toBe(true);
    const routes = createCalls().map(([url, init]) => [
      new URL(url).host,
      JSON.parse(init.body).fields.project.key
    ]);
    expect(routes).toEqual(expect.arrayContaining([
      ['remote.example', 'TARGET'],
      ['remote2.example', 'OTHER2']
    ]));
    expect(routes).toHaveLength(2);
  });

  test('an unmapped source project falls back to the organization default target', async () => {
    getOrganizationsWithTokens.mockResolvedValue([makeOrg()]);
    seedOrg('org-1', { projectMappings: {} });

    const result = await invokeForceSync({ issueKey: 'LOCAL-1', orgId: 'org-1' });

    expect(result.success).toBe(true);
    expect(createdProjectKeys()).toEqual(['OTHER']);
  });

  test('an invalid project mapping fails closed before any remote write', async () => {
    getOrganizationsWithTokens.mockResolvedValue([makeOrg()]);
    seedOrg('org-1', { projectMappings: { LOCAL: 'not-a-project-key' } });

    const result = await invokeForceSync({ issueKey: 'LOCAL-1', orgId: 'org-1' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('INVALID_PROJECT_MAPPING');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(storeMapping).not.toHaveBeenCalled();
  });

  test('a missing target project fails closed before any remote write', async () => {
    getOrganizationsWithTokens.mockResolvedValue([makeOrg({ remoteProjectKey: '' })]);
    seedOrg('org-1', { projectMappings: {} });

    const result = await invokeForceSync({ issueKey: 'LOCAL-1', orgId: 'org-1' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('TARGET_PROJECT_MISSING');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(storeMapping).not.toHaveBeenCalled();
  });


  test('a source project outside allowedProjects is never created remotely', async () => {
    getOrganizationsWithTokens.mockResolvedValue([makeOrg({ allowedProjects: ['SOMELSE'] })]);
    seedOrg('org-1', { projectMappings: { LOCAL: 'TARGET' } });

    const result = await invokeForceSync({ issueKey: 'LOCAL-1', orgId: 'org-1' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Project LOCAL not selected for sync');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(storeMapping).not.toHaveBeenCalled();
  });

  test('a legacy organization reads the unscoped projectMappings key', async () => {
    getOrganizationsWithTokens.mockResolvedValue([
      makeOrg({ id: 'legacy', name: 'Legacy Organization' })
    ]);
    seedOrg('legacy', { projectMappings: { LOCAL: 'TARGET' } });
    mockStore.set('projectMappings:legacy', { LOCAL: 'OTHER' });

    const result = await invokeForceSync({ issueKey: 'LOCAL-1', orgId: 'legacy' });

    expect(result.success).toBe(true);
    expect(createdProjectKeys()).toEqual(['TARGET']);
    expect(storeMapping).toHaveBeenCalledWith('LOCAL-1', 'CREATED-1', null);
  });

  test('updating an already-mapped issue never re-routes or recreates it', async () => {
    getOrganizationsWithTokens.mockResolvedValue([makeOrg()]);
    seedOrg('org-1', { projectMappings: { LOCAL: 'TARGET' } });
    getRemoteKey.mockResolvedValue('OTHER-5');

    const result = await invokeForceSync({ issueKey: 'LOCAL-1', orgId: 'org-1' });

    expect(result.success).toBe(true);
    expect(result.results[0].message).toContain('Updated');
    expect(createCalls()).toHaveLength(0);
    const updateCall = mockFetch.mock.calls.find(([url, init]) =>
      typeof url === 'string'
        && url.endsWith('/rest/api/3/issue/OTHER-5?notifyUsers=false')
        && init?.method === 'PUT'
    );
    expect(updateCall).toBeTruthy();
    expect(JSON.parse(updateCall[1].body).fields.project).toBeUndefined();
  });
});

import { fetch } from '@forge/api';
import { defineSyncResolvers } from '../src/resolvers/sync.js';
import {
  getOrganizationsWithTokens,
  getRemoteKey,
  storeMapping
} from '../src/services/storage/mappings.js';
import { getFullIssue } from '../src/services/jira/local-client.js';
