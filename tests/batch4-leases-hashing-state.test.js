import { entities, state, requests } from './helpers/forge-lease-runtime';
const mockStore = new Map();

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
  setWithTtl: jest.fn(async (key, value) => { mockStore.set(key, value); })
}));

jest.mock('../src/services/storage/stats.js', () => ({
  logAuditEntry: jest.fn(async () => undefined),
  trackWebhookSync: jest.fn(),
  trackApiCall: jest.fn()
}));

import * as kvsStore from '../src/services/storage/kvs.js';
import {
  acquireIssueLease,
  releaseIssueLease,
  withIssueLease,
  buildIssueLeaseKey,
  issueLeaseEntityKey,
  DEFAULT_ISSUE_LEASE_TTL_SECONDS
} from '../src/services/sync/issue-lease.js';
import {
  hashSynchronizedFields,
  buildNormalizedSynchronizedFields,
  normalizeDescriptionForHash
} from '../src/services/sync/field-normalization.js';
import {
  recordDestinationWrite,
  findAppCausedEcho,
  echoMarkerKey,
  getLatestAccepted,
  recordLatestAccepted,
  evaluateStaleEvent
} from '../src/services/sync/sync-state.js';
import { prependCrossReferenceToADF } from '../src/utils/adf.js';

const ADF_A = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Alpha' }] }] };
const ADF_B = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Beta' }] }] };

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
});

describe('Batch 4 per-issue leases', () => {
  test('F07: successor survives replacement between release read and delete', async () => {
    const oldLease = await acquireIssueLease({ orgId: 'org-1', localKey: 'LOCAL-1' });
    let successor;
    state.beforeTransaction = async body => {
      expect(body.delete).toHaveLength(1);
      // Delay A's release request while the expired row is taken over by B.
      successor = await acquireIssueLease({ orgId: 'org-1', localKey: 'LOCAL-1', now: Date.now() + 121000 });
    };

    await releaseIssueLease({ key: oldLease.key, token: oldLease.token });

    expect(successor.acquired).toBe(true);
    expect(entities.get(successor.key)?.leaseToken).toBe(successor.token);
  });

  test('1. first lease acquisition succeeds', async () => {
    const lease = await acquireIssueLease({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' });
    expect(lease).toEqual(expect.objectContaining({ acquired: true, status: 'ACQUIRED' }));
    expect(lease.token).toMatch(/^[a-f0-9]{64}$/);
  });

  test('2. concurrent lease acquisition fails safely', async () => {
    const first = await acquireIssueLease({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' });
    const second = await acquireIssueLease({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' });
    expect(first.acquired).toBe(true);
    expect(second).toEqual(expect.objectContaining({ acquired: false, status: 'SYNC_ALREADY_IN_PROGRESS' }));
  });

  test('3. lease uses a conditional entity create and bounded application expiry', async () => {
    const lease = await acquireIssueLease({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' });
    const creation = requests.find(request => request.body.set)?.body.set[0];
    expect(creation).toMatchObject({ key: lease.key, entityName: 'issue-lease',
      conditions: { and: [{ property: 'leaseToken', condition: 'NOT_EXISTS', values: [true] }] } });
    const stored = entities.get(lease.key);
    expect(stored.expiresAt - Date.now()).toBeLessThanOrEqual(DEFAULT_ISSUE_LEASE_TTL_SECONDS * 1000);
    expect(stored).not.toHaveProperty('description');
    expect(stored).not.toHaveProperty('summary');
    expect(stored.expiresAt).toBeGreaterThan(Date.now());
  });

  test('4. only the matching lease token can release the lease', async () => {
    const lease = await acquireIssueLease({ orgId: 'org-1', localKey: 'LOCAL-1' });
    const wrong = await releaseIssueLease({ key: lease.key, token: '0'.repeat(64) });
    expect(wrong.released).toBe(false);
    expect(entities.has(lease.key)).toBe(true);

    const correct = await releaseIssueLease({ key: lease.key, token: lease.token });
    expect(correct.released).toBe(true);
    expect(entities.has(lease.key)).toBe(false);
  });

  test('5. an old invocation cannot release a newer lease', async () => {
    const oldLease = await acquireIssueLease({ orgId: 'org-1', localKey: 'LOCAL-1' });
    entities.delete(oldLease.key);
    const newLease = await acquireIssueLease({ orgId: 'org-1', localKey: 'LOCAL-1' });

    const released = await releaseIssueLease({ key: oldLease.key, token: oldLease.token });
    expect(released.released).toBe(false);
    expect(entities.get(newLease.key).leaseToken).toBe(newLease.token);
  });

  test('6. storage failure is reported as a storage failure, not a duplicate', async () => {
    state.failure = Object.assign(new Error('quota exceeded'), { code: 'QUOTA' });
    const lease = await acquireIssueLease({ orgId: 'org-1', localKey: 'LOCAL-1' });
    expect(lease).toEqual(expect.objectContaining({ acquired: false, status: 'LEASE_STORAGE_ERROR' }));
  });

  test('7. exceptions release the owned lease', async () => {
    await expect(withIssueLease({ orgId: 'org-1', localKey: 'LOCAL-1' }, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(requests.some(request => request.body.delete?.[0]?.key === issueLeaseEntityKey(buildIssueLeaseKey({ orgId: 'org-1', localKey: 'LOCAL-1' })))).toBe(true);
    expect(entities.size).toBe(0);
  });

  test('8. scheduled and webhook directions contend on the same issue-pair lease', async () => {
    const scheduled = await acquireIssueLease({
      orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', direction: 'local-to-remote'
    });
    const webhook = await acquireIssueLease({
      orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', direction: 'remote-to-local'
    });
    expect(scheduled.acquired).toBe(true);
    expect(webhook.status).toBe('SYNC_ALREADY_IN_PROGRESS');
  });
});


describe('Batch 4 persistent loop prevention', () => {
  test('9. an exact app-caused echo is skipped', async () => {
    const hash = hashSynchronizedFields(ADF_A);
    await recordDestinationWrite({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', direction: 'remote-to-local', observedSide: 'local', fieldHash: hash });
    const result = await findAppCausedEcho({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', observedSide: 'local', fieldHash: hash });
    expect(result.echo).toBe(true);
  });

  test('10. a genuine user edit immediately after sync is not skipped', async () => {
    await recordDestinationWrite({
      orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', direction: 'remote-to-local',
      observedSide: 'local', fieldHash: hashSynchronizedFields({ summary: 'synced' })
    });
    const result = await findAppCausedEcho({
      orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', observedSide: 'local',
      fieldHash: hashSynchronizedFields({ summary: 'user edit' })
    });
    expect(result.echo).toBe(false);
  });

  test('11. a cross-reference-only echo does not loop', async () => {
    const withRef = prependCrossReferenceToADF(ADF_A, 'LOCAL-1', 'REMOTE-1', 'A', 'B');
    const originalHash = hashSynchronizedFields({ description: ADF_A });
    const crossRefHash = hashSynchronizedFields({ description: withRef });
    expect(crossRefHash).toBe(originalHash);

    await recordDestinationWrite({
      orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1',
      direction: 'local-to-remote', observedSide: 'local', fieldHash: crossRefHash
    });
    const result = await findAppCausedEcho({
      orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', observedSide: 'local', fieldHash: originalHash
    });
    expect(result.echo).toBe(true);
  });

  test('12. a different description is not treated as the same update', () => {
    expect(hashSynchronizedFields({ description: ADF_A }))
      .not.toBe(hashSynchronizedFields({ description: ADF_B }));
  });

  test('13. loop markers contain only hashes and safe metadata', async () => {
    await recordDestinationWrite({
      orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', direction: 'local-to-remote',
      observedSide: 'remote', fieldHash: hashSynchronizedFields(ADF_A)
    });
    const marker = mockStore.get(echoMarkerKey({
      orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', observedSide: 'remote'
    }));
    expect(Object.keys(marker).sort()).toEqual([
      'createdAt', 'direction', 'expiresAt', 'fieldHash', 'localKey',
      'observedSide', 'orgId', 'remoteKey', 'sourceUpdated'
    ]);
    expect(JSON.stringify(marker)).not.toContain('Alpha');
  });

  test('14. process-local state is not the only loop-prevention mechanism', async () => {
    const hash = hashSynchronizedFields(ADF_A);
    await recordDestinationWrite({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', observedSide: 'local', fieldHash: hash });
    kvsStore.get.mockClear();
    await findAppCausedEcho({ orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', observedSide: 'local', fieldHash: hash });
    expect(kvsStore.get).toHaveBeenCalledWith(expect.stringContaining('sync-echo:org-1'));
  });
});

describe('Batch 4 stale-event rules', () => {
  const latest = { sourceUpdated: '2026-10-21T12:00:00.000Z', fieldHash: 'hash-a' };

  test('15. a newer event is applied', () => {
    expect(evaluateStaleEvent({ latest, sourceUpdated: '2026-10-21T12:00:01.000Z', fieldHash: 'hash-b' }).decision).toBe('apply');
  });

  test('16. an older event is skipped as stale', () => {
    expect(evaluateStaleEvent({ latest, sourceUpdated: '2026-10-21T11:59:59.000Z', fieldHash: 'hash-b' }))
      .toEqual(expect.objectContaining({ decision: 'stale', status: 'SYNC_STALE_EVENT' }));
  });

  test('17. equal timestamp and equal hash is a duplicate', () => {
    expect(evaluateStaleEvent({ latest, sourceUpdated: latest.sourceUpdated, fieldHash: 'hash-a' }).decision).toBe('duplicate');
  });

  test('18. equal timestamp and different hash is a conflict', () => {
    expect(evaluateStaleEvent({ latest, sourceUpdated: latest.sourceUpdated, fieldHash: 'hash-b' }))
      .toEqual(expect.objectContaining({ decision: 'conflict', status: 'SYNC_CONFLICT_REVIEW_REQUIRED' }));
  });

  test('20. missing timestamps do not produce false stale decisions', () => {
    expect(evaluateStaleEvent({ latest, sourceUpdated: null, fieldHash: 'hash-b' }))
      .toEqual(expect.objectContaining({ decision: 'unverified' }));
  });

  test('21. local-to-remote and remote-to-local timestamps are independent', async () => {
    await recordLatestAccepted({
      orgId: 'org-1', direction: 'local-to-remote', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1',
      sourceUpdated: '2026-10-21T12:00:00.000Z', fieldHash: 'hash-a'
    });
    const local = await getLatestAccepted({ orgId: 'org-1', direction: 'local-to-remote', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' });
    const remote = await getLatestAccepted({ orgId: 'org-1', direction: 'remote-to-local', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' });
    expect(local.sourceUpdated).toBe('2026-10-21T12:00:00.000Z');
    expect(remote).toBeNull();
  });
});


describe('Batch 4 field normalization and hashing', () => {
  test('22. equivalent supported fields produce the same hash', () => {
    const left = { summary: 'Same', labels: ['a', 'b'], priority: { name: 'High' }, duedate: '2026-01-01' };
    const right = { summary: 'Same', labels: ['b', 'a'], priority: { name: 'High' }, duedate: '2026-01-01' };
    expect(hashSynchronizedFields(left)).toBe(hashSynchronizedFields(right));
  });

  test('23. unordered labels/components/versions normalize consistently', () => {
    const left = {
      labels: ['z', 'a'],
      components: [{ name: 'UI' }, { name: 'API' }],
      fixVersions: [{ name: '2.0' }, { name: '1.0' }],
      versions: [{ name: 'B' }, { name: 'A' }]
    };
    const right = {
      labels: ['a', 'z'],
      components: [{ name: 'API' }, { name: 'UI' }],
      fixVersions: [{ name: '1.0' }, { name: '2.0' }],
      versions: [{ name: 'A' }, { name: 'B' }]
    };
    expect(hashSynchronizedFields(left)).toBe(hashSynchronizedFields(right));
  });

  test('24. different user content produces a different hash', () => {
    expect(hashSynchronizedFields({ summary: 'One' })).not.toBe(hashSynchronizedFields({ summary: 'Two' }));
    expect(hashSynchronizedFields({ description: ADF_A })).not.toBe(hashSynchronizedFields({ description: ADF_B }));
  });

  test('25. normalization does not mutate the input', () => {
    const input = {
      labels: ['b', 'a'],
      components: [{ name: 'UI' }],
      description: ADF_A,
      customfield_10001: { b: 2, a: 1 }
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    buildNormalizedSynchronizedFields(input, { customFieldIds: ['customfield_10001'] });
    expect(input).toEqual(snapshot);
  });

  test('26. cross-reference boilerplate does not create repeated hash differences', () => {
    const once = prependCrossReferenceToADF(ADF_A, 'LOCAL-1', 'REMOTE-1', 'A', 'B');
    const twice = prependCrossReferenceToADF(once, 'LOCAL-1', 'REMOTE-1', 'A', 'B');
    expect(hashSynchronizedFields({ description: once })).toBe(hashSynchronizedFields({ description: twice }));
  });

  test('27. ADF content and marks are handled deterministically', () => {
    const marked = {
      type: 'doc', version: 1, content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'Bold', marks: [{ type: 'strong' }, { type: 'em' }] }]
      }]
    };
    const reordered = {
      type: 'doc', version: 1, content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'Bold', marks: [{ type: 'em' }, { type: 'strong' }] }]
      }]
    };
    expect(hashSynchronizedFields({ description: marked })).toBe(hashSynchronizedFields({ description: reordered }));
    const unmarked = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bold' }] }] };
    expect(hashSynchronizedFields({ description: marked })).not.toBe(hashSynchronizedFields({ description: unmarked }));
  });

function linkDescription(href) {
  return {
    type: 'doc',
    version: 1,
    content: [{
      type: 'paragraph',
      content: [{
        type: 'text',
        text: 'documentation',
        marks: [{ type: 'link', attrs: { href } }]
      }]
    }]
  };
}

describe('Batch 4 ADF semantic links and malformed descriptions', () => {
  test('28. different href values with the same link text produce different hashes', () => {
    expect(hashSynchronizedFields({ description: linkDescription('https://site-a.example') }))
      .not.toBe(hashSynchronizedFields({ description: linkDescription('https://site-b.example') }));
  });

  test('29. equivalent href values produce the same hash', () => {
    expect(hashSynchronizedFields({ description: linkDescription('https://same.example/path') }))
      .toBe(hashSynchronizedFields({ description: linkDescription('https://same.example/path\r\n') }));
  });

  test('30. volatile media display URLs do not affect the hash', () => {
    const media = (url) => ({
      type: 'doc',
      version: 1,
      content: [{
        type: 'mediaSingle',
        content: [{
          type: 'media',
          attrs: { id: 'media-123', type: 'file', collection: 'content', url }
        }]
      }]
    });
    expect(hashSynchronizedFields({ description: media('https://download.example/a.png') }))
      .toBe(hashSynchronizedFields({ description: media('https://download.example/b.png') }));
  });

  test('31. malformed non-empty description does not hash like a genuinely empty description', () => {
    const malformed = { type: 'doc', version: 1, content: 'not-an-array' };
    const empty = { type: 'doc', version: 1, content: [] };
    expect(normalizeDescriptionForHash(malformed)).toEqual({ type: 'unsupported-description' });
    expect(hashSynchronizedFields({ description: malformed }))
      .not.toBe(hashSynchronizedFields({ description: empty }));
    expect(hashSynchronizedFields({ description: null }))
      .toBe(hashSynchronizedFields({ description: '' }));
  });

  test('32. a genuine remote edit immediately after outbound sync is not skipped', async () => {
    const synced = { summary: 'synced summary', labels: ['a'] };
    await recordDestinationWrite({
      orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1',
      direction: 'local-to-remote', observedSide: 'remote',
      fieldHash: hashSynchronizedFields(synced)
    });
    const result = await findAppCausedEcho({
      orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', observedSide: 'remote',
      fieldHash: hashSynchronizedFields({ summary: 'remote user edit', labels: ['a'] })
    });
    expect(result.echo).toBe(false);
  });

  test('33. markers never contain href values or description content', async () => {
    await recordDestinationWrite({
      orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1',
      direction: 'local-to-remote', observedSide: 'remote',
      fieldHash: hashSynchronizedFields({ description: linkDescription('https://secret.example/path') })
    });
    const marker = mockStore.get(echoMarkerKey({
      orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1', observedSide: 'remote'
    }));
    expect(JSON.stringify(marker)).not.toContain('secret.example');
    expect(JSON.stringify(marker)).not.toContain('documentation');
    expect(Object.keys(marker)).not.toContain('description');
  });
});

});
