import { updateIssueForOrg } from '../src/services/sync/issue-sync.js';
import { updateLocalIssueDescription, getOrgName } from '../src/services/jira/local-client.js';
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

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(),
  set: jest.fn(),
  getSecret: jest.fn(),
  setSecret: jest.fn(),
  deleteSecret: jest.fn(),
  del: jest.fn(),
  setIfNotExists: jest.fn(),
  setWithTtl: jest.fn()
}));

jest.mock('../src/services/storage/mappings.js', () => ({
  getRemoteKey: jest.fn(),
  getLocalKey: jest.fn(),
  storeMapping: jest.fn(),
  getOrganizationsWithTokens: jest.fn(),
  setLastSyncedLocalUpdated: jest.fn()
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

const org = {
  id: 'org-1',
  name: 'Remote Org',
  remoteUrl: 'https://remote.example.invalid',
  remoteEmail: 'sync@example.invalid',
  remoteApiToken: 'test-token',
  remoteProjectKey: 'REMOTE'
};

function localIssue(description) {
  return {
    key: 'LOCAL-1',
    fields: {
      project: { key: 'LOCAL' },
      summary: 'Issue with description',
      description,
      issuetype: { name: 'Task', id: '1' },
      labels: [],
      components: [],
      fixVersions: [],
      versions: []
    }
  };
}

describe('Cross-reference local write safety', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fetch.mockResolvedValue({ ok: true, status: 204, text: async () => '' });
    getOrgName.mockResolvedValue('Local Org');
    updateLocalIssueDescription.mockResolvedValue(true);
  });

  test('conversion failure causes zero local description writes while outbound update succeeds', async () => {
    const malformed = { type: 'doc', version: 1, content: 'not-an-array' };
    const result = await updateIssueForOrg(
      'LOCAL-1',
      'REMOTE-1',
      localIssue(malformed),
      org,
      { userMappings: {}, fieldMappings: {}, statusMappings: {}, issueTypeMappings: {} },
      { syncCrossReference: true, syncAttachments: false, syncLinks: false, syncComments: false }
    );

    expect(result).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1]).toEqual(expect.objectContaining({ method: 'GET' }));
    expect(updateLocalIssueDescription).not.toHaveBeenCalled();
  });

  test('a valid description is updated locally only after preservation succeeds', async () => {
    const description = {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep this' }] }]
    };
    const result = await updateIssueForOrg(
      'LOCAL-1',
      'REMOTE-1',
      localIssue(description),
      org,
      { userMappings: {}, fieldMappings: {}, statusMappings: {}, issueTypeMappings: {} },
      { syncCrossReference: true, syncAttachments: false, syncLinks: false, syncComments: false }
    );

    expect(result).not.toBeNull();
    expect(updateLocalIssueDescription).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(updateLocalIssueDescription.mock.calls[0][1])).toContain('Keep this');
  });

  test('description synchronization works when cross-reference is disabled', async () => {
    const description = {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Disabled enhancement body' }] }]
    };
    const result = await updateIssueForOrg(
      'LOCAL-1',
      'REMOTE-1',
      localIssue(description),
      org,
      { userMappings: {}, fieldMappings: {}, statusMappings: {}, issueTypeMappings: {} },
      { syncCrossReference: false, syncAttachments: false, syncLinks: false, syncComments: false }
    );

    expect(result).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1]).toEqual(expect.objectContaining({ method: 'GET' }));
    expect(updateLocalIssueDescription).not.toHaveBeenCalled();
  });
});
