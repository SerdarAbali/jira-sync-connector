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

  // Synchronization and bulk controls (sync.js)
  forceSyncIssue: 'DESTRUCTIVE',
  retryPendingLinks: 'DESTRUCTIVE',
  scanForDeletedIssues: 'SAFE_DISABLED',
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
  runSystemTest: 'SAFE_DISABLED'
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
