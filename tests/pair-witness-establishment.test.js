import {
  establishPairWitness,
  getPairWitnessState,
  recordWitnessPersistenceFailure,
  WITNESS_ESTABLISHMENT_OUTCOMES
} from '../src/services/sync/pair-witness-establishment.js';
import {
  buildPairWitness,
  deterministicPairId,
  PAIR_WITNESS_READ_CLASSES,
  PAIR_WITNESS_STATES
} from '../src/services/sync/pair-witness.js';
import { PAIR_WITNESS_WRITE_OUTCOMES } from '../src/services/sync/pair-witness-write.js';

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
  localSite: LOCAL_SITE
};

const PAIR = {
  orgId: ORG_ID,
  org: ORG,
  localKey: 'LOCAL-1',
  remoteKey: 'REMOT-1',
  localIssueId: '10001',
  remoteIssueId: '20881'
};

const absent = { class: PAIR_WITNESS_READ_CLASSES.ABSENT, statusCode: 404, record: null };
const matching = (record) => ({
  class: PAIR_WITNESS_READ_CLASSES.MATCHING,
  statusCode: 200,
  record,
  pairId: record.pairId,
  state: PAIR_WITNESS_STATES.ACTIVE
});

function existingWitness({ remoteIssueId = '20881', remoteKey = 'REMOT-1' } = {}) {
  return buildPairWitness({
    pairId: deterministicPairId({
      installationId: INSTALLATION_ID,
      orgId: ORG_ID,
      localIssueId: '10001',
      remoteIssueId
    }),
    state: PAIR_WITNESS_STATES.ACTIVE,
    installationId: INSTALLATION_ID,
    appId: APP_ID,
    orgId: ORG_ID,
    localSite: LOCAL_SITE,
    remoteSite: REMOTE_SITE,
    localIssueId: '10001',
    localKey: 'LOCAL-1',
    remoteIssueId,
    remoteKey,
    direction: 'local-to-remote',
    writtenAt: '2026-10-26T10:00:00.000Z'
  });
}

function deps(overrides = {}) {
  const records = new Map();
  return {
    readIdentity: jest.fn(async () => IDENTITY),
    readIssue: jest.fn(async ({ side }) => ({
      class: 'present',
      statusCode: 200,
      id: side === 'local' ? '10001' : '20881',
      key: side === 'local' ? 'LOCAL-1' : 'REMOT-1'
    })),
    readWitness: jest.fn(async () => absent),
    putWitness: jest.fn(async () => ({ outcome: PAIR_WITNESS_WRITE_OUTCOMES.APPLIED, statusCode: 200 })),
    verifyWrite: jest.fn(async () => ({ verified: true })),
    storeState: jest.fn(async (key, value) => { records.set(key, value); }),
    getState: jest.fn(async (key) => records.get(key) || null),
    auditWrite: jest.fn(async () => undefined),
    now: () => Date.parse('2026-10-27T10:00:00.000Z'),
    ...overrides
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('successful establishment', () => {
  test('writes local then remote and verifies both read-backs', async () => {
    const d = deps();

    const result = await establishPairWitness({ ...PAIR, deps: d });

    expect(result.success).toBe(true);
    expect(result.outcome).toBe(WITNESS_ESTABLISHMENT_OUTCOMES.APPLIED);
    expect(d.putWitness.mock.calls.map((call) => call[0].side)).toEqual(['local', 'remote']);
    expect(d.verifyWrite).toHaveBeenCalledTimes(2);

    const state = await getPairWitnessState({ ...PAIR, deps: d });
    expect(state.outcome).toBe(WITNESS_ESTABLISHMENT_OUTCOMES.APPLIED);
    expect(state.pairId).toBe(result.pairId);
    expect(d.auditWrite).toHaveBeenCalledWith(expect.objectContaining({
      action: 'pair-witness-establishment',
      success: true
    }));
  });

  test('an identical witness on both sides performs no write', async () => {
    const record = existingWitness();
    const d = deps({ readWitness: jest.fn(async () => matching(record)) });

    const result = await establishPairWitness({ ...PAIR, deps: d });

    expect(result.outcome).toBe(WITNESS_ESTABLISHMENT_OUTCOMES.ALREADY_PRESENT);
    expect(d.putWitness).not.toHaveBeenCalled();
  });

  test('writes the same canonical record to both sides', async () => {
    const d = deps();

    await establishPairWitness({ ...PAIR, deps: d });

    const [local, remote] = d.putWitness.mock.calls.map((call) => JSON.parse(call[0].body));
    expect(local).toEqual(remote);
    expect(local.pairId).toBe(remote.pairId);
    expect(local.localIssueId).toBe('10001');
    expect(local.remoteIssueId).toBe('20881');
  });
});

describe('partial and failed establishment', () => {
  test('a failed local write never touches the remote side', async () => {
    const d = deps({
      putWitness: jest.fn(async ({ side }) => (side === 'local'
        ? { outcome: PAIR_WITNESS_WRITE_OUTCOMES.FAILED, code: 'JIRA_WRITE_FAILED', statusCode: 500 }
        : { outcome: PAIR_WITNESS_WRITE_OUTCOMES.APPLIED, statusCode: 200 }))
    });

    const result = await establishPairWitness({ ...PAIR, deps: d });

    expect(result.success).toBe(false);
    expect(result.outcome).toBe(WITNESS_ESTABLISHMENT_OUTCOMES.FAILED);
    expect(d.putWitness).toHaveBeenCalledTimes(1);
    expect(d.putWitness.mock.calls[0][0].side).toBe('local');
  });

  test('a remote failure leaves a verified local witness and reports partial', async () => {
    const d = deps({
      putWitness: jest.fn(async ({ side }) => (side === 'remote'
        ? { outcome: PAIR_WITNESS_WRITE_OUTCOMES.FAILED, code: 'JIRA_WRITE_FAILED', statusCode: 503 }
        : { outcome: PAIR_WITNESS_WRITE_OUTCOMES.APPLIED, statusCode: 200 }))
    });

    const result = await establishPairWitness({ ...PAIR, deps: d });

    expect(result.outcome).toBe(WITNESS_ESTABLISHMENT_OUTCOMES.PARTIAL);
    expect(result.local.status).toBe('verified');
    expect(result.remote.status).toBe('failed');
  });

  test('a failed read-back is not reported as success', async () => {
    const d = deps({
      verifyWrite: jest.fn(async ({ side }) => (side === 'local'
        ? { verified: false, absent: false, readClass: PAIR_WITNESS_READ_CLASSES.UNVERIFIABLE, code: 'PAIR_WITNESS_UNAVAILABLE' }
        : { verified: true }))
    });

    const result = await establishPairWitness({ ...PAIR, deps: d });

    expect(result.success).toBe(false);
    expect(result.outcome).toBe(WITNESS_ESTABLISHMENT_OUTCOMES.READ_BACK_FAILED);
    expect(d.putWitness).toHaveBeenCalledTimes(1);
  });

  test('a paused or unauthorized write is reported as blocked', async () => {
    const d = deps({
      putWitness: jest.fn(async () => ({
        outcome: PAIR_WITNESS_WRITE_OUTCOMES.FAILED,
        code: 'PILOT_PAUSED',
        statusCode: null
      }))
    });

    const result = await establishPairWitness({ ...PAIR, deps: d });

    expect(result.outcome).toBe(WITNESS_ESTABLISHMENT_OUTCOMES.BLOCKED);
  });

  test('a contradictory existing witness is never overwritten', async () => {
    const other = existingWitness({ remoteIssueId: '20882', remoteKey: 'REMOT-2' });
    const d = deps({ readWitness: jest.fn(async () => matching(other)) });

    const result = await establishPairWitness({ ...PAIR, deps: d });

    expect(result.outcome).toBe(WITNESS_ESTABLISHMENT_OUTCOMES.CONFLICT);
    expect(d.putWitness).not.toHaveBeenCalled();
  });

  test('an explicit replacement may supersede the witness of the deleted counterpart', async () => {
    const previous = existingWitness();
    const d = deps({ readWitness: jest.fn(async ({ side }) => (side === 'local' ? matching(previous) : absent)) });

    const result = await establishPairWitness({
      ...PAIR,
      remoteKey: 'REMOT-2',
      remoteIssueId: '20999',
      deps: d,
      replacement: { localKey: 'LOCAL-1', remoteKey: 'REMOT-1', localIssueId: '10001' }
    });

    expect(result.outcome).toBe(WITNESS_ESTABLISHMENT_OUTCOMES.APPLIED);
    expect(d.putWitness.mock.calls.map((call) => call[0].side)).toEqual(['local', 'remote']);
  });

  test('legacy scope and unreadable identity are reported, not thrown', async () => {
    const legacy = await establishPairWitness({ ...PAIR, orgId: null, deps: deps() });
    expect(legacy.outcome).toBe(WITNESS_ESTABLISHMENT_OUTCOMES.NOT_APPLICABLE);

    const unreadable = await establishPairWitness({
      ...PAIR,
      deps: deps({ readIdentity: jest.fn(async () => ({ readable: false })) })
    });
    expect(unreadable.outcome).toBe(WITNESS_ESTABLISHMENT_OUTCOMES.UNAVAILABLE);
  });

  test('a mapping or ledger persistence failure is recorded as actionable attention', async () => {
    const d = deps();

    const result = await recordWitnessPersistenceFailure({
      orgId: ORG_ID,
      localKey: 'LOCAL-1',
      remoteKey: 'REMOT-1',
      targetKey: 'REMOT-1',
      outcome: WITNESS_ESTABLISHMENT_OUTCOMES.MAPPING_PERSISTENCE_FAILED,
      reason: 'MAPPING_WRITE_FAILED',
      deps: d
    });

    expect(result.success).toBe(false);
    expect(result.outcome).toBe(WITNESS_ESTABLISHMENT_OUTCOMES.MAPPING_PERSISTENCE_FAILED);
    const state = await getPairWitnessState({ ...PAIR, deps: d });
    expect(state.targetKey).toBe('REMOT-1');
    expect(state.outcome).toBe(WITNESS_ESTABLISHMENT_OUTCOMES.MAPPING_PERSISTENCE_FAILED);
    expect(d.auditWrite).toHaveBeenCalledWith(expect.objectContaining({
      action: 'pair-witness-establishment',
      success: false
    }));
  });
});

