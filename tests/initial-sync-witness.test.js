const mockStore = new Map();

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  return {
    __esModule: true,
    default: { asApp: () => ({ requestJira }), asUser: () => ({ requestJira }) },
    getAppContext: jest.fn(() => ({
      appAri: 'ari:cloud:ecosystem::app/362d8e6b-b68c-4403-8020-d32ddcc02716',
      environmentAri: { environmentId: '2e8c0cb5-881a-4345-b9ba-e887f790d316' },
      installationAri: { installationId: '974910c5-2861-4d40-a7eb-37802842d0a0' },
      environmentType: 'STAGING',
      installation: { contexts: [{ cloudId: '11111111-2222-4333-8444-555555555555' }] }
    })),
    route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch: jest.fn()
  };
});

jest.mock('@forge/events', () => ({ Queue: jest.fn(() => ({ push: jest.fn() })) }));

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(async key => (mockStore.has(key) ? mockStore.get(key) : null)),
  set: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  del: jest.fn(async key => { mockStore.delete(key); }),
  getSecret: jest.fn(async () => 'remote-token'),
  setIfNotExists: jest.fn(async (key, value) => {
    if (mockStore.has(key)) throw Object.assign(new Error('exists'), { code: 'KEY_ALREADY_EXISTS' });
    mockStore.set(key, value);
  })
}));

jest.mock('../src/services/storage/mappings.js', () => {
  const actual = jest.requireActual('../src/services/storage/mappings.js');
  return {
    ...actual,
    getOrganizationsWithTokens: jest.fn(),
    getRemoteKey: jest.fn(async () => null),
    getLocalKey: jest.fn(async () => null)
  };
});

jest.mock('../src/services/jira/local-client.js', () => ({ getFullIssue: jest.fn() }));

jest.mock('../src/services/sync/issue-sync.js', () => ({
  createRemoteIssue: jest.fn(),
  updateRemoteIssue: jest.fn()
}));

jest.mock('../src/services/sync/pair-witness.js', () => {
  const actual = jest.requireActual('../src/services/sync/pair-witness.js');
  return { ...actual, readIssueIdentity: jest.fn(), readPairWitness: jest.fn() };
});

import api from '@forge/api';
import {
  previewInitialSync,
  INITIAL_SYNC_REASONS
} from '../src/services/sync/initial-sync.js';
import {
  getOrganizationsWithTokens,
  getRemoteKey,
  getLocalKey
} from '../src/services/storage/mappings.js';
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
  name: 'Target Org',
  remoteUrl: 'https://remote.atlassian.net',
  remoteEmail: 'sync@example.com',
  remoteApiToken: 'remote-token',
  remoteProjectKey: 'REMOTE',
  allowedProjects: ['LOCAL'],
  jqlFilter: '',
  syncDirection: 'push'
};

const INSTALLATION_ID = '974910c5-2861-4d40-a7eb-37802842d0a0';
const APP_ID = '362d8e6b-b68c-4403-8020-d32ddcc02716';
const LOCAL_SITE = '11111111-2222-4333-8444-555555555555';

function issue(key = 'LOCAL-1', id = '10001') {
  return {
    id,
    key,
    fields: {
      project: { key: 'LOCAL' },
      summary: 'Eligible issue',
      issuetype: { name: 'Task', id: '1' },
      status: { name: 'To Do' },
      parent: null,
      updated: '2026-10-27T10:00:00.000Z'
    }
  };
}

const record = buildPairWitness({
  pairId: deterministicPairId({
    installationId: INSTALLATION_ID,
    orgId: 'org-1',
    localIssueId: '10001',
    remoteIssueId: '20881'
  }),
  state: 'active',
  installationId: INSTALLATION_ID,
  appId: APP_ID,
  orgId: 'org-1',
  localSite: LOCAL_SITE,
  remoteSite: 'remote.atlassian.net',
  localIssueId: '10001',
  localKey: 'LOCAL-1',
  remoteIssueId: '20881',
  remoteKey: 'REMOT-1',
  direction: 'local-to-remote',
  writtenAt: '2026-10-27T10:00:00.000Z'
});

const matchingRead = {
  class: PAIR_WITNESS_READ_CLASSES.MATCHING,
  statusCode: 200,
  record,
  pairId: record.pairId,
  state: 'active'
};
const absentRead = { class: PAIR_WITNESS_READ_CLASSES.ABSENT, statusCode: 404, record: null };

beforeEach(() => {
  mockStore.clear();
  mockStore.set('organizations', [ORG]);
  jest.clearAllMocks();
  getOrganizationsWithTokens.mockResolvedValue([ORG]);
  getRemoteKey.mockResolvedValue(null);
  getLocalKey.mockResolvedValue(null);
  readIssueIdentity.mockImplementation(async ({ side }) => ({
    class: 'present',
    statusCode: 200,
    id: side === 'local' ? '10001' : '20881',
    key: side === 'local' ? 'LOCAL-1' : 'REMOT-1'
  }));
  readPairWitness.mockResolvedValue(absentRead);
  requestJira.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ issues: [issue()] })
  });
});

describe('initial backfill witness classification', () => {
  test('a confirmed absent witness keeps a genuine new issue eligible', async () => {
    const result = await previewInitialSync({ orgId: 'org-1' });

    expect(result.success).toBe(true);
    expect(result.preview.classification.eligible.issueKeys).toEqual(['LOCAL-1']);
    expect(result.preview.counts.mappingConflicts).toBe(0);
  });

  test('a witnessed pair is a conflict, never eligible for backfill', async () => {
    readPairWitness.mockResolvedValue(matchingRead);

    const result = await previewInitialSync({ orgId: 'org-1' });

    expect(result.success).toBe(true);
    expect(result.preview.classification.eligible.issueKeys).toEqual([]);
    expect(result.preview.classification.mappingConflicts.issueKeys).toEqual(['LOCAL-1']);
    expect(result.preview.classification.mappingConflicts.reasons)
      .toEqual({ [INITIAL_SYNC_REASONS.WITNESS_CONFIRMS_EXISTING_PAIR]: 1 });
  });

  test('an unreadable witness blocks the candidate instead of treating it as new', async () => {
    readPairWitness.mockResolvedValue({
      class: PAIR_WITNESS_READ_CLASSES.INACCESSIBLE,
      statusCode: 403,
      record: null
    });

    const result = await previewInitialSync({ orgId: 'org-1' });

    expect(result.preview.classification.eligible.issueKeys).toEqual([]);
    expect(result.preview.classification.blockedByValidation.reasons)
      .toEqual({ [INITIAL_SYNC_REASONS.WITNESS_UNVERIFIABLE]: 1 });
  });

  test('witness evidence changes the preview checksum, forcing re-approval', async () => {
    const clean = await previewInitialSync({ orgId: 'org-1' });
    readPairWitness.mockResolvedValue(matchingRead);
    const witnessed = await previewInitialSync({ orgId: 'org-1' });

    expect(clean.preview.previewChecksum).not.toBe(witnessed.preview.previewChecksum);
  });
});

