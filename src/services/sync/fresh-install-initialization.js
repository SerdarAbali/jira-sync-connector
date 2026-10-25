import kvs from '@forge/kvs';
import { getAppContext } from '@forge/api';
import { buildConnectorReadiness } from '../readiness/connector-readiness.js';
import { ISSUE_LEASE_MIGRATION_KEY, readIssueLeaseMigrationState } from './lease-migration.js';
import { probeEntityProtocol } from './lease-migration-activation.js';
import {
  FRESH_INSTALLATION_TARGET, FRESH_INITIALIZATION_POLICY, matchesFreshInstallationContext
} from './fresh-install-policy.js';
import { isKeyConflictError } from '../../utils/storage-errors.js';

export const FRESH_INITIALIZATION_CONFIRMATION = 'INITIALIZE_FRESH_ISSUE_LEASES';

function blocked(code, wroteMigrationState = false) {
  const messages = {
    PAUSE_REQUIRED: 'Verify Pause is active using the existing staging Pause control, then retry. Initialization never changes Pause.',
    F07_MARKER_EXISTS: 'An F07 marker already exists. Inspect readiness; initialization cannot overwrite it.',
    FRESH_WRITE_OUTCOME_UNKNOWN: 'The marker write outcome is unknown. Inspect readiness before any further action; do not blindly retry.',
    FRESH_READBACK_UNVERIFIED: 'Marker validation could not be completed. Inspect readiness; do not delete or overwrite existing state.',
    F07_STATE_UNREADABLE: 'F07 storage could not be read. Restore readable storage before initialization.',
    ENTITY_PROTOCOL_UNVERIFIED: 'Conditional Custom Entity transactions could not be verified; initialization is blocked.',
    FRESH_INITIALIZATION_UNAVAILABLE: 'Initialization prerequisites could not be read or verified. No marker write was attempted.'
  };
  return {
    success: false, status: 'BLOCKED', code, error: messages[code] || code,
    activation: { performed: false, wroteMigrationState }
  };
}

function checkReadiness(ready, requireAbsent = true) {
  const target = FRESH_INSTALLATION_TARGET;
  if (ready?.success !== true) return 'READINESS_UNAVAILABLE';
  if (ready.appId !== target.appId || ready.environmentId !== target.environmentId
      || ready.installationId !== target.installationId
      || typeof ready.environment !== 'string' || ready.environment.toUpperCase() !== 'STAGING'
      || !Array.isArray(ready.installedSites) || ready.installedSites.length !== 1
      || ready.installedSites[0] !== target.siteHost) return 'READINESS_BINDING_MISMATCH';
  if (ready.pause?.readable !== true || ready.pause.paused !== true) return 'PAUSE_REQUIRED';
  if (ready.f07Status?.readable !== true) return 'F07_STATE_UNREADABLE';
  if (requireAbsent && ready.f07Status.present !== false) return 'F07_MARKER_EXISTS';
  if (!requireAbsent && ready.f07Status.valid !== true) return 'FRESH_READBACK_UNVERIFIED';
  return null;
}

/**
 * Only the registered ADMIN_WRITE resolver may expose this service. Dependencies
 * are an internal test boundary and are never forwarded from resolver payloads.
 * The exact disposable staging installation has an explicit provenance waiver.
 */
export async function initializeFreshIssueLeases(options = {}) {
  const deps = {
    getAppContext, kvs, readReadiness: buildConnectorReadiness,
    readIssueLeaseMigrationState, now: () => Date.now(), ...(options.deps || {})
  };
  const payload = options.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).some(key => key !== 'confirmation')) {
    return blocked('INVALID_FRESH_INITIALIZATION_INPUT');
  }
  if (payload.confirmation !== FRESH_INITIALIZATION_CONFIRMATION) {
    return blocked('CONFIRMATION_REQUIRED');
  }
  let writeAttempted = false;
  let wrote = false;
  try {
    let context;
    try { context = deps.getAppContext(); } catch { return blocked('FRESH_INSTALLATION_MISMATCH'); }
    if (!matchesFreshInstallationContext(context)) return blocked('FRESH_INSTALLATION_MISMATCH');
    let reason = checkReadiness(await deps.readReadiness());
    if (reason) return blocked(reason);
    // Reuse real conditional-create, conflict, readback and token-delete probe.
    const probe = await probeEntityProtocol({ deps: { kvs: deps.kvs }, now: deps.now() });
    if (!probe.verified) return blocked('ENTITY_PROTOCOL_UNVERIFIED');
    reason = checkReadiness(await deps.readReadiness());
    if (reason) return blocked(reason);
    if (!matchesFreshInstallationContext(deps.getAppContext())) return blocked('FRESH_INSTALLATION_MISMATCH');
    const activatedAt = deps.now();
    if (!Number.isSafeInteger(activatedAt) || activatedAt < 0) return blocked('INITIALIZATION_CLOCK_INVALID');
    const marker = {
      version: 2, basis: 'fresh-install', phase: 'entity-active',
      ...FRESH_INSTALLATION_TARGET, activatedAt,
      policy: FRESH_INITIALIZATION_POLICY
    };
    writeAttempted = true;
    try {
      await deps.kvs.set(ISSUE_LEASE_MIGRATION_KEY, marker, { keyPolicy: 'FAIL_IF_EXISTS' });
    } catch (error) {
      return isKeyConflictError(error)
        ? blocked('F07_MARKER_EXISTS') : blocked('FRESH_WRITE_OUTCOME_UNKNOWN', null);
    }
    wrote = true;
    // The production reader verifies schema, staging policy and current runtime
    // binding; do not promote the value we attempted to write into a receipt.
    const stored = await deps.readIssueLeaseMigrationState(deps.now());
    if (!stored.valid || stored.state?.version !== 2
        || stored.state.activatedAt !== activatedAt
        || stored.state.policy !== FRESH_INITIALIZATION_POLICY) {
      return blocked('FRESH_READBACK_UNVERIFIED', true);
    }
    const after = await deps.readReadiness();
    reason = checkReadiness(after, false);
    if (reason) return blocked(reason, true);
    return {
      success: true, status: 'INITIALIZED',
      activation: { performed: true, wroteMigrationState: true },
      binding: { ...FRESH_INSTALLATION_TARGET }, paused: true
    };
  } catch {
    // Never retry or remove a marker following an uncertain write/readback.
    return blocked(wrote ? 'FRESH_READBACK_UNVERIFIED' : writeAttempted
      ? 'FRESH_WRITE_OUTCOME_UNKNOWN' : 'FRESH_INITIALIZATION_UNAVAILABLE',
    wrote ? true : writeAttempted ? null : false);
  }
}
