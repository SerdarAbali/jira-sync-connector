import { activateIssueLeaseMigration } from '../services/sync/lease-migration-activation.js';
import logger from '../utils/logger.js';
import { initializeFreshIssueLeases } from '../services/sync/fresh-install-initialization.js';

/**
 * Guarded F07 activation entry point. ADMIN_WRITE, the Jira administrator check
 * and the audit record are enforced by the authorization wrapper; this resolver
 * only delegates the safety decision.
 */
export function defineLeaseMigrationResolvers(resolver) {
  resolver.define('initializeFreshIssueLeases', async ({ payload }) => {
    return initializeFreshIssueLeases({ payload });
  });
  resolver.define('activateIssueLeaseMigration', async ({ payload }) => {
    try {
      return await activateIssueLeaseMigration({ payload });
    } catch (error) {
      logger.warn('Issue lease activation failed closed', {
        code: typeof error?.code === 'string' ? error.code : 'unknown'
      });
      return {
        success: false,
        status: 'FAILED',
        code: 'ACTIVATION_FAILED',
        error: 'Activation failed closed.',
        activation: { performed: false, wroteMigrationState: false }
      };
    }
  });
}
