import api from '@forge/api';
import { handler } from '../src/resolvers/index.js';

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  return {
    __esModule: true,
    default: {
      asUser: jest.fn(() => ({ requestJira })),
      asApp: jest.fn(() => ({ requestJira }))
    },
    route: (strings, ...values) =>
      strings.reduce((out, part, i) => out + part + (values[i] ?? ''), '')
  };
});

jest.mock('@forge/resolver', () => {
  class FakeResolver {
    constructor() {
      this.functions = {};
    }

    define(name, fn) {
      if (typeof fn !== 'function') {
        throw new Error(`Resolver definition '${name}' callback must be a function`);
      }
      this.functions[name] = fn;
      return this;
    }

    getDefinitions() {
      const functions = this.functions;
      return async (request, backendRuntimePayload) => {
        const { call, context } = request;
        const fn = functions[call.functionKey];
        if (typeof fn !== 'function') {
          throw new TypeError(`Resolver function '${call.functionKey}' is not a function`);
        }
        return fn({
          payload: call.payload || {},
          context: {
            ...context,
            accountId: backendRuntimePayload?.principal?.accountId
          }
        });
      };
    }
  }
  return { __esModule: true, default: FakeResolver };
});

jest.mock('../src/utils/logger.js', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

jest.mock('../src/resolvers/config.js', () => ({
  defineConfigResolvers: (resolver) => {
    resolver.define('addOrganization', jest.fn().mockResolvedValue({ success: true }));
    resolver.define('getOrganizations', jest.fn().mockResolvedValue([{ id: 'org1' }]));
  }
}));

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../src/resolvers/sync.js', () => ({ defineSyncResolvers: jest.fn() }));
jest.mock('../src/resolvers/data.js', () => ({ defineDataResolvers: jest.fn() }));
jest.mock('../src/resolvers/stats.js', () => ({ defineStatsResolvers: jest.fn() }));
jest.mock('../src/resolvers/audit.js', () => ({ defineAuditResolvers: jest.fn() }));
jest.mock('../src/resolvers/diagnostics.js', () => ({
  defineDiagnosticsResolvers: (resolver) => {
    resolver.define('runSystemTest', jest.fn().mockResolvedValue({
      success: false,
      disabled: true,
      code: 'SYSTEM_TEST_DISABLED'
    }));
  }
}));

const userRequestJira = api.asUser().requestJira;

function allowAdmin() {
  userRequestJira.mockResolvedValue({
    ok: true,
    json: async () => ({ permissions: { ADMINISTER: { havePermission: true } } })
  });
}

function forgeCall(functionKey, payload = {}, accountId = 'u1') {
  return handler(
    { call: { functionKey, payload, jobId: 'test-job' }, context: {} },
    { principal: { accountId } }
  );
}

describe('Resolver index authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    allowAdmin();
  });

  test('registers a callable Forge handler from all groups', () => {
    expect(handler).toBeDefined();
    expect(typeof handler).toBe('function');
    expect(Object.keys(handler)).toHaveLength(0);
  });

  test('missing context is denied before the resolver runs', async () => {
    await expect(handler({
      call: { functionKey: 'addOrganization', payload: {} },
      context: {}
    })).resolves.toEqual({
      success: false,
      code: 'FORBIDDEN',
      error: 'Jira administrator permission required'
    });
    expect(userRequestJira).not.toHaveBeenCalled();
  });

  test('missing accountId is denied', async () => {
    await expect(handler({
      call: { functionKey: 'addOrganization', payload: {} },
      context: {},
      backendRuntimePayload: {}
    })).resolves.toEqual({
      success: false,
      code: 'FORBIDDEN',
      error: 'Jira administrator permission required'
    });
    expect(userRequestJira).not.toHaveBeenCalled();
  });

  test('confirmed administrator can invoke an ADMIN_WRITE resolver', async () => {
    await expect(forgeCall('addOrganization')).resolves.toEqual({
      success: true
    });
    expect(userRequestJira).toHaveBeenCalledTimes(1);
  });

  test('getOrganizations is protected for non-admin callers', async () => {
    userRequestJira.mockResolvedValue({
      ok: true,
      json: async () => ({ permissions: { ADMINISTER: { havePermission: false } } })
    });

    await expect(forgeCall('getOrganizations')).resolves.toEqual({
      success: false,
      code: 'FORBIDDEN',
      error: 'Jira administrator permission required'
    });
  });

  test('runSystemTest is denied without admin permission', async () => {
    userRequestJira.mockResolvedValue({
      ok: true,
      json: async () => ({ permissions: { ADMINISTER: { havePermission: false } } })
    });

    await expect(forgeCall('runSystemTest')).resolves.toEqual({
      success: false,
      code: 'FORBIDDEN',
      error: 'Jira administrator permission required'
    });
  });

  test('runSystemTest returns its disabled response after admin authorization', async () => {
    await expect(forgeCall('runSystemTest')).resolves.toEqual({
      success: false,
      disabled: true,
      code: 'SYSTEM_TEST_DISABLED'
    });
  });
});
