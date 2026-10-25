/**
 * Focused reproduction for the STG 2026-10-25 late attachment deletion.
 *
 * Live observation (MOB-28 / VMOB-32):
 *   local A id 10001 -> remote A id 10002
 *   local B id 10002 -> remote B id 10001
 *   A was deleted while propagation was Off; the deletion was applied to
 *   remote A (correct counterpart) only after propagation was switched On.
 *
 * The IDs are deliberately crossed so any direction-blind or number-only
 * lookup would resolve the other attachment.
 */
const mockStore = new Map();

jest.mock('@forge/api', () => ({
  __esModule: true,
  default: { asApp: () => ({ requestJira: jest.fn() }) },
  route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
  fetch: jest.fn()
}));

jest.mock('@forge/events', () => ({
  Queue: jest.fn(() => ({ push: jest.fn() }))
}));

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
  getSecret: jest.fn(async () => null)
}));

jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn()
}));

jest.mock('../src/services/jira/remote-client.js', () => ({
  getRemoteIssue: jest.fn()
}));

jest.mock('../src/services/jira/attachment-client.js', () => {
  const actual = jest.requireActual('../src/services/jira/attachment-client.js');
  return {
    ...actual,
    getAttachmentSettings: jest.fn(),
    getAttachmentMetadata: jest.fn(),
    downloadAttachmentContent: jest.fn(),
    uploadAttachmentContent: jest.fn(),
    deleteAttachmentContent: jest.fn(),
    getIssueAttachments: jest.fn()
  };
});

import { deleteAttachmentContent } from '../src/services/jira/attachment-client.js';
import { getFullIssue } from '../src/services/jira/local-client.js';
import {
  getAttachmentMapping,
  storeAttachmentMapping
} from '../src/services/storage/mappings.js';
import {
  ATTACHMENT_SYNC_CODES,
  propagateAttachmentDeletion
} from '../src/services/sync/attachment-sync.js';

const ORG_ID = 'org-1';
const LOCAL_KEY = 'MOB-28';
const REMOTE_KEY = 'VMOB-32';

// Live fixture numbering: the remote site issued the counterpart IDs in the
// opposite order, so the two pairs are numerically crossed.
const LOCAL_A = '10001';
const REMOTE_A = '10002';
const LOCAL_B = '10002';
const REMOTE_B = '10001';

const ORG = {
  id: ORG_ID,
  name: 'STG MOB to VMOB',
  remoteUrl: 'https://remote.example',
  remoteEmail: 'sync@example.com',
  remoteApiToken: 'remote-secret-token',
  remoteProjectKey: 'VMOB',
  allowedProjects: ['MOB'],
  syncDirection: 'push'
};

const LOCAL_ISSUE = {
  id: '10061',
  key: LOCAL_KEY,
  fields: { project: { key: 'MOB' }, attachment: [] }
};

const OPTIONS_OFF = { syncAttachments: true, propagateAttachmentDeletions: false };
const OPTIONS_ON = { syncAttachments: true, propagateAttachmentDeletions: true };

function deletionRequest({ sourceAttachmentId, syncOptions }) {
  return propagateAttachmentDeletion({
    direction: 'local-to-remote',
    sourceAttachmentId,
    localKey: LOCAL_KEY,
    remoteKey: REMOTE_KEY,
    config: ORG,
    orgId: ORG_ID,
    syncOptions
  });
}

beforeEach(async () => {
  mockStore.clear();
  jest.clearAllMocks();

  mockStore.set('organizations', [{
    id: ORG_ID,
    syncDirection: ORG.syncDirection,
    allowedProjects: ORG.allowedProjects
  }]);
  mockStore.set(`${ORG_ID}:local-to-remote:${LOCAL_KEY}`, REMOTE_KEY);
  mockStore.set(`${ORG_ID}:remote-to-local:${REMOTE_KEY}`, LOCAL_KEY);

  getFullIssue.mockResolvedValue(LOCAL_ISSUE);
  deleteAttachmentContent.mockResolvedValue({ deleted: true, alreadyDeleted: false });

  await storeAttachmentMapping(LOCAL_A, REMOTE_A, ORG_ID, 'local-to-remote');
  await storeAttachmentMapping(LOCAL_B, REMOTE_B, ORG_ID, 'local-to-remote');
});

describe('Attachment deletion target resolution with crossed numeric IDs', () => {
  test('deleting source 10001 targets only its own counterpart 10002', async () => {
    const result = await deletionRequest({
      sourceAttachmentId: LOCAL_A,
      syncOptions: OPTIONS_ON
    });

    expect(result).toEqual({ status: ATTACHMENT_SYNC_CODES.DELETE_COMPLETE });
    expect(deleteAttachmentContent).toHaveBeenCalledTimes(1);
    expect(deleteAttachmentContent).toHaveBeenCalledWith({
      source: 'remote',
      attachmentId: REMOTE_A,
      config: ORG
    });
    expect(deleteAttachmentContent).not.toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: REMOTE_B })
    );
    // The other pair keeps its mapping.
    await expect(getAttachmentMapping(LOCAL_B, ORG_ID, 'local-to-remote')).resolves.toBe(REMOTE_B);
  });

  test('a local-to-remote lookup ignores a remote-to-local mapping for the same number', async () => {
    // Bidirectional data for remote attachment 10002 -> local 10001 exists.
    await storeAttachmentMapping(REMOTE_A, LOCAL_A, ORG_ID, 'remote-to-local');

    await expect(getAttachmentMapping(REMOTE_A, ORG_ID, 'local-to-remote')).resolves.toBe(REMOTE_B);
    await expect(getAttachmentMapping(REMOTE_A, ORG_ID, 'remote-to-local')).resolves.toBe(LOCAL_A);
  });
});

describe('Propagation setting is evaluated at processing time (live defect)', () => {
  // Characterizes the current behaviour that produced the STG FAIL. After the
  // proposed fix (a deletion observed while propagation is Off must be recorded
  // and never applied later) the second call below must instead return
  // ATTACHMENT_SYNC_CODES.DELETE_DISABLED and issue no DELETE.
  test('a delete event delivered after the setting flips On deletes the counterpart', async () => {
    // 1. The event is emitted while propagation is Off (live: 18:55:51Z).
    const whileOff = await deletionRequest({
      sourceAttachmentId: LOCAL_A,
      syncOptions: OPTIONS_OFF
    });

    expect(whileOff).toEqual({ status: ATTACHMENT_SYNC_CODES.DELETE_DISABLED });
    expect(deleteAttachmentContent).not.toHaveBeenCalled();
    await expect(getAttachmentMapping(LOCAL_A, ORG_ID, 'local-to-remote')).resolves.toBe(REMOTE_A);

    // 2. The same queued event is processed after propagation was switched On
    //    (live: propagation On ~18:57Z, DELETE issued 19:00:26Z). Nothing
    //    anchors the policy to the moment the attachment was deleted.
    const afterFlip = await deletionRequest({
      sourceAttachmentId: LOCAL_A,
      syncOptions: OPTIONS_ON
    });

    expect(afterFlip).toEqual({ status: ATTACHMENT_SYNC_CODES.DELETE_COMPLETE });
    expect(deleteAttachmentContent).toHaveBeenCalledWith({
      source: 'remote',
      attachmentId: REMOTE_A,
      config: ORG
    });
    // The numerically equal twin is not touched, so the defect is a policy
    // timing error and not a destination-resolution error.
    expect(deleteAttachmentContent).not.toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: REMOTE_B })
    );
    // The enabling path consumes the mapping, so accepting the stale event is
    // not recoverable from the retained record.
    await expect(getAttachmentMapping(LOCAL_A, ORG_ID, 'local-to-remote')).resolves.toBeNull();
  });

  test('a paused connector blocks a queued deletion before any DELETE request', async () => {
    mockStore.set('pilotPause', {
      paused: true,
      pausedAt: '2026-10-25T19:01:28.000Z',
      pausedBy: '712020:6acf6244-4800-474c-85a8-d17d5fe2aac6',
      reasonCode: 'emergency_stop'
    });

    await expect(deletionRequest({
      sourceAttachmentId: LOCAL_B,
      syncOptions: OPTIONS_ON
    })).resolves.toEqual({
      status: ATTACHMENT_SYNC_CODES.DELETE_FAILED,
      code: 'PILOT_PAUSED'
    });

    expect(deleteAttachmentContent).not.toHaveBeenCalled();
    await expect(getAttachmentMapping(LOCAL_B, ORG_ID, 'local-to-remote')).resolves.toBe(REMOTE_B);
  });
});

describe('Legacy undirected mapping fallback', () => {
  test('documents that a pre-direction legacy key can supply the destination', async () => {
    // Written by code that predates direction-scoped keys: the undirected key
    // is shared by both directions, so a local-to-remote read can resolve a
    // destination that came from a remote-to-local upload.
    mockStore.set(`${ORG_ID}:attachment-mapping:10009`, '10010');

    await expect(getAttachmentMapping('10009', ORG_ID, 'local-to-remote')).resolves.toBe('10010');
    await expect(getAttachmentMapping('10009', ORG_ID, 'remote-to-local')).resolves.toBeNull();
  });
});

