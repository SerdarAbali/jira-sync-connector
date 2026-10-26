import { handler, registeredResolverNames } from '../src/resolvers/index.js';
import { createAuthorizedResolver, forbiddenResponse } from '../src/resolvers/authorization.js';
import { RESOLVER_POLICIES } from '../src/resolvers/authorization-policy.js';
import * as kvsStore from '../src/services/storage/kvs.js';
import api from '@forge/api';

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  const webTrigger = { getUrl: jest.fn() };
  return {
    __esModule: true,
    default: {
      asUser: jest.fn(() => ({ requestJira })),
      asApp: jest.fn(() => ({ requestJira })),
      webTrigger,
      fetch: jest.fn()
    },
    route: (strings, ...values) =>
      strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch: jest.fn(),
    webTrigger
  };
});

jest.mock('@forge/events', () => ({
  Queue: jest.fn(() => ({ push: jest.fn() }))
}));

jest.mock('@forge/kvs', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    set: jest.fn(),
    getSecret: jest.fn(),
    setSecret: jest.fn(),
    deleteSecret: jest.fn(),
    delete: jest.fn()
  },
  WhereConditions: { beginsWith: jest.fn() }
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

jest.mock('../src/services/storage/stats.js', () => ({
  logAuditEntry: jest.fn(),
  trackWebhookSync: jest.fn(),
  trackApiCall: jest.fn()
}));

jest.mock('../src/utils/logger.js', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const userRequestJira = api.asUser().requestJira;

function allowAdmin() {
  userRequestJira.mockResolvedValue({
    ok: true,
    json: async () => ({ permissions: { ADMINISTER: { havePermission: true } } })
  });
}

function denyAdmin() {
  userRequestJira.mockResolvedValue({
    ok: true,
    json: async () => ({ permissions: { ADMINISTER: { havePermission: false } } })
  });
}

function invoke(functionKey, payload = {}, accountId = 'user-123') {
  return handler(
    { call: { functionKey, payload, jobId: 'regression-job' }, context: {} },
    { principal: { accountId } }
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  allowAdmin();
  kvsStore.get.mockResolvedValue(null);
  kvsStore.getSecret.mockResolvedValue(null);
  kvsStore.set.mockResolvedValue(undefined);
  kvsStore.setSecret.mockResolvedValue(undefined);
  kvsStore.deleteSecret.mockResolvedValue(undefined);
  kvsStore.del.mockResolvedValue(undefined);
  kvsStore.setIfNotExists.mockResolvedValue(undefined);
  kvsStore.setWithTtl.mockResolvedValue(undefined);
});

describe('Forge resolver handler regression', () => {
  test('exports the callable handler, not an empty object', () => {
    expect(typeof handler).toBe('function');
    expect(handler).not.toEqual({});
    expect(Object.keys(handler)).toHaveLength(0);
  });

  test('all registered names have explicit policy entries', () => {
    const registered = [...registeredResolverNames].sort();
    const classified = Object.keys(RESOLVER_POLICIES).sort();

    expect(registered).toHaveLength(85);
    expect(registered).toEqual(classified);
    expect(registered).toContain('getIssueCreateOperationStatus');
    expect(registered).toContain('getConnectorReadiness');
    expect(registered).toContain('exportRecoverySnapshot');
    expect(registered).toContain('previewRecoverySnapshot');
    expect(registered).toContain('activateIssueLeaseMigration');
    expect(registered).toContain('initializeFreshIssueLeases');
  });

  test('getOrganizations reaches its resolver and reads the organizations key after authorization', async () => {
    kvsStore.get.mockImplementation(async (key) => {
      if (key === 'organizations') return [{ id: 'org-1', name: 'Org', syncDirection: 'push' }];
      return null;
    });

    const result = await invoke('getOrganizations');

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(kvsStore.get).toHaveBeenCalledWith('organizations');
    expect(userRequestJira.mock.invocationCallOrder[0])
      .toBeLessThan(kvsStore.get.mock.invocationCallOrder[0]);
  });

  test('failed authorization prevents the organizations KVS read', async () => {
    denyAdmin();

    await expect(invoke('getOrganizations')).resolves.toEqual(forbiddenResponse());
    expect(kvsStore.get).not.toHaveBeenCalled();
  });

  test('an unknown resolver is registered as default-denied', async () => {
    const implementation = jest.fn().mockResolvedValue({ success: true });
    const checkPermission = jest.fn().mockResolvedValue(true);
    const resolver = createAuthorizedResolver({
      policies: RESOLVER_POLICIES,
      checkPermission
    });
    resolver.define('unclassifiedResolver', implementation);
    const callable = resolver.getDefinitions();

    const result = await callable(
      { call: { functionKey: 'unclassifiedResolver', payload: {} }, context: {} },
      { principal: { accountId: 'user-123' } }
    );

    expect(result).toEqual(forbiddenResponse());
    expect(checkPermission).not.toHaveBeenCalled();
    expect(implementation).not.toHaveBeenCalled();
  });

  test('runSystemTest and scanForDeletedIssues remain disabled after authorization', async () => {
    const systemTest = await invoke('runSystemTest');
    expect(systemTest).toEqual(expect.objectContaining({
      success: false,
      disabled: true,
      code: 'SYSTEM_TEST_DISABLED'
    }));

    const scan = await invoke('scanForDeletedIssues');
    expect(scan).toEqual(expect.objectContaining({
      success: false,
      code: 'BULK_SCAN_RECREATE_DISABLED'
    }));
  });
});
