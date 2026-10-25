import {
  buildRecoverySnapshot,
  normalizeSnapshotOrgId,
  RecoverySnapshotError,
  snapshotErrorMessage
} from '../services/sync/recovery-snapshot.js';
import logger from '../utils/logger.js';

function snapshotFailureCode(error) {
  return error instanceof RecoverySnapshotError
    ? error.code
    : 'SNAPSHOT_EXPORT_FAILED';
}

/**
 * Read-only export of one organization's issue-pair mappings and issue-create
 * ledger. The authorization wrapper enforces ADMIN_READ and the Jira
 * administrator check before this runs. The export writes nothing: neither to
 * Jira, nor to Forge storage, nor to the pause state.
 */
export function defineRecoverySnapshotResolvers(resolver) {
  resolver.define('exportRecoverySnapshot', async ({ payload }) => {
    let orgId = null;
    try {
      orgId = normalizeSnapshotOrgId(payload?.orgId);
      return await buildRecoverySnapshot({ orgId });
    } catch (error) {
      const code = snapshotFailureCode(error);
      logger.warn('Recovery snapshot export failed', { code, orgId });
      return {
        success: false,
        code,
        error: snapshotErrorMessage(code)
      };
    }
  });
}
