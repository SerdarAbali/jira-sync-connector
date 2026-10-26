import {
  authorizeSynchronization,
  readSyncAuthorizationStatus,
  SYNC_AUTHORIZATION_MESSAGES,
  SYNC_AUTHORIZATION_REASONS,
  syncAuthorizationConfirmation,
  SyncAuthorizationError
} from '../services/sync/sync-authorization.js';
import logger from '../utils/logger.js';

function failureCode(error) {
  return error instanceof SyncAuthorizationError
    ? error.code
    : SYNC_AUTHORIZATION_REASONS.UNREADABLE;
}

function fixedMessage(code) {
  return SYNC_AUTHORIZATION_MESSAGES[code]
    || SYNC_AUTHORIZATION_MESSAGES[SYNC_AUTHORIZATION_REASONS.UNREADABLE];
}

/**
 * Read-only authorization status and the exact confirmation phrase.
 *
 * The authorization wrapper enforces ADMIN_READ and the Jira administrator
 * permission before this runs. Nothing is written and no Jira request is made.
 */
export function defineSyncAuthorizationResolvers(resolver) {
  resolver.define('getSyncAuthorizationStatus', async () => {
    try {
      const status = await readSyncAuthorizationStatus();
      const record = status.record;
      return {
        success: true,
        authorized: status.authorized,
        state: status.state || (record ? record.state : 'missing'),
        reason: status.reason,
        message: status.message,
        installationId: status.currentIdentity?.installationId || null,
        environmentId: status.currentIdentity?.environmentId || null,
        authorizedAt: record?.authorizedAt || null,
        authorizedBy: record?.authorizedBy || null,
        basis: record?.basis || null,
        authorizedOrganizationIds: record?.organizationIds || [],
        configuredOrganizationIds: status.configuredOrganizationIds,
        uncoveredOrganizationIds: status.uncoveredOrganizationIds,
        organizationSetDelta: status.organizationSetDelta || { added: [], removed: [] },
        confirmationPhrase: status.currentIdentity
          ? syncAuthorizationConfirmation({
            installationId: status.currentIdentity.installationId,
            organizationIds: status.configuredOrganizationIds
          })
          : null
      };
    } catch (error) {
      const code = failureCode(error);
      logger.warn('Synchronization authorization status failed', { code });
      return { success: false, code, error: fixedMessage(code) };
    }
  });

  /**
   * Controlled, auditable authorization for an established installation.
   *
   * ADMIN_WRITE plus an exact confirmation phrase. It writes one storage record
   * and performs no Jira request, so authorizing can never mutate an issue.
   */
  resolver.define('authorizeSynchronization', async ({ payload, context }) => {
    try {
      return await authorizeSynchronization({
        confirmation: payload?.confirmation,
        accountId: typeof context?.accountId === 'string' ? context.accountId : null,
        basis: 'established'
      });
    } catch (error) {
      const code = failureCode(error);
      logger.warn('Synchronization authorization failed', { code });
      return { success: false, code, error: fixedMessage(code) };
    }
  });
}
