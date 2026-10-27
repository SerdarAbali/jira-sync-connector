jest.mock('../src/services/sync/sync-authorization.js', () => require('./helpers/authorized-sync-authorization.js'));
jest.mock('../src/services/sync/pair-witness-guard.js', () => require('./helpers/pair-witness-create-mocks.js').guardModule);
jest.mock('../src/services/sync/pair-witness-establishment.js', () => ({
  WITNESS_ESTABLISHMENT_OUTCOMES: {
    APPLIED: 'witness-established',
    MAPPING_PERSISTENCE_FAILED: 'witness-skipped-mapping-failure',
    LEDGER_PERSISTENCE_FAILED: 'witness-skipped-ledger-failure',
    FAILED: 'witness-establishment-failed'
  },
  establishPairWitness: jest.fn(async () => ({ success: true, outcome: 'witness-established' })),
  recordWitnessPersistenceFailure: jest.fn(async () => ({ success: false }))
}));

// Only the final ledger resolution is forced to fail; the claim, submission and
// mapping paths remain the production implementations.
jest.mock('../src/services/sync/issue-create-operation.js', () => {
  const actual = jest.requireActual('../src/services/sync/issue-create-operation.js');
  return {
    ...actual,
    markIssueCreateSucceeded: jest.fn(async () => ({
      success: false,
      code: 'CREATE_TARGET_MISMATCH'
    }))
  };
});

const mockStore = new Map();

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  const fetchMock = jest.fn();
  return {
    __esModule: true,
    default: { asApp: () => ({ requestJira }), asUser: () => ({ requestJira }) },
    route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch: fetchMock
  };
});

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(async key => (mockStore.has(key) ? mockStore.get(key) : null)),
  set: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  del: jest.fn(async key => { mockStore.delete(key); }),
  createIfNotExists: jest.fn(async (key, value) => {
    if (mockStore.has(key)) throw Object.assign(new Error('exists'), { code: 'KEY_ALREADY_EXISTS' });
    mockStore.set(key, value);
  }),
  setIfNotExists: jest.fn(async (key, value) => {
    if (mockStore.has(key)) throw Object.assign(new Error('exists'), { code: 'KEY_ALREADY_EXISTS' });
    mockStore.set(key, value);
  }),
  setWithTtl: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  getSecret: jest.fn(async () => 'remote-token'),
  setSecret: jest.fn()
}));

jest.mock('../src/services/storage/mappings.js', () => {
  const actual = jest.requireActual('../src/services/storage/mappings.js');
  return {
    isValidIssueKey: actual.isValidIssueKey,
    MappingConflictError: actual.MappingConflictError,
    getRemoteKey: jest.fn(async () => null),
    getLocalKey: jest.fn(async () => null),
    storeMapping: jest.fn(async () => ({ idempotent: false })),
    replaceIssueMapping: jest.fn(async () => ({ success: true })),
    ensureMappingPair: jest.fn(),
    getOrganizationsWithTokens: jest.fn(async () => []),
    setLastSyncedLocalUpdated: jest.fn(),
    getLastSyncedLocalUpdated: jest.fn(async () => null),
    storeAttachmentMapping: jest.fn(),
    removeAttachmentMapping: jest.fn(),
    getAttachmentMapping: jest.fn(async () => null),
    storeLinkMapping: jest.fn(),
    removeLinkMapping: jest.fn(),
    getLinkMapping: jest.fn(async () => null),
    getLocalCommentId: jest.fn(),
    getRemoteCommentId: jest.fn(async () => null),
    storeCommentMapping: jest.fn()
  };
});

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
  recordRejectedFields: jest.fn(async () => undefined)
}));

jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn(),
  getFullComment: jest.fn(),
  getOrgName: jest.fn(async () => 'Local Org'),
  updateLocalIssueDescription: jest.fn()
}));

jest.mock('../src/services/jira/remote-client.js', () => ({
  getRemoteIssue: jest.fn(),
  getRemoteComment: jest.fn()
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
import { storeMapping } from '../src/services/storage/mappings.js';
import {
  establishPairWitness,
  recordWitnessPersistenceFailure
} from '../src/services/sync/pair-witness-establishment.js';

const mockFetch = fetch;

const ORG = {
  id: 'org-1',
  name: 'Target Org',
  remoteUrl: 'https://remote.atlassian.net',
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

function localIssue() {
  return {
    id: '10001',
    key: 'LOCAL-1',
    fields: {
      project: { key: 'LOCAL' },
      summary: 'Test issue',
      description: null,
      issuetype: { name: 'Task', id: '1' },
      status: { name: 'To Do' },
      updated: '2026-10-27T10:00:00.000Z',
      labels: [],
      attachment: [],
      issuelinks: []
    }
  };
}

beforeEach(() => {
  mockStore.clear();
  mockStore.set('organizations', [ORG]);
  jest.clearAllMocks();
  require('../src/services/jira/local-client.js').getFullIssue.mockImplementation(async () => localIssue());
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({ id: '20881', key: 'REMOT-1' })
  });
  const mappingsMock = require('../src/services/storage/mappings.js');
  mappingsMock.getRemoteKey.mockResolvedValue(null);
  mappingsMock.storeMapping.mockResolvedValue({ idempotent: false });
  mappingsMock.replaceIssueMapping.mockResolvedValue({ success: true });
  establishPairWitness.mockResolvedValue({ success: true, outcome: 'witness-established' });
});

describe('ledger persistence safety after a create', () => {
  test('a failed ledger resolution is observable and never writes a mapping or witness', async () => {
    const result = await createRemoteIssue(localIssue(), ORG, MAPPINGS, null, {
      syncAttachments: false,
      syncLinks: false,
      syncComments: false,
      syncCrossReference: false
    });

    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/rest/api/3/issue?notifyUsers=false');
    expect(storeMapping).not.toHaveBeenCalled();
    expect(establishPairWitness).not.toHaveBeenCalled();
    expect(recordWitnessPersistenceFailure).toHaveBeenCalledWith(expect.objectContaining({
      localKey: 'LOCAL-1',
      remoteKey: 'REMOT-1',
      targetKey: 'REMOT-1',
      outcome: 'witness-skipped-ledger-failure',
      reason: 'CREATE_TARGET_MISMATCH'
    }));
  });

  test('a later attempt cannot silently create the issue again', async () => {
    await createRemoteIssue(localIssue(), ORG, MAPPINGS, null, {
      syncAttachments: false,
      syncLinks: false,
      syncComments: false,
      syncCrossReference: false
    });
    const second = await createRemoteIssue(localIssue(), ORG, MAPPINGS, null, {
      syncAttachments: false,
      syncLinks: false,
      syncComments: false,
      syncCrossReference: false
    });

    expect(second).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(storeMapping).not.toHaveBeenCalled();
    expect(establishPairWitness).not.toHaveBeenCalled();
  });
});

