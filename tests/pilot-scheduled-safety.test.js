import { performScheduledSync } from '../src/services/scheduled/scheduled-sync.js';
import * as kvsStore from '../src/services/storage/kvs.js';
import { getOrganizationsWithTokens, getRemoteKey, getLocalKey } from '../src/services/storage/mappings.js';
import { getFullIssue } from '../src/services/jira/local-client.js';
import { updateRemoteIssue } from '../src/services/sync/issue-sync.js';
import { syncIssueLinks } from '../src/services/sync/link-sync.js';
import api, { fetch } from '@forge/api';

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
  get: jest.fn(),
  set: jest.fn(),
  getSecret: jest.fn(),
  del: jest.fn()
}));

jest.mock('../src/services/storage/mappings.js', () => ({
  getOrganizationsWithTokens: jest.fn(),
  getRemoteKey: jest.fn(),
  getLocalKey: jest.fn(),
  storeLinkMapping: jest.fn(),
  getLastSyncedLocalUpdated: jest.fn()
}));

jest.mock('../src/services/storage/flags.js', () => ({
  removePendingLink: jest.fn(),
  getPendingLinks: jest.fn(),
  removeIssueFromPendingLinksIndex: jest.fn()
}));

jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn()
}));

jest.mock('../src/services/sync/issue-sync.js', () => ({
  updateRemoteIssue: jest.fn()
}));

jest.mock('../src/services/sync/link-sync.js', () => ({
  syncIssueLinks: jest.fn()
}));

const ORG = {
  id: 'org-1',
  name: 'Target Org',
  remoteUrl: 'https://target.atlassian.net',
  remoteEmail: 'sync@example.com',
  remoteApiToken: 'token',
  remoteProjectKey: 'TARGET',
  allowedProjects: ['LOCAL']
};

describe('Pilot safety: scheduled sync is update-only and fail-closed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    require('./helpers/forge-lease-runtime').state.basicStore = new Map();
    getOrganizationsWithTokens.mockResolvedValue([ORG]);
    getRemoteKey.mockResolvedValue(null);
    getLocalKey.mockResolvedValue(null);
    getFullIssue.mockResolvedValue({
      key: 'LOCAL-1',
      fields: {
        updated: '2026-01-01T00:00:00.000Z',
        project: { key: 'LOCAL' },
        issuetype: { name: 'Task' }
      }
    });
    api.asApp().requestJira.mockResolvedValue({
      ok: true,
      json: async () => ({ issues: [{ key: 'LOCAL-1' }], isLast: true })
    });
  });

  test('missing scheduled configuration results in zero Jira writes', async () => {
    kvsStore.get.mockResolvedValue(null);

    const result = await performScheduledSync();

    expect(result.disabled).toBe(true);
    expect(result.reason).toBe('missing-or-malformed-config');
    expect(api.asApp().requestJira).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(kvsStore.set).not.toHaveBeenCalled();
    expect(updateRemoteIssue).not.toHaveBeenCalled();
  });

  test('malformed enabled flag results in zero Jira writes', async () => {
    kvsStore.get.mockImplementation(async (key) => {
      if (key === 'scheduledSyncConfig') return { enabled: 'true', syncScope: 'recent' };
      return null;
    });

    const result = await performScheduledSync();

    expect(result.disabled).toBe(true);
    expect(result.reason).toBe('invalid-enabled-flag');
    expect(api.asApp().requestJira).not.toHaveBeenCalled();
    expect(updateRemoteIssue).not.toHaveBeenCalled();
  });

  test('does not create or update issues for unmapped local issues', async () => {
    kvsStore.get.mockImplementation(async (key) => {
      if (key === 'scheduledSyncConfig') return { enabled: true, syncScope: 'recent' };
      return null;
    });

    const result = await performScheduledSync();

    expect(result.issuesCreated).toBe(0);
    expect(result.issuesRecreated).toBe(0);
    expect(getRemoteKey).toHaveBeenCalledWith('LOCAL-1', 'org-1');
    expect(getRemoteKey).not.toHaveBeenCalledWith('LOCAL-1', null);
    expect(updateRemoteIssue).not.toHaveBeenCalled();
    expect(syncIssueLinks).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(api.asApp().requestJira).toHaveBeenCalledTimes(1);
  });
});
