import {
  adoptWitnessedPair,
  previewWitnessedPairAdoption,
  pairWitnessAdoptionPhrase,
  PAIR_WITNESS_ADOPTION_ERRORS
} from '../src/services/sync/pair-witness-adoption.js';
import {
  buildPairWitness,
  deterministicPairId,
  PAIR_WITNESS_READ_CLASSES
} from '../src/services/sync/pair-witness.js';
import { RESOLVER_POLICIES } from '../src/resolvers/authorization-policy.js';

jest.mock('@forge/api', () => ({
  __esModule: true,
  default: { asApp: () => ({ requestJira: jest.fn() }), asUser: () => ({ requestJira: jest.fn() }) },
  getAppContext: jest.fn(),
  route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
  fetch: jest.fn()
}));

const ORG_ID = 'org-1';
const LOCAL_KEY = 'LOCAL-1';
const REMOTE_KEY = 'REMOT-1';
const LOCAL_ID = '10001';
const REMOTE_ID = '20881';
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

const PAIR_ID = deterministicPairId({
  installationId: INSTALLATION_ID,
  orgId: ORG_ID,
  localIssueId: LOCAL_ID,
  remoteIssueId: REMOTE_ID
});

const RECORD = buildPairWitness({
  pairId: PAIR_ID,
  state: 'active',
  installationId: INSTALLATION_ID,
  appId: APP_ID,
  orgId: ORG_ID,
  localSite: LOCAL_SITE,
  remoteSite: REMOTE_SITE,
  localIssueId: LOCAL_ID,
  localKey: LOCAL_KEY,
  remoteIssueId: REMOTE_ID,
  remoteKey: REMOTE_KEY,
  direction: 'local-to-remote',
  writtenAt: '2026-10-27T10:00:00.000Z'
});

const matching = {
  class: PAIR_WITNESS_READ_CLASSES.MATCHING,
  statusCode: 200,
  record: RECORD,
  pairId: PAIR_ID,
  state: 'active'
};
const absent = { class: PAIR_WITNESS_READ_CLASSES.ABSENT, statusCode: 404, record: null };

function deps(overrides = {}) {
  return {
    readPause: jest.fn(async () => ({ paused: true })),
    getOrganizations: jest.fn(async () => [ORG]),
    readIdentity: jest.fn(async () => ({
      readable: true,
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      localSite: LOCAL_SITE
    })),
    readIssue: jest.fn(async ({ side }) => ({
      class: 'present',
      statusCode: 200,
      id: side === 'local' ? LOCAL_ID : REMOTE_ID,
      key: side === 'local' ? LOCAL_KEY : REMOTE_KEY
    })),
    readWitness: jest.fn(async () => matching),
    getRemoteKey: jest.fn(async () => null),
    getLocalKey: jest.fn(async () => null),
    storeMapping: jest.fn(async () => ({ idempotent: false })),
    auditWrite: jest.fn(async () => undefined),
    ...overrides
  };
}

const base = {
  orgId: ORG_ID,
  localKey: LOCAL_KEY,
  remoteKey: REMOTE_KEY,
  pairId: PAIR_ID,
  confirmation: pairWitnessAdoptionPhrase({
    orgId: ORG_ID,
    localKey: LOCAL_KEY,
    remoteKey: REMOTE_KEY,
    pairId: PAIR_ID
  }),
  actorAccountId: 'account-1'
};

describe('witnessed-pair adoption', () => {
  test('adoption is an explicit administrator write, not a synchronization action', () => {
    expect(RESOLVER_POLICIES.adoptWitnessedPair).toBe('ADMIN_WRITE');
  });

  test('restores the mapping from two verified witnesses and audits it', async () => {
    const d = deps();

    const result = await adoptWitnessedPair({ ...base, deps: d });

    expect(result.success).toBe(true);
    expect(result.code).toBe('PAIR_WITNESS_PAIR_ADOPTED');
    expect(d.storeMapping).toHaveBeenCalledWith(LOCAL_KEY, REMOTE_KEY, ORG_ID);
    expect(d.auditWrite).toHaveBeenCalledWith(expect.objectContaining({
      action: 'adopt-pair-witness',
      success: true,
      pairId: PAIR_ID
    }));
  });

  test('an identical mapping makes adoption an idempotent no-op', async () => {
    const d = deps({
      getRemoteKey: jest.fn(async () => REMOTE_KEY),
      getLocalKey: jest.fn(async () => LOCAL_KEY)
    });

    const result = await adoptWitnessedPair({ ...base, deps: d });

    expect(result.success).toBe(true);
    expect(result.idempotent).toBe(true);
    expect(d.storeMapping).not.toHaveBeenCalled();
  });

  test('a conflicting mapping is refused', async () => {
    const d = deps({ getRemoteKey: jest.fn(async () => 'REMOT-9') });

    const result = await adoptWitnessedPair({ ...base, deps: d });

    expect(result.code).toBe(PAIR_WITNESS_ADOPTION_ERRORS.MAPPING_CONFLICT);
    expect(d.storeMapping).not.toHaveBeenCalled();
  });

  test('adoption requires a confirmed pause', async () => {
    const result = await adoptWitnessedPair({
      ...base,
      deps: deps({ readPause: jest.fn(async () => ({ paused: false })) })
    });

    expect(result.code).toBe(PAIR_WITNESS_ADOPTION_ERRORS.PAUSE_REQUIRED);
  });

  test('an unreadable pause state fails closed', async () => {
    const result = await adoptWitnessedPair({
      ...base,
      deps: deps({ readPause: jest.fn(async () => { throw new Error('storage'); }) })
    });

    expect(result.code).toBe(PAIR_WITNESS_ADOPTION_ERRORS.PAUSE_UNREADABLE);
  });

  test('the exact confirmation phrase is required', async () => {
    const wrong = await adoptWitnessedPair({ ...base, confirmation: 'ADOPT something', deps: deps() });
    expect(wrong.code).toBe(PAIR_WITNESS_ADOPTION_ERRORS.CONFIRMATION_MISMATCH);

    const missing = await adoptWitnessedPair({ ...base, confirmation: null, deps: deps() });
    expect(missing.code).toBe(PAIR_WITNESS_ADOPTION_ERRORS.CONFIRMATION_REQUIRED);
  });


  test('one-sided witnesses are refused', async () => {
    const d = deps({
      readWitness: jest.fn(async ({ side }) => (side === 'local' ? matching : absent))
    });

    const result = await adoptWitnessedPair({ ...base, deps: d });

    expect(result.code).toBe(PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_ABSENT);
  });

  test('an inaccessible witness is refused as inaccessible', async () => {
    const d = deps({
      readWitness: jest.fn(async () => ({
        class: PAIR_WITNESS_READ_CLASSES.INACCESSIBLE,
        statusCode: 403,
        record: null
      }))
    });

    const result = await adoptWitnessedPair({ ...base, deps: d });

    expect(result.code).toBe(PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_INACCESSIBLE);
  });

  test('a supplied pair id that does not match the witnesses is refused', async () => {
    const wrongPairId = '3f6c1a8e-9b21-4f0d-9d4e-6a1b2c3d4e5f';
    const result = await adoptWitnessedPair({
      ...base,
      pairId: wrongPairId,
      confirmation: pairWitnessAdoptionPhrase({
        orgId: ORG_ID,
        localKey: LOCAL_KEY,
        remoteKey: REMOTE_KEY,
        pairId: wrongPairId
      }),
      deps: deps()
    });

    expect(result.code).toBe(PAIR_WITNESS_ADOPTION_ERRORS.PAIR_ID_MISMATCH);
  });

  test('witnesses that cannot be attributed are a conflict', async () => {
    const d = deps({
      readWitness: jest.fn(async () => ({
        class: PAIR_WITNESS_READ_CLASSES.SITE_MISMATCH,
        statusCode: 200,
        record: RECORD
      }))
    });

    const result = await adoptWitnessedPair({ ...base, deps: d });

    expect(result.code).toBe(PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_CONFLICT);
  });

  test('a moved issue key is refused instead of adopting a stale key', async () => {
    const d = deps({
      readIssue: jest.fn(async ({ side }) => ({
        class: 'present',
        statusCode: 200,
        id: side === 'local' ? LOCAL_ID : REMOTE_ID,
        key: side === 'local' ? LOCAL_KEY : 'REMOT-9'
      }))
    });

    const result = await adoptWitnessedPair({ ...base, deps: d });

    expect(result.code).toBe(PAIR_WITNESS_ADOPTION_ERRORS.ISSUE_KEY_MISMATCH);
  });

  test('legacy scope cannot be adopted', async () => {
    const result = await adoptWitnessedPair({
      ...base,
      orgId: null,
      confirmation: 'ADOPT null LOCAL-1 REMOT-1 ' + PAIR_ID,
      deps: deps()
    });

    expect(result.code).toBe(PAIR_WITNESS_ADOPTION_ERRORS.ORGANIZATION_INVALID);
  });
});


describe('read-only adoption preview', () => {
  const preview = (overrides = {}, depsOverrides = {}) => previewWitnessedPairAdoption({
    orgId: ORG_ID,
    localKey: LOCAL_KEY,
    remoteKey: REMOTE_KEY,
    deps: deps(depsOverrides),
    ...overrides
  });

  test('reports the verified pair identity, phrase and readiness while writing nothing', async () => {
    const d = deps();

    const result = await previewWitnessedPairAdoption({
      orgId: ORG_ID,
      localKey: LOCAL_KEY,
      remoteKey: REMOTE_KEY,
      deps: d
    });

    expect(result.success).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.pairId).toBe(PAIR_ID);
    expect(result.localIssueId).toBe(LOCAL_ID);
    expect(result.remoteIssueId).toBe(REMOTE_ID);
    expect(result.mapping.state).toBe('missing');
    expect(result.confirmationPhrase).toBe(base.confirmation);
    expect(d.storeMapping).not.toHaveBeenCalled();
    expect(d.auditWrite).not.toHaveBeenCalled();
  });

  test('reports a required pause without failing the read-only preview', async () => {
    const result = await preview({}, { readPause: jest.fn(async () => ({ paused: false })) });

    expect(result.success).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.pause).toEqual({ readable: true, paused: false, reasonCode: null });
    expect(result.conflicts).toContain(PAIR_WITNESS_ADOPTION_ERRORS.PAUSE_REQUIRED);
  });

  test('reports a mapping conflict instead of offering adoption', async () => {
    const result = await preview({}, { getRemoteKey: jest.fn(async () => 'REMOT-9') });

    expect(result.success).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.mapping.state).toBe('conflict');
    expect(result.conflicts).toContain(PAIR_WITNESS_ADOPTION_ERRORS.MAPPING_CONFLICT);
  });

  test('an already adopted pair is reported as matching, not as ready to write', async () => {
    const result = await preview({}, {
      getRemoteKey: jest.fn(async () => REMOTE_KEY),
      getLocalKey: jest.fn(async () => LOCAL_KEY)
    });

    expect(result.ready).toBe(false);
    expect(result.alreadyMapped).toBe(true);
    expect(result.mapping.state).toBe('matching');
  });

  test('one-sided witnesses are refused without being reported as a pair', async () => {
    const result = await preview({}, {
      readWitness: jest.fn(async ({ side }) => (side === 'local' ? matching : absent))
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe(PAIR_WITNESS_ADOPTION_ERRORS.WITNESS_ABSENT);
  });

  test('an unreadable pause is shown as unverifiable, not as paused', async () => {
    const result = await preview({}, {
      readPause: jest.fn(async () => { throw new Error('storage'); })
    });

    expect(result.pause).toEqual({ readable: false, paused: false, reasonCode: null });
    expect(result.ready).toBe(false);
    expect(result.conflicts).toContain(PAIR_WITNESS_ADOPTION_ERRORS.PAUSE_UNREADABLE);
  });
});

