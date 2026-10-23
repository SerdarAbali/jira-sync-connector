import kvs from '@forge/kvs';

export const ISSUE_LEASE_MIGRATION_KEY = 'issueLeaseMigration:v1';
// Maximum handler (900s), outstanding request (180s), plus drain margin.
export const LEGACY_LEASE_DRAIN_MS = 1140000;

export async function assertIssueLeaseMigrationReady() {
  let state;
  try {
    state = await kvs.get(ISSUE_LEASE_MIGRATION_KEY);
  } catch {
    throw leaseMigrationError();
  }
  if (state?.version !== 1 || state.phase !== 'entity-active'
      || state.legacyDisabled !== true || !Number.isSafeInteger(state.disabledAt)
      || !Number.isSafeInteger(state.activatedAt)
      || state.disabledAt < 0 || state.activatedAt < state.disabledAt + LEGACY_LEASE_DRAIN_MS
      || state.activatedAt > Date.now()) {
    throw leaseMigrationError();
  }
}

function leaseMigrationError() {
  const error = new Error('Issue lease migration is not verified; writes blocked');
  error.code = 'LEASE_MIGRATION_REQUIRED';
  return error;
}
