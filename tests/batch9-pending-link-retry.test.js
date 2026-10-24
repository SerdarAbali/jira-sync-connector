const mockStore = new Map();

jest.mock('@forge/api', () => {
  const fetchMock = jest.fn();
  const requestJira = jest.fn();
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
  queryByPrefix: jest.fn(async prefix => [...mockStore.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => ({ key, value })))
}));

jest.mock('../src/services/storage/mappings.js', () => ({
  getRemoteKey: jest.fn(),
  getLocalKey: jest.fn(),
  storeLinkMapping: jest.fn(),
  getOrganizationsWithTokens: jest.fn(),
  getLastSyncedLocalUpdated: jest.fn()
}));

jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn()
}));

jest.mock('../src/services/sync/issue-sync.js', () => ({
  updateRemoteIssue: jest.fn()
}));

jest.mock('../src/services/sync/link-sync.js', () => ({
  syncIssueLinks: jest.fn(),
  fetchRemoteIssueLinks: jest.fn(),
  remoteLinkMatches: (remoteLink, remoteLinkedKey, linkTypeName, direction) => {
    if (!remoteLink || remoteLink.type?.name !== linkTypeName) return false;
    const counterpart = direction === 'outward' ? remoteLink.outwardIssue : remoteLink.inwardIssue;
    return counterpart?.key === remoteLinkedKey;
  }
}));

jest.mock('../src/services/sync/pilot-pause.js', () => ({
  assertPilotWritesAllowed: jest.fn(async () => undefined)
}));

jest.mock('../src/services/storage/stats.js', () => ({
  trackApiCall: jest.fn(async () => undefined),
  logAuditEntry: jest.fn(async () => undefined),
  trackWebhookSync: jest.fn(async () => undefined)
}));

import { getFullIssue } from '../src/services/jira/local-client.js';
import { getLocalKey } from '../src/services/storage/mappings.js';
import { fetch as mockFetch } from '@forge/api';
import { retryAllPendingLinks } from '../src/services/scheduled/scheduled-sync.js';
import { fetchRemoteIssueLinks } from '../src/services/sync/link-sync.js';
import { getRemoteKey, storeLinkMapping } from '../src/services/storage/mappings.js';
import { getPendingLinks, storePendingLink } from '../src/services/storage/flags.js';

const config = {
  id: 'org-1',
  remoteUrl: 'https://remote.example.invalid',
  remoteEmail: 'sync@example.invalid',
  remoteApiToken: 'test-token'
};

const pendingLink = {
  linkId: 'LINK-1',
  linkedIssueKey: 'LOCAL-B',
  direction: 'inward',
  linkTypeName: 'Blocks',
  orgId: 'org-1'
};

function emptyStats() {
  return { errors: [], events: [] };
}

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
  mockStore.set('organizations', [{ ...config, allowedProjects: ['LOCAL'] }]);
  getFullIssue.mockImplementation(async key => ({ key, fields: { project: { key: 'LOCAL' } } }));
  getLocalKey.mockImplementation(async key => key.replace('REMOTE-', 'LOCAL-'));
  fetchRemoteIssueLinks.mockResolvedValue({ ok: true, links: [] });
  getRemoteKey.mockImplementation(async key => {
    if (key === 'LOCAL-A') return 'REMOTE-A';
    if (key === 'LOCAL-B') return 'REMOTE-B';
    return null;
  });
});


describe('Batch 9 scheduled pending-link retry', () => {
  test('discovers the pending-link-idx prefix written by storePendingLink and succeeds', async () => {
    await storePendingLink('LOCAL-A', pendingLink);
    mockFetch.mockResolvedValue({ ok: true, status: 201 });

    const result = await retryAllPendingLinks(config, {}, emptyStats());

    expect(result).toEqual({ retried: 1, success: 1, failed: 0, stillPending: 0 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(storeLinkMapping).toHaveBeenCalledWith('LINK-1', 'synced', 'org-1');
    expect(mockStore.has('pending-links:LOCAL-A')).toBe(false);
    expect(mockStore.has('pending-link-idx:LOCAL-A')).toBe(false);
  });

  test('deduplicates source issue keys returned by the prefix query', async () => {
    await storePendingLink('LOCAL-A', pendingLink);
    const kvs = require('../src/services/storage/kvs.js');
    kvs.queryByPrefix.mockResolvedValueOnce([
      { key: 'pending-link-idx:LOCAL-A', value: await getPendingLinks('LOCAL-A') },
      { key: 'pending-link-idx:LOCAL-A', value: await getPendingLinks('LOCAL-A') }
    ]);
    mockFetch.mockResolvedValue({ ok: true, status: 201 });

    const result = await retryAllPendingLinks(config, {}, emptyStats());

    expect(result.success).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('keeps a still-pending link and increments its attempts counter', async () => {
    await storePendingLink('LOCAL-A', pendingLink);
    getRemoteKey.mockImplementation(async key => (key === 'LOCAL-A' ? 'REMOTE-A' : null));

    const result = await retryAllPendingLinks(config, {}, emptyStats());
    const pending = await getPendingLinks('LOCAL-A');

    expect(result).toEqual({ retried: 1, success: 0, failed: 0, stillPending: 1 });
    expect(pending).toHaveLength(1);
    expect(pending[0].attempts).toBe(2);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('drops a still-pending link at the maximum attempt limit', async () => {
    await storePendingLink('LOCAL-A', pendingLink);
    const seeded = await getPendingLinks('LOCAL-A');
    seeded[0].attempts = 9;
    mockStore.set('pending-links:LOCAL-A', seeded);
    mockStore.set('pending-link-idx:LOCAL-A', seeded);
    getRemoteKey.mockImplementation(async key => (key === 'LOCAL-A' ? 'REMOTE-A' : null));

    const stats = emptyStats();
    const result = await retryAllPendingLinks(config, {}, stats);

    expect(result).toEqual({ retried: 1, success: 0, failed: 1, stillPending: 0 });
    expect(mockStore.has('pending-links:LOCAL-A')).toBe(false);
    expect(stats.events.some(event => event.type === 'link-dropped')).toBe(true);
  });

  test('keeps a transient 5xx link pending but marks it for reconciliation and does not repeat the POST', async () => {
    await storePendingLink('LOCAL-A', pendingLink);
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const first = await retryAllPendingLinks(config, {}, emptyStats());
    const pendingAfterFirst = await getPendingLinks('LOCAL-A');

    expect(first).toEqual({ retried: 1, success: 0, failed: 1, stillPending: 1 });
    expect(pendingAfterFirst[0]).toEqual(expect.objectContaining({
      attempts: 2,
      reconciliationRequired: true
    }));

    const second = await retryAllPendingLinks(config, {}, emptyStats());

    expect(second).toEqual({ retried: 1, success: 0, failed: 1, stillPending: 1 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((await getPendingLinks('LOCAL-A'))[0].attempts).toBe(3);
  });

  test('recovers an ambiguous write when the remote link is later observed', async () => {
    await storePendingLink('LOCAL-A', pendingLink);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    await retryAllPendingLinks(config, {}, emptyStats());

    fetchRemoteIssueLinks.mockResolvedValueOnce({
      ok: true,
      links: [{
        id: 'LINK-1',
        type: { name: 'Blocks' },
        inwardIssue: { key: 'REMOTE-B' }
      }]
    });

    const result = await retryAllPendingLinks(config, {}, emptyStats());

    expect(result).toEqual({ retried: 1, success: 1, failed: 0, stillPending: 0 });
    expect(storeLinkMapping).toHaveBeenCalledWith('LINK-1', 'synced', 'org-1');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockStore.has('pending-links:LOCAL-A')).toBe(false);
  });
});
