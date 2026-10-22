const mockStore = new Map();
const mockTransactionOps = [];
const mockTransaction = {
  delete(key) { mockTransactionOps.push(['delete', key]); return this; },
  set(key, value) { mockTransactionOps.push(['set', key, value]); return this; },
  async execute() { return undefined; }
};

jest.mock('@forge/api', () => ({
  __esModule: true,
  default: { asApp: () => ({ requestJira: jest.fn() }) },
  route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
  fetch: jest.fn()
}));

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(async key => mockStore.get(key) ?? null),
  set: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  del: jest.fn(async key => { mockStore.delete(key); }),
  getSecret: jest.fn(async () => null),
  queryByPrefix: jest.fn(async prefix => Array.from(mockStore.entries())
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => ({ key, value }))),
  transaction: jest.fn(() => mockTransaction)
}));

jest.mock('../src/services/storage/mappings.js', () => ({
  getOrganizationsWithTokens: jest.fn(),
  getRemoteKey: jest.fn(),
  getLocalKey: jest.fn(),
  replaceIssueMapping: jest.fn(),
  deactivateIssueMapping: jest.fn()
}));

jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn(),
  probeLocalIssue: jest.fn(),
  updateLocalIssueDescription: jest.fn()
}));

jest.mock('../src/services/jira/remote-client.js', () => ({
  getRemoteIssue: jest.fn(),
  probeRemoteIssue: jest.fn()
}));

jest.mock('../src/services/sync/issue-sync.js', () => ({
  createIssueForOrg: jest.fn()
}));

jest.mock('../src/services/sync/pilot-pause.js', () => ({
  getPilotPause: jest.fn(async () => ({ paused: false })),
  assertPilotWritesAllowed: jest.fn()
}));

import {
  COUNTERPART_STATUS_VALUES,
  COUNTERPART_RECORD_STATES,
  recordCounterpartStatus,
  getCounterpartStatus,
  counterpartStatusBlocksSync
} from '../src/services/sync/counterpart-status.js';
import {
  maybeAutoReplaceAfterDeletion,
  replaceCounterpart,
  remapDeletedCounterpart,
  endCounterpartSync
} from '../src/services/sync/counterpart-recovery.js';
import {
  prependCounterpartNoticeToADF,
  stripCounterpartNoticeFromADF,
  updateCounterpartNoticeInADF
} from '../src/utils/adf.js';
import { normalizeDescriptionForHash } from '../src/services/sync/field-normalization.js';
import fs from 'fs';
import path from 'path';
import { normalizeSyncOptions, DEFAULT_SYNC_OPTIONS } from '../src/resolvers/config.js';
import { RESOLVER_POLICIES } from '../src/resolvers/authorization-policy.js';
import * as kvsStore from '../src/services/storage/kvs.js';
import * as mappings from '../src/services/storage/mappings.js';
import * as localClient from '../src/services/jira/local-client.js';
import * as remoteClient from '../src/services/jira/remote-client.js';
import * as issueSync from '../src/services/sync/issue-sync.js';

const ORG = {
  id: 'org-1',
  name: 'Org B',
  remoteUrl: 'https://org-b.atlassian.net',
  remoteEmail: 'admin@example.com',
  remoteApiToken: 'secret-token',
  remoteProjectKey: 'B',
  allowedProjects: ['A'],
  syncDirection: 'push'
};

async function seedDeletionStatus({ deletedSide, orgId = 'org-1' }) {
  return recordCounterpartStatus({
    orgId,
    localKey: 'LOCAL-1',
    remoteKey: 'REMOTE-1',
    status: COUNTERPART_STATUS_VALUES.CONFIRMED_DELETED,
    deletedSide,
    source: 'issue_deleted_event',
    reasonCode: 'TEST_DELETION'
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  mockTransactionOps.length = 0;
  mappings.getOrganizationsWithTokens.mockResolvedValue([{ ...ORG }]);
  mappings.replaceIssueMapping.mockResolvedValue({ success: true });
  mappings.deactivateIssueMapping.mockResolvedValue({
    success: true,
    endedRecord: { localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' }
  });
  localClient.probeLocalIssue.mockResolvedValue({ reachable: true, statusCode: 200 });
  remoteClient.probeRemoteIssue.mockResolvedValue({ reachable: true, statusCode: 200 });
  localClient.getFullIssue.mockResolvedValue({
    key: 'LOCAL-1',
    fields: {
      summary: 'Local survivor',
      description: null,
      issuetype: { name: 'Task' },
      project: { key: 'A' },
      status: { name: 'To Do' }
    }
  });
  localClient.updateLocalIssueDescription.mockResolvedValue(true);
  issueSync.createIssueForOrg.mockResolvedValue({ key: 'REMOTE-2' });
});

describe('safe counterpart status records', () => {
  test('stores only identifiers and classification metadata', async () => {
    const result = await recordCounterpartStatus({
      orgId: 'org-1',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      status: COUNTERPART_STATUS_VALUES.CONFIRMED_DELETED,
      deletedSide: 'remote',
      source: 'issue_deleted_event',
      reasonCode: 'REMOTE_ISSUE_DELETED',
      description: 'must not be stored',
      summary: 'must not be stored',
      token: 'must not be stored',
      url: 'https://must-not-be-stored'
    });

    expect(result.success).toBe(true);
    const persisted = mockStore.get('counterpart-status:org-1:LOCAL-1:REMOTE-1');
    expect(persisted).toEqual(expect.objectContaining({
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      orgId: 'org-1',
      status: 'confirmed_deleted',
      deletedSide: 'remote',
      state: 'active'
    }));
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain('must not be stored');
    expect(serialized).not.toContain('description');
    expect(serialized).not.toContain('summary');
    expect(serialized).not.toContain('token');
  });

  test('404, 401/403 and ended pairs map to distinct safe gate codes', async () => {
    expect(counterpartStatusBlocksSync({
      state: 'active',
      status: 'unavailable'
    })).toEqual({ blocked: true, code: 'COUNTERPART_UNAVAILABLE' });
    expect(counterpartStatusBlocksSync({
      state: 'active',
      status: 'access_problem'
    })).toEqual({ blocked: true, code: 'COUNTERPART_ACCESS_PROBLEM' });
    expect(counterpartStatusBlocksSync({
      state: 'ended'
    }, { hasMapping: false })).toEqual({ blocked: true, code: 'COUNTERPART_SYNC_ENDED' });
  });
});

describe('connector-owned survivor notices', () => {
  const original = {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'User content' }] }]
  };

  test('adds exactly one marker-tagged notice and never mutates the input', () => {
    const once = prependCounterpartNoticeToADF(original, {
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      status: 'deleted'
    });
    const twice = prependCounterpartNoticeToADF(once, {
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      status: 'deleted'
    });
    expect(once.content).toHaveLength(2);
    expect(twice.content).toHaveLength(2);
    expect(original.content).toHaveLength(1);
    expect(stripCounterpartNoticeFromADF(twice)).toEqual(original);
    expect(updateCounterpartNoticeInADF(twice, null)).toEqual(original);
  });

  test('notice text is excluded from description hashing', () => {
    const withNotice = prependCounterpartNoticeToADF(original, {
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      status: 'deleted'
    });
    expect(normalizeDescriptionForHash(withNotice))
      .toEqual(normalizeDescriptionForHash(original));
  });
});

describe('automatic replacement controls', () => {
  test('legacy recreateDeletedIssues never enables automatic replacement', async () => {
    mockStore.set('syncOptions:org-1', { recreateDeletedIssues: true });
    await seedDeletionStatus({ deletedSide: 'remote' });

    const result = await maybeAutoReplaceAfterDeletion({
      orgId: 'org-1',
      org: { ...ORG },
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      deletedSide: 'remote'
    });

    expect(result.code).toBe('AUTOMATIC_REPLACEMENT_OFF');
    expect(issueSync.createIssueForOrg).not.toHaveBeenCalled();
  });

  test('push never recreates a deleted local issue from the remote survivor', async () => {
    mockStore.set('syncOptions:org-1', { automaticReplacementAfterDeletion: true });
    await seedDeletionStatus({ deletedSide: 'local' });

    const result = await maybeAutoReplaceAfterDeletion({
      orgId: 'org-1',
      org: { ...ORG, syncDirection: 'push' },
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      deletedSide: 'local'
    });

    expect(result.code).toBe('DIRECTION_BLOCKED');
    expect(issueSync.createIssueForOrg).not.toHaveBeenCalled();
  });

  test('push may recreate a deleted remote counterpart from the surviving local issue', async () => {
    mockStore.set('syncOptions:org-1', { automaticReplacementAfterDeletion: true });
    await seedDeletionStatus({ deletedSide: 'remote' });

    const result = await maybeAutoReplaceAfterDeletion({
      orgId: 'org-1',
      org: { ...ORG, syncDirection: 'push' },
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      deletedSide: 'remote'
    });

    expect(result.success).toBe(true);
    expect(result.replacementRemoteKey).toBe('REMOTE-2');
    expect(issueSync.createIssueForOrg).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'LOCAL-1' }),
      expect.objectContaining({ id: 'org-1' }),
      expect.any(Object),
      expect.objectContaining({
        replacementOfRemoteKey: 'REMOTE-1',
        operationSuffix: expect.stringContaining('replacement_remote_')
      }),
      null
    );
    const status = await getCounterpartStatus({
      orgId: 'org-1',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1'
    });
    expect(status.state).toBe(COUNTERPART_RECORD_STATES.REPLACED);
    expect(status.replacementRemoteKey).toBe('REMOTE-2');
  });

  test('manual replacement refuses non-confirmed classifications', async () => {
    await recordCounterpartStatus({
      orgId: 'org-1',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      status: COUNTERPART_STATUS_VALUES.TEMPORARY_FAILURE,
      source: 'probe'
    });
    const result = await replaceCounterpart({
      orgId: 'org-1',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1'
    });
    expect(result.code).toBe('COUNTERPART_NOT_CONFIRMED_DELETED');
  });
});

describe('administrator remap', () => {
  test('verifies both replacement sides before atomically replacing the pair', async () => {
    await seedDeletionStatus({ deletedSide: 'remote' });

    const result = await remapDeletedCounterpart({
      orgId: 'org-1',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      newLocalKey: 'LOCAL-2',
      newRemoteKey: 'REMOTE-2',
      actorAccountId: 'admin-123'
    });

    expect(result.success).toBe(true);
    expect(localClient.probeLocalIssue).toHaveBeenCalledWith('LOCAL-2');
    expect(remoteClient.probeRemoteIssue).toHaveBeenCalledWith('REMOTE-2', expect.any(Object));
    expect(mappings.replaceIssueMapping).toHaveBeenCalledWith(expect.objectContaining({
      oldLocalKey: 'LOCAL-1',
      oldRemoteKey: 'REMOTE-1',
      newLocalKey: 'LOCAL-2',
      newRemoteKey: 'REMOTE-2'
    }));
    const status = await getCounterpartStatus({
      orgId: 'org-1',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1'
    });
    expect(status.state).toBe(COUNTERPART_RECORD_STATES.REPLACED);
    expect(status.replacementLocalKey).toBe('LOCAL-2');
    expect(status.replacementRemoteKey).toBe('REMOTE-2');
  });
});

describe('ending a pair', () => {
  test('deactivates both lookup directions and preserves actor/end history', async () => {
    await seedDeletionStatus({ deletedSide: 'remote' });

    const result = await endCounterpartSync({
      orgId: 'org-1',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      actorAccountId: 'admin-123'
    });

    expect(result.success).toBe(true);
    expect(result.jiraIssueDeleted).toBe(false);
    expect(mappings.deactivateIssueMapping).toHaveBeenCalledWith(expect.objectContaining({
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      orgId: 'org-1',
      endedBy: 'admin-123'
    }));
    const persisted = mockStore.get('counterpart-status:org-1:LOCAL-1:REMOTE-1');
    expect(persisted.state).toBe('ended');
    expect(persisted.endedBy).toBe('admin-123');
    expect(persisted.endedAt).toBeTruthy();
  });

  test('actual mapping ending removes both directions atomically with no Jira DELETE', async () => {
    const actualMappings = jest.requireActual('../src/services/storage/mappings.js');
    const result = await actualMappings.deactivateIssueMapping({
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      orgId: 'org-1',
      endedAt: '2026-10-22T10:00:00.000Z',
      endedBy: 'admin-123',
      reasonCode: 'administrator_ended_counterpart_sync'
    });

    expect(result.success).toBe(true);
    expect(mockTransactionOps).toEqual(expect.arrayContaining([
      ['delete', 'org-1:local-to-remote:LOCAL-1'],
      ['delete', 'org-1:remote-to-local:REMOTE-1'],
      ['delete', 'mapping-meta:org-1:LOCAL-1'],
      ['set', 'mapping-ended:org-1:LOCAL-1:REMOTE-1', expect.objectContaining({
        localKey: 'LOCAL-1',
        remoteKey: 'REMOTE-1',
        orgId: 'org-1',
        endedAt: '2026-10-22T10:00:00.000Z',
        endedBy: 'admin-123'
      })]
    ]));
    expect(kvsStore.del).not.toHaveBeenCalled();
  });
});

describe('configuration and administration boundaries', () => {
  test('the new setting defaults Off and is independent of the legacy recreate flag', () => {
    expect(DEFAULT_SYNC_OPTIONS.automaticReplacementAfterDeletion).toBe(false);
    expect(normalizeSyncOptions({}).automaticReplacementAfterDeletion).toBe(false);
    expect(normalizeSyncOptions({ recreateDeletedIssues: true })
      .automaticReplacementAfterDeletion).toBe(false);
    expect(normalizeSyncOptions({ automaticReplacementAfterDeletion: true })
      .automaticReplacementAfterDeletion).toBe(true);
  });

  test('recovery resolvers have explicit least-privilege policies', () => {
    expect(RESOLVER_POLICIES.getDeletedCounterparts).toBe('ADMIN_READ');
    expect(RESOLVER_POLICIES.probeDeletedCounterpart).toBe('ADMIN_READ');
    expect(RESOLVER_POLICIES.remapDeletedCounterpart).toBe('ADMIN_WRITE');
    expect(RESOLVER_POLICIES.replaceDeletedCounterpart).toBe('DESTRUCTIVE');
    expect(RESOLVER_POLICIES.endDeletedCounterpartSync).toBe('DESTRUCTIVE');
    expect(RESOLVER_POLICIES.dismissDeletedCounterpart).toBe('ADMIN_WRITE');
  });

  test('the recovery UI is wired and states that ending removes both mappings', () => {
    const app = fs.readFileSync(path.join(process.cwd(), 'static/admin-page/src/App.jsx'), 'utf8');
    const component = fs.readFileSync(
      path.join(process.cwd(), 'static/admin-page/src/components/DeletedCounterpartRecovery.jsx'),
      'utf8'
    );
    expect(app).toContain('<Tab>Recovery</Tab>');
    expect(app).toContain('<DeletedCounterpartRecovery');
    expect(component).toContain("invoke('getDeletedCounterparts'");
    expect(component).toContain("'endDeletedCounterpartSync'");
    expect(component).toContain("'remapDeletedCounterpart'");
    expect(component).toContain("'replaceDeletedCounterpart'");
    expect(component).toContain('No Jira issue is deleted');
    expect(component).not.toContain('DELETE /rest/api');
  });

  test('deleted-counterpart handling adds no recurring missed-sync notification records', () => {
    const sources = [
      'src/services/sync/counterpart-status.js',
      'src/services/sync/counterpart-probe.js',
      'src/services/sync/counterpart-recovery.js',
      'src/triggers/issue-deleted.js'
    ].map(relative => fs.readFileSync(path.join(process.cwd(), relative), 'utf8')).join('\n');
    expect(sources).not.toContain('SYNC-1234');
    expect(sources).not.toContain('missed-issue');
    expect(sources).not.toContain('hourly reconciliation');
  });
});
