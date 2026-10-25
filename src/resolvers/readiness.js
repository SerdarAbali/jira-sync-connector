import { buildConnectorReadiness } from '../services/readiness/connector-readiness.js';
import logger from '../utils/logger.js';

/**
 * Read-only, installation-scoped readiness. The authorization wrapper enforces
 * ADMIN_READ and the Jira administrator check before this runs.
 */
export function defineReadinessResolvers(resolver) {
  resolver.define('getConnectorReadiness', async () => {
    try {
      return await buildConnectorReadiness();
    } catch (error) {
      logger.warn('Connector readiness failed', {
        code: typeof error?.code === 'string' ? error.code : 'unknown'
      });
      return {
        success: false,
        status: 'unavailable',
        code: 'READINESS_UNAVAILABLE',
        error: 'Connector readiness could not be read.'
      };
    }
  });
}
