/**
 * Controlled pairing-witness migration.
 *
 * The production plan/approve/apply/cancel code runs unmodified. Storage, Jira
 * identity reads, the property transport and the pause record are modelled, so
 * the assertions describe the real ordering and failure behaviour: local before
 * remote, read-back before progress, no delete, no conflict overwrite, and no
 * mapping or create-ledger write anywhere.
 */
import { resetStore, seed, store } from './helpers/pair-witness-store.js';
import {
  PAIR_WITNESS_ITEM_STATES,
  PAIR_WITNESS_MIGRATION_ERRORS,
  applyPairWitnessMigration,
  approvePairWitnessMigration,
  buildPairWitnessPlan,
  cancelPairWitnessMigration,
  getPairWitnessMigrationStatus,
  normalizePairSelection
} from '../src/services/sync/pair-witness-migration.js';
import {
  PAIR_WITNESS_PERMIT_KEY,
  PAIR_WITNESS_PLAN_KEY,
  PAIR_WITNESS_WRITE_MARKER_KEY,
  evaluatePairWitnessPermit
} from '../src/services/sync/pair-witness-permit.js';
import { buildWitnessBody } from '../src/services/sync/pair-witness-write.js';
import { deterministicPairId } from '../src/services/sync/pair-witness.js';

jest.mock('../src/services/storage/kvs.js', () => require('./helpers/pair-witness-store.js').kvsModule);
jest.mock('@forge/api', () => ({
  __esModule: true,
  default: { asApp: () => ({ requestJira: jest.fn() }), asUser: () => ({ requestJira: jest.fn() }) },
  getAppContext: jest.fn(() => ({
    appAri: { appId: '362d8e6b-b68c-4403-8020-d32fdcc02716' },
    environmentAri: { environmentId: '2e8c0cb5-881a-4345-b9ba-e887f790d316' },
    installationAri: { installationId: '974910c5-2861-4d40-a7eb-37802842d0a0' }
  })),
  route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
  fetch: jest.fn()
}));
jest.mock('../src/services/storage/stats.js', () => ({
  logAuditEntry: jest.fn(),
  trackWebhookSync: jest.fn(),
  trackApiCall: jest.fn()
}));

const APP_ID = '362d8e6b-b68c-4403-8020-d32fdcc02716';
const INSTALLATION_ID = '974910c5-2861-4d40-a7eb-37802842d0a0';
const ORG_A = 'org-1792917897410';
const ORG_B = 'org-1792934416107';
const LOCAL_SITE = '11111111-2222-4333-8444-555555555555';
const REMOTE_HOST = 'remote.atlassian.net';

const ORG = {
  id: ORG_A,
  name: 'STG MOB to VMOB',
  remoteUrl: `https://${REMOTE_HOST}`,
  remoteEmail: 'sync@example.com',
  remoteApiToken: 'remote-token'
};

function pair(n, overrides = {}) {
  return {
    localKey: `MOB-${n}`,
    remoteKey: `VMOB-${n}`,
    localIssueId: String(10000 + n),
    remoteIssueId: String(20000 + n),
    ...overrides
  };
}

/** Harness: preview pairs plus a mutable Jira-side property map. */
function harness({ pairs, overrides = {} } = {}) {
  const state = {
    witnesses: new Map(),
    writes: [],
    reads: [],
    putLocal: null,
    putRemote: null,
    pause: { paused: true, reasonCode: 'emergency_stop' }
  };

  const previewPairs = pairs.map((entry) => ({
    localKey: entry.localKey,
    remoteKey: entry.remoteKey,
    pairClass: entry.pairClass || 'ready-to-witness',
    mapping: { consistent: true, unreadable: false },
    ledger: { state: 'none', inDoubt: false, unreadable: false },
    ended: { present: false, unreadable: false },
    repaired: { present: false, unreadable: false },
    local: {
      issue: { class: 'present', id: entry.localIssueId, key: entry.localKey, statusCode: 200 },
      witness: entry.localWitness || { class: 'absent', pairId: null, state: null, statusCode: 404 }
    },
    remote: {
      issue: { class: 'present', id: entry.remoteIssueId, key: entry.remoteKey, statusCode: 200 },
      witness: entry.remoteWitness || { class: 'absent', pairId: null, state: null, statusCode: 404 }
    }
  }));

  // Storage the per-pair revalidation reads: both directed lookups must agree.
  for (const entry of pairs) {
    if (entry.seedDirections === false) continue;
    seed(`mapping-meta:${ORG_A}:${entry.localKey}`, {
      localKey: entry.localKey,
      remoteKey: entry.remoteKey,
      orgId: ORG_A
    });
    seed(`${ORG_A}:local-to-remote:${entry.localKey}`, entry.forward || entry.remoteKey);
    seed(`${ORG_A}:remote-to-local:${entry.remoteKey}`, entry.reverse || entry.localKey);
  }


  const deps = {
    getStored: store.get,
    setStoredWithTtl: async (key, value) => {
      seed(key, value);
    },
    deleteKey: store.del,
    getOrganizations: async () => [ORG],
    readPause: async () => state.pause,
    readIdentity: async () => ({
      readable: true,
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      environmentId: '2e8c0cb5-881a-4345-b9ba-e887f790d316',
      cloudIds: [LOCAL_SITE],
      siteHost: 'local.atlassian.net'
    }),
    preview: async () => ({
      success: true,
      organization: { id: ORG_A, name: ORG.name, remoteSite: REMOTE_HOST },
      pairs: previewPairs
    }),
    resolveIssue: async ({ side, issueRef }) => {
      const field = side === 'local' ? 'localIssueId' : 'remoteIssueId';
      const match = pairs.find((entry) => String(entry[field]) === String(issueRef));
      if (!match) return { class: 'missing', statusCode: 404, id: null, key: null };
      return {
        class: 'present',
        statusCode: 200,
        id: String(issueRef),
        key: match[side === 'local' ? 'localKey' : 'remoteKey']
      };
    },
    readWitness: async ({ side, issueRef, expected }) => {
      state.reads.push({ side, issueRef: String(issueRef) });
      const entry = state.witnesses.get(`${side}:${issueRef}`);
      if (!entry) {
        return {
          class: 'absent',
          code: 'PAIR_WITNESS_NOT_FOUND',
          statusCode: 404,
          pairId: null,
          state: null
        };
      }
      // Mirrors the production classifier: an existing witness for a different
      // pair is a conflict, never a match.
      if (expected && typeof expected.pairId === 'string' && entry.pairId !== expected.pairId) {
        return {
          class: 'different-pair',
          code: null,
          statusCode: 200,
          pairId: entry.pairId,
          state: entry.state,
          record: entry
        };
      }
      return {
        class: 'matching',
        code: null,
        statusCode: 200,
        pairId: entry.pairId,
        state: entry.state,
        record: entry
      };
    },
    putLocal: async (issueId, body) => {
      state.writes.push({ side: 'local', issueId: String(issueId), body });
      if (state.putLocal) return state.putLocal({ issueId: String(issueId), body, state });
      state.witnesses.set(`local:${issueId}`, JSON.parse(body));
      return { ok: true, status: 200 };
    },
    putRemote: async (_org, issueId, body) => {
      state.writes.push({ side: 'remote', issueId: String(issueId), body });
      if (state.putRemote) return state.putRemote({ issueId: String(issueId), body, state });
      state.witnesses.set(`remote:${issueId}`, JSON.parse(body));
      return { ok: true, status: 200 };
    },
    budget: () => ({ budgetMs: 0, deadline: 0, remainingMs: () => 0 }),
    now: () => Date.now(),
    ...overrides
  };

  return { deps, state, previewPairs };
}

function pairIdOf(entry) {
  return deterministicPairId({
    installationId: INSTALLATION_ID,
    orgId: ORG_A,
    localIssueId: entry.localIssueId,
    remoteIssueId: entry.remoteIssueId
  });
}

beforeEach(() => {
  resetStore();
});


describe('plan and approval', () => {
  test('a ready pair becomes a two-sided write and keeps a derived pair id', async () => {
    const { deps } = harness({ pairs: [pair(8), pair(9)] });
    const plan = await buildPairWitnessPlan({ orgId: ORG_A, deps });

    expect(plan.counts).toEqual({
      pairs: 2,
      writablePairs: 2,
      verifyOnlyPairs: 0,
      writesRequired: 4,
      excludedPairs: 0
    });
    expect(plan.items.map((entry) => entry.action)).toEqual(['both', 'both']);
    expect(plan.items[0].pairId).toBe(pairIdOf(pair(8)));
    expect(plan.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.approvalPhrase).toBe(
      `APPROVE WITNESS ${ORG_A} ${plan.digest.replace('sha256:', '').slice(0, 12)} 2`
    );
  });

  test('the pair id is stable across plans and changes with the organization', async () => {
    const first = await buildPairWitnessPlan({ orgId: ORG_A, deps: harness({ pairs: [pair(8)] }).deps });
    const second = await buildPairWitnessPlan({ orgId: ORG_A, deps: harness({ pairs: [pair(8)] }).deps });
    expect(first.items[0].pairId).toBe(second.items[0].pairId);
    expect(first.digest).toBe(second.digest);

    const otherOrg = deterministicPairId({
      installationId: INSTALLATION_ID,
      orgId: ORG_B,
      localIssueId: pair(8).localIssueId,
      remoteIssueId: pair(8).remoteIssueId
    });
    expect(otherOrg).not.toBe(first.items[0].pairId);
  });

  test('a fully witnessed pair is verify-only and a mismatching witness is excluded', async () => {
    const witnessed = pair(8);
    const mismatched = pair(9);
    const { deps } = harness({
      pairs: [
        {
          ...witnessed,
          pairClass: 'already-witnessed',
          localWitness: { class: 'matching', pairId: pairIdOf(witnessed) },
          remoteWitness: { class: 'matching', pairId: pairIdOf(witnessed) }
        },
        {
          ...mismatched,
          pairClass: 'already-witnessed',
          localWitness: { class: 'matching', pairId: 'other-pair-id' },
          remoteWitness: { class: 'matching', pairId: 'other-pair-id' }
        }
      ]
    });

    const plan = await buildPairWitnessPlan({ orgId: ORG_A, deps });

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].state).toBe(PAIR_WITNESS_ITEM_STATES.SKIPPED_VERIFIED);
    expect(plan.items[0].action).toBe('none');
    expect(plan.excluded).toEqual([
      { localKey: 'MOB-9', remoteKey: 'VMOB-9', reason: 'witness-pair-mismatch' }
    ]);
    expect(plan.counts.writablePairs).toBe(0);
  });

  test('a half-witnessed pair writes only the missing side', async () => {
    const entry = pair(8);
    const { deps } = harness({
      pairs: [{
        ...entry,
        pairClass: 'partially-witnessed',
        localWitness: { class: 'matching', pairId: pairIdOf(entry) }
      }]
    });

    const plan = await buildPairWitnessPlan({ orgId: ORG_A, deps });
    expect(plan.items[0].action).toBe('remote');
    expect(plan.counts.writesRequired).toBe(1);
  });

  test('unverifiable classifications are excluded, never approximated', async () => {
    const { deps } = harness({
      pairs: [
        { ...pair(8), pairClass: 'counterpart-missing' },
        { ...pair(9), pairClass: 'create-in-doubt' },
        { ...pair(10), pairClass: 'pair-ended' },
        { ...pair(11), pairClass: 'witness-inaccessible' }
      ]
    });

    const plan = await buildPairWitnessPlan({ orgId: ORG_A, deps });
    expect(plan.items).toHaveLength(0);
    expect(plan.excluded.map((entry) => entry.reason)).toEqual([
      'counterpart-missing',
      'create-in-doubt',
      'pair-ended',
      'witness-inaccessible'
    ]);
  });

  test('approval requires the exact phrase and writes the plan plus a permit', async () => {
    const { deps } = harness({ pairs: [pair(8)] });
    const plan = await buildPairWitnessPlan({ orgId: ORG_A, deps });

    await expect(approvePairWitnessMigration({ orgId: ORG_A, confirmation: 'nope', deps }))
      .rejects.toMatchObject({ code: PAIR_WITNESS_MIGRATION_ERRORS.CONFIRMATION_REQUIRED });
    expect(await store.get(PAIR_WITNESS_PLAN_KEY(ORG_A))).toBeNull();

    const approved = await approvePairWitnessMigration({
      orgId: ORG_A,
      confirmation: plan.approvalPhrase,
      accountId: 'admin-account',
      deps
    });

    expect(approved).toMatchObject({ success: true, status: 'approved', permitIssued: true });
    expect(approved.jiraWritesPerformed).toBe(0);
    const stored = await store.get(PAIR_WITNESS_PLAN_KEY(ORG_A));
    expect(stored).toMatchObject({ status: 'approved', approvedBy: 'admin-account', digest: plan.digest });
    const permit = await store.get(PAIR_WITNESS_PERMIT_KEY);
    expect(permit).toMatchObject({ orgId: ORG_A, planDigest: plan.digest });
    expect(permit.entries).toHaveLength(2);
  });

  test('approval refuses when the connector is not paused', async () => {
    const { deps, state } = harness({ pairs: [pair(8)] });
    state.pause = { paused: false };
    const plan = await buildPairWitnessPlan({ orgId: ORG_A, deps });

    await expect(approvePairWitnessMigration({ orgId: ORG_A, confirmation: plan.approvalPhrase, deps }))
      .rejects.toMatchObject({ code: PAIR_WITNESS_MIGRATION_ERRORS.PAUSE_REQUIRED });
  });

  test('approval refuses an empty plan', async () => {
    const { deps } = harness({ pairs: [{ ...pair(8), pairClass: 'mapping-mismatch' }] });
    await expect(approvePairWitnessMigration({ orgId: ORG_A, confirmation: 'x', deps }))
      .rejects.toMatchObject({ code: PAIR_WITNESS_MIGRATION_ERRORS.PLAN_EMPTY });
  });
});


async function approvedRun(h, orgId = ORG_A) {
  const plan = await buildPairWitnessPlan({ orgId, deps: h.deps });
  await approvePairWitnessMigration({
    orgId,
    confirmation: plan.approvalPhrase,
    accountId: 'admin',
    deps: h.deps
  });
  return plan;
}

describe('batch execution', () => {
  test('writes local then remote, verifies both, and records progress', async () => {
    const h = harness({ pairs: [pair(8), pair(9)] });
    await approvedRun(h);

    const result = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });

    expect(result.success).toBe(true);
    expect(result.writesPerformed).toBe(4);
    expect(result.states[PAIR_WITNESS_ITEM_STATES.VERIFIED]).toBe(2);
    expect(result.remaining).toBe(0);
    expect(result.status).toBe('completed');

    // Ordering: local before remote for every pair.
    expect(h.state.writes.map((entry) => entry.side)).toEqual([
      'local', 'remote', 'local', 'remote'
    ]);
    // The permit is single-batch and is gone afterwards.
    expect(await store.get(PAIR_WITNESS_PERMIT_KEY)).toBeNull();
    // Markers exist for all four issues.
    for (const entry of [pair(8), pair(9)]) {
      expect(await store.get(PAIR_WITNESS_WRITE_MARKER_KEY(ORG_A, 'local', entry.localIssueId)))
        .toBeTruthy();
      expect(await store.get(PAIR_WITNESS_WRITE_MARKER_KEY(ORG_A, REMOTE_HOST, entry.remoteIssueId)))
        .toBeTruthy();
    }
  });

  test('both written bodies carry the same derived pair id', async () => {
    const h = harness({ pairs: [pair(8)] });
    await approvedRun(h);
    await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });

    const bodies = h.state.writes.map((entry) => JSON.parse(entry.body));
    expect(bodies[0].pairId).toBe(bodies[1].pairId);
    expect(bodies[0].pairId).toBe(pairIdOf(pair(8)));
    expect(bodies[0].localIssueId).toBe(pair(8).localIssueId);
    expect(bodies[1].remoteIssueId).toBe(pair(8).remoteIssueId);
  });

  test('a failing local write stops before the remote write', async () => {
    const h = harness({ pairs: [pair(8)] });
    await approvedRun(h);
    h.state.putLocal = async () => ({ ok: false, status: 403 });

    const result = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });

    expect(h.state.writes).toHaveLength(1);
    expect(h.state.writes[0].side).toBe('local');
    expect(result.states[PAIR_WITNESS_ITEM_STATES.CONFLICT]).toBe(1);
    expect(result.remaining).toBe(0);
    expect(result.status).toBe('needs-attention');
    expect(await store.get(PAIR_WITNESS_WRITE_MARKER_KEY(ORG_A, REMOTE_HOST, pair(8).remoteIssueId)))
      .toBeNull();
  });

  test('a failing remote write keeps the local witness and reports a partial pair', async () => {
    const h = harness({ pairs: [pair(8)] });
    await approvedRun(h);
    h.state.putRemote = async () => ({ ok: false, status: 500 });

    const result = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });

    expect(result.states[PAIR_WITNESS_ITEM_STATES.PARTIAL]).toBe(1);
    // The local property is still there: evidence is never rolled back.
    expect(h.state.witnesses.get(`local:${pair(8).localIssueId}`)).toBeTruthy();
    expect(h.state.witnesses.get(`remote:${pair(8).remoteIssueId}`)).toBeUndefined();
    const status = await getPairWitnessMigrationStatus({ orgId: ORG_A, deps: h.deps });
    expect(status.plan.states[PAIR_WITNESS_ITEM_STATES.PARTIAL]).toBe(1);
  });

  test('an ambiguous remote write that landed is verified instead of retried', async () => {
    const h = harness({ pairs: [pair(8)] });
    await approvedRun(h);
    let calls = 0;
    h.state.putRemote = async ({ issueId, body, state }) => {
      calls += 1;
      state.witnesses.set(`remote:${issueId}`, JSON.parse(body));
      return { ok: false, status: 503 };
    };

    const result = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });

    expect(calls).toBe(1);
    expect(result.states[PAIR_WITNESS_ITEM_STATES.VERIFIED]).toBe(1);
  });

  test('an ambiguous write that did not land is retried once with the same pair id', async () => {
    const h = harness({ pairs: [pair(8)] });
    await approvedRun(h);
    const seen = [];
    let calls = 0;
    h.state.putRemote = async ({ issueId, body, state }) => {
      calls += 1;
      seen.push(JSON.parse(body).pairId);
      if (calls === 1) return { ok: false, status: 504 };
      state.witnesses.set(`remote:${issueId}`, JSON.parse(body));
      return { ok: true, status: 200 };
    };

    const result = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });

    expect(calls).toBe(2);
    expect(seen[0]).toBe(seen[1]);
    expect(result.states[PAIR_WITNESS_ITEM_STATES.VERIFIED]).toBe(1);
  });

  test('a 429 defers the batch without recording progress', async () => {
    const h = harness({ pairs: [pair(8)] });
    await approvedRun(h);
    h.state.putLocal = async () => ({ ok: false, status: 429, headers: new Map() });

    const result = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });

    expect(result.stopReason).toBe('rate-limited');
    expect(result.states[PAIR_WITNESS_ITEM_STATES.DEFERRED]).toBe(1);
    expect(result.remaining).toBe(1);
    expect(h.state.witnesses.size).toBe(0);
  });
});


describe('interruption, expiry and continuation', () => {
  test('a crash after the local write resumes and writes only the remote side', async () => {
    const h = harness({ pairs: [pair(8)] });
    await approvedRun(h);
    // Simulate: local property already written, remote not, item still pending.
    const localRecord = {
      pairId: pairIdOf(pair(8)),
      state: 'active'
    };
    h.state.witnesses.set(`local:${pair(8).localIssueId}`, {
      ...localJSON(h, pair(8)),
      ...localRecord
    });

    const result = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });

    expect(result.states[PAIR_WITNESS_ITEM_STATES.VERIFIED]).toBe(1);
    expect(h.state.writes.map((entry) => entry.side)).toEqual(['remote']);
  });

  test('a crash before any write resumes both sides with the same pair id', async () => {
    const h = harness({ pairs: [pair(8)] });
    const plan = await approvedRun(h);
    const firstPairId = plan.items[0].pairId;

    const result = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });
    const bodies = h.state.writes.map((entry) => JSON.parse(entry.body));

    expect(result.writesPerformed).toBe(2);
    expect(bodies.every((body) => body.pairId === firstPairId)).toBe(true);
  });

  test('an expired permit stops the batch until the plan is revalidated for continuation', async () => {
    const h = harness({ pairs: [pair(8)] });
    await approvedRun(h);
    // The permit vanishes (TTL) or is expired: the next batch re-mints one after
    // revalidating the stored plan, and never reuses the old authority.
    await store.del(PAIR_WITNESS_PERMIT_KEY);

    const result = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });
    expect(result.states[PAIR_WITNESS_ITEM_STATES.VERIFIED]).toBe(1);
    expect(await store.get(PAIR_WITNESS_PERMIT_KEY)).toBeNull();
  });

  test('an expired plan refuses continuation and keeps the recorded results', async () => {
    const h = harness({ pairs: [pair(8)] });
    await approvedRun(h);
    const stored = await store.get(PAIR_WITNESS_PLAN_KEY(ORG_A));
    seed(PAIR_WITNESS_PLAN_KEY(ORG_A), { ...stored, expiresAt: Date.now() - 1 });

    await expect(applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps }))
      .rejects.toMatchObject({ code: PAIR_WITNESS_MIGRATION_ERRORS.PLAN_EXPIRED });

    // The plan record itself is still there: expiry stops writes, not history.
    expect(await store.get(PAIR_WITNESS_PLAN_KEY(ORG_A))).toBeTruthy();
    expect(h.state.writes).toHaveLength(0);
  });

  test('a tampered plan is refused rather than applied', async () => {
    const h = harness({ pairs: [pair(8)] });
    await approvedRun(h);
    const stored = await store.get(PAIR_WITNESS_PLAN_KEY(ORG_A));
    seed(PAIR_WITNESS_PLAN_KEY(ORG_A), {
      ...stored,
      items: stored.items.map((entry) => ({ ...entry, remoteIssueId: '99999' }))
    });

    await expect(applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps }))
      .rejects.toMatchObject({ code: PAIR_WITNESS_MIGRATION_ERRORS.PLAN_NOT_APPROVED });
    expect(h.state.writes).toHaveLength(0);
  });

  test('a concurrent batch is refused while another holds the lock', async () => {
    const h = harness({ pairs: [pair(8)] });
    await approvedRun(h);
    seed('pairWitnessBatchLock', { token: 'other-process', acquiredAt: Date.now(), expiresAt: Date.now() + 60000 });

    await expect(applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps }))
      .rejects.toMatchObject({ code: PAIR_WITNESS_MIGRATION_ERRORS.BUSY });
    expect(h.state.writes).toHaveLength(0);
  });

  test('batches are bounded and the second batch continues where the first stopped', async () => {
    const pairs = Array.from({ length: 12 }, (_, index) => pair(index + 1));
    const h = harness({ pairs });
    await approvedRun(h);

    const first = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });
    expect(first.batchSize).toBe(10);
    expect(first.remaining).toBe(2);
    expect(first.writesPerformed).toBe(20);

    const second = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });
    expect(second.batchSize).toBe(2);
    expect(second.remaining).toBe(0);
    expect(second.status).toBe('completed');

    // No issue is written twice across batches.
    const written = h.state.writes.map((entry) => `${entry.side}:${entry.issueId}`);
    expect(new Set(written).size).toBe(written.length);
    expect(written).toHaveLength(24);
  });

  test('a completed plan performs no further writes and stays completed', async () => {
    const h = harness({ pairs: [pair(8)] });
    await approvedRun(h);
    const first = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });
    expect(first.status).toBe('completed');
    const before = h.state.writes.length;

    const again = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });
    expect(again.writesPerformed).toBe(0);
    expect(again.status).toBe('completed');
    expect(h.state.writes).toHaveLength(before);
  });

  test('a conflicted plan reports needs-attention and refuses new work', async () => {
    const h = harness({ pairs: [pair(8)] });
    await approvedRun(h);
    h.state.witnesses.set(`local:${pair(8).localIssueId}`, {
      ...localJSON(h, pair(8)),
      pairId: 'conflicting-pair-id'
    });

    const result = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });
    expect(result.status).toBe('needs-attention');
    expect(result.states[PAIR_WITNESS_ITEM_STATES.CONFLICT]).toBe(1);
    expect(h.state.writes).toHaveLength(0);
  });
});

function localJSON(h, entry) {
  const body = h.state.writes.find((write) => write.side === 'local' && write.issueId === entry.localIssueId);
  return body ? JSON.parse(body.body) : {};
}


describe('evidence preservation and scope isolation', () => {
  test('an ended witness is reported as historical and never overwritten', async () => {
    const h = harness({ pairs: [pair(8)] });
    const endedRecord = { pairId: pairIdOf(pair(8)), state: 'ended' };
    h.state.witnesses.set(`local:${pair(8).localIssueId}`, endedRecord);

    // The preview classifies this pair as ended, so it never reaches the plan.
    const plan = await buildPairWitnessPlan({
      orgId: ORG_A,
      deps: { ...h.deps, preview: async () => ({
        success: true,
        organization: { id: ORG_A, remoteSite: REMOTE_HOST },
        pairs: [{
          localKey: pair(8).localKey,
          remoteKey: pair(8).remoteKey,
          pairClass: 'witness-ended',
          local: {
            issue: { class: 'present', id: pair(8).localIssueId, key: pair(8).localKey },
            witness: { class: 'ended', pairId: pairIdOf(pair(8)), state: 'ended' }
          },
          remote: {
            issue: { class: 'present', id: pair(8).remoteIssueId, key: pair(8).remoteKey },
            witness: { class: 'absent', pairId: null }
          }
        }]
      }) }
    });

    expect(plan.items).toHaveLength(0);
    expect(plan.excluded[0].reason).toBe('witness-ended');
    expect(h.state.witnesses.get(`local:${pair(8).localIssueId}`)).toEqual(endedRecord);
  });

  test('cancellation revokes the permit and plan without any Jira request', async () => {
    const h = harness({ pairs: [pair(8)] });
    await approvedRun(h);

    const result = await cancelPairWitnessMigration({ orgId: ORG_A, deps: h.deps });

    expect(result).toMatchObject({
      success: true,
      permitRevoked: true,
      planDeleted: true,
      jiraRequests: 0,
      propertiesDeleted: 0
    });
    expect(await store.get(PAIR_WITNESS_PERMIT_KEY)).toBeNull();
    expect(await store.get(PAIR_WITNESS_PLAN_KEY(ORG_A))).toBeNull();
    expect(h.state.writes).toHaveLength(0);
  });

  test('an Org B batch cannot run against an Org A plan', async () => {
    const h = harness({ pairs: [pair(8)] });
    await approvedRun(h, ORG_A);

    await expect(applyPairWitnessMigration({ orgId: ORG_B, deps: h.deps }))
      .rejects.toMatchObject({ code: PAIR_WITNESS_MIGRATION_ERRORS.PLAN_MISSING });
    expect(h.state.writes).toHaveLength(0);
  });

  test('the migration writes no mapping, ledger or create-operation record', async () => {
    const h = harness({ pairs: [pair(8), pair(9)] });
    await approvedRun(h);
    store.set.mockClear();

    await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });

    const writtenKeys = store.set.mock.calls.map((call) => String(call[0]));
    expect(writtenKeys.some((key) => key.startsWith('mapping-meta:'))).toBe(false);
    expect(writtenKeys.some((key) => key.includes(':local-to-remote:'))).toBe(false);
    expect(writtenKeys.some((key) => key.startsWith('issue-create-op:'))).toBe(false);
    expect(writtenKeys.some((key) => key.startsWith('mapping-repair:'))).toBe(false);
  });

  test('status inspection reports plan, states and permit without writing', async () => {
    const h = harness({ pairs: [pair(8)] });
    await approvedRun(h);
    await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });
    const before = store.set.mock.calls.length;

    const status = await getPairWitnessMigrationStatus({ orgId: ORG_A, deps: h.deps });

    expect(status.plan.status).toBe('completed');
    expect(status.plan.states[PAIR_WITNESS_ITEM_STATES.VERIFIED]).toBe(1);
    expect(status.plan.items[0]).toMatchObject({
      localKey: 'MOB-8',
      remoteKey: 'VMOB-8',
      state: PAIR_WITNESS_ITEM_STATES.VERIFIED
    });
    expect(status.permit).toBeNull();
    expect(store.set.mock.calls.length).toBe(before);
  });

  test('the migration modules contain no create, field-update or delete verb', () => {
    const fs = require('fs');
    const path = require('path');
    const root = process.cwd();
    const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

    for (const file of [
      'src/services/sync/pair-witness-migration.js',
      'src/services/sync/pair-witness-write.js',
      'src/services/sync/pair-witness-permit.js'
    ]) {
      const source = read(file);
      expect(source).not.toMatch(/method:\s*'(POST|DELETE|PATCH)'/);
      expect(source).not.toContain('createRemoteIssue');
      expect(source).not.toContain('beginIssueCreateOperation');
      expect(source).not.toContain('storeMapping');
      expect(source).not.toContain('resumePilot');
      expect(source).not.toContain('updateIssueDescription');
      // The only property key any of these may address.
      expect(source).not.toContain('last-synced');
    }

    const writeSource = read('src/services/sync/pair-witness-write.js');
    const putVerbs = [...writeSource.matchAll(/method:\s*'([A-Z]+)'/g)].map((match) => match[1]);
    expect(putVerbs).toEqual(['PUT', 'PUT']);
  });
});


describe('overlapping writers are prevented', () => {
  test('a lock taken mid-pair stops the second write', async () => {
    const h = harness({ pairs: [pair(8)] });
    await approvedRun(h);
    h.state.putLocal = async ({ issueId, body, state }) => {
      state.witnesses.set(`local:${issueId}`, JSON.parse(body));
      // Another invocation steals the batch between the two writes.
      seed('pairWitnessBatchLock', {
        token: 'other-invocation',
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 120_000
      });
      return { ok: true, status: 200 };
    };

    const result = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });

    expect(result.stopReason).toBe('lock-lost');
    expect(h.state.writes.map((entry) => entry.side)).toEqual(['local']);
    expect(result.states[PAIR_WITNESS_ITEM_STATES.DEFERRED]).toBe(1);
    expect(result.remaining).toBe(1);
    expect(h.state.witnesses.get(`local:${pair(8).localIssueId}`)).toBeTruthy();
  });

  test('a lock lost before the first write produces no write at all', async () => {
    const h = harness({ pairs: [pair(8)] });
    await approvedRun(h);
    const original = h.deps.readWitness;
    let calls = 0;
    h.deps.readWitness = async (request) => {
      calls += 1;
      if (calls === 2) {
        await store.del('pairWitnessBatchLock');
      }
      return original(request);
    };

    const result = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });

    expect(result.stopReason).toBe('lock-lost');
    expect(h.state.writes).toHaveLength(0);
    expect(result.remaining).toBe(1);
  });

  test('ownership is re-read before each property write in a healthy batch', async () => {
    const h = harness({ pairs: [pair(8), pair(9)] });
    await approvedRun(h);
    let lockReads = 0;
    const original = h.deps.getStored;
    h.deps.getStored = async (key) => {
      if (key === 'pairWitnessBatchLock') lockReads += 1;
      return original(key);
    };

    const result = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });

    expect(result.writesPerformed).toBe(4);
    // Acquisition plus one ownership check before each of the four PUTs.
    expect(lockReads).toBeGreaterThanOrEqual(4);
  });
});


describe('partial completion recovers without duplicate work', () => {
  /** The exact body the migration writes, derived from the approved plan. */
  function bodyFor(plan, entry) {
    return {
      v: 1,
      pairId: plan.items[0].pairId,
      state: 'active',
      installationId: INSTALLATION_ID,
      appId: APP_ID,
      orgId: ORG_A,
      localSite: LOCAL_SITE,
      remoteSite: REMOTE_HOST,
      localIssueId: entry.localIssueId,
      localKey: entry.localKey,
      remoteIssueId: entry.remoteIssueId,
      remoteKey: entry.remoteKey,
      direction: 'local-to-remote',
      writtenAt: new Date().toISOString(),
      digest: 'sha256:placeholder'
    };
  }

  test('a PUT that landed before the crash is not written again', async () => {
    const h = harness({ pairs: [pair(8)] });
    const plan = await approvedRun(h);
    // The local property was written, then the process died before progress.
    h.state.witnesses.set(`local:${pair(8).localIssueId}`, bodyFor(plan, pair(8)));

    const result = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });

    expect(h.state.writes.map((entry) => entry.side)).toEqual(['remote']);
    expect(result.states[PAIR_WITNESS_ITEM_STATES.VERIFIED]).toBe(1);
  });

  test('both properties written without markers still verify, and re-running writes nothing', async () => {
    const h = harness({ pairs: [pair(8)] });
    const plan = await approvedRun(h);
    h.state.witnesses.set(`local:${pair(8).localIssueId}`, bodyFor(plan, pair(8)));
    h.state.witnesses.set(`remote:${pair(8).remoteIssueId}`, bodyFor(plan, pair(8)));

    const first = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });
    expect(first.writesPerformed).toBe(0);
    expect(first.states[PAIR_WITNESS_ITEM_STATES.VERIFIED]).toBe(1);

    const second = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });
    expect(second.writesPerformed).toBe(0);
    expect(h.state.writes).toHaveLength(0);
  });

  test('a marker without progress does not block verification of a correct pair', async () => {
    const h = harness({ pairs: [pair(8)] });
    const plan = await approvedRun(h);
    seed(PAIR_WITNESS_WRITE_MARKER_KEY(ORG_A, 'local', pair(8).localIssueId), {
      pairId: plan.items[0].pairId,
      writtenAt: new Date().toISOString()
    });
    h.state.witnesses.set(`local:${pair(8).localIssueId}`, bodyFor(plan, pair(8)));
    h.state.witnesses.set(`remote:${pair(8).remoteIssueId}`, bodyFor(plan, pair(8)));

    const result = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });

    expect(result.states[PAIR_WITNESS_ITEM_STATES.VERIFIED]).toBe(1);
    expect(h.state.writes).toHaveLength(0);
  });

  test('a permit expiring after the local write defers the pair instead of conflicting it', async () => {
    const h = harness({ pairs: [pair(8)] });
    await approvedRun(h);
    // The first write lands; the transport then refuses the second because the
    // permit is gone, exactly as the real boundary would.
    h.state.putLocal = async ({ issueId, body, state }) => {
      state.witnesses.set(`local:${issueId}`, JSON.parse(body));
      return { ok: true, status: 200 };
    };
    h.state.putRemote = async () => {
      const error = new Error('The maintenance permit has expired.');
      error.code = 'PAIR_WITNESS_PERMIT_REFUSED';
      error.reason = 'PAIR_WITNESS_PERMIT_EXPIRED';
      throw error;
    };

    const result = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });

    expect(result.states[PAIR_WITNESS_ITEM_STATES.DEFERRED]).toBe(1);
    expect(result.states[PAIR_WITNESS_ITEM_STATES.CONFLICT]).toBeUndefined();
    expect(result.status).not.toBe('needs-attention');
    expect(h.state.witnesses.get(`local:${pair(8).localIssueId}`)).toBeTruthy();
    // No pointless retry of a refused write.
    expect(h.state.writes.filter((entry) => entry.side === 'remote')).toHaveLength(1);

    // A later run continues and writes only the missing side.
    h.state.putRemote = null;
    const resumed = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });
    expect(resumed.states[PAIR_WITNESS_ITEM_STATES.VERIFIED]).toBe(1);
    expect(h.state.writes.filter((entry) => entry.side === 'local')).toHaveLength(1);
    expect(h.state.writes.filter((entry) => entry.side === 'remote')).toHaveLength(2);
  });

  test('a terminal permit refusal conflicts the pair instead of deferring forever', async () => {
    const h = harness({ pairs: [pair(8)] });
    await approvedRun(h);
    h.state.putLocal = async () => {
      const error = new Error('The property payload does not match the approved payload.');
      error.code = 'PAIR_WITNESS_PERMIT_REFUSED';
      error.reason = 'PAIR_WITNESS_PERMIT_PAYLOAD_MISMATCH';
      throw error;
    };

    const result = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });

    expect(result.states[PAIR_WITNESS_ITEM_STATES.CONFLICT]).toBe(1);
    expect(result.status).toBe('needs-attention');
    // The attempt was refused before any property changed.
    expect(h.state.witnesses.size).toBe(0);
  });

  test('re-running against identical witnesses performs no property write', async () => {
    const h = harness({ pairs: [pair(8), pair(9)] });
    await approvedRun(h);
    await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });
    const writesSoFar = h.state.writes.length;

    const again = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });

    expect(again.writesPerformed).toBe(0);
    expect(h.state.writes).toHaveLength(writesSoFar);
  });
});


describe('explicit pair selection', () => {
  const select = (...entries) => entries.map((n) => ({ localKey: `MOB-${n}`, remoteKey: `VMOB-${n}` }));

  async function approveSelected(h, pairs, orgId = ORG_A) {
    const plan = await buildPairWitnessPlan({ orgId, pairs, deps: h.deps });
    const approved = await approvePairWitnessMigration({
      orgId,
      pairs,
      confirmation: plan.approvalPhrase,
      accountId: 'admin',
      deps: h.deps
    });
    return { plan, approved };
  }

  test('a single selected pair yields one item and exactly two property writes', async () => {
    const h = harness({ pairs: [pair(8), pair(9), pair(10)] });
    const { plan, approved } = await approveSelected(h, select(8));

    expect(plan.selectionMode).toBe('explicit');
    expect(plan.selection).toEqual([{ localKey: 'MOB-8', remoteKey: 'VMOB-8' }]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ localKey: 'MOB-8', remoteKey: 'VMOB-8', action: 'both' });
    expect(plan.counts).toMatchObject({ pairs: 1, writablePairs: 1, writesRequired: 2 });

    expect(approved.permitEntries).toBe(2);
    const permit = await store.get(PAIR_WITNESS_PERMIT_KEY);
    expect(permit.entries.map((entry) => entry.issueId).sort())
      .toEqual([pair(8).localIssueId, pair(8).remoteIssueId].sort());

    const result = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });
    expect(result.writesPerformed).toBe(2);
    expect(h.state.writes.map((entry) => `${entry.side}:${entry.issueId}`).sort())
      .toEqual([`local:${pair(8).localIssueId}`, `remote:${pair(8).remoteIssueId}`].sort());
    expect(result.states[PAIR_WITNESS_ITEM_STATES.VERIFIED]).toBe(1);
  });

  test('selection cannot expand between planning and approval', async () => {
    const h = harness({ pairs: [pair(8), pair(9)] });
    const plan = await buildPairWitnessPlan({ orgId: ORG_A, pairs: select(8), deps: h.deps });

    await expect(approvePairWitnessMigration({
      orgId: ORG_A,
      pairs: select(8, 9),
      confirmation: plan.approvalPhrase,
      deps: h.deps
    })).rejects.toMatchObject({ code: PAIR_WITNESS_MIGRATION_ERRORS.CONFIRMATION_REQUIRED });

    expect(await store.get(PAIR_WITNESS_PLAN_KEY(ORG_A))).toBeNull();
    expect(await store.get(PAIR_WITNESS_PERMIT_KEY)).toBeNull();
  });

  test('an explicitly empty selection is refused and never read as all pairs', async () => {
    const h = harness({ pairs: [pair(8)] });

    await expect(buildPairWitnessPlan({ orgId: ORG_A, pairs: [], deps: h.deps }))
      .rejects.toMatchObject({ code: PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_EMPTY });
    await expect(approvePairWitnessMigration({
      orgId: ORG_A,
      pairs: [],
      confirmation: 'APPROVE WITNESS x y 0',
      deps: h.deps
    })).rejects.toMatchObject({ code: PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_EMPTY });
    expect(await store.get(PAIR_WITNESS_PLAN_KEY(ORG_A))).toBeNull();
  });

  test('unknown, mismatched, duplicate and other-organization pairs are refused', async () => {
    const h = harness({ pairs: [pair(8), pair(9)] });

    await expect(buildPairWitnessPlan({
      orgId: ORG_A,
      pairs: [{ localKey: 'MOB-99', remoteKey: 'VMOB-99' }],
      deps: h.deps
    })).rejects.toMatchObject({ code: PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_PAIR_UNKNOWN });

    await expect(buildPairWitnessPlan({
      orgId: ORG_A,
      pairs: [{ localKey: 'MOB-8', remoteKey: 'VMOB-9' }],
      deps: h.deps
    })).rejects.toMatchObject({ code: PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_PAIR_MISMATCH });

    await expect(buildPairWitnessPlan({
      orgId: ORG_A,
      pairs: select(8, 8),
      deps: h.deps
    })).rejects.toMatchObject({ code: PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_DUPLICATE });

    await expect(buildPairWitnessPlan({
      orgId: ORG_A,
      pairs: [{ localKey: 'MOB-8', remoteKey: 'VMOB-8' }, { localKey: 'MOB-8', remoteKey: 'VMOB-9' }],
      deps: h.deps
    })).rejects.toMatchObject({ code: PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_DUPLICATE });

    await expect(buildPairWitnessPlan({
      orgId: ORG_A,
      pairs: [{ localKey: 'DEV-2', remoteKey: 'SAM1-16' }],
      deps: h.deps
    })).rejects.toMatchObject({ code: PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_PAIR_UNKNOWN });
  });
});


describe('explicit selection: scope, digest and permit containment', () => {
  const select = (...entries) => entries.map((n) => ({ localKey: `MOB-${n}`, remoteKey: `VMOB-${n}` }));

  test('a selected pair that cannot be witnessed refuses the whole plan', async () => {
    const h = harness({
      pairs: [pair(8), { ...pair(9), pairClass: 'witness-conflict' }]
    });

    await expect(buildPairWitnessPlan({ orgId: ORG_A, pairs: select(9), deps: h.deps }))
      .rejects.toMatchObject({
        code: PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_PAIR_INELIGIBLE,
        details: { reason: 'witness-conflict' }
      });

    await expect(buildPairWitnessPlan({ orgId: ORG_A, pairs: select(8, 9), deps: h.deps }))
      .rejects.toMatchObject({ code: PAIR_WITNESS_MIGRATION_ERRORS.SELECTION_PAIR_INELIGIBLE });

    expect(await store.get(PAIR_WITNESS_PLAN_KEY(ORG_A))).toBeNull();
  });

  test('omitting the selection keeps the whole-organization behaviour', async () => {
    const h = harness({
      pairs: [pair(8), pair(9), { ...pair(10), pairClass: 'pair-ended' }]
    });
    const plan = await buildPairWitnessPlan({ orgId: ORG_A, deps: h.deps });

    expect(plan.selectionMode).toBe('organization');
    expect(plan.selection).toBeNull();
    expect(plan.items.map((entry) => entry.localKey)).toEqual(['MOB-8', 'MOB-9']);
    expect(plan.excluded).toEqual([
      { localKey: 'MOB-10', remoteKey: 'VMOB-10', reason: 'pair-ended' }
    ]);
  });

  test('a one-pair digest differs from the whole-organization digest', async () => {
    const pairs = Array.from({ length: 20 }, (_, index) => pair(index + 1));
    const h = harness({ pairs });

    const full = await buildPairWitnessPlan({ orgId: ORG_A, deps: h.deps });
    const single = await buildPairWitnessPlan({ orgId: ORG_A, pairs: select(8), deps: h.deps });

    expect(full.counts.pairs).toBe(20);
    expect(single.counts.pairs).toBe(1);
    expect(single.digest).not.toBe(full.digest);
    expect(single.approvalPhrase).not.toBe(full.approvalPhrase);
  });

  test('the whole-organization phrase cannot approve a one-pair plan and vice versa', async () => {
    const h = harness({ pairs: [pair(8), pair(9)] });
    const full = await buildPairWitnessPlan({ orgId: ORG_A, deps: h.deps });
    const single = await buildPairWitnessPlan({ orgId: ORG_A, pairs: select(8), deps: h.deps });

    await expect(approvePairWitnessMigration({
      orgId: ORG_A,
      pairs: select(8),
      confirmation: full.approvalPhrase,
      deps: h.deps
    })).rejects.toMatchObject({ code: PAIR_WITNESS_MIGRATION_ERRORS.CONFIRMATION_REQUIRED });

    await expect(approvePairWitnessMigration({
      orgId: ORG_A,
      confirmation: single.approvalPhrase,
      deps: h.deps
    })).rejects.toMatchObject({ code: PAIR_WITNESS_MIGRATION_ERRORS.CONFIRMATION_REQUIRED });
  });

  test('the selection is normalized into canonical order', () => {
    const normalized = normalizePairSelection([
      { localKey: 'MOB-9', remoteKey: 'VMOB-9' },
      { localKey: 'MOB-10', remoteKey: 'VMOB-10' },
      { localKey: 'MOB-8', remoteKey: 'VMOB-8' }
    ]);
    expect(normalized.map((entry) => entry.localKey)).toEqual(['MOB-10', 'MOB-8', 'MOB-9']);
    expect(normalizePairSelection(undefined)).toBeNull();
    expect(() => normalizePairSelection('MOB-8')).toThrow();
  });
});


describe('explicit selection: permit containment and idempotence', () => {
  const select = (n) => [{ localKey: `MOB-${n}`, remoteKey: `VMOB-${n}` }];

  async function approveOne(h, n) {
    const pairs = select(n);
    const plan = await buildPairWitnessPlan({ orgId: ORG_A, pairs, deps: h.deps });
    await approvePairWitnessMigration({
      orgId: ORG_A,
      pairs,
      confirmation: plan.approvalPhrase,
      deps: h.deps
    });
    return plan;
  }

  test('a second batch on a one-pair plan is a no-op and leaves the other pair alone', async () => {
    const h = harness({ pairs: [pair(8), pair(9)] });
    await approveOne(h, 8);

    const first = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });
    expect(first.writesPerformed).toBe(2);

    const second = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });
    expect(second.writesPerformed).toBe(0);
    expect(h.state.writes).toHaveLength(2);
    expect(h.state.witnesses.get(`local:${pair(9).localIssueId}`)).toBeUndefined();
  });

  test('the selected permit authorizes no other issue', async () => {
    const h = harness({ pairs: [pair(8), pair(9)] });
    await approveOne(h, 8);
    seed('pilotPause', {
      paused: true,
      pausedAt: new Date().toISOString(),
      reasonCode: 'emergency_stop'
    });

    const permit = await store.get(PAIR_WITNESS_PERMIT_KEY);
    const localEntry = permit.entries.find((entry) => entry.site === 'local');
    const path = (issueId) => `/rest/api/3/issue/${issueId}/properties/sync-connector-pair`;
    const bodyFor = (issueId, localKey) => JSON.stringify(buildWitnessBody({
      pairId: localEntry.pairId,
      installationId: INSTALLATION_ID,
      appId: APP_ID,
      orgId: ORG_A,
      localSite: LOCAL_SITE,
      remoteSite: REMOTE_HOST,
      localIssueId: issueId,
      localKey,
      remoteIssueId: pair(8).remoteIssueId,
      remoteKey: pair(8).remoteKey,
      direction: 'local-to-remote',
      writtenAt: new Date().toISOString()
    }));

    const allowed = await evaluatePairWitnessPermit({
      method: 'PUT',
      raw: path(localEntry.issueId),
      pathname: path(localEntry.issueId),
      body: bodyFor(pair(8).localIssueId, 'MOB-8')
    });
    expect(allowed.allowed).toBe(true);

    const refused = await evaluatePairWitnessPermit({
      method: 'PUT',
      raw: path(pair(9).localIssueId),
      pathname: path(pair(9).localIssueId),
      body: bodyFor(pair(9).localIssueId, 'MOB-9')
    });
    expect(refused).toMatchObject({
      allowed: false,
      refusal: 'PERMIT_INVALID',
      reason: 'PAIR_WITNESS_PERMIT_ISSUE_NOT_APPROVED'
    });
  });

  test('a selected plan status reports the explicit scope', async () => {
    const h = harness({ pairs: [pair(8), pair(9)] });
    await approveOne(h, 8);

    const status = await getPairWitnessMigrationStatus({ orgId: ORG_A, deps: h.deps });
    expect(status.plan.selectionMode).toBe('explicit');
    expect(status.plan.selection).toEqual([{ localKey: 'MOB-8', remoteKey: 'VMOB-8' }]);
    expect(status.plan.items).toHaveLength(1);
  });
});


describe('batch timing diagnostics', () => {
  /** A clock that advances 25 ms on every read, so durations are deterministic. */
  function steppingClock(start = 1_700_000_000_000) {
    let current = start;
    return () => {
      current += 25;
      return current;
    };
  }

  test('the batch reports per-pair and per-step durations', async () => {
    const h = harness({ pairs: [pair(8), pair(9)] });
    const plan = await buildPairWitnessPlan({ orgId: ORG_A, deps: h.deps });
    await approvePairWitnessMigration({
      orgId: ORG_A,
      confirmation: plan.approvalPhrase,
      deps: h.deps
    });
    h.deps.now = steppingClock();

    const result = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });

    expect(result.timings).toBeTruthy();
    expect(result.timings.batchMs).toBeGreaterThan(0);
    expect(result.timings.pairs).toHaveLength(2);

    for (const entry of result.timings.pairs) {
      expect(entry.state).toBe(PAIR_WITNESS_ITEM_STATES.VERIFIED);
      expect(entry.localPutMs).toBeGreaterThan(0);
      expect(entry.localVerifyMs).toBeGreaterThan(0);
      expect(entry.remotePutMs).toBeGreaterThan(0);
      expect(entry.remoteVerifyMs).toBeGreaterThan(0);
      expect(entry.totalMs).toBeGreaterThanOrEqual(
        entry.localPutMs + entry.localVerifyMs + entry.remotePutMs + entry.remoteVerifyMs
      );
    }

    const totals = result.timings.totals;
    expect(totals.localPutMs).toBe(
      result.timings.pairs.reduce((sum, entry) => sum + entry.localPutMs, 0)
    );
    expect(totals.remoteVerifyMs).toBe(
      result.timings.pairs.reduce((sum, entry) => sum + entry.remoteVerifyMs, 0)
    );
  });

  test('timings contain counts and durations only, never keys or content', async () => {
    const h = harness({ pairs: [pair(8)] });
    const plan = await buildPairWitnessPlan({ orgId: ORG_A, deps: h.deps });
    await approvePairWitnessMigration({
      orgId: ORG_A,
      confirmation: plan.approvalPhrase,
      deps: h.deps
    });

    const result = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });
    const serialized = JSON.stringify(result.timings);

    expect(serialized).not.toContain('MOB-');
    expect(serialized).not.toContain('VMOB-');
    expect(serialized).not.toContain('Basic');
    expect(Object.keys(result.timings.pairs[0]).sort()).toEqual([
      'localPutMs',
      'localVerifyMs',
      'remotePutMs',
      'remoteVerifyMs',
      'seq',
      'state',
      'totalMs'
    ]);
  });

  test('a pair that needs no write reports zero write and verify time', async () => {
    const h = harness({ pairs: [pair(8)] });
    const plan = await buildPairWitnessPlan({ orgId: ORG_A, deps: h.deps });
    await approvePairWitnessMigration({
      orgId: ORG_A,
      confirmation: plan.approvalPhrase,
      deps: h.deps
    });
    // The pair is already correct: nothing to write.
    const body = {
      v: 1,
      pairId: plan.items[0].pairId,
      state: 'active',
      installationId: INSTALLATION_ID,
      appId: APP_ID,
      orgId: ORG_A,
      localSite: LOCAL_SITE,
      remoteSite: REMOTE_HOST,
      localIssueId: pair(8).localIssueId,
      localKey: 'MOB-8',
      remoteIssueId: pair(8).remoteIssueId,
      remoteKey: 'VMOB-8',
      direction: 'local-to-remote',
      writtenAt: new Date().toISOString(),
      digest: 'sha256:placeholder'
    };
    h.state.witnesses.set(`local:${pair(8).localIssueId}`, body);
    h.state.witnesses.set(`remote:${pair(8).remoteIssueId}`, body);

    const result = await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });

    expect(result.writesPerformed).toBe(0);
    expect(result.timings.pairs[0]).toMatchObject({
      localPutMs: 0,
      localVerifyMs: 0,
      remotePutMs: 0,
      remoteVerifyMs: 0
    });
  });

  test('the timing log line contains no secrets or issue keys', async () => {
    const h = harness({ pairs: [pair(8)] });
    const plan = await buildPairWitnessPlan({ orgId: ORG_A, deps: h.deps });
    await approvePairWitnessMigration({
      orgId: ORG_A,
      confirmation: plan.approvalPhrase,
      deps: h.deps
    });
    const logged = [];
    const original = console.log;
    console.log = (...args) => logged.push(args.join(' '));
    try {
      await applyPairWitnessMigration({ orgId: ORG_A, deps: h.deps });
    } finally {
      console.log = original;
    }

    const timingLine = logged.find((line) => line.includes('pair-witness batch'));
    expect(timingLine).toBeTruthy();
    expect(timingLine).toContain('batchMs=');
    expect(timingLine).not.toContain('MOB-');
    expect(timingLine).not.toContain('VMOB-');
    expect(timingLine).not.toContain('Basic');
    expect(timingLine).not.toContain('ATATT');
  });
});

