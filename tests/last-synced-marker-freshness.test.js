// The synchronization authorization gate has its own suite; this suite tests another behaviour.
jest.mock('../src/services/sync/sync-authorization.js', () => require('./helpers/authorized-sync-authorization.js'));
jest.mock('../src/services/sync/pair-witness-guard.js', () => require('./helpers/pair-witness-create-mocks.js').guardModule);
jest.mock('../src/services/sync/pair-witness-establishment.js', () => require('./helpers/pair-witness-create-mocks.js').establishmentModule);

import { createIssueForOrg, updateIssueForOrg } from '../src/services/sync/issue-sync.js';
import { getFullIssue, getOrgName, updateLocalIssueDescription } from '../src/services/jira/local-client.js';
import { setLastSyncedLocalUpdated, storeMapping } from '../src/services/storage/mappings.js';
import { prependCrossReferenceToADF } from '../src/utils/adf.js';
import { fetch } from '@forge/api';

jest.mock('@forge/api', () => ({
  __esModule: true,
  default: {
    asApp: () => ({ requestJira: jest.fn() })
  },
  route: (strings, ...values) =>
    strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
  fetch: jest.fn()
}));

const mockStore = new Map();

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
  getOrganizationsWithTokens: jest.fn(),
  setLastSyncedLocalUpdated: jest.fn(),
  storeLinkMapping: jest.fn(),
  replaceIssueMapping: jest.fn()
}));

jest.mock('../src/services/storage/flags.js', () => ({
  markSyncing: jest.fn(),
  clearSyncFlag: jest.fn(),
  isSyncing: jest.fn(),
  findPendingLinksToIssue: jest.fn(),
  removePendingLink: jest.fn()
}));

jest.mock('../src/services/storage/stats.js', () => ({
  trackWebhookSync: jest.fn(),
  trackApiCall: jest.fn(),
  logAuditEntry: jest.fn()
}));

jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn(),
  getOrgName: jest.fn(),
  updateLocalIssueDescription: jest.fn()
}));

jest.mock('../src/services/sync/attachment-sync.js', () => ({
  syncAttachments: jest.fn()
}));

jest.mock('../src/services/sync/link-sync.js', () => ({
  syncIssueLinks: jest.fn(),
  createLinkOnRemote: jest.fn()
}));

jest.mock('../src/services/sync/comment-sync.js', () => ({
  syncAllComments: jest.fn()
}));

jest.mock('../src/services/sync/transition-sync.js', () => ({
  transitionRemoteIssue: jest.fn()
}));

jest.mock('../src/services/storage/rejected-fields.js', () => ({
  recordRejectedFields: jest.fn()
}));

const org = {
  id: 'org-1',
  name: 'Remote Org',
  remoteUrl: 'https://remote.example.invalid',
  remoteEmail: 'sync@example.invalid',
  remoteApiToken: 'test-token',
  remoteProjectKey: 'REMOTE'
};

const LOCAL_KEY = 'LOCAL-1';
// Timestamp read together with the issue snapshot, i.e. before the connector
// writes the cross-reference back into the local description.
const SNAPSHOT_UPDATED = '2026-10-21T12:00:00.000Z';
// Authoritative timestamp after that local write.
const POST_WRITE_UPDATED = '2026-10-21T12:00:09.000Z';

const DESCRIPTION = {
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep this' }] }]
};

function localIssue(description = DESCRIPTION) {
  return {
    key: LOCAL_KEY,
    fields: {
      project: { key: 'LOCAL' },
      summary: 'Issue with description',
      description,
      issuetype: { name: 'Task', id: '10001' },
      status: { name: 'To Do' },
      updated: SNAPSHOT_UPDATED,
      labels: [],
      components: [],
      fixVersions: [],
      versions: []
    }
  };
}

function mappings() {
  return { userMappings: {}, fieldMappings: {}, statusMappings: {}, issueTypeMappings: {} };
}

function lastMarkerValue() {
  const calls = setLastSyncedLocalUpdated.mock.calls;
  return calls.length > 0 ? calls[calls.length - 1] : null;
}


describe('Last-synced marker freshness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStore.clear();
    mockStore.set('organizations', [{ ...org, allowedProjects: ['LOCAL'] }]);
    getOrgName.mockResolvedValue('Local Org');
    getFullIssue.mockResolvedValue({
      key: LOCAL_KEY,
      fields: { project: { key: 'LOCAL' }, updated: POST_WRITE_UPDATED }
    });
    updateLocalIssueDescription.mockResolvedValue(true);
    storeMapping.mockResolvedValue({ localKey: LOCAL_KEY, remoteKey: 'REMOTE-9', idempotent: false });
    fetch.mockResolvedValue({ ok: true, status: 204, text: async () => '', json: async () => ({}) });
  });

  test('create path stores the timestamp of the local cross-reference write', async () => {
    fetch.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ key: 'REMOTE-9' }) });

    const result = await createIssueForOrg(localIssue(), org, mappings(), {
      syncAttachments: false,
      syncLinks: false,
      syncComments: false
    });

    expect(result).toEqual(expect.objectContaining({ key: 'REMOTE-9' }));
    expect(updateLocalIssueDescription).toHaveBeenCalledTimes(1);
    expect(lastMarkerValue()).toEqual([LOCAL_KEY, POST_WRITE_UPDATED, 'org-1']);
    expect(setLastSyncedLocalUpdated).not.toHaveBeenCalledWith(LOCAL_KEY, SNAPSHOT_UPDATED, 'org-1');
  });

  test('create path re-reads the issue after the local write', async () => {
    fetch.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ key: 'REMOTE-9' }) });

    await createIssueForOrg(localIssue(), org, mappings(), {
      syncAttachments: false,
      syncLinks: false,
      syncComments: false
    });

    const writeOrder = updateLocalIssueDescription.mock.invocationCallOrder[0];
    const refreshOrder = getFullIssue.mock.invocationCallOrder[getFullIssue.mock.invocationCallOrder.length - 1];
    expect(writeOrder).toBeDefined();
    expect(refreshOrder).toBeGreaterThan(writeOrder);
    expect(getFullIssue).toHaveBeenCalledWith(LOCAL_KEY);
  });

  test('create path keeps the snapshot timestamp when no local write happened', async () => {
    fetch.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ key: 'REMOTE-9' }) });

    const result = await createIssueForOrg(localIssue(), org, mappings(), {
      syncAttachments: false,
      syncLinks: false,
      syncComments: false,
      syncCrossReference: false
    });

    expect(result).toEqual(expect.objectContaining({ key: 'REMOTE-9' }));
    expect(updateLocalIssueDescription).not.toHaveBeenCalled();
    expect(lastMarkerValue()).toEqual([LOCAL_KEY, SNAPSHOT_UPDATED, 'org-1']);
  });

  test('create path does not claim freshness when the timestamp cannot be refreshed', async () => {
    fetch.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ key: 'REMOTE-9' }) });
    // The outbound-scope assertion reads the issue before the write; only the
    // post-write refresh is unavailable here.
    getFullIssue.mockImplementation(async () => {
      if (updateLocalIssueDescription.mock.calls.length > 0) throw new Error('local read failed');
      return { key: LOCAL_KEY, fields: { project: { key: 'LOCAL' }, updated: POST_WRITE_UPDATED } };
    });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await createIssueForOrg(localIssue(), org, mappings(), {
      syncAttachments: false,
      syncLinks: false,
      syncComments: false
    });

    expect(result).toEqual(expect.objectContaining({ key: 'REMOTE-9' }));
    expect(lastMarkerValue()).toEqual([LOCAL_KEY, SNAPSHOT_UPDATED, 'org-1']);
    expect(setLastSyncedLocalUpdated).not.toHaveBeenCalledWith(LOCAL_KEY, POST_WRITE_UPDATED, 'org-1');
    expect(log.mock.calls.flat().join(' ')).toContain('Could not refresh last-synced marker');
    log.mockRestore();
  });

  test('update path stores the timestamp of the repaired local cross-reference', async () => {
    const details = await updateIssueForOrg(
      LOCAL_KEY,
      'REMOTE-1',
      localIssue(),
      org,
      mappings(),
      { syncCrossReference: true, syncAttachments: false, syncLinks: false, syncComments: false }
    );

    expect(details).not.toBeNull();
    expect(updateLocalIssueDescription).toHaveBeenCalledTimes(1);
    expect(lastMarkerValue()).toEqual([LOCAL_KEY, POST_WRITE_UPDATED, 'org-1']);
    expect(setLastSyncedLocalUpdated).not.toHaveBeenCalledWith(LOCAL_KEY, SNAPSHOT_UPDATED, 'org-1');
  });

  test('update path keeps the snapshot timestamp when the reference is already current', async () => {
    const descriptionWithReference = prependCrossReferenceToADF(DESCRIPTION, LOCAL_KEY, 'REMOTE-1');

    const details = await updateIssueForOrg(
      LOCAL_KEY,
      'REMOTE-1',
      localIssue(descriptionWithReference),
      org,
      mappings(),
      { syncCrossReference: true, syncAttachments: false, syncLinks: false, syncComments: false }
    );

    expect(details).not.toBeNull();
    expect(updateLocalIssueDescription).not.toHaveBeenCalled();
    expect(lastMarkerValue()).toEqual([LOCAL_KEY, SNAPSHOT_UPDATED, 'org-1']);
  });

  test('update path does not claim freshness when the timestamp cannot be refreshed', async () => {
    getFullIssue.mockImplementation(async () => {
      if (updateLocalIssueDescription.mock.calls.length > 0) throw new Error('local read failed');
      return { key: LOCAL_KEY, fields: { project: { key: 'LOCAL' }, updated: POST_WRITE_UPDATED } };
    });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    const details = await updateIssueForOrg(
      LOCAL_KEY,
      'REMOTE-1',
      localIssue(),
      org,
      mappings(),
      { syncCrossReference: true, syncAttachments: false, syncLinks: false, syncComments: false }
    );

    expect(details).not.toBeNull();
    expect(updateLocalIssueDescription).toHaveBeenCalledTimes(1);
    expect(lastMarkerValue()).toEqual([LOCAL_KEY, SNAPSHOT_UPDATED, 'org-1']);
    expect(log.mock.calls.flat().join(' ')).toContain('Could not refresh last-synced marker');
    log.mockRestore();
  });
});
