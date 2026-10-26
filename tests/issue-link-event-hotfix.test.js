// The synchronization authorization gate has its own suite; this suite tests another behaviour.
jest.mock('../src/services/sync/sync-authorization.js', () => require('./helpers/authorized-sync-authorization.js'));

const fs = require('fs');
const path = require('path');

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

jest.mock('../src/services/sync/issue-sync.js', () => ({
  syncIssue: jest.fn(async () => ({ success: true }))
}));

jest.mock('../src/services/storage/mappings.js', () => ({
  getRemoteKey: jest.fn(),
  getLocalKey: jest.fn(async key => key.replace('REMOTE-', 'LOCAL-')),
  getLinkMapping: jest.fn(),
  storeLinkMapping: jest.fn(),
  getOrganizationsWithTokens: jest.fn(),
  removeLinkMapping: jest.fn()
}));

jest.mock('../src/services/storage/flags.js', () => ({
  storePendingLink: jest.fn(),
  removePendingLink: jest.fn()
}));

jest.mock('../src/services/sync/pilot-pause.js', () => ({
  assertPilotWritesAllowed: jest.fn(async () => undefined)
}));

jest.mock('../src/services/storage/stats.js', () => ({
  trackApiCall: jest.fn(async () => undefined)
}));

jest.mock('../src/services/storage/kvs.js', () => ({ get: jest.fn(async key => key === 'organizations' ? [{ id: 'org-1', allowedProjects: ['LOCAL'] }] : null) }));
jest.mock('../src/services/jira/local-client.js', () => ({ getFullIssue: jest.fn(async key => ({ key, fields: { project: { key: 'LOCAL' } } })) }));

import api, { fetch as mockFetch } from '@forge/api';
import { run as runLinkCreated } from '../src/triggers/link.js';
import { run as runLinkDeleted } from '../src/triggers/link-deleted.js';
import { syncIssueLinks } from '../src/services/sync/link-sync.js';
import * as outboundScope from '../src/services/sync/outbound-scope.js';
import { syncIssue } from '../src/services/sync/issue-sync.js';
import {
  getRemoteKey,
  getLinkMapping,
  storeLinkMapping,
  getOrganizationsWithTokens,
  removeLinkMapping
} from '../src/services/storage/mappings.js';

const mockRequestJira = api.asApp().requestJira;
const manifest = fs.readFileSync(path.join(__dirname, '..', 'manifest.yml'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

function getManifestSection(name) {
  const lines = manifest.split(/\r?\n/);
  const start = lines.findIndex(line => line === `  ${name}:`);
  if (start === -1) throw new Error(`Missing manifest section: ${name}`);
  const end = lines.findIndex((line, index) => index > start && /^  [A-Za-z]/.test(line));
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

function getManifestEntries(sectionName) {
  const entries = [];
  let current = null;

  for (const line of getManifestSection(sectionName)) {
    const keyMatch = line.match(/^    - key: (\S+)$/);
    if (keyMatch) {
      current = { key: keyMatch[1], events: [] };
      entries.push(current);
      continue;
    }
    if (!current) continue;

    const functionMatch = line.match(/^      function: (\S+)$/);
    if (functionMatch) current.function = functionMatch[1];

    const handlerMatch = line.match(/^      handler: (\S+)$/);
    if (handlerMatch) current.handler = handlerMatch[1];

    const eventMatch = line.match(/^        - (\S+)$/);
    if (eventMatch) current.events.push(eventMatch[1]);
  }

  return entries;
}

const triggers = getManifestEntries('trigger');
const functions = getManifestEntries('function');

function triggerByKey(key) {
  return triggers.find(trigger => trigger.key === key);
}

function functionByKey(key) {
  return functions.find(entry => entry.key === key);
}

function resolveManifestHandler(handlerName) {
  if (handlerName === 'index.runLinkCreated') return runLinkCreated;
  if (handlerName === 'index.runLinkDeleted') return runLinkDeleted;
  throw new Error(`Unexpected manifest handler: ${handlerName}`);
}

function linkedHandlerFor(triggerKey) {
  const trigger = triggerByKey(triggerKey);
  const fn = functionByKey(trigger.function);
  return resolveManifestHandler(fn.handler);
}

const config = {
  remoteUrl: 'https://remote.example.invalid',
  remoteEmail: 'sync@example.invalid',
  remoteApiToken: 'test-token'
};

function linkedIssue() {
  return {
    key: 'LOCAL-1',
    fields: {
      issuelinks: [{
        id: '10001',
        type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
        inwardIssue: { key: 'LOCAL-2' }
      }]
    }
  };
}

async function runMappedLinkSync() {
  getLinkMapping.mockResolvedValue(null);
  getRemoteKey.mockImplementation(async key => key.replace('LOCAL-', 'REMOTE-'));
  mockFetch.mockResolvedValue({ ok: true, status: 201 });

  const result = await syncIssueLinks(
    'LOCAL-1',
    'REMOTE-1',
    linkedIssue(),
    config,
    null,
    'org-1',
    false
  );

  return result;
}

describe('issue-link event hotfix', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequestJira.mockReset();
    mockFetch.mockReset();
  });

  test('manifest uses exactly the documented issue-link event names', () => {
    expect(triggerByKey('issue-link-created')).toEqual({
      key: 'issue-link-created',
      function: 'link-trigger',
      events: ['avi:jira:created:issuelink']
    });
    expect(triggerByKey('issue-link-deleted')).toEqual({
      key: 'issue-link-deleted',
      function: 'link-deleted-trigger',
      events: ['avi:jira:deleted:issuelink']
    });
  });

  test('obsolete avi:jira-issue-link:* event names are absent', () => {
    expect(manifest).not.toMatch(/avi:jira-issue-link:/);
  });

  test('created event reaches the link-created handler', async () => {
    const trigger = triggerByKey('issue-link-created');
    const fn = functionByKey(trigger.function);
    const handler = resolveManifestHandler(fn.handler);

    expect(trigger.function).toBe('link-trigger');
    expect(fn.handler).toBe('index.runLinkCreated');
    expect(indexSource).toContain("export { run as runLinkCreated } from './triggers/link.js';");

    mockRequestJira.mockImplementation(async url => {
      const issueId = url.split('/').pop();
      return {
        ok: true,
        json: async () => ({ key: issueId === '1' ? 'LOCAL-1' : 'LOCAL-2' })
      };
    });

    await handler({
      eventType: 'avi:jira:created:issuelink',
      selfGenerated: false,
      id: '10001',
      sourceIssueId: '1',
      destinationIssueId: '2',
      sourceProjectId: '10',
      destinationProjectId: '10',
      issueLinkType: { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }
    });

    expect(syncIssue).toHaveBeenNthCalledWith(1, expect.objectContaining({
      eventType: 'avi:jira:updated:issue',
      issue: { key: 'LOCAL-2' },
      linkChange: { eventType: 'avi:jira:created:issuelink', userInitiated: true }
    }));
    expect(syncIssue).toHaveBeenNthCalledWith(2, expect.objectContaining({
      eventType: 'avi:jira:updated:issue',
      issue: { key: 'LOCAL-1' },
      linkChange: { eventType: 'avi:jira:created:issuelink', userInitiated: true }
    }));
  });

  test('an app-generated link event is not tagged as a user link change', async () => {
    mockRequestJira.mockImplementation(async url => {
      const issueId = url.split('/').pop();
      return {
        ok: true,
        json: async () => ({ key: issueId === '1' ? 'LOCAL-1' : 'LOCAL-2' })
      };
    });

    await runLinkCreated({
      eventType: 'avi:jira:created:issuelink',
      selfGenerated: true,
      id: '10002',
      sourceIssueId: '1',
      issueLinkType: { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }
    });

    expect(syncIssue).toHaveBeenCalledTimes(1);
    expect(syncIssue.mock.calls[0][0]).not.toHaveProperty('linkChange');
  });

  test('deleted event reaches the link-deleted handler', async () => {
    const trigger = triggerByKey('issue-link-deleted');
    const fn = functionByKey(trigger.function);
    const handler = resolveManifestHandler(fn.handler);

    expect(trigger.function).toBe('link-deleted-trigger');
    expect(fn.handler).toBe('index.runLinkDeleted');
    expect(indexSource).toContain("export { run as runLinkDeleted } from './triggers/link-deleted.js';");

    getOrganizationsWithTokens.mockResolvedValue([]);
    mockRequestJira.mockImplementation(async url => {
      const issueId = url.split('/').pop();
      return {
        ok: true,
        json: async () => ({ key: issueId === '1' ? 'LOCAL-1' : 'LOCAL-2' })
      };
    });

    await handler({
      eventType: 'avi:jira:deleted:issuelink',
      selfGenerated: false,
      id: '10001',
      sourceIssueId: '1',
      destinationIssueId: '2',
      sourceProjectId: '10',
      destinationProjectId: '10',
      issueLinkType: { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }
    });

    expect(mockRequestJira).toHaveBeenCalledTimes(2);
    expect(getOrganizationsWithTokens).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('mapped link endpoints attempt one remote link write', async () => {
    const result = await runMappedLinkSync();

    expect(result).toEqual({ synced: 1, skipped: 0, failed: 0, pending: 0 });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(`${config.remoteUrl}/rest/api/3/issueLink`);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      type: { name: 'Blocks' },
      inwardIssue: { key: 'REMOTE-2' },
      outwardIssue: { key: 'REMOTE-1' }
    });
    expect(storeLinkMapping).toHaveBeenCalledWith('10001', 'synced', 'org-1');
  });

  test('no summary matching is used for mapped link endpoints', async () => {
    await runMappedLinkSync();

    const calls = mockFetch.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls.some(([url]) => /summary|\/search/i.test(url))).toBe(false);
    expect(calls.some(([, options]) => /summary/i.test(options.body))).toBe(false);
    expect(getRemoteKey).toHaveBeenCalledTimes(3);
    expect(getRemoteKey).toHaveBeenCalledWith('LOCAL-2', 'org-1');
  });
});

describe('documented issue-link event payload', () => {
  const createdEvent = (overrides = {}) => ({
    eventType: 'avi:jira:created:issuelink',
    selfGenerated: false,
    id: '10001',
    sourceIssueId: '1',
    destinationIssueId: '2',
    sourceProjectId: '10',
    destinationProjectId: '10',
    issueLinkType: { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
    timestamp: '2026-10-25T09:51:45.959Z',
    ...overrides
  });

  const deletedEvent = (overrides = {}) => createdEvent({ eventType: 'avi:jira:deleted:issuelink', ...overrides });

  function resolveKeys() {
    mockRequestJira.mockImplementation(async url => {
      const issueId = url.split('/').pop();
      return {
        ok: true,
        json: async () => ({ key: issueId === '1' ? 'LOCAL-1' : 'LOCAL-2' })
      };
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequestJira.mockReset();
    mockFetch.mockReset();
    getOrganizationsWithTokens.mockResolvedValue([]);
  });

  test('created: root-level IDs sync the destination before the source', async () => {
    resolveKeys();

    await linkedHandlerFor('issue-link-created')(createdEvent());

    expect(mockRequestJira.mock.calls.map(([url]) => url))
      .toEqual(['/rest/api/3/issue/1', '/rest/api/3/issue/2']);
    expect(syncIssue).toHaveBeenNthCalledWith(1, expect.objectContaining({ issue: { key: 'LOCAL-2' } }));
    expect(syncIssue).toHaveBeenNthCalledWith(2, expect.objectContaining({ issue: { key: 'LOCAL-1' } }));
  });

  test('created: nested legacy payloads still resolve both endpoints', async () => {
    resolveKeys();

    await linkedHandlerFor('issue-link-created')({
      issueLink: { sourceIssueId: '1', destinationIssueId: '2', issueLinkType: { name: 'Blocks' } }
    });

    expect(mockRequestJira).toHaveBeenCalledTimes(2);
    expect(syncIssue).toHaveBeenCalledTimes(2);
  });

  test('created: a payload without endpoint IDs performs no reads or syncs', async () => {
    resolveKeys();

    await linkedHandlerFor('issue-link-created')({ eventType: 'avi:jira:created:issuelink', selfGenerated: false });

    expect(mockRequestJira).not.toHaveBeenCalled();
    expect(syncIssue).not.toHaveBeenCalled();
  });

  test('created: a single endpoint syncs only that issue', async () => {
    resolveKeys();

    await linkedHandlerFor('issue-link-created')(createdEvent({ destinationIssueId: undefined }));

    expect(mockRequestJira).toHaveBeenCalledTimes(1);
    expect(syncIssue).toHaveBeenCalledTimes(1);
    expect(syncIssue).toHaveBeenCalledWith(expect.objectContaining({ issue: { key: 'LOCAL-1' } }));
  });

  test('deleted: root-level fields resolve both endpoints and the link type', async () => {
    resolveKeys();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await linkedHandlerFor('issue-link-deleted')(deletedEvent());

    const output = logSpy.mock.calls.map(([message]) => String(message)).join('\n');
    logSpy.mockRestore();

    expect(mockRequestJira.mock.calls.map(([url]) => url))
      .toEqual(['/rest/api/3/issue/1', '/rest/api/3/issue/2']);
    expect(output).toContain('Link deleted: LOCAL-1 → LOCAL-2 (Blocks)');
    expect(getOrganizationsWithTokens).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('deleted: nested legacy payloads still resolve both endpoints', async () => {
    resolveKeys();

    await linkedHandlerFor('issue-link-deleted')({
      issueLink: { id: '10001', sourceIssueId: '1', destinationIssueId: '2', issueLinkType: { name: 'Blocks' } }
    });

    expect(mockRequestJira).toHaveBeenCalledTimes(2);
    expect(getOrganizationsWithTokens).toHaveBeenCalledTimes(1);
  });

  test('deleted: a payload without a link ID stops before any read', async () => {
    resolveKeys();

    await linkedHandlerFor('issue-link-deleted')(deletedEvent({ id: undefined }));

    expect(mockRequestJira).not.toHaveBeenCalled();
    expect(getOrganizationsWithTokens).not.toHaveBeenCalled();
  });

  test('deleted: a payload without both endpoints stops before organization lookup', async () => {
    resolveKeys();

    await linkedHandlerFor('issue-link-deleted')(deletedEvent({ destinationIssueId: undefined }));

    expect(mockRequestJira).toHaveBeenCalledTimes(1);
    expect(getOrganizationsWithTokens).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('deleted: an unreadable endpoint stops before organization lookup', async () => {
    mockRequestJira.mockImplementation(async url => {
      const issueId = url.split('/').pop();
      if (issueId === '2') return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ key: 'LOCAL-1' }) };
    });

    await linkedHandlerFor('issue-link-deleted')(deletedEvent());

    expect(getOrganizationsWithTokens).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('deleted: the root-level link ID is the mapping key removed after a remote delete', async () => {
    resolveKeys();
    const scopeSpy = jest.spyOn(outboundScope, 'assertOutboundRemoteScope').mockResolvedValue(undefined);
    getOrganizationsWithTokens.mockResolvedValue([{
      id: 'org-1',
      remoteUrl: 'https://remote.example.invalid',
      remoteEmail: 'sync@example.invalid',
      remoteApiToken: 'test-token'
    }]);
    getRemoteKey.mockImplementation(async key => key.replace('LOCAL-', 'REMOTE-'));
    mockFetch.mockImplementation(async (url, options = {}) => {
      if (options.method === 'DELETE') return { ok: true, status: 204 };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          fields: {
            issuelinks: [{ id: '55', type: { name: 'Blocks' }, outwardIssue: { key: 'REMOTE-2' } }]
          }
        })
      };
    });

    await linkedHandlerFor('issue-link-deleted')(deletedEvent());

    expect(scopeSpy).toHaveBeenCalledWith({ orgId: 'org-1', remoteKeys: ['REMOTE-1', 'REMOTE-2'] });
    scopeSpy.mockRestore();
    const [deleteUrl] = mockFetch.mock.calls.find(([, options]) => options?.method === 'DELETE');
    expect(deleteUrl).toBe('https://remote.example.invalid/rest/api/3/issueLink/55');
    expect(removeLinkMapping).toHaveBeenCalledWith('10001', 'org-1');
  });
});
