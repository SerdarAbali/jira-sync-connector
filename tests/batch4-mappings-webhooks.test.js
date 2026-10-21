const mockStore = new Map();
const mockTransactionWrites = [];

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(async key => (mockStore.has(key) ? mockStore.get(key) : null)),
  set: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  del: jest.fn(async key => { mockStore.delete(key); }),
  setIfNotExists: jest.fn(async (key, value) => {
    if (mockStore.has(key)) {
      const error = new Error('already exists');
      error.code = 'KEY_ALREADY_EXISTS';
      throw error;
    }
    mockStore.set(key, value);
  }),
  setWithTtl: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  transaction: jest.fn(() => {
    const tx = {
      set: jest.fn((key, value) => {
        mockTransactionWrites.push([key, value]);
        mockStore.set(key, value);
        return tx;
      }),
      execute: jest.fn(async () => undefined)
    };
    return tx;
  })
}));

jest.mock('../src/services/storage/stats.js', () => ({
  logAuditEntry: jest.fn(async () => undefined),
  trackWebhookSync: jest.fn(),
  trackApiCall: jest.fn()
}));

import * as kvsStore from '../src/services/storage/kvs.js';
import {
  storeMapping,
  ensureMappingPair,
  getMappingRepairRecord,
  isValidIssueKey
} from '../src/services/storage/mappings.js';
import {
  recordConflict,
  conflictRecordKey,
  detectDestinationConflict
} from '../src/services/sync/sync-state.js';
import {
  buildWebhookFingerprint,
  claimWebhookEvent,
  markWebhookCompleted,
  releaseWebhookEvent
} from '../src/services/sync/webhook-replay.js';
import { parseWebhookUserPath, run as runWebhook } from '../src/webtriggers/incoming-webhook.js';

beforeEach(() => {
  mockStore.clear();
  mockTransactionWrites.length = 0;
  jest.clearAllMocks();
  kvsStore.set.mockImplementation(async (key, value) => { mockStore.set(key, value); });
  kvsStore.transaction.mockImplementation(() => {
    const tx = {
      set: jest.fn((key, value) => {
        mockTransactionWrites.push([key, value]);
        mockStore.set(key, value);
        return tx;
      }),
      execute: jest.fn(async () => undefined)
    };
    return tx;
  });
});

describe('Batch 4 conflict records and conservative detection', () => {
  test('29. conflict records contain no issue content', async () => {
    const record = await recordConflict({
      orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1',
      direction: 'local-to-remote', localTimestamp: '2026-10-21T12:00:00.000Z',
      sourceHash: 'a'.repeat(64), destinationHash: 'b'.repeat(64),
      reason: 'equal_timestamp_different_hash'
    });
    const stored = mockStore.get(conflictRecordKey({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' }));
    const serialized = JSON.stringify([record, stored]);
    expect(serialized).not.toContain('summary');
    expect(serialized).not.toContain('description');
    expect(serialized).not.toContain('comment');
    expect(stored).toEqual(expect.objectContaining({
      decision: 'conflict',
      reason: 'equal_timestamp_different_hash'
    }));
  });

  test('31. uncertain cases are not falsely labeled as definite conflicts', () => {
    expect(detectDestinationConflict({
      expectedDestinationHash: null,
      observedDestinationHash: 'abc',
      sourceHash: 'new',
      lastSourceHash: 'old'
    })).toEqual(expect.objectContaining({ conflict: false, reason: 'insufficient-evidence' }));

    expect(detectDestinationConflict({
      expectedDestinationHash: 'abc',
      observedDestinationHash: 'abc',
      sourceHash: 'new',
      lastSourceHash: 'old'
    })).toEqual(expect.objectContaining({ conflict: false }));
  });
});

describe('Batch 4 mapping consistency', () => {
  test('32. a matching existing mapping is idempotent', async () => {
    mockStore.set('org-1:local-to-remote:LOCAL-1', 'REMOTE-1');
    mockStore.set('org-1:remote-to-local:REMOTE-1', 'LOCAL-1');
    const result = await storeMapping('LOCAL-1', 'REMOTE-1', 'org-1');
    expect(result.idempotent).toBe(true);
    expect(mockStore.get('org-1:local-to-remote:LOCAL-1')).toBe('REMOTE-1');
  });

  test('33. a conflicting mapping is rejected without overwrite', async () => {
    mockStore.set('org-1:local-to-remote:LOCAL-1', 'REMOTE-OLD');
    await expect(storeMapping('LOCAL-1', 'REMOTE-1', 'org-1'))
      .rejects.toEqual(expect.objectContaining({ code: 'MAPPING_CONFLICT' }));
    expect(mockStore.get('org-1:local-to-remote:LOCAL-1')).toBe('REMOTE-OLD');
  });

  test('34. forward and reverse mappings remain consistent', async () => {
    await storeMapping('LOCAL-1', 'REMOTE-1', 'org-1');
    expect(mockStore.get('org-1:local-to-remote:LOCAL-1')).toBe('REMOTE-1');
    expect(mockStore.get('org-1:remote-to-local:REMOTE-1')).toBe('LOCAL-1');
    expect(mockTransactionWrites.map(([key]) => key)).toEqual([
      'org-1:local-to-remote:LOCAL-1',
      'org-1:remote-to-local:REMOTE-1',
      'mapping-meta:org-1:LOCAL-1'
    ]);
  });

  test('35. a partial mapping failure is detectable and repairable', async () => {
    kvsStore.transaction.mockImplementation(() => {
      const tx = {
        set: jest.fn(() => tx),
        execute: jest.fn(async () => { throw new Error('transaction unavailable'); })
      };
      return tx;
    });
    kvsStore.set.mockImplementation(async (key, value) => {
      if (key === 'org-1:local-to-remote:LOCAL-1') {
        throw new Error('storage failed');
      }
      mockStore.set(key, value);
    });

    await expect(storeMapping('LOCAL-1', 'REMOTE-1', 'org-1'))
      .rejects.toThrow('Partial mapping write requires repair');

    expect(await getMappingRepairRecord('LOCAL-1', 'REMOTE-1', 'org-1'))
      .toEqual(expect.objectContaining({ reason: 'partial-mapping-write' }));

    kvsStore.set.mockImplementation(async (key, value) => { mockStore.set(key, value); });
    const repaired = await ensureMappingPair('LOCAL-1', 'REMOTE-1', 'org-1');
    expect(repaired.repaired).toBe(true);
    expect(mockStore.get('org-1:local-to-remote:LOCAL-1')).toBe('REMOTE-1');
  });

  test('36. no summary-based association is introduced', async () => {
    mockStore.set('org-1:local-to-remote:LOCAL-1', 'REMOTE-1');
    mockStore.set('org-1:remote-to-local:REMOTE-1', 'LOCAL-1');
    await storeMapping('LOCAL-1', 'REMOTE-1', 'org-1');
    expect(kvsStore.get).not.toHaveBeenCalledWith(expect.stringContaining('summary'));
    expect(isValidIssueKey('LOCAL-1')).toBe(true);
    expect(isValidIssueKey('not an issue key')).toBe(false);
  });
});


describe('Batch 4 webhook duplicate fingerprints', () => {
  function updatedPayload(timestamp, updated = 'changed') {
    return {
      webhookEvent: 'jira:issue_updated',
      timestamp,
      issue: { id: '10001', key: 'REMOTE-1', fields: { summary: updated, updated: new Date(timestamp).toISOString() } }
    };
  }

  test('37. the same reliable webhook event is suppressed after completion', async () => {
    const payload = updatedPayload(1780000000000);
    const first = await claimWebhookEvent(payload, 'org-1');
    expect(first.status).toBe('claimed');
    await markWebhookCompleted(first.key, first.token);

    const retry = await claimWebhookEvent(payload, 'org-1');
    expect(retry.status).toBe('completed');
  });

  test('38. distinct updates to the same issue both process', () => {
    expect(buildWebhookFingerprint(updatedPayload(1780000000000), 'org-1'))
      .not.toBe(buildWebhookFingerprint(updatedPayload(1780000001000), 'org-1'));
  });

  test('39. failed processing permits retry', async () => {
    const payload = updatedPayload(1780000002000);
    const claim = await claimWebhookEvent(payload, 'org-1');
    await releaseWebhookEvent(claim.key, claim.token);
    const retry = await claimWebhookEvent(payload, 'org-1');
    expect(retry.status).toBe('claimed');
  });

  test('40. a processing lease prevents concurrent duplicate execution', async () => {
    const payload = updatedPayload(1780000003000);
    const first = await claimWebhookEvent(payload, 'org-1');
    const second = await claimWebhookEvent(payload, 'org-1');
    expect(first.status).toBe('claimed');
    expect(second.status).toBe('processing');
  });

  test('41. events without stable identity remain untracked', () => {
    expect(buildWebhookFingerprint({
      webhookEvent: 'jira:issue_updated',
      issue: { fields: { updated: '2026-10-21T12:00:00.000Z' } }
    }, 'org-1')).toBeNull();
    expect(buildWebhookFingerprint({
      webhookEvent: 'comment_created',
      issue: { id: '10001', key: 'REMOTE-1' },
      comment: { body: 'no id' }
    }, 'org-1')).toBeNull();
  });

  test('42. existing native Jira path authentication still parses the opaque path', () => {
    expect(parseWebhookUserPath('/org-1/abcdefghijklmnop')).toEqual({
      orgId: 'org-1',
      credential: 'abcdefghijklmnop'
    });
    expect(parseWebhookUserPath('/org-1/abcdefghijklmnop?secret=leak')).toBeNull();
  });

  test('43. Forge response headers remain array-valued', async () => {
    const response = await runWebhook({ method: 'GET', headers: {}, queryParameters: {}, userPath: '' });
    expect(response.statusCode).toBe(405);
    expect(response.headers['Content-Type']).toEqual(['application/json']);
  });
});
