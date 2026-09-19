import { handler } from '../src/resolvers/index.js';

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

jest.mock('../src/utils/logger.js', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../src/resolvers/config.js', () => ({
  defineConfigResolvers: (resolver) => {
    resolver.define('addOrganization', jest.fn().mockResolvedValue({ success: true }));
    resolver.define('getOrganizations', jest.fn().mockResolvedValue([{ id: 'org1' }]));
  },
}));

jest.mock('../src/resolvers/sync.js', () => ({ defineSyncResolvers: jest.fn() }));
jest.mock('../src/resolvers/data.js', () => ({ defineDataResolvers: jest.fn() }));
jest.mock('../src/resolvers/stats.js', () => ({ defineStatsResolvers: jest.fn() }));
jest.mock('../src/resolvers/audit.js', () => ({ defineAuditResolvers: jest.fn() }));
jest.mock('../src/resolvers/diagnostics.js', () => ({ defineDiagnosticsResolvers: jest.fn() }));

describe('Resolver index', () => {
  test('registers resolvers from all groups', () => {
    expect(handler).toBeDefined();
    expect(typeof handler.addOrganization).toBe('function');
    expect(typeof handler.getOrganizations).toBe('function');
  });

  test('protected resolver requires admin accountId', async () => {
    await expect(handler.addOrganization({ context: {} })).resolves.toEqual({
      success: false,
      error: 'Unauthorized: Admin permissions required',
    });
  });

  test('protected resolver passes through with accountId', async () => {
    await expect(handler.addOrganization({ context: { accountId: 'u1' } })).resolves.toEqual({
      success: true,
    });
  });

  test('unprotected resolver is not wrapped', async () => {
    await expect(handler.getOrganizations({ context: {} })).resolves.toEqual([{ id: 'org1' }]);
  });
});
