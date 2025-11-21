import { storage } from '@forge/api';
import { getRemoteKey } from '../services/storage/mappings.js';
import { getFullIssue } from '../services/jira/local-client.js';
import { createRemoteIssue, updateRemoteIssue } from '../services/sync/issue-sync.js';

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
}
