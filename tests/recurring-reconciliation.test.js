jest.mock('@forge/events', () => {
  const push = jest.fn(async () => undefined);
  return {
    Queue: jest.fn(() => ({ push })),
    __queuePush: push
  };
});

jest.mock('../src/services/storage/kvs.js', () => {
  const store = new Map();
  const get = jest.fn(async key => (store.has(key) ? store.get(key) : null));
  const set = jest.fn(async (key, value) => { store.set(key, value); });
  const del = jest.fn(async key => { store.delete(key); });
  const setIfNotExists = jest.fn(async (key, value) => {
    if (store.has(key)) {
      const error = new Error('already exists');
      error.code = 'KEY_ALREADY_EXISTS';
      throw error;
    }
    store.set(key, value);
  });
  return {
    __store: store,
    get,
    set,
    del,
    setIfNotExists,
    queryByPrefix: jest.fn(async prefix => Array.from(store.entries())
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value })))
  };
});

jest.mock('../src/services/storage/mappings.js', () => {
  const actual = jest.requireActual('../src/services/storage/mappings.js');
  return {
    ...actual,
    getOrganizationsWithTokens: jest.fn(),
    getRemoteKey: jest.fn(),
    getLocalKey: jest.fn()
  };
});

jest.mock('../src/services/sync/initial-sync.js', () => ({
  INITIAL_SYNC_QUEUE_KEY: 'initial-sync-queue',
  INITIAL_SYNC_MAX_ITEMS_PER_EVENT: 5,
  previewReconciliationCandidates: jest.fn(),
  processReconciliationCandidate: jest.fn()
}));

jest.mock('../src/services/jira/local-client.js', () => ({
  addLocalIssueComment: jest.fn(),
  probeLocalIssue: jest.fn()
}));

jest.mock('../src/services/jira/remote-client.js', () => ({
  probeRemoteIssue: jest.fn()
}));

jest.mock('../src/services/sync/pilot-pause.js', () => ({
  getPilotPause: jest.fn()
}));

import * as kvsStore from '../src/services/storage/kvs.js';
import {
  RECONCILIATION_DEFAULTS,
  getReconciliationSettings,
  saveReconciliationSettings,
  validateReconciliationSettings
} from '../src/services/sync/reconciliation-settings.js';
import {
  RECONCILIATION_ATTENTION_STATES,
  acknowledgeReconciliationAttention,
  getReconciliationAttention,
  reconciliationAttentionNeedsNotification,
  recordReconciliationFailure
} from '../src/services/sync/reconciliation-attention.js';
import {
  RECONCILIATION_REASONS,
  RECONCILIATION_STATES,
  buildReconciliationJobKey,
  buildReconciliationScheduleKey,
  getRecurringReconciliationStatus,
  processReconciliationJob,
  resolveRecurringReconciliationAttention,
  runDueReconciliations,
  saveRecurringReconciliationSettings
} from '../src/services/sync/source-reconciliation.js';
import {
  previewReconciliationCandidates,
  processReconciliationCandidate
} from '../src/services/sync/initial-sync.js';
import {
  getOrganizationsWithTokens,
  getRemoteKey,
  getLocalKey
} from '../src/services/storage/mappings.js';
import {
  addLocalIssueComment,
  probeLocalIssue
} from '../src/services/jira/local-client.js';
import { probeRemoteIssue } from '../src/services/jira/remote-client.js';
import { getPilotPause } from '../src/services/sync/pilot-pause.js';
import {
  RECONCILIATION_REVIEW_MARKER,
  buildReconciliationReviewCommentADF,
  isConnectorGeneratedComment
} from '../src/utils/adf.js';
import { __queuePush as queuePush } from '@forge/events';
import { toReconciliationSavePayload } from '../static/admin-page/src/reconciliation-save-payload.js';

const mockStore = kvsStore.__store;

const ORG = {
  id: 'org-1',
  name: 'Target Org',
  remoteUrl: 'https://target.example',
  remoteEmail: 'sync@example.com',
  remoteApiToken: 'token',
  remoteProjectKey: 'REMOTE',
  allowedProjects: ['LOCAL']
};

function enableSettings(overrides = {}) {
  return saveReconciliationSettings({
    orgId: ORG.id,
    settings: {
      recurringReconciliationEnabled: true,
      reconciliationIntervalMinutes: 60,
      reconciliationCommentOnReview: true,
      reconciliationFailureThreshold: 3,
      ...overrides
    }
  });
}

function previewWith(issueKeys, overrides = {}) {
  return {
    success: true,
    preview: {
      org: ORG,
      configuration: { mappings: {}, remoteProjectKey: 'REMOTE' },
      previewChecksum: 'preview-checksum',
      configurationChecksum: 'configuration-checksum',
      totalIssues: issueKeys.length,
      counts: { blockedByValidation: 0, mappingConflicts: 0 },
      classification: { eligible: { issueKeys } },
      ...overrides
    }
  };
}

async function createScheduledJob(now = Date.now()) {
  const result = await runDueReconciliations({ now });
  expect(result.scheduled).toBe(1);
  return mockStore.get(buildReconciliationJobKey(ORG.id));
}

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
  mockStore.set('organizations', [ORG]);
  getOrganizationsWithTokens.mockResolvedValue([ORG]);
  getRemoteKey.mockResolvedValue(null);
  getLocalKey.mockResolvedValue(null);
  getPilotPause.mockResolvedValue({ paused: false });
  addLocalIssueComment.mockResolvedValue({ success: true, commentId: '10001' });
  probeLocalIssue.mockResolvedValue({ reachable: true, statusCode: 200 });
  probeRemoteIssue.mockResolvedValue({ reachable: true, statusCode: 200 });
});

describe('recurring reconciliation settings', () => {
  test('are opt-in and disabled with safe defaults', async () => {
    await expect(getReconciliationSettings(ORG.id)).resolves.toEqual({
      ...RECONCILIATION_DEFAULTS,
      version: 1
    });
    expect(RECONCILIATION_DEFAULTS.recurringReconciliationEnabled).toBe(false);
  });

  test('validate interval, threshold and unknown keys', () => {
    expect(() => validateReconciliationSettings({
      recurringReconciliationEnabled: true,
      reconciliationIntervalMinutes: 5,
      reconciliationCommentOnReview: true,
      reconciliationFailureThreshold: 3
    })).toThrow(/reconciliationIntervalMinutes/);
    expect(() => validateReconciliationSettings({
      recurringReconciliationEnabled: true,
      reconciliationIntervalMinutes: 60,
      reconciliationCommentOnReview: true,
      reconciliationFailureThreshold: 3,
      remoteScan: true
    })).toThrow(/not a supported/);
  });

  test('accepts a save payload built from the status settings, rejects the raw echo', async () => {
    const status = await getRecurringReconciliationStatus({ orgId: ORG.id });
    // The status response carries the server-owned `version` metadata.
    expect(status.settings.version).toBe(1);

    // Echoing the status object verbatim is what the admin panel used to send.
    const echoed = await saveRecurringReconciliationSettings({
      orgId: ORG.id,
      settings: { ...status.settings, recurringReconciliationEnabled: true }
    });
    expect(echoed.success).toBe(false);
    expect(echoed.code).toBe('RECONCILIATION_INVALID_SETTINGS');

    // Sending only the editable fields is accepted.
    const result = await saveRecurringReconciliationSettings({
      orgId: ORG.id,
      settings: toReconciliationSavePayload({
        ...status.settings,
        recurringReconciliationEnabled: true
      })
    });
    expect(result.success).toBe(true);
    expect(result.settings.recurringReconciliationEnabled).toBe(true);
    expect(result.settings.version).toBe(1);
  });

  test('disabling cancels an active run without reversing completed writes', async () => {
    await enableSettings();
    const job = await createScheduledJob();
    const result = await saveRecurringReconciliationSettings({
      orgId: ORG.id,
      settings: {
        recurringReconciliationEnabled: false,
        reconciliationIntervalMinutes: 60,
        reconciliationCommentOnReview: true,
        reconciliationFailureThreshold: 3
      }
    });

    expect(result.success).toBe(true);
    expect(result.cancelledJob.state).toBe(RECONCILIATION_STATES.CANCELLED);
    expect(mockStore.get(buildReconciliationJobKey(ORG.id)).state)
      .toBe(RECONCILIATION_STATES.CANCELLED);
    expect(job.jobId).toBe(result.cancelledJob.jobId);
  });
});

describe('reconciliation scheduling', () => {
  test('disabled organizations enqueue nothing and write no schedule', async () => {
    const result = await runDueReconciliations({ now: Date.now() });

    expect(result.scheduled).toBe(0);
    expect(queuePush).not.toHaveBeenCalled();
    expect(mockStore.has(buildReconciliationScheduleKey(ORG.id))).toBe(false);
  });

  test('a due run is enqueued once and nextRunAt is not written at enqueue', async () => {
    await enableSettings();

    const result = await runDueReconciliations({ now: Date.now() });

    expect(result.scheduled).toBe(1);
    expect(queuePush).toHaveBeenCalledWith({
      body: {
        type: 'reconciliation',
        orgId: ORG.id,
        jobId: expect.stringMatching(/^reconciliation-/)
      }
    });
    expect(mockStore.has(buildReconciliationScheduleKey(ORG.id))).toBe(false);
    expect(mockStore.get(buildReconciliationJobKey(ORG.id)).state)
      .toBe(RECONCILIATION_STATES.QUEUED);
  });

  test('an active job blocks a duplicate run', async () => {
    await enableSettings();
    await runDueReconciliations({ now: Date.now() });
    queuePush.mockClear();

    const second = await runDueReconciliations({ now: Date.now() + 1000 });

    expect(second.scheduled).toBe(0);
    expect(queuePush).not.toHaveBeenCalled();
  });

  test('global pause defers scheduling and leaves nextRunAt untouched', async () => {
    await enableSettings();
    getPilotPause.mockResolvedValue({ paused: true });

    const result = await runDueReconciliations({ now: Date.now() });

    expect(result.deferred).toBe(1);
    expect(queuePush).not.toHaveBeenCalled();
    expect(mockStore.has(buildReconciliationScheduleKey(ORG.id))).toBe(false);
  });

  test('a failed enqueue leaves the organization due for the next hourly heartbeat', async () => {
    await enableSettings();
    queuePush.mockRejectedValueOnce(new Error('queue down'));

    const now = Date.now();
    const failed = await runDueReconciliations({ now });

    expect(failed.scheduled).toBe(0);
    expect(mockStore.get(buildReconciliationJobKey(ORG.id)).state)
      .toBe(RECONCILIATION_STATES.FAILED);
    expect(mockStore.has(buildReconciliationScheduleKey(ORG.id))).toBe(false);
    const status = await getRecurringReconciliationStatus({ orgId: ORG.id });
    expect(status.schedule.nextRunAt).toBeNull();
    expect(status.schedule.isDue).toBe(true);
    expect(status.activeJob).toBeNull();

    const retried = await runDueReconciliations({ now: now + 60 * 60 * 1000 });

    expect(retried.scheduled).toBe(1);
    expect(queuePush).toHaveBeenCalledTimes(2);
    expect(mockStore.get(buildReconciliationJobKey(ORG.id)).state)
      .toBe(RECONCILIATION_STATES.QUEUED);
    expect(mockStore.has(buildReconciliationScheduleKey(ORG.id))).toBe(false);
  });
});


describe('reconciliation worker', () => {
  test('reuses source candidates, completes, and writes nextRunAt only after completion', async () => {
    await enableSettings();
    const job = await createScheduledJob();
    queuePush.mockClear();
    previewReconciliationCandidates.mockResolvedValue(previewWith(['LOCAL-1']));
    processReconciliationCandidate.mockResolvedValue({
      issueKey: 'LOCAL-1',
      outcome: 'created',
      reasonCode: 'CREATED'
    });

    const result = await processReconciliationJob({
      orgId: ORG.id,
      jobId: job.jobId
    });

    expect(result.success).toBe(true);
    expect(result.state).toBe(RECONCILIATION_STATES.COMPLETED);
    expect(processReconciliationCandidate).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG.id,
      issueKey: 'LOCAL-1'
    }));
    const completed = mockStore.get(buildReconciliationJobKey(ORG.id));
    expect(completed.state).toBe(RECONCILIATION_STATES.COMPLETED);
    expect(completed.counts.created).toBe(1);
    const schedule = mockStore.get(buildReconciliationScheduleKey(ORG.id));
    expect(schedule.nextRunAt).toBeTruthy();
    expect(schedule.lastOutcome).toBe('success');
    expect(queuePush).not.toHaveBeenCalled();
  });

  test('a continuation enqueue failure leaves the run due for the next heartbeat', async () => {
    await enableSettings();
    const job = await createScheduledJob();
    queuePush.mockClear();
    previewReconciliationCandidates.mockResolvedValue(previewWith(['LOCAL-1', 'LOCAL-2']));
    processReconciliationCandidate.mockResolvedValue({
      issueKey: 'LOCAL-1',
      outcome: 'updated',
      reasonCode: 'UPDATED'
    });
    queuePush.mockRejectedValueOnce(new Error('queue down'));

    const result = await processReconciliationJob({
      orgId: ORG.id,
      jobId: job.jobId,
      maxItems: 1
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe(RECONCILIATION_REASONS.QUEUE_ENQUEUE_FAILED);
    expect(mockStore.get(buildReconciliationJobKey(ORG.id)).state)
      .toBe(RECONCILIATION_STATES.FAILED);
    expect(mockStore.has(buildReconciliationScheduleKey(ORG.id))).toBe(false);
    const status = await getRecurringReconciliationStatus({ orgId: ORG.id });
    expect(status.schedule.nextRunAt).toBeNull();
    expect(status.schedule.isDue).toBe(true);
  });

  test('a definitive preview failure advances nextRunAt from the failure time', async () => {
    await enableSettings();
    const job = await createScheduledJob();
    previewReconciliationCandidates.mockResolvedValue({
      success: false,
      code: RECONCILIATION_REASONS.PREVIEW_FAILED
    });
    const startedAt = Date.now();

    const result = await processReconciliationJob({
      orgId: ORG.id,
      jobId: job.jobId,
      now: startedAt
    });

    expect(result.success).toBe(false);
    const failedJob = mockStore.get(buildReconciliationJobKey(ORG.id));
    expect(failedJob.state).toBe(RECONCILIATION_STATES.FAILED);
    expect(failedJob.reasonCode).toBe(RECONCILIATION_REASONS.PREVIEW_FAILED);
    const schedule = mockStore.get(buildReconciliationScheduleKey(ORG.id));
    expect(schedule.nextRunAt).toBe(new Date(startedAt + 60 * 60 * 1000).toISOString());
    expect(schedule.lastOutcome).toBe('failed');
  });

  test('bounded processing enqueues the same job and does not advance nextRunAt early', async () => {
    await enableSettings();
    const job = await createScheduledJob();
    queuePush.mockClear();
    previewReconciliationCandidates.mockResolvedValue(previewWith(['LOCAL-1', 'LOCAL-2']));
    processReconciliationCandidate.mockImplementation(async ({ issueKey }) => ({
      issueKey,
      outcome: 'created',
      reasonCode: 'CREATED'
    }));

    const first = await processReconciliationJob({
      orgId: ORG.id,
      jobId: job.jobId,
      maxItems: 1
    });

    expect(first.continued).toBe(true);
    expect(mockStore.has(buildReconciliationScheduleKey(ORG.id))).toBe(false);
    expect(mockStore.get(buildReconciliationJobKey(ORG.id)).attemptedKeys).toEqual(['LOCAL-1']);
    expect(queuePush).toHaveBeenCalledWith({
      body: { type: 'reconciliation', orgId: ORG.id, jobId: job.jobId }
    });

    queuePush.mockClear();
    const second = await processReconciliationJob({
      orgId: ORG.id,
      jobId: job.jobId,
      maxItems: 1
    });

    expect(second.state).toBe(RECONCILIATION_STATES.COMPLETED);
    expect(processReconciliationCandidate).toHaveBeenCalledTimes(2);
    expect(processReconciliationCandidate.mock.calls[1][0].issueKey).toBe('LOCAL-2');
    expect(mockStore.get(buildReconciliationScheduleKey(ORG.id)).nextRunAt).toBeTruthy();
  });

  test('global pause defers without advancing the schedule', async () => {
    await enableSettings();
    const job = await createScheduledJob();
    getPilotPause.mockResolvedValue({ paused: true });

    const result = await processReconciliationJob({
      orgId: ORG.id,
      jobId: job.jobId
    });

    expect(result.state).toBe(RECONCILIATION_STATES.DEFERRED);
    expect(mockStore.has(buildReconciliationScheduleKey(ORG.id))).toBe(false);
    expect(mockStore.get(buildReconciliationJobKey(ORG.id)).state)
      .toBe(RECONCILIATION_STATES.DEFERRED);
  });

  test('repeated failures keep one stable attention record and comment only once', async () => {
    await enableSettings({ reconciliationFailureThreshold: 2 });
    previewReconciliationCandidates.mockResolvedValue(previewWith(['LOCAL-1']));
    processReconciliationCandidate.mockResolvedValue({
      issueKey: 'LOCAL-1',
      outcome: 'failed',
      reasonCode: 'CREATE_NOT_STARTED'
    });

    const firstJob = await createScheduledJob(Date.now());
    const first = await processReconciliationJob({
      orgId: ORG.id,
      jobId: firstJob.jobId
    });
    expect(first.state).toBe(RECONCILIATION_STATES.COMPLETED);
    const firstRecord = await getReconciliationAttention({
      orgId: ORG.id,
      localKey: 'LOCAL-1'
    });
    expect(firstRecord.attempts).toBe(1);
    expect(firstRecord.state).toBe(RECONCILIATION_ATTENTION_STATES.OPEN);
    expect(addLocalIssueComment).not.toHaveBeenCalled();

    const secondJob = await createScheduledJob(Date.now() + 2 * 60 * 60 * 1000);
    await processReconciliationJob({
      orgId: ORG.id,
      jobId: secondJob.jobId
    });
    const secondRecord = await getReconciliationAttention({
      orgId: ORG.id,
      localKey: 'LOCAL-1'
    });
    expect(secondRecord.firstSeenAt).toBe(firstRecord.firstSeenAt);
    expect(secondRecord.attempts).toBe(2);
    expect(addLocalIssueComment).toHaveBeenCalledTimes(1);
    expect(addLocalIssueComment.mock.calls[0][1].content[0].content[0].text)
      .toContain(RECONCILIATION_REVIEW_MARKER);
  });


  test('acknowledging suppresses notifications but preserves the unresolved state', async () => {
    await recordReconciliationFailure({
      orgId: ORG.id,
      localKey: 'LOCAL-9',
      reasonCode: 'CREATE_NOT_STARTED'
    });
    const acknowledged = await acknowledgeReconciliationAttention({
      orgId: ORG.id,
      localKey: 'LOCAL-9',
      actorAccountId: 'admin-1'
    });

    expect(acknowledged.success).toBe(true);
    expect(acknowledged.record.state).toBe(RECONCILIATION_ATTENTION_STATES.OPEN);
    expect(acknowledged.record.acknowledgedAt).toBeTruthy();
    expect(reconciliationAttentionNeedsNotification(acknowledged.record, 1)).toBe(false);
  });

  test('resolve requires fresh mapping and health-check confirmation', async () => {
    await recordReconciliationFailure({
      orgId: ORG.id,
      localKey: 'LOCAL-1',
      reasonCode: 'CREATE_NOT_STARTED'
    });
    getRemoteKey.mockResolvedValue('REMOTE-1');
    getLocalKey.mockResolvedValue('LOCAL-1');

    const resolved = await resolveRecurringReconciliationAttention({
      orgId: ORG.id,
      localKey: 'LOCAL-1',
      actorAccountId: 'admin-1'
    });

    expect(resolved.success).toBe(true);
    expect(resolved.record.state).toBe(RECONCILIATION_ATTENTION_STATES.RESOLVED);
    expect(probeLocalIssue).toHaveBeenCalledWith('LOCAL-1');
    expect(probeRemoteIssue).toHaveBeenCalledWith('REMOTE-1', ORG);
  });

  test('a failed resolve health check leaves the attention record unresolved', async () => {
    await recordReconciliationFailure({
      orgId: ORG.id,
      localKey: 'LOCAL-2',
      reasonCode: 'CREATE_NOT_STARTED'
    });
    getRemoteKey.mockResolvedValue('REMOTE-2');
    getLocalKey.mockResolvedValue('LOCAL-2');
    probeRemoteIssue.mockResolvedValue({ reachable: false, statusCode: 404 });

    const resolved = await resolveRecurringReconciliationAttention({
      orgId: ORG.id,
      localKey: 'LOCAL-2'
    });

    expect(resolved.success).toBe(false);
    expect(resolved.code).toBe('RECONCILIATION_HEALTH_CHECK_FAILED');
    const record = await getReconciliationAttention({
      orgId: ORG.id,
      localKey: 'LOCAL-2'
    });
    expect(record.state).toBe(RECONCILIATION_ATTENTION_STATES.OPEN);
  });

  test('status exposes settings, schedule, active job and attention summary', async () => {
    await enableSettings();
    await recordReconciliationFailure({
      orgId: ORG.id,
      localKey: 'LOCAL-3',
      reasonCode: 'CREATE_NOT_STARTED'
    });

    const status = await getRecurringReconciliationStatus({ orgId: ORG.id });

    expect(status.success).toBe(true);
    expect(status.settings.recurringReconciliationEnabled).toBe(true);
    expect(status.schedule.isDue).toBe(true);
    expect(status.attentionSummary.open).toBe(1);
  });
});

describe('connector review comment filtering', () => {
  test('the review comment marker is recognizable as connector-generated', () => {
    const body = buildReconciliationReviewCommentADF({
      localKey: 'LOCAL-1',
      reasonCode: 'CREATE_NOT_STARTED',
      attempts: 3
    });

    expect(isConnectorGeneratedComment(body)).toBe(true);
    expect(isConnectorGeneratedComment({
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A real user comment' }] }]
    })).toBe(false);
  });
});
