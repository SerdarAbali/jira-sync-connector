import { defineConfigResolvers } from '../src/resolvers/config.js';
import { validateOrganizationPayload } from '../src/utils/validation.js';
import * as kvsStore from '../src/services/storage/kvs.js';

jest.mock('@forge/api', () => {
  const fetchMock = jest.fn();
  const webTrigger = { getUrl: jest.fn() };
  return {
    __esModule: true,
    default: {
      asUser: jest.fn(() => ({ requestJira: jest.fn() })),
      asApp: jest.fn(() => ({ requestJira: jest.fn() })),
      webTrigger,
      fetch: fetchMock
    },
    route: (strings, ...values) =>
      strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch: fetchMock,
    webTrigger
  };
});

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

const definitions = {};
const fakeResolver = {
  define(name, fn) {
    definitions[name] = fn;
  }
};
defineConfigResolvers(fakeResolver);

const TOKEN_KEY = 'secret:org-1:token';
const FAKE_TOKEN = 'fake-api-token-value';

function configCall(name, payload = {}) {
  return definitions[name]({
    payload,
    context: { accountId: 'admin-1' }
  });
}

function storedOrganization(overrides = {}) {
  return {
    id: 'org-1',
    name: 'Source Mobile',
    remoteUrl: 'https://example.invalid',
    remoteEmail: 'admin@example.invalid',
    remoteProjectKey: 'VMOB',
    allowedProjects: ['MOB'],
    jqlFilter: 'project = MOB',
    syncDirection: 'push',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function primeStorage(org = storedOrganization()) {
  kvsStore.get.mockImplementation(async (key) => {
    if (key === 'organizations') return [org];
    return null;
  });
  kvsStore.getSecret.mockImplementation(async (key) => {
    if (key === TOKEN_KEY) return FAKE_TOKEN;
    return null;
  });
}

function savedOrganization() {
  const call = kvsStore.set.mock.calls.find(([key]) => key === 'organizations');
  if (!call) throw new Error('organizations were not written');
  return call[1][0];
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  primeStorage();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('updateOrganization partial updates preserve organization scope', () => {
  test('saving the allowed-project filter preserves the stored JQL filter', async () => {
    const result = await configCall('updateOrganization', {
      id: 'org-1',
      name: 'Source Mobile',
      remoteUrl: 'https://example.invalid',
      remoteEmail: 'admin@example.invalid',
      remoteProjectKey: 'VMOB',
      allowedProjects: ['MOB', 'DEV']
    });

    expect(result.success).toBe(true);
    expect(savedOrganization().allowedProjects).toEqual(['MOB', 'DEV']);
    expect(savedOrganization().jqlFilter).toBe('project = MOB');
    expect(result.organization.jqlFilter).toBe('project = MOB');
  });

  test('a partial update that omits allowedProjects preserves the stored project scope', async () => {
    const result = await configCall('updateOrganization', {
      id: 'org-1',
      name: 'Renamed Mobile',
      remoteUrl: 'https://example.invalid',
      remoteEmail: 'admin@example.invalid',
      remoteProjectKey: 'VMOB'
    });

    expect(result.success).toBe(true);
    expect(savedOrganization().name).toBe('Renamed Mobile');
    expect(savedOrganization().allowedProjects).toEqual(['MOB']);
    expect(savedOrganization().jqlFilter).toBe('project = MOB');
  });

  test('the intended JQL editor can still explicitly clear the filter', async () => {
    const result = await configCall('updateOrganization', {
      id: 'org-1',
      name: 'Source Mobile',
      remoteUrl: 'https://example.invalid',
      remoteEmail: 'admin@example.invalid',
      remoteProjectKey: 'VMOB',
      allowedProjects: ['MOB'],
      jqlFilter: ''
    });

    expect(result.success).toBe(true);
    expect(savedOrganization().jqlFilter).toBe('');
    expect(savedOrganization().allowedProjects).toEqual(['MOB']);
  });

  test('explicitly saving an empty project scope clears only the scope', async () => {
    const result = await configCall('updateOrganization', {
      id: 'org-1',
      name: 'Source Mobile',
      remoteUrl: 'https://example.invalid',
      remoteEmail: 'admin@example.invalid',
      remoteProjectKey: 'VMOB',
      allowedProjects: []
    });

    expect(result.success).toBe(true);
    expect(savedOrganization().allowedProjects).toEqual([]);
    expect(savedOrganization().jqlFilter).toBe('project = MOB');
  });

  test('partial updates preserve credentials, direction and unrelated properties', async () => {
    const result = await configCall('updateOrganization', {
      id: 'org-1',
      name: 'Source Mobile',
      remoteUrl: 'https://example.invalid',
      remoteEmail: 'admin@example.invalid',
      remoteProjectKey: 'VMOB',
      allowedProjects: ['MOB']
    });

    expect(result.success).toBe(true);
    expect(kvsStore.setSecret).not.toHaveBeenCalled();
    expect(kvsStore.deleteSecret).not.toHaveBeenCalled();
    expect(kvsStore.del).not.toHaveBeenCalled();
    expect(savedOrganization().syncDirection).toBe('push');
    expect(savedOrganization().createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(savedOrganization().remoteApiToken).toBeUndefined();
    expect(result.organization.hasRemoteApiToken).toBe(true);
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
  });

  test('an explicit direction change still applies while scope is preserved', async () => {
    const result = await configCall('updateOrganization', {
      id: 'org-1',
      name: 'Source Mobile',
      remoteUrl: 'https://example.invalid',
      remoteEmail: 'admin@example.invalid',
      remoteProjectKey: 'VMOB',
      allowedProjects: ['MOB'],
      syncDirection: 'bidirectional'
    });

    expect(result.success).toBe(true);
    expect(savedOrganization().syncDirection).toBe('bidirectional');
    expect(savedOrganization().jqlFilter).toBe('project = MOB');
  });

  test('whitespace-only JQL input clears the filter explicitly', async () => {
    const result = await configCall('updateOrganization', {
      id: 'org-1',
      name: 'Source Mobile',
      remoteUrl: 'https://example.invalid',
      remoteEmail: 'admin@example.invalid',
      remoteProjectKey: 'VMOB',
      allowedProjects: ['MOB'],
      jqlFilter: '   '
    });

    expect(result.success).toBe(true);
    expect(savedOrganization().jqlFilter).toBe('');
  });

  test('malformed JQL input is rejected without writing', async () => {
    const result = await configCall('updateOrganization', {
      id: 'org-1',
      name: 'Source Mobile',
      remoteUrl: 'https://example.invalid',
      remoteEmail: 'admin@example.invalid',
      remoteProjectKey: 'VMOB',
      jqlFilter: 42
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('jqlFilter must be a string');
    expect(kvsStore.set).not.toHaveBeenCalledWith('organizations', expect.anything());
  });

  test('malformed allowedProjects input is rejected without writing', async () => {
    const result = await configCall('updateOrganization', {
      id: 'org-1',
      name: 'Source Mobile',
      remoteUrl: 'https://example.invalid',
      remoteEmail: 'admin@example.invalid',
      remoteProjectKey: 'VMOB',
      allowedProjects: 'MOB'
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('allowedProjects must be an array');
    expect(kvsStore.set).not.toHaveBeenCalledWith('organizations', expect.anything());
  });
});

describe('addOrganization still initializes scope for new organizations', () => {
  test('a new organization without scope keeps safe defaults', async () => {
    kvsStore.get.mockResolvedValue([]);

    const result = await configCall('addOrganization', {
      name: 'New Vendor',
      remoteUrl: 'https://example.invalid',
      remoteEmail: 'admin@example.invalid',
      remoteProjectKey: 'SAM1'
    });

    expect(result.success).toBe(true);
    expect(result.organization.allowedProjects).toEqual([]);
    expect(result.organization.jqlFilter).toBe('');
  });
});

describe('validateOrganizationPayload distinguishes omission from an explicit empty value', () => {
  const basePayload = {
    name: 'Source Mobile',
    remoteUrl: 'https://example.invalid',
    remoteEmail: 'admin@example.invalid',
    remoteProjectKey: 'VMOB'
  };

  test('omitted optional properties stay undefined', () => {
    const validated = validateOrganizationPayload({ ...basePayload });

    expect(validated.jqlFilter).toBeUndefined();
    expect(validated.allowedProjects).toBeUndefined();
  });

  test('explicit empty values stay explicit', () => {
    const validated = validateOrganizationPayload({
      ...basePayload,
      jqlFilter: '',
      allowedProjects: []
    });

    expect(validated.jqlFilter).toBe('');
    expect(validated.allowedProjects).toEqual([]);
  });

  test('null is treated as omitted rather than as a clear instruction', () => {
    const validated = validateOrganizationPayload({
      ...basePayload,
      jqlFilter: null,
      allowedProjects: null
    });

    expect(validated.jqlFilter).toBeUndefined();
    expect(validated.allowedProjects).toBeUndefined();
  });

  test('supplied scope values are still validated', () => {
    expect(() => validateOrganizationPayload({ ...basePayload, jqlFilter: {} }))
      .toThrow('jqlFilter must be a string');
    expect(() => validateOrganizationPayload({ ...basePayload, allowedProjects: {} }))
      .toThrow('allowedProjects must be an array');
    expect(() => validateOrganizationPayload({ ...basePayload, jqlFilter: 'a'.repeat(501) }))
      .toThrow('jqlFilter exceeds maximum length of 500');
  });
});
