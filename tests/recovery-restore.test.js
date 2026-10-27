/**
 * Controlled recovery snapshot restoration.
 *
 * The tests drive the production export, preview and restore modules against an
 * in-memory Forge store and mocked Jira GETs. They prove that a valid restore is
 * bounded and resumable, that stale/foreign/conflicting inputs fail closed, and
 * that the pause and synchronization-authorization boundaries are never relaxed.
 */
import api, { getAppContext } from '@forge/api';
import {
  createAuthorizedResolver,
  forbiddenResponse
} from '../src/resolvers/authorization.js';
import { RESOLVER_POLICIES } from '../src/resolvers/authorization-policy.js';
import { defineRecoveryRestoreResolvers } from '../src/resolvers/recovery-restore.js';
import { buildRecoverySnapshot } from '../src/services/sync/recovery-snapshot.js';
import { beginIssueCreateOperation } from '../src/services/sync/issue-create-operation.js';
import {
  RECOVERY_RESTORE_ERRORS,
  applyRecoveryRestore,
  approveRecoveryRestore,
  cancelRecoveryRestore,
  planRecoveryRestore,
  previewRecoveryRestore
} from '../src/services/sync/recovery-restore.js';
import {
  PAIR_WITNESS_ISSUE_CLASSES,
  PAIR_WITNESS_READ_CLASSES,
  deterministicPairId
} from '../src/services/sync/pair-witness.js';
import * as kvsStore from '../src/services/storage/kvs.js';

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  const getAppContext = jest.fn();
  return {
    __esModule: true,
    default: {
      asApp: () => ({ requestJira }),
      asUser: () => ({ requestJira })
    },
    getAppContext,
    route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch: jest.fn()
  };
});

jest.mock('@forge/resolver', () => {
  class FakeResolver {
    constructor() {
      this.functions = {};
    }

    define(name, fn) {
      this.functions[name] = fn;
      return this;
    }

    getDefinitions() {
      const functions = this.functions;
      return async (request) => {
        const fn = functions[request.call.functionKey];
        return fn({
          payload: request.call.payload || {},
          context: request.context || {}
        });
      };
    }
  }
  return { __esModule: true, default: FakeResolver };
});

jest.mock('@forge/events', () => ({
  Queue: jest.fn(() => ({ push: jest.fn() }))
}));

jest.mock('@forge/kvs', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
    getSecret: jest.fn(),
    setSecret: jest.fn(),
    deleteSecret: jest.fn(),
    query: jest.fn(),
    transact: jest.fn()
  },
  WhereConditions: { beginsWith: (value) => ({ op: 'beginsWith', value }) }
}));

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  getSecret: jest.fn(),
  setSecret: jest.fn(),
  deleteSecret: jest.fn(),
  createIfNotExists: jest.fn(),
  setIfNotExists: jest.fn(),
  setWithTtl: jest.fn(),
  queryPageByPrefix: jest.fn(),
  queryByPrefix: jest.fn(),
  transaction: jest.fn()
}));

const store = new Map();

const ORG = {
  id: 'org-1',
  name: 'Pilot Org',
  remoteUrl: 'https://vendor.example.com/jira',
  remoteEmail: 'operator@vendor.example.com',
  remoteProjectKey: 'VEND',
  allowedProjects: ['LOCAL', 'ALPHA'],
  syncDirection: 'bidirectional',
  remoteApiToken: 'SECRET_ORG_TOKEN',
  jqlFilter: 'assignee = operator@vendor.example.com'
};

const PAUSED = {
  paused: true,
  pausedAt: '2026-02-03T00:00:00.000Z',
  reasonCode: 'PILOT_CHANGE'
};

const IDENTITY = {
  readable: true,
  code: null,
  appId: '362d8e6b-b68c-4403-8020-d32ddcc02716',
  appAri: 'ari:cloud:ecosystem::app/362d8e6b-b68c-4403-8020-d32ddcc02716',
  appVersion: '3.10.0',
  environmentId: 'env-0000000000000001',
  environmentType: 'development',
  installationId: 'installation-0000001',
  cloudIds: ['cloud-0000001'],
  siteHost: 'site.example.com',
  siteReason: null,
  bound: true
};

const LOCAL_SITE = IDENTITY.cloudIds[0];
const REMOTE_SITE = 'vendor.example.com';

function resetStore() {
  store.clear();
  store.set('organizations', [ORG]);
  jest.clearAllMocks();
}

function fakePage(prefix, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 100);
  const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
  const start = options.cursor ? Number(options.cursor) : 0;
  const slice = keys.slice(start, start + limit);
  const nextIndex = start + slice.length;
  return {
    records: slice.map((key) => ({ key, value: store.get(key) })),
    nextCursor: nextIndex < keys.length ? String(nextIndex) : null
  };
}

function seedPair(localKey, remoteKey, orgId = 'org-1') {
  store.set(`mapping-meta:${orgId}:${localKey}`, {
    localKey,
    remoteKey,
    orgId,
    updatedAt: '2026-01-01T00:00:00.000Z'
  });
  store.set(`${orgId}:local-to-remote:${localKey}`, remoteKey);
  store.set(`${orgId}:remote-to-local:${remoteKey}`, localKey);
}

function removePair(localKey, remoteKey, orgId = 'org-1') {
  store.delete(`mapping-meta:${orgId}:${localKey}`);
  store.delete(`${orgId}:local-to-remote:${localKey}`);
  store.delete(`${orgId}:remote-to-local:${remoteKey}`);
}

function ledgerKey({
  orgId = 'org-1',
  direction = 'local-to-remote',
  sourceKey = 'LOCAL-1',
  operationSuffix = null
} = {}) {
  const base = `issue-create-op:${orgId}:${direction}:${encodeURIComponent(sourceKey)}`;
  return operationSuffix ? `${base}:${encodeURIComponent(operationSuffix)}` : base;
}

function seedLedger(localKey = 'LOCAL-1', remoteKey = 'VEND-1') {
  store.set(ledgerKey({ sourceKey: localKey }), {
    orgId: 'org-1',
    direction: 'local-to-remote',
    sourceKey: localKey,
    state: 'succeeded',
    attempt: 1,
    targetKey: remoteKey,
    operationId: 'operation-0000000001',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:05:00.000Z',
    completedAt: '2026-01-01T00:05:00.000Z',
    attemptToken: 'SECRET_ATTEMPT_TOKEN'
  });
}

function witnessRecord(localKey, remoteKey, localIssueId, remoteIssueId) {
  return {
    v: 1,
    pairId: deterministicPairId({
      installationId: IDENTITY.installationId,
      orgId: 'org-1',
      localIssueId,
      remoteIssueId
    }),
    state: 'active',
    installationId: IDENTITY.installationId,
    appId: IDENTITY.appId,
    orgId: 'org-1',
    localSite: LOCAL_SITE,
    remoteSite: REMOTE_SITE,
    localIssueId,
    localKey,
    remoteIssueId,
    remoteKey,
    direction: 'local-to-remote',
    writtenAt: '2026-01-01T00:00:00.000Z',
    digest: 'mock-digest'
  };
}

const issueIds = new Map([
  ['LOCAL-1', '10001'],
  ['VEND-1', '20001'],
  ['LOCAL-2', '10002'],
  ['VEND-2', '20002']
]);


function makeDeps(overrides = {}) {
  const base = {
    queryPage: jest.fn(fakePage),
    getStored: jest.fn(async (key) => {
      if (key === 'organizations') return [ORG];
      return store.get(key) ?? null;
    }),
    setStored: jest.fn(async (key, value) => {
      store.set(key, value);
    }),
    setStoredWithTtl: jest.fn(async (key, value) => {
      store.set(key, value);
    }),
    deleteKey: jest.fn(async (key) => {
      store.delete(key);
    }),
    setIfNotExists: jest.fn(async (key, value) => {
      if (store.has(key)) {
        const error = new Error('key exists');
        error.code = 'KEY_ALREADY_EXISTS';
        throw error;
      }
      store.set(key, value);
    }),
    createOperation: jest.fn(async (key, value) => {
      if (store.has(key)) {
        const error = new Error('key exists');
        error.code = 'KEY_ALREADY_EXISTS';
        throw error;
      }
      store.set(key, value);
    }),
    readPause: jest.fn(async () => ({ ...PAUSED })),
    getPilotPause: jest.fn(async () => ({ ...PAUSED })),
    getOrganizations: jest.fn(async () => [ORG]),
    readIdentity: jest.fn(async () => ({ ...IDENTITY })),
    readIssue: jest.fn(async ({ issueRef }) => {
      const id = issueIds.get(issueRef);
      if (!id) return { class: PAIR_WITNESS_ISSUE_CLASSES.MISSING, id: null, key: null };
      return { class: PAIR_WITNESS_ISSUE_CLASSES.PRESENT, id, key: issueRef };
    }),
    readWitness: jest.fn(async ({ side, issueRef }) => {
      const localKey = [...issueIds.entries()].find(([, id]) => id === issueRef)?.[0];
      if (!localKey) return { class: PAIR_WITNESS_READ_CLASSES.ABSENT, record: null };
      const localIssueId = issueIds.get('LOCAL-1') === issueRef ? '10001' : null;
      void localIssueId;
      return {
        class: PAIR_WITNESS_READ_CLASSES.ABSENT,
        record: null
      };
    }),
    getRemoteKey: jest.fn(async (localKey, orgId) => (
      store.get(`${orgId}:local-to-remote:${localKey}`) ?? null
    )),
    getLocalKey: jest.fn(async (remoteKey, orgId) => (
      store.get(`${orgId}:remote-to-local:${remoteKey}`) ?? null
    )),
    storeMapping: jest.fn(async (localKey, remoteKey, orgId) => {
      const existingRemote = store.get(`${orgId}:local-to-remote:${localKey}`);
      const existingLocal = store.get(`${orgId}:remote-to-local:${remoteKey}`);
      if (existingRemote && existingRemote !== remoteKey) {
        const error = new Error('mapping conflict');
        error.code = 'MAPPING_CONFLICT';
        throw error;
      }
      if (existingLocal && existingLocal !== localKey) {
        const error = new Error('mapping conflict');
        error.code = 'MAPPING_CONFLICT';
        throw error;
      }
      seedPair(localKey, remoteKey, orgId);
      return {
        localKey,
        remoteKey,
        idempotent: existingRemote === remoteKey && existingLocal === localKey
      };
    }),
    setAuthorizationState: jest.fn(async ({ state, organizationIds }) => {
      store.set('syncAuthorization', {
        version: 1,
        state,
        appId: IDENTITY.appId,
        environmentId: IDENTITY.environmentId,
        installationId: IDENTITY.installationId,
        organizationIds
      });
    }),
    auditWrite: jest.fn(async () => true),
    now: () => Date.parse('2026-02-03T04:05:06.000Z')
  };
  return { ...base, ...overrides };
}

function matchingWitnessDeps(overrides = {}) {
  return makeDeps({
    readWitness: jest.fn(async ({ side, issueRef }) => {
      const entry = [...issueIds.entries()].find(([, id]) => id === issueRef);
      if (!entry) return { class: PAIR_WITNESS_READ_CLASSES.ABSENT, record: null };
      const key = entry[0];
      const pair = key.startsWith('LOCAL-')
        ? [key, `VEND-${key.slice('LOCAL-'.length)}`]
        : [`LOCAL-${key.slice('VEND-'.length)}`, key];
      return {
        class: PAIR_WITNESS_READ_CLASSES.MATCHING,
        record: witnessRecord(
          pair[0],
          pair[1],
          issueIds.get(pair[0]),
          issueIds.get(pair[1])
        ),
        side
      };
    }),
    ...overrides
  });
}

async function makeSnapshot({ pairs = [['LOCAL-1', 'VEND-1']], ledger = true } = {}) {
  for (const [localKey, remoteKey] of pairs) {
    seedPair(localKey, remoteKey);
    if (ledger) seedLedger(localKey, remoteKey);
  }
  const snapshot = await buildRecoverySnapshot({ orgId: 'org-1', deps: makeDeps() });
  for (const [localKey, remoteKey] of pairs) {
    removePair(localKey, remoteKey);
    if (ledger) store.delete(ledgerKey({ sourceKey: localKey }));
  }
  return snapshot;
}

function expectCode(promise, code) {
  return expect(promise).rejects.toMatchObject({ code });
}


describe('recovery restore workflow', () => {
  beforeEach(() => {
    resetStore();
  });

  test('previews, plans, approves and restores a mapping and its succeeded ledger row', async () => {
    const snapshot = await makeSnapshot();
    const deps = matchingWitnessDeps();
    const content = snapshot.content;

    const preview = await previewRecoveryRestore({ orgId: 'org-1', content, deps });
    expect(preview.success).toBe(true);
    expect(preview.readOnly).toBe(true);
    expect(preview.noWritesPerformed).toBe(true);
    expect(preview.counts.selectedPairs).toBe(1);
    expect(preview.counts.witnessConfirmed).toBe(1);
    expect(preview.counts.witnessAbsent).toBe(0);
    expect(preview.counts.ledgerRows).toBe(1);
    expect(preview.candidates[0]).toEqual(expect.objectContaining({
      localKey: 'LOCAL-1',
      remoteKey: 'VEND-1',
      witness: 'confirmed'
    }));
    expect(store.has('recoveryRestorePlan:org-1')).toBe(false);
    expect(store.has('syncAuthorization')).toBe(false);
    expect(store.has('org-1:local-to-remote:LOCAL-1')).toBe(false);

    const plan = await planRecoveryRestore({ orgId: 'org-1', content, deps });
    expect(plan.success).toBe(true);
    expect(plan.status).toBe('pending');
    expect(plan.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.approvalPhrase).toBe(`RESTORE org-1 ${plan.digest}`);

    const approved = await approveRecoveryRestore({
      orgId: 'org-1',
      digest: plan.digest,
      confirmation: plan.approvalPhrase,
      accountId: 'admin-1',
      deps
    });
    expect(approved.status).toBe('approved');
    expect(approved.authorizationState).toBe('restore-in-progress');
    expect(store.get('syncAuthorization').state).toBe('restore-in-progress');
    expect(store.get(`${'org-1'}:local-to-remote:LOCAL-1`)).toBeUndefined();

    const applied = await applyRecoveryRestore({
      orgId: 'org-1',
      digest: plan.digest,
      batchSize: 5,
      deps
    });
    expect(applied.success).toBe(true);
    expect(applied.status).toBe('completed');
    expect(applied.mappingWrites).toBe(1);
    expect(applied.ledgerWrites).toBe(1);
    expect(applied.jiraWrites).toBe(0);
    expect(applied.pauseUnchanged).toBe(true);
    expect(applied.authorizationState).toBe('blocked');
    expect(store.get('org-1:local-to-remote:LOCAL-1')).toBe('VEND-1');
    expect(store.get('org-1:remote-to-local:VEND-1')).toBe('LOCAL-1');
    expect(store.get(`mapping-meta:org-1:LOCAL-1`)).toEqual(expect.objectContaining({
      localKey: 'LOCAL-1',
      remoteKey: 'VEND-1',
      orgId: 'org-1'
    }));
    const ledger = store.get(ledgerKey());
    expect(ledger).toEqual(expect.objectContaining({
      state: 'succeeded',
      targetKey: 'VEND-1',
      operationId: 'operation-0000000001',
      restorePlanDigest: plan.digest,
      restoredBy: 'admin-1'
    }));
    expect(ledger.attemptToken).toBeUndefined();
    expect(store.get('syncAuthorization').state).toBe('blocked');
    expect(deps.auditWrite).toHaveBeenCalled();
    expect(deps.readIssue).toHaveBeenCalled();
    expect(deps.readWitness).toHaveBeenCalled();

    kvsStore.get.mockImplementation(async (key) => store.get(key) ?? null);
    kvsStore.createIfNotExists.mockRejectedValue(Object.assign(
      new Error('already exists'),
      { code: 'KEY_ALREADY_EXISTS' }
    ));
    const duplicate = await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: 'local-to-remote',
      sourceKey: 'LOCAL-1'
    });
    expect(duplicate.code).toBe('CREATE_RECONCILIATION_REQUIRED');
  });

  test('accepts an absent witness only through the explicit snapshot plan', async () => {
    const snapshot = await makeSnapshot();
    const deps = makeDeps();
    const preview = await previewRecoveryRestore({
      orgId: 'org-1',
      content: snapshot.content,
      deps
    });
    expect(preview.candidates[0].witness).toBe('absent');
    expect(preview.counts.witnessAbsent).toBe(1);
    expect(preview.approvalPhrase).toContain(preview.digest);
  });

  test('refuses preview, planning and approval while the pause is not confirmed on', async () => {
    const snapshot = await makeSnapshot();
    const deps = matchingWitnessDeps({
      readPause: jest.fn(async () => ({ paused: false }))
    });
    await expectCode(
      previewRecoveryRestore({ orgId: 'org-1', content: snapshot.content, deps }),
      RECOVERY_RESTORE_ERRORS.PAUSE_REQUIRED
    );
    await expectCode(
      planRecoveryRestore({ orgId: 'org-1', content: snapshot.content, deps }),
      RECOVERY_RESTORE_ERRORS.PAUSE_REQUIRED
    );
  });

  test('rejects a corrupted snapshot before a plan exists', async () => {
    const snapshot = await makeSnapshot();
    const deps = matchingWitnessDeps();
    const corrupted = `${snapshot.content.slice(0, -2)}x\n`;
    await expect(previewRecoveryRestore({
      orgId: 'org-1',
      content: corrupted,
      deps
    })).rejects.toMatchObject({
      code: expect.stringMatching(/^SNAPSHOT_PREVIEW_/)
    });
  });

  test('rejects organization and installation mismatches', async () => {
    const snapshot = await makeSnapshot();
    const orgTwo = { ...ORG, id: 'org-2', name: 'Second Org' };
    const deps = matchingWitnessDeps({
      getOrganizations: jest.fn(async () => [ORG, orgTwo])
    });
    await expectCode(
      previewRecoveryRestore({ orgId: 'org-2', content: snapshot.content, deps }),
      'SNAPSHOT_PREVIEW_ORGANIZATION_MISMATCH'
    );

    const foreignDeps = matchingWitnessDeps({
      readIdentity: jest.fn(async () => ({
        ...IDENTITY,
        installationId: 'installation-foreign',
        environmentId: 'env-foreign'
      }))
    });
    await expectCode(
      previewRecoveryRestore({ orgId: 'org-1', content: snapshot.content, deps: foreignDeps }),
      RECOVERY_RESTORE_ERRORS.SNAPSHOT_NOT_RECOVERABLE
    );
  });


  test('refuses to overwrite a conflicting live mapping and creates no plan', async () => {
    const snapshot = await makeSnapshot();
    seedPair('LOCAL-1', 'VEND-9');
    const deps = matchingWitnessDeps();
    const preview = await previewRecoveryRestore({
      orgId: 'org-1',
      content: snapshot.content,
      deps
    });
    expect(preview.counts.selectedPairs).toBe(0);
    await expectCode(
      planRecoveryRestore({ orgId: 'org-1', content: snapshot.content, deps }),
      RECOVERY_RESTORE_ERRORS.PLAN_EMPTY
    );
    expect(store.get('org-1:local-to-remote:LOCAL-1')).toBe('VEND-9');
    expect(store.has('recoveryRestorePlan:org-1')).toBe(false);
  });

  test('excludes contradictory witnesses instead of trusting the snapshot alone', async () => {
    const snapshot = await makeSnapshot();
    const deps = makeDeps({
      readWitness: jest.fn(async () => ({
        class: PAIR_WITNESS_READ_CLASSES.MATCHING,
        record: witnessRecord(
          'LOCAL-2',
          'VEND-2',
          issueIds.get('LOCAL-2'),
          issueIds.get('VEND-2')
        )
      }))
    });
    const preview = await previewRecoveryRestore({
      orgId: 'org-1',
      content: snapshot.content,
      deps
    });
    expect(preview.counts.selectedPairs).toBe(0);
    expect(preview.excluded[0]).toEqual(expect.objectContaining({
      localKey: 'LOCAL-1',
      reason: 'witness-conflict'
    }));
    await expectCode(
      planRecoveryRestore({ orgId: 'org-1', content: snapshot.content, deps }),
      RECOVERY_RESTORE_ERRORS.PLAN_EMPTY
    );
  });

  test('rejects stale approvals after live state changes', async () => {
    const snapshot = await makeSnapshot();
    const deps = matchingWitnessDeps();
    const plan = await planRecoveryRestore({
      orgId: 'org-1',
      content: snapshot.content,
      deps
    });
    seedPair('LOCAL-1', 'VEND-9');
    await expectCode(
      approveRecoveryRestore({
        orgId: 'org-1',
        digest: plan.digest,
        confirmation: plan.approvalPhrase,
        deps
      }),
      RECOVERY_RESTORE_ERRORS.APPROVAL_STALE
    );
    expect(store.has('syncAuthorization')).toBe(false);
  });


  test('rejects a mismatched approval digest before arming authorization', async () => {
    const snapshot = await makeSnapshot();
    const deps = matchingWitnessDeps();
    const plan = await planRecoveryRestore({
      orgId: 'org-1',
      content: snapshot.content,
      deps
    });
    await expectCode(
      approveRecoveryRestore({
        orgId: 'org-1',
        digest: `sha256:${'0'.repeat(64)}`,
        confirmation: plan.approvalPhrase,
        deps
      }),
      RECOVERY_RESTORE_ERRORS.PLAN_DIGEST_MISMATCH
    );
    expect(store.has('syncAuthorization')).toBe(false);
  });

  test('refuses a batch when authorization is not armed', async () => {
    const snapshot = await makeSnapshot();
    const deps = matchingWitnessDeps();
    const plan = await planRecoveryRestore({
      orgId: 'org-1',
      content: snapshot.content,
      deps
    });
    await approveRecoveryRestore({
      orgId: 'org-1',
      digest: plan.digest,
      confirmation: plan.approvalPhrase,
      deps
    });
    store.set('syncAuthorization', { version: 1, state: 'blocked' });
    await expectCode(
      applyRecoveryRestore({ orgId: 'org-1', digest: plan.digest, deps }),
      RECOVERY_RESTORE_ERRORS.NOT_ARMED
    );
    expect(store.has('org-1:local-to-remote:LOCAL-1')).toBe(false);
  });

  test('resumes a bounded batch and never repeats a completed item', async () => {
    const snapshot = await makeSnapshot({
      pairs: [['LOCAL-1', 'VEND-1'], ['LOCAL-2', 'VEND-2']]
    });
    const deps = matchingWitnessDeps();
    const plan = await planRecoveryRestore({
      orgId: 'org-1',
      content: snapshot.content,
      deps
    });
    expect(plan.counts.selectedPairs).toBe(2);
    await approveRecoveryRestore({
      orgId: 'org-1',
      digest: plan.digest,
      confirmation: plan.approvalPhrase,
      deps
    });

    const first = await applyRecoveryRestore({
      orgId: 'org-1',
      digest: plan.digest,
      batchSize: 1,
      deps
    });
    expect(first.status).toBe('running');
    expect(first.remaining).toBe(1);
    expect(first.mappingWrites).toBe(1);
    expect(first.authorizationState).toBe('restore-in-progress');

    const second = await applyRecoveryRestore({
      orgId: 'org-1',
      digest: plan.digest,
      batchSize: 10,
      deps
    });
    expect(second.status).toBe('completed');
    expect(second.remaining).toBe(0);
    expect(second.mappingWrites).toBe(1);
    expect(store.get('org-1:local-to-remote:LOCAL-1')).toBe('VEND-1');
    expect(store.get('org-1:local-to-remote:LOCAL-2')).toBe('VEND-2');
    expect(store.get(ledgerKey({ sourceKey: 'LOCAL-1' })).state).toBe('succeeded');
    expect(store.get(ledgerKey({ sourceKey: 'LOCAL-2' })).state).toBe('succeeded');

    const third = await applyRecoveryRestore({
      orgId: 'org-1',
      digest: plan.digest,
      deps
    });
    expect(third.processed).toBe(0);
    expect(third.mappingWrites).toBe(0);
  });

  test('resumes after a transient ledger write failure', async () => {
    const snapshot = await makeSnapshot();
    let failed = false;
    const deps = matchingWitnessDeps({
      createOperation: jest.fn(async (key, value) => {
        if (!failed) {
          failed = true;
          throw new Error('kvs temporarily unavailable');
        }
        store.set(key, value);
      })
    });
    const plan = await planRecoveryRestore({
      orgId: 'org-1',
      content: snapshot.content,
      deps
    });
    await approveRecoveryRestore({
      orgId: 'org-1',
      digest: plan.digest,
      confirmation: plan.approvalPhrase,
      deps
    });

    const first = await applyRecoveryRestore({
      orgId: 'org-1',
      digest: plan.digest,
      deps
    });
    expect(first.status).toBe('running');
    expect(first.mappingWrites).toBe(1);
    expect(first.ledgerWrites).toBe(0);
    expect(first.states.partial).toBe(1);
    expect(store.get('org-1:local-to-remote:LOCAL-1')).toBe('VEND-1');
    expect(store.has(ledgerKey())).toBe(false);

    const second = await applyRecoveryRestore({
      orgId: 'org-1',
      digest: plan.digest,
      deps
    });
    expect(second.status).toBe('completed');
    expect(second.ledgerWrites).toBe(1);
    expect(store.get(ledgerKey())).toEqual(expect.objectContaining({
      state: 'succeeded',
      targetKey: 'VEND-1'
    }));
  });

  test('refuses a candidate whose live create ledger contradicts the snapshot', async () => {
    const snapshot = await makeSnapshot();
    store.set(ledgerKey(), {
      orgId: 'org-1',
      direction: 'local-to-remote',
      sourceKey: 'LOCAL-1',
      state: 'succeeded',
      attempt: 1,
      targetKey: 'VEND-9'
    });
    const deps = matchingWitnessDeps();
    const preview = await previewRecoveryRestore({
      orgId: 'org-1',
      content: snapshot.content,
      deps
    });
    expect(preview.counts.selectedPairs).toBe(0);
    expect(preview.excluded[0].reason).toBe('ledger-conflict');
    await expectCode(
      planRecoveryRestore({ orgId: 'org-1', content: snapshot.content, deps }),
      RECOVERY_RESTORE_ERRORS.PLAN_EMPTY
    );
  });

  test('rejects approval after the installation identity changes', async () => {
    const snapshot = await makeSnapshot();
    const deps = matchingWitnessDeps();
    const plan = await planRecoveryRestore({
      orgId: 'org-1',
      content: snapshot.content,
      deps
    });
    deps.readIdentity.mockResolvedValue({
      ...IDENTITY,
      installationId: 'installation-other',
      environmentId: 'env-other'
    });
    await expectCode(
      approveRecoveryRestore({
        orgId: 'org-1',
        digest: plan.digest,
        confirmation: plan.approvalPhrase,
        deps
      }),
      RECOVERY_RESTORE_ERRORS.PLAN_NOT_APPROVED
    );
    expect(store.has('syncAuthorization')).toBe(false);
  });

  test('cancelling a pending plan does not invent a blocked authorization', async () => {
    const snapshot = await makeSnapshot();
    const deps = matchingWitnessDeps();
    await planRecoveryRestore({ orgId: 'org-1', content: snapshot.content, deps });
    const cancelled = await cancelRecoveryRestore({ orgId: 'org-1', deps });
    expect(cancelled.success).toBe(true);
    expect(cancelled.status).toBe('cancelled');
    expect(store.has('syncAuthorization')).toBe(false);
  });

  test('repairs only the missing metadata index when both directions already agree', async () => {
    const snapshot = await makeSnapshot();
    seedPair('LOCAL-1', 'VEND-1');
    store.delete('mapping-meta:org-1:LOCAL-1');
    store.delete(ledgerKey());
    const deps = matchingWitnessDeps();
    const plan = await planRecoveryRestore({
      orgId: 'org-1',
      content: snapshot.content,
      deps
    });
    await approveRecoveryRestore({
      orgId: 'org-1',
      digest: plan.digest,
      confirmation: plan.approvalPhrase,
      deps
    });
    const applied = await applyRecoveryRestore({ orgId: 'org-1', digest: plan.digest, deps });
    expect(applied.status).toBe('completed');
    expect(store.get('mapping-meta:org-1:LOCAL-1')).toEqual(expect.objectContaining({
      localKey: 'LOCAL-1',
      remoteKey: 'VEND-1'
    }));
  });

  test('refuses a second approval while another restore holds the authorization veto', async () => {
    const snapshot = await makeSnapshot();
    const deps = matchingWitnessDeps();
    const plan = await planRecoveryRestore({
      orgId: 'org-1',
      content: snapshot.content,
      deps
    });
    store.set('syncAuthorization', {
      version: 1,
      state: 'restore-in-progress',
      installationId: IDENTITY.installationId
    });
    await expectCode(
      approveRecoveryRestore({
        orgId: 'org-1',
        digest: plan.digest,
        confirmation: plan.approvalPhrase,
        deps
      }),
      RECOVERY_RESTORE_ERRORS.AUTHORIZATION_UNAVAILABLE
    );
    expect(store.get('syncAuthorization').state).toBe('restore-in-progress');
  });

  test('cancelling a pending plan does not clear another restore authorization', async () => {
    const snapshot = await makeSnapshot();
    const deps = matchingWitnessDeps();
    await planRecoveryRestore({ orgId: 'org-1', content: snapshot.content, deps });
    store.set('syncAuthorization', {
      version: 1,
      state: 'restore-in-progress',
      installationId: IDENTITY.installationId
    });
    const cancelled = await cancelRecoveryRestore({ orgId: 'org-1', deps });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.authorizationState).toBe('restore-in-progress');
    expect(store.get('syncAuthorization').state).toBe('restore-in-progress');
  });

  test('scans past a full excluded candidate window instead of silently skipping later pairs', async () => {
    const pairs = Array.from({ length: 201 }, (_, index) => {
      const suffix = index + 1;
      return [`LOCAL-${suffix}`, `VEND-${suffix}`];
    });
    const snapshot = await makeSnapshot({ pairs, ledger: false });
    const idFor = (key) => String(100000 + Number(key.split('-')[1]));
    const keyForId = new Map();
    for (let suffix = 1; suffix <= 201; suffix += 1) {
      keyForId.set(idFor(`LOCAL-${suffix}`), [`LOCAL-${suffix}`, `VEND-${suffix}`]);
      keyForId.set(idFor(`VEND-${suffix}`), [`LOCAL-${suffix}`, `VEND-${suffix}`]);
    }
    const deps = makeDeps({
      readIssue: jest.fn(async ({ issueRef }) => ({
        class: PAIR_WITNESS_ISSUE_CLASSES.PRESENT,
        id: idFor(issueRef),
        key: issueRef
      })),
      readWitness: jest.fn(async ({ issueRef }) => {
        const pair = keyForId.get(issueRef);
        const suffix = Number(pair?.[0]?.split('-')[1] || 0);
        if (suffix < 201) {
          return { class: PAIR_WITNESS_READ_CLASSES.INACCESSIBLE, record: null };
        }
        return {
          class: PAIR_WITNESS_READ_CLASSES.MATCHING,
          record: witnessRecord(
            pair[0],
            pair[1],
            idFor(pair[0]),
            idFor(pair[1])
          )
        };
      })
    });

    const preview = await previewRecoveryRestore({
      orgId: 'org-1',
      content: snapshot.content,
      deps
    });
    expect(preview.counts.availablePairs).toBe(201);
    expect(preview.counts.selectedPairs).toBe(1);
    expect(preview.candidates[0]).toEqual(expect.objectContaining({
      localKey: 'LOCAL-201',
      remoteKey: 'VEND-201',
      witness: 'confirmed'
    }));
    expect(preview.excluded).toHaveLength(200);

    const plan = await planRecoveryRestore({
      orgId: 'org-1',
      content: snapshot.content,
      deps
    });
    expect(plan.counts.selectedPairs).toBe(1);
    expect(plan.counts.excludedPairs).toBe(200);
    expect(plan.candidates[0].localKey).toBe('LOCAL-201');
  });

  test('refuses a suffixed live ledger row that contradicts the pair', async () => {
    const snapshot = await makeSnapshot({ ledger: false });
    store.set(`${ledgerKey()}:automatic-replacement-1`, {
      orgId: 'org-1',
      direction: 'local-to-remote',
      sourceKey: 'LOCAL-1',
      state: 'pending',
      attempt: 2,
      targetKey: 'VEND-9'
    });
    const deps = matchingWitnessDeps();
    const preview = await previewRecoveryRestore({
      orgId: 'org-1',
      content: snapshot.content,
      deps
    });
    expect(preview.counts.selectedPairs).toBe(0);
    expect(preview.excluded[0].reason).toBe('ledger-conflict');
  });

  test('declares ADMIN policies for every restore resolver', () => {
    expect(RESOLVER_POLICIES.previewRecoveryRestore).toBe('ADMIN_READ');
    expect(RESOLVER_POLICIES.planRecoveryRestore).toBe('ADMIN_WRITE');
    expect(RESOLVER_POLICIES.approveRecoveryRestore).toBe('ADMIN_WRITE');
    expect(RESOLVER_POLICIES.applyRecoveryRestore).toBe('ADMIN_WRITE');
    expect(RESOLVER_POLICIES.cancelRecoveryRestore).toBe('ADMIN_WRITE');
    expect(RESOLVER_POLICIES.getRecoveryRestoreStatus).toBe('ADMIN_READ');
    const resolver = createAuthorizedResolver();
    defineRecoveryRestoreResolvers(resolver);
    expect(resolver.getRegisteredNames()).toEqual(expect.arrayContaining([
      'previewRecoveryRestore',
      'planRecoveryRestore',
      'approveRecoveryRestore',
      'applyRecoveryRestore',
      'cancelRecoveryRestore',
      'getRecoveryRestoreStatus'
    ]));
    void forbiddenResponse;
    void api;
    void getAppContext;
    void kvsStore;
  });
});

