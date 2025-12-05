import api, { route, fetch } from '@forge/api';
import { Queue } from '@forge/events';
import * as kvsStore from '../services/storage/kvs.js';
import { getRemoteKey, getOrganizationsWithTokens, storeMapping } from '../services/storage/mappings.js';
import { getFullIssue } from '../services/jira/local-client.js';
import { createRemoteIssue, updateRemoteIssue } from '../services/sync/issue-sync.js';
import { retryAllPendingLinks } from '../services/scheduled/scheduled-sync.js';

export function defineSyncResolvers(resolver) {
  resolver.define('forceSyncIssue', async ({ payload }) => {
    try {
      const { issueKey, orgId } = payload;
      
      if (!issueKey) {
        throw new Error('Issue key is required');
      }
      
      console.log(`🔄 Manual sync requested for: ${issueKey}`);
      
      // Get organizations with tokens
      const organizations = await getOrganizationsWithTokens();
      
      // Legacy support
      const legacyConfig = await kvsStore.get('syncConfig');
      if (legacyConfig && legacyConfig.remoteUrl && organizations.length === 0) {
        organizations.push({
          id: 'legacy',
          name: 'Legacy Organization',
          ...legacyConfig
        });
      }
      
      if (organizations.length === 0) {
        throw new Error('No organizations configured');
      }
      
      // If orgId specified, sync to that org only; otherwise sync to all
      const orgsToSync = orgId 
        ? organizations.filter(o => o.id === orgId)
        : organizations;
      
      if (orgsToSync.length === 0) {
        throw new Error('Organization not found');
      }
      
      const issue = await getFullIssue(issueKey);
      if (!issue) {
        throw new Error('Could not fetch issue data');
      }
      
      const results = [];
      
      for (const org of orgsToSync) {
        // Fetch org-specific mappings
        const [userMappings, fieldMappings, statusMappings, issueTypeMappings, syncOptions] = await Promise.all([
          kvsStore.get(org.id === 'legacy' ? 'userMappings' : `userMappings:${org.id}`),
          kvsStore.get(org.id === 'legacy' ? 'fieldMappings' : `fieldMappings:${org.id}`),
          kvsStore.get(org.id === 'legacy' ? 'statusMappings' : `statusMappings:${org.id}`),
          kvsStore.get(org.id === 'legacy' ? 'issueTypeMappings' : `issueTypeMappings:${org.id}`),
          kvsStore.get(org.id === 'legacy' ? 'syncOptions' : `syncOptions:${org.id}`)
        ]);
        
        const mappings = {
          userMappings: userMappings || {},
          fieldMappings: fieldMappings || {},
          statusMappings: statusMappings || {},
          issueTypeMappings: issueTypeMappings || {}
        };
        
        const existingRemoteKey = await getRemoteKey(issueKey, org.id === 'legacy' ? null : org.id);
        
        try {
          if (existingRemoteKey) {
            console.log(`🔄 Force UPDATE for ${org.name}: ${issueKey} → ${existingRemoteKey}`);
            await updateRemoteIssue(issueKey, existingRemoteKey, issue, org, mappings, null, syncOptions);
            results.push({ org: org.name, success: true, message: `Updated ${issueKey} → ${existingRemoteKey}` });
          } else {
            console.log(`✨ Force CREATE for ${org.name}: ${issueKey}`);
            const createResult = await createRemoteIssue(issue, org, mappings, null, syncOptions);
            const remoteKey = createResult?.key || createResult;
            if (remoteKey) {
              results.push({ org: org.name, success: true, message: `Created ${issueKey} → ${remoteKey}` });
            } else {
              results.push({ org: org.name, success: false, error: 'Failed to create remote issue' });
            }
          }
        } catch (orgError) {
          console.error(`Error syncing to ${org.name}:`, orgError);
          results.push({ org: org.name, success: false, error: orgError.message });
        }
      }
      
      const successCount = results.filter(r => r.success).length;
      const messages = results.map(r => r.success ? r.message : `${r.org}: ${r.error}`);
      
      return { 
        success: successCount > 0, 
        message: messages.join('; '),
        results 
      };
    } catch (error) {
      console.error('Force sync error:', error);
      return { success: false, error: error.message };
    }
  });

  // New resolver to retry pending links manually
  resolver.define('retryPendingLinks', async () => {
    try {
      console.log('🔄 Manual retry of pending links requested');
      
      // Get all organizations with their API tokens from secure storage
      let organizations = await getOrganizationsWithTokens();
      
      // Legacy support
      const legacyConfig = await kvsStore.get('syncConfig');
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
          kvsStore.get(org.id === 'legacy' ? 'userMappings' : `userMappings:${org.id}`),
          kvsStore.get(org.id === 'legacy' ? 'fieldMappings' : `fieldMappings:${org.id}`),
          kvsStore.get(org.id === 'legacy' ? 'statusMappings' : `statusMappings:${org.id}`)
        ]);

        const mappings = {
          userMappings: userMappings || {},
          fieldMappings: fieldMappings || {},
          statusMappings: statusMappings || {}
        };

        const results = await retryAllPendingLinks(org, mappings, null);
        
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


  // Resolver to trigger bulk sync via async queue (900 second timeout)
  // This handles: 1) Never synced issues, 2) Deleted remote issues, 3) Missing attachments/links/comments
  resolver.define('scanForDeletedIssues', async ({ payload }) => {
    try {
      const { orgId, syncMissingData = false, updateExisting = false, force = false } = payload || {};
      console.log(`🚀 Triggering bulk sync (org: ${orgId || 'all'}, syncMissingData: ${syncMissingData}, updateExisting: ${updateExisting}, force: ${force})...`);

      // Check if sync is already in progress (skip if force=true)
      const currentStatus = await kvsStore.get('bulkSyncStatus');
      if (!force && currentStatus && currentStatus.status === 'running') {
        const startedAt = new Date(currentStatus.timestamp);
        const elapsed = Date.now() - startedAt.getTime();
        // If it's been running for less than 15 minutes, consider it still active
        if (elapsed < 15 * 60 * 1000) {
          return {
            success: false,
            error: 'Bulk sync is already in progress. Please wait for it to complete, or use the Cancel button to stop it.',
            status: currentStatus,
            elapsedMs: elapsed
          };
        }
      }

      // Mark sync as starting
      await kvsStore.set('bulkSyncStatus', {
        status: 'running',
        timestamp: new Date().toISOString(),
        orgId: orgId || 'all',
        syncMissingData,
        updateExisting
      });

      // Push to async queue for background processing with 900s timeout
      const queue = new Queue({ key: 'bulk-sync-queue' });
      const { jobId } = await queue.push({
        body: {
          orgId,
          syncMissingData,
          updateExisting
        }
      });

      console.log(`✅ Bulk sync job queued: ${jobId}`);

      return {
        success: true,
        message: 'Bulk sync started in background. This may take several minutes for large projects. Check back for status.',
        jobId,
        status: 'running'
      };

    } catch (error) {
      console.error('Error starting bulk sync:', error);
      await kvsStore.set('bulkSyncStatus', {
        status: 'error',
        timestamp: new Date().toISOString(),
        error: error.message
      });
      return { success: false, error: error.message };
    }
  });

  // New resolver to check bulk sync status
  resolver.define('getBulkSyncStatus', async () => {
    try {
      const status = await kvsStore.get('bulkSyncStatus');
      return { success: true, status: status || { status: 'idle' } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Resolver to cancel/reset bulk sync status
  resolver.define('cancelBulkSync', async () => {
    try {
      const currentStatus = await kvsStore.get('bulkSyncStatus');
      
      // Mark as cancelled
      await kvsStore.set('bulkSyncStatus', {
        status: 'cancelled',
        timestamp: new Date().toISOString(),
        previousStatus: currentStatus
      });
      
      console.log('🛑 Bulk sync cancelled by user');
      
      return { 
        success: true, 
        message: 'Bulk sync cancelled. Note: Any currently processing issue will complete, but no new issues will be started.',
        previousStatus: currentStatus
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Resolver to manually trigger scheduled sync (for testing)
  resolver.define('triggerScheduledSync', async () => {
    try {
      console.log('🔄 Manual trigger of scheduled sync requested');
      const { performScheduledSync } = await import('../services/scheduled/scheduled-sync.js');
      const stats = await performScheduledSync();
      console.log('✅ Manual scheduled sync completed:', stats);
      return { success: true, stats };
    } catch (error) {
      console.error('❌ Manual scheduled sync failed:', error);
      return { success: false, error: error.message };
    }
  });
}

