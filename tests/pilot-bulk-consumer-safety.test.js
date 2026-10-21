import { run } from '../src/triggers/bulk-sync.js';
import api, { fetch } from '@forge/api';
import * as kvsStore from '../src/services/storage/kvs.js';
import { createRemoteIssue, updateRemoteIssue } from '../src/services/sync/issue-sync.js';
import { syncAttachments } from '../src/services/sync/attachment-sync.js';
import { syncIssueLinks } from '../src/services/sync/link-sync.js';
import { syncAllComments } from '../src/services/sync/comment-sync.js';

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
  getRemoteKey: jest.fn(),
  addToMappingIndex: jest.fn(),
  removeMapping: jest.fn(),
  getOrganizationsWithTokens: jest.fn(),
  storeMapping: jest.fn()
}));

jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn()
}));

jest.mock('../src/services/sync/issue-sync.js', () => ({
  createRemoteIssue: jest.fn(),
  updateRemoteIssue: jest.fn()
}));

jest.mock('../src/services/sync/attachment-sync.js', () => ({
  syncAttachments: jest.fn()
}));

jest.mock('../src/services/sync/link-sync.js', () => ({
  syncIssueLinks: jest.fn()
}));

jest.mock('../src/services/sync/comment-sync.js', () => ({
  syncAllComments: jest.fn()
}));

describe('Pilot safety: bulk-sync consumer is disabled', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('actual consumer handler returns disabled with zero Jira operations', async () => {
    const result = await run({
      body: { orgId: 'org-1', syncMissingData: true, updateExisting: true, dryRun: false }
    }, {});

    expect(result).toEqual(expect.objectContaining({
      success: false,
      code: 'BULK_SYNC_CONSUMER_DISABLED',
      message: expect.stringContaining('No Jira operations were performed')
    }));
    expect(api.asApp().requestJira).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(kvsStore.get).not.toHaveBeenCalled();
    expect(kvsStore.set).not.toHaveBeenCalled();
    expect(createRemoteIssue).not.toHaveBeenCalled();
    expect(updateRemoteIssue).not.toHaveBeenCalled();
    expect(syncAttachments).not.toHaveBeenCalled();
    expect(syncIssueLinks).not.toHaveBeenCalled();
    expect(syncAllComments).not.toHaveBeenCalled();
  });
});
