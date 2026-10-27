import { resetStore } from './helpers/pair-witness-store.js';
import {
  PAIR_WITNESS_GUARD_CODES,
  PAIR_WITNESS_GUARD_DECISIONS,
  evaluatePairWitnessCreateGuard,
  syncDecisionForGuardCode
} from '../src/services/sync/pair-witness-guard.js';
import {
  buildPairWitness,
  deterministicPairId,
  PAIR_WITNESS_READ_CLASSES,
  PAIR_WITNESS_STATES
} from '../src/services/sync/pair-witness.js';
import { ISSUE_CREATE_DIRECTIONS, ISSUE_CREATE_STATES } from '../src/services/sync/issue-create-operation.js';

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
const LOCAL_SITE = '11111111-2222-4333-8444-555555555555';
const REMOTE_SITE = 'remote.atlassian.net';

const ORG = {
  id: ORG_ID,
  remoteUrl: 'https://remote.atlassian.net',
  remoteEmail: 'sync@example.com',
  remoteApiToken: 'remote-token'
};

const IDENTITY = {
  readable: true,
  appId: APP_ID,
  installationId: INSTALLATION_ID,
  localSite: LOCAL_SITE,
  cloudIds: [LOCAL_SITE]
};

function witness(overrides = {}) {
  const localIssueId = overrides.localIssueId || '10001';
  const remoteIssueId = overrides.remoteIssueId || '20881';
  const base = {
    pairId: deterministicPairId({
      installationId: INSTALLATION_ID,
      orgId: ORG_ID,
      localIssueId,
      remoteIssueId
    }),
    state: PAIR_WITNESS_STATES.ACTIVE,
    installationId: INSTALLATION_ID,
    appId: APP_ID,
    orgId: ORG_ID,
    localSite: LOCAL_SITE,
    remoteSite: REMOTE_SITE,
    localIssueId,
    localKey: 'LOCAL-1',
    remoteIssueId,
    remoteKey: 'REMOT-1',
    direction: 'local-to-remote',
    writtenAt: '2026-10-27T10:00:00.000Z'
  };
  return buildPairWitness({ ...base, ...overrides });
}

const absent = {
  class: PAIR_WITNESS_READ_CLASSES.ABSENT,
  code: 'PAIR_WITNESS_NOT_FOUND',
  statusCode: 404,
  record: null,
  pairId: null,
  state: null
};

function evidence({
  mapping = null,
  ledger = null,
  localWitness = absent,
  remoteWitness = absent,
  localIssue = { class: 'present', statusCode: 200, id: '10001', key: 'LOCAL-1' },
  remoteIssue = { class: 'present', statusCode: 200, id: '20881', key: 'REMOT-1' }
} = {}) {
  return {
    getRemoteKey: jest.fn(async () => mapping),
    getLocalKey: jest.fn(async () => mapping),
    getIssueCreateOperation: jest.fn(async () => ledger),
    readIdentity: jest.fn(async () => IDENTITY),
    readIssue: jest.fn(async ({ side }) => (side === 'local' ? localIssue : remoteIssue)),
    readWitness: jest.fn(async ({ side }) => (side === 'local' ? localWitness : remoteWitness))
  };
}

function guard(deps, overrides = {}) {
  return evaluatePairWitnessCreateGuard({
    orgId: ORG_ID,
    org: ORG,
    direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
    sourceKey: 'LOCAL-1',
    sourceIssueId: '10001',
    identity: IDENTITY,
    deps,
    ...overrides
  });
}

beforeEach(() => {
  resetStore();
});

describe('first-time creation', () => {
  test('no witness and no mapping or ledger allows a legitimate create', async () => {
    const deps = evidence();

    const result = await guard(deps);

    expect(result.decision).toBe(PAIR_WITNESS_GUARD_DECISIONS.ALLOW);
    expect(result.code).toBe(PAIR_WITNESS_GUARD_CODES.NO_WITNESS_EVIDENCE);
  });

  test('legacy scope is reported and skipped, not blocked', async () => {
    const result = await guard(evidence(), { orgId: null });

    expect(result.decision).toBe(PAIR_WITNESS_GUARD_DECISIONS.ALLOW);
    expect(result.code).toBe(PAIR_WITNESS_GUARD_CODES.NOT_APPLICABLE_LEGACY);
  });

  test('an existing mapping blocks before any Jira read', async () => {
    const deps = evidence({ mapping: 'REMOT-9' });

    const result = await guard(deps);

    expect(result.code).toBe(PAIR_WITNESS_GUARD_CODES.MAPPING_PRESENT);
    expect(deps.readWitness).not.toHaveBeenCalled();
  });

  test('a succeeded or unknown ledger blocks before any Jira read', async () => {
    for (const state of [ISSUE_CREATE_STATES.SUCCEEDED, ISSUE_CREATE_STATES.UNKNOWN]) {
      const deps = evidence({ ledger: { state } });
      const result = await guard(deps);
      expect(result.code).toBe(PAIR_WITNESS_GUARD_CODES.LEDGER_IN_DOUBT);
      expect(deps.readWitness).not.toHaveBeenCalled();
    }
  });

  test('an unreadable witness is never treated as absent', async () => {
    const deps = evidence({
      localWitness: {
        class: PAIR_WITNESS_READ_CLASSES.INACCESSIBLE,
        code: 'PAIR_WITNESS_INACCESSIBLE',
        statusCode: 403,
        record: null
      }
    });

    const result = await guard(deps);

    expect(result.code).toBe(PAIR_WITNESS_GUARD_CODES.WITNESS_INACCESSIBLE);
  });
});

describe('witnessed pairs', () => {
  test('two matching witnesses block duplicate creation and expose the counterpart', async () => {
    const record = witness();
    const deps = evidence({
      localWitness: { class: PAIR_WITNESS_READ_CLASSES.MATCHING, statusCode: 200, record, pairId: record.pairId, state: 'active' },
      remoteWitness: { class: PAIR_WITNESS_READ_CLASSES.MATCHING, statusCode: 200, record, pairId: record.pairId, state: 'active' }
    });

    const result = await guard(deps);

    expect(result.decision).toBe(PAIR_WITNESS_GUARD_DECISIONS.BLOCK);
    expect(result.code).toBe(PAIR_WITNESS_GUARD_CODES.PAIR_PROVEN);
    expect(result.counterpartKey).toBe('REMOT-1');
    expect(syncDecisionForGuardCode(result.code)).toBe('duplicate');
  });

  test('a one-sided witness blocks instead of being trusted', async () => {
    const record = witness();
    const result = await guard(evidence({
      localWitness: { class: PAIR_WITNESS_READ_CLASSES.MATCHING, statusCode: 200, record, pairId: record.pairId },
      remoteWitness: absent
    }));

    expect(result.code).toBe(PAIR_WITNESS_GUARD_CODES.COUNTERPART_WITNESS_ABSENT);
  });

  test('a counterpart witness naming a different pair blocks as a conflict', async () => {
    const record = witness();
    const other = witness({ remoteIssueId: '20882', remoteKey: 'REMOT-2' });
    const result = await guard(evidence({
      localWitness: { class: PAIR_WITNESS_READ_CLASSES.MATCHING, statusCode: 200, record, pairId: record.pairId },
      remoteWitness: { class: PAIR_WITNESS_READ_CLASSES.MATCHING, statusCode: 200, record: other, pairId: other.pairId }
    }));

    expect(result.code).toBe(PAIR_WITNESS_GUARD_CODES.COUNTERPART_WITNESS_CONFLICT);
  });

  test('a missing counterpart is never permission to create another one', async () => {
    const record = witness();
    const result = await guard(evidence({
      localWitness: { class: PAIR_WITNESS_READ_CLASSES.MATCHING, statusCode: 200, record, pairId: record.pairId },
      remoteIssue: { class: 'missing', statusCode: 404, id: null, key: null }
    }));

    expect(result.code).toBe(PAIR_WITNESS_GUARD_CODES.COUNTERPART_MISSING);
  });

  test('a pair id that does not derive from its own ids is a conflict', async () => {
    const record = { ...witness(), pairId: '3f6c1a8e-9b21-4f0d-9d4e-6a1b2c3d4e5f' };
    const result = await guard(evidence({
      localWitness: { class: PAIR_WITNESS_READ_CLASSES.MATCHING, statusCode: 200, record, pairId: record.pairId }
    }));

    expect(result.code).toBe(PAIR_WITNESS_GUARD_CODES.WITNESS_PAIR_ID_MISMATCH);
  });

  test.each([
    [PAIR_WITNESS_READ_CLASSES.MALFORMED, PAIR_WITNESS_GUARD_CODES.WITNESS_MALFORMED],
    [PAIR_WITNESS_READ_CLASSES.SCHEMA_NEWER, PAIR_WITNESS_GUARD_CODES.WITNESS_SCHEMA_NEWER],
    [PAIR_WITNESS_READ_CLASSES.FOREIGN_INSTALLATION, PAIR_WITNESS_GUARD_CODES.WITNESS_CONFLICT],
    [PAIR_WITNESS_READ_CLASSES.SITE_MISMATCH, PAIR_WITNESS_GUARD_CODES.WITNESS_CONFLICT],
    [PAIR_WITNESS_READ_CLASSES.ISSUE_MISMATCH, PAIR_WITNESS_GUARD_CODES.WITNESS_CONFLICT]
  ])('read class %s blocks as %s', async (readClass, expected) => {
    const result = await guard(evidence({
      localWitness: { class: readClass, statusCode: 200, record: null }
    }));
    expect(result.code).toBe(expected);
  });
});


describe('explicit replacement', () => {
  test('a confirmed-deleted counterpart may be replaced when the witness names it', async () => {
    const record = witness();
    const result = await guard(evidence({
      mapping: 'REMOT-1',
      localWitness: { class: PAIR_WITNESS_READ_CLASSES.MATCHING, statusCode: 200, record, pairId: record.pairId },
      remoteIssue: { class: 'missing', statusCode: 404, id: null, key: null }
    }), { replacementKey: 'REMOT-1', operationSuffix: 'replace:REMOT-1' });

    expect(result.decision).toBe(PAIR_WITNESS_GUARD_DECISIONS.ALLOW);
    expect(result.code).toBe(PAIR_WITNESS_GUARD_CODES.REPLACEMENT_ALLOWED);
  });

  test('a replacement may not proceed while the counterpart still exists', async () => {
    const record = witness();
    const result = await guard(evidence({
      mapping: 'REMOT-1',
      localWitness: { class: PAIR_WITNESS_READ_CLASSES.MATCHING, statusCode: 200, record, pairId: record.pairId },
      remoteWitness: { class: PAIR_WITNESS_READ_CLASSES.MATCHING, statusCode: 200, record, pairId: record.pairId }
    }), { replacementKey: 'REMOT-1' });

    expect(result.code).toBe(PAIR_WITNESS_GUARD_CODES.PAIR_PROVEN);
  });

  test('an ended witness may be superseded only for the exact replacement pair', async () => {
    const record = witness({ state: PAIR_WITNESS_STATES.ENDED });
    const allowed = await guard(evidence({
      mapping: 'REMOT-1',
      localWitness: { class: PAIR_WITNESS_READ_CLASSES.ENDED, statusCode: 200, record, pairId: record.pairId }
    }), { replacementKey: 'REMOT-1' });
    expect(allowed.code).toBe(PAIR_WITNESS_GUARD_CODES.REPLACEMENT_ALLOWED);

    const blocked = await guard(evidence({
      mapping: 'REMOT-9',
      localWitness: { class: PAIR_WITNESS_READ_CLASSES.ENDED, statusCode: 200, record, pairId: record.pairId }
    }), { replacementKey: 'REMOT-9' });
    expect(blocked.code).toBe(PAIR_WITNESS_GUARD_CODES.WITNESS_PAIR_ENDED);
  });
});

describe('source and transport failures', () => {
  test('a source 403 is inaccessible, not missing', async () => {
    const result = await guard(evidence({
      localIssue: { class: 'inaccessible', statusCode: 403, id: null, key: null }
    }), { sourceIssueId: null });

    expect(result.code).toBe(PAIR_WITNESS_GUARD_CODES.SOURCE_INACCESSIBLE);
  });

  test('a witness transport failure blocks rather than allowing', async () => {
    const deps = evidence();
    deps.readWitness = jest.fn(async () => { throw new Error('network'); });

    const result = await guard(deps);

    expect(result.code).toBe(PAIR_WITNESS_GUARD_CODES.WITNESS_UNVERIFIABLE);
  });

  test('an unreadable identity blocks', async () => {
    const result = await guard(evidence(), { identity: { readable: false } });

    expect(result.code).toBe(PAIR_WITNESS_GUARD_CODES.IDENTITY_UNAVAILABLE);
  });

  test('inbound direction reads the remote issue witness and local counterpart', async () => {
    const record = witness();
    const deps = evidence({
      mapping: null,
      localWitness: { class: PAIR_WITNESS_READ_CLASSES.MATCHING, statusCode: 200, record, pairId: record.pairId },
      remoteWitness: { class: PAIR_WITNESS_READ_CLASSES.MATCHING, statusCode: 200, record, pairId: record.pairId }
    });

    const result = await evaluatePairWitnessCreateGuard({
      orgId: ORG_ID,
      org: ORG,
      direction: ISSUE_CREATE_DIRECTIONS.REMOTE_TO_LOCAL,
      sourceKey: 'REMOT-1',
      sourceIssueId: '20881',
      identity: IDENTITY,
      deps
    });

    expect(result.code).toBe(PAIR_WITNESS_GUARD_CODES.PAIR_PROVEN);
    expect(deps.getLocalKey).toHaveBeenCalledWith('REMOT-1', ORG_ID);
    expect(deps.readWitness.mock.calls[0][0].side).toBe('remote');
  });
});

