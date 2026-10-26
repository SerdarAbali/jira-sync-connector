/**
 * Maintenance permit: the complete allow/deny matrix.
 *
 * The production boundary (`guarded-api`) and the production permit module run
 * unmodified. Only the Forge SDK, the pause record and the KVS boundary are
 * modelled, so every assertion describes what the deployed app does: while the
 * connector is paused and synchronization is unauthorized, exactly one PUT shape
 * on exactly one approved payload can reach the transport.
 */
import api, { getAppContext } from '@forge/api';
import { resetStore, seed, store } from './helpers/pair-witness-store.js';
import {
  PAIR_WITNESS_BATCH_LOCK_KEY,
  PAIR_WITNESS_PERMIT_KEY,
  PAIR_WITNESS_PERMIT_REASONS,
  PAIR_WITNESS_PLAN_KEY,
  acquirePairWitnessBatchLock,
  evaluatePairWitnessPermit,
  issuePairWitnessPermit,
  pairWitnessApprovalPhrase,
  readPairWitnessPermit
} from '../src/services/sync/pair-witness-permit.js';
import {
  buildPairWitness,
  deterministicPairId,
  pairWitnessPayloadDigest
} from '../src/services/sync/pair-witness.js';
import { PAIR_WITNESS_PROPERTY_KEY } from '../src/services/sync/pair-witness-constants.js';
import { fetch as guardedFetch } from '../src/services/jira/guarded-api.js';
import { pausePilot } from '../src/services/sync/pilot-pause.js';

jest.mock('@forge/api', () => {
  const requestJira = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  const fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  return {
    __esModule: true,
    default: { asApp: () => ({ requestJira }), asUser: () => ({ requestJira }) },
    getAppContext: jest.fn(),
    route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch
  };
});

jest.mock('../src/services/storage/kvs.js', () => require('./helpers/pair-witness-store.js').kvsModule);
jest.mock('../src/services/storage/stats.js', () => ({
  logAuditEntry: jest.fn(),
  trackWebhookSync: jest.fn(),
  trackApiCall: jest.fn()
}));
import { logAuditEntry } from '../src/services/storage/stats.js';
jest.mock('../src/services/sync/lease-migration.js', () => ({
  assertIssueLeaseMigrationReady: jest.fn(async () => true)
}));
jest.mock('../src/services/sync/issue-lease-context.js', () => ({
  assertCurrentIssueLeases: jest.fn(async () => true)
}));

const APP_ID = '362d8e6b-b68c-4403-8020-d32ddcc02716';
const ENVIRONMENT_ID = '2e8c0cb5-881a-4345-b9ba-e887f790d316';
const INSTALLATION_ID = '974910c5-2861-4d40-a7eb-37802842d0a0';
const ORG_A = 'org-1792917897410';
const ORG_B = 'org-1792934416107';
const LOCAL_SITE = '11111111-2222-4333-8444-555555555555';
const REMOTE_SITE = 'serdarjiratwo.atlassian.net';

const requestJira = api.asApp().requestJira;
const forgeFetch = require('@forge/api').fetch;

function witnessFor(overrides = {}) {
  const pairId = overrides.pairId || deterministicPairId({
    installationId: INSTALLATION_ID,
    orgId: overrides.orgId || ORG_A,
    localIssueId: String(overrides.localIssueId || '10001'),
    remoteIssueId: String(overrides.remoteIssueId || '20881')
  });
  return buildPairWitness({
    pairId,
    state: 'active',
    installationId: INSTALLATION_ID,
    appId: APP_ID,
    orgId: overrides.orgId || ORG_A,
    localSite: LOCAL_SITE,
    remoteSite: REMOTE_SITE,
    localIssueId: String(overrides.localIssueId || '10001'),
    localKey: overrides.localKey || 'MOB-8',
    remoteIssueId: String(overrides.remoteIssueId || '20881'),
    remoteKey: overrides.remoteKey || 'VMOB-13',
    direction: 'local-to-remote',
    writtenAt: '2026-10-26T09:00:00.000Z'
  });
}

function seedPlan(overrides = {}) {
  const plan = {
    version: 1,
    orgId: ORG_A,
    installationId: INSTALLATION_ID,
    appId: APP_ID,
    localSite: LOCAL_SITE,
    digest: `sha256:${'a'.repeat(64)}`,
    status: 'approved',
    expiresAt: Date.now() + 3600_000,
    items: [],
    ...overrides
  };
  seed(PAIR_WITNESS_PLAN_KEY(plan.orgId), plan);
  return plan;
}

function seedPermit(record, plan) {
  seed(PAIR_WITNESS_PERMIT_KEY, {
    version: 1,
    permitId: 'pw_test_0001',
    orgId: record.orgId || ORG_A,
    planDigest: plan.digest,
    installationId: INSTALLATION_ID,
    appId: APP_ID,
    localSite: LOCAL_SITE,
    batchIndex: 0,
    issuedAt: new Date().toISOString(),
    expiresAt: Date.now() + 600_000,
    entries: [record.entry]
  });
}

function entryFor(record, site = 'local') {
  return {
    site,
    issueId: site === 'local' ? record.localIssueId : record.remoteIssueId,
    pairId: record.pairId,
    payloadDigest: pairWitnessPayloadDigest(record)
  };
}

const localPath = (issueId) => `/rest/api/3/issue/${issueId}/properties/${PAIR_WITNESS_PROPERTY_KEY}`;

beforeEach(async () => {
  resetStore();
  jest.clearAllMocks();
  getAppContext.mockReturnValue({
    appAri: { appId: APP_ID },
    environmentAri: { environmentId: ENVIRONMENT_ID },
    installationAri: { installationId: INSTALLATION_ID }
  });
  await pausePilot('emergency_stop', 'test-admin');
});

const evaluate = (options) => evaluatePairWitnessPermit({
  deps: { now: () => Date.now() },
  ...options
});

describe('the permit allows exactly one request shape', () => {
  test('an approved local property PUT reaches the transport', async () => {
    const plan = seedPlan();
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, 'local') }, plan);

    const decision = await evaluate({
      method: 'PUT',
      raw: localPath(record.localIssueId),
      pathname: localPath(record.localIssueId),
      body: JSON.stringify(record)
    });
    expect(decision.allowed).toBe(true);
    expect(decision.site).toBe('local');
  });

  test('an approved remote property PUT reaches the transport', async () => {
    const plan = seedPlan();
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, REMOTE_SITE) }, plan);

    const decision = await evaluate({
      method: 'PUT',
      raw: `https://${REMOTE_SITE}${localPath(record.remoteIssueId)}`,
      pathname: localPath(record.remoteIssueId),
      body: JSON.stringify(record)
    });
    expect(decision.allowed).toBe(true);
    expect(decision.site).toBe(REMOTE_SITE);
  });

  const nonPermitShapes = [
    ['POST create', 'POST', '/rest/api/3/issue', null],
    ['PUT issue fields', 'PUT', '/rest/api/3/issue/10001', null],
    ['PUT another property key', 'PUT', '/rest/api/3/issue/10001/properties/last-synced', null],
    ['DELETE the witness', 'DELETE', `/rest/api/3/issue/10001/properties/${PAIR_WITNESS_PROPERTY_KEY}`, null],
    ['PATCH the witness', 'PATCH', `/rest/api/3/issue/10001/properties/${PAIR_WITNESS_PROPERTY_KEY}`, null],
    ['PUT a key instead of an id', 'PUT', `/rest/api/3/issue/MOB-8/properties/${PAIR_WITNESS_PROPERTY_KEY}`, null],
    ['PUT a sub-resource', 'PUT', `/rest/api/3/issue/10001/properties/${PAIR_WITNESS_PROPERTY_KEY}/extra`, null]
  ];

  test.each(nonPermitShapes)('%s is not permit-shaped', async (_label, method, pathname) => {
    const plan = seedPlan();
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, 'local') }, plan);

    const decision = await evaluate({
      method,
      raw: pathname,
      pathname,
      body: JSON.stringify(record)
    });
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toBeNull();
  });

  test('an unapproved issue is refused', async () => {
    const plan = seedPlan();
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, 'local') }, plan);

    const decision = await evaluate({
      method: 'PUT',
      raw: localPath('99999'),
      pathname: localPath('99999'),
      body: JSON.stringify(record)
    });
    expect(decision).toMatchObject({
      allowed: false,
      refusal: 'PERMIT_INVALID',
      reason: PAIR_WITNESS_PERMIT_REASONS.PERMIT_ISSUE_NOT_APPROVED
    });
  });

  test('an approved issue on an unapproved site is refused', async () => {
    const plan = seedPlan();
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, REMOTE_SITE) }, plan);

    const decision = await evaluate({
      method: 'PUT',
      raw: `https://evil.example${localPath(record.remoteIssueId)}`,
      pathname: localPath(record.remoteIssueId),
      body: JSON.stringify(record)
    });
    expect(decision).toMatchObject({ allowed: false, refusal: 'PERMIT_INVALID' });
    expect(decision.reason).toBe(PAIR_WITNESS_PERMIT_REASONS.PERMIT_SITE_NOT_APPROVED);
  });

  test('a local claim for a remote-only entry is refused', async () => {
    const plan = seedPlan();
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, REMOTE_SITE) }, plan);

    const decision = await evaluate({
      method: 'PUT',
      raw: localPath(record.remoteIssueId),
      pathname: localPath(record.remoteIssueId),
      body: JSON.stringify(record)
    });
    expect(decision.reason).toBe(PAIR_WITNESS_PERMIT_REASONS.PERMIT_SITE_NOT_APPROVED);
  });
});


describe('payload, pair and organization binding', () => {
  test('a body that differs from the approved payload is refused', async () => {
    const plan = seedPlan();
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, 'local') }, plan);
    const tampered = buildPairWitness({ ...record, remoteKey: 'VMOB-99' });

    const decision = await evaluate({
      method: 'PUT',
      raw: localPath(record.localIssueId),
      pathname: localPath(record.localIssueId),
      body: JSON.stringify(tampered)
    });
    expect(decision.reason).toBe(PAIR_WITNESS_PERMIT_REASONS.PERMIT_PAYLOAD_MISMATCH);
  });

  test('a different pair id is refused before the payload comparison', async () => {
    const plan = seedPlan();
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, 'local') }, plan);
    const other = witnessFor({ localIssueId: '10001', remoteIssueId: '20882' });

    const decision = await evaluate({
      method: 'PUT',
      raw: localPath(record.localIssueId),
      pathname: localPath(record.localIssueId),
      body: JSON.stringify(other)
    });
    expect(decision.reason).toBe(PAIR_WITNESS_PERMIT_REASONS.PERMIT_PAIR_MISMATCH);
  });

  test('a witness for another organization is refused', async () => {
    const plan = seedPlan();
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, 'local') }, plan);
    const foreign = buildPairWitness({ ...record, orgId: ORG_B });

    const decision = await evaluate({
      method: 'PUT',
      raw: localPath(record.localIssueId),
      pathname: localPath(record.localIssueId),
      body: JSON.stringify(foreign)
    });
    expect(decision).toMatchObject({ allowed: false, refusal: 'PERMIT_INVALID' });
  });

  test('a malformed or non-witness body is refused', async () => {
    const plan = seedPlan();
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, 'local') }, plan);

    for (const body of ['not json', '{}', JSON.stringify({ hello: 'world' }), undefined]) {
      const decision = await evaluate({
        method: 'PUT',
        raw: localPath(record.localIssueId),
        pathname: localPath(record.localIssueId),
        body
      });
      expect(decision.reason).toBe(PAIR_WITNESS_PERMIT_REASONS.PERMIT_PAYLOAD_MISMATCH);
    }
  });
});


describe('permit lifecycle conditions', () => {
  const permitShaped = (record) => ({
    method: 'PUT',
    raw: localPath(record.localIssueId),
    pathname: localPath(record.localIssueId),
    body: JSON.stringify(record)
  });

  test('no permit at all refuses a permit-shaped request', async () => {
    seedPlan();
    const decision = await evaluate(permitShaped(witnessFor()));
    expect(decision.reason).toBe(PAIR_WITNESS_PERMIT_REASONS.PERMIT_MISSING);
  });

  test('a malformed permit record is refused', async () => {
    seedPlan();
    seed(PAIR_WITNESS_PERMIT_KEY, { version: 99, permitId: 'x' });
    const decision = await evaluate(permitShaped(witnessFor()));
    expect(decision.reason).toBe(PAIR_WITNESS_PERMIT_REASONS.PERMIT_MALFORMED);
  });

  test('an expired permit is refused', async () => {
    const plan = seedPlan();
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, 'local') }, plan);
    const stored = await store.get(PAIR_WITNESS_PERMIT_KEY);
    seed(PAIR_WITNESS_PERMIT_KEY, { ...stored, expiresAt: Date.now() - 1000 });

    const decision = await evaluate(permitShaped(record));
    expect(decision.reason).toBe(PAIR_WITNESS_PERMIT_REASONS.PERMIT_EXPIRED);
  });

  test('a permit from another installation is refused', async () => {
    const plan = seedPlan();
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, 'local') }, plan);
    const stored = await store.get(PAIR_WITNESS_PERMIT_KEY);
    seed(PAIR_WITNESS_PERMIT_KEY, {
      ...stored,
      installationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    });

    const decision = await evaluate(permitShaped(record));
    expect(decision.reason).toBe(PAIR_WITNESS_PERMIT_REASONS.PERMIT_FOREIGN_INSTALLATION);
  });

  test('a permit for another plan is refused', async () => {
    const plan = seedPlan();
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, 'local') }, plan);
    seedPlan({ digest: `sha256:${'b'.repeat(64)}` });

    const decision = await evaluate(permitShaped(record));
    expect(decision.reason).toBe(PAIR_WITNESS_PERMIT_REASONS.PERMIT_PLAN_MISMATCH);
  });

  test('a non-approved or expired plan is refused', async () => {
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, 'local') }, seedPlan());

    seedPlan({ status: 'completed' });
    expect((await evaluate(permitShaped(record))).reason)
      .toBe(PAIR_WITNESS_PERMIT_REASONS.PLAN_NOT_APPROVED);

    seedPlan({ status: 'running', expiresAt: Date.now() - 1 });
    expect((await evaluate(permitShaped(record))).reason)
      .toBe(PAIR_WITNESS_PERMIT_REASONS.PLAN_EXPIRED);

    seed(PAIR_WITNESS_PLAN_KEY(ORG_A), null);
    expect((await evaluate(permitShaped(record))).reason)
      .toBe(PAIR_WITNESS_PERMIT_REASONS.PLAN_NOT_APPROVED);
  });

  test('an issue that already recorded a write is refused', async () => {
    const plan = seedPlan();
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, 'local') }, plan);
    seed(`witnessWritten:${ORG_A}:local:${record.localIssueId}`, { pairId: record.pairId });

    const decision = await evaluate(permitShaped(record));
    expect(decision.reason).toBe(PAIR_WITNESS_PERMIT_REASONS.PERMIT_ALREADY_WRITTEN);
  });

  test('a restore in progress refuses the permit', async () => {
    const plan = seedPlan();
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, 'local') }, plan);
    seed('syncAuthorization', { version: 1, state: 'restore-in-progress' });

    const decision = await evaluate(permitShaped(record));
    expect(decision.reason).toBe(PAIR_WITNESS_PERMIT_REASONS.RESTORE_IN_PROGRESS);
  });

  test('an unreadable restore state refuses the permit', async () => {
    const plan = seedPlan();
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, 'local') }, plan);

    const decision = await evaluate({
      ...permitShaped(record),
      deps: {
        getStored: async (key) => {
          if (key === 'syncAuthorization') throw new Error('kvs down');
          return store.get(key);
        }
      }
    });
    expect(decision.reason).toBe(PAIR_WITNESS_PERMIT_REASONS.RESTORE_UNREADABLE);
  });
});


describe('pause must be explicitly ON', () => {
  test('a paused connector with a valid permit allows the property PUT', async () => {
    const plan = seedPlan();
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, 'local') }, plan);

    await guardedFetch(localPath(record.localIssueId), {
      method: 'PUT',
      body: JSON.stringify(record)
    });

    expect(forgeFetch).toHaveBeenCalledTimes(1);
  });

  test('a permit-shaped write with no pause record is refused', async () => {
    const plan = seedPlan();
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, 'local') }, plan);
    await store.del('pilotPause');

    await expect(guardedFetch(localPath(record.localIssueId), {
      method: 'PUT',
      body: JSON.stringify(record)
    })).rejects.toMatchObject({
      code: 'PAIR_WITNESS_PERMIT_REFUSED',
      reason: PAIR_WITNESS_PERMIT_REASONS.PAUSE_NOT_CONFIRMED
    });
    expect(forgeFetch).not.toHaveBeenCalled();
  });

  test('a permit-shaped write with an unreadable pause is refused', async () => {
    const plan = seedPlan();
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, 'local') }, plan);

    const decision = await evaluatePairWitnessPermit({
      method: 'PUT',
      raw: localPath(record.localIssueId),
      pathname: localPath(record.localIssueId),
      body: JSON.stringify(record),
      deps: {
        now: () => Date.now(),
        readPause: async () => {
          throw new Error('kvs unavailable');
        }
      }
    });

    expect(decision).toMatchObject({ allowed: false, refusal: 'PERMIT_INVALID' });
    expect(decision.reason).toBe(PAIR_WITNESS_PERMIT_REASONS.PAUSE_UNREADABLE);
  });

  test('a paused connector with an expired permit refuses the write', async () => {
    const plan = seedPlan();
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, 'local') }, plan);
    const stored = await store.get(PAIR_WITNESS_PERMIT_KEY);
    seed(PAIR_WITNESS_PERMIT_KEY, { ...stored, expiresAt: Date.now() - 1 });

    await expect(guardedFetch(localPath(record.localIssueId), {
      method: 'PUT',
      body: JSON.stringify(record)
    })).rejects.toMatchObject({ code: 'PAIR_WITNESS_PERMIT_REFUSED' });
    expect(forgeFetch).not.toHaveBeenCalled();
  });
});


describe('ordinary writes stay blocked even with a valid permit', () => {
  function validPermit() {
    const plan = seedPlan();
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, 'local') }, plan);
    return record;
  }

  test('issue creation is blocked while a valid permit exists', async () => {
    validPermit();

    await expect(guardedFetch('https://serdarjiratwo.atlassian.net/rest/api/3/issue', {
      method: 'POST',
      body: JSON.stringify({ fields: { summary: 'should never be created' } })
    })).rejects.toMatchObject({ code: 'PILOT_PAUSED' });

    expect(forgeFetch).not.toHaveBeenCalled();
    expect(requestJira).not.toHaveBeenCalled();
  });

  test('an issue field update is blocked while a valid permit exists', async () => {
    validPermit();

    await expect(guardedFetch('/rest/api/3/issue/10001', {
      method: 'PUT',
      body: JSON.stringify({ fields: { summary: 'should never change' } })
    })).rejects.toMatchObject({ code: 'PILOT_PAUSED' });

    expect(forgeFetch).not.toHaveBeenCalled();
  });

  test('another property key is blocked while a valid permit exists', async () => {
    validPermit();

    await expect(guardedFetch(
      'https://serdarjiratwo.atlassian.net/rest/api/3/issue/20881/properties/last-synced',
      { method: 'PUT', body: '{"x":1}' }
    )).rejects.toMatchObject({ code: 'PILOT_PAUSED' });

    expect(forgeFetch).not.toHaveBeenCalled();
  });

  test('deleting a property is blocked while a valid permit exists', async () => {
    const record = validPermit();

    await expect(guardedFetch(localPath(record.localIssueId), { method: 'DELETE' }))
      .rejects.toMatchObject({ code: 'PILOT_PAUSED' });

    expect(forgeFetch).not.toHaveBeenCalled();
  });

  test('an unapproved issue is refused by the permit, not silently allowed', async () => {
    validPermit();

    await expect(guardedFetch(localPath('77777'), { method: 'PUT', body: '{}' }))
      .rejects.toMatchObject({ code: 'PAIR_WITNESS_PERMIT_REFUSED' });

    expect(forgeFetch).not.toHaveBeenCalled();
  });

  test('the approved write passes while an ordinary write stays blocked', async () => {
    const record = validPermit();

    await guardedFetch(localPath(record.localIssueId), {
      method: 'PUT',
      body: JSON.stringify(record)
    });
    expect(forgeFetch).toHaveBeenCalledTimes(1);

    await expect(guardedFetch('https://serdarjiratwo.atlassian.net/rest/api/3/issue', {
      method: 'POST',
      body: '{}'
    })).rejects.toMatchObject({ code: 'PILOT_PAUSED' });
    expect(forgeFetch).toHaveBeenCalledTimes(1);
  });
});

describe('single-flight ownership and phrase', () => {
  test('a second concurrent batch cannot acquire the lock', async () => {
    const first = await acquirePairWitnessBatchLock({});
    expect(first.token).toBeTruthy();

    await expect(acquirePairWitnessBatchLock({})).rejects.toMatchObject({
      code: 'PAIR_WITNESS_PERMIT_REFUSED',
      reason: PAIR_WITNESS_PERMIT_REASONS.LOCK_HELD
    });
  });

  test('the lock is released by its owner only', async () => {
    const { releasePairWitnessBatchLock } = require('../src/services/sync/pair-witness-permit.js');
    const lock = await acquirePairWitnessBatchLock({});
    expect(await releasePairWitnessBatchLock({ token: 'someone-else' })).toBe(false);
    expect(await releasePairWitnessBatchLock(lock)).toBe(true);
    expect((await acquirePairWitnessBatchLock({})).token).toBeTruthy();
  });

  test('the approval phrase names the organization, digest prefix and pair count', () => {
    const phrase = pairWitnessApprovalPhrase({
      orgId: ORG_A,
      planDigest: `sha256:${'c'.repeat(64)}`,
      pairCount: 21
    });
    expect(phrase).toBe(`APPROVE WITNESS ${ORG_A} cccccccccccc 21`);
    expect(phrase).not.toContain('sha256:');
  });

  test('issuing a permit stores a short-lived record that can be read back', async () => {
    const record = witnessFor();
    const issued = await issuePairWitnessPermit({
      orgId: ORG_A,
      planDigest: `sha256:${'d'.repeat(64)}`,
      installationId: INSTALLATION_ID,
      appId: APP_ID,
      localSite: LOCAL_SITE,
      entries: [entryFor(record, 'local')],
      deps: { now: () => Date.now() }
    });

    expect(issued.expiresAt - Date.now()).toBeLessThanOrEqual(600_000);
    expect(await readPairWitnessPermit({})).toMatchObject({
      permitId: issued.permitId,
      orgId: ORG_A
    });
  });
});


describe('batch ownership cannot silently expire', () => {
  test('the owner passes and a near-expiry lock is renewed', async () => {
    const { assertPairWitnessBatchLockOwner } = require('../src/services/sync/pair-witness-permit.js');
    const lock = await acquirePairWitnessBatchLock({});
    // Force the stored lock close to expiry.
    seed(PAIR_WITNESS_BATCH_LOCK_KEY, {
      token: lock.token,
      acquiredAt: Date.now() - 118_000,
      expiresAt: Date.now() + 2_000
    });

    await expect(assertPairWitnessBatchLockOwner({ lock })).resolves.toBe(true);

    const renewed = await store.get(PAIR_WITNESS_BATCH_LOCK_KEY);
    expect(renewed.token).toBe(lock.token);
    expect(renewed.expiresAt).toBeGreaterThan(Date.now() + 60_000);
    expect(lock.expiresAt).toBe(renewed.expiresAt);
  });

  test('a foreign token stops the old invocation', async () => {
    const { assertPairWitnessBatchLockOwner } = require('../src/services/sync/pair-witness-permit.js');
    const lock = await acquirePairWitnessBatchLock({});
    seed(PAIR_WITNESS_BATCH_LOCK_KEY, {
      token: 'another-invocation',
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 120_000
    });

    await expect(assertPairWitnessBatchLockOwner({ lock })).rejects.toMatchObject({
      code: 'PAIR_WITNESS_PERMIT_REFUSED',
      reason: PAIR_WITNESS_PERMIT_REASONS.LOCK_LOST,
      details: { reason: 'foreign-token' }
    });
  });

  test('an absent or expired lock stops the invocation', async () => {
    const { assertPairWitnessBatchLockOwner } = require('../src/services/sync/pair-witness-permit.js');
    const lock = await acquirePairWitnessBatchLock({});

    await store.del(PAIR_WITNESS_BATCH_LOCK_KEY);
    await expect(assertPairWitnessBatchLockOwner({ lock })).rejects.toMatchObject({
      reason: PAIR_WITNESS_PERMIT_REASONS.LOCK_LOST,
      details: { reason: 'expired' }
    });

    seed(PAIR_WITNESS_BATCH_LOCK_KEY, {
      token: lock.token,
      acquiredAt: Date.now() - 130_000,
      expiresAt: Date.now() - 10_000
    });
    await expect(assertPairWitnessBatchLockOwner({ lock })).rejects.toMatchObject({
      reason: PAIR_WITNESS_PERMIT_REASONS.LOCK_LOST
    });
  });

  test('an unreadable lock and a failed renewal both stop the invocation', async () => {
    const { assertPairWitnessBatchLockOwner } = require('../src/services/sync/pair-witness-permit.js');
    const lock = await acquirePairWitnessBatchLock({});

    await expect(assertPairWitnessBatchLockOwner({
      lock,
      deps: {
        getStored: async () => {
          throw new Error('kvs down');
        }
      }
    })).rejects.toMatchObject({ details: { reason: 'unreadable' } });

    // Renewal is only attempted when the lock is close to expiring.
    seed(PAIR_WITNESS_BATCH_LOCK_KEY, {
      token: lock.token,
      acquiredAt: Date.now() - 118_000,
      expiresAt: Date.now() + 2_000
    });
    await expect(assertPairWitnessBatchLockOwner({
      lock,
      deps: {
        setStoredWithTtl: async () => {
          throw new Error('write failed');
        }
      }
    })).rejects.toMatchObject({ details: { reason: 'renewal-failed' } });
  });

  test('a lockless caller is refused rather than assumed to own the batch', async () => {
    const { assertPairWitnessBatchLockOwner } = require('../src/services/sync/pair-witness-permit.js');
    await expect(assertPairWitnessBatchLockOwner({ lock: null }))
      .rejects.toMatchObject({ details: { reason: 'no-local-lock' } });
  });
});


describe('maintenance write audit trail through the real transport', () => {
  const auditEntries = () => logAuditEntry.mock.calls.map((call) => call[0]);

  function approvedWrite() {
    const plan = seedPlan();
    const record = witnessFor();
    seedPermit({ entry: entryFor(record, 'local') }, plan);
    return record;
  }

  test('records the attempt before transport and the outcome after it', async () => {
    const record = approvedWrite();
    forgeFetch.mockResolvedValue({ ok: true, status: 200 });

    await guardedFetch(localPath(record.localIssueId), {
      method: 'PUT',
      body: JSON.stringify(record)
    });

    const entries = auditEntries();
    expect(entries.map((entry) => entry.outcome)).toEqual(['attempted', 'succeeded']);
    expect(entries[0]).toMatchObject({
      action: 'pair_witness_property_write',
      source: 'jira_transport',
      orgId: ORG_A,
      site: 'local',
      issueId: record.localIssueId,
      pairId: record.pairId,
      permitId: 'pw_test_0001'
    });
    expect(entries[1]).toMatchObject({ outcome: 'succeeded', statusCode: 200 });
    // The attempt is logged before the transport is called, so it can never
    // claim more than "this was submitted".
    expect(logAuditEntry.mock.invocationCallOrder[0])
      .toBeLessThan(forgeFetch.mock.invocationCallOrder[0]);
    expect(logAuditEntry.mock.invocationCallOrder[1])
      .toBeGreaterThan(forgeFetch.mock.invocationCallOrder[0]);
  });

  test('a non-2xx answer is recorded as failed, never as succeeded', async () => {
    const record = approvedWrite();
    forgeFetch.mockResolvedValue({ ok: false, status: 500 });

    await guardedFetch(localPath(record.localIssueId), {
      method: 'PUT',
      body: JSON.stringify(record)
    });

    const entries = auditEntries();
    expect(entries.map((entry) => entry.outcome)).toEqual(['attempted', 'failed']);
    expect(entries[1]).toMatchObject({ outcome: 'failed', statusCode: 500, reason: 'http-status' });
  });

  test('a transport error is recorded as failed and still propagated', async () => {
    const record = approvedWrite();
    forgeFetch.mockRejectedValue(new Error('socket hang up'));

    await expect(guardedFetch(localPath(record.localIssueId), {
      method: 'PUT',
      body: JSON.stringify(record)
    })).rejects.toThrow('socket hang up');

    const entries = auditEntries();
    expect(entries.map((entry) => entry.outcome)).toEqual(['attempted', 'failed']);
    expect(entries[1]).toMatchObject({ outcome: 'failed', reason: 'transport-error', statusCode: null });
  });

  test('a refused permit is recorded as refused and nothing is submitted', async () => {
    const record = approvedWrite();
    await store.del('pilotPause');

    await expect(guardedFetch(localPath(record.localIssueId), {
      method: 'PUT',
      body: JSON.stringify(record)
    })).rejects.toMatchObject({ code: 'PAIR_WITNESS_PERMIT_REFUSED' });

    const entries = auditEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      outcome: 'refused',
      reason: PAIR_WITNESS_PERMIT_REASONS.PAUSE_NOT_CONFIRMED,
      site: 'local',
      issueId: record.localIssueId
    });
    expect(forgeFetch).not.toHaveBeenCalled();
  });

  test('an audit failure never blocks or alters the write', async () => {
    const record = approvedWrite();
    logAuditEntry.mockRejectedValue(new Error('audit storage down'));
    forgeFetch.mockResolvedValue({ ok: true, status: 200 });

    await expect(guardedFetch(localPath(record.localIssueId), {
      method: 'PUT',
      body: JSON.stringify(record)
    })).resolves.toMatchObject({ status: 200 });
    expect(forgeFetch).toHaveBeenCalledTimes(1);
  });

  test('the audit record carries identifiers only, never content or credentials', async () => {
    const record = approvedWrite();
    forgeFetch.mockResolvedValue({ ok: true, status: 200 });

    await guardedFetch(localPath(record.localIssueId), {
      method: 'PUT',
      body: JSON.stringify(record)
    });

    for (const entry of auditEntries()) {
      expect(Object.keys(entry).sort()).toEqual([
        'action',
        'issueId',
        'orgId',
        'outcome',
        'pairId',
        'permitId',
        'reason',
        'site',
        'source',
        'statusCode'
      ]);
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain('Basic');
      expect(serialized).not.toContain('Bearer');
      expect(serialized).not.toContain('token');
      expect(serialized).not.toContain(record.localKey);
      expect(serialized).not.toContain(record.remoteKey);
      expect(serialized).not.toContain('doc');
    }
  });
});

