jest.mock('../src/services/sync/sync-authorization.js', () => require('./helpers/authorized-sync-authorization.js'));

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

jest.mock('../src/services/readiness/connector-readiness.js', () => ({
  readWitnessIdentity: jest.fn(async () => ({
    readable: true,
    appId: '362d8e6b-b68c-4403-8020-d32ddcc02716',
    installationId: '974910c5-2861-4d40-a7eb-37802842d0a0',
    localSite: '11111111-2222-4333-8444-555555555555'
  })),
  readForgeInstallationIdentity: jest.fn()
}));

jest.mock('../src/services/sync/pair-witness.js', () => {
  const actual = jest.requireActual('../src/services/sync/pair-witness.js');
  return {
    ...actual,
    readIssueIdentity: jest.fn(),
    readPairWitness: jest.fn()
  };
});

jest.mock('../src/services/sync/pair-witness-establishment.js', () => ({
  WITNESS_ESTABLISHMENT_OUTCOMES: {
    APPLIED: 'witness-established',
    MAPPING_PERSISTENCE_FAILED: 'witness-skipped-mapping-failure',
    LEDGER_PERSISTENCE_FAILED: 'witness-skipped-ledger-failure',
    FAILED: 'witness-establishment-failed'
  },
  establishPairWitness: jest.fn(async () => ({ success: true, outcome: 'witness-established' })),
  recordWitnessPersistenceFailure: jest.fn(async () => ({ success: false, outcome: 'witness-establishment-failed' }))
}));

jest.mock('../src/services/sync/sync-observability.js', () => {
  const actual = jest.requireActual('../src/services/sync/sync-observability.js');
  return { ...actual, recordSyncDecision: jest.fn(async (record) => record) };
});

import { fetch } from '@forge/api';
import { createRemoteIssue } from '../src/services/sync/issue-sync.js';
import { storeMapping, replaceIssueMapping } from '../src/services/storage/mappings.js';
import { recordSyncDecision } from '../src/services/sync/sync-observability.js';
import { establishPairWitness, recordWitnessPersistenceFailure } from '../src/services/sync/pair-witness-establishment.js';
import {
  readIssueIdentity,
  readPairWitness,
  buildPairWitness,
  deterministicPairId,
  PAIR_WITNESS_READ_CLASSES
} from '../src/services/sync/pair-witness.js';
import {
  buildIssueCreateOperationKey,
  ISSUE_CREATE_DIRECTIONS,
  ISSUE_CREATE_STATES
} from '../src/services/sync/issue-create-operation.js';

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

const INSTALLATION_ID = '974910c5-2861-4d40-a7eb-37802842d0a0';
const APP_ID = '362d8e6b-b68c-4403-8020-d32ddcc02716';
const LOCAL_SITE = '11111111-2222-4333-8444-555555555555';

function localIssue(key = 'LOCAL-1') {
  return {
    id: '10001',
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

function pairWitness({ remoteIssueId = '20881', remoteKey = 'REMOT-1' } = {}) {
  return buildPairWitness({
    pairId: deterministicPairId({
      installationId: INSTALLATION_ID,
      orgId: 'org-1',
      localIssueId: '10001',
      remoteIssueId
    }),
    state: 'active',
    installationId: INSTALLATION_ID,
    appId: APP_ID,
    orgId: 'org-1',
    localSite: LOCAL_SITE,
    remoteSite: 'remote.atlassian.net',
    localIssueId: '10001',
    localKey: 'LOCAL-1',
    remoteIssueId,
    remoteKey,
    direction: 'local-to-remote',
    writtenAt: '2026-10-27T10:00:00.000Z'
  });
}

const matchingRead = (record) => ({
  class: PAIR_WITNESS_READ_CLASSES.MATCHING,
  statusCode: 200,
  record,
  pairId: record.pairId,
  state: 'active'
});
const absentRead = {
  class: PAIR_WITNESS_READ_CLASSES.ABSENT,
  statusCode: 404,
  record: null,
  pairId: null,
  state: null
};

const createOptions = () => ({
  syncAttachments: false,
  syncLinks: false,
  syncComments: false,
  syncCrossReference: false
});

beforeEach(() => {
  mockStore.clear();
  mockSecretStore.clear();
  mockStore.set('organizations', [ORG]);
  mockSecretStore.set('secret:org-1:token', 'remote-token');
  require('../src/services/jira/local-client.js').getFullIssue.mockImplementation(async key => localIssue(key));
  jest.clearAllMocks();
  const mappingsMock = require('../src/services/storage/mappings.js');
  mappingsMock.getRemoteKey.mockResolvedValue(null);
  mappingsMock.getLocalKey.mockResolvedValue(null);
  mappingsMock.storeMapping.mockClear();
  mappingsMock.replaceIssueMapping.mockClear();
  establishPairWitness.mockResolvedValue({ success: true, outcome: 'witness-established' });
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({
      id: '20881',
      key: 'REMOT-1',
      self: 'https://remote.atlassian.net/rest/api/3/issue/20881'
    })
  });
  readIssueIdentity.mockImplementation(async ({ side }) => ({
    class: 'present',
    statusCode: 200,
    id: side === 'local' ? '10001' : '20881',
    key: side === 'local' ? 'LOCAL-1' : 'REMOT-1'
  }));
  readPairWitness.mockResolvedValue(absentRead);
});


describe('outbound create enforcement', () => {
  test('a confirmed absent witness preserves legitimate first-time creation', async () => {
    const result = await createRemoteIssue(localIssue(), ORG, MAPPINGS, null, createOptions());

    expect(result?.key).toBe('REMOT-1');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/rest/api/3/issue?notifyUsers=false');
    expect(storeMapping).toHaveBeenCalledWith('LOCAL-1', 'REMOT-1', 'org-1');
    expect(establishPairWitness).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOT-1',
      localIssueId: '10001',
      remoteIssueId: '20881'
    }));
  });

  test('two matching witnesses prevent the create POST entirely', async () => {
    const record = pairWitness();
    readPairWitness.mockImplementation(async ({ side }) => matchingRead(record));

    const result = await createRemoteIssue(localIssue(), ORG, MAPPINGS, null, createOptions());

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(storeMapping).not.toHaveBeenCalled();
    expect(recordSyncDecision).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'duplicate',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOT-1',
      reason: 'PAIR_WITNESS_PAIR_PROVEN'
    }));
  });

  test('an in-doubt ledger blocks before the create POST', async () => {
    mockStore.set(buildIssueCreateOperationKey({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1'
    }), {
      operationId: 'op-1',
      attempt: 1,
      attemptToken: 'token',
      state: ISSUE_CREATE_STATES.SUCCEEDED,
      targetKey: 'REMOT-9'
    });

    const result = await createRemoteIssue(localIssue(), ORG, MAPPINGS, null, createOptions());

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(recordSyncDecision).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'ambiguous_write',
      reason: 'PAIR_WITNESS_LEDGER_IN_DOUBT'
    }));
  });

  test('an authorized replacement of a witnessed, deleted counterpart creates exactly once', async () => {
    const { getRemoteKey } = require('../src/services/storage/mappings.js');
    getRemoteKey.mockResolvedValue('REMOT-0');
    readPairWitness.mockImplementation(async ({ side }) => (side === 'local'
      ? matchingRead(pairWitness({ remoteIssueId: '20880', remoteKey: 'REMOT-0' }))
      : absentRead));
    readIssueIdentity.mockImplementation(async ({ side, issueRef }) => {
      if (side === 'local') {
        return { class: 'present', statusCode: 200, id: '10001', key: 'LOCAL-1' };
      }
      if (issueRef === '20880') {
        return { class: 'missing', statusCode: 404, id: null, key: null };
      }
      return { class: 'present', statusCode: 200, id: '20881', key: 'REMOT-1' };
    });

    const result = await createRemoteIssue(localIssue(), ORG, MAPPINGS, null, {
      ...createOptions(),
      replacementOfRemoteKey: 'REMOT-0',
      operationSuffix: 'replace:REMOT-0'
    });

    expect(result?.key).toBe('REMOT-1');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(replaceIssueMapping).toHaveBeenCalledWith(expect.objectContaining({
      oldRemoteKey: 'REMOT-0',
      newRemoteKey: 'REMOT-1'
    }));
  });

  test('a witness-establishment failure never repeats the create', async () => {
    establishPairWitness.mockResolvedValueOnce({ success: false, outcome: 'witness-partial' });

    const result = await createRemoteIssue(localIssue(), ORG, MAPPINGS, null, createOptions());

    expect(result?.key).toBe('REMOT-1');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(storeMapping).toHaveBeenCalledTimes(1);
  });

  test('an unreadable witness read blocks the create', async () => {
    readPairWitness.mockResolvedValue({
      class: PAIR_WITNESS_READ_CLASSES.UNVERIFIABLE,
      statusCode: 503,
      record: null,
      code: 'PAIR_WITNESS_UNAVAILABLE'
    });

    const result = await createRemoteIssue(localIssue(), ORG, MAPPINGS, null, createOptions());

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(recordSyncDecision).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'skipped_locked',
      reason: 'PAIR_WITNESS_UNVERIFIABLE'
    }));
  });
});


describe('persistence and pause behaviour', () => {
  test('a mapping write failure is recorded and never produces a second create', async () => {
    storeMapping.mockRejectedValueOnce(Object.assign(new Error('storage'), { code: 'MAPPING_STORAGE_ERROR' }));

    const result = await createRemoteIssue(localIssue(), ORG, MAPPINGS, null, createOptions());

    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(recordWitnessPersistenceFailure).toHaveBeenCalledWith(expect.objectContaining({
      localKey: 'LOCAL-1',
      remoteKey: 'REMOT-1',
      targetKey: 'REMOT-1',
      outcome: 'witness-skipped-mapping-failure',
      reason: 'MAPPING_STORAGE_ERROR'
    }));
    expect(establishPairWitness).not.toHaveBeenCalled();
  });

  test('a paused connector performs no create and no witness read', async () => {
    mockStore.set('pilotPause', { paused: true, reasonCode: 'emergency_stop' });

    await expect(createRemoteIssue(localIssue(), ORG, MAPPINGS, null, createOptions()))
      .rejects.toMatchObject({ code: 'PILOT_PAUSED' });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(readPairWitness).not.toHaveBeenCalled();
  });

  test('two concurrent create attempts produce exactly one POST and one mapping', async () => {
    const [first, second] = await Promise.all([
      createRemoteIssue(localIssue(), ORG, MAPPINGS, null, createOptions()),
      createRemoteIssue(localIssue(), ORG, MAPPINGS, null, createOptions())
    ]);

    const created = [first, second].filter((result) => result?.key);
    expect(created).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(storeMapping).toHaveBeenCalledTimes(1);
  });
});

