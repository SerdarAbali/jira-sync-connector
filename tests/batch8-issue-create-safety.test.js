// The synchronization authorization gate has its own suite; this suite tests another behaviour.
jest.mock('../src/services/sync/sync-authorization.js', () => require('./helpers/authorized-sync-authorization.js'));
// Witness enforcement has its own suites; this suite tests the create ledger.
jest.mock('../src/services/sync/pair-witness-guard.js', () => require('./helpers/pair-witness-create-mocks.js').guardModule);
jest.mock('../src/services/sync/pair-witness-establishment.js', () => require('./helpers/pair-witness-create-mocks.js').establishmentModule);

const mockStore = new Map();
const mockSecretStore = new Map();

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  const fetchMock = jest.fn();
  return {
    __esModule: true,
    default: {
      asApp: () => ({ requestJira }),
      asUser: () => ({ requestJira })
    },
    route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch: fetchMock
  };
});

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(async key => (mockStore.has(key) ? mockStore.get(key) : null)),
  set: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  del: jest.fn(async key => { mockStore.delete(key); }),
  createIfNotExists: jest.fn(async (key, value) => {
    if (mockStore.has(key)) {
      const error = new Error('key already exists');
      error.code = 'KEY_ALREADY_EXISTS';
      throw error;
    }
    mockStore.set(key, value);
  }),
  setIfNotExists: jest.fn(async (key, value) => {
    if (mockStore.has(key)) {
      const error = new Error('key already exists');
      error.code = 'KEY_ALREADY_EXISTS';
      throw error;
    }
    mockStore.set(key, value);
  }),
  setWithTtl: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  getSecret: jest.fn(async key => (mockSecretStore.has(key) ? mockSecretStore.get(key) : null)),
  setSecret: jest.fn(async (key, value) => { mockSecretStore.set(key, value); })
}));

jest.mock('../src/services/storage/mappings.js', () => ({
  getRemoteKey: jest.fn(async () => null),
  getLocalKey: jest.fn(async () => null),
  storeMapping: jest.fn(async () => ({ idempotent: false })),
  ensureMappingPair: jest.fn(),
  getOrganizationsWithTokens: jest.fn(async () => []),
  setLastSyncedLocalUpdated: jest.fn(),
  storeAttachmentMapping: jest.fn(),
  removeAttachmentMapping: jest.fn(),
  getAttachmentMapping: jest.fn(async () => null),
  storeLinkMapping: jest.fn(),
  removeLinkMapping: jest.fn(),
  getLinkMapping: jest.fn(async () => null),
  getLocalCommentId: jest.fn(),
  getRemoteCommentId: jest.fn(async () => null),
  storeCommentMapping: jest.fn()
}));

jest.mock('../src/services/storage/flags.js', () => ({
  markSyncing: jest.fn(),
  clearSyncFlag: jest.fn(),
  isSyncing: jest.fn(async () => false),
  findPendingLinksToIssue: jest.fn(async () => []),
  removePendingLink: jest.fn(),
  storePendingLink: jest.fn(),
  enqueuePendingChildIssue: jest.fn(),
  consumePendingChildIssues: jest.fn(async () => [])
}));

jest.mock('../src/services/storage/stats.js', () => ({
  logAuditEntry: jest.fn(async () => undefined),
  trackWebhookSync: jest.fn(async () => undefined),
  trackApiCall: jest.fn()
}));

jest.mock('../src/services/storage/rejected-fields.js', () => ({
  recordRejectedFields: jest.fn(async () => undefined),
  getRejectedFields: jest.fn(async () => []),
  clearRejectedField: jest.fn()
}));

jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn(),
  getFullComment: jest.fn(),
  getOrgName: jest.fn(async () => 'Local Org'),
  updateLocalIssueDescription: jest.fn(),
  uploadAttachment: jest.fn(),
  downloadAttachment: jest.fn(async () => Buffer.from('file'))
}));

jest.mock('../src/services/jira/remote-client.js', () => ({
  getRemoteIssue: jest.fn(),
  getRemoteComment: jest.fn(),
  uploadAttachment: jest.fn(),
  downloadRemoteAttachment: jest.fn(),
  getRemoteIssueAttachments: jest.fn(async () => [])
}));

jest.mock('../src/services/sync/attachment-sync.js', () => ({
  syncAttachments: jest.fn(async () => ({}))
}));

jest.mock('../src/services/sync/transition-sync.js', () => ({
  transitionRemoteIssue: jest.fn(async () => false),
  transitionLocalIssue: jest.fn(async () => false)
}));

import { fetch } from '@forge/api';
import { createRemoteIssue } from '../src/services/sync/issue-sync.js';
import {
  beginIssueCreateOperation,
  getIssueCreateOperation,
  markIssueCreateFailedDefinitive,
  markIssueCreateSubmissionStarted,
  markIssueCreateSucceeded,
  markIssueCreateUnknown,
  buildIssueCreateOperationKey,
  ISSUE_CREATE_CODES,
  ISSUE_CREATE_DIRECTIONS,
  ISSUE_CREATE_STATES
} from '../src/services/sync/issue-create-operation.js';
import { storeMapping } from '../src/services/storage/mappings.js';
import { logAuditEntry } from '../src/services/storage/stats.js';
import { getRemoteIssue } from '../src/services/jira/remote-client.js';

const mockFetch = fetch;

const ORG = {
  id: 'org-1',
  name: 'Target Org',
  remoteUrl: 'https://remote.example',
  remoteEmail: 'sync@example.com',
  remoteApiToken: 'remote-token',
  remoteProjectKey: 'REMOTE',
  allowedProjects: ['LOCAL']
};

const MAPPINGS = {
  userMappings: {},
  fieldMappings: {},
  statusMappings: {},
  issueTypeMappings: {},
  projectMappings: {}
};

function localIssue(key = 'LOCAL-1') {
  return {
    key,
    fields: {
      project: { key: 'LOCAL' },
      summary: 'Test issue',
      description: null,
      issuetype: { name: 'Task', id: '1' },
      status: { name: 'To Do' },
      updated: '2026-10-22T10:00:00.000Z',
      labels: [],
      attachment: [],
      issuelinks: []
    }
  };
}

function createOptions() {
  return { syncAttachments: true, syncLinks: false, syncComments: false, syncCrossReference: false };
}

function operationKey(sourceKey = 'LOCAL-1') {
  return buildIssueCreateOperationKey({
    orgId: 'org-1',
    direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
    sourceKey
  });
}

beforeEach(() => {
  mockStore.clear();
  mockSecretStore.clear();
  mockStore.set('organizations', [ORG]);
  require('../src/services/jira/local-client.js').getFullIssue.mockImplementation(async key => localIssue(key));
  jest.clearAllMocks();
  mockFetch.mockReset();
  getRemoteIssue.mockResolvedValue({
    key: 'REMOTE-9',
    fields: {
      summary: 'Test issue',
      description: null,
      issuetype: { name: 'Task' },
      status: { name: 'To Do' },
      updated: '2026-10-22T10:00:01.000Z',
      labels: []
    }
  });
});


describe('Batch 8 issue-create operation ledger', () => {
  test('concurrent callers can atomically claim only one create operation', async () => {
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => beginIssueCreateOperation({
        orgId: 'org-1',
        direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
        sourceKey: 'LOCAL-1'
      }))
    );

    const allowed = claims.filter(claim => claim.allowed);
    expect(allowed).toHaveLength(1);
    expect(claims.filter(claim => claim.code === ISSUE_CREATE_CODES.IN_PROGRESS)).toHaveLength(7);
    expect(mockStore.get(operationKey()).operationId).toBe(allowed[0].operation.operationId);
  });

  test('a submitted create with an unknown outcome is never retried automatically', async () => {
    const first = await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1'
    });
    await markIssueCreateSubmissionStarted(first.operation);
    await markIssueCreateUnknown(first.operation);

    const second = await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1',
      now: Date.now() + 24 * 60 * 60 * 1000
    });

    expect(second.allowed).toBe(false);
    expect(second.code).toBe(ISSUE_CREATE_CODES.RECONCILIATION_REQUIRED);
    expect(mockStore.get(operationKey()).state).toBe(ISSUE_CREATE_STATES.UNKNOWN);
  });

  test('a failed-definitive create may be retried exactly once at a time', async () => {
    const first = await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1'
    });
    await markIssueCreateFailedDefinitive(first.operation);

    const retry = await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1'
    });
    const concurrentRetry = await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1'
    });

    expect(retry.allowed).toBe(true);
    expect(retry.code).toBe(ISSUE_CREATE_CODES.RETRY_ALLOWED);
    expect(retry.operation.attempt).toBe(2);
    expect(concurrentRetry.allowed).toBe(false);
    expect(concurrentRetry.code).toBe(ISSUE_CREATE_CODES.IN_PROGRESS);
  });

  test('a successful create stores the mapping and resolves the ledger to succeeded', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ key: 'REMOTE-9' })
    });

    const result = await createRemoteIssue(localIssue(), ORG, MAPPINGS, null, createOptions());

    expect(result).toEqual(expect.objectContaining({ key: 'REMOTE-9' }));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/rest/api/3/issue?notifyUsers=false'),
      expect.objectContaining({ method: 'POST' })
    );
    expect(storeMapping).toHaveBeenCalledWith('LOCAL-1', 'REMOTE-9', 'org-1');
    expect(mockStore.get(operationKey())).toEqual(expect.objectContaining({
      state: ISSUE_CREATE_STATES.SUCCEEDED,
      targetKey: 'REMOTE-9'
    }));
  });

  test('a second create after an unknown HTTP outcome performs no request and no mapping write', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'upstream unavailable'
    });

    const first = await createRemoteIssue(localIssue(), ORG, MAPPINGS, null, createOptions());
    const second = await createRemoteIssue(localIssue(), ORG, MAPPINGS, null, createOptions());

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(storeMapping).not.toHaveBeenCalled();
    expect(mockStore.get(operationKey()).state).toBe(ISSUE_CREATE_STATES.UNKNOWN);

    const retry = await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1',
      now: Date.now() + 24 * 60 * 60 * 1000
    });
    expect(retry.allowed).toBe(false);
    expect(retry.code).toBe(ISSUE_CREATE_CODES.RECONCILIATION_REQUIRED);
  });

  test('a deterministic 400 is definitive and retryable, not described as before submission', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'invalid payload'
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ key: 'REMOTE-9' })
      });

    const first = await createRemoteIssue(localIssue(), ORG, MAPPINGS, null, createOptions());
    expect(first).toBeNull();
    const afterFirst = mockStore.get(operationKey());
    const firstAttemptToken = afterFirst.attemptToken;
    expect(afterFirst.state).toBe(ISSUE_CREATE_STATES.FAILED_DEFINITIVE);
    expect(afterFirst.failureReason).toBe('JIRA_HTTP_REJECTED');
    expect(afterFirst.submissionStartedAt).toBeTruthy();

    const retry = await createRemoteIssue(localIssue(), ORG, MAPPINGS, null, createOptions());

    expect(retry).toEqual(expect.objectContaining({ key: 'REMOTE-9' }));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(storeMapping).toHaveBeenCalledWith('LOCAL-1', 'REMOTE-9', 'org-1');
    const afterRetry = mockStore.get(operationKey());
    expect(afterRetry).toEqual(expect.objectContaining({
      state: ISSUE_CREATE_STATES.SUCCEEDED,
      attempt: 2
    }));
    expect(afterRetry.attemptToken).not.toBe(firstAttemptToken);
  });

  test('a create HTTP 429 is recorded as unknown rather than retryable', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'rate limited'
    });

    const first = await createRemoteIssue(localIssue(), ORG, MAPPINGS, null, createOptions());

    expect(first).toBeNull();
    expect(mockStore.get(operationKey()).state).toBe(ISSUE_CREATE_STATES.UNKNOWN);

    const retry = await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1',
      now: Date.now() + 24 * 60 * 60 * 1000
    });
    expect(retry.allowed).toBe(false);
    expect(retry.code).toBe(ISSUE_CREATE_CODES.RECONCILIATION_REQUIRED);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('every create attempt receives a new cryptographically random attempt token', async () => {
    const first = await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1'
    });
    expect(first.operation.attemptToken).toMatch(/^[0-9a-f]{64}$/);

    await markIssueCreateFailedDefinitive(first.operation);
    const second = await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1'
    });
    expect(second.operation.attemptToken).toMatch(/^[0-9a-f]{64}$/);
    expect(second.operation.attemptToken).not.toBe(first.operation.attemptToken);

    await markIssueCreateFailedDefinitive(second.operation);
    const third = await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1'
    });
    expect(third.operation.attemptToken).toMatch(/^[0-9a-f]{64}$/);
    expect(third.operation.attemptToken).not.toBe(second.operation.attemptToken);
    expect(mockStore.get(operationKey()).attemptToken).toBe(third.operation.attemptToken);
  });

  test('a stale attempt cannot mark a newer attempt unknown', async () => {
    const first = await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1'
    });
    await markIssueCreateFailedDefinitive(first.operation);
    const retry = await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1'
    });

    const stale = await markIssueCreateUnknown(first.operation);

    expect(stale).toEqual(expect.objectContaining({
      success: false,
      code: ISSUE_CREATE_CODES.STALE_ATTEMPT
    }));
    expect(mockStore.get(operationKey())).toEqual(expect.objectContaining({
      state: ISSUE_CREATE_STATES.PENDING,
      attempt: 2,
      attemptToken: retry.operation.attemptToken
    }));
    expect(mockStore.get(operationKey()).submissionStartedAt).toBeUndefined();
  });

  test('a stale attempt cannot mark a newer attempt succeeded', async () => {
    const first = await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1'
    });
    await markIssueCreateFailedDefinitive(first.operation);
    const retry = await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1'
    });

    const stale = await markIssueCreateSucceeded({
      operation: first.operation,
      targetKey: 'REMOTE-STALE'
    });

    expect(stale).toEqual(expect.objectContaining({
      success: false,
      code: ISSUE_CREATE_CODES.STALE_ATTEMPT
    }));
    expect(mockStore.get(operationKey())).toEqual(expect.objectContaining({
      state: ISSUE_CREATE_STATES.PENDING,
      attempt: 2,
      attemptToken: retry.operation.attemptToken
    }));
    expect(mockStore.get(operationKey()).targetKey).toBeUndefined();
    expect(storeMapping).not.toHaveBeenCalled();
  });

  test('a stale attempt cannot mark a newer attempt failed', async () => {
    const first = await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1'
    });
    await markIssueCreateFailedDefinitive(first.operation);
    const retry = await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1'
    });

    const stale = await markIssueCreateFailedDefinitive(first.operation, {
      reasonCode: 'STALE_FAILURE'
    });

    expect(stale).toEqual(expect.objectContaining({
      success: false,
      code: ISSUE_CREATE_CODES.STALE_ATTEMPT
    }));
    expect(mockStore.get(operationKey())).toEqual(expect.objectContaining({
      state: ISSUE_CREATE_STATES.PENDING,
      attempt: 2,
      attemptToken: retry.operation.attemptToken
    }));
    expect(mockStore.get(operationKey()).failureReason).toBeUndefined();
  });

  test('only the current attempt can record submission', async () => {
    const first = await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1'
    });
    await markIssueCreateFailedDefinitive(first.operation);
    const retry = await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1'
    });

    const staleSubmission = await markIssueCreateSubmissionStarted(first.operation);
    expect(staleSubmission).toEqual(expect.objectContaining({
      ok: false,
      code: ISSUE_CREATE_CODES.STALE_ATTEMPT
    }));
    expect(mockStore.get(operationKey()).submissionStartedAt).toBeUndefined();

    const currentSubmission = await markIssueCreateSubmissionStarted(retry.operation);
    expect(currentSubmission.ok).toBe(true);
    expect(mockStore.get(operationKey()).submissionStartedAt).toBeTruthy();
    expect(mockStore.get(operationKey()).attemptToken).toBe(retry.operation.attemptToken);
  });

  test('a network exception remains unknown and requires reconciliation', async () => {
    mockFetch.mockRejectedValueOnce(new Error('socket hang up'));

    const first = await createRemoteIssue(localIssue(), ORG, MAPPINGS, null, createOptions());
    expect(first).toBeNull();
    expect(mockStore.get(operationKey()).state).toBe(ISSUE_CREATE_STATES.UNKNOWN);

    const retry = await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1',
      now: Date.now() + 24 * 60 * 60 * 1000
    });
    expect(retry.allowed).toBe(false);
    expect(retry.code).toBe(ISSUE_CREATE_CODES.RECONCILIATION_REQUIRED);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('a malformed success response remains unknown and requires reconciliation', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({})
    });

    const first = await createRemoteIssue(localIssue(), ORG, MAPPINGS, null, createOptions());
    expect(first).toBeNull();
    expect(mockStore.get(operationKey()).state).toBe(ISSUE_CREATE_STATES.UNKNOWN);
    expect(storeMapping).not.toHaveBeenCalled();

    const retry = await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1',
      now: Date.now() + 24 * 60 * 60 * 1000
    });
    expect(retry.allowed).toBe(false);
    expect(retry.code).toBe(ISSUE_CREATE_CODES.RECONCILIATION_REQUIRED);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('attempt tokens are absent from public status, logs, and audit records', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logAuditEntry.mockClear();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ key: 'REMOTE-9' })
    });

    try {
      await createRemoteIssue(localIssue(), ORG, MAPPINGS, null, createOptions());
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }

    const stored = mockStore.get(operationKey());
    expect(stored.attemptToken).toMatch(/^[0-9a-f]{64}$/);
    const status = await getIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1'
    });
    expect(status).not.toHaveProperty('attemptToken');
    expect(JSON.stringify(status)).not.toContain(stored.attemptToken);

    const publicOutput = JSON.stringify({
      logs: [
        ...logSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls
      ],
      audit: logAuditEntry.mock.calls
    });
    expect(publicOutput).not.toContain(stored.attemptToken);
  });


});

