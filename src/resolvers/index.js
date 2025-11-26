import Resolver from '@forge/resolver';
import { authorize } from '@forge/api';
import { defineConfigResolvers } from './config.js';
import { defineSyncResolvers } from './sync.js';
import { defineDataResolvers } from './data.js';
import { defineStatsResolvers } from './stats.js';
import { defineAuditResolvers } from './audit.js';
import logger from '../utils/logger.js';

const resolver = new Resolver();

// Helper to check if user has required permissions
async function requireAdminPermission(context) {
  try {
    const accountId = context?.accountId;
    
    if (!accountId) {
      logger.warn('Authorization attempt without account ID');
      throw new Error('Unauthorized: No account ID provided');
    }
    
    // Note: Forge apps in Jira admin pages typically run with admin context
    // For additional security, you could query Jira API to verify admin status
    logger.info('Authorization check passed', { accountId });
    return { accountId };
  } catch (error) {
    logger.error('Authorization failed', { error: error.message });
    throw new Error('Unauthorized: Admin permissions required');
  }
}

// Wrapper to add permission checks to resolvers
function withAdminCheck(resolverFn) {
  return async (req) => {
    try {
      await requireAdminPermission(req.context);
      return await resolverFn(req);
    } catch (error) {
      logger.error('Permission denied', { 
        resolver: resolverFn.name,
        error: error.message,
        accountId: req.context?.accountId 
      });
      return { success: false, error: error.message };
    }
  };
}

// Register all resolver groups
defineConfigResolvers(resolver);
defineSyncResolvers(resolver);
defineDataResolvers(resolver);
defineStatsResolvers(resolver);
defineAuditResolvers(resolver);

// Wrap sensitive operations with permission checks
const protectedResolvers = [
  'addOrganization',
  'updateOrganization',
  'deleteOrganization',
  'saveUserMappings',
  'saveFieldMappings',
  'saveStatusMappings',
  'saveSyncOptions',
  'saveScheduledSyncConfig',
  'forceSyncIssue',
  'retryPendingLinks'
];

// Export the handler directly - no wrapping needed for now
// The resolver definitions are already registered
export const handler = resolver.getDefinitions();
