import api from '@forge/api';
import { Queue } from '@forge/events';
import {
  JIRA_ADMIN_PERMISSION_ENDPOINT,
  checkJiraAdminPermission,
  createAuthorizedDefinitions,
  createAuthorizedHandler,
  forbiddenResponse
} from '../src/resolvers/authorization.js';
import {
  POLICY_CATEGORIES,
  RESOLVER_POLICIES
} from '../src/resolvers/authorization-policy.js';
import { handler } from '../src/resolvers/index.js';
import * as kvsStore from '../src/services/storage/kvs.js';
import logger from '../src/utils/logger.js';

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  return {
    __esModule: true,
    default: {
      asUser: jest.fn(() => ({ requestJira })),
      asApp: jest.fn(() => ({ requestJira }))
    },
    route: (strings, ...values) =>
      strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch: jest.fn(),
    webTrigger: { getUrl: jest.fn() }
  };
});

jest.mock('@forge/resolver', () => {
  const defs = {};
  class FakeResolver {
    define(name, fn) {
      defs[name] = fn;
    }
    getDefinitions() {
      return defs;
    }
  }
  return { __esModule: true, default: FakeResolver };
});

jest.mock('@forge/events', () => ({
  Queue: jest.fn(() => ({ push: jest.fn() }))
}));

jest.mock('@forge/kvs', () => {
  const get = jest.fn();
  const set = jest.fn();
  const getSecret = jest.fn();
  const setSecret = jest.fn();
  const deleteSecret = jest.fn();
  const del = jest.fn();
  return {
    __esModule: true,
    default: { get, set, getSecret, setSecret, deleteSecret, delete: del },
    WhereConditions: { beginsWith: jest.fn() }
  };
});

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(),
  set: jest.fn(),
  getSecret: jest.fn(),
  setSecret: jest.fn(),
  deleteSecret: jest.fn(),
  del: jest.fn()
}));

jest.mock('../src/utils/logger.js', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const userRequestJira = api.asUser().requestJira;
const userContext = { accountId: 'user-123' };

function request(payload = {}) {
  return { context: userContext, payload };
}

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

function resetStorageMocks() {
  kvsStore.get.mockResolvedValue(null);
  kvsStore.getSecret.mockResolvedValue(null);
  kvsStore.set.mockResolvedValue(undefined);
  kvsStore.setSecret.mockResolvedValue(undefined);
  kvsStore.deleteSecret.mockResolvedValue(undefined);
}


describe('Batch 2 Jira administrator permission check', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetStorageMocks();
  });

  test('uses api.asUser and the current Jira Get my permissions endpoint', async () => {
    allowAdmin();

    await expect(checkJiraAdminPermission()).resolves.toBe(true);
    expect(api.asUser).toHaveBeenCalled();
    expect(api.asApp).not.toHaveBeenCalled();
    expect(userRequestJira).toHaveBeenCalledWith(JIRA_ADMIN_PERMISSION_ENDPOINT);
  });

  test('denies a positive response without ADMINISTER', async () => {
    denyAdmin();

    await expect(checkJiraAdminPermission()).resolves.toBe(false);
  });

  test('denies a failed permission request', async () => {
    userRequestJira.mockResolvedValue({ ok: false, status: 403 });

    await expect(checkJiraAdminPermission()).resolves.toBe(false);
  });

  test('denies malformed permission responses', async () => {
    userRequestJira.mockResolvedValue({
      ok: true,
      json: async () => ({ permissions: {} })
    });

    await expect(checkJiraAdminPermission()).resolves.toBe(false);
  });

  test('denies a permission check exception', async () => {
    userRequestJira.mockRejectedValue(new Error('network failure'));

    await expect(checkJiraAdminPermission()).resolves.toBe(false);
  });
});

describe('Batch 2 default-deny resolver wrapper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetStorageMocks();
  });

  test('missing context is denied before permission lookup or resolver execution', async () => {
    const implementation = jest.fn().mockResolvedValue({ success: true });
    const checkPermission = jest.fn().mockResolvedValue(true);
    const recordAudit = jest.fn().mockResolvedValue(undefined);
    const wrapped = createAuthorizedHandler('getOrganizations', implementation, {
      policy: 'ADMIN_READ',
      checkPermission,
      recordAudit
    });

    await expect(wrapped({ payload: { apiToken: 'SECRET' } })).resolves.toEqual(forbiddenResponse());
    expect(checkPermission).not.toHaveBeenCalled();
    expect(implementation).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  test('missing accountId is denied before permission lookup or resolver execution', async () => {
    const implementation = jest.fn().mockResolvedValue({ success: true });
    const checkPermission = jest.fn().mockResolvedValue(true);
    const wrapped = createAuthorizedHandler('getOrganizations', implementation, {
      policy: 'ADMIN_READ',
      checkPermission
    });

    await expect(wrapped({ context: {} })).resolves.toEqual(forbiddenResponse());
    expect(checkPermission).not.toHaveBeenCalled();
    expect(implementation).not.toHaveBeenCalled();
  });

  test('non-admin permission response denies the resolver', async () => {
    const implementation = jest.fn().mockResolvedValue({ success: true });
    const wrapped = createAuthorizedHandler('getOrganizations', implementation, {
      policy: 'ADMIN_READ',
      checkPermission: jest.fn().mockResolvedValue(false)
    });

    await expect(wrapped(request())).resolves.toEqual(forbiddenResponse());
    expect(implementation).not.toHaveBeenCalled();
  });

  test('permission-check exception denies the resolver', async () => {
    const implementation = jest.fn().mockResolvedValue({ success: true });
    const wrapped = createAuthorizedHandler('getOrganizations', implementation, {
      policy: 'ADMIN_READ',
      checkPermission: jest.fn().mockRejectedValue(new Error('boom'))
    });

    await expect(wrapped(request())).resolves.toEqual(forbiddenResponse());
    expect(implementation).not.toHaveBeenCalled();
  });

  test('a resolver without a policy is denied by default', async () => {
    const implementation = jest.fn().mockResolvedValue({ success: true });
    const checkPermission = jest.fn().mockResolvedValue(true);
    const definitions = createAuthorizedDefinitions(
      { newlyAddedResolver: implementation },
      { policies: RESOLVER_POLICIES, checkPermission }
    );

    await expect(definitions.newlyAddedResolver(request())).resolves.toEqual(forbiddenResponse());
    expect(checkPermission).not.toHaveBeenCalled();
    expect(implementation).not.toHaveBeenCalled();
  });
});


describe('Batch 2 authorization audit and data hygiene', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetStorageMocks();
  });

  test('authorization responses and logs do not include secrets or payloads', async () => {
    const implementation = jest.fn().mockResolvedValue({ success: true });
    const wrapped = createAuthorizedHandler('getOrganizations', implementation, {
      policy: 'ADMIN_READ',
      checkPermission: jest.fn().mockResolvedValue(false)
    });
    const secretPayload = {
      apiToken: 'SECRET_API_TOKEN',
      incomingSecret: 'SECRET_WEBHOOK',
      authorization: 'Bearer SECRET_HEADER'
    };

    const result = await wrapped({ context: userContext, payload: secretPayload });
    const serializedLogs = JSON.stringify(logger.warn.mock.calls);

    expect(result).toEqual(forbiddenResponse());
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(serializedLogs).not.toContain('SECRET_API_TOKEN');
    expect(serializedLogs).not.toContain('SECRET_WEBHOOK');
    expect(serializedLogs).not.toContain('SECRET_HEADER');
  });

  test('ADMIN_WRITE audit records contain only safe identifiers and outcome', async () => {
    const implementation = jest.fn().mockResolvedValue({ success: true });
    const recordAudit = jest.fn().mockResolvedValue(undefined);
    const wrapped = createAuthorizedHandler('saveConfig', implementation, {
      policy: 'ADMIN_WRITE',
      checkPermission: jest.fn().mockResolvedValue(true),
      recordAudit
    });

    await wrapped(request({ apiToken: 'SECRET_API_TOKEN' }));

    expect(recordAudit).toHaveBeenCalledWith({
      action: 'saveConfig',
      actorAccountId: 'user-123',
      category: 'ADMIN_WRITE',
      success: true
    });
    expect(JSON.stringify(recordAudit.mock.calls)).not.toContain('SECRET_API_TOKEN');
  });

  test('DESTRUCTIVE audit records serialize failures without error details', async () => {
    const implementation = jest.fn().mockResolvedValue({
      success: false,
      error: 'SECRET_INTERNAL_ERROR'
    });
    const recordAudit = jest.fn().mockResolvedValue(undefined);
    const wrapped = createAuthorizedHandler('clearAuditLog', implementation, {
      policy: 'DESTRUCTIVE',
      checkPermission: jest.fn().mockResolvedValue(true),
      recordAudit
    });

    await wrapped(request());

    expect(recordAudit).toHaveBeenCalledWith({
      action: 'clearAuditLog',
      actorAccountId: 'user-123',
      category: 'DESTRUCTIVE',
      success: false
    });
    expect(JSON.stringify(recordAudit.mock.calls)).not.toContain('SECRET_INTERNAL_ERROR');
  });
});


describe('Batch 2 resolver inventory and actual handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetStorageMocks();
  });

  test('every currently registered resolver has an explicit valid policy', () => {
    const registered = Object.keys(handler).sort();
    const classified = Object.keys(RESOLVER_POLICIES).sort();

    expect(registered).toHaveLength(52);
    expect(registered).toEqual(classified);
    expect(RESOLVER_POLICIES.importOrgSettings).toBe('ADMIN_WRITE');
    expect(RESOLVER_POLICIES).not.toHaveProperty('importSettings');
    for (const resolverName of registered) {
      expect(POLICY_CATEGORIES).toContain(RESOLVER_POLICIES[resolverName]);
    }
  });

  test('confirmed administrator can invoke an ADMIN_READ resolver', async () => {
    allowAdmin();

    await expect(handler.getOrganizations(request())).resolves.toEqual([]);
    expect(userRequestJira).toHaveBeenCalledTimes(1);
  });

  test('confirmed administrator can invoke an ADMIN_WRITE resolver', async () => {
    allowAdmin();

    await expect(handler.saveConfig(request({ config: { remoteUrl: 'https://example.invalid' } })))
      .resolves.toEqual({ success: true });
    expect(kvsStore.set).toHaveBeenCalledWith(
      'syncConfig',
      { remoteUrl: 'https://example.invalid' }
    );
  });

  test('authorization is not cached across users', async () => {
    denyAdmin();
    await expect(handler.getOrganizations({ context: { accountId: 'user-1' }, payload: {} }))
      .resolves.toEqual(forbiddenResponse());

    allowAdmin();
    await expect(handler.getOrganizations({ context: { accountId: 'user-2' }, payload: {} }))
      .resolves.toEqual([]);

    expect(userRequestJira).toHaveBeenCalledTimes(2);
  });

  test('Jira permission request failures deny actual resolvers', async () => {
    userRequestJira.mockResolvedValueOnce({ ok: false, status: 403 });
    await expect(handler.getOrganizations({ context: { accountId: 'user-1' }, payload: {} }))
      .resolves.toEqual(forbiddenResponse());

    userRequestJira.mockRejectedValueOnce(new Error('permission endpoint unavailable'));
    await expect(handler.saveConfig(request({ config: { remoteUrl: 'https://example.invalid' } })))
      .resolves.toEqual(forbiddenResponse());

    expect(kvsStore.set).not.toHaveBeenCalled();
  });

  test('getOrganizations, saveConfig, exportIssues, clearAuditLog and triggerScheduledSync are denied to non-admin callers', async () => {
    denyAdmin();

    const cases = [
      ['getOrganizations', {}],
      ['saveConfig', { config: { apiToken: 'SECRET' } }],
      ['exportIssues', { jql: 'project = TEST' }],
      ['clearAuditLog', {}],
      ['triggerScheduledSync', {}]
    ];

    for (const [name, payload] of cases) {
      const result = await handler[name](request(payload));
      expect(result).toEqual(forbiddenResponse());
    }

    expect(kvsStore.set).not.toHaveBeenCalled();
    expect(Queue).not.toHaveBeenCalled();
  });

  test('importOrgSettings is protected correctly', async () => {
    denyAdmin();

    await expect(handler.importOrgSettings(request({
      orgId: 'org-1',
      data: { org: { remoteApiToken: 'SECRET_TOKEN' } }
    }))).resolves.toEqual(forbiddenResponse());
    expect(kvsStore.set).not.toHaveBeenCalled();
    expect(kvsStore.setSecret).not.toHaveBeenCalled();
  });

  test('scanForDeletedIssues is denied without admin and disabled after admin authorization', async () => {
    denyAdmin();
    await expect(handler.scanForDeletedIssues(request())).resolves.toEqual(forbiddenResponse());

    allowAdmin();
    const result = await handler.scanForDeletedIssues(request());
    expect(result).toEqual(expect.objectContaining({
      success: false,
      code: 'BULK_SCAN_RECREATE_DISABLED'
    }));
    expect(Queue).not.toHaveBeenCalled();
    expect(kvsStore.set).not.toHaveBeenCalled();
    expect(api.asApp).not.toHaveBeenCalled();
  });

  test('runSystemTest is denied without admin and disabled after admin authorization', async () => {
    denyAdmin();
    await expect(handler.runSystemTest(request())).resolves.toEqual(forbiddenResponse());

    allowAdmin();
    const result = await handler.runSystemTest(request());
    expect(result).toEqual(expect.objectContaining({
      success: false,
      disabled: true,
      code: 'SYSTEM_TEST_DISABLED'
    }));
    expect(kvsStore.set).not.toHaveBeenCalled();
  });
});
