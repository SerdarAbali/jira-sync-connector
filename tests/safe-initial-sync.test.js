import fs from 'fs';
import path from 'path';

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  const fetchMock = jest.fn();
  return {
    __esModule: true,
    default: { asApp: () => ({ requestJira }) },
    route: (strings, ...values) => strings.reduce((out, part, index) => out + part + (values[index] ?? ''), ''),
    fetch: fetchMock,
    __requestJira: requestJira,
    __fetch: fetchMock
  };
});

jest.mock('@forge/events', () => {
  const push = jest.fn();
  return {
    Queue: jest.fn(() => ({ push })),
    __queuePush: push
  };
});

jest.mock('../src/services/storage/kvs.js', () => {
  const store = new Map();
  return {
    __store: store,
    get: jest.fn(async key => (store.has(key) ? store.get(key) : null)),
    set: jest.fn(async (key, value) => { store.set(key, value); }),
    del: jest.fn(async key => { store.delete(key); }),
    getSecret: jest.fn(async key => (store.has(key) ? store.get(key) : null)),
    setIfNotExists: jest.fn(async (key, value) => {
      if (store.has(key)) {
        const error = new Error('key exists');
        error.code = 'KEY_ALREADY_EXISTS';
        throw error;
      }
      store.set(key, value);
    }),
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

jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn()
}));

jest.mock('../src/services/sync/issue-sync.js', () => ({
  createRemoteIssue: jest.fn()
}));

import {
  previewInitialSync,
  startInitialSync,
  getInitialSyncStatus,
  pauseInitialSync,
  resumeInitialSync,
  cancelInitialSync,
  processInitialSyncJob,
  recoverInitialSyncJobs,
  buildInitialSyncJobKey,
  acquireInitialSyncProcessingLease,
  releaseInitialSyncProcessingLease,
  verifyInitialSyncProcessingLease,
  INITIAL_SYNC_PROCESSING_LEASE_SECONDS,
  INITIAL_SYNC_MAX_PROCESSING_WINDOW_MS,
  INITIAL_SYNC_STATES,
  INITIAL_SYNC_REASONS
} from '../src/services/sync/initial-sync.js';
import {
  beginIssueCreateOperation,
  markIssueCreateSubmissionStarted,
  markIssueCreateUnknown,
  ISSUE_CREATE_DIRECTIONS
} from '../src/services/sync/issue-create-operation.js';
import {
  getRemoteKey,
  getLocalKey
} from '../src/services/storage/mappings.js';
import { getFullIssue } from '../src/services/jira/local-client.js';
import { createRemoteIssue } from '../src/services/sync/issue-sync.js';
import * as kvsStore from '../src/services/storage/kvs.js';
import { RESOLVER_POLICIES } from '../src/resolvers/authorization-policy.js';
import { __requestJira as mockRequestJira, __fetch as mockFetch } from '@forge/api';
import { __queuePush as mockQueuePush } from '@forge/events';

const mockStore = kvsStore.__store;

const ORG = {
  id: 'org-1',
  name: 'Target Org',
  remoteUrl: 'https://target.example',
  remoteEmail: 'sync@example.com',
  remoteApiToken: 'token-for-tests',
  remoteProjectKey: 'REMOTE',
  allowedProjects: ['LOCAL'],
  jqlFilter: 'labels = initial-sync',
  syncDirection: 'push'
};

const SECRET_SUMMARY = 'PRIVATE_ISSUE_CONTENT_DO_NOT_STORE';

let searchIssues = [];

function issue(key, overrides = {}) {
  return {
    key,
    fields: {
      project: { key: 'LOCAL' },
      summary: `${SECRET_SUMMARY}_${key}`,
      issuetype: { name: 'Task', id: '1' },
      status: { name: 'To Do' },
      parent: null,
      ...overrides
    }
  };
}

function searchResponse(issues = searchIssues) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ issues })
  };
}

async function makePreview() {
  const result = await previewInitialSync({ orgId: ORG.id });
  expect(result.success).toBe(true);
  return result.preview;
}

async function startFromPreview(preview) {
  return startInitialSync({
    orgId: ORG.id,
    approved: true,
    previewChecksum: preview.previewChecksum,
    configurationChecksum: preview.configurationChecksum,
    startedBy: 'admin-1'
  });
}

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
  mockRequestJira.mockReset();
  mockFetch.mockReset();
  mockQueuePush.mockReset();
  mockQueuePush.mockResolvedValue(undefined);

  mockStore.set('organizations', [ORG]);
  mockStore.set('secret:org-1:token', ORG.remoteApiToken);
  getRemoteKey.mockResolvedValue(null);
  getLocalKey.mockResolvedValue(null);
  getFullIssue.mockImplementation(async key => issue(key));
  createRemoteIssue.mockImplementation(async current => ({
    key: `REMOTE-${current.key.split('-')[1]}`
  }));
  mockRequestJira.mockImplementation(async () => searchResponse());
  searchIssues = [
    issue('LOCAL-1'),
    issue('LOCAL-2'),
    issue('LOCAL-3', { summary: '' }),
    issue('LOCAL-4')
  ];
});

describe('safe initial sync preview', () => {
  test('is read-only, uses the configured allowed project and JQL, and exposes keys only', async () => {
    getRemoteKey.mockImplementation(async key => (key === 'LOCAL-2' ? 'REMOTE-2' : null));
    getLocalKey.mockImplementation(async key => (key === 'REMOTE-2' ? 'LOCAL-2' : null));
    const claim = await beginIssueCreateOperation({
      orgId: ORG.id,
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-4'
    });
    await markIssueCreateSubmissionStarted(claim.operation);
    await markIssueCreateUnknown(claim.operation);
    kvsStore.set.mockClear();

    const result = await previewInitialSync({ orgId: ORG.id });

    expect(result.success).toBe(true);
    expect(result.preview.counts).toEqual({
      eligible: 1,
      alreadyMapped: 1,
      blockedByValidation: 1,
      mappingConflicts: 1
    });
    expect(result.preview.classification.eligible.issueKeys).toEqual(['LOCAL-1']);
    expect(result.preview.classification.alreadyMapped.issueKeys).toEqual(['LOCAL-2']);
    expect(result.preview.classification.blockedByValidation.issueKeys).toEqual(['LOCAL-3']);
    expect(result.preview.classification.mappingConflicts.issueKeys).toEqual(['LOCAL-4']);

    const request = mockRequestJira.mock.calls[0];
    const body = JSON.parse(request[1].body);
    expect(body.jql).toBe('project = LOCAL AND (labels = initial-sync) ORDER BY key ASC');
    expect(body.fields).not.toContain('description');
    expect(kvsStore.set).not.toHaveBeenCalled();
    expect(mockQueuePush).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(SECRET_SUMMARY);
  });

  test('classifies reverse mapping conflicts, incomplete pairs, and out-of-scope parents', async () => {
    searchIssues = [
      issue('LOCAL-1'),
      issue('LOCAL-2'),
      issue('LOCAL-3'),
      issue('LOCAL-5', { parent: { key: 'LOCAL-99' } })
    ];
    getRemoteKey.mockImplementation(async key => {
      if (key === 'LOCAL-1') return 'REMOTE-1';
      if (key === 'LOCAL-2') return 'REMOTE-2';
      if (key === 'LOCAL-3') return 'not-a-valid-key';
      return null;
    });
    getLocalKey.mockImplementation(async key => {
      if (key === 'REMOTE-1') return 'DIFFERENT-LOCAL';
      if (key === 'REMOTE-2') return null;
      return null;
    });

    const preview = await makePreview();

    expect(preview.classification.mappingConflicts.reasons).toEqual({
      MAPPING_REVERSE_CONFLICT: 1,
      MAPPING_PAIR_INCOMPLETE: 1,
      INVALID_EXISTING_MAPPING: 1
    });
    expect(preview.classification.blockedByValidation.reasons).toEqual({
      PARENT_OUTSIDE_SCOPE: 1
    });
  });

  test('rejects stale preview and configuration checksums before queueing or writing', async () => {
    searchIssues = [issue('LOCAL-1')];
    const preview = await makePreview();
    kvsStore.set.mockClear();
    mockQueuePush.mockClear();

    searchIssues = [issue('LOCAL-1'), issue('LOCAL-6')];
    const staleScope = await startFromPreview(preview);
    expect(staleScope).toEqual(expect.objectContaining({
      success: false,
      code: INITIAL_SYNC_REASONS.PREVIEW_CHECKSUM_MISMATCH
    }));

    searchIssues = [issue('LOCAL-1')];
    const freshPreview = await makePreview();
    mockStore.set('issueTypeMappings:org-1', { remoteType: { localName: 'Task', remoteName: 'Task' } });
    const staleConfig = await startFromPreview(freshPreview);
    expect(staleConfig).toEqual(expect.objectContaining({
      success: false,
      code: INITIAL_SYNC_REASONS.CONFIGURATION_CHECKSUM_MISMATCH
    }));
    expect(mockQueuePush).not.toHaveBeenCalled();
    expect(mockStore.has(buildInitialSyncJobKey(ORG.id))).toBe(false);
  });

  test('rejects organization scope or JQL changes after preview', async () => {
    searchIssues = [issue('LOCAL-1')];
    const preview = await makePreview();

    mockStore.set('organizations', [{
      ...ORG,
      jqlFilter: 'labels = changed-after-preview'
    }]);

    const result = await startFromPreview(preview);
    expect(result).toEqual(expect.objectContaining({
      success: false,
      code: INITIAL_SYNC_REASONS.CONFIGURATION_CHECKSUM_MISMATCH
    }));
    expect(mockQueuePush).not.toHaveBeenCalled();
  });

  test('requires explicit approval and persists an identifier-only queue payload', async () => {
    searchIssues = [issue('LOCAL-1')];
    const preview = await makePreview();

    const noApproval = await startInitialSync({
      orgId: ORG.id,
      approved: false,
      previewChecksum: preview.previewChecksum,
      configurationChecksum: preview.configurationChecksum
    });
    expect(noApproval.code).toBe(INITIAL_SYNC_REASONS.APPROVAL_REQUIRED);

    mockQueuePush.mockClear();
    const started = await startFromPreview(preview);
    expect(started.success).toBe(true);
    expect(mockQueuePush).toHaveBeenCalledTimes(1);
    const payload = mockQueuePush.mock.calls[0][0];
    expect(Object.keys(payload.body).sort()).toEqual(['jobId', 'orgId', 'type']);
    expect(payload.body.orgId).toBe(ORG.id);
    expect(JSON.stringify(payload)).not.toContain(SECRET_SUMMARY);
    expect(JSON.stringify(payload)).not.toContain('LOCAL-1');
  });

  test('authorization policy makes preview read-only and every mutation administrator-only', () => {
    expect(RESOLVER_POLICIES.previewInitialSync).toBe('ADMIN_READ');
    expect(RESOLVER_POLICIES.getInitialSyncStatus).toBe('ADMIN_READ');
    expect(RESOLVER_POLICIES.startInitialSync).toBe('ADMIN_WRITE');
    expect(RESOLVER_POLICIES.pauseInitialSync).toBe('ADMIN_WRITE');
    expect(RESOLVER_POLICIES.resumeInitialSync).toBe('ADMIN_WRITE');
    expect(RESOLVER_POLICIES.cancelInitialSync).toBe('ADMIN_WRITE');
  });

  test('does not use summary matching or restore deletion/recreation controls', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'services', 'sync', 'initial-sync.js'),
      'utf8'
    );
    expect(source).not.toMatch(/summary\s*[~=]/i);
    expect(source).not.toContain('forceRecreate');
    expect(source).not.toContain('recreateDeletedIssues: true');
    expect(source).not.toContain('propagateAttachmentDeletions: true');
  });
});


describe('initial sync processing lease ownership', () => {
  const LOCK_KEY = 'initialSyncLock:org-1';
  const NEWER_TOKEN = 'f'.repeat(64);

  test('generates a unique cryptographic token and persists ownership for every acquisition', async () => {
    const now = Date.now();
    const first = await acquireInitialSyncProcessingLease({
      orgId: ORG.id,
      jobId: 'job-token-1',
      now
    });

    expect(first).toEqual(expect.objectContaining({
      acquired: true,
      status: 'ACQUIRED',
      jobId: 'job-token-1',
      leaseToken: expect.stringMatching(/^[a-f0-9]{64}$/),
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + INITIAL_SYNC_PROCESSING_LEASE_SECONDS * 1000).toISOString()
    }));
    expect(INITIAL_SYNC_PROCESSING_LEASE_SECONDS * 1000)
      .toBeGreaterThan(INITIAL_SYNC_MAX_PROCESSING_WINDOW_MS);
    expect(mockStore.get(LOCK_KEY)).toEqual({
      jobId: 'job-token-1',
      leaseToken: first.leaseToken,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + INITIAL_SYNC_PROCESSING_LEASE_SECONDS * 1000).toISOString()
    });

    expect(await releaseInitialSyncProcessingLease(first)).toEqual({
      released: true,
      status: 'RELEASED'
    });

    const second = await acquireInitialSyncProcessingLease({
      orgId: ORG.id,
      jobId: 'job-token-1',
      now: now + 1
    });
    expect(second.acquired).toBe(true);
    expect(second.leaseToken).toMatch(/^[a-f0-9]{64}$/);
    expect(second.leaseToken).not.toBe(first.leaseToken);
    await releaseInitialSyncProcessingLease(second);
  });

  test('a stale invocation cannot release a newer invocation lease', async () => {
    const stale = await acquireInitialSyncProcessingLease({
      orgId: ORG.id,
      jobId: 'job-stale'
    });
    const newer = {
      jobId: 'job-stale',
      leaseToken: NEWER_TOKEN,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
    mockStore.set(LOCK_KEY, newer);

    const released = await releaseInitialSyncProcessingLease(stale);

    expect(released).toEqual({ released: false, status: 'LEASE_LOST' });
    expect(mockStore.get(LOCK_KEY)).toEqual(newer);
  });


  test('an expired and reacquired lease remains owned by the newer invocation', async () => {
    const stale = await acquireInitialSyncProcessingLease({
      orgId: ORG.id,
      jobId: 'job-reacquired',
      now: Date.now()
    });
    mockStore.delete(LOCK_KEY);

    const newer = await acquireInitialSyncProcessingLease({
      orgId: ORG.id,
      jobId: 'job-reacquired',
      now: Date.now() + 1
    });
    expect(newer.acquired).toBe(true);
    expect(await verifyInitialSyncProcessingLease(newer))
      .toEqual({ owned: true, status: 'OWNED' });

    expect(await releaseInitialSyncProcessingLease(stale)).toEqual({
      released: false,
      status: 'LEASE_LOST'
    });
    expect(await verifyInitialSyncProcessingLease(newer))
      .toEqual({ owned: true, status: 'OWNED' });
    expect(mockStore.get(LOCK_KEY).leaseToken).toBe(newer.leaseToken);
    expect(await releaseInitialSyncProcessingLease(newer)).toEqual({
      released: true,
      status: 'RELEASED'
    });
  });

  test('reports a conditional storage failure instead of ordinary lock contention', async () => {
    searchIssues = [issue('LOCAL-1')];
    const preview = await makePreview();
    const started = await startFromPreview(preview);
    mockQueuePush.mockClear();
    createRemoteIssue.mockClear();
    kvsStore.setIfNotExists.mockRejectedValueOnce(
      Object.assign(new Error('storage quota exceeded'), { code: 'QUOTA' })
    );

    const result = await processInitialSyncJob({
      orgId: ORG.id,
      jobId: started.job.jobId,
      maxItems: 1
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      code: INITIAL_SYNC_REASONS.LEASE_STORAGE_ERROR,
      processed: 0
    }));
    expect(result.code).not.toBe('INITIAL_SYNC_JOB_LOCKED');
    expect(createRemoteIssue).not.toHaveBeenCalled();
    expect(mockQueuePush).not.toHaveBeenCalled();
  });

  test('stops without advancing the cursor or scheduling a continuation after ownership is lost', async () => {
    searchIssues = [issue('LOCAL-1'), issue('LOCAL-2'), issue('LOCAL-3')];
    const preview = await makePreview();
    const started = await startFromPreview(preview);
    mockQueuePush.mockClear();
    createRemoteIssue.mockClear();
    const newer = {
      jobId: started.job.jobId,
      leaseToken: NEWER_TOKEN,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
    createRemoteIssue.mockImplementationOnce(async current => {
      mockStore.set(LOCK_KEY, newer);
      return { key: `REMOTE-${current.key.split('-')[1]}` };
    });

    const result = await processInitialSyncJob({
      orgId: ORG.id,
      jobId: started.job.jobId,
      maxItems: 2
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      code: INITIAL_SYNC_REASONS.LEASE_LOST,
      processed: 0
    }));
    expect(createRemoteIssue).toHaveBeenCalledTimes(1);
    expect(mockQueuePush).not.toHaveBeenCalled();
    const status = await getInitialSyncStatus({ orgId: ORG.id });
    expect(status.status.state).toBe(INITIAL_SYNC_STATES.RUNNING);
    expect(status.status.progress).toEqual({ total: 3, processed: 0, remaining: 3 });
    expect(status.status.lastConfirmedKey).toBeNull();
    expect(status.status.counts.created).toBe(0);
    expect(mockStore.get(LOCK_KEY)).toEqual(newer);
  });

  test('rechecks ownership before enqueuing a continuation after a checkpoint', async () => {
    searchIssues = [issue('LOCAL-1'), issue('LOCAL-2'), issue('LOCAL-3')];
    const preview = await makePreview();
    const started = await startFromPreview(preview);
    mockQueuePush.mockClear();
    createRemoteIssue.mockClear();
    const newer = {
      jobId: started.job.jobId,
      leaseToken: NEWER_TOKEN,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
    const persist = kvsStore.set.getMockImplementation();
    kvsStore.set.mockImplementationOnce(async (key, value) => {
      await persist(key, value);
      if (key === buildInitialSyncJobKey(ORG.id)) {
        mockStore.set(LOCK_KEY, newer);
      }
    });

    const result = await processInitialSyncJob({
      orgId: ORG.id,
      jobId: started.job.jobId,
      maxItems: 1
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      code: INITIAL_SYNC_REASONS.LEASE_LOST,
      processed: 1
    }));
    expect(mockQueuePush).not.toHaveBeenCalled();
    const status = await getInitialSyncStatus({ orgId: ORG.id });
    expect(status.status.progress).toEqual({ total: 3, processed: 1, remaining: 2 });
    expect(status.status.lastConfirmedKey).toBe('LOCAL-1');
    expect(mockStore.get(LOCK_KEY)).toEqual(newer);
  });
});



describe('bounded safe initial sync processing', () => {
  test('processes at most the configured bound, checkpoints, and schedules one continuation', async () => {
    searchIssues = ['LOCAL-1', 'LOCAL-2', 'LOCAL-3', 'LOCAL-4', 'LOCAL-5', 'LOCAL-6', 'LOCAL-7']
      .map(key => issue(key));
    const preview = await makePreview();
    const started = await startFromPreview(preview);
    expect(started.success).toBe(true);
    mockQueuePush.mockClear();
    createRemoteIssue.mockClear();

    const first = await processInitialSyncJob({
      orgId: ORG.id,
      jobId: started.job.jobId,
      maxItems: 2
    });

    expect(first.success).toBe(true);
    expect(first.processed).toBe(2);
    expect(createRemoteIssue).toHaveBeenCalledTimes(2);
    expect(mockQueuePush).toHaveBeenCalledTimes(1);
    const status = await getInitialSyncStatus({ orgId: ORG.id });
    expect(status.status.state).toBe(INITIAL_SYNC_STATES.RUNNING);
    expect(status.status.progress).toEqual({ total: 7, processed: 2, remaining: 5 });
    expect(status.status.lastConfirmedKey).toBe('LOCAL-2');
    expect(status.status.counts.created).toBe(2);
  });

  test('resumes from the persisted cursor after a restart and preserves the final report', async () => {
    searchIssues = [issue('LOCAL-1'), issue('LOCAL-2'), issue('LOCAL-3')];
    const preview = await makePreview();
    const started = await startFromPreview(preview);
    mockQueuePush.mockClear();
    createRemoteIssue.mockClear();

    await processInitialSyncJob({ orgId: ORG.id, jobId: started.job.jobId, maxItems: 1 });
    expect(createRemoteIssue.mock.calls[0][0].key).toBe('LOCAL-1');

    // A new invocation has no in-memory state: it must trust only KVS.
    await processInitialSyncJob({ orgId: ORG.id, jobId: started.job.jobId, maxItems: 2 });
    expect(createRemoteIssue.mock.calls.map(call => call[0].key)).toEqual(['LOCAL-1', 'LOCAL-2', 'LOCAL-3']);

    const completed = await getInitialSyncStatus({ orgId: ORG.id });
    expect(completed.status.state).toBe(INITIAL_SYNC_STATES.COMPLETED);
    expect(completed.status.progress).toEqual({ total: 3, processed: 3, remaining: 0 });
    expect(completed.status.counts).toEqual(expect.objectContaining({
      created: 3,
      alreadyMapped: 0,
      skipped: 0,
      mappingConflicts: 0,
      reconciliationRequired: 0,
      failed: 0,
      cancelled: 0
    }));
  });

  test('persists parent-first ordering for a child returned before its parent', async () => {
    searchIssues = [
      issue('LOCAL-2', { parent: { key: 'LOCAL-1' } }),
      issue('LOCAL-1')
    ];
    const preview = await makePreview();
    expect(preview.classification.eligible.issueKeys).toEqual(['LOCAL-1', 'LOCAL-2']);

    const started = await startFromPreview(preview);
    createRemoteIssue.mockClear();
    await processInitialSyncJob({ orgId: ORG.id, jobId: started.job.jobId, maxItems: 2 });
    expect(createRemoteIssue.mock.calls.map(call => call[0].key)).toEqual(['LOCAL-1', 'LOCAL-2']);
  });

  test('passes configured fields and attachment/comment/link options to the existing create path', async () => {
    searchIssues = [issue('LOCAL-1')];
    mockStore.set('syncOptions:org-1', {
      syncComments: true,
      syncAttachments: true,
      syncLinks: true,
      syncCrossReference: true,
      propagateAttachmentDeletions: false
    });
    mockStore.set('fieldMappings:org-1', { customfield_1: 'customfield_2' });
    const preview = await makePreview();
    const started = await startFromPreview(preview);
    await processInitialSyncJob({ orgId: ORG.id, jobId: started.job.jobId, maxItems: 1 });

    const options = createRemoteIssue.mock.calls[0][4];
    const mappings = createRemoteIssue.mock.calls[0][2];
    expect(options).toEqual(expect.objectContaining({
      syncComments: true,
      syncAttachments: true,
      syncLinks: true,
      forceCheckAttachments: true,
      forceCheckLinks: true,
      recreateDeletedIssues: false,
      propagateAttachmentDeletions: false
    }));
    expect(mappings.fieldMappings).toEqual({ customfield_1: 'customfield_2' });
  });

  test('does not automatically retry an unknown create and records reconciliation required', async () => {
    searchIssues = [issue('LOCAL-1'), issue('LOCAL-2')];
    const preview = await makePreview();
    const started = await startFromPreview(preview);
    createRemoteIssue.mockImplementation(async current => {
      if (current.key === 'LOCAL-1') {
        const claim = await beginIssueCreateOperation({
          orgId: ORG.id,
          direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
          sourceKey: current.key
        });
        await markIssueCreateSubmissionStarted(claim.operation);
        await markIssueCreateUnknown(claim.operation);
        return null;
      }
      return { key: 'REMOTE-2' };
    });

    await processInitialSyncJob({ orgId: ORG.id, jobId: started.job.jobId, maxItems: 2 });
    const status = await getInitialSyncStatus({ orgId: ORG.id });
    expect(status.status.counts.reconciliationRequired).toBe(1);
    expect(status.status.counts.created).toBe(1);

    createRemoteIssue.mockClear();
    await processInitialSyncJob({ orgId: ORG.id, jobId: started.job.jobId, maxItems: 2 });
    expect(createRemoteIssue).not.toHaveBeenCalled();
  });
});


describe('initial sync controls and restart recovery', () => {
  test('pause stops new writes, resume continues from the cursor, and cancel leaves completed writes intact', async () => {
    searchIssues = [issue('LOCAL-1'), issue('LOCAL-2'), issue('LOCAL-3')];
    const preview = await makePreview();
    const started = await startFromPreview(preview);
    mockQueuePush.mockClear();
    createRemoteIssue.mockClear();

    const paused = await pauseInitialSync({ orgId: ORG.id });
    expect(paused.success).toBe(true);
    expect(paused.job.state).toBe(INITIAL_SYNC_STATES.PAUSED);
    createRemoteIssue.mockClear();
    await processInitialSyncJob({ orgId: ORG.id, jobId: started.job.jobId, maxItems: 2 });
    expect(createRemoteIssue).not.toHaveBeenCalled();
    expect(mockQueuePush).not.toHaveBeenCalled();

    const resumed = await resumeInitialSync({ orgId: ORG.id });
    expect(resumed.success).toBe(true);
    expect(mockQueuePush).toHaveBeenCalledTimes(1);
    await processInitialSyncJob({ orgId: ORG.id, jobId: started.job.jobId, maxItems: 1 });
    expect(createRemoteIssue).toHaveBeenCalledTimes(1);

    mockQueuePush.mockClear();
    const cancelled = await cancelInitialSync({ orgId: ORG.id });
    expect(cancelled.success).toBe(true);
    expect(cancelled.job.state).toBe(INITIAL_SYNC_STATES.CANCELLED);
    expect(cancelled.job.counts.cancelled).toBe(2);

    createRemoteIssue.mockClear();
    await processInitialSyncJob({ orgId: ORG.id, jobId: started.job.jobId, maxItems: 2 });
    expect(createRemoteIssue).not.toHaveBeenCalled();
    expect(mockQueuePush).not.toHaveBeenCalled();
  });

  test('global Pause blocks the worker and resume remains blocked until writes are active', async () => {
    searchIssues = [issue('LOCAL-1'), issue('LOCAL-2')];
    const preview = await makePreview();
    const started = await startFromPreview(preview);
    createRemoteIssue.mockClear();
    mockQueuePush.mockClear();

    mockStore.set('pilotPause', {
      paused: true,
      pausedAt: new Date().toISOString(),
      pausedBy: 'admin-1',
      reasonCode: 'emergency_stop'
    });

    await processInitialSyncJob({ orgId: ORG.id, jobId: started.job.jobId, maxItems: 2 });
    expect(createRemoteIssue).not.toHaveBeenCalled();
    const paused = await getInitialSyncStatus({ orgId: ORG.id });
    expect(paused.status.state).toBe(INITIAL_SYNC_STATES.PAUSED);
    expect(paused.status.reasonCode).toBe(INITIAL_SYNC_REASONS.GLOBAL_PAUSE_ACTIVE);

    const blockedResume = await resumeInitialSync({ orgId: ORG.id });
    expect(blockedResume.code).toBe(INITIAL_SYNC_REASONS.GLOBAL_PAUSE_ACTIVE);

    mockStore.set('pilotPause', { paused: false, pausedAt: null, pausedBy: null, reasonCode: null });
    const resumed = await resumeInitialSync({ orgId: ORG.id });
    expect(resumed.success).toBe(true);
  });

  test.each([
    ['remoteUrl', 'https://different-target.example'],
    ['remoteProjectKey', 'OTHER']
  ])('fails closed before writes when the approved %s changes', async (field, value) => {
    searchIssues = [issue('LOCAL-1')];
    const preview = await makePreview();
    const started = await startFromPreview(preview);
    createRemoteIssue.mockClear();
    mockQueuePush.mockClear();

    mockStore.set('organizations', [{ ...ORG, [field]: value }]);
    const result = await processInitialSyncJob({
      orgId: ORG.id,
      jobId: started.job.jobId,
      maxItems: 1
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe(INITIAL_SYNC_REASONS.TARGET_CONFIGURATION_CHANGED);
    expect(createRemoteIssue).not.toHaveBeenCalled();
    const status = await getInitialSyncStatus({ orgId: ORG.id });
    expect(status.status.state).toBe(INITIAL_SYNC_STATES.FAILED);
    expect(status.status.reasonCode).toBe(INITIAL_SYNC_REASONS.TARGET_CONFIGURATION_CHANGED);
    expect(status.status.progress.processed).toBe(0);
  });

  test('fails closed with a safe reason when a persisted batch is missing', async () => {
    searchIssues = [issue('LOCAL-1')];
    const preview = await makePreview();
    const started = await startFromPreview(preview);
    const batchKey = Array.from(mockStore.keys()).find(key => key.startsWith('initialSyncBatch:'));
    expect(batchKey).toBeTruthy();
    mockStore.delete(batchKey);

    const result = await processInitialSyncJob({
      orgId: ORG.id,
      jobId: started.job.jobId,
      maxItems: 1
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe(INITIAL_SYNC_REASONS.JOB_BATCH_MISSING);
    const status = await getInitialSyncStatus({ orgId: ORG.id });
    expect(status.status.state).toBe(INITIAL_SYNC_STATES.FAILED);
    expect(status.status.reasonCode).toBe(INITIAL_SYNC_REASONS.JOB_BATCH_MISSING);
  });

  test('recovery requeues only stale running jobs without resetting progress', async () => {
    searchIssues = [issue('LOCAL-1')];
    const preview = await makePreview();
    const started = await startFromPreview(preview);
    const jobKey = buildInitialSyncJobKey(ORG.id);
    const job = mockStore.get(jobKey);
    mockStore.set(jobKey, {
      ...job,
      updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
    });
    mockQueuePush.mockClear();

    const recovered = await recoverInitialSyncJobs();
    expect(recovered).toEqual({ success: true, recovered: 1 });
    expect(mockQueuePush).toHaveBeenCalledWith({
      body: { type: 'initial-sync', orgId: ORG.id, jobId: started.job.jobId }
    });
    expect(mockStore.get(jobKey).progress.processed).toBe(0);
  });

  test('mapping conflicts are never sent to the create path', async () => {
    searchIssues = [issue('LOCAL-1'), issue('LOCAL-2')];
    getRemoteKey.mockImplementation(async key => (key === 'LOCAL-2' ? 'REMOTE-2' : null));
    getLocalKey.mockImplementation(async key => (key === 'REMOTE-2' ? 'DIFFERENT-LOCAL' : null));
    const preview = await makePreview();
    expect(preview.counts.mappingConflicts).toBe(1);
    const started = await startFromPreview(preview);
    await processInitialSyncJob({ orgId: ORG.id, jobId: started.job.jobId, maxItems: 2 });
    expect(createRemoteIssue).toHaveBeenCalledTimes(1);
    expect(createRemoteIssue.mock.calls[0][0].key).toBe('LOCAL-1');
  });

  test('job records, batches and queue payloads contain no issue content', async () => {
    searchIssues = [issue('LOCAL-1'), issue('LOCAL-2')];
    const preview = await makePreview();
    const started = await startFromPreview(preview);
    await processInitialSyncJob({ orgId: ORG.id, jobId: started.job.jobId, maxItems: 2 });

    const persisted = JSON.stringify(Array.from(mockStore.values()));
    const queued = JSON.stringify(mockQueuePush.mock.calls);
    expect(persisted).not.toContain(SECRET_SUMMARY);
    expect(queued).not.toContain(SECRET_SUMMARY);
    expect(persisted).not.toContain('PRIVATE_ISSUE_CONTENT_DO_NOT_STORE_LOCAL-1');
  });
});
