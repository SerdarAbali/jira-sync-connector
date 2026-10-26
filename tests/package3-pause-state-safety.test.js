// The synchronization authorization gate has its own suite; this suite tests another behaviour.
jest.mock('../src/services/sync/sync-authorization.js', () => require('./helpers/authorized-sync-authorization.js'));

/**
 * Package 3: Pause-state safety.
 *
 * The production Pause module, the guarded Jira transport and the retry/write
 * gate run unmodified. Only the Forge KVS HTTP boundary and the Jira transport
 * call are modelled; a missing Pause record is a real KEY_NOT_FOUND response.
 *
 * Guarantee under test: an existing Pause record that does not carry a valid
 * boolean decision can never authorize a Jira mutation, while a missing record
 * keeps its intentional active behavior.
 */
import api, { fetch } from '@forge/api';
import {
  PILOT_PAUSE_KEY,
  PilotPausedError,
  getPilotPause,
  pausePilot,
  resumePilot,
  getPilotStatus,
  assertPilotWritesAllowed
} from '../src/services/sync/pilot-pause.js';
import { fetch as guardedFetch } from '../src/services/jira/guarded-api.js';
import { executeWriteWithRetry } from '../src/services/sync/write-retry.js';
import { processIncomingWebhook } from './helpers/signed-webhook.js';

jest.mock('@forge/api', () => ({
  __esModule: true,
  default: { asApp: () => ({ requestJira: jest.fn() }) },
  route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
  fetch: jest.fn()
}));

const requestJira = api.asApp().requestJira;
const forgeFetch = fetch;

const ORG = {
  id: 'org-1',
  name: 'Target Org',
  remoteUrl: 'https://remote.example.invalid',
  remoteEmail: 'remote@example.invalid',
  remoteApiToken: 'remote-token',
  remoteProjectKey: 'REMOTE',
  allowedProjects: ['LOCAL'],
  syncDirection: 'bidirectional'
};
const WEBHOOK_SECRET = 'abcdefghijklmnopqrstuvwx';
const MIGRATION = {
  version: 1,
  phase: 'entity-active',
  legacyDisabled: true,
  disabledAt: 0,
  activatedAt: 1140000
};
const JIRA_ISSUE_URL = 'https://remote.example.invalid/rest/api/3/issue';
const writeOptions = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };

const store = new Map();
const secrets = new Map();
let pauseReadFailure = null;

function kvsResponse(status, value) {
  return {
    ok: status < 400,
    status,
    headers: { get: () => null },
    text: async () => (value === undefined ? '' : JSON.stringify(value))
  };
}

function installKvsBoundary() {
  global.__forge_fetch__ = async (_target, path, request) => {
    const body = JSON.parse(request.body);
    if (path === '/api/v1/get') {
      if (body.key === 'issueLeaseMigration:v1') {
        return kvsResponse(200, { key: body.key, value: MIGRATION });
      }
      if (pauseReadFailure && body.key === PILOT_PAUSE_KEY) throw pauseReadFailure;
      if (store.has(body.key)) return kvsResponse(200, { key: body.key, value: store.get(body.key) });
      return kvsResponse(404, { code: 'KEY_NOT_FOUND', message: 'Missing' });
    }
    if (path === '/api/v1/secret/get') {
      if (secrets.has(body.key)) return kvsResponse(200, { key: body.key, value: secrets.get(body.key) });
      return kvsResponse(404, { code: 'KEY_NOT_FOUND', message: 'Missing' });
    }
    if (path === '/api/v1/set') {
      store.set(body.key, body.value);
      return kvsResponse(204);
    }
    throw new Error(`Unmodelled Forge KVS request: ${path}`);
  };
}

async function attemptWrite() {
  try {
    await guardedFetch(JIRA_ISSUE_URL, writeOptions);
    return 'submitted';
  } catch (error) {
    return error.code;
  }
}

function storedPause(value) {
  store.set(PILOT_PAUSE_KEY, value);
}

beforeEach(() => {
  store.clear();
  secrets.clear();
  pauseReadFailure = null;
  jest.clearAllMocks();
  forgeFetch.mockResolvedValue({ ok: true, status: 204 });
  store.set('organizations', [ORG]);
  secrets.set('secret:org-1:webhookSigningSecret', WEBHOOK_SECRET);
  secrets.set('secret:org-1:token', 'remote-token');
  installKvsBoundary();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Pause records that authorize Jira writes', () => {
  test('a missing record stays active for upgraded installations and submits once', async () => {
    expect(store.has(PILOT_PAUSE_KEY)).toBe(false);

    expect(await getPilotPause()).toEqual({
      paused: false,
      pausedAt: null,
      pausedBy: null,
      reasonCode: null
    });
    await expect(assertPilotWritesAllowed('issue_create_remote')).resolves.toBeUndefined();
    await expect(guardedFetch(JIRA_ISSUE_URL, writeOptions)).resolves.toEqual({ ok: true, status: 204 });
    expect(forgeFetch).toHaveBeenCalledTimes(1);
    expect(requestJira).not.toHaveBeenCalled();
  });

  test('an explicit boolean false stays active regardless of optional attribution', async () => {
    storedPause({
      paused: false,
      pausedAt: 42,
      pausedBy: { nested: true },
      reasonCode: 7,
      unrelated: 'ignored'
    });

    expect(await getPilotPause()).toEqual({
      paused: false,
      pausedAt: null,
      pausedBy: null,
      reasonCode: null
    });
    await expect(guardedFetch(JIRA_ISSUE_URL, writeOptions)).resolves.toEqual({ ok: true, status: 204 });
    expect(forgeFetch).toHaveBeenCalledTimes(1);
  });

  test('an explicit boolean true stays paused and blocks before transport', async () => {
    storedPause({
      paused: true,
      pausedAt: '2026-10-24T10:00:00.000Z',
      pausedBy: 'admin-1',
      reasonCode: 'maintenance'
    });

    expect(await getPilotPause()).toEqual({
      paused: true,
      pausedAt: '2026-10-24T10:00:00.000Z',
      pausedBy: 'admin-1',
      reasonCode: 'maintenance'
    });
    await expect(assertPilotWritesAllowed('issue_create_remote')).rejects.toMatchObject({
      code: 'PILOT_PAUSED',
      operation: 'issue_create_remote'
    });
    expect(await attemptWrite()).toBe('PILOT_PAUSED');
    expect(forgeFetch).not.toHaveBeenCalled();
    expect(requestJira).not.toHaveBeenCalled();
  });

  test('a paused decision without attribution metadata still blocks and exports null fields', async () => {
    storedPause({ paused: true, pausedAt: 1761314400000, pausedBy: 5, reasonCode: false });

    expect(await getPilotPause()).toEqual({
      paused: true,
      pausedAt: null,
      pausedBy: null,
      reasonCode: null
    });
    expect(await attemptWrite()).toBe('PILOT_PAUSED');
    expect(forgeFetch).not.toHaveBeenCalled();
  });

  test('a paused decision with only the boolean field blocks', async () => {
    storedPause({ paused: true });

    expect(await getPilotPause()).toEqual({
      paused: true,
      pausedAt: null,
      pausedBy: null,
      reasonCode: null
    });
    expect(await attemptWrite()).toBe('PILOT_PAUSED');
    expect(forgeFetch).not.toHaveBeenCalled();
  });
});

describe('Malformed existing Pause records fail closed', () => {
  const malformedRecords = [
    ['empty object', {}],
    ['string "true"', { paused: 'true' }],
    ['string "false"', { paused: 'false' }],
    ['number 1', { paused: 1 }],
    ['number 0', { paused: 0 }],
    ['null flag', { paused: null }],
    ['metadata without flag', { reasonCode: 'maintenance', pausedAt: '2026-10-24T10:00:00.000Z' }],
    ['array record', []],
    ['array with true', [true]],
    ['string record', 'paused'],
    ['number record', 42],
    ['boolean record true', true],
    ['boolean record false', false]
  ];

  test.each(malformedRecords)('%s never authorizes a guarded Jira mutation', async (_label, record) => {
    storedPause(record);

    expect((await getPilotPause()).paused).toBe(true);
    await expect(assertPilotWritesAllowed('issue_create_remote')).rejects.toBeInstanceOf(PilotPausedError);
    expect(await attemptWrite()).toBe('PILOT_PAUSED');
    expect(forgeFetch).not.toHaveBeenCalled();
    expect(requestJira).not.toHaveBeenCalled();
  });

  test.each(malformedRecords)('%s never authorizes the retry write gate', async (_label, record) => {
    storedPause(record);
    const write = jest.fn(async () => ({ ok: true, status: 200 }));

    await expect(executeWriteWithRetry(write, 'issue field update')).rejects.toMatchObject({
      code: 'PILOT_PAUSED',
      operation: 'issue field update'
    });
    expect(write).not.toHaveBeenCalled();
  });

  test('a malformed record is reported as paused and can be recovered by an explicit resume', async () => {
    storedPause({ paused: 'true' });

    const status = await getPilotStatus();
    expect(status).toMatchObject({ state: 'paused', paused: true, pausedAt: null, pausedBy: null, reasonCode: null });
    expect(status.organizations).toEqual([
      { id: 'org-1', name: 'Target Org', syncDirection: 'bidirectional' }
    ]);

    // Pausing again reports the fail-closed state without inventing attribution.
    await expect(pausePilot('maintenance', 'admin-1')).resolves.toMatchObject({
      paused: true,
      pausedAt: null,
      pausedBy: null,
      reasonCode: null
    });
    expect(store.get(PILOT_PAUSE_KEY)).toEqual({ paused: 'true' });

    // Resume is the existing administrator recovery path; it writes a valid record.
    const resumed = await resumePilot('admin-2');
    expect(resumed).toEqual({ paused: false, pausedAt: null, pausedBy: null, reasonCode: null });
    expect(store.get(PILOT_PAUSE_KEY)).toMatchObject({ paused: false, resumedBy: 'admin-2' });
    expect(await attemptWrite()).toBe('submitted');
    expect(forgeFetch).toHaveBeenCalledTimes(1);
  });

  test('a malformed record stops an inbound webhook before local Jira writes', async () => {
    storedPause({});

    const result = await processIncomingWebhook({
      webhookEvent: 'jira:issue_created',
      issue: { key: 'REMOTE-1', fields: { summary: 'Remote issue' } }
    }, { orgId: 'org-1', signingSecret: WEBHOOK_SECRET });

    expect(result).toEqual({
      status: 200,
      body: { message: 'Jira writes are paused', state: 'paused' }
    });
    expect(forgeFetch).not.toHaveBeenCalled();
    expect(requestJira).not.toHaveBeenCalled();
  });
});

describe('Unchanged Pause boundaries', () => {
  test('a storage error blocks both the pause check and the guarded transport', async () => {
    pauseReadFailure = Object.assign(new Error('storage unavailable'), { code: 'KVS_UNAVAILABLE' });

    await expect(assertPilotWritesAllowed('issue_create_remote')).rejects.toMatchObject({
      code: 'KVS_UNAVAILABLE'
    });
    expect(await attemptWrite()).toBe('PAUSE_STATE_UNAVAILABLE');
    expect(forgeFetch).not.toHaveBeenCalled();
  });

  test('a storage error blocks the retry write gate without attempting the write', async () => {
    pauseReadFailure = Object.assign(new Error('storage unavailable'), { code: 'KVS_UNAVAILABLE' });
    const write = jest.fn(async () => ({ ok: true, status: 200 }));

    await expect(executeWriteWithRetry(write, 'issue field update')).rejects.toMatchObject({
      code: 'PAUSE_STATE_UNAVAILABLE',
      operation: 'issue field update',
      causeCode: 'KVS_UNAVAILABLE'
    });
    expect(write).not.toHaveBeenCalled();
  });

  test('malformed Pause state does not block Jira reads or enhanced search', async () => {
    storedPause({ paused: 'true' });

    await expect(guardedFetch(`${JIRA_ISSUE_URL}/REMOTE-1`, { method: 'GET' }))
      .resolves.toEqual({ ok: true, status: 204 });
    await expect(guardedFetch('https://remote.example.invalid/rest/api/3/search/jql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    })).resolves.toEqual({ ok: true, status: 204 });
    expect(forgeFetch).toHaveBeenCalledTimes(2);
    expect(forgeFetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'POST']);
  });
});

