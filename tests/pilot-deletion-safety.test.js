import { run as runIssueDeleted } from '../src/triggers/issue-deleted.js';
import { processIncomingWebhook } from '../src/services/sync/incoming-sync.js';
import { getOrganizationsWithTokens, getRemoteKey, getLocalKey } from '../src/services/storage/mappings.js';
import { logAuditEntry } from '../src/services/storage/stats.js';
import * as kvsStore from '../src/services/storage/kvs.js';
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

jest.mock('../src/services/storage/mappings.js', () => ({
  getOrganizationsWithTokens: jest.fn(),
  getRemoteKey: jest.fn(),
  getLocalKey: jest.fn(),
  storeMapping: jest.fn(),
  storeAttachmentMapping: jest.fn(),
  getAttachmentMapping: jest.fn(),
  storeLinkMapping: jest.fn(),
  getLocalCommentId: jest.fn(),
  storeCommentMapping: jest.fn()
}));

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(),
  getSecret: jest.fn(),
  set: jest.fn(),
  setIfNotExists: jest.fn(),
  setWithTtl: jest.fn(),
  del: jest.fn()
}));

jest.mock('../src/services/storage/flags.js', () => ({
  markSyncing: jest.fn(),
  isSyncing: jest.fn(),
  clearSyncFlag: jest.fn(),
  enqueuePendingChildIssue: jest.fn(),
  consumePendingChildIssues: jest.fn()
}));

jest.mock('../src/services/storage/rejected-fields.js', () => ({
  recordRejectedFields: jest.fn()
}));

jest.mock('../src/services/storage/stats.js', () => ({
  logAuditEntry: jest.fn(),
  trackWebhookSync: jest.fn(),
  trackApiCall: jest.fn()
}));

jest.mock('../src/services/jira/remote-client.js', () => ({
  getRemoteIssue: jest.fn(),
  getRemoteComment: jest.fn()
}));

jest.mock('../src/services/jira/local-client.js', () => ({
  uploadAttachment: jest.fn(),
  getFullIssue: jest.fn()
}));

jest.mock('../src/services/sync/transition-sync.js', () => ({
  transitionLocalIssue: jest.fn()
}));

jest.mock('../src/utils/mapping.js', () => ({
  mapUserToLocal: jest.fn()
}));

describe('Pilot safety: deletion propagation is disabled', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  jest.requireMock('../src/services/jira/local-client.js').getFullIssue.mockResolvedValue({ key: 'LOCAL-1', fields: { project: { key: 'LOCAL' } } });
    getOrganizationsWithTokens.mockResolvedValue([{ id: 'org-1', name: 'Target Org' }]);
    getRemoteKey.mockResolvedValue('REMOTE-1');
    getLocalKey.mockResolvedValue('LOCAL-1');
    logAuditEntry.mockResolvedValue(undefined);
  });

  test('local issue deletion performs zero remote DELETE calls and keeps the mapping', async () => {
    await runIssueDeleted({ issue: { key: 'LOCAL-1', id: '10001' } });

    expect(fetch).not.toHaveBeenCalled();
    expect(api.asApp().requestJira).not.toHaveBeenCalled();
    expect(logAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      action: 'delete-blocked',
      sourceIssue: 'LOCAL-1',
      targetIssue: 'REMOTE-1',
      orgId: 'org-1'
    }));
    expect(getRemoteKey).toHaveBeenCalledWith('LOCAL-1', 'org-1');
    expect(kvsStore.set).toHaveBeenCalledWith(
      'counterpart-status:org-1:LOCAL-1:REMOTE-1',
      expect.objectContaining({
        localKey: 'LOCAL-1',
        remoteKey: 'REMOTE-1',
        status: 'confirmed_deleted',
        deletedSide: 'local'
      })
    );
    expect(kvsStore.del).not.toHaveBeenCalled();
  });

  test('deletion without an issue key skips mapping lookup safely', async () => {
    await runIssueDeleted({ issue: { id: '10001' } });

    expect(getRemoteKey).not.toHaveBeenCalled();
    expect(getOrganizationsWithTokens).not.toHaveBeenCalled();
    expect(logAuditEntry).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(api.asApp().requestJira).not.toHaveBeenCalled();
  });

  test('remote issue deletion performs zero local DELETE calls and keeps the mapping', async () => {
    const kvsStore = await import('../src/services/storage/kvs.js');
    kvsStore.setIfNotExists.mockResolvedValue(undefined);
    kvsStore.setWithTtl.mockResolvedValue(undefined);
    kvsStore.get.mockImplementation(async (key) => {
      if (key === 'organizations') {
        return [{ id: 'org-1', name: 'Remote Org', syncDirection: 'bidirectional', allowedProjects: ['LOCAL'] }];
      }
      return null;
    });
    kvsStore.getSecret.mockImplementation(async (key) => {
      if (key === 'secret:org-1:incomingSecret') return 'shared-secret-0123456789abcdef';
      if (key === 'secret:org-1:token') return 'remote-token';
      return null;
    });

    const result = await processIncomingWebhook(
      { webhookEvent: 'jira:issue_deleted', issue: { key: 'REMOTE-1' } },
      { orgId: 'org-1', credential: 'shared-secret-0123456789abcdef' }
    );

    expect(result.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect(api.asApp().requestJira).not.toHaveBeenCalled();
    expect(logAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      action: 'remote-delete-blocked',
      sourceIssue: 'LOCAL-1',
      targetIssue: 'REMOTE-1',
      orgId: 'org-1'
    }));
    expect(kvsStore.set).toHaveBeenCalledWith(
      'counterpart-status:org-1:LOCAL-1:REMOTE-1',
      expect.objectContaining({
        localKey: 'LOCAL-1',
        remoteKey: 'REMOTE-1',
        status: 'confirmed_deleted',
        deletedSide: 'remote'
      })
    );
    expect(kvsStore.del).not.toHaveBeenCalled();
  });
});
