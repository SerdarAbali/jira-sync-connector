import { defineSyncResolvers } from '../src/resolvers/sync.js';
import { defineDiagnosticsResolvers } from '../src/resolvers/diagnostics.js';
import { Queue } from '@forge/events';
import api, { fetch } from '@forge/api';
import * as kvsStore from '../src/services/storage/kvs.js';
import { createRemoteIssue, updateRemoteIssue } from '../src/services/sync/issue-sync.js';
import { retryAllPendingLinks } from '../src/services/scheduled/scheduled-sync.js';

jest.mock('@forge/events', () => ({
  Queue: jest.fn()
}));

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

jest.mock('../src/services/scheduled/scheduled-sync.js', () => ({
  retryAllPendingLinks: jest.fn()
}));

function captureResolvers(defineResolvers) {
  const definitions = {};
  defineResolvers({ define: (name, fn) => { definitions[name] = fn; } });
  return definitions;
}

describe('Pilot safety: destructive resolvers are disabled', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('scanForDeletedIssues queues no work and performs no writes', async () => {
    const definitions = captureResolvers(defineSyncResolvers);

    const result = await definitions.scanForDeletedIssues({
      payload: { orgId: 'org-1', force: true, dryRun: false }
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      code: 'BULK_SCAN_RECREATE_DISABLED'
    }));
    expect(Queue).not.toHaveBeenCalled();
    expect(kvsStore.set).not.toHaveBeenCalled();
    expect(createRemoteIssue).not.toHaveBeenCalled();
    expect(updateRemoteIssue).not.toHaveBeenCalled();
    expect(retryAllPendingLinks).not.toHaveBeenCalled();
    expect(api.asApp().requestJira).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('runSystemTest performs no Jira writes', async () => {
    const definitions = captureResolvers(defineDiagnosticsResolvers);

    const result = await definitions.runSystemTest({ payload: { orgId: 'org-1' } });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      disabled: true,
      code: 'SYSTEM_TEST_DISABLED'
    }));
    expect(api.asApp().requestJira).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(kvsStore.set).not.toHaveBeenCalled();
  });
});
