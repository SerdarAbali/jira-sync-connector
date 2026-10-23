/**
 * F05 scenario 9: durable continuation must honour the saved Retry-After
 * deadline and the emergency pause, without producing duplicate writes.
 *
 * The heartbeat trigger, the comment-verification ledger and the pilot pause
 * are the production modules; only the downstream synchronizers are stubbed.
 */
const mockStore = new Map();

jest.mock('@forge/api', () => ({
  __esModule: true,
  default: { asApp: () => ({ requestJira: jest.fn() }) },
  route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
  fetch: jest.fn()
}));

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(async key => (mockStore.has(key) ? mockStore.get(key) : null)),
  set: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  del: jest.fn(async key => { mockStore.delete(key); }),
  setIfNotExists: jest.fn(async (key, value) => {
    if (mockStore.has(key)) throw Object.assign(new Error('exists'), { code: 'KEY_ALREADY_EXISTS' });
    mockStore.set(key, value);
  }),
  queryByPrefix: jest.fn(async prefix => Array.from(mockStore, ([key, value]) => ({ key, value }))
    .filter(row => row.key.startsWith(prefix))),
  getSecret: jest.fn(async () => 'secret')
}));

jest.mock('../src/services/storage/stats.js', () => ({
  trackApiCall: jest.fn(),
  trackWebhookSync: jest.fn(),
  logAuditEntry: jest.fn()
}));

jest.mock('../src/services/sync/initial-sync.js', () => ({
  recoverInitialSyncJobs: jest.fn(async () => ({ recovered: 0 }))
}));
jest.mock('../src/services/sync/source-reconciliation.js', () => ({
  runDueReconciliations: jest.fn(async () => ({ scheduled: 0 }))
}));
jest.mock('../src/services/sync/post-create-attachments.js', () => ({
  recoverPostCreateAttachments: jest.fn(async () => ({ completed: 0 }))
}));
jest.mock('../src/services/sync/comment-sync.js', () => ({
  syncComment: jest.fn(async () => ({ status: 'COMMENT_SYNCED' }))
}));
jest.mock('../src/services/sync/incoming-sync.js', () => ({
  processIncomingWebhook: jest.fn()
}));

import { run as runRecoveryHeartbeat } from '../src/triggers/initial-sync-recovery.js';
import { deferCommentVerification } from '../src/services/sync/comment-verification-recovery.js';
import { CommentVerificationDeferred } from '../src/services/jira/comment-read.js';
import { pausePilot, resumePilot } from '../src/services/sync/pilot-pause.js';
import { syncComment } from '../src/services/sync/comment-sync.js';

const identifiers = {
  direction: 'local-to-remote',
  orgId: 'org-1',
  issueKey: 'LOCAL-1',
  commentId: 'C1'
};
const recordKey = 'comment-verification:local-to-remote:org-1:LOCAL-1:C1';
const startedAt = new Date('2026-10-23T10:00:00.000Z').getTime();

describe('F05 scenario 9: durable continuation honours pause and Retry-After', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(startedAt);
    jest.clearAllMocks();
    mockStore.clear();
    mockStore.set('organizations', [{ id: 'org-1', name: 'Remote', syncDirection: 'bidirectional' }]);
    await deferCommentVerification(identifiers, new CommentVerificationDeferred(120000));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('the saved deadline exceeds the rate-limit floor and is not retried early', async () => {
    expect(mockStore.get(recordKey)).toMatchObject({ notBefore: startedAt + 120000 });

    jest.setSystemTime(startedAt + 60000);
    await runRecoveryHeartbeat();
    expect(syncComment).not.toHaveBeenCalled();
    expect(mockStore.has(recordKey)).toBe(true);
  });

  test('an active pause blocks recovery and keeps the durable record', async () => {
    await pausePilot('emergency_stop', 'admin-1');
    jest.setSystemTime(startedAt + 130000);

    const result = await runRecoveryHeartbeat();

    expect(syncComment).not.toHaveBeenCalled();
    expect(result.comments.recovered).toBe(0);
    expect(mockStore.has(recordKey)).toBe(true);
  });

  test('after resume the due record is submitted once and never duplicated', async () => {
    await pausePilot('emergency_stop', 'admin-1');
    jest.setSystemTime(startedAt + 130000);
    await runRecoveryHeartbeat();
    expect(syncComment).not.toHaveBeenCalled();

    await resumePilot('admin-1');
    jest.setSystemTime(startedAt + 140000);
    const first = await runRecoveryHeartbeat();
    expect(syncComment).toHaveBeenCalledTimes(1);
    expect(first.comments.recovered).toBe(1);
    expect(mockStore.has(recordKey)).toBe(false);

    await runRecoveryHeartbeat();
    expect(syncComment).toHaveBeenCalledTimes(1);
  });
});
