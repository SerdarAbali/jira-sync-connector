/**
 * Authorized installation double for suites that test something other than the
 * synchronization authorization gate itself.
 *
 * Every suite that uses this module states that explicitly with
 * `jest.mock('../src/services/sync/sync-authorization.js', () => require('./helpers/authorized-sync-authorization.js'))`.
 * The production module is exercised unmodified by `tests/sync-authorization.test.js`
 * and by the static wiring assertion in that suite.
 */
const kvsStore = require('../../src/services/storage/kvs.js');

const SYNC_AUTHORIZATION_KEY = 'syncAuthorization';
const SYNC_AUTHORIZATION_STATES = Object.freeze({
  AUTHORIZED: 'authorized',
  RESTORE_IN_PROGRESS: 'restore-in-progress',
  BLOCKED: 'blocked'
});
const SYNC_AUTHORIZATION_REASONS = Object.freeze({
  MISSING: 'SYNC_AUTHORIZATION_MISSING',
  UNREADABLE: 'SYNC_AUTHORIZATION_UNREADABLE',
  MALFORMED: 'SYNC_AUTHORIZATION_MALFORMED',
  IDENTITY_UNAVAILABLE: 'SYNC_AUTHORIZATION_IDENTITY_UNAVAILABLE',
  INSTALLATION_MISMATCH: 'SYNC_AUTHORIZATION_INSTALLATION_MISMATCH',
  RESTORE_IN_PROGRESS: 'SYNC_RESTORE_IN_PROGRESS',
  BLOCKED: 'SYNC_AUTHORIZATION_BLOCKED',
  NO_ORGANIZATIONS: 'SYNC_AUTHORIZATION_NO_ORGANIZATIONS',
  ORGANIZATIONS_UNVERIFIED: 'SYNC_AUTHORIZATION_ORGANIZATIONS_UNVERIFIED',
  CONFIRMATION_REQUIRED: 'SYNC_AUTHORIZATION_CONFIRMATION_REQUIRED',
  INVALID_STATE: 'SYNC_AUTHORIZATION_INVALID_STATE'
});

class SyncAuthorizationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SyncAuthorizationError';
    this.code = code;
  }
}

const authorizedStatus = {
  authorized: true,
  state: SYNC_AUTHORIZATION_STATES.AUTHORIZED,
  reason: null,
  message: null,
  record: null,
  currentIdentity: null,
  configuredOrganizationIds: [],
  uncoveredOrganizationIds: []
};

module.exports = {
  SYNC_AUTHORIZATION_KEY,
  SYNC_AUTHORIZATION_STATES,
  SYNC_AUTHORIZATION_REASONS,
  SYNC_AUTHORIZATION_BASES: Object.freeze(['fresh-install', 'established', 'restored']),
  SyncAuthorizationError,
  readSyncAuthorizationStatus: jest.fn(async () => ({ ...authorizedStatus })),
  assertSyncAuthorized: jest.fn(async () => ({ ...authorizedStatus })),
  syncAuthorizationConfirmation: ({ installationId, organizationIds }) =>
    `AUTHORIZE ${installationId} ${[...new Set(organizationIds)].sort().join(',')}`,
  authorizeSynchronization: jest.fn(async ({ confirmation } = {}) => {
    await kvsStore.set(SYNC_AUTHORIZATION_KEY, { state: 'authorized' });
    return { success: true, state: 'authorized', confirmation, jiraWritesPerformed: false };
  }),
  setSyncAuthorizationState: jest.fn(async ({ state } = {}) => ({ success: true, state }))
};
