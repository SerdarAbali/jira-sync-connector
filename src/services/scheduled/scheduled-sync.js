import api, { route, storage, fetch } from '@forge/api';
import { LOG_EMOJI, SCHEDULED_SYNC_DELAY_MS, MAX_PENDING_LINK_ATTEMPTS } from '../../constants.js';
import { sleep } from '../../utils/retry.js';
import { getRemoteKey, getLocalKey, storeLinkMapping } from '../storage/mappings.js';
import { removePendingLink, getPendingLinks } from '../storage/flags.js';
import { getFullIssue } from '../jira/local-client.js';
import { createRemoteIssue, updateRemoteIssue } from '../sync/issue-sync.js';

async function checkIfIssueNeedsSync(issueKey, issue, config, mappings) {
  // Check if issue was created by remote sync
  const createdByRemote = await getLocalKey(issueKey);
  if (createdByRemote) {
    return { needsSync: false, reason: 'created-by-remote' };
  }

  // Check if issue has remote mapping
  const remoteKey = await getRemoteKey(issueKey);

  if (!remoteKey) {
    // No mapping exists - needs creation
    return { needsSync: true, action: 'create' };
  }

  // Has mapping - check if fields have changed
  // For now, we'll sync it (in future, we can add change detection)
  return { needsSync: true, action: 'update', remoteKey };
}

async function removeIssueFromPendingLinksIndex(issueKey) {
  const pendingLinksIndex = await storage.get('pending-links-index') || [];
  const updatedIndex = pendingLinksIndex.filter(key => key !== issueKey);
  await storage.set('pending-links-index', updatedIndex);
}

export async function retryAllPendingLinks(config, mappings) {
  console.log(`🔄 Starting pending link retry...`);

  let totalRetried = 0;
  let totalSuccess = 0;
  let totalFailed = 0;
  let totalStillPending = 0;

  try {
    const pendingLinksIndex = await storage.get('pending-links-index') || [];

    if (pendingLinksIndex.length === 0) {
      console.log(`No pending links to retry`);
      return { retried: 0, success: 0, failed: 0, stillPending: 0 };
    }

    console.log(`📋 Found ${pendingLinksIndex.length} issue(s) with pending links`);

    // Process each issue's pending links
    for (const localIssueKey of pendingLinksIndex) {
      const pendingLinks = await getPendingLinks(localIssueKey);
      
      if (!pendingLinks || pendingLinks.length === 0) {
        // Clean up index if no links found
        await removeIssueFromPendingLinksIndex(localIssueKey);
        continue;
      }

      const remoteIssueKey = await getRemoteKey(localIssueKey);

      if (!remoteIssueKey) {
        console.log(`⏭️ Skipping ${localIssueKey} - not synced to remote yet`);
        continue;
      }

      console.log(`🔗 Retrying ${pendingLinks.length} pending link(s) for ${localIssueKey}`);

      const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');

      for (const pendingLink of pendingLinks) {
        totalRetried++;

        // Check if linked issue is now synced
        const remoteLinkedKey = await getRemoteKey(pendingLink.linkedIssueKey);

        if (!remoteLinkedKey) {
          console.log(`⏭️ ${pendingLink.linkedIssueKey} still not synced - keeping as pending`);
          totalStillPending++;

          // Update attempts counter (remove after MAX_PENDING_LINK_ATTEMPTS to prevent infinite storage)
          if (pendingLink.attempts >= MAX_PENDING_LINK_ATTEMPTS) {
            console.log(`❌ Removing ${pendingLink.linkedIssueKey} from pending - max attempts reached`);
            await removePendingLink(localIssueKey, pendingLink.linkId);
            totalFailed++;
          }
          continue;
        }

        // Linked issue is now synced - try to create the link
        console.log(`✅ ${pendingLink.linkedIssueKey} is now synced - creating link`);

        try {
          const linkPayload = {
            type: { name: pendingLink.linkTypeName }
          };

          if (pendingLink.direction === 'outward') {
            linkPayload.inwardIssue = { key: remoteIssueKey };
            linkPayload.outwardIssue = { key: remoteLinkedKey };
            console.log(`${LOG_EMOJI.LINK} Creating link: ${remoteIssueKey} → ${remoteLinkedKey}`);
          } else {
            linkPayload.inwardIssue = { key: remoteLinkedKey };
            linkPayload.outwardIssue = { key: remoteIssueKey };
            console.log(`${LOG_EMOJI.LINK} Creating link: ${remoteLinkedKey} → ${remoteIssueKey}`);
          }

          const response = await fetch(
            `${config.remoteUrl}/rest/api/3/issueLink`,
            {
              method: 'POST',
              headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(linkPayload)
            }
          );

          if (response.ok || response.status === 201) {
            console.log(`${LOG_EMOJI.SUCCESS} Successfully synced pending link: ${pendingLink.linkedIssueKey}`);
            await storeLinkMapping(pendingLink.linkId, 'synced');
            await removePendingLink(localIssueKey, pendingLink.linkId);
            totalSuccess++;
          } else {
            const errorText = await response.text();
            console.error(`${LOG_EMOJI.ERROR} Failed to create pending link: ${errorText}`);
            totalFailed++;
            // Keep as pending for next retry
          }
        } catch (error) {
          console.error(`${LOG_EMOJI.ERROR} Error creating pending link:`, error);
          totalFailed++;
          // Keep as pending for next retry
        }

        // Small delay to avoid rate limiting
        await sleep(100);
      }
    }

    console.log(`✅ Pending link retry complete: ${totalSuccess} success, ${totalFailed} failed, ${totalStillPending} still pending`);
    return { retried: totalRetried, success: totalSuccess, failed: totalFailed, stillPending: totalStillPending };

  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error in retryAllPendingLinks:`, error);
    return { retried: totalRetried, success: totalSuccess, failed: totalFailed, stillPending: totalStillPending };
  }
}

export async function performScheduledSync() {
  console.log(`⏰ Scheduled sync starting...`);

  const scheduledConfig = await storage.get('scheduledSyncConfig');
  if (!scheduledConfig || !scheduledConfig.enabled) {
    console.log(`⏭️ Scheduled sync disabled`);
    return;
  }
  
  const config = await storage.get('syncConfig');
  if (!config || !config.remoteUrl || !config.remoteProjectKey) {
    console.log(`⏭️ Sync not configured`);
    return;
  }
  
  const stats = {
    lastRun: new Date().toISOString(),
    issuesChecked: 0,
    issuesCreated: 0,
    issuesUpdated: 0,
    issuesSkipped: 0,
    errors: []
  };
  
  try {
    // Fetch all mappings once
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
    
    // Fetch recent issues from local Jira
    // Build project filter for JQL
    let projectFilter;
    if (config.allowedProjects && Array.isArray(config.allowedProjects) && config.allowedProjects.length > 0) {
      // Use allowed projects list
      if (config.allowedProjects.length === 1) {
        projectFilter = `project = ${config.allowedProjects[0]}`;
      } else {
        projectFilter = `project IN (${config.allowedProjects.join(', ')})`;
      }
    } else {
      // Fallback to remoteProjectKey for backward compatibility
      projectFilter = `project = ${config.remoteProjectKey}`;
    }

    const jql = scheduledConfig.syncScope === 'recent'
      ? `${projectFilter} AND updated >= -24h ORDER BY updated DESC`
      : `${projectFilter} ORDER BY updated DESC`;
    
    const searchResponse = await api.asApp().requestJira(
      route`/rest/api/3/search?jql=${jql}&maxResults=100`
    );
    const searchResults = await searchResponse.json();
    
    console.log(`📋 Found ${searchResults.issues.length} issues to check`);
    
    for (const issueData of searchResults.issues) {
      stats.issuesChecked++;
      const issueKey = issueData.key;
      
      try {
        // Get full issue details
        const issue = await getFullIssue(issueKey);
        if (!issue) {
          console.log(`⏭️ Could not fetch ${issueKey}`);
          stats.issuesSkipped++;
          continue;
        }
        
        // Check if sync is needed
        const syncCheck = await checkIfIssueNeedsSync(issueKey, issue, config, mappings);
        
        if (!syncCheck.needsSync) {
          console.log(`⏭️ ${issueKey} - ${syncCheck.reason}`);
          stats.issuesSkipped++;
          continue;
        }
        
        // Perform sync
        if (syncCheck.action === 'create') {
          console.log(`✨ Scheduled CREATE: ${issueKey}`);
          const remoteKey = await createRemoteIssue(issue, config, mappings);
          if (remoteKey) {
            stats.issuesCreated++;
          } else {
            stats.errors.push(`Failed to create ${issueKey}`);
          }
        } else if (syncCheck.action === 'update') {
          console.log(`🔄 Scheduled UPDATE: ${issueKey} → ${syncCheck.remoteKey}`);
          await updateRemoteIssue(issueKey, syncCheck.remoteKey, issue, config, mappings);
          stats.issuesUpdated++;
        }
        
        // Small delay to avoid rate limiting
        await sleep(SCHEDULED_SYNC_DELAY_MS);
        
      } catch (error) {
        console.error(`Error syncing ${issueKey}:`, error);
        stats.errors.push(`${issueKey}: ${error.message}`);
      }
    }
    
  } catch (error) {
    console.error('Scheduled sync error:', error);
    stats.errors.push(`General error: ${error.message}`);
  }

  // Retry pending links after main sync
  try {
    const config = await storage.get('syncConfig');
    if (config && config.remoteUrl) {
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

      const pendingLinkResults = await retryAllPendingLinks(config, mappings);
      console.log(`🔗 Pending links: ${pendingLinkResults.success} synced, ${pendingLinkResults.stillPending} still pending`);
    }
  } catch (error) {
    console.error('Error retrying pending links:', error);
  }

  // Save stats
  await storage.set('scheduledSyncStats', stats);

  console.log(`✅ Scheduled sync complete:`, stats);
  return stats;
}
