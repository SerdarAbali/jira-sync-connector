// The synchronization authorization gate has its own suite; this suite tests another behaviour.
jest.mock('../src/services/sync/sync-authorization.js', () => require('./helpers/authorized-sync-authorization.js'));

import { createHmac } from 'crypto';
const mockStore = new Map();
const mockSecrets = new Map();

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  const fetchMock = jest.fn();
  return {
    __esModule: true,
    default: {
      asApp: () => ({ requestJira })
    },
    route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch: fetchMock
  };
});

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(async key => (mockStore.has(key) ? mockStore.get(key) : null)),
  set: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  del: jest.fn(async key => { mockStore.delete(key); }),
  getSecret: jest.fn(async key => (mockSecrets.has(key) ? mockSecrets.get(key) : null)),
  setSecret: jest.fn(async (key, value) => { mockSecrets.set(key, value); }),
  setIfNotExists: jest.fn(async (key, value) => {
    if (mockStore.has(key)) {
      const error = new Error('already exists');
      error.code = 'KEY_ALREADY_EXISTS';
      throw error;
    }
    mockStore.set(key, value);
  }),
  setWithTtl: jest.fn(async (key, value) => { mockStore.set(key, value); })
}));

jest.mock('../src/services/storage/stats.js', () => ({
  logAuditEntry: jest.fn(async () => undefined),
  trackWebhookSync: jest.fn(),
  trackApiCall: jest.fn()
}));

jest.mock('../src/services/storage/flags.js', () => ({
  markSyncing: jest.fn(),
  isSyncing: jest.fn(async () => false),
  clearSyncFlag: jest.fn(),
  enqueuePendingChildIssue: jest.fn(),
  consumePendingChildIssues: jest.fn(async () => [])
}));

jest.mock('../src/services/storage/rejected-fields.js', () => ({
  recordRejectedFields: jest.fn()
}));

jest.mock('../src/services/jira/local-client.js', () => ({
  uploadAttachment: jest.fn(),
  getFullIssue: jest.fn(),
  getFullComment: jest.fn(),
  getOrgName: jest.fn()
}));

jest.mock('../src/services/jira/remote-client.js', () => ({
  getRemoteIssue: jest.fn(),
  getRemoteComment: jest.fn()
}));

jest.mock('../src/services/sync/transition-sync.js', () => ({
  transitionLocalIssue: jest.fn()
}));

jest.mock('../src/utils/mapping.js', () => ({
  mapUserToLocal: jest.fn()
}));

import { processIncomingWebhook } from './helpers/signed-webhook.js';
import { run as runWebhook } from '../src/webtriggers/incoming-webhook.js';
import api, { fetch as mockFetch } from '@forge/api';

const mockRequestJira = api.asApp().requestJira;

const CREDENTIAL = 'abcdefghijklmnop';
const REMOTE_ISSUE_ID = 9001;
const REMOTE_DESTINATION_ID = 9002;
const LOCAL_LINK_ID = '10001';
const UNMAPPED_LOCAL_LINK_ID = '10002';
const LINK_MAPPING_KEY = `org-1:link-mapping:${LOCAL_LINK_ID}`;

const ORG = {
  id: 'org-1',
  name: 'Remote Org B',
  remoteUrl: 'https://remote.example.invalid',
  remoteEmail: 'sync@example.invalid',
  syncDirection: 'bidirectional',
  allowedProjects: ['LOCAL']
};

let localLinks = [];

function seedOrganization({ syncDirection = 'bidirectional', paused = false } = {}) {
  mockStore.set('organizations', [{ ...ORG, syncDirection }]);
  mockSecrets.set('secret:org-1:webhookSigningSecret', CREDENTIAL);
  mockSecrets.set('secret:org-1:token', 'remote-token');
  if (paused) {
    mockStore.set('pilotPause', {
      paused: true,
      pausedAt: '2026-10-22T00:00:00.000Z',
      pausedBy: 'admin',
      reasonCode: 'maintenance'
    });
  }
}

function seedIssueMappings() {
  mockStore.set('org-1:remote-to-local:REMOTE-1', 'LOCAL-1');
  mockStore.set('org-1:remote-to-local:REMOTE-2', 'LOCAL-2');
}

function seedLinkMapping(linkId = LOCAL_LINK_ID) {
  mockStore.set(`org-1:link-mapping:${linkId}`, 'synced');
}

function systemLinkEvent(webhookEvent = 'issuelink_deleted', overrides = {}) {
  return {
    webhookEvent,
    timestamp: 1780000000000,
    issueLink: {
      id: 90001,
      sourceIssueId: REMOTE_ISSUE_ID,
      destinationIssueId: REMOTE_DESTINATION_ID,
      issueLinkType: { id: 10000, name: 'Blocks' },
      ...overrides
    }
  };
}

function webhookRequest(payload) {
  return {
    method: 'POST',
    headers: { 'Content-Type': ['application/json'], 'X-Hub-Signature': [`sha256=${createHmac('sha256', CREDENTIAL).update(JSON.stringify(payload), 'utf8').digest('hex')}`] },
    queryParameters: {},
    userPath: '/signed/org-1',
    body: JSON.stringify(payload)
  };
}

function localIssueLink(id, overrides = {}) {
  return {
    id,
    type: { name: 'Blocks' },
    outwardIssue: { key: 'LOCAL-1' },
    inwardIssue: { key: 'LOCAL-2' },
    ...overrides
  };
}

function linksForIssue(key) {
  return localLinks
    .filter(link => link.outwardIssue?.key === key || link.inwardIssue?.key === key)
    .map(link => {
      if (link.outwardIssue?.key === key) {
        return { id: link.id, type: link.type, inwardIssue: link.inwardIssue };
      }
      return { id: link.id, type: link.type, outwardIssue: link.outwardIssue };
    });
}


function setupLocalJira({ deleteStatus = 204, deleteThrows = false } = {}) {
  mockRequestJira.mockImplementation(async (url, options = {}) => {
    if (options.method === 'DELETE') {
      if (deleteThrows) {
        throw new Error('socket timeout');
      }

      const match = url.match(/\/issueLink\/(\d+)$/);
      if (!match) {
        throw new Error(`Unexpected DELETE ${url}`);
      }

      if (deleteStatus === 204 || deleteStatus === 200) {
        localLinks = localLinks.filter(link => String(link.id) !== match[1]);
        return { ok: true, status: deleteStatus };
      }
      return { ok: false, status: deleteStatus };
    }

    if (options.method === 'POST' && /\/issueLink$/.test(url)) {
      const body = JSON.parse(options.body);
      localLinks.push({
        id: LOCAL_LINK_ID,
        type: body.type,
        outwardIssue: body.outwardIssue,
        inwardIssue: body.inwardIssue
      });
      return { ok: true, status: 201 };
    }

    if (url.includes('?fields=issuelinks')) {
      const keyMatch = url.match(/\/issue\/([^/?]+)/);
      return {
        ok: true,
        status: 200,
        json: async () => ({ key: keyMatch?.[1], fields: { issuelinks: linksForIssue(keyMatch?.[1]) } })
      };
    }

    throw new Error(`Unexpected request ${options.method || 'GET'} ${url}`);
  });
}

function setupRemoteJira() {
  mockFetch.mockImplementation(async url => {
    if (url.includes(`/issue/${REMOTE_ISSUE_ID}?`)) {
      return { ok: true, status: 200, json: async () => ({ key: 'REMOTE-1' }) };
    }
    if (url.includes(`/issue/${REMOTE_DESTINATION_ID}?`)) {
      return { ok: true, status: 200, json: async () => ({ key: 'REMOTE-2' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

function callsFor(method) {
  return mockRequestJira.mock.calls.filter(([, options]) => options?.method === method);
}

beforeEach(() => {
  mockStore.clear();
  mockSecrets.clear();
  jest.clearAllMocks();
  jest.requireMock('../src/services/jira/local-client.js').getFullIssue.mockResolvedValue({ key: 'LOCAL-1', fields: { project: { key: 'LOCAL' } } });
  localLinks = [];
  setupLocalJira();
  setupRemoteJira();
});

describe('inbound issue-link deletion hotfix', () => {
  test('webtrigger allowlist accepts both Jira system-webhook link event names', async () => {
    seedOrganization();
    seedIssueMappings();

    const created = await runWebhook(webhookRequest(systemLinkEvent('issuelink_created')));
    const deleted = await runWebhook(webhookRequest(systemLinkEvent('issuelink_deleted', { id: 90002 })));

    expect(created.statusCode).toBe(200);
    expect(deleted.statusCode).toBe(200);
    expect(JSON.parse(created.body)).not.toEqual({ error: 'Unrecognized webhook event' });
    expect(JSON.parse(deleted.body)).not.toEqual({ error: 'Unrecognized webhook event' });
  });

  test('inbound system issuelink_created reaches the local link creation handler', async () => {
    seedOrganization();
    seedIssueMappings();

    const result = await processIncomingWebhook(
      systemLinkEvent('issuelink_created'),
      { orgId: 'org-1', signingSecret: CREDENTIAL }
    );

    expect(result.status).toBe(200);
    expect(callsFor('POST')).toHaveLength(1);
    expect(callsFor('POST')[0][0]).toBe('/rest/api/3/issueLink');
    expect(mockStore.get(LINK_MAPPING_KEY)).toBe('inbound');
  });

  test('inbound system issuelink_deleted reaches the mapped local link deletion handler', async () => {
    seedOrganization();
    seedIssueMappings();
    seedLinkMapping();
    localLinks = [localIssueLink(LOCAL_LINK_ID)];

    const result = await processIncomingWebhook(
      systemLinkEvent('issuelink_deleted'),
      { orgId: 'org-1', signingSecret: CREDENTIAL }
    );

    expect(result.status).toBe(200);
    expect(callsFor('DELETE')).toHaveLength(1);
    expect(callsFor('DELETE')[0][0]).toBe(`/rest/api/3/issueLink/${LOCAL_LINK_ID}`);
    expect(mockStore.has(LINK_MAPPING_KEY)).toBe(false);
  });

  test('deletion removes only the mapped link and never deletes either issue', async () => {
    seedOrganization();
    seedIssueMappings();
    seedLinkMapping();
    localLinks = [
      localIssueLink(UNMAPPED_LOCAL_LINK_ID),
      localIssueLink(LOCAL_LINK_ID)
    ];

    await processIncomingWebhook(
      systemLinkEvent('issuelink_deleted'),
      { orgId: 'org-1', signingSecret: CREDENTIAL }
    );

    const deleteCalls = callsFor('DELETE');
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0]).toBe(`/rest/api/3/issueLink/${LOCAL_LINK_ID}`);
    expect(deleteCalls.some(([url]) => /\/rest\/api\/3\/issue\/[^/]+$/.test(url))).toBe(false);
    expect(mockFetch.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);
  });

  test('missing stored link mapping performs zero DELETE requests', async () => {
    seedOrganization();
    seedIssueMappings();
    localLinks = [localIssueLink(LOCAL_LINK_ID)];

    const result = await processIncomingWebhook(
      systemLinkEvent('issuelink_deleted'),
      { orgId: 'org-1', signingSecret: CREDENTIAL }
    );

    expect(result.status).toBe(200);
    expect(callsFor('DELETE')).toHaveLength(0);
  });

  test('a local Jira 404 is treated as already deleted and removes the mapping', async () => {
    seedOrganization();
    seedIssueMappings();
    seedLinkMapping();
    localLinks = [localIssueLink(LOCAL_LINK_ID)];
    setupLocalJira({ deleteStatus: 404 });

    const result = await processIncomingWebhook(
      systemLinkEvent('issuelink_deleted'),
      { orgId: 'org-1', signingSecret: CREDENTIAL }
    );

    expect(result.status).toBe(200);
    expect(callsFor('DELETE')).toHaveLength(1);
    expect(mockStore.has(LINK_MAPPING_KEY)).toBe(false);
  });

  test('the mapping is retained when DELETE returns an uncertain 5xx outcome', async () => {
    seedOrganization();
    seedIssueMappings();
    seedLinkMapping();
    localLinks = [localIssueLink(LOCAL_LINK_ID)];
    setupLocalJira({ deleteStatus: 503 });

    const result = await processIncomingWebhook(
      systemLinkEvent('issuelink_deleted'),
      { orgId: 'org-1', signingSecret: CREDENTIAL }
    );

    expect(result.status).toBe(200);
    expect(result.body.code).toBe('LINK_DELETE_AMBIGUOUS');
    expect(callsFor('DELETE')).toHaveLength(1);
    expect(mockStore.get(LINK_MAPPING_KEY)).toBe('synced');
  });

  test('a thrown DELETE is not retried and returns a safe ambiguous result', async () => {
    seedOrganization();
    seedIssueMappings();
    seedLinkMapping();
    localLinks = [localIssueLink(LOCAL_LINK_ID)];
    setupLocalJira({ deleteThrows: true });

    const result = await processIncomingWebhook(
      systemLinkEvent('issuelink_deleted'),
      { orgId: 'org-1', signingSecret: CREDENTIAL }
    );

    expect(result.status).toBe(200);
    expect(result.body.code).toBe('LINK_DELETE_AMBIGUOUS');
    expect(callsFor('DELETE')).toHaveLength(1);
    expect(mockStore.get(LINK_MAPPING_KEY)).toBe('synced');
  });

  test('global emergency pause blocks link deletion before any lookup or write', async () => {
    seedOrganization({ paused: true });
    seedIssueMappings();
    seedLinkMapping();
    localLinks = [localIssueLink(LOCAL_LINK_ID)];

    const result = await processIncomingWebhook(
      systemLinkEvent('issuelink_deleted'),
      { orgId: 'org-1', signingSecret: CREDENTIAL }
    );

    expect(result).toEqual({
      status: 200,
      body: { message: 'Jira writes are paused', state: 'paused' }
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockRequestJira).not.toHaveBeenCalled();
    expect(mockStore.get(LINK_MAPPING_KEY)).toBe('synced');
  });

  test('duplicate issuelink_deleted delivery is harmless and idempotent', async () => {
    seedOrganization();
    seedIssueMappings();
    seedLinkMapping();
    localLinks = [localIssueLink(LOCAL_LINK_ID)];

    await processIncomingWebhook(
      systemLinkEvent('issuelink_deleted', { id: 90001 }),
      { orgId: 'org-1', signingSecret: CREDENTIAL }
    );
    const duplicate = await processIncomingWebhook(
      systemLinkEvent('issuelink_deleted', { id: 90001, timestamp: 1780000005000 }),
      { orgId: 'org-1', signingSecret: CREDENTIAL }
    );

    expect(duplicate.status).toBe(200);
    expect(callsFor('DELETE')).toHaveLength(1);
    expect(mockStore.has(LINK_MAPPING_KEY)).toBe(false);
  });

  test('deletion never searches or matches by summary', async () => {
    seedOrganization();
    seedIssueMappings();
    seedLinkMapping();
    localLinks = [localIssueLink(LOCAL_LINK_ID)];

    await processIncomingWebhook(
      systemLinkEvent('issuelink_deleted'),
      { orgId: 'org-1', signingSecret: CREDENTIAL }
    );

    const emitted = JSON.stringify([
      mockFetch.mock.calls.map(([url, options]) => [url, options?.body]),
      mockRequestJira.mock.calls.map(([url, options]) => [url, options?.body])
    ]);
    expect(emitted).not.toMatch(/summary|\/search/i);
  });
});
