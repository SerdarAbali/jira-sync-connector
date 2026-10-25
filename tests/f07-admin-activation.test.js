/**
 * Targeted regression coverage for the guarded F07 activation operation.
 *
 * The entity protocol probe uses the installed @forge/kvs builders against the
 * local `__forge_fetch__` storage model, so conditional transactions and their
 * rejection codes are exercised rather than mocked. Every activation path in
 * this suite must stop at, or before, the unverifiable retirement boundary and
 * must never write migration state.
 */
const runtime = require('./helpers/forge-lease-runtime');
const {
  ACTIVATION_CONFIRMATION,
  LEGACY_RETIREMENT_UNVERIFIED,
  activateIssueLeaseMigration,
  evaluateRetirementCandidate,
  probeEntityProtocol
} = require('../src/services/sync/lease-migration-activation');
const { LEGACY_LEASE_DRAIN_MS } = require('../src/services/sync/lease-migration');

const APP_ARI = 'ari:cloud:ecosystem::app/362d8e6b-b68c-4403-8020-d32ddcc02716';
const APP_UUID = '362d8e6b-b68c-4403-8020-d32ddcc02716';
const NOW = Date.parse('2026-10-24T12:00:00.000Z');

function identity() {
  return {
    appAri: { appId: APP_UUID, toString: () => APP_ARI },
    appVersion: '3.0.0',
    environmentAri: { environmentId: 'env-staging' },
    environmentType: 'staging',
    installationAri: { installationId: 'install-1' },
    installation: { contexts: [{ cloudId: 'cloud-1' }] }
  };
}

function activationDeps(overrides = {}) {
  return {
    getAppContext: () => identity(),
    getPilotPause: async () => ({ paused: true }),
    now: () => NOW,
    ...overrides
  };
}

function missingState() {
  return {
    readable: true,
    present: false,
    valid: false,
    active: false,
    phase: null,
    state: null,
    reasons: ['migration-missing']
  };
}

function invoke(overrides = {}) {
  return activateIssueLeaseMigration({
    payload: { confirmation: ACTIVATION_CONFIRMATION },
    deps: activationDeps(overrides.deps),
    ...overrides.options
  });
}

describe('guarded F07 activation preconditions', () => {
  beforeEach(() => {
    runtime.state.migration = null;
  });

  it('refuses an attempt without the explicit confirmation and makes no storage request', async () => {
    const result = await activateIssueLeaseMigration({
      payload: { confirmation: 'yes' },
      deps: activationDeps()
    });
    expect(result).toMatchObject({
      success: false,
      status: 'BLOCKED',
      code: 'CONFIRMATION_REQUIRED',
      activation: { performed: false, wroteMigrationState: false }
    });
    expect(runtime.requests).toEqual([]);
  });

  it('rejects forged inputs that try to assert readiness or activation state', async () => {
    const result = await activateIssueLeaseMigration({
      payload: {
        confirmation: ACTIVATION_CONFIRMATION,
        legacyDisabled: true,
        source: 'authenticated-connector',
        verified: true,
        state: { version: 1, phase: 'entity-active' }
      },
      deps: activationDeps()
    });
    expect(result.code).toBe('UNSUPPORTED_ACTIVATION_INPUT');
    expect(result.rejectedFields.sort()).toEqual(['legacyDisabled', 'source', 'state', 'verified']);
    expect(runtime.requests).toEqual([]);
  });

  it('fails closed when installation identity is unavailable', async () => {
    const result = await activateIssueLeaseMigration({
      payload: { confirmation: ACTIVATION_CONFIRMATION },
      deps: activationDeps({ getAppContext: () => { throw new Error('no runtime'); } })
    });
    expect(result.code).toBe('IDENTITY_UNAVAILABLE');
    expect(runtime.requests).toEqual([]);
  });

  it('requires an authoritative Pause', async () => {
    const result = await invoke({ deps: { getPilotPause: async () => ({ paused: false }) } });
    expect(result.code).toBe('PAUSE_REQUIRED');
    expect(runtime.requests).toEqual([]);
  });

  it('reports an unreadable Pause as a failed attempt, not as active', async () => {
    const result = await invoke({
      deps: { getPilotPause: async () => { throw new Error('storage down'); } }
    });
    expect(result.status).toBe('FAILED');
    expect(result.code).toBe('PAUSE_UNREADABLE');
  });
});

describe('guarded F07 activation migration state and probe', () => {
  beforeEach(() => {
    runtime.state.migration = null;
  });

  it('refuses to re-activate an already active migration', async () => {
    runtime.state.migration = {
      version: 1,
      phase: 'entity-active',
      legacyDisabled: true,
      disabledAt: NOW - 5_000_000,
      activatedAt: NOW - 1_000_000
    };
    const result = await invoke();
    expect(result.code).toBe('MIGRATION_ALREADY_ACTIVE');
    expect(runtime.requests.filter((entry) => entry.path === '/api/v1/transaction')).toEqual([]);
  });

  it('rejects a malformed or ambiguous stored migration state', async () => {
    runtime.state.migration = {
      version: 1,
      phase: 'legacy',
      legacyDisabled: true,
      disabledAt: 0,
      activatedAt: 0
    };
    const result = await invoke();
    expect(result.code).toBe('MIGRATION_STATE_AMBIGUOUS');
  });

  it('enforces the 19-minute drain when a retirement timestamp is supplied', async () => {
    runtime.state.migration = { version: 1, phase: 'draining', legacyDisabled: false };
    const result = await activateIssueLeaseMigration({
      payload: {
        confirmation: ACTIVATION_CONFIRMATION,
        retirement: { legacyDisabledAt: NOW - 60000 }
      },
      deps: activationDeps()
    });
    expect(result.code).toBe('DRAIN_INCOMPLETE');
    expect(result.activation.performed).toBe(false);
  });

  it('rejects malformed and future-dated retirement timestamps', async () => {
    const malformed = await activateIssueLeaseMigration({
      payload: { confirmation: ACTIVATION_CONFIRMATION, retirement: { legacyDisabledAt: 'yesterday' } },
      deps: activationDeps()
    });
    expect(malformed.code).toBe('RETIREMENT_EVIDENCE_INVALID');

    const future = await activateIssueLeaseMigration({
      payload: { confirmation: ACTIVATION_CONFIRMATION, retirement: { legacyDisabledAt: NOW + 60000 } },
      deps: activationDeps()
    });
    expect(future.code).toBe('RETIREMENT_EVIDENCE_INVALID');
  });

  it('blocks when Pause is lost during the probe', async () => {
    let calls = 0;
    const result = await invoke({
      deps: {
        getPilotPause: async () => {
          calls += 1;
          return { paused: calls === 1 };
        }
      }
    });
    expect(result.code).toBe('PAUSE_LOST');
    expect(result.activation.wroteMigrationState).toBe(false);
  });

  it('blocks when the migration state becomes active during the probe', async () => {
    const reads = [
      missingState(),
      {
        readable: true,
        present: true,
        valid: true,
        active: true,
        phase: 'entity-active',
        state: {
          version: 1,
          phase: 'entity-active',
          legacyDisabled: true,
          disabledAt: NOW - 5_000_000,
          activatedAt: NOW - 1_000_000
        },
        reasons: []
      }
    ];
    const result = await invoke({
      deps: { readIssueLeaseMigrationState: async () => reads.shift() }
    });
    expect(result.code).toBe('MIGRATION_ALREADY_ACTIVE');
    expect(runtime.state.migration).toBeNull();
    expect(runtime.requests.filter((entry) => entry.path === '/api/v1/set')).toEqual([]);
  });

  it('blocks when conditional create enforcement cannot be observed', async () => {
    const fakeKvs = {
      transact() {
        const builder = {
          set() { return builder; },
          delete() { return builder; },
          check() { return builder; },
          async execute() { /* every transaction succeeds */ }
        };
        return builder;
      },
      entity() {
        return { async get() { return undefined; } };
      }
    };
    const result = await invoke({ deps: { kvs: fakeKvs } });
    expect(result.code).toBe('ENTITY_PROTOCOL_UNVERIFIED');
    expect(result.probe).toMatchObject({ verified: false, reason: 'probe-conditional-create-not-enforced' });
  });
});

describe('guarded F07 activation retirement boundary', () => {
  beforeEach(() => {
    runtime.state.migration = null;
  });

  it('performs every verifiable check and still blocks without writing migration state', async () => {
    const result = await activateIssueLeaseMigration({
      payload: {
        confirmation: ACTIVATION_CONFIRMATION,
        retirement: { legacyDisabledAt: NOW - LEGACY_LEASE_DRAIN_MS - 1000 }
      },
      deps: activationDeps()
    });

    expect(result).toMatchObject({
      success: false,
      status: 'BLOCKED',
      code: LEGACY_RETIREMENT_UNVERIFIED,
      activation: { performed: false, wroteMigrationState: false },
      probe: { verified: true, reason: null },
      evidence: { source: null, verified: false }
    });
    expect(result.binding).toMatchObject({
      appId: APP_UUID,
      environmentId: 'env-staging',
      installationId: 'install-1'
    });
    expect(result.drain).toMatchObject({
      suppliedDisabledAt: NOW - LEGACY_LEASE_DRAIN_MS - 1000,
      satisfied: true
    });
    expect(result.checks.map((entry) => entry.id)).toEqual([
      'identity-binding',
      'pause-state',
      'migration-state',
      'legacy-retirement',
      'entity-protocol'
    ]);

    // The probe is cleaned up, and no migration, mapping or lease record is
    // written. A blocked attempt is not an activation.
    expect(runtime.state.migration).toBeNull();
    expect([...runtime.entities.keys()].filter((key) => key.startsWith('lease-probe-'))).toEqual([]);
    expect(runtime.state.basicStore).toBeNull();
    expect(runtime.requests.filter((entry) => entry.path === '/api/v1/set')).toEqual([]);
  });

  it('blocks without a retirement timestamp instead of treating elapsed time as proof', async () => {
    const result = await invoke();
    expect(result.code).toBe(LEGACY_RETIREMENT_UNVERIFIED);
    expect(result.drain).toMatchObject({ suppliedDisabledAt: null, satisfied: false });
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'legacy-retirement',
      status: 'unknown'
    }));
  });

  it('evaluates the drain boundary exactly and never promotes it to verified evidence', () => {
    expect(evaluateRetirementCandidate({ legacyDisabledAt: NOW - LEGACY_LEASE_DRAIN_MS }, NOW))
      .toMatchObject({ supplied: true, drainSatisfied: true, reason: 'retirement-evidence-unverified' });
    expect(evaluateRetirementCandidate({ legacyDisabledAt: NOW - LEGACY_LEASE_DRAIN_MS + 1 }, NOW))
      .toMatchObject({ supplied: true, drainSatisfied: false, reason: 'retirement-drain-incomplete' });
    expect(evaluateRetirementCandidate(undefined, NOW))
      .toMatchObject({ supplied: false, drainSatisfied: false });
  });

  it('verifies the entity protocol against storage and removes the probe row', async () => {
    const result = await probeEntityProtocol({ now: NOW });
    expect(result.verified).toBe(true);
    expect([...runtime.entities.keys()]).toEqual([]);
  });

  it('reports storage failure during the probe as unverified', async () => {
    runtime.state.failure = new Error('storage unavailable');
    const result = await probeEntityProtocol({ now: NOW });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('probe-storage-error');
  });
});
