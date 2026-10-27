import {
  SprintSyncError,
  SPRINT_SYNC_MESSAGES,
  applySprintSync,
  getSprintSyncStatus,
  previewSprintSync,
  saveSprintMapping
} from '../services/sync/sprint-sync.js';
import { normalizeSnapshotOrgId } from '../services/sync/recovery-snapshot.js';
import logger from '../utils/logger.js';

function failureCode(error) {
  return typeof error?.code === 'string' && error.code.startsWith('SPRINT_SYNC_')
    ? error.code
    : 'SPRINT_SYNC_APPLY_FAILED';
}

function failure(error) {
  const code = failureCode(error);
  return {
    success: false,
    code,
    error: error instanceof SprintSyncError
      ? SPRINT_SYNC_MESSAGES[code] || error.message
      : SPRINT_SYNC_MESSAGES[code] || 'The sprint operation could not be completed.',
    details: error?.details || null
  };
}

/**
 * Sprint synchronization resolvers.
 *
 * Mapping verification and preview are read-only except for the verified
 * mapping record; preview never writes Jira. Apply is a paused, authorized,
 * digest-bound add-only operation. No resolver creates a sprint or removes an
 * issue from a sprint.
 */
export function defineSprintSyncResolvers(resolver) {
  resolver.define('getSprintSyncStatus', async ({ payload }) => {
    let orgId = null;
    try {
      orgId = normalizeSnapshotOrgId(payload?.orgId);
      return await getSprintSyncStatus({ orgId });
    } catch (error) {
      logger.warn('Sprint sync status failed', { code: failureCode(error), orgId });
      return failure(error);
    }
  });

  resolver.define('saveSprintMapping', async ({ payload }) => {
    let orgId = null;
    try {
      orgId = normalizeSnapshotOrgId(payload?.orgId);
      return await saveSprintMapping({
        orgId,
        localSprintId: payload?.localSprintId,
        remoteSprintId: payload?.remoteSprintId,
        confirmation: payload?.confirmation
      });
    } catch (error) {
      logger.warn('Sprint mapping verification failed', { code: failureCode(error), orgId });
      return failure(error);
    }
  });

  resolver.define('previewSprintSync', async ({ payload }) => {
    let orgId = null;
    try {
      orgId = normalizeSnapshotOrgId(payload?.orgId);
      return await previewSprintSync({
        orgId,
        localSprintId: payload?.localSprintId,
        remoteSprintId: payload?.remoteSprintId
      });
    } catch (error) {
      logger.warn('Sprint sync preview failed', { code: failureCode(error), orgId });
      return failure(error);
    }
  });

  resolver.define('applySprintSync', async ({ payload }) => {
    let orgId = null;
    try {
      orgId = normalizeSnapshotOrgId(payload?.orgId);
      return await applySprintSync({
        orgId,
        localSprintId: payload?.localSprintId,
        remoteSprintId: payload?.remoteSprintId,
        digest: payload?.digest,
        confirmation: payload?.confirmation
      });
    } catch (error) {
      logger.warn('Sprint sync apply failed', { code: failureCode(error), orgId });
      return failure(error);
    }
  });
}
