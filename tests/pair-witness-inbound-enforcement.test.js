jest.mock('../src/services/sync/sync-authorization.js', () => require('./helpers/authorized-sync-authorization.js'));

const mockStore = new Map();

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  return {
    __esModule: true,
    default: { asApp: () => ({ requestJira }), asUser: () => ({ requestJira }) },
    route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch: jest.fn()
  };
});

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(async key => (mockStore.has(key) ? mockStore.get(key) : null)),
  set: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  del: jest.fn(async key => { mockStore.delete(key); }),
  createIfNotExists: jest.fn(async (key, value) => {
    if (mockStore.has(key)) throw Object.assign(new Error('conflict'), { code: 'KEY_ALREADY_EXISTS' });
    mockStore.set(key, value);
  }),
  setIfNotExists: jest.fn(async (key, value) => {
    if (mockStore.has(key)) throw Object.assign(new Error('conflict'), { code: 'KEY_ALREADY_EXISTS' });
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
    getLocalKey: jest.fn(async () => null),
    getRemoteKey: jest.fn(async () => null),
    storeMapping: jest.fn(async () => ({ idempotent: false })),
    replaceIssueMapping: jest.fn(async () => ({ success: true })),
    ensureMappingPair: jest.fn(),
    getOrganizationsWithTokens: jest.fn(async () => []),
    storeLinkMapping: jest.fn(),
    getLinkMapping: jest.fn(async () => null),
    removeLinkMapping: jest.fn(),
    getLocalCommentId: jest.fn(async () => null),
    storeCommentMapping: jest.fn(),
    getRemoteCommentId: jest.fn(async () => null),
    setLastSyncedLocalUpdated: jest.fn(),
    getLastSyncedLocalUpdated: jest.fn(async () => null),
    getAttachmentMapping: jest.fn(async () => null),
    storeAttachmentMapping: jest.fn(),
    removeAttachmentMapping: jest.fn(),
    storeAttachmentMappingHistory: jest.fn()
  };
});

jest.mock('../src/services/storage/flags.js', () => ({
  markSyncing: jest.fn(),
  clearSyncFlag: jest.fn(),
  isSyncing: jest.fn(async () => false),
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
  updateLocalIssueDescription: jest.fn()
}));

jest.mock('../src/services/jira/remote-client.js', () => ({
  getRemoteIssue: jest.fn(),
  getRemoteComment: jest.fn()
}));

jest.mock('../src/services/sync/attachment-sync.js', () => ({
  syncRemoteAttachmentsToLocal: jest.fn(async () => ({})),
  propagateAttachmentDeletion: jest.fn(async () => undefined),
  getAttachmentSyncPolicy: jest.fn(() => ({ enabled: false }))
}));

jest.mock('../src/services/sync/comment-confidentiality.js', () => ({
  getCommentConfidentiality: jest.fn(),
  verifyCommentThread: jest.fn(async () => true),
  commentParentId: jest.fn(() => null),
  withParentHints: jest.fn((value) => value),
  verifyFreshCommentThread: jest.fn(async () => true)
}));

jest.mock('../src/services/jira/comment-read.js', () => ({
  commentReadBudget: jest.fn(() => ({})),
  readCommentJson: jest.fn(async (read) => {
    const response = await read();
    return response.json();
  })
}));
jest.mock('../src/services/jira/comment-project.js', () => ({ getCommentProjectType: jest.fn(async () => 'business') }));

jest.mock('../src/services/sync/comment-verification-recovery.js', () => ({
  deferCommentVerification: jest.fn(),
  markDeferredCommentSubmission: jest.fn(),
  assertCommentVerificationReady: jest.fn(),
  rejectDeferredCommentAncestry: jest.fn()
}));

jest.mock('../src/services/sync/transition-sync.js', () => ({
  transitionLocalIssue: jest.fn(async () => false),
  transitionRemoteIssue: jest.fn(async () => false)
}));

jest.mock('../src/services/sync/webhook-replay.js', () => ({
  claimWebhookEvent: jest.fn(async () => ({ claimed: true })),
  markWebhookCompleted: jest.fn(),
  releaseWebhookEvent: jest.fn()
}));

jest.mock('../src/services/sync/lease-migration.js', () => ({
  assertIssueLeaseMigrationReady: jest.fn(async () => undefined),
  readIssueLeaseMigrationState: jest.fn(async () => ({ active: true }))
}));

jest.mock('../src/services/sync/post-create-attachments.js', () => ({
  retainPostCreateAttachments: jest.fn(),
  resumePostCreateAttachments: jest.fn(async () => ({ pending: false }))
}));

jest.mock('../src/services/sync/counterpart-probe.js', () => ({
  setCounterpartNotice: jest.fn(async () => undefined),
  probeCounterpart: jest.fn(async () => ({ status: 'active' }))
}));

jest.mock('../src/services/sync/counterpart-recovery.js', () => ({
  maybeAutoReplaceAfterDeletion: jest.fn(async () => null)
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
  return { ...actual, readIssueIdentity: jest.fn(), readPairWitness: jest.fn() };
});

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

jest.mock('../src/services/sync/sync-observability.js', () => {
  const actual = jest.requireActual('../src/services/sync/sync-observability.js');
  return { ...actual, recordSyncDecision: jest.fn(async (record) => record) };
});


import api from '@forge/api';
import { handleRemoteIssueCreated } from '../src/services/sync/incoming-sync.js';
import { getLocalKey, storeMapping, replaceIssueMapping } from '../src/services/storage/mappings.js';
import { getRemoteIssue } from '../src/services/jira/remote-client.js';
import { recordSyncDecision } from '../src/services/sync/sync-observability.js';
import { establishPairWitness } from '../src/services/sync/pair-witness-establishment.js';
import {
  readIssueIdentity,
  readPairWitness,
  buildPairWitness,
  deterministicPairId,
  PAIR_WITNESS_READ_CLASSES
} from '../src/services/sync/pair-witness.js';

const requestJira = api.asApp().requestJira;

const ORG = {
  id: 'org-1',
  name: 'Local Org',
  remoteUrl: 'https://remote.atlassian.net',
  remoteEmail: 'sync@example.com',
  remoteApiToken: 'remote-token',
  remoteProjectKey: 'REMOTE',
  allowedProjects: ['LOCAL'],
  syncDirection: 'bidirectional'
};

const MAPPINGS = {
  userMappings: {},
  fieldMappings: {},
  statusMappings: {},
  issueTypeMappings: {},
  projectMappings: {}
};

const CONTEXT = {
  org: ORG,
  orgId: 'org-1',
  mappings: MAPPINGS,
  syncOptions: { syncComments: false, syncAttachments: false, syncLinks: false }
};

const INSTALLATION_ID = '974910c5-2861-4d40-a7eb-37802842d0a0';
const APP_ID = '362d8e6b-b68c-4403-8020-d32ddcc02716';
const LOCAL_SITE = '11111111-2222-4333-8444-555555555555';

const remote = {
  id: '20881',
  key: 'REMOT-1',
  fields: {
    project: { key: 'REMOTE' },
    summary: 'Remote issue',
    description: null,
    issuetype: { name: 'Task' },
    status: { name: 'To Do' },
    updated: '2026-10-27T10:00:00.000Z',
    labels: [],
    attachment: [],
    issuelinks: []
  }
};

function pairWitness({ localIssueId = '10001', localKey = 'LOCAL-1' } = {}) {
  return buildPairWitness({
    pairId: deterministicPairId({
      installationId: INSTALLATION_ID,
      orgId: 'org-1',
      localIssueId,
      remoteIssueId: '20881'
    }),
    state: 'active',
    installationId: INSTALLATION_ID,
    appId: APP_ID,
    orgId: 'org-1',
    localSite: LOCAL_SITE,
    remoteSite: 'remote.atlassian.net',
    localIssueId,
    localKey,
    remoteIssueId: '20881',
    remoteKey: 'REMOT-1',
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
const absentRead = { class: PAIR_WITNESS_READ_CLASSES.ABSENT, statusCode: 404, record: null };

beforeEach(() => {
  mockStore.clear();
  mockStore.set('organizations', [ORG]);
  jest.clearAllMocks();
  getRemoteIssue.mockResolvedValue(remote);
  requestJira.mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({ id: '10002', key: 'LOCAL-2' })
  });
  getLocalKey.mockResolvedValue(null);
  storeMapping.mockClear();
  replaceIssueMapping.mockClear();
  readIssueIdentity.mockImplementation(async ({ side, issueRef }) => {
    if (side === 'remote') {
      return { class: 'present', statusCode: 200, id: '20881', key: 'REMOT-1' };
    }
    return issueRef === '10001'
      ? { class: 'present', statusCode: 200, id: '10001', key: 'LOCAL-1' }
      : { class: 'present', statusCode: 200, id: '10002', key: 'LOCAL-2' };
  });
  readPairWitness.mockResolvedValue(absentRead);
  establishPairWitness.mockResolvedValue({ success: true, outcome: 'witness-established' });
});


describe('inbound create enforcement', () => {
  test('an absent remote witness preserves legitimate local creation', async () => {
    const result = await handleRemoteIssueCreated(remote, CONTEXT);

    expect(result.status).toBe('CREATED');
    expect(requestJira).toHaveBeenCalledTimes(1);
    expect(requestJira.mock.calls[0][1].method).toBe('POST');
    expect(storeMapping).toHaveBeenCalledWith('LOCAL-2', 'REMOT-1', 'org-1');
    expect(establishPairWitness).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1',
      localKey: 'LOCAL-2',
      remoteKey: 'REMOT-1',
      localIssueId: '10002',
      remoteIssueId: '20881',
      direction: 'remote-to-local'
    }));
  });

  test('two matching witnesses prevent the local create POST', async () => {
    const record = pairWitness();
    readPairWitness.mockImplementation(async () => matchingRead(record));

    const result = await handleRemoteIssueCreated(remote, CONTEXT);

    expect(result.status).toBe('PAIR_WITNESS_PAIR_PROVEN');
    expect(requestJira).not.toHaveBeenCalled();
    expect(storeMapping).not.toHaveBeenCalled();
    expect(recordSyncDecision).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'duplicate',
      remoteKey: 'REMOT-1',
      reason: 'PAIR_WITNESS_PAIR_PROVEN'
    }));
  });

  test('an inaccessible remote witness prevents the create', async () => {
    readPairWitness.mockResolvedValue({
      class: PAIR_WITNESS_READ_CLASSES.INACCESSIBLE,
      statusCode: 403,
      record: null
    });

    const result = await handleRemoteIssueCreated(remote, CONTEXT);

    expect(result.status).toBe('PAIR_WITNESS_INACCESSIBLE');
    expect(requestJira).not.toHaveBeenCalled();
  });

  test('an authorized inbound replacement of a witnessed, deleted local counterpart creates once', async () => {
    getLocalKey.mockResolvedValue('LOCAL-0');
    require('../src/services/jira/local-client.js').getFullIssue.mockResolvedValue({
      key: 'LOCAL-0',
      fields: { project: { key: 'LOCAL' }, status: { name: 'To Do' } }
    });
    readPairWitness.mockImplementation(async ({ side }) => (side === 'remote'
      ? matchingRead(pairWitness({ localIssueId: '10001', localKey: 'LOCAL-0' }))
      : absentRead));
    readIssueIdentity.mockImplementation(async ({ side, issueRef }) => {
      if (side === 'remote') {
        return { class: 'present', statusCode: 200, id: '20881', key: 'REMOT-1' };
      }
      if (issueRef === '10001') {
        return { class: 'missing', statusCode: 404, id: null, key: null };
      }
      return { class: 'present', statusCode: 200, id: '10002', key: 'LOCAL-2' };
    });

    const result = await handleRemoteIssueCreated(remote, CONTEXT, {
      replacementOfLocalKey: 'LOCAL-0',
      operationSuffix: 'replace:LOCAL-0'
    });

    expect(result.status).toBe('CREATED');
    expect(requestJira).toHaveBeenCalledTimes(1);
    expect(replaceIssueMapping).toHaveBeenCalledWith(expect.objectContaining({
      oldLocalKey: 'LOCAL-0',
      newLocalKey: 'LOCAL-2'
    }));
  });
});

