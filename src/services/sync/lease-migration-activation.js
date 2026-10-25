import { randomBytes } from 'crypto';
import kvs, { Filter, FilterConditions as C } from '@forge/kvs';
import { getAppContext } from '@forge/api';
import { getPilotPause } from './pilot-pause.js';
import {
  LEGACY_LEASE_DRAIN_MS,
  readIssueLeaseMigrationState
} from './lease-migration.js';
import { ISSUE_LEASE_ENTITY } from './issue-lease.js';
import { isKeyConflictError } from '../../utils/storage-errors.js';
import { safeErrorForLog } from '../../utils/redaction.js';

/**
 * Guarded F07 activation.
 *
 * The operation verifies the authorization preconditions that Forge can
 * actually demonstrate: an explicit administrator confirmation, authoritative
 * Pause, installation-bound identity, the minimum legacy drain window, the
 * stored migration phase and the Custom Entity conditional protocol against
 * real Forge storage.
 *
 * It deliberately cannot promote an operator assertion into proof of legacy
 * writer retirement. Forge exposes no supported interface that proves a
 * previous app version, queue consumer or scheduled handler can no longer run,
 * so a supplied retirement timestamp is reported but never trusted. When
 * retirement cannot be established the operation returns BLOCKED and writes
 * nothing. No flag, payload field or E2E path can bypass that.
 */
export const ACTIVATION_CONFIRMATION = 'ACTIVATE_ISSUE_LEASES';
export const LEGACY_RETIREMENT_UNVERIFIED =
  'Legacy writer retirement cannot be established through a supported Forge interface.';

const ALLOWED_PAYLOAD_KEYS = new Set(['confirmation', 'retirement']);
const PROBE_KEY_PREFIX = 'lease-probe-';
const PROBE_LEASE_MS = 60000;
const INACTIVE_PHASES = new Set(['legacy', 'pending', 'draining', 'inactive']);

const defaultDeps = {
  getAppContext,
  getPilotPause,
  readIssueLeaseMigrationState,
  kvs,
  now: () => Date.now()
};

function blocked(code, error, details = {}) {
  return {
    success: false,
    status: 'BLOCKED',
    code,
    error,
    activation: { performed: false, wroteMigrationState: false },
    ...details
  };
}

function failed(code, error, details = {}) {
  return {
    success: false,
    status: 'FAILED',
    code,
    error,
    activation: { performed: false, wroteMigrationState: false },
    ...details
  };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readIdentity(deps) {
  try {
    const context = deps.getAppContext();
    const appId = typeof context?.appAri?.appId === 'string' ? context.appAri.appId : null;
    const environmentId = typeof context?.environmentAri?.environmentId === 'string'
      ? context.environmentAri.environmentId
      : null;
    const installationId = typeof context?.installationAri?.installationId === 'string'
      ? context.installationAri.installationId
      : null;
    const environmentType = typeof context?.environmentType === 'string'
      ? context.environmentType
      : null;
    const appVersion = typeof context?.appVersion === 'string' ? context.appVersion : null;
    if (!appId || !environmentId || !installationId || !environmentType) return null;
    return { appId, environmentId, installationId, environmentType, appVersion };
  } catch {
    return null;
  }
}

function validInactiveState(state) {
  return isPlainObject(state)
    && state.version === 1
    && typeof state.phase === 'string'
    && INACTIVE_PHASES.has(state.phase)
    && state.legacyDisabled !== true;
}

/**
 * Evaluates a caller-supplied retirement timestamp for the drain check only.
 * The result is never treated as proof of retirement.
 */
export function evaluateRetirementCandidate(candidate, now = Date.now()) {
  if (candidate === undefined || candidate === null) {
    return { supplied: false, drainSatisfied: false, reason: 'retirement-evidence-missing' };
  }
  if (!isPlainObject(candidate)) {
    return { supplied: true, drainSatisfied: false, reason: 'retirement-evidence-malformed' };
  }
  const disabledAt = candidate.legacyDisabledAt;
  if (!Number.isSafeInteger(disabledAt) || disabledAt < 0) {
    return { supplied: true, drainSatisfied: false, reason: 'retirement-evidence-malformed' };
  }
  if (disabledAt > now) {
    return { supplied: true, drainSatisfied: false, reason: 'retirement-evidence-future-dated' };
  }
  if (now - disabledAt < LEGACY_LEASE_DRAIN_MS) {
    return { supplied: true, drainSatisfied: false, reason: 'retirement-drain-incomplete' };
  }
  return { supplied: true, drainSatisfied: true, reason: 'retirement-evidence-unverified' };
}

async function conditionalSet(kvsApi, key, value) {
  await kvsApi.transact().set(key, value, {
    entityName: ISSUE_LEASE_ENTITY,
    conditions: new Filter().and('leaseToken', C.notExists())
  }).execute();
}

async function conditionalDelete(kvsApi, key, token) {
  await kvsApi.transact().delete(key, {
    entityName: ISSUE_LEASE_ENTITY,
    conditions: new Filter().and('leaseToken', C.equalTo(token))
  }).execute();
}

/**
 * Exercises the documented Custom Entity conditional protocol on real Forge
 * storage: conditional create, rejected duplicate create, read-back and
 * conditional delete. Only a short-lived probe row is written and it is removed
 * before returning. Leases, mappings and operation ledgers are never touched.
 */
export async function probeEntityProtocol({ deps = defaultDeps, now = Date.now() } = {}) {
  const kvsApi = deps.kvs;
  const key = `${PROBE_KEY_PREFIX}${randomBytes(16).toString('hex')}`;
  const token = randomBytes(32).toString('hex');
  const expiresAt = now + PROBE_LEASE_MS;
  let created = false;

  try {
    await conditionalSet(kvsApi, key, { leaseToken: token, expiresAt });
    created = true;

    let duplicateRejected = false;
    try {
      await conditionalSet(kvsApi, key, { leaseToken: randomBytes(32).toString('hex'), expiresAt });
    } catch (error) {
      duplicateRejected = isKeyConflictError(error);
    }
    if (!duplicateRejected) {
      return { verified: false, reason: 'probe-conditional-create-not-enforced' };
    }

    const stored = await kvsApi.entity(ISSUE_LEASE_ENTITY).get(key);
    if (stored?.leaseToken !== token) {
      return { verified: false, reason: 'probe-read-back-mismatch' };
    }

    await conditionalDelete(kvsApi, key, token);
    created = false;

    const remaining = await kvsApi.entity(ISSUE_LEASE_ENTITY).get(key);
    if (remaining) {
      return { verified: false, reason: 'probe-delete-not-applied' };
    }
    return { verified: true, reason: null };
  } catch (error) {
    console.warn('Issue lease protocol probe failed', safeErrorForLog(error));
    return {
      verified: false,
      reason: isKeyConflictError(error) ? 'probe-conditional-conflict' : 'probe-storage-error'
    };
  } finally {
    if (created) {
      try {
        await conditionalDelete(kvsApi, key, token);
      } catch {
        // Best-effort cleanup only. A leftover probe row is inert and can be
        // removed by the application-level takeover protocol.
      }
    }
  }
}

/**
 * Smallest authorized administrative operation for the F07 gate. It either
 * performs every verifiable precondition and then stops at the unprovable
 * retirement boundary, or fails closed earlier with a specific reason. It never
 * writes migration state, mappings, leases or operation ledgers.
 */
export async function activateIssueLeaseMigration(options = {}) {
  const deps = { ...defaultDeps, ...(options.deps || {}) };
  const nowMs = deps.now();
  const payload = isPlainObject(options.payload) ? options.payload : null;
  const checks = [];

  if (!payload) {
    return blocked('INVALID_PAYLOAD', 'Activation requires an explicit confirmation payload.');
  }

  const unsupported = Object.keys(payload).filter((key) => !ALLOWED_PAYLOAD_KEYS.has(key));
  if (unsupported.length > 0) {
    return blocked(
      'UNSUPPORTED_ACTIVATION_INPUT',
      'Activation accepts only an explicit confirmation and an unverified retirement timestamp.',
      { rejectedFields: unsupported }
    );
  }

  if (payload.confirmation !== ACTIVATION_CONFIRMATION) {
    return blocked('CONFIRMATION_REQUIRED', 'Activation requires the explicit administrator confirmation value.');
  }

  const identity = readIdentity(deps);
  if (!identity) {
    return blocked('IDENTITY_UNAVAILABLE', 'Forge installation identity is unavailable; activation cannot be bound.');
  }
  checks.push({
    id: 'identity-binding',
    status: 'pass',
    detail: 'Forge application, environment and installation identity are available.'
  });

  let pause;
  try {
    pause = await deps.getPilotPause();
  } catch (error) {
    console.warn('Activation pause read failed', safeErrorForLog(error));
    return failed('PAUSE_UNREADABLE', 'Authoritative Pause could not be read.');
  }
  if (pause?.paused !== true) {
    return blocked(
      'PAUSE_REQUIRED',
      'F07 activation requires an authoritative Pause before the migration gate can change.',
      { checks }
    );
  }
  checks.push({ id: 'pause-state', status: 'pass', detail: 'Authoritative Pause is active.' });

  let migration;
  try {
    migration = await deps.readIssueLeaseMigrationState(nowMs);
  } catch (error) {
    console.warn('Activation migration state read failed', safeErrorForLog(error));
    return failed('MIGRATION_STATE_UNREADABLE', 'F07 migration state could not be read.');
  }
  if (migration.readable !== true) {
    return blocked('MIGRATION_STATE_UNREADABLE', 'F07 migration state could not be read; activation fails closed.', { checks });
  }
  if (migration.present && migration.active) {
    return blocked('MIGRATION_ALREADY_ACTIVE', 'F07 migration is already entity-active.', { checks });
  }
  if (migration.present && !validInactiveState(migration.state)) {
    return blocked(
      'MIGRATION_STATE_AMBIGUOUS',
      'The stored F07 migration state is malformed or unrecognized; activation fails closed.',
      { checks }
    );
  }
  checks.push({
    id: 'migration-state',
    status: 'pass',
    detail: migration.present ? 'F07 state is explicitly inactive.' : 'F07 state is absent (not yet activated).'
  });

  const retirement = evaluateRetirementCandidate(payload.retirement, nowMs);
  checks.push({
    id: 'legacy-retirement',
    status: 'unknown',
    detail: retirement.supplied
      ? `A retirement timestamp was supplied (${retirement.reason}); it is not verifiable evidence.`
      : 'No legacy writer retirement evidence was supplied, and none can be verified by the app.'
  });
  if (retirement.supplied && retirement.reason === 'retirement-evidence-malformed') {
    return blocked('RETIREMENT_EVIDENCE_INVALID', 'The supplied retirement evidence is malformed.', { checks });
  }
  if (retirement.supplied && retirement.reason === 'retirement-evidence-future-dated') {
    return blocked('RETIREMENT_EVIDENCE_INVALID', 'The supplied retirement timestamp is in the future.', { checks });
  }
  if (retirement.supplied && retirement.reason === 'retirement-drain-incomplete') {
    return blocked(
      'DRAIN_INCOMPLETE',
      `At least ${LEGACY_LEASE_DRAIN_MS} ms must elapse after legacy writer retirement.`,
      { checks }
    );
  }

  let probe;
  try {
    probe = await probeEntityProtocol({ deps, now: nowMs });
  } catch (error) {
    console.warn('Activation entity protocol probe failed', safeErrorForLog(error));
    probe = { verified: false, reason: 'probe-storage-error' };
  }
  checks.push({
    id: 'entity-protocol',
    status: probe.verified ? 'pass' : 'block',
    detail: probe.verified
      ? 'Custom Entity conditional create, conflict rejection, read-back and delete are verified.'
      : `Custom Entity protocol could not be verified: ${probe.reason}.`
  });
  if (!probe.verified) {
    return blocked(
      'ENTITY_PROTOCOL_UNVERIFIED',
      'Required Custom Entity behavior could not be verified against Forge storage.',
      { checks, probe: { verified: false, reason: probe.reason } }
    );
  }

  let pauseAfter;
  try {
    pauseAfter = await deps.getPilotPause();
  } catch (error) {
    console.warn('Activation pause re-check failed', safeErrorForLog(error));
    return failed('PAUSE_UNREADABLE', 'Authoritative Pause could not be re-read.');
  }
  if (pauseAfter?.paused !== true) {
    return blocked('PAUSE_LOST', 'Pause was not authoritative for the whole activation attempt.', { checks });
  }

  let current;
  try {
    current = await deps.readIssueLeaseMigrationState(nowMs);
  } catch (error) {
    console.warn('Activation migration state re-check failed', safeErrorForLog(error));
    return failed('MIGRATION_STATE_UNREADABLE', 'F07 migration state could not be re-read.');
  }
  if (current.readable !== true) {
    return blocked('MIGRATION_STATE_UNREADABLE', 'F07 migration state could not be re-read; activation fails closed.', { checks });
  }
  if (current.active) {
    return blocked('MIGRATION_ALREADY_ACTIVE', 'F07 migration became entity-active during this attempt.', { checks });
  }
  if (current.present && !validInactiveState(current.state)) {
    return blocked('MIGRATION_STATE_CHANGED', 'F07 migration state changed to an ambiguous value during this attempt.', { checks });
  }

  return blocked(
    LEGACY_RETIREMENT_UNVERIFIED,
    `${LEGACY_RETIREMENT_UNVERIFIED} F07 activation stays blocked and no state was written.`,
    {
      checks,
      probe: { verified: true, reason: null },
      drain: {
        suppliedDisabledAt: retirement.supplied ? payload.retirement.legacyDisabledAt : null,
        drainMs: LEGACY_LEASE_DRAIN_MS,
        satisfied: retirement.drainSatisfied
      },
      binding: {
        appId: identity.appId,
        environmentId: identity.environmentId,
        installationId: identity.installationId
      },
      evidence: { source: null, verified: false }
    }
  );
}
