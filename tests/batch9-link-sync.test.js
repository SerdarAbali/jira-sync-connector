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

jest.mock('../src/services/storage/mappings.js', () => ({
  getRemoteKey: jest.fn(),
  getLocalKey: jest.fn(async () => null),
  storeMapping: jest.fn(),
  getOrganizationsWithTokens: jest.fn(async () => []),
  setLastSyncedLocalUpdated: jest.fn(),
  storeLinkMapping: jest.fn(),
  getLinkMapping: jest.fn()
}));

jest.mock('../src/services/storage/flags.js', () => ({
  markSyncing: jest.fn(),
  clearSyncFlag: jest.fn(),
  isSyncing: jest.fn(async () => false),
  findPendingLinksToIssue: jest.fn(),
  removePendingLink: jest.fn(),
  storePendingLink: jest.fn()
}));

jest.mock('../src/services/sync/pilot-pause.js', () => ({
  assertPilotWritesAllowed: jest.fn(async () => undefined)
}));

jest.mock('../src/services/storage/stats.js', () => ({
  trackApiCall: jest.fn(async () => undefined),
  trackWebhookSync: jest.fn(async () => undefined),
  logAuditEntry: jest.fn(async () => undefined)
}));

jest.mock('../src/services/storage/kvs.js', () => ({ get: jest.fn(async key => key === 'organizations' ? [{ id: 'org-1', allowedProjects: ['LOCAL'] }] : null) }));
jest.mock('../src/services/jira/local-client.js', () => ({ getFullIssue: jest.fn(async key => ({ key, fields: { project: { key: 'LOCAL' } } })) }));

import { getLocalKey } from '../src/services/storage/mappings.js';
import { fetch as mockFetch } from '@forge/api';
import { syncIssueLinks } from '../src/services/sync/link-sync.js';
import { processPendingLinksForNewlySyncedIssue } from '../src/services/sync/issue-sync.js';
import {
  getRemoteKey,
  getLinkMapping,
  storeLinkMapping
} from '../src/services/storage/mappings.js';
import {
  findPendingLinksToIssue,
  removePendingLink
} from '../src/services/storage/flags.js';

const config = {
  id: 'org-1',
  remoteUrl: 'https://remote.example.invalid',
  remoteEmail: 'sync@example.invalid',
  remoteApiToken: 'test-token'
};

const linkMap = new Map();

function mappingKey(linkId, orgId) {
  return `${orgId || 'legacy'}:${linkId}`;
}

function issueWithLink(key, linkedKey, direction, linkId = 'LINK-1') {
  return {
    key,
    fields: {
      issuelinks: [{
        id: linkId,
        type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
        ...(direction === 'outward'
          ? { outwardIssue: { key: linkedKey } }
          : { inwardIssue: { key: linkedKey } })
      }]
    }
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  linkMap.clear();
  getLocalKey.mockImplementation(async key => key.replace('REMOTE-', 'LOCAL-'));
  getLinkMapping.mockImplementation(async (linkId, orgId) => linkMap.get(mappingKey(linkId, orgId)) || null);
  storeLinkMapping.mockImplementation(async (linkId, value, orgId) => {
    linkMap.set(mappingKey(linkId, orgId), value);
  });
  getRemoteKey.mockImplementation(async key => {
    if (key === 'LOCAL-A') return 'REMOTE-A';
    if (key === 'LOCAL-B') return 'REMOTE-B';
    return null;
  });
});


describe('Batch 9 pending-link idempotency', () => {
  test('pending A to B creates one POST and stores the mapping before removing pending state', async () => {
    findPendingLinksToIssue.mockResolvedValue([{
      sourceIssueKey: 'LOCAL-A',
      linkId: 'LINK-1',
      linkedIssueKey: 'LOCAL-B',
      direction: 'inward',
      linkTypeName: 'Blocks',
      orgId: 'org-1'
    }]);
    mockFetch.mockResolvedValueOnce({ ok: true, status: 201 });

    await processPendingLinksForNewlySyncedIssue('LOCAL-B', 'REMOTE-B', config, 'org-1');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(storeLinkMapping).toHaveBeenCalledWith('LINK-1', 'synced', 'org-1');
    expect(removePendingLink).toHaveBeenCalledWith('LOCAL-A', 'LINK-1');
    expect(storeLinkMapping.mock.invocationCallOrder[0])
      .toBeLessThan(removePendingLink.mock.invocationCallOrder[0]);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        fields: {
          issuelinks: [{
            id: 'LINK-1',
            type: { name: 'Blocks' },
            outwardIssue: { key: 'REMOTE-A' }
          }]
        }
      })
    });

    const result = await syncIssueLinks(
      'LOCAL-B',
      'REMOTE-B',
      issueWithLink('LOCAL-B', 'LOCAL-A', 'outward'),
      config,
      null,
      'org-1',
      true
    );

    expect(result).toEqual({ synced: 0, skipped: 1, failed: 0, pending: 0 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });

  test('forceCheck stores a mapping when the remote link exists but no local mapping does', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        fields: {
          issuelinks: [{
            id: 'LINK-1',
            type: { name: 'Blocks' },
            outwardIssue: { key: 'REMOTE-A' }
          }]
        }
      })
    });

    const result = await syncIssueLinks(
      'LOCAL-B',
      'REMOTE-B',
      issueWithLink('LOCAL-B', 'LOCAL-A', 'outward'),
      config,
      null,
      'org-1',
      true
    );

    expect(result).toEqual({ synced: 0, skipped: 1, failed: 0, pending: 0 });
    expect(storeLinkMapping).toHaveBeenCalledWith('LINK-1', 'synced', 'org-1');
    expect(mockFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  });

  test('an opposite-direction remote link is not treated as the desired link', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          fields: {
            issuelinks: [{
              id: 'LINK-1',
              type: { name: 'Blocks' },
              inwardIssue: { key: 'REMOTE-A' }
            }]
          }
        })
      })
      .mockResolvedValueOnce({ ok: true, status: 201 });

    const result = await syncIssueLinks(
      'LOCAL-B',
      'REMOTE-B',
      issueWithLink('LOCAL-B', 'LOCAL-A', 'outward'),
      config,
      null,
      'org-1',
      true
    );

    expect(result).toEqual({ synced: 1, skipped: 0, failed: 0, pending: 0 });
    expect(mockFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });
});
