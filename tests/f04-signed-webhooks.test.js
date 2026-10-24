import { webhookReceiptKey } from '../src/services/storage/webhook-receipt.js';
import { defineConfigResolvers } from '../src/resolvers/config.js';
import { run as runWebhook } from '../src/webtriggers/incoming-webhook.js';
import { buildWebhookFingerprint } from '../src/services/sync/webhook-replay.js';
import { logAuditEntry } from '../src/services/storage/stats.js';
import * as mappings from '../src/services/storage/mappings.js';
import { secureCompare } from '../src/utils/secure-compare.js';
import { createHmac, randomBytes } from 'crypto';
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
const META_KEY = 'webhookSigningSecretMeta:org-1';

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

function webhookFromOrg(targetOrg = baseOrg({ allowedProjects: ['LOCAL'] })) {
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
  jest.requireMock('../src/services/jira/local-client.js').getFullIssue.mockResolvedValue({ key: 'LOCAL-1', fields: { project: { key: 'LOCAL' } } });
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


function signedRequest(body = JSON.stringify({ webhookEvent: 'jira:issue_deleted', issue: { key: 'REMOTE-1' } }), secret = FAKE_WEBHOOK_SECRET) {
  return webhookRequest({ userPath: '/signed/org-1', body, headers: {
    'X-Hub-Signature': [`sha256=${createHmac('sha256', secret).update(typeof body === 'string' ? body : '', 'utf8').digest('hex')}`]
  } });
}
function signingStore() {
  webhookFromOrg();
  kvsStore.getSecret.mockImplementation(async key => key === 'secret:org-1:webhookSigningSecret' ? FAKE_WEBHOOK_SECRET : key === TOKEN_KEY ? FAKE_TOKEN : null);
}
describe('F04 signed HTTP boundary', () => {
  test.each([
    JSON.stringify({ webhookEvent: 'jira:issue_deleted', issue: { key: 'REMOTE-1' } }),
    '{ "webhookEvent": "jira:issue_deleted", "issue": {"key":"REMOTE-1"}, "text":"雪 ☃ é" }',
    '{\n"webhookEvent":"jira:issue_deleted","issue":{"key":"REMOTE-1"},"text":"\\u96ea"}'
  ])('accepts exact signed UTF-8 body %s', async body => {
    signingStore();
    expect((await runWebhook(signedRequest(body))).statusCode).toBe(200);
  });
  test('changed whitespace fails before parsing', async () => {
    signingStore(); const request = signedRequest(); request.body += ' ';
    expect((await runWebhook(request)).statusCode).toBe(401);
    expect(logAuditEntry).not.toHaveBeenCalled();
  });
  test.each([undefined, [], [''], ['sha1=' + 'a'.repeat(40)], ['sha256=' + 'a'.repeat(63)], ['sha256=' + 'g'.repeat(64)], ['sha256=' + 'a'.repeat(64), 'sha256=' + 'a'.repeat(64)], ['sha256=' + 'a'.repeat(64) + ',sha256=' + 'a'.repeat(64)]])('rejects malformed signature %p', async signature => {
    signingStore(); const request = signedRequest(); request.headers['X-Hub-Signature'] = signature;
    expect((await runWebhook(request)).statusCode).toBe(401);
  });
  test('rejects case-variant duplicate headers', async () => {
    signingStore(); const request = signedRequest(); request.headers['x-hub-signature'] = request.headers['X-Hub-Signature'];
    expect((await runWebhook(request)).statusCode).toBe(401);
  });
  test('wrong key and legacy stored credential cannot authorize', async () => {
    signingStore(); expect((await runWebhook(signedRequest(undefined, 'different-key'))).statusCode).toBe(401);
    kvsStore.getSecret.mockImplementation(async key => key === INCOMING_KEY ? FAKE_WEBHOOK_SECRET : null);
    expect((await runWebhook(signedRequest())).statusCode).toBe(401);
    expect((await runWebhook(webhookRequest())).statusCode).toBe(401);
  });
  test('object body is rejected', async () => {
    signingStore(); expect((await runWebhook(signedRequest({ webhookEvent: 'jira:issue_deleted' }))).statusCode).toBe(400);
  });
  test('signed malformed JSON is rejected', async () => {
    signingStore(); expect((await runWebhook(signedRequest('{'))).statusCode).toBe(400);
  });
  test('authentication storage failure fails closed without disclosure', async () => {
    signingStore(); kvsStore.getSecret.mockRejectedValue(new Error(FAKE_WEBHOOK_SECRET));
    const response = await runWebhook(signedRequest());
    expect(response.statusCode).toBe(401); expect(response.body).not.toContain(FAKE_WEBHOOK_SECRET);
  });
  test('rotation uses a new signing key, separate reusable URL, and no readback', async () => {
    signingStore(); const result = await configCall('rotateWebhookSecret', { orgId: 'org-1' });
    expect(result.oneTimeDisplay).toBe(true);
    expect(result.callbackUrl).toBe('https://example.invalid/webhook/signed/org-1');
    expect(kvsStore.setSecret).toHaveBeenCalledWith('secret:org-1:webhookSigningSecret', result.secret);
    expect(JSON.stringify(await configCall('getOrganizations'))).not.toContain(FAKE_WEBHOOK_SECRET);
    expect(JSON.stringify(await configCall('exportOrgSettings', { orgId: 'org-1' }))).not.toContain(FAKE_WEBHOOK_SECRET);
  });
});

describe('F04 signing lifecycle and server-only recovery', () => {
  test('rotation immediately rejects the previous signing key without changing callback URL', async () => {
    webhookFromOrg();
    let activeSecret = FAKE_WEBHOOK_SECRET;
    kvsStore.getSecret.mockImplementation(async key => key === 'secret:org-1:webhookSigningSecret' ? activeSecret : FAKE_TOKEN);
    kvsStore.setSecret.mockImplementation(async (key, value) => { activeSecret = value; });
    expect((await runWebhook(signedRequest())).statusCode).toBe(200);
    const rotated = await configCall('rotateWebhookSecret', { orgId: 'org-1' });
    expect(rotated.secret).not.toBe(FAKE_WEBHOOK_SECRET);
    expect((await runWebhook(signedRequest())).statusCode).toBe(401);
    expect((await runWebhook(signedRequest(undefined, rotated.secret))).statusCode).toBe(200);
    expect(kvsStore.del).toHaveBeenCalledWith(webhookReceiptKey('org-1'));
  });
  test('URL generation failure still returns the one-time secret and permits separate URL retrieval', async () => {
    signingStore(); api.webTrigger.getUrl.mockRejectedValueOnce(new Error('unavailable'));
    const result = await configCall('rotateWebhookSecret', { orgId: 'org-1' });
    expect(result).toMatchObject({ success: true, oneTimeDisplay: true, callbackUrl: null });
    expect(result.secret).toHaveLength(43);
    expect((await configCall('getOrganizations'))[0].incomingWebhookUrl).toBe('https://example.invalid/webhook/signed/org-1');
  });
  test('failed secret storage returns a generic error with no secret or body', async () => {
    signingStore(); kvsStore.setSecret.mockRejectedValueOnce(new Error(FAKE_WEBHOOK_SECRET));
    const result = await configCall('rotateWebhookSecret', { orgId: 'org-1' });
    expect(result.success).toBe(false); expect(result.secret).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(FAKE_WEBHOOK_SECRET);
  });
  test('administrator enforcement rejects rotation before any secret read or write', async () => {
    const { createAuthorizedHandler } = await import('../src/resolvers/authorization.js');
    const handler = createAuthorizedHandler('rotateWebhookSecret', definitions.rotateWebhookSecret);
    api.asUser().requestJira.mockResolvedValue({ ok: true, json: async () => ({ permissions: { ADMINISTER: { havePermission: false } } }) });
    expect(await handler({ payload: { orgId: 'org-1' }, context: { accountId: 'user-1' } })).toMatchObject({ code: 'FORBIDDEN' });
    expect(kvsStore.getSecret).not.toHaveBeenCalled(); expect(kvsStore.setSecret).not.toHaveBeenCalled();
  });
  test('internal recovery validates persisted identifiers and obeys Pause without reading a signing key', async () => {
    const { recoverIncomingComment } = await import('../src/services/sync/incoming-sync.js');
    signingStore();
    const record = { direction: 'remote-to-local', orgId: 'org-1', issueKey: 'REMOTE-1', commentId: '123' };
    expect(await recoverIncomingComment({ ...record, orgId: '../org-1' })).toMatchObject({ status: 'CANCELLED' });
    kvsStore.get.mockImplementation(async key => key === 'organizations' ? [baseOrg()] : key === 'pilotPause' ? { paused: true } : null);
    expect((await recoverIncomingComment(record)).body.state).toBe('paused');
    expect(kvsStore.getSecret).not.toHaveBeenCalled();
  });
  test('trailing newline signature is malformed even with a matching digest', async () => {
    signingStore(); const request = signedRequest(); request.headers['X-Hub-Signature'][0] += '\n';
    expect((await runWebhook(request)).statusCode).toBe(401);
  });
  test('a different organization uses only its own signing key', async () => {
    signingStore(); kvsStore.get.mockResolvedValue([baseOrg(), baseOrg({ id: 'org-2' })]);
    kvsStore.getSecret.mockImplementation(async key => key === 'secret:org-2:webhookSigningSecret' ? 'org-two-signing-key' : FAKE_WEBHOOK_SECRET);
    const request = signedRequest(); request.userPath = '/signed/org-2';
    expect((await runWebhook(request)).statusCode).toBe(401);
    expect(kvsStore.getSecret).toHaveBeenCalledWith('secret:org-2:webhookSigningSecret');
    expect(kvsStore.getSecret).not.toHaveBeenCalledWith('secret:org-1:webhookSigningSecret');
  });
});

describe('F04 boundary and redaction regressions', () => {
  test.each([
    [request => { request.method = 'GET'; }, 405],
    [request => { request.headers['Content-Type'] = ['text/plain']; }, 415],
    [request => { request.body = ''; }, 400],
    [request => { request.body = 'x'.repeat(1024 * 1024 + 1); }, 413],
    [request => { request.queryParameters = { secret: FAKE_WEBHOOK_SECRET }; }, 401]
  ])('preserves HTTP boundary checks %#', async (change, status) => {
    signingStore(); const request = signedRequest(); change(request);
    expect((await runWebhook(request)).statusCode).toBe(status);
    expect(logAuditEntry).not.toHaveBeenCalled();
  });
  test.each(['null', '[]', '{"webhookEvent":"unknown"}'])('rejects signed invalid payload %s', async body => {
    signingStore(); expect((await runWebhook(signedRequest(body))).statusCode).toBe(400);
  });
  test('official Atlassian SHA-256 test vector authenticates before JSON rejection', async () => {
    signingStore(); kvsStore.getSecret.mockResolvedValue("It's a Secret to Everybody");
    const request = signedRequest('Hello World!');
    request.headers['X-Hub-Signature'] = ['sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9'];
    expect((await runWebhook(request)).statusCode).toBe(400);
  });
  test('a signed request to a push-only organization returns 403 without a verification receipt', async () => {
    signingStore(); kvsStore.get.mockResolvedValue([baseOrg({ syncDirection: 'push' })]);
    expect((await runWebhook(signedRequest())).statusCode).toBe(403);
    expect(kvsStore.set).not.toHaveBeenCalledWith(webhookReceiptKey('org-1'), expect.anything());
    expect(logAuditEntry).not.toHaveBeenCalled();
  });
  test('imported credentials and old callback URLs cannot provision signing keys', async () => {
    signingStore();
    const result = await configCall('importOrgSettings', { orgId: 'org-1', data: { org: {
      incomingSecret: FAKE_WEBHOOK_SECRET, webhookSigningSecret: FAKE_WEBHOOK_SECRET,
      incomingWebhookUrl: `https://example.invalid/org-1/${FAKE_WEBHOOK_SECRET}`
    } } });
    expect(result.success).toBe(true);
    expect(kvsStore.setSecret).not.toHaveBeenCalledWith('secret:org-1:webhookSigningSecret', expect.anything());
    const stored = kvsStore.set.mock.calls.find(([key]) => key === 'organizations')[1];
    expect(JSON.stringify(stored)).not.toContain(FAKE_WEBHOOK_SECRET);
  });
  test('deleting an organization removes its signed verification receipt', async () => {
    signingStore();
    const receiptKey = webhookReceiptKey('org-1');
    const records = new Map([[receiptKey, { receivedAt: '2026-10-24T10:00:00.000Z' }]]);
    kvsStore.del.mockImplementation(async key => { records.delete(key); });
    const result = await configCall('deleteOrganization', { id: 'org-1' });
    expect(result.success).toBe(true);
    expect(kvsStore.del).toHaveBeenCalledWith(receiptKey);
    expect(records.has(receiptKey)).toBe(false);
  });
  test('receipt reset failure aborts rotation before replacing a signing key', async () => {
    signingStore(); kvsStore.del.mockRejectedValueOnce(new Error('unavailable'));
    expect((await configCall('rotateWebhookSecret', { orgId: 'org-1' })).success).toBe(false);
    expect(kvsStore.setSecret).not.toHaveBeenCalled();
  });
  test('keys are generated independently per organization', async () => {
    signingStore(); kvsStore.get.mockResolvedValue([baseOrg(), baseOrg({ id: 'org-2' })]);
    randomBytes.mockReturnValueOnce(Buffer.alloc(32, 0x42)).mockReturnValueOnce(Buffer.alloc(32, 0x43));
    const first = await configCall('rotateWebhookSecret', { orgId: 'org-1' });
    const second = await configCall('rotateWebhookSecret', { orgId: 'org-2' });
    expect(first.secret).not.toBe(second.secret);
    expect(randomBytes).toHaveBeenCalledWith(32);
    expect(kvsStore.setSecret).toHaveBeenCalledWith('secret:org-1:webhookSigningSecret', first.secret);
    expect(kvsStore.setSecret).toHaveBeenCalledWith('secret:org-2:webhookSigningSecret', second.secret);
  });
  test('authentication failures never log secrets, signatures, or request bodies', async () => {
    signingStore(); const request = signedRequest();
    const spies = ['log', 'warn', 'error'].map(name => jest.spyOn(console, name).mockImplementation(() => {}));
    try {
      kvsStore.getSecret.mockRejectedValueOnce(new Error(`${FAKE_WEBHOOK_SECRET} ${request.body}`));
      const result = await runWebhook(request);
      const output = JSON.stringify([result, ...spies.map(spy => spy.mock.calls)]);
      expect(output).not.toContain(FAKE_WEBHOOK_SECRET);
      expect(output).not.toContain(request.body);
      expect(output).not.toContain(request.headers['X-Hub-Signature'][0]);
    } finally { spies.forEach(spy => spy.mockRestore()); }
  });
});
