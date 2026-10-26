/**
 * Read-only pairing-witness migration preview.
 *
 * Storage, the Forge installation identity, the pause and both Jira sites are
 * modelled, so the assertions describe the deployed behaviour: the preview
 * classifies pairs without writing anything, and an unreadable witness is never
 * downgraded to "missing".
 */
import { resetStore, seed, store } from './helpers/pair-witness-store.js';
import {
  PAIR_WITNESS_PAIR_CLASSES,
  PAIR_WITNESS_PREVIEW_ERRORS,
  PAIR_WITNESS_PREVIEW_LIMITATIONS,
  classifyPair,
  findDuplicateDestinations,
  previewPairWitnessMigration
} from '../src/services/sync/pair-witness-preview.js';
import {
  PAIR_WITNESS_ISSUE_CLASSES,
  PAIR_WITNESS_READ_CLASSES
} from '../src/services/sync/pair-witness.js';

jest.mock('../src/services/storage/kvs.js', () => require('./helpers/pair-witness-store.js').kvsModule);
jest.mock('@forge/api', () => ({
  __esModule: true,
  default: { asApp: () => ({ requestJira: jest.fn() }), asUser: () => ({ requestJira: jest.fn() }) },
  getAppContext: jest.fn(),
  route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
  fetch: jest.fn()
}));

const ORG_ID = 'org-1';
const INSTALLATION_ID = '974910c5-2861-4d40-a7eb-37802842d0a0';
const APP_ID = '362d8e6b-b68c-4403-8020-d32ddcc02716';
const CLOUD_ID = '11111111-2222-4333-8444-555555555555';
const REMOTE_SITE = 'remote.atlassian.net';

const ORGANIZATION = {
  id: ORG_ID,
  name: 'Primary organization',
  remoteUrl: 'https://remote.atlassian.net',
  remoteEmail: 'sync@example.com',
  remoteApiToken: 'remote-token',
  syncDirection: 'bidirectional'
};

function pairRecord(localKey, remoteKey) {
  return { localKey, remoteKey, orgId: ORG_ID, updatedAt: '2026-10-26T08:00:00.000Z' };
}

/** Seeds a fully consistent stored pair. */
function seedPair(localKey, remoteKey, overrides = {}) {
  seed(`mapping-meta:${ORG_ID}:${localKey}`, pairRecord(localKey, remoteKey));
  seed(`${ORG_ID}:local-to-remote:${localKey}`, overrides.forward ?? remoteKey);
  seed(`${ORG_ID}:remote-to-local:${remoteKey}`, overrides.reverse ?? localKey);
}

const present = (id, key) => ({
  class: PAIR_WITNESS_ISSUE_CLASSES.PRESENT,
  statusCode: 200,
  id,
  key
});

const absentWitness = { class: PAIR_WITNESS_READ_CLASSES.ABSENT, code: 'PAIR_WITNESS_NOT_FOUND', statusCode: 404, pairId: null, state: null };
const matchingWitness = (pairId) => ({
  class: PAIR_WITNESS_READ_CLASSES.MATCHING,
  code: null,
  statusCode: 200,
  pairId,
  state: 'active'
});

function deps(overrides = {}) {
  const issues = overrides.issues || {};
  const witnesses = overrides.witnesses || {};
  return {
    getStored: store.get,
    queryPage: store.queryPageByPrefix,
    readPause: async () => ({ paused: true, reasonCode: 'emergency_stop', pausedAt: '2026-10-26T09:00:00.000Z' }),
    readIdentity: async () => ({
      readable: true,
      appId: APP_ID,
      environmentId: '2e8c0cb5-881a-4345-b9ba-e887f790d316',
      installationId: INSTALLATION_ID,
      cloudIds: [CLOUD_ID],
      siteHost: 'local.atlassian.net'
    }),
    getOrganizations: async () => [ORGANIZATION],
    resolveIssue: async ({ side, issueRef }) => {
      const entry = issues[`${side}:${issueRef}`];
      if (entry) return entry;
      return present(side === 'local' ? '10001' : '20881', issueRef);
    },
    readWitness: async ({ side, issueRef }) => witnesses[`${side}:${issueRef}`] || absentWitness,
    now: () => Date.parse('2026-10-26T10:00:00.000Z'),
    ...overrides.deps
  };
}

beforeEach(() => {
  resetStore();
});


const previewPairWitnessPreview = (options) => previewPairWitnessMigration({
  orgId: ORG_ID,
  deps: options.deps
});

describe('classification', () => {
  test('a consistent pair with no witness on either side is ready to witness', async () => {
    seedPair('LOCAL-1', 'REMOT-1');

    const result = await previewPairWitnessPreview({ deps: deps() });

    expect(result.success).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.counts.pairsScanned).toBe(1);
    expect(result.counts.readyToWitness).toBe(1);
    expect(result.pairs[0].pairClass).toBe(PAIR_WITNESS_PAIR_CLASSES.READY);
    expect(result.witnesses).toMatchObject({ absent: 2, matching: 0 });
    expect(result.cost).toMatchObject({
      jiraIssueReads: 2,
      jiraPropertyReads: 2,
      jiraReads: 4,
      witnessWritesPerformed: 0,
      jiraIssuesCreated: 0,
      witnessWritesProjected: 2
    });
  });

  test('a pair with a matching witness on both sides is already witnessed', async () => {
    seedPair('LOCAL-1', 'REMOT-1');

    const result = await previewPairWitnessPreview({
      deps: deps({
        witnesses: {
          'local:10001': matchingWitness('3f6c1a8e-9b21-4f0d-9d4e-6a1b2c3d4e5f'),
          'remote:20881': matchingWitness('3f6c1a8e-9b21-4f0d-9d4e-6a1b2c3d4e5f')
        }
      })
    });

    expect(result.counts.alreadyWitnessed).toBe(1);
    expect(result.findings).toEqual([]);
    expect(result.cost.witnessWritesProjected).toBe(0);
  });

  test('a witness on one side only is partially witnessed', async () => {
    seedPair('LOCAL-1', 'REMOT-1');

    const result = await previewPairWitnessPreview({
      deps: deps({
        witnesses: { 'local:10001': matchingWitness('3f6c1a8e-9b21-4f0d-9d4e-6a1b2c3d4e5f') }
      })
    });

    expect(result.counts.partiallyWitnessed).toBe(1);
    expect(result.cost.witnessWritesProjected).toBe(1);
  });

  test('a malformed witness is a conflict, not a missing witness', async () => {
    seedPair('LOCAL-1', 'REMOT-1');

    const result = await previewPairWitnessPreview({
      deps: deps({
        witnesses: {
          'local:10001': { class: PAIR_WITNESS_READ_CLASSES.MALFORMED, code: 'PAIR_WITNESS_MALFORMED', statusCode: 200 }
        }
      })
    });

    expect(result.counts.witnessConflict).toBe(1);
    expect(result.counts.readyToWitness).toBe(0);
    expect(result.witnesses.absent).toBe(1);
    expect(result.findings[0]).toMatchObject({ code: 'witness-conflict', localKey: 'LOCAL-1' });
    expect(result.findings[0].detail).toContain('local:malformed');
  });

  test('a foreign organization witness is a conflict', async () => {
    seedPair('LOCAL-1', 'REMOT-1');

    const result = await previewPairWitnessPreview({
      deps: deps({
        witnesses: {
          'remote:20881': {
            class: PAIR_WITNESS_READ_CLASSES.FOREIGN_ORGANIZATION,
            code: 'PAIR_WITNESS_FOREIGN_ORGANIZATION'
          }
        }
      })
    });

    expect(result.counts.witnessConflict).toBe(1);
  });

  test('an ended witness is reported as ended, never as deletable', async () => {
    seedPair('LOCAL-1', 'REMOT-1');

    const result = await previewPairWitnessPreview({
      deps: deps({
        witnesses: { 'local:10001': { class: PAIR_WITNESS_READ_CLASSES.ENDED, state: 'ended' } }
      })
    });

    expect(result.counts.witnessEnded).toBe(1);
    expect(result.witnesses.ended).toBe(1);
    expect(PAIR_WITNESS_PREVIEW_LIMITATIONS.join(' ')).toContain('never deleted');
  });

  test('an inaccessible witness is counted separately and never as absent', async () => {
    seedPair('LOCAL-1', 'REMOT-1');

    const result = await previewPairWitnessPreview({
      deps: deps({
        witnesses: {
          'local:10001': {
            class: PAIR_WITNESS_READ_CLASSES.INACCESSIBLE,
            code: 'PAIR_WITNESS_INACCESSIBLE',
            statusCode: 403
          }
        }
      })
    });

    expect(result.counts.witnessInaccessible).toBe(1);
    expect(result.witnesses.inaccessible).toBe(1);
    expect(result.witnesses.absent).toBe(1);
    expect(result.counts.readyToWitness).toBe(0);
  });

  test('an unverifiable witness is counted separately and never as absent', async () => {
    seedPair('LOCAL-1', 'REMOT-1');

    const result = await previewPairWitnessPreview({
      deps: deps({
        witnesses: {
          'remote:20881': { class: PAIR_WITNESS_READ_CLASSES.UNVERIFIABLE, code: 'PAIR_WITNESS_RATE_LIMITED' }
        }
      })
    });

    expect(result.counts.witnessUnverifiable).toBe(1);
    expect(result.witnesses.unverifiable).toBe(1);
  });

  test('a missing counterpart is reported, and no property is read on that side', async () => {
    seedPair('LOCAL-1', 'REMOT-1');

    const result = await previewPairWitnessPreview({
      deps: deps({
        issues: { 'remote:REMOT-1': { class: PAIR_WITNESS_ISSUE_CLASSES.MISSING, statusCode: 404 } }
      })
    });

    expect(result.counts.counterpartMissing).toBe(1);
    expect(result.cost.jiraIssueReads).toBe(2);
    expect(result.cost.jiraPropertyReads).toBe(1);
    expect(result.pairs[0].remote.witness.class).toBeNull();
  });

  test('an inaccessible counterpart is not reported as missing', async () => {
    seedPair('LOCAL-1', 'REMOT-1');

    const result = await previewPairWitnessPreview({
      deps: deps({
        issues: {
          'local:LOCAL-1': { class: PAIR_WITNESS_ISSUE_CLASSES.INACCESSIBLE, statusCode: 403 }
        }
      })
    });

    expect(result.counts.counterpartInaccessible).toBe(1);
    expect(result.counts.counterpartMissing).toBe(0);
  });

  test('an unverifiable counterpart is unverified', async () => {
    seedPair('LOCAL-1', 'REMOT-1');

    const result = await previewPairWitnessPreview({
      deps: deps({
        issues: { 'local:LOCAL-1': { class: PAIR_WITNESS_ISSUE_CLASSES.UNVERIFIABLE, statusCode: 429 } }
      })
    });

    expect(result.counts.unverified).toBe(1);
  });
});

describe('storage refusals are decided without spending Jira quota', () => {
  test('a direction mismatch blocks the pair and reads no Jira issue', async () => {
    seedPair('LOCAL-1', 'REMOT-1', { reverse: 'LOCAL-2' });

    const result = await previewPairWitnessPreview({ deps: deps() });

    expect(result.counts.mappingMismatch).toBe(1);
    expect(result.pairs[0].jiraReadSkipped).toBe(true);
    expect(result.cost.jiraReads).toBe(0);
    expect(result.findings[0]).toMatchObject({ code: 'mapping-mismatch', localKey: 'LOCAL-1' });
  });

  test('a pending create ledger row is in doubt and blocks classification', async () => {
    seedPair('LOCAL-1', 'REMOT-1');
    seed(`issue-create-op:${ORG_ID}:local-to-remote:LOCAL-1`, {
      state: 'pending',
      targetKey: null,
      createdAt: '2026-10-26T09:00:00.000Z'
    });

    const result = await previewPairWitnessPreview({ deps: deps() });

    expect(result.counts.createInDoubt).toBe(1);
    expect(result.pairs[0].ledger).toMatchObject({ state: 'pending', inDoubt: true });
    expect(result.cost.jiraReads).toBe(0);
  });

  test('an unknown create ledger row is in doubt', async () => {
    seedPair('LOCAL-1', 'REMOT-1');
    seed(`issue-create-op:${ORG_ID}:remote-to-local:REMOT-1`, {
      state: 'unknown',
      targetKey: null,
      createdAt: '2026-10-26T09:00:00.000Z'
    });

    const result = await previewPairWitnessPreview({ deps: deps() });

    expect(result.counts.createInDoubt).toBe(1);
  });

  test('a succeeded ledger row does not block a witnessable pair', async () => {
    seedPair('LOCAL-1', 'REMOT-1');
    seed(`issue-create-op:${ORG_ID}:local-to-remote:LOCAL-1`, {
      state: 'succeeded',
      targetKey: 'REMOT-1',
      createdAt: '2026-10-26T09:00:00.000Z'
    });

    const result = await previewPairWitnessPreview({ deps: deps() });

    expect(result.counts.readyToWitness).toBe(1);
    expect(result.counts.createInDoubt).toBe(0);
  });

  test('an ended pair is reported as ended and is never repaired', async () => {
    seedPair('LOCAL-1', 'REMOT-1');
    seed(`mapping-ended:${ORG_ID}:LOCAL-1:REMOT-1`, {
      localKey: 'LOCAL-1',
      remoteKey: 'REMOT-1',
      endedAt: '2026-10-25T09:00:00.000Z'
    });

    const result = await previewPairWitnessPreview({ deps: deps() });

    expect(result.counts.pairEnded).toBe(1);
    expect(result.cost.jiraReads).toBe(0);
    expect(result.cost.witnessWritesProjected).toBe(0);
  });

  test('a mapping repair record is reported and blocks the pair', async () => {
    seedPair('LOCAL-1', 'REMOT-1');
    seed(`mapping-repair:${ORG_ID}:LOCAL-1:REMOT-1`, {
      reason: 'partial-mapping-write',
      detectedAt: '2026-10-25T09:00:00.000Z'
    });

    const result = await previewPairWitnessPreview({ deps: deps() });

    expect(result.counts.repairRequired).toBe(1);
    expect(result.cost.jiraReads).toBe(0);
  });

  test('an unreadable mapping record is recorded instead of aborting the preview', async () => {
    seed(`mapping-meta:${ORG_ID}:LOCAL-1`, { localKey: 'OTHER-1', remoteKey: 'REMOT-1' });

    const result = await previewPairWitnessPreview({ deps: deps() });

    expect(result.counts.invalidRecords).toBe(1);
    expect(result.findings[0]).toMatchObject({ detail: 'invalid-mapping-record' });
    expect(result.counts.pairsScanned).toBe(0);
  });
});

describe('duplicate destinations and bounded scans', () => {
  test('two local issues claiming one remote issue are reported as duplicates', async () => {
    seedPair('LOCAL-1', 'REMOT-1');
    seedPair('LOCAL-2', 'REMOT-1');

    const result = await previewPairWitnessPreview({ deps: deps() });

    expect(result.counts.duplicateDestination).toBe(2);
    expect(result.duplicates).toEqual([{ remoteKey: 'REMOT-1', localKeys: ['LOCAL-1', 'LOCAL-2'] }]);
    expect(result.cost.witnessWritesProjected).toBe(0);
    for (const pair of result.pairs) {
      expect(pair.pairClass).toBe(PAIR_WITNESS_PAIR_CLASSES.DUPLICATE_DESTINATION);
      expect(typeof pair.basePairClass).toBe('string');
    }
  });

  test('a duplicate is never surfaced as ready to witness', async () => {
    seedPair('LOCAL-1', 'REMOT-1');
    seedPair('LOCAL-2', 'REMOT-1');

    const result = await previewPairWitnessPreview({ deps: deps() });

    expect(result.counts.readyToWitness).toBe(0);
    expect(result.findings.filter((f) => f.code === 'duplicate-destination')).toHaveLength(2);
  });

  test('the scan is bounded and reports truncation instead of completeness', async () => {
    seedPair('LOCAL-1', 'REMOT-1');
    seedPair('LOCAL-2', 'REMOT-2');
    seedPair('LOCAL-3', 'REMOT-3');

    const result = await previewPairWitnessMigration({ orgId: ORG_ID, maxPairs: 2, deps: deps() });

    expect(result.limits.maxPairs).toBe(2);
    expect(result.limits.pairsListed).toBe(2);
    expect(result.limits.truncated).toBe(true);
    expect(result.counts.pairsScanned).toBe(2);
  });

  test('a complete scan is not reported as truncated', async () => {
    seedPair('LOCAL-1', 'REMOT-1');

    const result = await previewPairWitnessPreview({ deps: deps() });

    expect(result.limits.truncated).toBe(false);
  });

  test('the requested pair limit is clamped to the supported maximum', async () => {
    const result = await previewPairWitnessMigration({ orgId: ORG_ID, maxPairs: 100000, deps: deps() });

    expect(result.limits.maxPairs).toBe(200);
  });
});

describe('stable ids, not keys, prove a pair', () => {
  test('a moved issue keeps the pair and is reported as key drift', async () => {
    seedPair('LOCAL-1', 'REMOT-1');

    const result = await previewPairWitnessPreview({
      deps: deps({
        issues: {
          'local:LOCAL-1': {
            class: PAIR_WITNESS_ISSUE_CLASSES.PRESENT,
            statusCode: 200,
            id: '10001',
            key: 'MOVED-7'
          }
        }
      })
    });

    expect(result.counts.keyDrift).toBe(1);
    expect(result.counts.readyToWitness).toBe(1);
    expect(result.pairs[0].keyDrift).toEqual({ local: true, remote: false });
    expect(result.pairs[0].local.issue.id).toBe('10001');
  });

  test('the property is read by stable id once the issue is resolved', async () => {
    seedPair('LOCAL-1', 'REMOT-1');
    const seen = [];

    await previewPairWitnessPreview({
      deps: {
        ...deps(),
        readWitness: async (request) => {
          seen.push({
            side: request.side,
            issueRef: request.issueRef,
            issueId: request.expected?.issueId
          });
          return absentWitness;
        }
      }
    });

    expect(seen).toEqual([
      { side: 'local', issueRef: '10001', issueId: '10001' },
      { side: 'remote', issueRef: '20881', issueId: '20881' }
    ]);
  });
});

describe('refusals', () => {
  const expectRefusal = async (options, code) => {
    await expect(previewPairWitnessPreview({ deps: options })).rejects.toMatchObject({ code });
  };

  test('the pause must be in force', async () => {
    await expect(previewPairWitnessMigration({
      orgId: ORG_ID,
      deps: deps({ deps: { readPause: async () => ({ paused: false }) } })
    })).rejects.toMatchObject({ code: PAIR_WITNESS_PREVIEW_ERRORS.REQUIRES_PAUSE });
  });

  test('an unreadable pause is refused rather than assumed', async () => {
    await expect(previewPairWitnessMigration({
      orgId: ORG_ID,
      deps: deps({
        deps: {
          readPause: async () => {
            throw new Error('kvs unavailable');
          }
        }
      })
    })).rejects.toMatchObject({ code: PAIR_WITNESS_PREVIEW_ERRORS.PAUSE_UNREADABLE });
  });

  test('an unreadable installation identity is refused', async () => {
    await expectRefusal(
      deps({ deps: { readIdentity: async () => ({ readable: false, code: 'IDENTITY_CONTEXT_UNAVAILABLE' }) } }),
      PAIR_WITNESS_PREVIEW_ERRORS.IDENTITY_UNAVAILABLE
    );
  });

  test('an unknown organization is refused', async () => {
    await expectRefusal(
      deps({ deps: { getOrganizations: async () => [] } }),
      PAIR_WITNESS_PREVIEW_ERRORS.ORGANIZATION_NOT_FOUND
    );
  });

  test('an organization without a usable remote site or token is refused', async () => {
    await expectRefusal(
      deps({ deps: { getOrganizations: async () => [{ ...ORGANIZATION, remoteApiToken: '' }] } }),
      PAIR_WITNESS_PREVIEW_ERRORS.ORGANIZATION_UNUSABLE
    );
    await expectRefusal(
      deps({ deps: { getOrganizations: async () => [{ ...ORGANIZATION, remoteUrl: 'http://plain.example' }] } }),
      PAIR_WITNESS_PREVIEW_ERRORS.ORGANIZATION_UNUSABLE
    );
  });

  test('an invalid or missing organization identifier is refused without reading storage', async () => {
    await expect(previewPairWitnessMigration({ orgId: 'legacy', deps: deps() }))
      .rejects.toMatchObject({ code: PAIR_WITNESS_PREVIEW_ERRORS.ORGANIZATION_INVALID });
    await expect(previewPairWitnessMigration({ orgId: null, deps: deps() }))
      .rejects.toMatchObject({ code: PAIR_WITNESS_PREVIEW_ERRORS.ORGANIZATION_REQUIRED });
    expect(store.get).not.toHaveBeenCalled();
  });

  test('an unreadable mapping page aborts instead of reporting a partial scan', async () => {
    seedPair('LOCAL-1', 'REMOT-1');
    await expect(previewPairWitnessMigration({
      orgId: ORG_ID,
      deps: deps({
        deps: {
          queryPage: async () => {
            throw new Error('storage page unreadable');
          }
        }
      })
    })).rejects.toMatchObject({ code: PAIR_WITNESS_PREVIEW_ERRORS.STORAGE_UNAVAILABLE });
  });
});

describe('read-only invariants', () => {
  test('a full preview writes nothing to storage and creates no issue', async () => {
    seedPair('LOCAL-1', 'REMOT-1');
    seedPair('LOCAL-2', 'REMOT-2');

    const result = await previewPairWitnessPreview({ deps: deps() });

    expect(result.readOnly).toBe(true);
    expect(store.set).not.toHaveBeenCalled();
    expect(store.del).not.toHaveBeenCalled();
    expect(result.cost.witnessWritesPerformed).toBe(0);
    expect(result.cost.jiraIssuesCreated).toBe(0);
  });

  test('every Jira read is recorded in the cost report', async () => {
    seedPair('LOCAL-1', 'REMOT-1');

    const result = await previewPairWitnessPreview({ deps: deps() });

    expect(result.cost.jiraReads)
      .toBe(result.cost.jiraIssueReads + result.cost.jiraPropertyReads);
    expect(result.cost.localReads).toBe(2);
    expect(result.cost.remoteReads).toBe(2);
    // One extra local read is the installation-identity lookup (serverInfo).
    expect(result.cost.estimatedAppPoints).toBe(result.cost.localReads + 1);
    expect(result.cost.identityLookupReads).toBe(1);
  });

  test('the response carries the limitations an operator must read', async () => {
    seedPair('LOCAL-1', 'REMOT-1');

    const result = await previewPairWitnessPreview({ deps: deps() });

    expect(result.limitations).toEqual(PAIR_WITNESS_PREVIEW_LIMITATIONS);
    expect(result.limitations.join(' ')).toContain('never used as proof of a pairing');
    expect(result.limitations.join(' ')).toContain('The existing ledger stays the authority');
  });
});

describe('pure classification helpers', () => {
  test('storage contradictions outrank witness findings', () => {
    expect(classifyPair({
      mapping: { consistent: false },
      local: { issue: { class: 'present' }, witness: { class: 'matching' } },
      remote: { issue: { class: 'present' }, witness: { class: 'matching' } }
    })).toBe(PAIR_WITNESS_PAIR_CLASSES.MAPPING_MISMATCH);
  });

  test('a conflict outranks a partial witness', () => {
    expect(classifyPair({
      mapping: { consistent: true },
      ledger: {},
      ended: {},
      repaired: {},
      local: { issue: { class: 'present' }, witness: { class: 'matching' } },
      remote: { issue: { class: 'present' }, witness: { class: 'malformed' } }
    })).toBe(PAIR_WITNESS_PAIR_CLASSES.WITNESS_CONFLICT);
  });

  test('duplicate destination grouping is deterministic', () => {
    expect(findDuplicateDestinations([
      { localKey: 'B-2', remoteKey: 'R-9' },
      { localKey: 'A-1', remoteKey: 'R-9' },
      { localKey: 'C-3', remoteKey: 'R-8' }
    ])).toEqual([{ remoteKey: 'R-9', localKeys: ['A-1', 'B-2'] }]);
    expect(findDuplicateDestinations([])).toEqual([]);
  });
});

