import fs from 'fs';
import path from 'path';
import api from '@forge/api';
import { performScheduledSync } from '../src/services/scheduled/scheduled-sync.js';
import * as kvsStore from '../src/services/storage/kvs.js';
import {
  getOrganizationsWithTokens,
  getRemoteKey,
  getLocalKey,
  getLastSyncedLocalUpdated
} from '../src/services/storage/mappings.js';
import { getFullIssue } from '../src/services/jira/local-client.js';
import { updateRemoteIssue } from '../src/services/sync/issue-sync.js';
import { getReconciliationSettings } from '../src/services/sync/reconciliation-settings.js';
import { trackWebhookSync } from '../src/services/storage/stats.js';
import { defineStatsResolvers } from '../src/resolvers/stats.js';
import {
  PILOT_PAUSE_KEY,
  getPilotPause,
  pausePilot
} from '../src/services/sync/pilot-pause.js';

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  return {
    __esModule: true,
    default: { asApp: () => ({ requestJira }) },
    route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch: jest.fn()
  };
});

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  getSecret: jest.fn(),
  setSecret: jest.fn()
}));

jest.mock('../src/services/storage/mappings.js', () => ({
  getOrganizationsWithTokens: jest.fn(),
  getRemoteKey: jest.fn(),
  getLocalKey: jest.fn(),
  getLastSyncedLocalUpdated: jest.fn(),
  storeLinkMapping: jest.fn()
}));

jest.mock('../src/services/storage/flags.js', () => ({
  removePendingLink: jest.fn(),
  getPendingLinks: jest.fn(),
  listPendingLinkIssueKeys: jest.fn(async () => []),
  recordPendingLinkAttempt: jest.fn()
}));

jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn()
}));

jest.mock('../src/services/sync/issue-sync.js', () => ({
  updateRemoteIssue: jest.fn()
}));

jest.mock('../src/services/sync/link-sync.js', () => ({
  syncIssueLinks: jest.fn(),
  remoteLinkMatches: jest.fn(),
  fetchRemoteIssueLinks: jest.fn()
}));

jest.mock('../src/services/sync/reconciliation-settings.js', () => ({
  getReconciliationSettings: jest.fn()
}));

jest.mock('../src/utils/retry.js', () => ({
  sleep: jest.fn(async () => undefined),
  executeWriteOnce: jest.fn(async (operation) => operation())
}));

const ORG = {
  id: 'org-1',
  name: 'Scheduled Org',
  remoteUrl: 'https://remote.example.invalid',
  remoteEmail: 'sync@example.invalid',
  remoteApiToken: 'token',
  remoteProjectKey: 'REMOTE',
  allowedProjects: ['LOCAL']
};

const ISSUE_UPDATED = '2026-10-22T09:00:00.000Z';

function seedScheduledRun() {
  kvsStore.get.mockImplementation(async (key) => {
    if (key === 'scheduledSyncConfig') {
      return { enabled: true, syncScope: 'recent' };
    }
    return null;
  });
  getOrganizationsWithTokens.mockResolvedValue([ORG]);
  getLocalKey.mockResolvedValue(null);
  getRemoteKey.mockResolvedValue(null);
  getLastSyncedLocalUpdated.mockResolvedValue(null);
  getFullIssue.mockResolvedValue({
    key: 'LOCAL-1',
    fields: {
      updated: ISSUE_UPDATED,
      project: { key: 'LOCAL' },
      issuetype: { name: 'Task' }
    }
  });
  api.asApp().requestJira.mockResolvedValue({
    ok: true,
    json: async () => ({ issues: [{ key: 'LOCAL-1' }], isLast: true })
  });
}

function definedResolvers(definer) {
  const definitions = {};
  definer({
    define: (name, handler) => {
      definitions[name] = handler;
    }
  });
  return definitions;
}

beforeEach(() => {
  jest.clearAllMocks();
  require('./helpers/forge-lease-runtime').state.basicStore = new Map();
  seedScheduledRun();
  getReconciliationSettings.mockResolvedValue({
    recurringReconciliationEnabled: false,
    reconciliationIntervalMinutes: 60
  });
});

describe('v2.1.0-rc3 scheduled cleanup and skip classification', () => {
  test('prevents recurring and legacy schedulers from both running for one organization', async () => {
    getReconciliationSettings.mockResolvedValue({
      recurringReconciliationEnabled: true
    });

    const result = await performScheduledSync();

    expect(api.asApp().requestJira).not.toHaveBeenCalled();
    expect(updateRemoteIssue).not.toHaveBeenCalled();
    expect(result.issuesSkipped).toBe(1);
    expect(result.events[0]).toEqual(expect.objectContaining({
      type: 'skip',
      reason: 'recurring-reconciliation-enabled'
    }));
  });

  test('preserves stored legacy scheduling configuration when recurring reconciliation takes over', async () => {
    getReconciliationSettings.mockResolvedValue({
      recurringReconciliationEnabled: true
    });

    await performScheduledSync();

    expect(kvsStore.get).toHaveBeenCalledWith('scheduledSyncConfig');
    expect(kvsStore.set.mock.calls.some(([key]) => key === 'scheduledSyncConfig')).toBe(false);
    expect(kvsStore.del).not.toHaveBeenCalledWith('scheduledSyncConfig');
  });
  test('preserves pause behavior and the stored emergency-stop state', async () => {
    let storedPause = null;
    kvsStore.get.mockImplementation(async (key) => (
      key === PILOT_PAUSE_KEY ? storedPause : null
    ));
    kvsStore.set.mockImplementation(async (key, value) => {
      if (key === PILOT_PAUSE_KEY) storedPause = value;
    });

    const paused = await pausePilot('emergency_stop', 'admin-1');

    expect(paused).toEqual(expect.objectContaining({
      paused: true,
      pausedBy: 'admin-1',
      reasonCode: 'emergency_stop'
    }));
    expect(storedPause).toEqual(expect.objectContaining({
      paused: true,
      pausedBy: 'admin-1',
      reasonCode: 'emergency_stop'
    }));
    await expect(getPilotPause()).resolves.toEqual(expect.objectContaining({
      paused: true,
      reasonCode: 'emergency_stop'
    }));
  });



  test('fails closed when recurring settings cannot be read', async () => {
    getReconciliationSettings.mockRejectedValue(new Error('storage unavailable'));

    const result = await performScheduledSync();

    expect(api.asApp().requestJira).not.toHaveBeenCalled();
    expect(updateRemoteIssue).not.toHaveBeenCalled();
    expect(result.issuesSkipped).toBe(1);
    expect(result.events[0]).toEqual(expect.objectContaining({
      type: 'skip',
      reason: 'reconciliation-settings-unavailable'
    }));
  });

  test('counts already-current mapped issues separately and records no failure', async () => {
    getRemoteKey.mockResolvedValue('REMOTE-1');
    getLastSyncedLocalUpdated.mockResolvedValue(ISSUE_UPDATED);

    const result = await performScheduledSync();

    expect(result.issuesChecked).toBe(1);
    expect(result.issuesAlreadyCurrent).toBe(1);
    expect(result.issuesUpdated).toBe(0);
    expect(result.issuesSkipped).toBe(0);
    expect(result.issuesFailed).toBe(0);
    expect(result.lastSuccessfulJiraWrite).toBeNull();
    expect(updateRemoteIssue).not.toHaveBeenCalled();
  });

  test('records the last successful scheduled Jira write timestamp', async () => {
    getRemoteKey.mockResolvedValue('REMOTE-1');
    getLastSyncedLocalUpdated.mockResolvedValue('2026-10-21T09:00:00.000Z');
    updateRemoteIssue.mockResolvedValue({ fields: true });

    const result = await performScheduledSync();

    expect(result.issuesChecked).toBe(1);
    expect(result.issuesUpdated).toBe(1);
    expect(result.issuesFailed).toBe(0);
    expect(typeof result.lastSuccessfulJiraWrite).toBe('string');
    expect(Number.isFinite(Date.parse(result.lastSuccessfulJiraWrite))).toBe(true);
  });

  test('counts failed issue work separately while retaining legacy stored fields', async () => {
    getRemoteKey.mockResolvedValue('REMOTE-1');
    getLastSyncedLocalUpdated.mockResolvedValue('2026-10-21T09:00:00.000Z');
    updateRemoteIssue.mockRejectedValue(new Error('remote write failed'));

    const result = await performScheduledSync();

    expect(result.issuesChecked).toBe(1);
    expect(result.issuesFailed).toBe(1);
    expect(result.issuesUpdated).toBe(0);
    expect(result.issuesCreated).toBe(0);
    expect(result.issuesRecreated).toBe(0);
    expect(result.errors).toHaveLength(1);
  });

  test('tracks normal safety outcomes as skips without adding red errors', async () => {
    kvsStore.get.mockResolvedValue(null);

    await trackWebhookSync(
      'skip',
      false,
      'SYNC_ALREADY_IN_PROGRESS',
      'org-1',
      'LOCAL-1',
      { reason: 'SYNC_ALREADY_IN_PROGRESS' }
    );

    let stored = kvsStore.set.mock.calls
      .filter(([key]) => key === 'webhookSyncStats')
      .at(-1)[1];
    expect(stored.errors).toEqual([]);
    expect(stored.issuesSkipped).toBe(1);
    expect(stored.loopsPrevented).toBe(1);
    expect(stored.lastSuccessfulJiraWrite).toBeNull();
    expect(stored.byOrg['org-1'].issuesSkipped).toBe(1);
  });

  test('filters connector-authored comments as skips and records genuine writes', async () => {
    kvsStore.get.mockResolvedValue(null);

    await trackWebhookSync(
      'comment',
      false,
      'Comment authored by SyncApp (loop prevention)',
      'org-1',
      'LOCAL-1',
      { reason: 'app-authored' }
    );

    let stored = kvsStore.set.mock.calls
      .filter(([key]) => key === 'webhookSyncStats')
      .at(-1)[1];
    expect(stored.errors).toEqual([]);
    expect(stored.issuesSkipped).toBe(1);
    expect(stored.lastSuccessfulJiraWrite).toBeNull();

    kvsStore.get.mockResolvedValue({ ...stored, errors: [] });
    await trackWebhookSync('update', true, null, 'org-1', 'LOCAL-1', {
      remoteKey: 'REMOTE-1'
    });

    stored = kvsStore.set.mock.calls
      .filter(([key]) => key === 'webhookSyncStats')
      .at(-1)[1];
    expect(stored.issuesUpdated).toBe(1);
    expect(typeof stored.lastSuccessfulJiraWrite).toBe('string');
    expect(typeof stored.byOrg['org-1'].lastSuccessfulJiraWrite).toBe('string');
  });

  test('keeps genuine failures visible in the webhook error history', async () => {
    kvsStore.get.mockResolvedValue(null);

    await trackWebhookSync('update', false, 'HTTP 500', 'org-1', 'LOCAL-1', {
      remoteKey: 'REMOTE-1'
    });

    const stored = kvsStore.set.mock.calls
      .filter(([key]) => key === 'webhookSyncStats')
      .at(-1)[1];
    expect(stored.errors).toHaveLength(1);
    expect(stored.errors[0]).toEqual(expect.objectContaining({
      operation: 'update'
    }));
  });
});


describe('v2.1.0-rc3 administrator-facing cleanup', () => {
  test('filters legacy stored safety skips from webhook errors', async () => {
    kvsStore.get.mockResolvedValue({
      totalSyncs: 2,
      issuesCreated: 0,
      issuesUpdated: 0,
      commentsSynced: 0,
      issuesSkipped: 2,
      loopsPrevented: 0,
      lastSync: '2026-10-22T09:00:00.000Z',
      lastSuccessfulJiraWrite: null,
      errors: [
        { error: 'SYNC_STALE_EVENT', operation: 'skip' },
        { error: 'Comment authored by SyncApp (loop prevention)', operation: 'comment' },
        { error: 'HTTP 500', operation: 'update' }
      ],
      byOrg: {}
    });

    const resolvers = definedResolvers(defineStatsResolvers);
    const result = await resolvers.getWebhookSyncStats();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toBe('HTTP 500');
    expect(result.lastSuccessfulJiraWrite).toBeNull();
  });

  test('returns current legacy stats counters when older records omit them', async () => {
    kvsStore.get.mockResolvedValue({
      lastRun: '2026-10-22T09:00:00.000Z',
      issuesChecked: 4,
      issuesCreated: 0,
      issuesUpdated: 1,
      issuesSkipped: 3,
      issuesRecreated: 0,
      errors: [],
      events: []
    });

    const resolvers = definedResolvers(defineStatsResolvers);
    const result = await resolvers.getScheduledSyncStats();

    expect(result.issuesAlreadyCurrent).toBe(0);
    expect(result.issuesFailed).toBe(0);
    expect(result.lastSuccessfulJiraWrite).toBeNull();
  });

  test('manual scheduled trigger is fail-closed with no queue push', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/resolvers/sync.js'),
      'utf8'
    );
    const resolver = source.slice(source.indexOf("resolver.define('triggerScheduledSync'"));
    expect(resolver).toContain("success: false");
    expect(resolver).toContain('SCHEDULED_SYNC_MANUAL_TRIGGER_DISABLED');
    expect(source).not.toContain("from '@forge/events'");
    expect(source).not.toContain('manual-sync-queue');

    const consumerSource = fs.readFileSync(
      path.join(process.cwd(), 'src/triggers/manual-scheduled-sync.js'),
      'utf8'
    );
    expect(consumerSource).toContain('SCHEDULED_SYNC_MANUAL_TRIGGER_DISABLED');
    expect(consumerSource).not.toContain('performScheduledSync');
  });
});
