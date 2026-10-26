// The synchronization authorization gate has its own suite; this suite tests another behaviour.
jest.mock('../src/services/sync/sync-authorization.js', () => require('./helpers/authorized-sync-authorization.js'));

import { entities } from './helpers/forge-lease-runtime';

const mockStore = new Map();

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  const fetchMock = jest.fn();
  return {
    __esModule: true,
    default: { asApp: () => ({ requestJira }) },
    route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch: fetchMock
  };
});

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(async key => (mockStore.has(key) ? mockStore.get(key) : null)),
  set: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  del: jest.fn(async key => { mockStore.delete(key); }),
  getSecret: jest.fn(async () => 'token'),
  setIfNotExists: jest.fn(async (key, value) => {
    if (mockStore.has(key)) {
      const error = new Error('already exists');
      error.code = 'KEY_ALREADY_EXISTS';
      throw error;
    }
    mockStore.set(key, value);
  }),
  setWithTtl: jest.fn(async (key, value) => { mockStore.set(key, value); })
}));

jest.mock('../src/services/storage/mappings.js', () => ({
  getRemoteKey: jest.fn(),
  getLocalKey: jest.fn(),
  storeMapping: jest.fn(),
  ensureMappingPair: jest.fn(),
  replaceIssueMapping: jest.fn(),
  getOrganizationsWithTokens: jest.fn(),
  setLastSyncedLocalUpdated: jest.fn(),
  storeAttachmentMapping: jest.fn(),
  getAttachmentMapping: jest.fn(),
  storeLinkMapping: jest.fn(),
  getLinkMapping: jest.fn(),
  removeLinkMapping: jest.fn(),
  getLocalCommentId: jest.fn(),
  storeCommentMapping: jest.fn()
}));

jest.mock('../src/services/storage/flags.js', () => ({
  markSyncing: jest.fn(),
  clearSyncFlag: jest.fn(),
  isSyncing: jest.fn(),
  findPendingLinksToIssue: jest.fn(),
  removePendingLink: jest.fn()
}));

jest.mock('../src/services/storage/stats.js', () => ({
  logAuditEntry: jest.fn(async () => undefined),
  trackWebhookSync: jest.fn(async () => undefined),
  trackApiCall: jest.fn(async () => undefined)
}));

jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn(),
  getFullComment: jest.fn(),
  getOrgName: jest.fn(async () => 'Local Org'),
  updateLocalIssueDescription: jest.fn(async () => true),
  uploadAttachment: jest.fn()
}));

jest.mock('../src/services/jira/remote-client.js', () => ({
  getRemoteIssue: jest.fn(),
  getRemoteComment: jest.fn()
}));

jest.mock('../src/services/sync/attachment-sync.js', () => ({
  syncAttachments: jest.fn(async () => ({}))
}));

jest.mock('../src/services/sync/link-sync.js', () => ({
  syncIssueLinks: jest.fn(async () => ({ synced: 0 })),
  createLinkOnRemote: jest.fn(async () => ({ success: true }))
}));

jest.mock('../src/services/sync/comment-sync.js', () => ({
  syncAllComments: jest.fn(async () => ({ synced: 0, skipped: 0 }))
}));

jest.mock('../src/services/sync/transition-sync.js', () => ({
  transitionRemoteIssue: jest.fn(async () => false),
  transitionLocalIssue: jest.fn(async () => false)
}));

jest.mock('../src/services/storage/rejected-fields.js', () => ({
  recordRejectedFields: jest.fn()
}));

jest.mock('../src/services/sync/pilot-pause.js', () => ({
  assertPilotWritesAllowed: jest.fn(async () => undefined)
}));

import api, { fetch as mockFetch } from '@forge/api';
import { run as runLinkCreated } from '../src/triggers/link.js';
import { syncIssue } from '../src/services/sync/issue-sync.js';
import { recordDestinationWrite } from '../src/services/sync/sync-state.js';
import { resolveLocalDestinationHash } from '../src/services/sync/destination-state.js';
import { hashSynchronizedFields } from '../src/services/sync/field-normalization.js';
import { syncIssueLinks } from '../src/services/sync/link-sync.js';
import { getFullIssue } from '../src/services/jira/local-client.js';
import { getRemoteIssue } from '../src/services/jira/remote-client.js';
import { getOrganizationsWithTokens, getRemoteKey } from '../src/services/storage/mappings.js';
import { isSyncing } from '../src/services/storage/flags.js';
import { assertPilotWritesAllowed } from '../src/services/sync/pilot-pause.js';

const mockRequestJira = api.asApp().requestJira;

const ORG = {
  id: 'org-1',
  name: 'Remote Org',
  remoteUrl: 'https://remote.example.invalid',
  remoteEmail: 'sync@example.invalid',
  remoteApiToken: 'test-token',
  remoteProjectKey: 'REMOTE'
};

const LOCAL_KEY = 'LOCAL-1';
const REMOTE_KEY = 'REMOTE-1';

function localIssue(overrides = {}) {
  return {
    key: LOCAL_KEY,
    fields: {
      project: { key: 'LOCAL' },
      summary: 'Test issue',
      issuetype: { name: 'Task', id: '10001' },
      status: { name: 'To Do' },
      updated: '2026-10-25T10:20:00.000Z',
      labels: [],
      ...overrides
    }
  };
}

function linkCreatedEvent(overrides = {}) {
  return {
    eventType: 'avi:jira:created:issuelink',
    selfGenerated: false,
    id: '10101',
    sourceIssueId: '10050',
    issueLinkType: { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
    timestamp: '2026-10-25T10:30:31.000Z',
    ...overrides
  };
}

/**
 * Record the echo marker a previous connector write leaves behind. Synchronized
 * fields are unchanged afterwards, which is what makes the gate fire: only the
 * link changed.
 */
async function recordUnchangedFieldEcho() {
  const issue = localIssue();
  const prior = await resolveLocalDestinationHash({ localKey: LOCAL_KEY });
  expect(prior).toEqual({
    available: true,
    hash: hashSynchronizedFields(issue.fields, { customFieldIds: [], includeStatus: true })
  });
  await recordDestinationWrite({
    orgId: 'org-1',
    localKey: LOCAL_KEY,
    remoteKey: REMOTE_KEY,
    observedSide: 'local',
    fieldHash: prior.hash
  });
  return prior.hash;
}

/** The decision the echo gate recorded for the mapped pair, if any. */
function echoDecision() {
  return mockStore.get(`sync-decision:org-1:${LOCAL_KEY}:${REMOTE_KEY}`);
}

function storedOrganization(allowedProjects = ['LOCAL']) {
  const org = { ...ORG, syncDirection: 'bidirectional', allowedProjects };
  mockStore.set('organizations', [org]);
  return org;
}

beforeEach(() => {
  mockStore.clear();
  entities.clear();
  jest.clearAllMocks();
  getFullIssue.mockResolvedValue(localIssue());
  getRemoteIssue.mockResolvedValue({ ...localIssue(), key: REMOTE_KEY });
  getOrganizationsWithTokens.mockResolvedValue([storedOrganization()]);
  getRemoteKey.mockResolvedValue(REMOTE_KEY);
  isSyncing.mockResolvedValue(false);
  assertPilotWritesAllowed.mockResolvedValue(undefined);
  mockRequestJira.mockResolvedValue({ ok: true, status: 200, json: async () => ({ key: LOCAL_KEY }) });
  mockStore.set('syncOptions:org-1', { syncLinks: true, syncComments: false, syncAttachments: false });
});

describe('issue-link events and the echo gate', () => {
  test('a user-created link inside the echo window is processed', async () => {
    await recordUnchangedFieldEcho();

    await runLinkCreated(linkCreatedEvent());

    expect(syncIssueLinks).toHaveBeenCalledTimes(1);
    expect(syncIssueLinks).toHaveBeenCalledWith(
      LOCAL_KEY,
      REMOTE_KEY,
      expect.objectContaining({ key: LOCAL_KEY }),
      expect.objectContaining({ id: 'org-1' }),
      expect.anything(),
      'org-1',
      false
    );
    // Mapping lookup and project scope still run for a tagged link event.
    expect(getRemoteKey).toHaveBeenCalledWith(LOCAL_KEY, 'org-1');
    expect(echoDecision()?.decision).not.toBe('skipped_echo');
    expect(mockFetch.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(true);
  });

  test('an ordinary issue update inside the echo window stays suppressed', async () => {
    await recordUnchangedFieldEcho();

    await syncIssue({
      eventType: 'avi:jira:updated:issue',
      issue: { key: LOCAL_KEY },
      changelog: { items: [{ field: 'summary' }] }
    });

    expect(syncIssueLinks).not.toHaveBeenCalled();
    expect(echoDecision()).toEqual(expect.objectContaining({
      decision: 'skipped_echo',
      reason: 'app-caused-write-marker'
    }));
  });

  test('an app-generated link event keeps the echo suppression', async () => {
    await recordUnchangedFieldEcho();

    await runLinkCreated(linkCreatedEvent({ selfGenerated: true }));

    expect(syncIssueLinks).not.toHaveBeenCalled();
    expect(echoDecision()).toEqual(expect.objectContaining({
      decision: 'skipped_echo',
      reason: 'app-caused-write-marker'
    }));
  });

  test('a link marker for another link event type is not accepted', async () => {
    await recordUnchangedFieldEcho();

    await syncIssue({
      eventType: 'avi:jira:updated:issue',
      issue: { key: LOCAL_KEY },
      linkChange: { eventType: 'avi:jira:deleted:issuelink', userInitiated: true }
    });

    expect(syncIssueLinks).not.toHaveBeenCalled();
  });

  test('repeated link events are processed each time', async () => {
    await recordUnchangedFieldEcho();

    await runLinkCreated(linkCreatedEvent({ id: '10101' }));
    await runLinkCreated(linkCreatedEvent({ id: '10102' }));

    // Duplicate-link suppression remains link-sync's mapping check, which runs
    // once per processed event.
    expect(syncIssueLinks).toHaveBeenCalledTimes(2);
  });

  test('link evidence does not bypass project scope', async () => {
    getOrganizationsWithTokens.mockResolvedValue([storedOrganization(['OTHER'])]);
    await recordUnchangedFieldEcho();

    await runLinkCreated(linkCreatedEvent());

    expect(syncIssueLinks).not.toHaveBeenCalled();
  });

  test('link evidence does not bypass an active sync flag', async () => {
    await recordUnchangedFieldEcho();
    isSyncing.mockResolvedValue(true);

    await runLinkCreated(linkCreatedEvent());

    expect(syncIssueLinks).not.toHaveBeenCalled();
  });

  test('link evidence does not bypass the emergency pause', async () => {
    await recordUnchangedFieldEcho();
    assertPilotWritesAllowed.mockRejectedValue(
      Object.assign(new Error('connector paused'), { code: 'PILOT_PAUSED' })
    );

    await runLinkCreated(linkCreatedEvent());

    expect(assertPilotWritesAllowed).toHaveBeenCalledWith('issue_update_remote');
    expect(syncIssueLinks).not.toHaveBeenCalled();
  });
});
