const mockStore = new Map();
const mockSecretStore = new Map();

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  const fetchMock = jest.fn();
  return {
    __esModule: true,
    default: { asApp: () => ({ requestJira }) },
    route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch: fetchMock
  };
});

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(async key => (mockStore.has(key) ? mockStore.get(key) : null)),
  set: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  del: jest.fn(async key => { mockStore.delete(key); }),
  getSecret: jest.fn(async key => (mockSecretStore.has(key) ? mockSecretStore.get(key) : null)),
  setSecret: jest.fn(async (key, value) => { mockSecretStore.set(key, value); }),
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

jest.mock('../src/services/storage/mappings.js', () => ({
  getLocalKey: jest.fn(async () => 'LOCAL-1'),
  getRemoteKey: jest.fn(),
  storeMapping: jest.fn(),
  ensureMappingPair: jest.fn(),
  getOrganizationsWithTokens: jest.fn(async () => []),
  storeLinkMapping: jest.fn(),
  getLinkMapping: jest.fn(),
  getLocalCommentId: jest.fn(async () => 'LOCAL-PARENT-1'),
  storeCommentMapping: jest.fn()
}));

jest.mock('../src/services/storage/flags.js', () => ({
  markSyncing: jest.fn(),
  clearSyncFlag: jest.fn(),
  isSyncing: jest.fn(async () => false),
  enqueuePendingChildIssue: jest.fn(),
  consumePendingChildIssues: jest.fn(async () => [])
}));

jest.mock('../src/services/storage/stats.js', () => ({
  logAuditEntry: jest.fn(async () => undefined),
  trackWebhookSync: jest.fn(async () => undefined),
  trackApiCall: jest.fn(async () => undefined)
}));

jest.mock('../src/services/storage/rejected-fields.js', () => ({
  recordRejectedFields: jest.fn()
}));

jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn(),
  getFullComment: jest.fn(),
  getOrgName: jest.fn(async () => 'Local Org'),
  updateLocalIssueDescription: jest.fn(),
  uploadAttachment: jest.fn()
}));

jest.mock('../src/services/jira/remote-client.js', () => ({
  getRemoteIssue: jest.fn(),
  getRemoteComment: jest.fn(async () => ({
    id: 'REMOTE-PARENT-1',
    body: 'parent body',
    author: { displayName: 'Parent User' }
  }))
}));

jest.mock('../src/services/sync/transition-sync.js', () => ({
  transitionLocalIssue: jest.fn(),
  transitionRemoteIssue: jest.fn()
}));

jest.mock('../src/services/sync/pilot-pause.js', () => ({
  getPilotPause: jest.fn(async () => ({ paused: false })),
  assertPilotWritesAllowed: jest.fn(async () => undefined)
}));

jest.mock('../src/utils/mapping.js', () => ({
  mapUserToLocal: jest.fn()
}));


import api from '@forge/api';
import { processIncomingWebhook } from '../src/services/sync/incoming-sync.js';
import { storeCommentMapping } from '../src/services/storage/mappings.js';
import { buildWebhookFingerprint, webhookMarkerKey } from '../src/services/sync/webhook-replay.js';

const requestJira = api.asApp().requestJira;
const CREDENTIAL = 'abcdefghijklmnop';
const COMMENT_BODY = 'remote body must not be persisted';

const ORG = {
  id: 'org-1',
  name: 'Remote Org',
  remoteUrl: 'https://remote.example.invalid',
  remoteEmail: 'sync@example.invalid',
  syncDirection: 'bidirectional',
  allowedProjects: ['LOCAL']
};

const payload = {
  webhookEvent: 'comment_created',
  issue: { id: 'REMOTE-ISSUE-1', key: 'REMOTE-1' },
  comment: {
    id: 'REMOTE-COMMENT-1',
    body: COMMENT_BODY,
    properties: [],
    parentId: 'REMOTE-PARENT-1',
    author: { displayName: 'Remote User' }
  }
};

function seedOrganization() {
  mockStore.set('organizations', [ORG]);
  mockSecretStore.set('secret:org-1:incomingSecret', CREDENTIAL);
  mockSecretStore.set('secret:org-1:token', 'remote-token');
}

function auth() {
  return { orgId: 'org-1', credential: CREDENTIAL };
}

function okResponse(body = { id: 'LOCAL-COMMENT-1', properties: [] }) {
  return { ok: true, status: 201, json: async () => body };
}

function errorResponse(status, body) {
  return { ok: false, status, json: async () => body };
}

function markerKeyForCurrentPayload() {
  return webhookMarkerKey('org-1', buildWebhookFingerprint(payload, 'org-1'));
}

function reconciliationKey() {
  return 'org-1:incoming-comment-reconciliation:REMOTE-COMMENT-1';
}

beforeEach(() => {
  mockStore.clear();
  mockSecretStore.clear();
  jest.clearAllMocks();
  requestJira.mockReset();
  seedOrganization();
});

describe('Batch 9 inbound threaded-comment safety', () => {
  test('falls back to one top-level POST only after a recognized parent-related 4xx', async () => {
    requestJira
      .mockResolvedValueOnce(errorResponse(400, { errors: { parent: 'Parent comment does not exist' } }))
      .mockResolvedValueOnce(okResponse());

    const result = await processIncomingWebhook(payload, auth());

    expect(result.status).toBe(200);
    expect(requestJira).toHaveBeenCalledTimes(2);
    const first = JSON.parse(requestJira.mock.calls[0][1].body);
    const second = JSON.parse(requestJira.mock.calls[1][1].body);
    expect(first.parent).toEqual({ id: 'LOCAL-PARENT-1' });
    expect(second.parent).toBeUndefined();
    expect(storeCommentMapping).toHaveBeenCalledWith('LOCAL-COMMENT-1', 'REMOTE-COMMENT-1', 'org-1');
    expect(mockStore.get(reconciliationKey())).toBeUndefined();
  });

  test('does not fall back after an unrelated 4xx', async () => {
    requestJira.mockResolvedValue(errorResponse(400, { errors: { summary: 'Invalid value' } }));

    const result = await processIncomingWebhook(payload, auth());

    expect(result.status).toBe(500);
    expect(requestJira).toHaveBeenCalledTimes(1);
    expect(mockStore.get(reconciliationKey())).toBeUndefined();
    expect(mockStore.get(markerKeyForCurrentPayload())).toBeUndefined();
  });

  test('does not fall back after 429 and preserves a reconciliation record', async () => {
    requestJira.mockResolvedValue(errorResponse(429, { errorMessages: ['Rate limited'] }));

    const result = await processIncomingWebhook(payload, auth());

    expect(result.status).toBe(202);
    expect(requestJira).toHaveBeenCalledTimes(1);
    expect(mockStore.get(reconciliationKey())).toEqual(expect.objectContaining({
      state: 'reconciliation_required',
      failedStatus: 429
    }));
    expect(mockStore.get(markerKeyForCurrentPayload())).toEqual(expect.objectContaining({ state: 'completed' }));
  });

  test('does not fall back after 5xx and does not release the replay marker', async () => {
    requestJira.mockResolvedValue(errorResponse(503, { errorMessages: ['Unavailable'] }));

    const result = await processIncomingWebhook(payload, auth());

    expect(result.status).toBe(202);
    expect(requestJira).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockStore.get(reconciliationKey()))).not.toContain(COMMENT_BODY);
    expect(mockStore.get(markerKeyForCurrentPayload())).toEqual(expect.objectContaining({ state: 'completed' }));
  });

  test('does not fall back or replay after a network exception', async () => {
    requestJira.mockRejectedValueOnce(new Error('socket hang up'));

    const result = await processIncomingWebhook(payload, auth());

    expect(result.status).toBe(202);
    expect(requestJira).toHaveBeenCalledTimes(1);
    expect(mockStore.get(reconciliationKey())).toEqual(expect.objectContaining({
      reason: 'comment-write-exception'
    }));
    expect(mockStore.get(markerKeyForCurrentPayload())).toEqual(expect.objectContaining({ state: 'completed' }));
  });

  test('treats a malformed success response as ambiguous and posts only once', async () => {
    requestJira.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => { throw new Error('malformed json'); }
    });

    const result = await processIncomingWebhook(payload, auth());

    expect(result.status).toBe(202);
    expect(requestJira).toHaveBeenCalledTimes(1);
    expect(mockStore.get(reconciliationKey())).toEqual(expect.objectContaining({
      reason: 'malformed-comment-create-response'
    }));
  });

  test('a persisted reconciliation record blocks a later replay even after the marker is gone', async () => {
    requestJira.mockResolvedValue(errorResponse(500, { errorMessages: ['Unavailable'] }));
    await processIncomingWebhook(payload, auth());

    mockStore.delete(markerKeyForCurrentPayload());
    requestJira.mockClear();

    const replay = await processIncomingWebhook(payload, auth());

    expect(replay.status).toBe(200);
    expect(requestJira).not.toHaveBeenCalled();
    expect(mockStore.get(reconciliationKey())).toEqual(expect.objectContaining({
      state: 'reconciliation_required'
    }));
  });
});
