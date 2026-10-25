import kvs from '@forge/kvs';
import { getAppContext } from '@forge/api';
import {
  FRESH_INSTALLATION_TARGET, FRESH_INITIALIZATION_POLICY, matchesFreshInstallationContext
} from './fresh-install-policy.js';

export const ISSUE_LEASE_MIGRATION_KEY = 'issueLeaseMigration:v1';
// Maximum handler (900s), outstanding request (180s), plus drain margin.
export const LEGACY_LEASE_DRAIN_MS = 1140000;

const MIGRATION_FIELDS = Object.freeze([
  'version',
  'phase',
  'legacyDisabled',
  'disabledAt',
  'activatedAt'
]);

function isSafeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// Only the documented control fields leave this module. Any additional stored
// field is not part of the migration contract and must not be surfaced.
function safeMigrationState(state) {
  const safe = {};
  const fields = state.version === 2
    ? ['version', 'phase', 'basis', 'activatedAt', 'policy', ...Object.keys(FRESH_INSTALLATION_TARGET)]
    : MIGRATION_FIELDS;
  for (const field of fields) {
    const value = state[field];
    if (typeof value === 'string' || typeof value === 'boolean' || Number.isSafeInteger(value)) {
      safe[field] = value;
    } else {
      safe[field] = null;
    }
  }
  return safe;
}

/**
 * Evaluates the stored F07 control record. Missing, malformed, future-dated and
 * insufficiently drained state is not ready. `active` only reflects the declared
 * phase; `valid` is the authorization-relevant decision.
 */
export function evaluateIssueLeaseMigrationState(state, now = Date.now(), context) {
  if (state === null || state === undefined) {
    return {
      present: false,
      valid: false,
      active: false,
      phase: null,
      state: null,
      reasons: ['migration-missing']
    };
  }

  if (typeof state !== 'object' || Array.isArray(state)) {
    return {
      present: true,
      valid: false,
      active: false,
      phase: null,
      state: null,
      reasons: ['migration-malformed']
    };
  }

  if (state.version === 2) {
    const reasons = [];
    if (state.basis !== 'fresh-install' || state.phase !== 'entity-active') reasons.push('fresh-marker-malformed');
    if (!matchesFreshInstallationContext(context)
        || !Object.entries(FRESH_INSTALLATION_TARGET).every(([key, value]) => state[key] === value)) {
      reasons.push('fresh-installation-mismatch');
    }
    if (state.policy !== FRESH_INITIALIZATION_POLICY) reasons.push('fresh-policy-invalid');
    if (!isSafeTimestamp(state.activatedAt) || state.activatedAt > now) reasons.push('fresh-activated-at-invalid');
    return { present: true, valid: reasons.length === 0, active: state.phase === 'entity-active',
      phase: typeof state.phase === 'string' ? state.phase : null,
      state: safeMigrationState(state), reasons };
  }

  const reasons = [];
  if (state.version !== 1) reasons.push('migration-version-unsupported');

  const phase = typeof state.phase === 'string' ? state.phase : null;
  if (!phase) {
    reasons.push('migration-phase-missing');
  } else if (phase !== 'entity-active') {
    reasons.push('migration-phase-inactive');
  }

  if (state.legacyDisabled !== true) reasons.push('migration-legacy-writers-not-retired');
  if (!isSafeTimestamp(state.disabledAt)) {
    reasons.push('migration-disabled-at-invalid');
  }
  if (!isSafeTimestamp(state.activatedAt)) {
    reasons.push('migration-activated-at-invalid');
  }

  if (reasons.length === 0) {
    if (state.activatedAt < state.disabledAt + LEGACY_LEASE_DRAIN_MS) {
      reasons.push('migration-drain-incomplete');
    }
    if (state.activatedAt > now) {
      reasons.push('migration-activated-in-future');
    }
  }

  return {
    present: true,
    valid: reasons.length === 0,
    active: phase === 'entity-active',
    phase,
    state: safeMigrationState(state),
    reasons
  };
}

/**
 * Reads the control record without caching. A missing record is reported as
 * absent; an unreadable store is reported separately so callers can fail closed
 * without claiming which state exists.
 */
export async function readIssueLeaseMigrationState(now = Date.now()) {
  let state;
  try {
    state = await kvs.get(ISSUE_LEASE_MIGRATION_KEY);
  } catch {
    return {
      readable: false,
      present: null,
      valid: false,
      active: false,
      phase: null,
      state: null,
      reasons: ['migration-unreadable']
    };
  }

  let context;
  if (state?.version === 2) {
    try { context = getAppContext(); } catch { /* Invalid binding fails closed. */ }
  }
  return { readable: true, ...evaluateIssueLeaseMigrationState(state, now, context) };
}

export async function assertIssueLeaseMigrationReady() {
  const result = await readIssueLeaseMigrationState();
  if (!result.valid) {
    throw leaseMigrationError();
  }
}

function leaseMigrationError() {
  const error = new Error('Issue lease migration is not verified; writes blocked');
  error.code = 'LEASE_MIGRATION_REQUIRED';
  return error;
}
