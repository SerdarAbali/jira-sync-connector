import * as kvsStore from '../storage/kvs.js';
import { createHash } from 'crypto';
import { getAppContext } from '@forge/api';

/**
 * Installation-wide synchronization authorization.
 *
 * This is a positive gate: Jira writes are allowed only when a record exists,
 * parses, belongs to this installation and names every configured organization.
 * An absent, malformed, unreadable or foreign record blocks. Pause remains an
 * independent veto and is never consulted here.
 *
 * The gate is deliberately independent of the emergency pause, of the F07 lease
 * migration marker, of any recovery snapshot checksum and of any restore
 * implementation. It answers one question only: has an administrator explicitly
 * authorized this installation's mapping state as trustworthy?
 */

export const SYNC_AUTHORIZATION_KEY = 'syncAuthorization';
export const SYNC_AUTHORIZATION_VERSION = 1;

export const SYNC_AUTHORIZATION_STATES = Object.freeze({
  AUTHORIZED: 'authorized',
  RESTORE_IN_PROGRESS: 'restore-in-progress',
  BLOCKED: 'blocked'
});

export const SYNC_AUTHORIZATION_BASES = Object.freeze(['fresh-install', 'established', 'restored']);

export const SYNC_AUTHORIZATION_REASONS = Object.freeze({
  MISSING: 'SYNC_AUTHORIZATION_MISSING',
  UNREADABLE: 'SYNC_AUTHORIZATION_UNREADABLE',
  MALFORMED: 'SYNC_AUTHORIZATION_MALFORMED',
  IDENTITY_UNAVAILABLE: 'SYNC_AUTHORIZATION_IDENTITY_UNAVAILABLE',
  INSTALLATION_MISMATCH: 'SYNC_AUTHORIZATION_INSTALLATION_MISMATCH',
  RESTORE_IN_PROGRESS: 'SYNC_RESTORE_IN_PROGRESS',
  BLOCKED: 'SYNC_AUTHORIZATION_BLOCKED',
  NO_ORGANIZATIONS: 'SYNC_AUTHORIZATION_NO_ORGANIZATIONS',
  ORGANIZATIONS_UNVERIFIED: 'SYNC_AUTHORIZATION_ORGANIZATIONS_UNVERIFIED',
  ORGANIZATION_SET_CHANGED: 'SYNC_AUTHORIZATION_ORGANIZATION_SET_CHANGED',
  CONFIRMATION_REQUIRED: 'SYNC_AUTHORIZATION_CONFIRMATION_REQUIRED',
  INVALID_STATE: 'SYNC_AUTHORIZATION_INVALID_STATE'
});

export const SYNC_AUTHORIZATION_MESSAGES = Object.freeze({
  [SYNC_AUTHORIZATION_REASONS.MISSING]:
    'Synchronization authorization is missing. No Jira write is attempted until an administrator authorizes this installation.',
  [SYNC_AUTHORIZATION_REASONS.UNREADABLE]:
    'Synchronization authorization could not be read. No Jira write is attempted.',
  [SYNC_AUTHORIZATION_REASONS.MALFORMED]:
    'Synchronization authorization is not a record this connector wrote. No Jira write is attempted.',
  [SYNC_AUTHORIZATION_REASONS.IDENTITY_UNAVAILABLE]:
    'The installation identity could not be read, so synchronization authorization cannot be verified. No Jira write is attempted.',
  [SYNC_AUTHORIZATION_REASONS.INSTALLATION_MISMATCH]:
    'Synchronization authorization belongs to a different installation. No Jira write is attempted.',
  [SYNC_AUTHORIZATION_REASONS.RESTORE_IN_PROGRESS]:
    'A restore is in progress. No Jira write is attempted until it is verified and authorization is re-established.',
  [SYNC_AUTHORIZATION_REASONS.BLOCKED]:
    'Synchronization is explicitly blocked. No Jira write is attempted.',
  [SYNC_AUTHORIZATION_REASONS.NO_ORGANIZATIONS]:
    'No organization is configured, so synchronization cannot be authorized.',
  [SYNC_AUTHORIZATION_REASONS.ORGANIZATIONS_UNVERIFIED]:
    'At least one configured organization was not covered when synchronization was authorized. No Jira write is attempted.',
  [SYNC_AUTHORIZATION_REASONS.ORGANIZATION_SET_CHANGED]:
    'The authorized organization set no longer matches the configured organization set: an organization was added or removed after authorization. No Jira write is attempted until the exact current set is authorized again.',
  [SYNC_AUTHORIZATION_REASONS.CONFIRMATION_REQUIRED]:
    'The authorization confirmation does not match this installation and its organizations. Nothing was written.',
  [SYNC_AUTHORIZATION_REASONS.INVALID_STATE]:
    'The requested synchronization authorization state is not valid. Nothing was written.'
});

export class SyncAuthorizationError extends Error {
  constructor(code) {
    super(SYNC_AUTHORIZATION_MESSAGES[code]
      || SYNC_AUTHORIZATION_MESSAGES[SYNC_AUTHORIZATION_REASONS.MISSING]);
    this.name = 'SyncAuthorizationError';
    this.code = code;
  }
}

const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const ORGANIZATION_ID_PATTERN = /^org-\d+$/;
const VALID_STATES = new Set(Object.values(SYNC_AUTHORIZATION_STATES));

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isInstallationId(value) {
  return typeof value === 'string' && INSTALLATION_ID_PATTERN.test(value);
}

function isOrganizationId(value) {
  return typeof value === 'string' && ORGANIZATION_ID_PATTERN.test(value);
}

/**
 * Canonical digest of an organization set. Order-independent and duplicate-free,
 * so reordering or repeating an entry never changes it. It is stored with the
 * authorization record and compared on every read: a record that names a
 * different set than the installation currently configures is refused, whether
 * the difference is an addition or a removal.
 */
export function syncAuthorizationOrganizationDigest(organizationIds = []) {
  const ids = [...new Set(organizationIds.filter(isOrganizationId))].sort();
  return `sha256:${createHash('sha256').update(ids.join(','), 'utf8').digest('hex')}`;
}

function organizationSetDelta(configured, authorized) {
  return {
    added: configured.filter((id) => !authorized.includes(id)),
    removed: authorized.filter((id) => !configured.includes(id))
  };
}

/** Reads app, environment and installation identity without a Jira request. */
function readContextIdentity(deps) {
  let context;
  try {
    context = deps.getAppContext();
  } catch {
    return null;
  }
  const appId = typeof context?.appAri?.appId === 'string' ? context.appAri.appId : null;
  const environmentId = typeof context?.environmentAri?.environmentId === 'string'
    ? context.environmentAri.environmentId
    : null;
  const installationId = typeof context?.installationAri?.installationId === 'string'
    ? context.installationAri.installationId
    : null;
  if (!isInstallationId(appId) || !isInstallationId(environmentId)
    || !isInstallationId(installationId)) {
    return null;
  }
  return { appId, environmentId, installationId };
}

function normalizeRecord(value) {
  if (!isPlainObject(value)) return null;
  if (value.version !== SYNC_AUTHORIZATION_VERSION) return null;
  if (!VALID_STATES.has(value.state)) return null;
  if (!isInstallationId(value.appId)
    || !isInstallationId(value.environmentId)
    || !isInstallationId(value.installationId)) {
    return null;
  }
  if (!Array.isArray(value.organizationIds) || value.organizationIds.length === 0
    || value.organizationIds.some((id) => !isOrganizationId(id))) {
    return null;
  }
  return {
    version: SYNC_AUTHORIZATION_VERSION,
    state: value.state,
    appId: value.appId,
    environmentId: value.environmentId,
    installationId: value.installationId,
    organizationIds: Array.from(new Set(value.organizationIds)).sort(),
    organizationSetDigest: typeof value.organizationSetDigest === 'string'
      ? value.organizationSetDigest
      : null,
    basis: SYNC_AUTHORIZATION_BASES.includes(value.basis) ? value.basis : null,
    authorizedAt: typeof value.authorizedAt === 'string' ? value.authorizedAt : null,
    authorizedBy: typeof value.authorizedBy === 'string' ? value.authorizedBy.slice(0, 100) : null,
    reason: typeof value.reason === 'string' ? value.reason.slice(0, 80) : null
  };
}

function blocked(reason, extra = {}) {
  return {
    authorized: false,
    state: null,
    reason,
    message: SYNC_AUTHORIZATION_MESSAGES[reason],
    record: null,
    configuredOrganizationIds: [],
    uncoveredOrganizationIds: [],
    organizationSetDelta: { added: [], removed: [] },
    ...extra
  };
}

/**
 * Read-only authorization status. Never writes, never calls Jira.
 *
 * A record authorizes writes only when it parses, matches this installation and
 * names every currently configured organization. A restore for one organization
 * therefore cannot authorize another organization's writes.
 */
export async function readSyncAuthorizationStatus(options = {}) {
  const deps = { getStored: kvsStore.get, getAppContext, ...options.deps };
  const identity = readContextIdentity(deps);

  let organizations;
  try {
    organizations = await deps.getStored('organizations');
  } catch {
    return blocked(SYNC_AUTHORIZATION_REASONS.UNREADABLE, { currentIdentity: identity });
  }
  const configuredOrganizationIds = (Array.isArray(organizations) ? organizations : [])
    .map((organization) => organization?.id)
    .filter(isOrganizationId)
    .sort();

  let stored;
  try {
    stored = await deps.getStored(SYNC_AUTHORIZATION_KEY);
  } catch {
    return blocked(SYNC_AUTHORIZATION_REASONS.UNREADABLE, {
      currentIdentity: identity,
      configuredOrganizationIds
    });
  }
  if (stored === null || stored === undefined) {
    return blocked(SYNC_AUTHORIZATION_REASONS.MISSING, {
      currentIdentity: identity,
      configuredOrganizationIds
    });
  }

  const record = normalizeRecord(stored);
  if (!record) {
    return blocked(SYNC_AUTHORIZATION_REASONS.MALFORMED, {
      currentIdentity: identity,
      configuredOrganizationIds
    });
  }
  if (!identity) {
    return blocked(SYNC_AUTHORIZATION_REASONS.IDENTITY_UNAVAILABLE, {
      record,
      configuredOrganizationIds
    });
  }
  if (record.appId !== identity.appId
    || record.environmentId !== identity.environmentId
    || record.installationId !== identity.installationId) {
    return blocked(SYNC_AUTHORIZATION_REASONS.INSTALLATION_MISMATCH, {
      record,
      currentIdentity: identity,
      configuredOrganizationIds
    });
  }

  const base = { record, currentIdentity: identity, configuredOrganizationIds };

  if (record.state === SYNC_AUTHORIZATION_STATES.RESTORE_IN_PROGRESS) {
    return { ...blocked(SYNC_AUTHORIZATION_REASONS.RESTORE_IN_PROGRESS, base), state: record.state };
  }
  if (record.state !== SYNC_AUTHORIZATION_STATES.AUTHORIZED) {
    return { ...blocked(SYNC_AUTHORIZATION_REASONS.BLOCKED, base), state: record.state };
  }
  if (configuredOrganizationIds.length === 0) {
    return blocked(SYNC_AUTHORIZATION_REASONS.NO_ORGANIZATIONS, base);
  }
  const delta = organizationSetDelta(configuredOrganizationIds, record.organizationIds);
  const expectedDigest = syncAuthorizationOrganizationDigest(configuredOrganizationIds);
  // A record written before digests existed has no digest; exact set equality
  // still applies to it. A record whose digest disagrees with its own set, or
  // with the current set, is refused rather than partially trusted.
  const digestMatches = record.organizationSetDigest === null
    || record.organizationSetDigest === expectedDigest;

  // Additions first: an organization that was never authorized is the more
  // actionable problem, and it is reported with the existing reason.
  if (delta.added.length > 0) {
    return blocked(SYNC_AUTHORIZATION_REASONS.ORGANIZATIONS_UNVERIFIED, {
      ...base,
      uncoveredOrganizationIds: delta.added,
      organizationSetDelta: delta
    });
  }
  // Exact set equality, never containment. Removing an authorized organization
  // (or re-adding it later against an unchanged record) must invalidate the
  // authorization just as an addition does.
  if (delta.removed.length > 0 || !digestMatches) {
    return blocked(SYNC_AUTHORIZATION_REASONS.ORGANIZATION_SET_CHANGED, {
      ...base,
      organizationSetDelta: delta,
      expectedOrganizationSetDigest: expectedDigest
    });
  }

  return {
    authorized: true,
    state: record.state,
    reason: null,
    message: null,
    record,
    currentIdentity: identity,
    configuredOrganizationIds,
    uncoveredOrganizationIds: [],
    organizationSetDelta: { added: [], removed: [] }
  };
}

/** Fail-closed assertion used by the Jira submission boundary. */
export async function assertSyncAuthorized(options = {}) {
  const status = await readSyncAuthorizationStatus(options);
  if (!status.authorized) {
    throw new SyncAuthorizationError(status.reason);
  }
  return status;
}

/** The exact phrase an administrator must supply to authorize this installation. */
export function syncAuthorizationConfirmation({ installationId, organizationIds }) {
  const ids = [...new Set(organizationIds)].sort();
  return `AUTHORIZE ${installationId} ${ids.join(',')}`;
}

/**
 * Explicit, auditable authorization procedure for an established installation.
 *
 * It writes exactly one storage record and performs no Jira request of any kind,
 * so authorizing an installation can never create, update or delete an issue.
 * The confirmation phrase binds the action to one installation and one exact set
 * of organizations.
 */
export async function authorizeSynchronization(options = {}) {
  const deps = {
    getStored: kvsStore.get,
    setStored: kvsStore.set,
    getAppContext,
    now: () => Date.now(),
    ...options.deps
  };
  const identity = readContextIdentity(deps);
  if (!identity) {
    throw new SyncAuthorizationError(SYNC_AUTHORIZATION_REASONS.IDENTITY_UNAVAILABLE);
  }

  let organizations;
  try {
    organizations = await deps.getStored('organizations');
  } catch {
    throw new SyncAuthorizationError(SYNC_AUTHORIZATION_REASONS.UNREADABLE);
  }
  const organizationIds = (Array.isArray(organizations) ? organizations : [])
    .map((organization) => organization?.id)
    .filter(isOrganizationId)
    .sort();
  if (organizationIds.length === 0) {
    throw new SyncAuthorizationError(SYNC_AUTHORIZATION_REASONS.NO_ORGANIZATIONS);
  }

  const expected = syncAuthorizationConfirmation({
    installationId: identity.installationId,
    organizationIds
  });
  if (typeof options.confirmation !== 'string' || options.confirmation !== expected) {
    throw new SyncAuthorizationError(SYNC_AUTHORIZATION_REASONS.CONFIRMATION_REQUIRED);
  }

  const basis = SYNC_AUTHORIZATION_BASES.includes(options.basis) ? options.basis : 'established';
  const record = {
    version: SYNC_AUTHORIZATION_VERSION,
    state: SYNC_AUTHORIZATION_STATES.AUTHORIZED,
    appId: identity.appId,
    environmentId: identity.environmentId,
    installationId: identity.installationId,
    organizationIds,
    organizationSetDigest: syncAuthorizationOrganizationDigest(organizationIds),
    basis,
    authorizedAt: new Date(deps.now()).toISOString(),
    authorizedBy: typeof options.accountId === 'string' ? options.accountId.slice(0, 100) : null,
    reason: null
  };
  await deps.setStored(SYNC_AUTHORIZATION_KEY, record);
  return {
    success: true,
    state: record.state,
    organizationIds,
    authorizedAt: record.authorizedAt,
    basis,
    jiraWritesPerformed: false
  };
}

/**
 * Explicit state transition used by a future restore and by tests. Only storage
 * is written; no Jira request is made and no other feature is consulted.
 */
export async function setSyncAuthorizationState(options = {}) {
  const deps = {
    getStored: kvsStore.get,
    setStored: kvsStore.set,
    getAppContext,
    now: () => Date.now(),
    ...options.deps
  };
  if (!VALID_STATES.has(options.state)) {
    throw new SyncAuthorizationError(SYNC_AUTHORIZATION_REASONS.INVALID_STATE);
  }
  const identity = readContextIdentity(deps);
  if (!identity) {
    throw new SyncAuthorizationError(SYNC_AUTHORIZATION_REASONS.IDENTITY_UNAVAILABLE);
  }
  const organizationIds = Array.isArray(options.organizationIds)
    ? options.organizationIds.filter(isOrganizationId).sort()
    : [];
  if (organizationIds.length === 0) {
    throw new SyncAuthorizationError(SYNC_AUTHORIZATION_REASONS.NO_ORGANIZATIONS);
  }
  const record = {
    version: SYNC_AUTHORIZATION_VERSION,
    state: options.state,
    appId: identity.appId,
    environmentId: identity.environmentId,
    installationId: identity.installationId,
    organizationIds,
    organizationSetDigest: syncAuthorizationOrganizationDigest(organizationIds),
    basis: SYNC_AUTHORIZATION_BASES.includes(options.basis) ? options.basis : 'restored',
    authorizedAt: new Date(deps.now()).toISOString(),
    authorizedBy: typeof options.accountId === 'string' ? options.accountId.slice(0, 100) : null,
    reason: typeof options.reason === 'string' ? options.reason.slice(0, 80) : null
  };
  await deps.setStored(SYNC_AUTHORIZATION_KEY, record);
  return { success: true, state: record.state, organizationIds, jiraWritesPerformed: false };
}
