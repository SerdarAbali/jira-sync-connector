import api, { route, fetch } from '@forge/api';
import * as kvsStore from '../storage/kvs.js';
import { LOG_EMOJI, SCHEDULED_SYNC_DELAY_MS, MAX_PENDING_LINK_ATTEMPTS } from '../../constants.js';
import { sleep } from '../../utils/retry.js';
import { getRemoteKey, getLocalKey, storeLinkMapping, getOrganizationsWithTokens, getLastSyncedLocalUpdated } from '../storage/mappings.js';
import { removePendingLink, getPendingLinks, removeIssueFromPendingLinksIndex } from '../storage/flags.js';
import { getFullIssue } from '../jira/local-client.js';
import { updateRemoteIssue } from '../sync/issue-sync.js';
import { syncIssueLinks } from '../sync/link-sync.js';

async function checkIfIssueNeedsSync(issueKey, issue, config, mappings, syncOptions = {}, orgId = null) {
  // Check if issue was created by remote sync
  const createdByRemote = await getLocalKey(issueKey);
  if (createdByRemote) {
    return { needsSync: false, reason: 'created-by-remote' };
  }

  // Check if issue has an organization-scoped remote mapping. Do not fall back
  // to a global/legacy mapping here: in a multi-org setup that could update the
  // wrong tenant. Scheduled sync is update-only for corporate pilot safety.
  const remoteKey = await getRemoteKey(issueKey, orgId);

  if (!remoteKey) {
    return { needsSync: false, reason: 'no-org-mapping-create-disabled' };
  }

  // Check if we already synced this version
  const lastSyncedUpdated = await getLastSyncedLocalUpdated(issueKey, orgId);
  if (lastSyncedUpdated && issue.fields.updated === lastSyncedUpdated) {
     // Skip if timestamps match exactly
     return { needsSync: false, reason: 'already-synced' };
  }

  // A valid mapping exists: update only. Deleted-issue recreation is disabled
  // for corporate pilot safety and is not attempted here.
  return { needsSync: true, action: 'update', remoteKey };
}

const MAX_SCHEDULED_EVENTS = 25;

function recordEvent(stats, event) {
  if (!stats || !stats.events) {
    return;
  }
  stats.events.unshift({
    timestamp: new Date().toISOString(),
    ...event
  });
  if (stats.events.length > MAX_SCHEDULED_EVENTS) {
    stats.events = stats.events.slice(0, MAX_SCHEDULED_EVENTS);
  }
}

export async function retryAllPendingLinks(config, mappings, stats) {
  console.log(`🔄 Starting pending link retry...`);

  let totalRetried = 0;
  let totalSuccess = 0;
  let totalFailed = 0;
  let totalStillPending = 0;

  try {
    const pendingLinksIndex = await kvsStore.get('pending-links-index') || [];

    if (pendingLinksIndex.length === 0) {
      console.log(`No pending links to retry`);
      return { retried: 0, success: 0, failed: 0, stillPending: 0 };
    }

    console.log(`📋 Found ${pendingLinksIndex.length} issue(s) with pending links`);

    // Get orgId for this config
    const orgId = config.id || null;

    // Process each issue's pending links
    for (const localIssueKey of pendingLinksIndex) {
      const pendingLinks = await getPendingLinks(localIssueKey);
      
      if (!pendingLinks || pendingLinks.length === 0) {
        // Clean up index if no links found
        await removeIssueFromPendingLinksIndex(localIssueKey);
        continue;
      }

      // Filter pending links for this org only
      const orgPendingLinks = pendingLinks.filter(pl => pl.orgId === orgId || (!pl.orgId && !orgId));
      
      if (orgPendingLinks.length === 0) {
        continue;
      }

      const remoteIssueKey = await getRemoteKey(localIssueKey, orgId);

      if (!remoteIssueKey) {
        console.log(`⏭️ Skipping ${localIssueKey} - not synced to remote yet (org: ${config.name || orgId})`);
        continue;
      }

      console.log(`🔗 Retrying ${orgPendingLinks.length} pending link(s) for ${localIssueKey} (org: ${config.name || orgId})`);

      const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');

      for (const pendingLink of orgPendingLinks) {
        totalRetried++;

        // Check if linked issue is now synced (use same orgId)
        const remoteLinkedKey = await getRemoteKey(pendingLink.linkedIssueKey, orgId);

        if (!remoteLinkedKey) {
          console.log(`⏭️ ${pendingLink.linkedIssueKey} still not synced - keeping as pending`);
          totalStillPending++;

          if (stats) {
            recordEvent(stats, {
              type: 'link-pending',
              issueKey: localIssueKey,
              linkedIssueKey: pendingLink.linkedIssueKey,
              direction: pendingLink.direction
            });
          }

          // Update attempts counter (remove after MAX_PENDING_LINK_ATTEMPTS to prevent infinite storage)
          if (pendingLink.attempts >= MAX_PENDING_LINK_ATTEMPTS) {
            console.log(`❌ Removing ${pendingLink.linkedIssueKey} from pending - max attempts reached`);
            await removePendingLink(localIssueKey, pendingLink.linkId);
            totalFailed++;
            if (stats) {
              recordEvent(stats, {
                type: 'link-dropped',
                issueKey: localIssueKey,
                linkedIssueKey: pendingLink.linkedIssueKey,
                reason: 'max-attempts'
              });
            }
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
            await storeLinkMapping(pendingLink.linkId, 'synced', orgId);
            await removePendingLink(localIssueKey, pendingLink.linkId);
            totalSuccess++;
            if (stats) {
              recordEvent(stats, {
                type: 'link-synced',
                issueKey: localIssueKey,
                linkedIssueKey: pendingLink.linkedIssueKey,
                direction: pendingLink.direction
              });
            }
          } else {
            const errorText = await response.text();
            console.error(`${LOG_EMOJI.ERROR} Failed to create pending link: ${errorText}`);
            totalFailed++;
            if (stats) {
              recordEvent(stats, {
                type: 'link-error',
                issueKey: localIssueKey,
                linkedIssueKey: pendingLink.linkedIssueKey,
                message: errorText
              });
            }
            // Keep as pending for next retry
          }
        } catch (error) {
          console.error(`${LOG_EMOJI.ERROR} Error creating pending link:`, error);
          totalFailed++;
          if (stats) {
            recordEvent(stats, {
              type: 'link-error',
              issueKey: localIssueKey,
              linkedIssueKey: pendingLink.linkedIssueKey,
              message: error.message
            });
          }
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

function createEmptyScheduledStats(reason) {
  return {
    lastRun: new Date().toISOString(),
    issuesChecked: 0,
    issuesCreated: 0,
    issuesUpdated: 0,
    issuesSkipped: 0,
    issuesRecreated: 0,
    errors: [],
    events: [],
    disabled: true,
    reason
  };
}

function getScheduledConfigIssue(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return 'missing-or-malformed-config';
  }
  if (config.enabled !== true) {
    return config.enabled === false ? 'disabled' : 'invalid-enabled-flag';
  }
  if (!['recent', 'all'].includes(config.syncScope)) {
    return 'invalid-sync-scope';
  }
  return null;
}

export async function performScheduledSync() {
  const startTime = Date.now();
  const TIMEOUT_THRESHOLD_MS = 800 * 1000; // 13 minutes 20 seconds (leaving buffer before 900s limit)
  
  console.log(`⏰ Scheduled sync starting...`);

  const scheduledConfig = await kvsStore.get('scheduledSyncConfig');
  const configIssue = getScheduledConfigIssue(scheduledConfig);

  if (configIssue) {
    // Fail closed: never create a default enabled configuration, and never
    // write to Jira when the scheduled-sync configuration is missing or bad.
    console.warn(`⏭️ Scheduled sync skipped: ${configIssue}`);
    return createEmptyScheduledStats(configIssue);
  }
  
  // Get organizations with their API tokens from secure storage
  const organizations = await getOrganizationsWithTokens();
  const configs = organizations.filter(org => org.remoteUrl && org.remoteProjectKey);
  if (configs.length > 0) {
    console.log(`📋 Found ${configs.length} configured organization(s)`);
  }

  if (configs.length === 0) {
    console.log(`⏭️ No organizations configured for sync`);
    return;
  }
  
  const stats = {
    lastRun: new Date().toISOString(),
    issuesChecked: 0,
    issuesCreated: 0,
    issuesUpdated: 0,
    issuesSkipped: 0,
    issuesRecreated: 0,
    errors: [],
    events: []
  };

  try {
    // Process each organization
    for (const org of configs) {
      // Check for timeout before starting org
      if (Date.now() - startTime > TIMEOUT_THRESHOLD_MS) {
        console.warn(`⚠️ Scheduled sync approaching timeout. Stopping early.`);
        stats.errors.push('Sync stopped early due to timeout risk');
        break;
      }

      const orgId = org.id || 'legacy';
      const orgName = org.name || 'Legacy';
      console.log(`\n🏢 Processing organization: ${orgName}`);
      
      const allowedProjects = Array.isArray(org.allowedProjects)
        ? org.allowedProjects.filter(Boolean)
        : [];

      if (allowedProjects.length === 0) {
        console.log(`⛔ Skipping ${orgName} - no project filters selected`);
        stats.issuesSkipped++;
        recordEvent(stats, {
          type: 'skip',
          orgName,
          message: 'No project filters selected'
        });
        continue;
      }

      try {
        // Build config object compatible with sync functions
        const config = {
          remoteUrl: org.remoteUrl,
          remoteEmail: org.remoteEmail,
          remoteApiToken: org.remoteApiToken,
        remoteProjectKey: org.remoteProjectKey,
        allowedProjects,
        jqlFilter: org.jqlFilter || ''
      };

      // Fetch org-specific mappings and sync options
      const [
        orgUserMappings, 
        orgFieldMappings, 
        orgStatusMappings, 
        orgSyncOptions,
        legacyUserMappings,
        legacyFieldMappings,
        legacyStatusMappings,
        legacySyncOptions
      ] = await Promise.all([
        kvsStore.get(`userMappings:${orgId}`),
        kvsStore.get(`fieldMappings:${orgId}`),
        kvsStore.get(`statusMappings:${orgId}`),
        kvsStore.get(`syncOptions:${orgId}`),
        kvsStore.get('userMappings'),
        kvsStore.get('fieldMappings'),
        kvsStore.get('statusMappings'),
        kvsStore.get('syncOptions')
      ]);
      
      // Use org-specific mappings if available, fallback to legacy
      const mappings = {
        userMappings: orgUserMappings || legacyUserMappings || {},
        fieldMappings: orgFieldMappings || legacyFieldMappings || {},
        statusMappings: orgStatusMappings || legacyStatusMappings || {}
      };

      const effectiveSyncOptions = orgSyncOptions || legacySyncOptions || {
        syncComments: true,
        syncAttachments: true,
        syncLinks: true,
        recreateDeletedIssues: false
      };
      
      // Always force check links during scheduled sync to catch missing links
      effectiveSyncOptions.forceCheckLinks = true;

      // Scheduled creation and recreation are intentionally disabled for
      // corporate pilot safety. Scheduled sync may only update issues that
      // already have a valid mapping. No summary matching or missing-issue
      // creation scan is performed.

      // Build project filter for JQL
      let projectFilter;
      if (config.allowedProjects && Array.isArray(config.allowedProjects) && config.allowedProjects.length > 0) {
        if (config.allowedProjects.length === 1) {
          projectFilter = `project = ${config.allowedProjects[0]}`;
        } else {
          projectFilter = `project IN (${config.allowedProjects.join(', ')})`;
        }
      } else {
        projectFilter = `project = ${config.remoteProjectKey}`;
      }

      // Combine project filter with org's custom JQL filter if set
      let baseFilter = projectFilter;
      if (config.jqlFilter && config.jqlFilter.trim()) {
        baseFilter = `${projectFilter} AND (${config.jqlFilter})`;
      }

      const jql = scheduledConfig.syncScope === 'recent'
        ? `${baseFilter} AND updated >= -24h ORDER BY updated DESC`
        : `${baseFilter} ORDER BY updated DESC`;
      
      console.log(`🔍 JQL: ${jql}`);
      
      const searchBody = {
        jql,
        maxResults: 100,
        fields: ['key', 'summary', 'updated'],
        expand: 'names'
      };

      const searchResponse = await api.asApp().requestJira(
        route`/rest/api/3/search/jql`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(searchBody)
        }
      );

      if (!searchResponse.ok) {
        const errorText = await searchResponse.text();
        throw new Error(`Failed to fetch issues: ${errorText}`);
      }

      const searchResults = await searchResponse.json();
      
      console.log(`📋 Found ${searchResults.issues.length} issues to check for ${orgName}`);
      
      for (const issueData of searchResults.issues) {
        // Check for timeout inside the issue loop
        if (Date.now() - startTime > TIMEOUT_THRESHOLD_MS) {
          console.warn(`⚠️ Scheduled sync approaching timeout. Stopping issue loop for ${orgName}.`);
          stats.errors.push(`Sync stopped early for ${orgName} due to timeout risk`);
          break;
        }

        stats.issuesChecked++;
        const issueKey = issueData.key;
        
        try {
          const issue = await getFullIssue(issueKey);
          if (!issue) {
            console.log(`⏭️ Could not fetch ${issueKey}`);
            stats.issuesSkipped++;
            continue;
          }
          
          const syncCheck = await checkIfIssueNeedsSync(issueKey, issue, config, mappings, effectiveSyncOptions, orgId);
          
          if (!syncCheck.needsSync) {
            console.log(`⏭️ ${issueKey} - ${syncCheck.reason}`);
            stats.issuesSkipped++;
            continue;
          }
          
          if (syncCheck.action === 'update') {
            console.log(`🔄 Scheduled UPDATE: ${issueKey} → ${syncCheck.remoteKey}`);
            const syncDetails = await updateRemoteIssue(issueKey, syncCheck.remoteKey, issue, config, mappings, null, effectiveSyncOptions);
            if (syncDetails?.skipped) {
              stats.issuesSkipped++;
              recordEvent(stats, {
                type: 'skip',
                issueKey,
                remoteKey: syncCheck.remoteKey,
                orgName,
                reason: syncDetails.status || 'update-skipped'
              });
              continue;
            }
            
            // Force verification of links for the mapped issue during the
            // scheduled update path.
            if (effectiveSyncOptions.syncLinks !== false) {
              const linkResult = await syncIssueLinks(issueKey, syncCheck.remoteKey, issue, config, null, orgId, true);
              if (linkResult && linkResult.synced > 0) {
                console.log(`🔗 Force-synced ${linkResult.synced} link(s) for ${issueKey}`);
                if (syncDetails) syncDetails.links = linkResult.synced;
              }
            }
            
            stats.issuesUpdated++;
            recordEvent(stats, {
              type: 'update',
              issueKey,
              remoteKey: syncCheck.remoteKey,
              orgName,
              details: syncDetails || { fields: true }
            });
          }
          
          await sleep(SCHEDULED_SYNC_DELAY_MS);
          
        } catch (error) {
          console.error(`Error syncing ${issueKey}:`, error);
          stats.errors.push(`${issueKey}: ${error.message}`);
          recordEvent(stats, {
            type: 'error',
            issueKey,
            message: error.message,
            orgName
          });
        }
      }

      // Retry pending links for this org
      try {
        const pendingLinkResults = await retryAllPendingLinks(config, mappings, stats);
        console.log(`🔗 Pending links for ${orgName}: ${pendingLinkResults.success} synced, ${pendingLinkResults.stillPending} still pending`);
      } catch (error) {
        console.error(`Error retrying pending links for ${orgName}:`, error);
      }
      
    } catch (error) {
      console.error(`Error processing org ${orgName}:`, error);
      stats.errors.push(`${orgName}: ${error.message}`);
      recordEvent(stats, {
        type: 'error',
        message: error.message,
        orgName
      });
    }
  }

  // Save stats
  await kvsStore.set('scheduledSyncStats', stats);

  console.log(`\n✅ Scheduled sync complete:`, stats);
  return stats;
  } catch (error) {
    console.error('Fatal error in scheduled sync:', error);
    return stats;
  }
}
