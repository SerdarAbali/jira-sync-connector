/**
 * Explicit server-side authorization policy for every resolver registered by
 * the Forge app.
 *
 * This is intentionally an explicit inventory, not a naming-convention
 * allowlist. A resolver with no entry here is denied by default.
 */

export const POLICY_CATEGORIES = Object.freeze([
  'ADMIN_READ',
  'ADMIN_WRITE',
  'DESTRUCTIVE',
  'SAFE_DISABLED'
]);

export const RESOLVER_POLICIES = Object.freeze({
  // Configuration and connector administration (config.js)
  getOrganizations: 'ADMIN_READ',
  addOrganization: 'ADMIN_WRITE',
  updateOrganization: 'ADMIN_WRITE',
  replaceOrganizationToken: 'ADMIN_WRITE',
  rotateWebhookSecret: 'ADMIN_WRITE',
  deleteOrganization: 'DESTRUCTIVE',
  getConfig: 'ADMIN_READ',
  saveConfig: 'ADMIN_WRITE',
  getUserMappings: 'ADMIN_READ',
  saveUserMappings: 'ADMIN_WRITE',
  getFieldMappings: 'ADMIN_READ',
  saveFieldMappings: 'ADMIN_WRITE',
  getStatusMappings: 'ADMIN_READ',
  saveStatusMappings: 'ADMIN_WRITE',
  getIssueTypeMappings: 'ADMIN_READ',
  saveIssueTypeMappings: 'ADMIN_WRITE',
  getProjectMappings: 'ADMIN_READ',
  saveProjectMappings: 'ADMIN_WRITE',
  getScheduledSyncConfig: 'ADMIN_READ',
  saveScheduledSyncConfig: 'ADMIN_WRITE',
  getSyncOptions: 'ADMIN_READ',
  saveSyncOptions: 'ADMIN_WRITE',
  exportOrgSettings: 'ADMIN_READ',
  importOrgSettings: 'ADMIN_WRITE',
  checkStorage: 'ADMIN_READ',
  migrateLegacyConfig: 'ADMIN_WRITE',
  testConnection: 'ADMIN_WRITE',
  getLastSyncTime: 'ADMIN_READ',
  getPilotStatus: 'ADMIN_READ',
  pausePilot: 'ADMIN_WRITE',
  resumePilot: 'ADMIN_WRITE',
  setupWizard: 'ADMIN_WRITE',

  // Synchronization and bulk controls (sync.js)
  forceSyncIssue: 'DESTRUCTIVE',
  retryPendingLinks: 'DESTRUCTIVE',
  scanForDeletedIssues: 'SAFE_DISABLED',
  previewInitialSync: 'ADMIN_READ',
  startInitialSync: 'ADMIN_WRITE',
  getInitialSyncStatus: 'ADMIN_READ',
  pauseInitialSync: 'ADMIN_WRITE',
  resumeInitialSync: 'ADMIN_WRITE',
  cancelInitialSync: 'ADMIN_WRITE',
  getBulkSyncStatus: 'ADMIN_READ',
  cancelBulkSync: 'DESTRUCTIVE',
  triggerScheduledSync: 'DESTRUCTIVE',

  // Data import/export and mapping helpers (data.js)
  fetchLocalProjects: 'ADMIN_READ',
  getRejectedFields: 'ADMIN_READ',
  clearRejectedField: 'DESTRUCTIVE',
  fetchLocalData: 'ADMIN_READ',
  fetchRemoteData: 'ADMIN_READ',
  exportIssues: 'ADMIN_READ',
  importIssues: 'DESTRUCTIVE',
  reconcileIssueCreate: 'ADMIN_WRITE',
  getIssueCreateOperationStatus: 'ADMIN_READ',
  reconcileAttachment: 'ADMIN_WRITE',
  autoMatchMappings: 'ADMIN_READ',
  checkIssueMapping: 'ADMIN_READ',

  // Statistics and log administration (stats.js, audit.js)
  getScheduledSyncStats: 'ADMIN_READ',
  getWebhookSyncStats: 'ADMIN_READ',
  getApiUsageStats: 'ADMIN_READ',
  resetApiUsageStats: 'DESTRUCTIVE',
  clearWebhookErrors: 'DESTRUCTIVE',
  clearScheduledErrors: 'DESTRUCTIVE',
  getAuditLog: 'ADMIN_READ',
  clearAuditLog: 'DESTRUCTIVE',

  // Read-only diagnostics and disabled Batch 1 operations (diagnostics.js)
  runHealthCheck: 'ADMIN_READ',
  verifyIssueSync: 'ADMIN_READ',
  runSystemTest: 'SAFE_DISABLED',

  // Deleted-counterpart recovery (recovery.js)
  getDeletedCounterparts: 'ADMIN_READ',
  probeDeletedCounterpart: 'ADMIN_READ',
  remapDeletedCounterpart: 'ADMIN_WRITE',
  replaceDeletedCounterpart: 'DESTRUCTIVE',
  endDeletedCounterpartSync: 'DESTRUCTIVE',
  dismissDeletedCounterpart: 'ADMIN_WRITE',

  // Recurring local-to-remote source reconciliation (reconciliation.js)
  getRecurringReconciliationStatus: 'ADMIN_READ',
  saveRecurringReconciliationSettings: 'ADMIN_WRITE',
  getRecurringReconciliationAttention: 'ADMIN_READ',
  acknowledgeRecurringReconciliationAttention: 'ADMIN_WRITE',
  resolveRecurringReconciliationAttention: 'ADMIN_WRITE',

  // Installation readiness and the separately gated F07 migration control.
  // Readiness never returns credentials; activation is refused by automated
  // E2E tooling and never exposed as a read or a default action.
  getConnectorReadiness: 'ADMIN_READ',
  activateIssueLeaseMigration: 'ADMIN_WRITE',
  initializeFreshIssueLeases: 'ADMIN_WRITE',

  // Read-only, downloadable recovery snapshot of one organization's mappings
  // and issue-create ledger (recovery-snapshot.js). It writes nothing, in Jira
  // or in Forge storage, and requires the emergency pause to be in force.
  exportRecoverySnapshot: 'ADMIN_READ',

  // Read-only, upload-and-compare restore preview for one organization's
  // snapshot file. It classifies pairs and ledger rows against current storage
  // and writes nothing: no mapping, ledger row, manifest or restore plan.
  previewRecoverySnapshot: 'ADMIN_READ',

  // Installation-wide synchronization authorization. Reading the state is
  // read-only; granting it is an explicit ADMIN_WRITE that writes one storage
  // record and performs no Jira request of any kind.
  getSyncAuthorizationStatus: 'ADMIN_READ',
  authorizeSynchronization: 'ADMIN_WRITE',

  // Read-only pairing-witness migration preview. It reads mapping metadata,
  // both directions, the create ledger and the issue property on both Jira
  // sites, and writes nothing anywhere.
  previewPairWitnessMigration: 'ADMIN_READ',

  // Pairing-witness migration. Planning only recomputes the plan and writes
  // nothing. Approval writes the plan and one short-lived maintenance permit.
  // A batch writes only the sync-connector-pair property on approved issues.
  // Cancellation revokes the permit and never touches a Jira property.
  planPairWitnessMigration: 'ADMIN_READ',
  getPairWitnessMigrationStatus: 'ADMIN_READ',
  approvePairWitnessMigration: 'ADMIN_WRITE',
  applyPairWitnessMigration: 'ADMIN_WRITE',
  cancelPairWitnessMigration: 'ADMIN_WRITE'
});

export function getResolverPolicy(resolverName) {
  if (typeof resolverName !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(RESOLVER_POLICIES, resolverName)) {
    return null;
  }
  return RESOLVER_POLICIES[resolverName];
}

export function isAuditedPolicy(policy) {
  return policy === 'ADMIN_WRITE' || policy === 'DESTRUCTIVE';
}
