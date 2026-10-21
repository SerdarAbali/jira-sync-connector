import { defineConfigResolvers } from '../src/resolvers/config.js';
import { run as runWebhook } from '../src/webtriggers/incoming-webhook.js';
import { buildWebhookFingerprint } from '../src/services/sync/webhook-replay.js';
import { logAuditEntry } from '../src/services/storage/stats.js';
import * as mappings from '../src/services/storage/mappings.js';
import { secureCompare } from '../src/utils/secure-compare.js';
import { randomBytes } from 'crypto';
import api from '@forge/api';
import * as kvsStore from '../src/services/storage/kvs.js';

jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return {
    ...actual,
    randomBytes: jest.fn((size) => Buffer.alloc(size, 0x41))
  };
});

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  const webTrigger = { getUrl: jest.fn() };
  const fetchMock = jest.fn();
  return {
    __esModule: true,
    default: {
      asUser: jest.fn(() => ({ requestJira })),
      asApp: jest.fn(() => ({ requestJira })),
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

jest.mock('../src/services/storage/stats.js', () => ({
  logAuditEntry: jest.fn(),
  trackWebhookSync: jest.fn(),
  trackApiCall: jest.fn()
}));

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

jest.mock('../src/utils/secure-compare.js', () => ({
  secureCompare: jest.fn((candidate, expected) => candidate === expected)
}));

const definitions = {};
const fakeResolver = {
  define(name, fn) {
    definitions[name] = fn;
  }
};
defineConfigResolvers(fakeResolver);

const FAKE_TOKEN = 'fake-api-token-value';
const FAKE_WEBHOOK_SECRET = 'fake-webhook-secret-0123456789abcdef';
const TOKEN_KEY = 'secret:org-1:token';
const INCOMING_KEY = 'secret:org-1:incomingSecret';
const META_KEY = 'webhookSecretMeta:org-1';

function configCall(name, payload = {}, context = { accountId: 'admin-1' }) {
  return definitions[name]({ payload, context });
}

function baseOrg(overrides = {}) {
  return {
    id: 'org-1',
    name: 'Target Org',
    remoteUrl: 'https://example.invalid',
    remoteEmail: 'admin@example.invalid',
    remoteProjectKey: 'KEY',
    syncDirection: 'bidirectional',
    allowedProjects: [],
    ...overrides
  };
}

function webhookFromOrg(targetOrg = baseOrg()) {
  kvsStore.get.mockImplementation(async (key) => {
    if (key === 'organizations') return [targetOrg];
    if (key === META_KEY) return { rotatedAt: '2026-01-01T00:00:00.000Z', rotatedByAccountId: 'admin-1' };
    return null;
  });
  kvsStore.getSecret.mockImplementation(async (key) => {
    if (key === INCOMING_KEY) return FAKE_WEBHOOK_SECRET;
    if (key === TOKEN_KEY) return FAKE_TOKEN;
    return null;
  });
  kvsStore.setIfNotExists.mockResolvedValue(undefined);
  kvsStore.setWithTtl.mockResolvedValue(undefined);
  logAuditEntry.mockResolvedValue(undefined);
}

function webhookRequest(overrides = {}) {
  const defaultBody = JSON.stringify({
    webhookEvent: 'jira:issue_deleted',
    timestamp: 1780000000000,
    issue: { id: '10001', key: 'REMOTE-1' }
  });
  return {
    method: 'POST',
    queryParameters: {},
    userPath: `/org-1/${FAKE_WEBHOOK_SECRET}`,
    body: defaultBody,
    ...overrides,
    headers: {
      'Content-Type': ['application/json'],
      ...(overrides.headers || {})
    }
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  kvsStore.get.mockResolvedValue(null);
  kvsStore.set.mockResolvedValue(undefined);
  kvsStore.getSecret.mockResolvedValue(null);
  kvsStore.setSecret.mockResolvedValue(undefined);
  kvsStore.deleteSecret.mockResolvedValue(undefined);
  kvsStore.del.mockResolvedValue(undefined);
  kvsStore.setIfNotExists.mockResolvedValue(undefined);
  kvsStore.setWithTtl.mockResolvedValue(undefined);
  api.webTrigger.getUrl.mockResolvedValue('https://example.invalid/webhook?secret=OLD_SECRET');
  mappings.getLocalKey.mockResolvedValue('LOCAL-1');
  logAuditEntry.mockResolvedValue(undefined);
});

describe('Batch 3 credential write-only behavior', () => {
  test('getOrganizations omits token, webhook secret and credential-bearing URL', async () => {
    kvsStore.get.mockImplementation(async (key) => {
      if (key === 'organizations') {
        return [baseOrg({ remoteApiToken: FAKE_TOKEN, incomingSecret: FAKE_WEBHOOK_SECRET })];
      }
      if (key === META_KEY) {
        return { rotatedAt: '2026-01-01T00:00:00.000Z', rotatedByAccountId: 'admin-1' };
      }
      return null;
    });
    kvsStore.getSecret.mockImplementation(async (key) => {
      if (key === TOKEN_KEY) return FAKE_TOKEN;
      if (key === INCOMING_KEY) return FAKE_WEBHOOK_SECRET;
      return null;
    });

    const result = await configCall('getOrganizations');
    const serialized = JSON.stringify(result);

    expect(result[0]).toMatchObject({
      id: 'org-1',
      hasRemoteApiToken: true,
      webhookConfigured: true,
      webhookSecretLastRotatedAt: '2026-01-01T00:00:00.000Z',
      webhookUrlConfigured: true
    });
    expect(result[0].remoteApiToken).toBeUndefined();
    expect(result[0].incomingSecret).toBeUndefined();
    expect(result[0].incomingWebhookUrl).toBe('https://example.invalid/webhook');
    expect(serialized).not.toContain(FAKE_TOKEN);
    expect(serialized).not.toContain(FAKE_WEBHOOK_SECRET);
    expect(serialized).not.toContain('OLD_SECRET');
  });

  test('updateOrganization preserves the existing token when no replacement is supplied', async () => {
    kvsStore.get.mockImplementation(async (key) => {
      if (key === 'organizations') return [baseOrg()];
      return null;
    });
    kvsStore.getSecret.mockImplementation(async (key) => {
      if (key === TOKEN_KEY) return FAKE_TOKEN;
      if (key === INCOMING_KEY) return FAKE_WEBHOOK_SECRET;
      return null;
    });

    const result = await configCall('updateOrganization', {
      id: 'org-1',
      name: 'Renamed Org',
      remoteUrl: 'https://example.invalid',
      remoteEmail: 'admin@example.invalid',
      remoteProjectKey: 'KEY',
      syncDirection: 'bidirectional'
    });

    expect(result.success).toBe(true);
    expect(kvsStore.setSecret).not.toHaveBeenCalled();
    const savedOrgs = kvsStore.set.mock.calls.find(([key]) => key === 'organizations')[1];
    expect(savedOrgs[0].remoteApiToken).toBeUndefined();
    expect(result.organization.remoteApiToken).toBeUndefined();
    expect(result.organization.hasRemoteApiToken).toBe(true);
  });

  test('explicit token replacement stores the new token only with setSecret', async () => {
    kvsStore.get.mockResolvedValue([baseOrg()]);

    const result = await configCall('replaceOrganizationToken', {
      orgId: 'org-1',
      remoteApiToken: 'replacement-token'
    });

    expect(result).toEqual({ success: true, hasRemoteApiToken: true });
    expect(kvsStore.setSecret).toHaveBeenCalledWith(TOKEN_KEY, 'replacement-token');
    expect(kvsStore.set).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('replacement-token');
  });

  test('addOrganization writes credentials only to secret storage', async () => {
    kvsStore.get.mockResolvedValue([]);

    const result = await configCall('addOrganization', {
      name: 'New Org',
      remoteUrl: 'https://example.invalid',
      remoteEmail: 'admin@example.invalid',
      remoteApiToken: 'new-token',
      remoteProjectKey: 'KEY',
      syncDirection: 'bidirectional'
    });

    expect(result.success).toBe(true);
    expect(randomBytes).toHaveBeenCalledWith(32);
    expect(kvsStore.setSecret).toHaveBeenCalledWith(expect.stringMatching(/^secret:org-\d+:token$/), 'new-token');
    expect(kvsStore.setSecret).toHaveBeenCalledWith(expect.stringMatching(/^secret:org-\d+:incomingSecret$/), expect.any(String));
    const savedOrgs = kvsStore.set.mock.calls.find(([key]) => key === 'organizations')[1];
    expect(JSON.stringify(savedOrgs)).not.toContain('new-token');
    expect(savedOrgs[0].remoteApiToken).toBeUndefined();
    expect(result.organization.remoteApiToken).toBeUndefined();
  });

  test('getConfig and saveConfig never expose or persist plaintext credentials', async () => {
    kvsStore.get.mockImplementation(async (key) => {
      if (key === 'syncConfig') {
        return {
          remoteUrl: 'https://example.invalid',
          remoteEmail: 'admin@example.invalid',
          remoteApiToken: 'legacy-token',
          incomingSecret: 'legacy-secret'
        };
      }
      return null;
    });
    kvsStore.getSecret.mockResolvedValue('legacy-token');

    const config = await configCall('getConfig');
    expect(config.remoteApiToken).toBeUndefined();
    expect(config.incomingSecret).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain('legacy-token');
    expect(JSON.stringify(config)).not.toContain('legacy-secret');

    kvsStore.set.mockClear();
    kvsStore.setSecret.mockClear();
    await configCall('saveConfig', {
      config: {
        remoteUrl: 'https://example.invalid',
        remoteApiToken: 'legacy-token',
        incomingSecret: 'legacy-secret'
      }
    });

    expect(kvsStore.setSecret).toHaveBeenCalledWith('secret:legacy:token', 'legacy-token');
    const savedConfig = kvsStore.set.mock.calls.find(([key]) => key === 'syncConfig')[1];
    expect(savedConfig.remoteApiToken).toBeUndefined();
    expect(savedConfig.incomingSecret).toBeUndefined();
  });
});


describe('Batch 3 legacy credential migration and deletion', () => {
  test('exportOrgSettings contains no token or webhook secret', async () => {
    kvsStore.get.mockImplementation(async (key) => {
      if (key === 'organizations') {
        return [baseOrg({ remoteApiToken: FAKE_TOKEN, incomingSecret: FAKE_WEBHOOK_SECRET })];
      }
      return null;
    });

    const result = await configCall('exportOrgSettings', { orgId: 'org-1' });
    const serialized = JSON.stringify(result.data);
    expect(result.success).toBe(true);
    expect(serialized).not.toContain(FAKE_TOKEN);
    expect(serialized).not.toContain(FAKE_WEBHOOK_SECRET);
    expect(result.data.org.remoteApiToken).toBeUndefined();
    expect(result.data.org.incomingSecret).toBeUndefined();
  });

  test('importOrgSettings stores supplied credentials only through setSecret', async () => {
    kvsStore.get.mockResolvedValue([baseOrg()]);

    const result = await configCall('importOrgSettings', {
      orgId: 'org-1',
      data: {
        org: {
          name: 'Imported Org',
          remoteUrl: 'https://example.invalid',
          remoteEmail: 'admin@example.invalid',
          remoteApiToken: 'imported-token',
          remoteProjectKey: 'KEY'
        }
      }
    });

    expect(result.success).toBe(true);
    expect(kvsStore.setSecret).toHaveBeenCalledWith(TOKEN_KEY, 'imported-token');
    const savedOrgs = kvsStore.set.mock.calls.find(([key]) => key === 'organizations')[1];
    expect(JSON.stringify(savedOrgs)).not.toContain('imported-token');
    expect(savedOrgs[0].remoteApiToken).toBeUndefined();
  });

  test('legacy migration writes the secret before removing plaintext', async () => {
    kvsStore.get.mockImplementation(async (key) => {
      if (key === 'syncConfig') {
        return {
          remoteUrl: 'https://legacy.invalid',
          remoteEmail: 'legacy@example.invalid',
          remoteApiToken: 'legacy-token',
          remoteProjectKey: 'LEG'
        };
      }
      return null;
    });

    const result = await configCall('migrateLegacyConfig');
    expect(result.success).toBe(true);
    expect(result.organization.remoteApiToken).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('legacy-token');

    const secretOrder = kvsStore.setSecret.mock.invocationCallOrder[0];
    const organizationsCallIndex = kvsStore.set.mock.calls
      .findIndex(([key]) => key === 'organizations');
    expect(secretOrder).toBeLessThan(kvsStore.set.mock.invocationCallOrder[organizationsCallIndex]);

    const cleanConfig = kvsStore.set.mock.calls.find(([key]) => key === 'syncConfig')[1];
    expect(cleanConfig.remoteApiToken).toBeUndefined();
    expect(JSON.stringify(cleanConfig)).not.toContain('legacy-token');
  });

  test('failed legacy migration does not delete the only credential', async () => {
    kvsStore.get.mockImplementation(async (key) => {
      if (key === 'syncConfig') {
        return {
          remoteUrl: 'https://legacy.invalid',
          remoteEmail: 'legacy@example.invalid',
          remoteApiToken: 'legacy-token',
          remoteProjectKey: 'LEG'
        };
      }
      return null;
    });
    kvsStore.setSecret.mockRejectedValueOnce(new Error('secret storage unavailable'));

    const result = await configCall('migrateLegacyConfig');
    expect(result.success).toBe(false);
    expect(kvsStore.set).not.toHaveBeenCalled();
  });

  test('deleteOrganization removes token, incoming webhook secret and rotation metadata', async () => {
    kvsStore.get.mockResolvedValue([baseOrg()]);

    const result = await configCall('deleteOrganization', { id: 'org-1' });
    expect(result.success).toBe(true);
    expect(kvsStore.deleteSecret).toHaveBeenCalledWith(TOKEN_KEY);
    expect(kvsStore.deleteSecret).toHaveBeenCalledWith(INCOMING_KEY);
    expect(kvsStore.del).toHaveBeenCalledWith(META_KEY);
  });
});


describe('Batch 3 webhook secret rotation', () => {
  test('rotation uses 256 bits of cryptographic randomness and setSecret only', async () => {
    kvsStore.get.mockResolvedValue([baseOrg()]);

    const result = await configCall('rotateWebhookSecret', { orgId: 'org-1' });

    expect(randomBytes).toHaveBeenCalledWith(32);
    expect(result.success).toBe(true);
    expect(result.oneTimeDisplay).toBe(true);
    expect(result.secret).toHaveLength(43);
    expect(result.secret).not.toContain(FAKE_TOKEN);
    expect(result.callbackUrl).toBe(`https://example.invalid/webhook/org-1/${result.secret}`);
    expect(kvsStore.setSecret).toHaveBeenCalledWith(INCOMING_KEY, result.secret);
    expect(kvsStore.setSecret).not.toHaveBeenCalledWith(TOKEN_KEY, expect.anything());
    expect(kvsStore.setSecret).toHaveBeenCalledTimes(1);
  });

  test('rotation records safe metadata and never returns the remote API token', async () => {
    kvsStore.get.mockResolvedValue([baseOrg()]);

    const result = await configCall('rotateWebhookSecret', { orgId: 'org-1' });

    expect(kvsStore.set).toHaveBeenCalledWith(META_KEY, {
      rotatedAt: expect.any(String),
      rotatedByAccountId: 'admin-1'
    });
    expect(result.remoteApiToken).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
  });

  test('later organization reads cannot retrieve the rotated secret', async () => {
    kvsStore.get.mockImplementation(async (key) => {
      if (key === 'organizations') return [baseOrg()];
      return null;
    });
    kvsStore.getSecret.mockImplementation(async (key) => {
      if (key === TOKEN_KEY) return FAKE_TOKEN;
      if (key === INCOMING_KEY) return FAKE_WEBHOOK_SECRET;
      return null;
    });

    const result = await configCall('getOrganizations');
    expect(JSON.stringify(result)).not.toContain(FAKE_WEBHOOK_SECRET);
    expect(result[0].incomingSecret).toBeUndefined();
    expect(result[0].incomingWebhookUrl).toBe('https://example.invalid/webhook');
    expect(JSON.stringify(result)).not.toContain('/org-1/');
  });
});



describe('Batch 3 native Jira webhook path authentication', () => {
  test('native Jira-style POST without custom authentication headers authenticates through userPath', async () => {
    webhookFromOrg();
    const response = await runWebhook(webhookRequest());

    expect(response.statusCode).toBe(200);
    expect(response.headers['Content-Type']).toEqual(['application/json']);
    expect(JSON.parse(response.body)).toEqual({ message: 'Processed' });
    expect(secureCompare).toHaveBeenCalledWith(FAKE_WEBHOOK_SECRET, FAKE_WEBHOOK_SECRET);
  });

  test('every webhook response uses a Forge array Content-Type', async () => {
    webhookFromOrg();
    const responses = [
      await runWebhook(webhookRequest()),
      await runWebhook(webhookRequest({ userPath: undefined })),
      await runWebhook(webhookRequest({ headers: { 'Content-Type': ['text/plain'] } })),
      await runWebhook(webhookRequest({ body: '{' }))
    ];

    for (const response of responses) {
      expect(response.headers['Content-Type']).toEqual(['application/json']);
    }
  });

  test('accepts a Forge-style array Content-Type with charset', async () => {
    webhookFromOrg();
    const response = await runWebhook(webhookRequest({
      headers: { 'Content-Type': ['application/json; charset=utf-8'] }
    }));

    expect(response.statusCode).toBe(200);
  });

  test('rejects malformed, empty, multiple and duplicate Content-Type headers', async () => {
    webhookFromOrg();
    const invalidHeaders = [
      { 'Content-Type': { malformed: true } },
      { 'Content-Type': [] },
      { 'Content-Type': ['application/json', 'application/json'] },
      { 'Content-Type': ['application/json'], 'content-type': ['application/json'] }
    ];

    for (const headers of invalidHeaders) {
      const response = await runWebhook(webhookRequest({ headers }));
      expect(response.statusCode).toBe(415);
      expect(response.headers['Content-Type']).toEqual(['application/json']);
    }
  });

  test('a valid userPath still reaches processIncomingWebhook', async () => {
    webhookFromOrg();
    const response = await runWebhook(webhookRequest());

    expect(response.statusCode).toBe(200);
    expect(kvsStore.get).toHaveBeenCalledWith('organizations');
  });

  test('query-string secrets are rejected', async () => {
    webhookFromOrg();
    const response = await runWebhook(webhookRequest({ queryParameters: { secret: FAKE_WEBHOOK_SECRET } }));

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'Unauthorized' });
    expect(kvsStore.get).not.toHaveBeenCalled();
  });

  test('missing userPath is rejected', async () => {
    webhookFromOrg();
    const response = await runWebhook(webhookRequest({ userPath: undefined }));

    expect(response.statusCode).toBe(401);
    expect(kvsStore.get).not.toHaveBeenCalled();
  });

  test('wrong organization path is rejected', async () => {
    webhookFromOrg();
    const response = await runWebhook(webhookRequest({
      userPath: `/org-999/${FAKE_WEBHOOK_SECRET}`
    }));

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'Unauthorized' });
  });

  test('wrong secret path is rejected', async () => {
    webhookFromOrg();
    const response = await runWebhook(webhookRequest({
      userPath: '/org-1/wrong-secret-0123456789abcdef'
    }));

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'Unauthorized' });
  });

  test('extra path segments are rejected', async () => {
    webhookFromOrg();
    const response = await runWebhook(webhookRequest({
      userPath: `/org-1/${FAKE_WEBHOOK_SECRET}/extra`
    }));

    expect(response.statusCode).toBe(401);
    expect(kvsStore.get).not.toHaveBeenCalled();
  });

  test('encoded, empty, double-slash, trailing-slash and oversized path segments are rejected', async () => {
    webhookFromOrg();
    const paths = [
      `/org-1/${FAKE_WEBHOOK_SECRET.replace('-', '%2F')}`,
      '/org-1/',
      `/org-1//${FAKE_WEBHOOK_SECRET}`,
      `/org-1/${FAKE_WEBHOOK_SECRET}/`,
      `/${'a'.repeat(1025)}`
    ];

    for (const userPath of paths) {
      const response = await runWebhook(webhookRequest({ userPath }));
      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body)).toEqual({ error: 'Unauthorized' });
    }
    expect(kvsStore.get).not.toHaveBeenCalled();
  });

  test('constant-time comparison is used', async () => {
    webhookFromOrg();
    const response = await runWebhook(webhookRequest());

    expect(response.statusCode).toBe(200);
    expect(secureCompare).toHaveBeenCalled();
  });

  test('unknown organization and wrong secret return identical responses', async () => {
    webhookFromOrg();
    const unknown = await runWebhook(webhookRequest({
      userPath: `/org-999/${FAKE_WEBHOOK_SECRET}`
    }));
    const wrongSecret = await runWebhook(webhookRequest({
      userPath: '/org-1/wrong-secret-0123456789abcdef'
    }));

    expect(unknown.statusCode).toBe(401);
    expect(wrongSecret.statusCode).toBe(401);
    expect(unknown.body).toBe(wrongSecret.body);
    expect(unknown.body).toBe(JSON.stringify({ error: 'Unauthorized' }));
  });

  test('only the selected organization secret is loaded', async () => {
    webhookFromOrg();
    kvsStore.get.mockImplementation(async (key) => {
      if (key === 'organizations') {
        return [baseOrg(), baseOrg({ id: 'org-2', name: 'Other Org' })];
      }
      return null;
    });

    const response = await runWebhook(webhookRequest());
    expect(response.statusCode).toBe(200);
    expect(kvsStore.getSecret).toHaveBeenCalledWith(INCOMING_KEY);
    expect(kvsStore.getSecret).not.toHaveBeenCalledWith('secret:org-2:incomingSecret');
  });
});


describe('Batch 3 payload-fingerprint duplicate suppression', () => {
  function fingerprintFor(request = webhookRequest()) {
    return buildWebhookFingerprint(JSON.parse(request.body), 'org-1');
  }

  test('fingerprint is deterministic, SHA-256 sized, and excludes the secret and body', () => {
    const request = webhookRequest();
    const payload = JSON.parse(request.body);
    const first = buildWebhookFingerprint(payload, 'org-1');
    const second = buildWebhookFingerprint({ ...payload }, 'org-1');

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain(FAKE_WEBHOOK_SECRET);
    expect(first).not.toContain('REMOTE-1');
    expect(first).not.toContain(request.body);
    expect(buildWebhookFingerprint({ webhookEvent: 'jira:issue_updated' }, 'org-1')).toBeNull();
  });

  test('a completed marker suppresses a duplicate without executing synchronization', async () => {
    webhookFromOrg();
    const markerKey = `webhook-replay:org-1:${fingerprintFor()}`;
    kvsStore.setIfNotExists.mockRejectedValueOnce(
      Object.assign(new Error('already exists'), { code: 'KEY_ALREADY_EXISTS' })
    );
    kvsStore.get.mockImplementation(async (key) => {
      if (key === 'organizations') return [baseOrg()];
      if (key === markerKey) return { state: 'completed' };
      return null;
    });

    const response = await runWebhook(webhookRequest());
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ message: 'Duplicate event ignored' });
    expect(logAuditEntry).not.toHaveBeenCalled();
  });

  test('a processing marker prevents concurrent execution', async () => {
    webhookFromOrg();
    const markerKey = `webhook-replay:org-1:${fingerprintFor()}`;
    kvsStore.setIfNotExists.mockRejectedValueOnce(
      Object.assign(new Error('already exists'), { code: 'KEY_ALREADY_EXISTS' })
    );
    kvsStore.get.mockImplementation(async (key) => {
      if (key === 'organizations') return [baseOrg()];
      if (key === markerKey) return { state: 'processing' };
      return null;
    });

    const response = await runWebhook(webhookRequest());
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ error: 'Request is already being processed' });
    expect(logAuditEntry).not.toHaveBeenCalled();
  });

  test('successful processing changes the marker to completed', async () => {
    webhookFromOrg();
    const markerKey = `webhook-replay:org-1:${fingerprintFor()}`;

    const response = await runWebhook(webhookRequest());
    expect(response.statusCode).toBe(200);
    expect(kvsStore.setWithTtl).toHaveBeenCalledWith(
      markerKey,
      expect.objectContaining({ state: 'completed' }),
      expect.any(Number)
    );
    expect(logAuditEntry).toHaveBeenCalledTimes(1);
  });


  test('failed processing removes the marker so a later retry can run', async () => {
    webhookFromOrg();
    const markerKey = `webhook-replay:org-1:${fingerprintFor()}`;
    logAuditEntry
      .mockRejectedValueOnce(new Error('audit unavailable'))
      .mockResolvedValueOnce(undefined);

    const first = await runWebhook(webhookRequest());
    expect(first.statusCode).toBe(500);
    expect(kvsStore.del).toHaveBeenCalledWith(markerKey);

    const second = await runWebhook(webhookRequest());
    expect(second.statusCode).toBe(200);
    expect(logAuditEntry).toHaveBeenCalledTimes(2);
  });

  test('a KVS conflict is inspected rather than reported as an unconditional duplicate', async () => {
    webhookFromOrg();
    const markerKey = `webhook-replay:org-1:${fingerprintFor()}`;
    kvsStore.setIfNotExists.mockRejectedValueOnce(
      Object.assign(new Error('already exists'), { code: 'KEY_ALREADY_EXISTS' })
    );
    kvsStore.get.mockImplementation(async (key) => {
      if (key === 'organizations') return [baseOrg()];
      if (key === markerKey) return { state: 'processing' };
      return null;
    });

    const response = await runWebhook(webhookRequest());
    expect(response.statusCode).toBe(409);
    expect(kvsStore.get).toHaveBeenCalledWith(markerKey);
  });

  test('a non-conflict KVS failure returns a temporary failure, not duplicate', async () => {
    webhookFromOrg();
    kvsStore.setIfNotExists.mockRejectedValueOnce(new Error('quota exceeded'));

    const response = await runWebhook(webhookRequest());
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: 'Webhook processing temporarily unavailable' });
    expect(logAuditEntry).not.toHaveBeenCalled();
  });

  test('Batch 1 deletion blocking still works through the native webhook path', async () => {
    webhookFromOrg();
    const response = await runWebhook(webhookRequest());

    expect(response.statusCode).toBe(200);
    expect(api.fetch).not.toHaveBeenCalled();
    expect(api.asApp().requestJira).not.toHaveBeenCalled();
    expect(logAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      action: 'remote-delete-blocked',
      orgId: 'org-1',
      targetIssue: 'REMOTE-1',
      sourceIssue: 'LOCAL-1'
    }));
  });

  test('logs, responses and audit records contain no credential values', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    webhookFromOrg();
    const response = await runWebhook(webhookRequest());
    const organizations = await configCall('getOrganizations');

    const emitted = JSON.stringify([
      response,
      organizations,
      logSpy.mock.calls,
      warnSpy.mock.calls,
      errorSpy.mock.calls,
      logAuditEntry.mock.calls
    ]);

    expect(emitted).not.toContain(FAKE_TOKEN);
    expect(emitted).not.toContain(FAKE_WEBHOOK_SECRET);
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

