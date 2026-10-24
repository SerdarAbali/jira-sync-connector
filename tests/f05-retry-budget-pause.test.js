/**
 * F05 regressions: Forge-safe Jira retries and emergency-pause enforcement.
 *
 * These tests drive the production retry helpers (utils/retry.js,
 * services/sync/write-retry.js) and a representative production write path
 * (updateIssueForOrg -> remote field PUT) against the real pilot-pause store
 * reader. Nothing is mocked at the retry layer, so a regression in the shipped
 * code fails here.
 */
import { fetch } from '@forge/api';

const mockStore = new Map();

import { updateIssueForOrg } from '../src/services/sync/issue-sync.js';
import { getRemoteIssue } from '../src/services/jira/remote-client.js';
import { executeWriteWithRetry } from '../src/services/sync/write-retry.js';
import {
  createRetryBudget,
  parseRetryAfterMs,
  executeWriteOnce,
  retryWithBackoff
} from '../src/utils/retry.js';
import { PILOT_PAUSE_KEY, getPilotPause } from '../src/services/sync/pilot-pause.js';
import { RETRY_SAFE_BUDGET_MS, MAX_RETRY_AFTER_MS } from '../src/constants.js';
import * as kvs from '../src/services/storage/kvs.js';
import { setLastSyncedLocalUpdated } from '../src/services/storage/mappings.js';

jest.mock('@forge/api', () => ({
  __esModule: true,
  default: { asApp: () => ({ requestJira: jest.fn() }) },
  route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
  fetch: jest.fn()
}));

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(async key => (mockStore.has(key) ? mockStore.get(key) : null)),
  set: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  del: jest.fn(async key => { mockStore.delete(key); }),
  setIfNotExists: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  queryByPrefix: jest.fn(async prefix => Array.from(mockStore, ([key, value]) => ({ key, value }))
    .filter(row => row.key.startsWith(prefix))),
  getSecret: jest.fn(async () => 'secret')
}));

jest.mock('../src/services/storage/mappings.js', () => ({
  getRemoteKey: jest.fn(),
  getLocalKey: jest.fn(),
  storeMapping: jest.fn(),
  getOrganizationsWithTokens: jest.fn(),
  setLastSyncedLocalUpdated: jest.fn(),
  storeLinkMapping: jest.fn(),
  getRemoteCommentId: jest.fn()
}));

jest.mock('../src/services/storage/flags.js', () => ({
  markSyncing: jest.fn(),
  clearSyncFlag: jest.fn(),
  isSyncing: jest.fn(),
  findPendingLinksToIssue: jest.fn(),
  removePendingLink: jest.fn()
}));

jest.mock('../src/services/storage/stats.js', () => ({
  trackWebhookSync: jest.fn(),
  trackApiCall: jest.fn(),
  logAuditEntry: jest.fn()
}));

jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn(),
  getOrgName: jest.fn(async () => 'Local Org'),
  updateLocalIssueDescription: jest.fn(async () => true)
}));

jest.mock('../src/services/sync/attachment-sync.js', () => ({ syncAttachments: jest.fn() }));
jest.mock('../src/services/sync/link-sync.js', () => ({ syncIssueLinks: jest.fn(), createLinkOnRemote: jest.fn() }));
jest.mock('../src/services/sync/comment-sync.js', () => ({ syncAllComments: jest.fn() }));
jest.mock('../src/services/sync/transition-sync.js', () => ({ transitionRemoteIssue: jest.fn() }));

const org = {
  id: 'org-1',
  name: 'Remote Org',
  remoteUrl: 'https://remote.example.invalid',
  remoteEmail: 'sync@example.invalid',
  remoteApiToken: 'test-token',
  remoteProjectKey: 'REMOTE'
};

const mappings = { userMappings: {}, fieldMappings: {}, statusMappings: {}, issueTypeMappings: {} };
const syncOptions = { syncAttachments: false, syncLinks: false, syncComments: false, syncCrossReference: false };

const localIssue = () => ({
  key: 'LOCAL-1',
  fields: {
    project: { key: 'LOCAL' },
    summary: 'Issue with summary',
    description: null,
    issuetype: { name: 'Task', id: '1' },
    updated: '2026-01-01T00:00:00.000Z',
    status: { name: 'To Do' },
    labels: [],
    components: [],
    fixVersions: [],
    versions: []
  }
});

const throttled = (retryAfter) => ({
  ok: false,
  status: 429,
  headers: { get: name => (String(name).toLowerCase() === 'retry-after' ? retryAfter : null) },
  text: async () => '',
  json: async () => ({})
});

const readOnlyResponse = { ok: true, status: 200, text: async () => '', json: async () => ({ fields: {} }) };

const putCalls = () => fetch.mock.calls.filter(([, options]) => options?.method === 'PUT');

function pauseNow() {
  mockStore.set(PILOT_PAUSE_KEY, {
    paused: true,
    pausedAt: '2026-10-23T10:00:00.000Z',
    pausedBy: 'admin-1',
    reasonCode: 'emergency_stop'
  });
}

// Captured before any test overrides it, so a failing assertion cannot leak a
// broken pause reader into the rest of the suite.
const baseKvsGet = kvs.get.getMockImplementation();

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  mockStore.set('organizations', [{ ...org, allowedProjects: ['LOCAL'] }]);
  require('../src/services/jira/local-client.js').getFullIssue.mockResolvedValue(localIssue());
  kvs.get.mockImplementation(baseKvsGet);
  fetch.mockResolvedValue(readOnlyResponse);
});

afterEach(() => {
  kvs.get.mockImplementation(baseKvsGet);
});


describe('F05 Pause enforcement on retried writes', () => {
  test('scenario 1: pause activated during the Retry-After window blocks every further write', async () => {
    fetch.mockImplementation(async (url, options) => {
      if (options?.method === 'PUT') {
        pauseNow(); // administrator activates the emergency pause while Jira throttles
        return throttled('0');
      }
      return readOnlyResponse;
    });

    const result = await updateIssueForOrg('LOCAL-1', 'REMOTE-1', localIssue(), org, mappings, syncOptions);

    expect(result).toBeNull();
    expect(putCalls()).toHaveLength(1);
    expect(setLastSyncedLocalUpdated).not.toHaveBeenCalled();
    expect(await getPilotPause()).toMatchObject({ paused: true, reasonCode: 'emergency_stop' });
  }, 15000);

  test('scenario 2: an unverifiable Pause state blocks the retried write (fail closed)', async () => {
    let failPauseReads = false;
    fetch.mockImplementation(async (url, options) => {
      if (options?.method === 'PUT') {
        failPauseReads = true; // storage becomes unavailable during the wait
        return throttled('0');
      }
      return readOnlyResponse;
    });
    kvs.get.mockImplementation(async key => {
      if (key === PILOT_PAUSE_KEY && failPauseReads) throw new Error('storage unavailable');
      return baseKvsGet(key);
    });

    const result = await updateIssueForOrg('LOCAL-1', 'REMOTE-1', localIssue(), org, mappings, syncOptions);

    expect(result).toBeNull();
    expect(putCalls()).toHaveLength(1);
    expect(setLastSyncedLocalUpdated).not.toHaveBeenCalled();
  }, 15000);

  test('scenario 2b: the write wrapper classifies an unverifiable Pause read as PAUSE_STATE_UNAVAILABLE', async () => {
    const write = jest.fn(async () => ({ ok: true, status: 204 }));
    kvs.get.mockImplementation(async key => {
      if (key === PILOT_PAUSE_KEY) throw new Error('storage unavailable');
      return baseKvsGet(key);
    });

    await expect(executeWriteWithRetry(write, 'guarded write')).rejects.toMatchObject({
      code: 'PAUSE_STATE_UNAVAILABLE'
    });
    expect(write).not.toHaveBeenCalled();
  });
});


describe('F05 bounded retry budgets', () => {
  test('scenario 3: a 60 second Retry-After never sleeps inside a short invocation', async () => {
    fetch.mockImplementation(async (url, options) => {
      if (options?.method === 'PUT') return throttled('60');
      return readOnlyResponse;
    });

    const started = Date.now();
    const result = await updateIssueForOrg('LOCAL-1', 'REMOTE-1', localIssue(), org, mappings, syncOptions);
    const elapsed = Date.now() - started;

    expect(result).toBeNull();
    expect(putCalls()).toHaveLength(1);
    expect(elapsed).toBeLessThan(1000);
  }, 15000);

  test('scenario 3b: the shared helper reports the bounded deadline instead of sleeping', async () => {
    const started = Date.now();
    const write = jest.fn(async () => throttled('60'));

    await expect(executeWriteWithRetry(write, 'rate limited write')).rejects.toMatchObject({
      code: 'RATE_LIMIT_DEFERRED',
      retryAfterMs: 60000,
      status: 429
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('scenario 4: a retry never happens before the full Retry-After deadline', async () => {
    const started = [];
    fetch.mockImplementation(async (url, options) => {
      if (options?.method === 'PUT') {
        started.push(Date.now());
        return started.length === 1 ? throttled('1') : { ok: true, status: 204, text: async () => '' };
      }
      return readOnlyResponse;
    });

    const result = await updateIssueForOrg('LOCAL-1', 'REMOTE-1', localIssue(), org, mappings, syncOptions);

    expect(putCalls()).toHaveLength(2);
    expect(started[1] - started[0]).toBeGreaterThanOrEqual(950);
    expect(result).not.toBeNull();
  }, 15000);

  test('scenario 5: with Pause off and budget available an ordinary retry succeeds once', async () => {
    const written = [];
    fetch.mockImplementation(async (url, options) => {
      if (options?.method === 'PUT') {
        written.push(url);
        return written.length === 1 ? throttled('0') : { ok: true, status: 204, text: async () => '' };
      }
      return readOnlyResponse;
    });

    const result = await updateIssueForOrg('LOCAL-1', 'REMOTE-1', localIssue(), org, mappings, syncOptions);

    expect(result).not.toBeNull();
    expect(putCalls()).toHaveLength(2);
    expect(setLastSyncedLocalUpdated).toHaveBeenCalled();
  }, 15000);

  test('scenario 6: reads keep working while paused and never sleep through a long Retry-After', async () => {
    pauseNow();
    fetch.mockResolvedValue(throttled('60'));

    const started = Date.now();
    const result = await getRemoteIssue('REMOTE-1', {
      remoteUrl: org.remoteUrl,
      remoteEmail: org.remoteEmail,
      remoteApiToken: org.remoteApiToken
    });
    const elapsed = Date.now() - started;

    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(1000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET' });
  });

  test('scenario 7: nested retry layers share one budget and cannot exceed it', async () => {
    const budget = createRetryBudget({ budgetMs: 1200 });
    let attempts = 0;
    const write = jest.fn(async () => {
      attempts += 1;
      return attempts === 1 ? throttled('1') : { ok: true, status: 204 };
    });

    const response = await executeWriteWithRetry(write, 'shared budget write', { budget });
    expect(response).toMatchObject({ status: 204 });

    const started = Date.now();
    await expect(executeWriteWithRetry(async () => throttled('1'), 'second write', { budget }))
      .rejects.toMatchObject({ code: 'RATE_LIMIT_DEFERRED', retryAfterMs: 1000 });
    expect(Date.now() - started).toBeLessThan(500);
  }, 15000);

  test('scenario 7b: an outer retry layer cannot resubmit a write after Pause', async () => {
    const budget = createRetryBudget({ budgetMs: 5000 });
    const write = jest.fn(async () => {
      pauseNow();
      return throttled('0');
    });

    await expect(
      retryWithBackoff(
        async () => executeWriteWithRetry(write, 'nested write', { budget }),
        'outer retry layer',
        3,
        { budget, initialDelay: 10, maxDelay: 10 }
      )
    ).rejects.toMatchObject({ code: 'PILOT_PAUSED' });

    expect(write).toHaveBeenCalledTimes(1);
  }, 15000);

  test('scenario 8: an ambiguous write outcome is never retried', async () => {
    const write = jest.fn().mockRejectedValue(new Error('socket hang up'));

    await expect(executeWriteWithRetry(write, 'ambiguous write')).rejects.toMatchObject({
      code: 'AMBIGUOUS_WRITE_OUTCOME'
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  test('scenario 8b: a production PUT with an ambiguous outcome is attempted once', async () => {
    fetch.mockImplementation(async (url, options) => {
      if (options?.method === 'PUT') throw new Error('socket hang up');
      return readOnlyResponse;
    });

    const result = await updateIssueForOrg('LOCAL-1', 'REMOTE-1', localIssue(), org, mappings, syncOptions);

    expect(result).toBeNull();
    expect(putCalls()).toHaveLength(1);
  }, 15000);

  test.each([
    ['blocked', 'PROJECT_NOT_ALLOWED'],
    ['unverifiable', 'SOURCE_SELECTION_UNAVAILABLE']
  ])('a production PUT reports its original %s scope rejection before submission', async (mode, reason) => {
    const { getFullIssue } = require('../src/services/jira/local-client.js');
    getFullIssue.mockResolvedValueOnce(localIssue()); // Entry scope check succeeds.
    if (mode === 'blocked') {
      getFullIssue.mockResolvedValueOnce({ ...localIssue(), fields: { project: { key: 'OTHER' } } });
    } else {
      getFullIssue.mockRejectedValueOnce(new Error('source unavailable'));
    }
    const syncResult = { addError: jest.fn() };

    const result = await updateIssueForOrg('LOCAL-1', 'REMOTE-1', localIssue(), org, mappings, syncOptions, syncResult);

    expect(result).toBeNull();
    expect(getFullIssue).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.filter(([, options]) => ['POST', 'PUT', 'DELETE'].includes(options?.method))).toHaveLength(0);
    expect(setLastSyncedLocalUpdated).not.toHaveBeenCalled();
    expect(syncResult.addError).toHaveBeenCalledWith(`Error updating remote issue: Outbound source selection denied: ${reason}`);
    expect(syncResult.addError).toHaveBeenCalledTimes(1);
  });

describe('F05 Retry-After representation', () => {
  test('seconds, HTTP-date and oversized deadlines are parsed and bounded', () => {
    expect(parseRetryAfterMs({ get: () => '120' })).toBe(120000);
    expect(parseRetryAfterMs({ get: () => '999999999' })).toBe(MAX_RETRY_AFTER_MS);
    const future = new Date(Date.now() + 60000).toUTCString();
    expect(parseRetryAfterMs({ get: () => future })).toBeGreaterThan(58000);
    expect(parseRetryAfterMs({ get: () => 'not-a-date' })).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
  });

  test('the default write budget fits the shortest supported Forge invocation', () => {
    expect(createRetryBudget().budgetMs).toBe(RETRY_SAFE_BUDGET_MS);
    expect(RETRY_SAFE_BUDGET_MS).toBeLessThan(25000);
  });

  test('single-shot writes stay single-shot and preserve the bounded server deadline', async () => {
    const fn = jest.fn(async () => throttled('7200'));

    await expect(executeWriteOnce(fn, 'Create issue')).rejects.toMatchObject({
      code: 'RATE_LIMITED_WRITE_OUTCOME',
      status: 429,
      retryAfterMs: MAX_RETRY_AFTER_MS
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

});
