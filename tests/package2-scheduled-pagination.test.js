import { state as runtime, entities } from './helpers/forge-lease-runtime';
const mockStore = new Map();
const mockRequest = jest.fn();
jest.mock('@forge/api', () => ({ __esModule: true,
  default: { asApp: () => ({ requestJira: mockRequest }) },
  route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
  fetch: jest.fn()
}));
jest.mock('../src/services/storage/kvs.js', () => ({
  ...jest.requireActual('../src/services/storage/kvs.js'),
  get: jest.fn(async key => mockStore.get(key) ?? null),
  set: jest.fn(async (key, value) => { mockStore.set(key, value); })
}));
jest.mock('../src/services/storage/mappings.js', () => ({
  getOrganizationsWithTokens: jest.fn(), getRemoteKey: jest.fn(async key => key.replace('LOCAL', 'REMOTE')),
  getLocalKey: jest.fn(async () => null), getLastSyncedLocalUpdated: jest.fn(async () => null), storeLinkMapping: jest.fn()
}));
jest.mock('../src/services/storage/flags.js', () => ({
  listPendingLinkIssueKeys: jest.fn(async () => []), getPendingLinks: jest.fn(), removePendingLink: jest.fn(), recordPendingLinkAttempt: jest.fn()
}));
jest.mock('../src/services/jira/local-client.js', () => ({ getFullIssue: jest.fn(async key => ({ key, fields: {
  updated: '2026-10-24T08:00:00.000Z', project: { key: 'LOCAL' } } })) }));
jest.mock('../src/services/sync/issue-sync.js', () => ({ updateRemoteIssue: jest.fn(async () => ({ fields: true })) }));
jest.mock('../src/services/sync/link-sync.js', () => ({ syncIssueLinks: jest.fn(), remoteLinkMatches: jest.fn(), fetchRemoteIssueLinks: jest.fn() }));
jest.mock('../src/utils/retry.js', () => ({ ...jest.requireActual('../src/utils/retry.js'), sleep: jest.fn(async () => {}) }));

import { performScheduledSync } from '../src/services/scheduled/scheduled-sync.js';
import { getOrganizationsWithTokens } from '../src/services/storage/mappings.js';
import { updateRemoteIssue } from '../src/services/sync/issue-sync.js';
import { getFullIssue } from '../src/services/jira/local-client.js';
const ORG = { id: 'org-1', name: 'Organization', remoteUrl: 'https://remote.example.invalid', remoteProjectKey: 'REMOTE',
  allowedProjects: ['LOCAL'], syncDirection: 'bidirectional' };
const response = data => ({ ok: true, status: 200, json: async () => data });
const page = (keys, token = null) => ({ issues: keys.map(key => ({ key })), isLast: !token, ...(token ? { nextPageToken: token } : {}) });
const requests = () => mockRequest.mock.calls.map(([, opts]) => JSON.parse(opts.body));

beforeEach(() => {
  jest.clearAllMocks(); mockStore.clear(); runtime.basicStore = mockStore;
  mockStore.set('scheduledSyncConfig', { enabled: true, syncScope: 'all' });
  mockStore.set('organizations', [ORG]);
  mockStore.set('syncOptions:org-1', { syncLinks: false, syncComments: false, syncAttachments: false });
  getOrganizationsWithTokens.mockImplementation(async () => mockStore.get('organizations'));
  getFullIssue.mockImplementation(async key => ({ key, fields: { project: { key: 'LOCAL' }, updated: '2026-10-24T08:00:00.000Z' } }));
  updateRemoteIssue.mockImplementation(async () => ({ fields: true }));
  mockRequest.mockImplementation(async () => response(page([])));
});
afterEach(() => jest.restoreAllMocks());

test('multiple enhanced-search pages are consumed through opaque tokens', async () => {
  mockRequest.mockResolvedValueOnce(response(page(['LOCAL-1'], 'opaque-2'))).mockResolvedValueOnce(response(page(['LOCAL-2'])));
  const result = await performScheduledSync();
  expect(requests()).toHaveLength(2);
  expect(requests()[1].nextPageToken).toBe('opaque-2');
  expect(updateRemoteIssue.mock.calls.map(call => call[0])).toEqual(['LOCAL-1', 'LOCAL-2']);
  expect(result.incomplete).toBe(false);
  expect(mockStore.get('scheduled-scan:org-1').complete).toBe(true);
});

test('budget interruption within a page resumes the saved remainder before any new search', async () => {
  let now = Date.now(); const start = now;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  mockRequest.mockResolvedValueOnce(response(page(['LOCAL-1', 'LOCAL-2'], 'next')));
  updateRemoteIssue.mockImplementationOnce(async () => { now = start + 801000; return { fields: true }; });
  const first = await performScheduledSync();
  expect(first.incomplete).toBe(true);
  expect(mockStore.get('scheduled-scan:org-1').remaining).toEqual(['LOCAL-2']);
  now = start + 900000;
  mockRequest.mockResolvedValueOnce(response(page(['LOCAL-3'])));
  const second = await performScheduledSync();
  expect(second.incomplete).toBe(false);
  expect(requests()[1].nextPageToken).toBe('next');
  expect(updateRemoteIssue.mock.calls.map(call => call[0])).toEqual(['LOCAL-1', 'LOCAL-2', 'LOCAL-3']);
});

test.each([
  { issues: [], isLast: false }, { issues: [] }, { issues: [], isLast: true, warningMessages: ['incomplete'] },
  { issues: [{ key: null }], isLast: true }
])('malformed or incomplete search response is not complete: %j', async data => {
  mockRequest.mockResolvedValue(response(data));
  const result = await performScheduledSync();
  expect(result.incomplete).toBe(true);
  expect(updateRemoteIssue).not.toHaveBeenCalled();
  expect(mockStore.get('scheduled-scan:org-1')?.complete).not.toBe(true);
});

test('repeated continuation tokens stop boundedly without claiming completion', async () => {
  mockRequest.mockResolvedValue(response(page(['LOCAL-1'], 'cycle')));
  const result = await performScheduledSync();
  expect(requests().length).toBeLessThanOrEqual(3);
  expect(result.incomplete).toBe(true);
  expect(mockStore.get('scheduled-scan:org-1')?.complete).not.toBe(true);
});

test('failed issue work remains durable while a later page is examined', async () => {
  mockRequest.mockResolvedValueOnce(response(page(['LOCAL-1'], 'next')))
    .mockResolvedValueOnce(response(page(['LOCAL-2'])));
  updateRemoteIssue.mockRejectedValueOnce(new Error('scope unavailable'));
  const result = await performScheduledSync();
  expect(result.incomplete).toBe(true);
  expect(mockStore.get('scheduled-scan:org-1').deferred).toEqual(['LOCAL-1']);
  expect(mockStore.get('scheduled-scan:org-1').remaining).toEqual([]);
  expect(requests()).toHaveLength(2);
  expect(updateRemoteIssue.mock.calls.map(call => call[0])).toEqual(['LOCAL-1', 'LOCAL-2']);
});

test('organizations use separate progress and cannot borrow another scan token', async () => {
  mockStore.set('organizations', [ORG, { ...ORG, id: 'org-2' }]);
  mockRequest.mockResolvedValue(response(page([])));
  await performScheduledSync();
  expect(mockStore.get('scheduled-scan:org-1').complete).toBe(true);
  expect(mockStore.get('scheduled-scan:org-2').complete).toBe(true);
  expect(requests().every(request => !request.nextPageToken)).toBe(true);
});

test('Pause blocks work without advancing its scan', async () => {
  mockStore.set('pilotPause', { paused: true });
  mockRequest.mockResolvedValue(response(page(['LOCAL-1'])));
  const result = await performScheduledSync();
  expect(result.incomplete).toBe(true);
  expect(updateRemoteIssue).not.toHaveBeenCalled();
  expect(mockStore.get('scheduled-scan:org-1')?.complete).not.toBe(true);
});

test('concurrent scheduled workers cannot both acquire the same scan', async () => {
  let resume, entered;
  const held = new Promise(resolve => { resume = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  mockRequest.mockImplementation(async () => { entered(); if (mockRequest.mock.calls.length === 1) await held; return response(page([])); });
  const first = performScheduledSync(); await reached;
  try { await performScheduledSync(); } finally { resume(); await first; }
  expect(requests()).toHaveLength(1);
  expect(entities.size).toBe(0);
});

test('page limits persist a continuation for the next invocation', async () => {
  let index = 0;
  mockRequest.mockImplementation(async () => response(page([], `page-${++index}`)));
  const first = await performScheduledSync();
  expect(first.incomplete).toBe(true);
  expect(requests()).toHaveLength(10);
  expect(mockStore.get('scheduled-scan:org-1').nextPageToken).toBe('page-10');
  mockRequest.mockResolvedValueOnce(response(page(['LOCAL-11'])));
  await performScheduledSync();
  expect(requests()[10].nextPageToken).toBe('page-10');
  expect(mockStore.get('scheduled-scan:org-1').complete).toBe(true);
});

test('a saved page is not acted on when selection changes during a search', async () => {
  mockRequest.mockImplementation(async () => {
    mockStore.set('organizations', [{ ...ORG, allowedProjects: ['OTHER'] }]);
    return response(page(['LOCAL-1'], 'old-token'));
  });
  const first = await performScheduledSync();
  expect(first.incomplete).toBe(true);
  expect(updateRemoteIssue).not.toHaveBeenCalled();
  mockRequest.mockResolvedValue(response(page([])));
  await performScheduledSync();
  expect(requests()[1].nextPageToken).toBeUndefined();
  expect(requests()[1].jql).toContain('OTHER');
  expect(mockStore.get('scheduled-scan:org-1').complete).toBe(true);
});

test('Pause after a fetched page preserves it for safe resume', async () => {
  mockRequest.mockImplementationOnce(async () => {
    mockStore.set('pilotPause', { paused: true });
    return response(page(['LOCAL-1']));
  });
  const first = await performScheduledSync();
  expect(first.incomplete).toBe(true);
  expect(updateRemoteIssue).not.toHaveBeenCalled();
  expect(mockStore.get('scheduled-scan:org-1').remaining).toEqual(['LOCAL-1']);
  mockStore.delete('pilotPause');
  const second = await performScheduledSync();
  expect(second.incomplete).toBe(false);
  expect(requests()).toHaveLength(1);
  expect(updateRemoteIssue).toHaveBeenCalledTimes(1);
});

test('page persistence failure performs no issue work and does not mark complete', async () => {
  mockRequest.mockImplementationOnce(async () => {
    runtime.beforeTransaction = async () => { throw new Error('storage unavailable'); };
    return response(page(['LOCAL-1']));
  });
  const result = await performScheduledSync();
  expect(result.incomplete).toBe(true);
  expect(updateRemoteIssue).not.toHaveBeenCalled();
  expect(mockStore.get('scheduled-scan:org-1').complete).toBe(false);
});

test('failed checkpoint after issue work retains the exact issue for reconciliation', async () => {
  mockRequest.mockResolvedValue(response(page(['LOCAL-1', 'LOCAL-2'])));
  updateRemoteIssue.mockImplementationOnce(async () => {
    runtime.beforeTransaction = async () => { throw new Error('checkpoint unavailable'); };
    return { fields: true };
  });
  const result = await performScheduledSync();
  expect(result.incomplete).toBe(true);
  expect(mockStore.get('scheduled-scan:org-1').remaining).toEqual(['LOCAL-1', 'LOCAL-2']);
  expect(updateRemoteIssue).toHaveBeenCalledTimes(1);
});

test('an expired worker cannot overwrite a successor scan or release its ownership', async () => {
  let now = Date.now(); jest.spyOn(Date, 'now').mockImplementation(() => now);
  let resume, entered;
  const held = new Promise(resolve => { resume = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  mockRequest.mockImplementationOnce(async () => { entered(); await held; return response(page(['LOCAL-1'])); });
  const first = performScheduledSync(); await reached;
  now += 901000;
  mockRequest.mockResolvedValue(response(page([])));
  await performScheduledSync();
  const successor = mockStore.get('scheduled-scan:org-1');
  resume(); await first;
  expect(mockStore.get('scheduled-scan:org-1')).toEqual(successor);
  expect(successor.complete).toBe(true);
  expect(updateRemoteIssue).not.toHaveBeenCalled();
  expect(entities.size).toBe(0);
});

test.each([{ complete: 'yes' }, false, 0, ''])('malformed existing progress fails closed: %j', async stored => {
  mockStore.set('scheduled-scan:org-1', stored);
  const result = await performScheduledSync();
  expect(result.incomplete).toBe(true);
  expect(requests()).toHaveLength(0);
  expect(mockStore.get('scheduled-scan:org-1')).toEqual(stored);
});

test('search failure preserves incomplete progress and does not retry within the invocation', async () => {
  mockRequest.mockResolvedValue({ ok: false, status: 429 });
  const result = await performScheduledSync();
  expect(result.incomplete).toBe(true);
  expect(requests()).toHaveLength(1);
  expect(updateRemoteIssue).not.toHaveBeenCalled();
});

test('rejected and deferred update results retain the affected item', async () => {
  mockRequest.mockResolvedValue(response(page(['LOCAL-1'])));
  updateRemoteIssue.mockResolvedValueOnce({ skipped: true, status: 'OUTBOUND_SCOPE_BLOCKED' });
  const result = await performScheduledSync();
  expect(result.incomplete).toBe(true);
  expect(result.issuesUpdated).toBe(0);
  expect(mockStore.get('scheduled-scan:org-1').deferred).toEqual(['LOCAL-1']);
  expect(mockStore.get('scheduled-scan:org-1').remaining).toEqual([]);
});

test('ownership loss between the read check and atomic progress transaction cannot publish a stale page', async () => {
  mockRequest.mockImplementationOnce(async () => {
    const stealAtProgressWrite = async body => {
      if ((body.set || []).some(row => row.key === 'scheduled-scan:org-1')) {
        const [key, current] = [...entities][0];
        entities.set(key, { ...current, leaseToken: 'successor-token' });
      } else runtime.beforeTransaction = stealAtProgressWrite;
    };
    runtime.beforeTransaction = stealAtProgressWrite;
    return response(page(['LOCAL-1']));
  });
  const result = await performScheduledSync();
  expect(result.incomplete).toBe(true);
  expect(mockStore.get('scheduled-scan:org-1').remaining).toEqual([]);
  expect(mockStore.get('scheduled-scan:org-1').complete).toBe(false);
  expect(updateRemoteIssue).not.toHaveBeenCalled();
  expect([...entities.values()]).toEqual([expect.objectContaining({ leaseToken: 'successor-token' })]);
});

test('a persistently deferred issue cannot starve a later eligible issue across scheduled executions', async () => {
  let now = Date.now(); const start = now;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  mockRequest.mockResolvedValue(response(page(['LOCAL-1', 'LOCAL-2'])));
  updateRemoteIssue.mockImplementation(async key => {
    if (key === 'LOCAL-1') {
      now += 801000;
      return { skipped: true, status: 'OUTBOUND_SCOPE_BLOCKED' };
    }
    return { fields: true };
  });
  const first = await performScheduledSync();
  expect(first.issuesUpdated).toBe(0);
  now = start + 900000;
  const second = await performScheduledSync();
  expect(updateRemoteIssue.mock.calls.map(call => call[0])).toContain('LOCAL-2');
  expect(second.issuesUpdated).toBe(1);
  expect(second.incomplete).toBe(true);
  expect(mockStore.get('scheduled-scan:org-1').deferred).toEqual(['LOCAL-1']);
  expect(second.scans['org-1']).toMatchObject({ deferredCount: 1, deferredIssues: ['LOCAL-1'] });
  now += 900000;
  await performScheduledSync();
  expect(updateRemoteIssue.mock.calls.filter(call => call[0] === 'LOCAL-1')).toHaveLength(3);
  expect(mockStore.get('scheduled-scan:org-1').deferred).toEqual(['LOCAL-1']);
});

test('deferred work is reconsidered even after leaving the recent search window or changing scan scope', async () => {
  mockRequest.mockResolvedValueOnce(response(page(['LOCAL-1', 'LOCAL-2'])));
  updateRemoteIssue.mockImplementation(async key => key === 'LOCAL-1' ? { skipped: true } : { fields: true });
  await performScheduledSync();
  expect(mockStore.get('scheduled-scan:org-1').deferred).toEqual(['LOCAL-1']);
  mockStore.set('scheduledSyncConfig', { enabled: true, syncScope: 'recent' });
  mockRequest.mockResolvedValue(response(page([])));
  updateRemoteIssue.mockClear(); updateRemoteIssue.mockResolvedValue({ fields: true });
  const result = await performScheduledSync();
  expect(updateRemoteIssue.mock.calls.map(call => call[0])).toEqual(['LOCAL-1']);
  expect(mockStore.get('scheduled-scan:org-1').deferred).toEqual([]);
  expect(result.incomplete).toBe(false);
});

test('deferred reconsideration rotates fairly without an attempt-limit discard or an in-run retry loop', async () => {
  const keys = Array.from({ length: 7 }, (_, index) => `LOCAL-${index + 1}`);
  mockRequest.mockResolvedValueOnce(response(page([...keys, 'LOCAL-8'])));
  updateRemoteIssue.mockImplementation(async key => key === 'LOCAL-8' ? { fields: true } : { skipped: true });
  const first = await performScheduledSync();
  expect(first.issuesUpdated).toBe(1);
  mockRequest.mockResolvedValue(response(page([])));
  updateRemoteIssue.mockClear();
  await performScheduledSync();
  expect(updateRemoteIssue.mock.calls.map(call => call[0])).toEqual(keys.slice(0, 5));
  updateRemoteIssue.mockClear();
  await performScheduledSync();
  expect(updateRemoteIssue.mock.calls.map(call => call[0])).toEqual(['LOCAL-6', 'LOCAL-7', 'LOCAL-1', 'LOCAL-2', 'LOCAL-3']);
  expect(new Set(mockStore.get('scheduled-scan:org-1').deferred)).toEqual(new Set(keys));
});

test('bounded deferred capacity retains overflow in the page and retries free capacity without dropping work', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => `LOCAL-${index + 1}`);
  mockRequest.mockResolvedValueOnce(response(page(firstPage, 'next')))
    .mockResolvedValueOnce(response(page(['LOCAL-101', 'LOCAL-102'])));
  updateRemoteIssue.mockImplementation(async key => key === 'LOCAL-102' ? { fields: true } : { skipped: true });
  const first = await performScheduledSync();
  const saved = mockStore.get('scheduled-scan:org-1');
  expect(saved.deferred).toHaveLength(100);
  expect(saved.remaining).toEqual(['LOCAL-101', 'LOCAL-102']);
  expect(first.scans['org-1'].reason).toBe('deferred-capacity');
  expect(updateRemoteIssue.mock.calls.some(call => call[0] === 'LOCAL-102')).toBe(false);
  updateRemoteIssue.mockImplementation(async key => ['LOCAL-1', 'LOCAL-102'].includes(key) ? { fields: true } : { skipped: true });
  const second = await performScheduledSync();
  expect(second.incomplete).toBe(true);
  expect(mockStore.get('scheduled-scan:org-1').deferred).toHaveLength(99);
  const third = await performScheduledSync();
  expect(updateRemoteIssue.mock.calls.some(call => call[0] === 'LOCAL-102')).toBe(true);
  expect(third.incomplete).toBe(true);
  expect(mockStore.get('scheduled-scan:org-1').remaining).toEqual([]);
  expect(mockStore.get('scheduled-scan:org-1').deferred).toHaveLength(100);
  expect(mockStore.get('scheduled-scan:org-1').deferred).toContain('LOCAL-101');
  expect(mockStore.get('scheduled-scan:org-1').deferred).not.toContain('LOCAL-1');
});

test('failed transfer into deferred storage leaves the original item durable and unadvanced', async () => {
  mockRequest.mockResolvedValueOnce(response(page(['LOCAL-1', 'LOCAL-2'])));
  updateRemoteIssue.mockImplementationOnce(async () => {
    runtime.beforeTransaction = async () => { throw new Error('storage unavailable'); };
    return { skipped: true };
  });
  const result = await performScheduledSync();
  expect(result.incomplete).toBe(true);
  expect(mockStore.get('scheduled-scan:org-1').remaining).toEqual(['LOCAL-1', 'LOCAL-2']);
  expect(mockStore.get('scheduled-scan:org-1').deferred).toEqual([]);
  expect(updateRemoteIssue).toHaveBeenCalledTimes(1);
});

test('Pause before deferred reconsideration leaves its durable queue untouched', async () => {
  mockRequest.mockResolvedValueOnce(response(page(['LOCAL-1'])));
  updateRemoteIssue.mockResolvedValue({ skipped: true });
  await performScheduledSync();
  updateRemoteIssue.mockClear();
  mockStore.set('pilotPause', { paused: true });
  const result = await performScheduledSync();
  expect(result.incomplete).toBe(true);
  expect(updateRemoteIssue).not.toHaveBeenCalled();
  expect(mockStore.get('scheduled-scan:org-1').deferred).toEqual(['LOCAL-1']);
});

test('deferred queues remain isolated by organization during later reconsideration', async () => {
  mockStore.set('organizations', [ORG, { ...ORG, id: 'org-2' }]);
  mockRequest.mockResolvedValueOnce(response(page(['LOCAL-1']))).mockResolvedValueOnce(response(page(['LOCAL-2'])));
  updateRemoteIssue.mockImplementation(async key => key === 'LOCAL-1' ? { skipped: true } : { fields: true });
  await performScheduledSync();
  mockRequest.mockResolvedValue(response(page([])));
  updateRemoteIssue.mockClear();
  await performScheduledSync();
  expect(updateRemoteIssue.mock.calls.map(call => [call[0], call[3].id])).toEqual([['LOCAL-1', 'org-1']]);
  expect(mockStore.get('scheduled-scan:org-1').deferred).toEqual(['LOCAL-1']);
  expect(mockStore.get('scheduled-scan:org-2').deferred).toEqual([]);
});

test('a retry exceeding its lease cannot pin another deferred issue ahead of future reconsideration', async () => {
  let now = Date.now(); jest.spyOn(Date, 'now').mockImplementation(() => now);
  mockRequest.mockResolvedValueOnce(response(page(['LOCAL-1', 'LOCAL-2'])));
  updateRemoteIssue.mockResolvedValue({ skipped: true });
  await performScheduledSync();
  mockRequest.mockResolvedValue(response(page([])));
  updateRemoteIssue.mockImplementationOnce(async () => { now += 901000; return { skipped: true }; });
  await performScheduledSync();
  expect(mockStore.get('scheduled-scan:org-1').deferred).toEqual(['LOCAL-2', 'LOCAL-1']);
  updateRemoteIssue.mockClear();
  updateRemoteIssue.mockImplementation(async key => key === 'LOCAL-2' ? { fields: true } : { skipped: true });
  await performScheduledSync();
  expect(updateRemoteIssue.mock.calls[0][0]).toBe('LOCAL-2');
  expect(mockStore.get('scheduled-scan:org-1').deferred).toEqual(['LOCAL-1']);
});

test('repeated complete primary pages preserve every deferred retry position and selective recovery', async () => {
  const keys = Array.from({ length: 20 }, (_, index) => `LOCAL-${index + 1}`);
  mockRequest.mockResolvedValue(response(page(keys)));
  updateRemoteIssue.mockResolvedValue({ skipped: true, status: 'OUTBOUND_SCOPE_BLOCKED' });
  const initial = await performScheduledSync();
  expect(initial.issuesUpdated).toBe(0);
  expect(mockStore.get('scheduled-scan:org-1').deferred).toEqual(keys);

  const windows = [];
  const reconsidered = new Set();
  for (let run = 0; run < 39; run++) {
    updateRemoteIssue.mockClear();
    const result = await performScheduledSync();
    const attempts = updateRemoteIssue.mock.calls.map(call => call[0]);
    windows.push(attempts);
    attempts.forEach(key => reconsidered.add(key));
    const saved = mockStore.get('scheduled-scan:org-1');
    expect(new Set(saved.deferred)).toEqual(new Set(keys));
    expect(saved.deferred.length).toBeLessThanOrEqual(100);
    expect(saved.remaining).toEqual([]);
    expect(result.scans['org-1'].scanComplete).toBe(true);
    expect(result.incomplete).toBe(true);
    expect(result.issuesUpdated).toBe(0);
    expect(result.lastSuccessfulJiraWrite).toBeNull();
    expect(entities.size).toBe(0);
  }
  // Exclude the initial attempt: every identity must receive actual later
  // reconsideration, rather than being counted again on primary encounters.
  expect([...reconsidered].sort()).toEqual([...keys].sort());
  expect(windows).toEqual(Array.from({ length: 39 }, (_, run) => keys.slice((run % 4) * 5, (run % 4) * 5 + 5)));
  expect(requests()).toHaveLength(40);

  const recovered = new Set(['LOCAL-12', 'LOCAL-19']);
  const successful = new Set();
  updateRemoteIssue.mockImplementation(async key => {
    if (recovered.has(key)) { successful.add(key); return { fields: true }; }
    return { skipped: true, status: 'OUTBOUND_SCOPE_BLOCKED' };
  });
  for (let run = 0; run < 8; run++) {
    updateRemoteIssue.mockClear();
    const result = await performScheduledSync();
    const saved = mockStore.get('scheduled-scan:org-1');
    expect(new Set(saved.deferred)).toEqual(new Set(keys.filter(key => !successful.has(key))));
    expect(saved.remaining).toEqual([]);
    expect(saved.complete).toBe(false);
    expect(result.scans['org-1'].scanComplete).toBe(true);
    expect(result.incomplete).toBe(true);
    expect(result.issuesUpdated).toBe(updateRemoteIssue.mock.calls.filter(call => recovered.has(call[0])).length);
    expect(entities.size).toBe(0);
  }
  expect(successful).toEqual(recovered);
  expect(mockStore.get('scheduled-scan:org-1').deferred).toHaveLength(18);
  expect(requests()).toHaveLength(48);
}, 15000);

test('primary advancement of an already-deferred issue cannot bypass successor ownership', async () => {
  const keys = Array.from({ length: 20 }, (_, index) => `LOCAL-${index + 1}`);
  mockRequest.mockResolvedValue(response(page(keys)));
  updateRemoteIssue.mockResolvedValue({ skipped: true });
  await performScheduledSync();
  updateRemoteIssue.mockClear();
  mockRequest.mockImplementationOnce(async () => {
    const stealAtPrimaryAdvance = async body => {
      if ((body.set || []).some(row => row.key === 'scheduled-scan:org-1' && row.value.remaining.length === 19)) {
        const [key, current] = [...entities][0];
        entities.set(key, { ...current, leaseToken: 'successor-token' });
      } else runtime.beforeTransaction = stealAtPrimaryAdvance;
    };
    runtime.beforeTransaction = stealAtPrimaryAdvance;
    return response(page(keys));
  });
  const result = await performScheduledSync();
  expect(result.incomplete).toBe(true);
  expect(mockStore.get('scheduled-scan:org-1').remaining).toEqual(keys);
  expect(mockStore.get('scheduled-scan:org-1').deferred).toEqual(keys);
  expect(updateRemoteIssue).not.toHaveBeenCalled();
  expect([...entities.values()]).toEqual([expect.objectContaining({ leaseToken: 'successor-token' })]);
});
