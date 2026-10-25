/**
 * Read-only create-ledger lookup used by the Recovery tab.
 *
 * The real resolver implementations, the real authorization wrapper and the
 * real create-ledger helpers run against in-memory storage. Jira transport is
 * mocked so any accidental outbound request fails the test.
 */
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
    route: (strings, ...values) =>
      strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
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
  getAllRemoteKeys: jest.fn(async () => []),
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

jest.mock('../src/services/sync/issue-sync.js', () => ({
  createIssueForOrg: jest.fn(),
  updateIssueForOrg: jest.fn()
}));

jest.mock('../src/services/sync/transition-sync.js', () => ({
  transitionLocalIssue: jest.fn(async () => false),
  transitionRemoteIssue: jest.fn(async () => false)
}));

import api, { fetch } from '@forge/api';
import * as kvsStore from '../src/services/storage/kvs.js';
import { defineDataResolvers } from '../src/resolvers/data.js';
import { getRemoteKey, getLocalKey, storeMapping } from '../src/services/storage/mappings.js';
import { getFullIssue } from '../src/services/jira/local-client.js';
import { logAuditEntry } from '../src/services/storage/stats.js';
import { RESOLVER_POLICIES } from '../src/resolvers/authorization-policy.js';
import { createAuthorizedHandler } from '../src/resolvers/authorization.js';
import {
  beginIssueCreateOperation,
  markIssueCreateSubmissionStarted,
  markIssueCreateUnknown,
  markIssueCreateFailedDefinitive,
  buildIssueCreateOperationKey,
  resolveIssueCreateOperation,
  ISSUE_CREATE_DIRECTIONS,
  ISSUE_CREATE_STATES
} from '../src/services/sync/issue-create-operation.js';

const mockFetch = fetch;
const mockRequestJira = api.asApp().requestJira;

const LOOKUP = 'getIssueCreateOperationStatus';
const ORG = {
  id: 'org-1',
  name: 'Target Org',
  remoteUrl: 'https://remote.example',
  remoteEmail: 'sync@example.com',
  remoteProjectKey: 'REMOTE',
  allowedProjects: ['LOCAL'],
  syncDirection: 'bidirectional'
};

function defineResolvers() {
  const definitions = {};
  defineDataResolvers({ define: (name, fn) => { definitions[name] = fn; } });
  return definitions;
}

function seedOrg() {
  mockStore.set('organizations', [ORG]);
  mockStore.set('projectMappings:org-1', { LOCAL: 'REMOTE' });
  mockSecretStore.set('secret:org-1:token', 'remote-token');
}

function operationKey(direction = ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE, sourceKey = 'LOCAL-1') {
  return buildIssueCreateOperationKey({ orgId: 'org-1', direction, sourceKey });
}

async function seedOperation({ direction = ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE, sourceKey = 'LOCAL-1' } = {}) {
  const claim = await beginIssueCreateOperation({ orgId: 'org-1', direction, sourceKey });
  await markIssueCreateSubmissionStarted(claim.operation);
  await markIssueCreateUnknown(claim.operation);
  return claim.operation;
}

async function seedSucceeded({ targetKey = 'REMOTE-9' } = {}) {
  const operation = await seedOperation();
  await resolveIssueCreateOperation({ operation, targetKey });
  return operation;
}

const lookup = (payload = {}) => defineResolvers()[LOOKUP]({
  payload: {
    orgId: 'org-1',
    direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
    sourceKey: 'LOCAL-1',
    ...payload
  }
});

const authorizedLookup = async (checkPermission = async () => true) => {
  const handler = createAuthorizedHandler(LOOKUP, defineResolvers()[LOOKUP], { checkPermission });
  return handler({ context: { accountId: 'account-1' }, payload: {
    orgId: 'org-1',
    direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
    sourceKey: 'LOCAL-1'
  } });
};

beforeEach(() => {
  mockStore.clear();
  mockSecretStore.clear();
  jest.clearAllMocks();
  mockFetch.mockReset();
  mockRequestJira.mockReset();
  getFullIssue.mockResolvedValue({
    key: 'LOCAL-1',
    fields: { project: { key: 'LOCAL' }, summary: 'Source issue', issuetype: { name: 'Task' } }
  });
  getRemoteKey.mockResolvedValue(null);
  getLocalKey.mockResolvedValue(null);
  seedOrg();
});


describe('create-ledger lookup authorization', () => {
  test('is classified as an administrator read and records no write audit', async () => {
    expect(RESOLVER_POLICIES[LOOKUP]).toBe('ADMIN_READ');
    await seedOperation();

    const result = await authorizedLookup();

    expect(result).toEqual(expect.objectContaining({ success: true, exists: true }));
    expect(logAuditEntry).not.toHaveBeenCalled();
  });

  test('denies a caller without an authenticated administrator context', async () => {
    await seedOperation();
    jest.clearAllMocks();
    const handler = createAuthorizedHandler(LOOKUP, defineResolvers()[LOOKUP], {
      checkPermission: async () => true
    });

    const result = await handler({ payload: { orgId: 'org-1' } });

    expect(result).toEqual({
      success: false,
      code: 'FORBIDDEN',
      error: 'Jira administrator permission required'
    });
    expect(kvsStore.get).not.toHaveBeenCalled();
  });

  test('denies a caller without the Jira administrator permission', async () => {
    await seedOperation();
    jest.clearAllMocks();

    const result = await authorizedLookup(async () => false);

    expect(result).toEqual(expect.objectContaining({ success: false, code: 'FORBIDDEN' }));
    expect(kvsStore.get).not.toHaveBeenCalled();
  });

  test('fails closed when the permission check throws', async () => {
    await seedOperation();
    jest.clearAllMocks();

    const result = await authorizedLookup(async () => { throw new Error('transport down'); });

    expect(result).toEqual(expect.objectContaining({ success: false, code: 'FORBIDDEN' }));
    expect(kvsStore.get).not.toHaveBeenCalled();
  });
});

describe('create-ledger lookup validity', () => {
  test.each([
    [{ orgId: '' }],
    [{ orgId: undefined }],
    [{ direction: 'sideways' }],
    [{ sourceKey: 'not a key' }],
    [{ sourceKey: undefined }]
  ])('rejects invalid lookup input %p', async payload => {
    const result = await lookup(payload);

    expect(result).toEqual(expect.objectContaining({
      success: false,
      code: 'INVALID_CREATE_LOOKUP_REQUEST'
    }));
    expect(kvsStore.get).not.toHaveBeenCalled();
  });

  test('reports an unknown organization without reading a ledger', async () => {
    const result = await lookup({ orgId: 'org-missing' });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      code: 'ORGANIZATION_NOT_FOUND'
    }));
    expect(kvsStore.get).not.toHaveBeenCalledWith(
      expect.stringContaining('issue-create-op:')
    );
  });
});


describe('create-ledger lookup results', () => {
  test('reports an unknown create outcome as reconcilable', async () => {
    await seedOperation();

    const result = await lookup();

    expect(result).toEqual(expect.objectContaining({
      success: true,
      exists: true,
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1'
    }));
    expect(result.operation).toEqual(expect.objectContaining({
      state: ISSUE_CREATE_STATES.UNKNOWN,
      submissionStarted: false,
      targetKey: null
    }));
    expect(result.operation.unknownAt).toEqual(expect.any(String));
    expect(result.mapping).toEqual({ sourceMappedKey: null });
    expect(result.reconciliation).toEqual({
      applicable: true,
      reason: 'CREATE_RECONCILIATION_REQUIRED',
      requiresExplicitTarget: true,
      recordedTargetKey: null
    });
  });

  test('reports a successful create with a missing mapping as reconcilable', async () => {
    await seedSucceeded({ targetKey: 'REMOTE-9' });

    const result = await lookup();

    expect(result.operation).toEqual(expect.objectContaining({
      state: ISSUE_CREATE_STATES.SUCCEEDED,
      targetKey: 'REMOTE-9'
    }));
    expect(result.mapping).toEqual({ sourceMappedKey: null });
    expect(result.reconciliation).toEqual({
      applicable: true,
      reason: 'CREATE_SUCCEEDED_MAPPING_MISSING',
      requiresExplicitTarget: true,
      recordedTargetKey: 'REMOTE-9'
    });
  });

  test('reports an already reconciled create as not reconcilable', async () => {
    await seedSucceeded({ targetKey: 'REMOTE-9' });
    getRemoteKey.mockResolvedValue('REMOTE-9');

    const result = await lookup();

    expect(result.mapping).toEqual({ sourceMappedKey: 'REMOTE-9' });
    expect(result.reconciliation).toEqual({
      applicable: false,
      reason: 'CREATE_ALREADY_RECONCILED',
      requiresExplicitTarget: true,
      recordedTargetKey: 'REMOTE-9'
    });
  });

  test('reports a pending attempt as still owned by the ledger', async () => {
    await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1'
    });

    const result = await lookup();

    expect(result.operation).toEqual(expect.objectContaining({
      state: ISSUE_CREATE_STATES.PENDING,
      submissionStarted: false
    }));
    expect(result.reconciliation).toEqual(expect.objectContaining({
      applicable: false,
      reason: 'CREATE_IN_PROGRESS'
    }));
  });

  test('reports a definitive rejection as retryable rather than reconcilable', async () => {
    const claim = await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1'
    });
    await markIssueCreateFailedDefinitive(claim.operation);

    const result = await lookup();

    expect(result.operation).toEqual(expect.objectContaining({
      state: ISSUE_CREATE_STATES.FAILED_DEFINITIVE,
      failureReason: 'JIRA_REJECTED'
    }));
    expect(result.reconciliation).toEqual(expect.objectContaining({
      applicable: false,
      reason: 'CREATE_RETRY_ALLOWED'
    }));
  });

  test('reports a missing ledger without offering reconciliation', async () => {
    const result = await lookup();

    expect(result).toEqual(expect.objectContaining({ success: true, exists: false }));
    expect(result.operation).toBeNull();
    expect(result.mapping).toEqual({ sourceMappedKey: null });
    expect(result.reconciliation).toEqual({
      applicable: false,
      reason: 'CREATE_OPERATION_NOT_FOUND',
      requiresExplicitTarget: true,
      recordedTargetKey: null
    });
    expect(mockStore.has(operationKey())).toBe(false);
  });

  test('reads the mapping in the direction of the create', async () => {
    await seedOperation({
      direction: ISSUE_CREATE_DIRECTIONS.REMOTE_TO_LOCAL,
      sourceKey: 'REMOTE-1'
    });
    getLocalKey.mockResolvedValue('LOCAL-9');

    const result = await lookup({
      direction: ISSUE_CREATE_DIRECTIONS.REMOTE_TO_LOCAL,
      sourceKey: 'REMOTE-1'
    });

    expect(getLocalKey).toHaveBeenCalledWith('REMOTE-1', 'org-1');
    expect(getRemoteKey).not.toHaveBeenCalled();
    expect(result.mapping).toEqual({ sourceMappedKey: 'LOCAL-9' });
    expect(result.reconciliation.reason).toBe('CREATE_RECONCILIATION_REQUIRED');
  });
});


describe('create-ledger lookup is strictly read-only', () => {
  test('performs no storage write, no mapping write and no Jira request', async () => {
    await seedOperation();
    const before = new Map(mockStore);
    jest.clearAllMocks();

    const result = await lookup();

    expect(result.success).toBe(true);
    expect(mockStore).toEqual(before);
    expect(kvsStore.set).not.toHaveBeenCalled();
    expect(kvsStore.createIfNotExists).not.toHaveBeenCalled();
    expect(kvsStore.setIfNotExists).not.toHaveBeenCalled();
    expect(kvsStore.del).not.toHaveBeenCalled();
    expect(storeMapping).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockRequestJira).not.toHaveBeenCalled();
  });

  test('never returns attempt tokens or internal ledger fields', async () => {
    const operation = await seedOperation();

    const result = await lookup();

    expect(JSON.stringify(result)).not.toContain(operation.attemptToken);
    expect(result).not.toHaveProperty('attemptToken');
    expect(result.operation).not.toHaveProperty('attemptToken');
    expect(result.operation).not.toHaveProperty('operationKey');
    expect(result.operation).not.toHaveProperty('operationId');
  });
});

describe('reconciliation remains server-enforced', () => {
  test('still requires an explicit destination key', async () => {
    await seedOperation();

    const result = await defineResolvers().reconcileIssueCreate({
      payload: {
        orgId: 'org-1',
        direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
        sourceKey: 'LOCAL-1'
      }
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      code: 'INVALID_RECONCILIATION_REQUEST'
    }));
    expect(storeMapping).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('rejects a destination already mapped to another source without any write', async () => {
    await seedOperation();
    getLocalKey.mockResolvedValue('LOCAL-OTHER');
    const before = new Map(mockStore);

    const result = await defineResolvers().reconcileIssueCreate({
      payload: {
        orgId: 'org-1',
        direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
        sourceKey: 'LOCAL-1',
        jiraIssueKey: 'REMOTE-9'
      }
    });

    expect(result).toEqual(expect.objectContaining({ success: false, code: 'MAPPING_CONFLICT' }));
    expect(storeMapping).not.toHaveBeenCalled();
    expect(mockStore).toEqual(before);
    expect(mockRequestJira).not.toHaveBeenCalled();
  });

  test('a repaired mapping is reported as already reconciled by the next lookup', async () => {
    await seedOperation();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ fields: { project: { key: 'REMOTE' } } })
    });

    const reconciled = await defineResolvers().reconcileIssueCreate({
      payload: {
        orgId: 'org-1',
        direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
        sourceKey: 'LOCAL-1',
        jiraIssueKey: 'REMOTE-9'
      }
    });

    expect(reconciled.success).toBe(true);
    expect(storeMapping).toHaveBeenCalledWith('LOCAL-1', 'REMOTE-9', 'org-1');

    getRemoteKey.mockResolvedValue('REMOTE-9');
    const after = await lookup();

    expect(after.exists).toBe(true);
    expect(after.operation).toEqual(expect.objectContaining({
      state: ISSUE_CREATE_STATES.SUCCEEDED,
      targetKey: 'REMOTE-9'
    }));
    expect(after.reconciliation).toEqual(expect.objectContaining({
      applicable: false,
      reason: 'CREATE_ALREADY_RECONCILED'
    }));
  });
});

