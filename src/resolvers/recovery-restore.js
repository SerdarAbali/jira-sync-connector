import {
  RecoveryRestoreError,
  RECOVERY_RESTORE_MESSAGES,
  applyRecoveryRestore,
  approveRecoveryRestore,
  cancelRecoveryRestore,
  getRecoveryRestoreStatus,
  planRecoveryRestore,
  previewRecoveryRestore
} from '../services/sync/recovery-restore.js';
import { normalizeSnapshotOrgId } from '../services/sync/recovery-snapshot.js';
import { previewErrorMessage } from '../services/sync/recovery-snapshot-preview.js';
import logger from '../utils/logger.js';

function failureCode(error) {
  if (typeof error?.code === 'string'
    && (error.code.startsWith('RECOVERY_RESTORE_') || error.code.startsWith('SNAPSHOT_'))) {
    return error.code;
  }
  return 'RECOVERY_RESTORE_APPLY_FAILED';
}

function failureMessage(error, code) {
  if (error instanceof RecoveryRestoreError) {
    return RECOVERY_RESTORE_MESSAGES[code] || error.message;
  }
  if (typeof error?.code === 'string' && error.code.startsWith('SNAPSHOT_')) {
    return previewErrorMessage(error.code);
  }
  return RECOVERY_RESTORE_MESSAGES[code]
    || 'The recovery restore operation could not be completed.';
}

/**
 * Resolvers for the controlled recovery workflow.
 *
 * Preview is ADMIN_READ and writes nothing. Planning, approval, batches and
 * cancellation are ADMIN_WRITE; approval also requires the exact digest-bound
 * phrase. No resolver can create, update or delete a Jira issue, resume
 * synchronization or restore authorization automatically.
 */
export function defineRecoveryRestoreResolvers(resolver) {
  resolver.define('previewRecoveryRestore', async ({ payload }) => {
    let orgId = null;
    try {
      orgId = normalizeSnapshotOrgId(payload?.orgId);
      return await previewRecoveryRestore({
        orgId,
        content: payload?.content,
        pairs: payload?.pairs
      });
    } catch (error) {
      const code = failureCode(error);
      logger.warn('Recovery restore preview failed', { code, orgId });
      return {
        success: false,
        readOnly: true,
        code,
        error: failureMessage(error, code),
        details: error?.details || null
      };
    }
  });

  resolver.define('planRecoveryRestore', async ({ payload, context }) => {
    let orgId = null;
    try {
      orgId = normalizeSnapshotOrgId(payload?.orgId);
      return await planRecoveryRestore({
        orgId,
        content: payload?.content,
        pairs: payload?.pairs,
        accountId: typeof context?.accountId === 'string' ? context.accountId : null
      });
    } catch (error) {
      const code = failureCode(error);
      logger.warn('Recovery restore planning failed', { code, orgId });
      return {
        success: false,
        code,
        error: failureMessage(error, code),
        details: error?.details || null
      };
    }
  });

  resolver.define('approveRecoveryRestore', async ({ payload, context }) => {
    let orgId = null;
    try {
      orgId = normalizeSnapshotOrgId(payload?.orgId);
      return await approveRecoveryRestore({
        orgId,
        digest: payload?.digest,
        confirmation: payload?.confirmation,
        accountId: typeof context?.accountId === 'string' ? context.accountId : null
      });
    } catch (error) {
      const code = failureCode(error);
      logger.warn('Recovery restore approval failed', { code, orgId });
      return {
        success: false,
        code,
        error: failureMessage(error, code),
        details: error?.details || null
      };
    }
  });

  resolver.define('applyRecoveryRestore', async ({ payload, context }) => {
    let orgId = null;
    try {
      orgId = normalizeSnapshotOrgId(payload?.orgId);
      return await applyRecoveryRestore({
        orgId,
        digest: payload?.digest,
        batchSize: payload?.batchSize,
        accountId: typeof context?.accountId === 'string' ? context.accountId : null
      });
    } catch (error) {
      const code = failureCode(error);
      logger.warn('Recovery restore batch failed', { code, orgId });
      return {
        success: false,
        code,
        error: failureMessage(error, code),
        details: error?.details || null
      };
    }
  });

  resolver.define('cancelRecoveryRestore', async ({ payload, context }) => {
    let orgId = null;
    try {
      orgId = normalizeSnapshotOrgId(payload?.orgId);
      return await cancelRecoveryRestore({
        orgId,
        accountId: typeof context?.accountId === 'string' ? context.accountId : null
      });
    } catch (error) {
      const code = failureCode(error);
      logger.warn('Recovery restore cancellation failed', { code, orgId });
      return {
        success: false,
        code,
        error: failureMessage(error, code),
        details: error?.details || null
      };
    }
  });

  resolver.define('getRecoveryRestoreStatus', async ({ payload }) => {
    let orgId = null;
    try {
      orgId = normalizeSnapshotOrgId(payload?.orgId);
      return await getRecoveryRestoreStatus({ orgId });
    } catch (error) {
      const code = failureCode(error);
      logger.warn('Recovery restore status failed', { code, orgId });
      return {
        success: false,
        code,
        error: failureMessage(error, code)
      };
    }
  });
}
