import { createRemoteIssue } from '../src/services/sync/issue-sync.js';
import { syncComment } from '../src/services/sync/comment-sync.js';
import { createLinkOnRemote } from '../src/services/sync/link-sync.js';
import { uploadAttachment } from '../src/services/jira/remote-client.js';
import api, { fetch } from '@forge/api';
import * as kvsStore from '../src/services/storage/kvs.js';
import {
  getOrganizationsWithTokens,
  getRemoteKey,
  getRemoteCommentId
} from '../src/services/storage/mappings.js';
import { getFullIssue, getFullComment, getOrgName } from '../src/services/jira/local-client.js';
import { isSyncing, markSyncing, clearSyncFlag } from '../src/services/storage/flags.js';
import { trackWebhookSync, trackApiCall } from '../src/services/storage/stats.js';

const mockOperationStore = new Map();

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  return {
    __esModule: true,
    default: { asApp: () => ({ requestJira }) },
    route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch: jest.fn()
  };
});

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(async key => (mockOperationStore.has(key) ? mockOperationStore.get(key) : null)),
  set: jest.fn(async (key, value) => { mockOperationStore.set(key, value); }),
  del: jest.fn(),
  createIfNotExists: jest.fn(async (key, value) => {
    if (mockOperationStore.has(key)) {
      const error = new Error('key already exists');
      error.code = 'KEY_ALREADY_EXISTS';
      throw error;
    }
    mockOperationStore.set(key, value);
  }),
  setIfNotExists: jest.fn(async (key, value) => {
    if (mockOperationStore.has(key)) {
      const error = new Error('key already exists');
      error.code = 'KEY_ALREADY_EXISTS';
      throw error;
    }
    mockOperationStore.set(key, value);
  }),
  getSecret: jest.fn()
}));

jest.mock('../src/services/storage/mappings.js', () => ({
  getRemoteKey: jest.fn(),
  getLocalKey: jest.fn(),
  getOrganizationsWithTokens: jest.fn(),
  storeMapping: jest.fn(),
  setLastSyncedLocalUpdated: jest.fn(),
  getRemoteCommentId: jest.fn(),
  storeCommentMapping: jest.fn(),
  getLinkMapping: jest.fn(),
  storeLinkMapping: jest.fn()
}));

jest.mock('../src/services/storage/flags.js', () => ({
  markSyncing: jest.fn(),
  clearSyncFlag: jest.fn(),
  isSyncing: jest.fn(),
  findPendingLinksToIssue: jest.fn(),
  removePendingLink: jest.fn(),
  storePendingLink: jest.fn()
}));

jest.mock('../src/services/storage/stats.js', () => ({
  trackWebhookSync: jest.fn(),
  logAuditEntry: jest.fn(),
  trackApiCall: jest.fn()
}));

jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn(),
  getFullComment: jest.fn(),
  getOrgName: jest.fn(),
  updateLocalIssueDescription: jest.fn(),
  uploadAttachment: jest.fn()
}));

jest.mock('../src/services/sync/attachment-sync.js', () => ({
  syncAttachments: jest.fn()
}));

jest.mock('../src/services/sync/transition-sync.js', () => ({
  transitionRemoteIssue: jest.fn()
}));

const org = {
  id: 'org-1',
  name: 'Target Org',
  remoteUrl: 'https://target.atlassian.net',
  remoteEmail: 'sync@example.com',
  remoteApiToken: 'token',
  remoteProjectKey: 'TARGET',
  allowedProjects: ['LOCAL']
};

const issue = {
  key: 'LOCAL-1',
  fields: {
    project: { key: 'LOCAL' },
    summary: 'Test issue',
    description: null,
    issuetype: { name: 'Task', id: '1' },
    updated: '2026-01-01T00:00:00.000Z',
    status: { name: 'To Do' },
    labels: []
  }
};

describe('Pilot safety: ambiguous non-idempotent writes are attempted once', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOperationStore.clear();
    api.asApp().requestJira.mockResolvedValue({ ok: true, json: async () => [] });
    fetch.mockRejectedValue(new Error('simulated network timeout'));
    getOrganizationsWithTokens.mockResolvedValue([org]);
    getRemoteKey.mockResolvedValue('REMOTE-1');
    getRemoteCommentId.mockResolvedValue(null);
    getFullIssue.mockResolvedValue(issue);
    getFullComment.mockResolvedValue({ id: 'C1', body: 'hello', author: { displayName: 'User' } });
    getOrgName.mockResolvedValue('Local Org');
    isSyncing.mockResolvedValue(false);
    kvsStore.get.mockImplementation(async (key) => {
      if (mockOperationStore.has(key)) return mockOperationStore.get(key);
      if (key === 'syncConfig') return null;
      if (key === 'syncOptions:org-1') return { syncComments: true };
      return null;
    });
  });

  test('ambiguous issue-create failure is attempted exactly once', async () => {
    const result = await createRemoteIssue(issue, org, {
      userMappings: {},
      fieldMappings: {},
      statusMappings: {},
      issueTypeMappings: {}
    }, null, {});

    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(markSyncing).toHaveBeenCalledWith('LOCAL-1');
    expect(clearSyncFlag).toHaveBeenCalledWith('LOCAL-1');
  });

  test('ambiguous issue-create HTTP 5xx is attempted exactly once', async () => {
    fetch.mockReset();
    fetch.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'upstream unavailable'
    });

    const result = await createRemoteIssue(issue, org, {
      userMappings: {},
      fieldMappings: {},
      statusMappings: {},
      issueTypeMappings: {}
    }, null, {});

    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('ambiguous comment-create failure is attempted exactly once', async () => {
    await syncComment({ issue: { key: 'LOCAL-1' }, comment: { id: 'C1' } });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(trackWebhookSync).toHaveBeenCalled();
  });

  test('ambiguous attachment-upload failure is attempted exactly once', async () => {
    const result = await uploadAttachment('REMOTE-1', 'file.txt', Buffer.from('data'), org);
    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('ambiguous issue-link failure is attempted exactly once', async () => {
    const result = await createLinkOnRemote(org, 'REMOTE-1', 'REMOTE-2', 'Relates', 'outward');
    expect(result.success).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
