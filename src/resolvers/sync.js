import { storage } from '@forge/api';
import { getRemoteKey } from '../services/storage/mappings.js';
import { getFullIssue } from '../services/jira/local-client.js';
import { createRemoteIssue, updateRemoteIssue, syncIssue } from '../services/sync/issue-sync.js';
import { retryAllPendingLinks } from '../services/scheduled/scheduled-sync.js';

export function defineSyncResolvers(resolver) {
  resolver.define('forceSyncIssue', async ({ payload }) => {
    try {
      const { issueKey } = payload;
      
      if (!issueKey) {
        throw new Error('Issue key is required');
      }
      
      console.log(`🔄 Manual sync requested for: ${issueKey}`);
      
      const config = await storage.get('syncConfig');
      if (!config || !config.remoteUrl) {
        throw new Error('Sync not configured');
      }
      
      const issue = await getFullIssue(issueKey);
      if (!issue) {
        throw new Error('Could not fetch issue data');
      }
      
      const [userMappings, fieldMappings, statusMappings] = await Promise.all([
        storage.get('userMappings'),
        storage.get('fieldMappings'),
        storage.get('statusMappings')
      ]);
      
      const mappings = {
        userMappings: userMappings || {},
        fieldMappings: fieldMappings || {},
        statusMappings: statusMappings || {}
      };
      
      const existingRemoteKey = await getRemoteKey(issueKey);
      
      if (existingRemoteKey) {
        console.log(`🔄 Force UPDATE: ${issueKey} → ${existingRemoteKey}`);
        await updateRemoteIssue(issueKey, existingRemoteKey, issue, config, mappings);
        return { success: true, message: `Synced ${issueKey} to ${existingRemoteKey}` };
      } else {
        console.log(`✨ Force CREATE: ${issueKey}`);
        const remoteKey = await createRemoteIssue(issue, config, mappings);
        if (remoteKey) {
          return { success: true, message: `Created ${issueKey} as ${remoteKey}` };
        } else {
          throw new Error('Failed to create remote issue');
        }
      }
    } catch (error) {
      console.error('Force sync error:', error);
      return { success: false, error: error.message };
    }
  });

  // New resolver to retry pending links manually
  resolver.define('retryPendingLinks', async () => {
    try {
      console.log('🔄 Manual retry of pending links requested');
      
      // Get all organizations
      const organizations = await storage.get('organizations') || [];
      
      // Legacy support
      const legacyConfig = await storage.get('syncConfig');
      if (legacyConfig && legacyConfig.remoteUrl && organizations.length === 0) {
        organizations.push({
          id: 'legacy',
          name: 'Legacy Organization',
          ...legacyConfig
        });
      }

      if (organizations.length === 0) {
        return { success: false, error: 'No organizations configured' };
      }

      let totalResults = {
        retried: 0,
        success: 0,
        failed: 0,
        stillPending: 0
      };

      // Retry pending links for each organization
      for (const org of organizations) {
        const [userMappings, fieldMappings, statusMappings] = await Promise.all([
          storage.get(org.id === 'legacy' ? 'userMappings' : `userMappings:${org.id}`),
          storage.get(org.id === 'legacy' ? 'fieldMappings' : `fieldMappings:${org.id}`),
          storage.get(org.id === 'legacy' ? 'statusMappings' : `statusMappings:${org.id}`)
        ]);

        const mappings = {
          userMappings: userMappings || {},
          fieldMappings: fieldMappings || {},
          statusMappings: statusMappings || {}
        };

        const results = await retryAllPendingLinks(org, mappings);
        
        totalResults.retried += results.retried;
        totalResults.success += results.success;
        totalResults.failed += results.failed;
        totalResults.stillPending += results.stillPending;
      }

      return { 
        success: true, 
        message: `Retried ${totalResults.retried} pending links: ${totalResults.success} synced, ${totalResults.stillPending} still pending, ${totalResults.failed} failed`,
        results: totalResults
      };
    } catch (error) {
      console.error('Error retrying pending links:', error);
      return { success: false, error: error.message };
    }
  });
}
