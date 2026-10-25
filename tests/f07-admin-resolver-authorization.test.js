/**
 * Authorization regressions for the readiness and F07 activation resolvers.
 *
 * The real authorization wrapper, policy inventory and Jira permission check
 * are exercised. Forge storage and transport are replaced at their module
 * boundary because the decision under test is authorization, not storage.
 */
const APP_ARI = 'ari:cloud:ecosystem::app/362d8e6b-b68c-4403-8020-d32ddcc02716';
const APP_UUID = '362d8e6b-b68c-4403-8020-d32ddcc02716';

jest.mock('@forge/api', () => {
  const permissionResponse = jest.fn(async () => ({
    ok: true,
    json: async () => ({ permissions: { ADMINISTER: { havePermission: true } } })
  }));
  return {
    __esModule: true,
    __permissionResponse: permissionResponse,
    default: {
      asUser: () => ({ requestJira: permissionResponse }),
      asApp: () => ({
        requestJira: async () => ({
          ok: true,
          json: async () => ({ baseUrl: 'https://localstaging.atlassian.net' })
        })
      })
    },
    getAppContext: () => ({
      appAri: { appId: APP_UUID, toString: () => APP_ARI },
      appVersion: '3.0.0',
      environmentAri: { environmentId: 'env-staging' },
      environmentType: 'staging',
      installationAri: { installationId: 'install-1' },
      installation: { contexts: [{ cloudId: 'cloud-1' }] }
    }),
    route: (strings, ...values) =>
      strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch: jest.fn(),
    webTrigger: { getUrl: jest.fn() }
  };
});

jest.mock('@forge/kvs', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async (key) => {
      if (key === 'organizations') {
        return [{ id: 'org-1', remoteProjectKey: 'RSTG', allowedProjects: ['STG'], syncDirection: 'bidirectional' }];
      }
      if (key === 'projectMappings:org-1') return { STG: 'RSTG' };
      if (key === 'syncOptions:org-1') return { syncComments: true };
      if (key === 'issueLeaseMigration:v1') {
        return {
          version: 1,
          phase: 'entity-active',
          legacyDisabled: true,
          disabledAt: 0,
          activatedAt: 1140000
        };
      }
      return null;
    }),
    getSecret: jest.fn(async (key) => (key.includes('webhookSigningSecret') ? 'present' : null)),
    set: jest.fn(),
    setSecret: jest.fn(),
    deleteSecret: jest.fn(),
    delete: jest.fn(),
    query: jest.fn(),
    transact: jest.fn(),
    entity: jest.fn()
  },
  WhereConditions: {}
}));

jest.mock('../src/utils/logger.js', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

jest.mock('../src/services/storage/stats.js', () => ({
  logAuditEntry: jest.fn(async () => {})
}));

const forgeApi = require('@forge/api');
const kvs = require('@forge/kvs').default;
const { logAuditEntry } = require('../src/services/storage/stats');
const {
  RESOLVER_POLICIES,
  POLICY_CATEGORIES
} = require('../src/resolvers/authorization-policy');
const { createAuthorizedHandler } = require('../src/resolvers/authorization');
const { defineReadinessResolvers } = require('../src/resolvers/readiness');
const { defineLeaseMigrationResolvers } = require('../src/resolvers/lease-migration');
const { ACTIVATION_CONFIRMATION } = require('../src/services/sync/lease-migration-activation');

const READINESS = 'getConnectorReadiness';
const ACTIVATION = 'activateIssueLeaseMigration';
const INITIALIZATION = 'initializeFreshIssueLeases';

function registeredHandlers() {
  const handlers = {};
  const resolver = { define: (name, fn) => { handlers[name] = fn; } };
  defineReadinessResolvers(resolver);
  defineLeaseMigrationResolvers(resolver);
  return handlers;
}

function invoke(handlers, name, request) {
  return createAuthorizedHandler(name, handlers[name])(request);
}

describe('F07 administration authorization', () => {
  const handlers = registeredHandlers();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('registers both operations under explicit policy categories', () => {
    expect(POLICY_CATEGORIES).toContain('ADMIN_READ');
    expect(POLICY_CATEGORIES).toContain('ADMIN_WRITE');
    expect(RESOLVER_POLICIES[READINESS]).toBe('ADMIN_READ');
    expect(RESOLVER_POLICIES[ACTIVATION]).toBe('ADMIN_WRITE');
    expect(RESOLVER_POLICIES[INITIALIZATION]).toBe('ADMIN_WRITE');
  });

  it('denies readiness without an authenticated administrator context', async () => {
    await expect(invoke(handlers, READINESS, {})).resolves.toMatchObject({ code: 'FORBIDDEN' });
    await expect(invoke(handlers, READINESS, { context: {} })).resolves.toMatchObject({
      code: 'FORBIDDEN'
    });
    expect(kvs.get).not.toHaveBeenCalled();
  });

  it('denies readiness when the caller lacks Jira ADMINISTER', async () => {
    forgeApi.__permissionResponse.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({ permissions: { ADMINISTER: { havePermission: false } } })
    }));

    const result = await invoke(handlers, READINESS, { context: { accountId: 'account-1' } });
    expect(result).toMatchObject({ success: false, code: 'FORBIDDEN' });
    expect(kvs.get).not.toHaveBeenCalled();
    expect(logAuditEntry).not.toHaveBeenCalled();
  });

  it('denies readiness when the permission check fails or returns malformed data', async () => {
    forgeApi.__permissionResponse.mockRejectedValueOnce(new Error('transport down'));
    await expect(invoke(handlers, READINESS, { context: { accountId: 'account-1' } }))
      .resolves.toMatchObject({ code: 'FORBIDDEN' });

    forgeApi.__permissionResponse.mockResolvedValueOnce({ ok: false, status: 403 });
    await expect(invoke(handlers, READINESS, { context: { accountId: 'account-1' } }))
      .resolves.toMatchObject({ code: 'FORBIDDEN' });

    forgeApi.__permissionResponse.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await expect(invoke(handlers, READINESS, { context: { accountId: 'account-1' } }))
      .resolves.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('serves readiness to an authenticated administrator and records no write audit', async () => {
    const result = await invoke(handlers, READINESS, { context: { accountId: 'account-1' } });

    expect(result).toMatchObject({
      success: true,
      source: 'authenticated-connector',
      appId: APP_UUID,
      appAri: APP_ARI,
      environment: 'staging',
      paused: false
    });
    expect(result.f07Status.valid).toBe(true);
    expect(result.mappings).toHaveLength(1);
    expect(logAuditEntry).not.toHaveBeenCalled();
  });

  it('denies activation without the administrator permission and never reaches storage', async () => {
    forgeApi.__permissionResponse.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({ permissions: { ADMINISTER: { havePermission: false } } })
    }));

    const result = await invoke(handlers, ACTIVATION, {
      payload: { confirmation: ACTIVATION_CONFIRMATION },
      context: { accountId: 'account-1' }
    });
    expect(result).toMatchObject({ success: false, code: 'FORBIDDEN' });
    expect(kvs.get).not.toHaveBeenCalled();
    expect(logAuditEntry).not.toHaveBeenCalled();
  });

  it('audits an authorized activation attempt as a failed write', async () => {
    const result = await invoke(handlers, ACTIVATION, {
      payload: { confirmation: ACTIVATION_CONFIRMATION },
      context: { accountId: 'account-1' }
    });

    expect(result).toMatchObject({
      success: false,
      status: 'BLOCKED',
      activation: { performed: false, wroteMigrationState: false }
    });
    expect(kvs.set).not.toHaveBeenCalled();
    expect(logAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      action: ACTIVATION,
      actorAccountId: 'account-1',
      category: 'ADMIN_WRITE',
      success: false
    }));
  });

  it('denies fresh initialization without authenticated Jira administration', async () => {
    await expect(invoke(handlers, INITIALIZATION, {})).resolves.toMatchObject({ code: 'FORBIDDEN' });
    forgeApi.__permissionResponse.mockResolvedValueOnce({ ok: true,
      json: async () => ({ permissions: { ADMINISTER: { havePermission: false } } }) });
    await expect(invoke(handlers, INITIALIZATION, { context: { accountId: 'account-1' } }))
      .resolves.toMatchObject({ code: 'FORBIDDEN' });
    expect(kvs.get).not.toHaveBeenCalled();
    expect(kvs.set).not.toHaveBeenCalled();
    expect(logAuditEntry).not.toHaveBeenCalled();
  });

  it('audits a blocked fresh initialization without accepting request dependencies', async () => {
    const result = await invoke(handlers, INITIALIZATION, {
      context: { accountId: 'account-1' },
      payload: { confirmation: 'INITIALIZE_FRESH_ISSUE_LEASES', deps: { verified: true } }
    });
    expect(result).toMatchObject({ code: 'INVALID_FRESH_INITIALIZATION_INPUT' });
    expect(logAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      action: INITIALIZATION, actorAccountId: 'account-1', category: 'ADMIN_WRITE', success: false
    }));
    expect(kvs.set).not.toHaveBeenCalled();
  });
});
