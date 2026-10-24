import * as kvsStore from '../services/storage/kvs.js';
import { getRemoteKey, getOrganizationsWithTokens } from '../services/storage/mappings.js';
import { getFullIssue } from '../services/jira/local-client.js';
import { createRemoteIssue, updateRemoteIssue } from '../services/sync/issue-sync.js';
import {
  previewInitialSync,
  startInitialSync,
  getInitialSyncStatus,
  pauseInitialSync,
  resumeInitialSync,
  cancelInitialSync
} from '../services/sync/initial-sync.js';
import { retryAllPendingLinks } from '../services/scheduled/scheduled-sync.js';
import { isProjectAllowedToSync } from '../utils/validation.js';

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
      const issueProjectKey = issue.fields.project.key;

      for (const org of orgsToSync) {
        const allowedProjects = Array.isArray(org.allowedProjects)
          ? org.allowedProjects.filter(Boolean)
          : [];

        if (allowedProjects.length === 0) {
          const message = 'No project filters selected for this organization';
          console.log(`⛔ ${org.id || 'organization'}: ${message}`);
          results.push({ org: org.name, success: false, error: message });
          continue;
        }

        const projectAllowed = await isProjectAllowedToSync(issueProjectKey, org);
        if (!projectAllowed) {
          const message = `Project ${issueProjectKey} not selected for sync`;
          console.log(`⏭️ ${org.id || 'organization'}: ${message}`);
          results.push({ org: org.name, success: false, error: message });
          continue;
        }
        // Fetch org-specific mappings
        const [userMappings, fieldMappings, statusMappings, issueTypeMappings, projectMappings, syncOptions] = await Promise.all([
          kvsStore.get(org.id === 'legacy' ? 'userMappings' : `userMappings:${org.id}`),
          kvsStore.get(org.id === 'legacy' ? 'fieldMappings' : `fieldMappings:${org.id}`),
          kvsStore.get(org.id === 'legacy' ? 'statusMappings' : `statusMappings:${org.id}`),
          kvsStore.get(org.id === 'legacy' ? 'issueTypeMappings' : `issueTypeMappings:${org.id}`),
          kvsStore.get(org.id === 'legacy' ? 'projectMappings' : `projectMappings:${org.id}`),
          kvsStore.get(org.id === 'legacy' ? 'syncOptions' : `syncOptions:${org.id}`)
        ]);

        const mappings = {
          userMappings: userMappings || {},
          fieldMappings: fieldMappings || {},
          statusMappings: statusMappings || {},
          issueTypeMappings: issueTypeMappings || {},
          projectMappings: projectMappings || {}
        };

        const existingRemoteKey = await getRemoteKey(issueKey, org.id === 'legacy' ? null : org.id);

        try {
          if (existingRemoteKey) {
            console.log(`🔄 Force UPDATE for ${org.id || 'organization'}: ${issueKey} → ${existingRemoteKey}`);
            const updateResult = await updateRemoteIssue(issueKey, existingRemoteKey, issue, org, mappings, null, syncOptions);
            if (!updateResult || (updateResult.skipped && updateResult.status !== 'ALREADY_CURRENT')) {
              results.push({ org: org.name, success: false, error: updateResult?.status || 'Remote issue update failed' });
              continue;
            }
            results.push({ org: org.name, success: true, message: `Updated ${issueKey} → ${existingRemoteKey}` });
          } else {
            console.log(`✨ Force CREATE for ${org.id || 'organization'}: ${issueKey}`);
            const createResult = await createRemoteIssue(issue, org, mappings, null, syncOptions);
            const remoteKey = createResult?.key || createResult;
            if (remoteKey) {
              results.push({ org: org.name, success: true, message: `Created ${issueKey} → ${remoteKey}` });
            } else {
              results.push({ org: org.name, success: false, error: 'Failed to create remote issue' });
            }
          }
        } catch (orgError) {
          console.error(`Error syncing to ${org.id || 'organization'}:`, orgError);
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
      const organizations = await getOrganizationsWithTokens();

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


  // Safe initial-sync orchestration. Preview is read-only; start requires an
  // explicit approval bound to the previewed configuration and checksum.
  resolver.define('previewInitialSync', async ({ payload }) => {
    return await previewInitialSync({ orgId: payload?.orgId });
  });

  resolver.define('startInitialSync', async ({ payload, context }) => {
    return await startInitialSync({
      orgId: payload?.orgId,
      approved: payload?.approved === true,
      previewChecksum: payload?.previewChecksum,
      configurationChecksum: payload?.configurationChecksum,
      startedBy: context?.accountId || null
    });
  });

  resolver.define('getInitialSyncStatus', async ({ payload }) => {
    return await getInitialSyncStatus({ orgId: payload?.orgId });
  });

  resolver.define('pauseInitialSync', async ({ payload }) => {
    return await pauseInitialSync({ orgId: payload?.orgId });
  });

  resolver.define('resumeInitialSync', async ({ payload }) => {
    return await resumeInitialSync({ orgId: payload?.orgId });
  });

  resolver.define('cancelInitialSync', async ({ payload }) => {
    return await cancelInitialSync({ orgId: payload?.orgId });
  });


  // Bulk scan/recreate is intentionally disabled for corporate pilot safety.
  // This resolver queues no work and performs zero Jira writes. The name is
  // retained for compatibility so existing callers receive a clear, structured
  // error instead of silently doing nothing.
  resolver.define('scanForDeletedIssues', async () => ({
    success: false,
    code: 'BULK_SCAN_RECREATE_DISABLED',
    error: 'Bulk scan/recreate is disabled pending the safe bulk-sync redesign.',
    message: 'No issues were scanned, queued, created, updated, transitioned, or deleted.'
  }));

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

  // Manual scheduled-sync triggers are intentionally disabled. Recurring
  // reconciliation is scheduled by the existing hourly recovery heartbeat.
  resolver.define('triggerScheduledSync', async () => {
    return {
      success: false,
      code: 'SCHEDULED_SYNC_MANUAL_TRIGGER_DISABLED',
      error: 'Manual scheduled sync is disabled. Recurring reconciliation runs from the hourly recovery heartbeat when enabled.'
    };
  });
}

