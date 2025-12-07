import api, { route, fetch } from '@forge/api';
import * as kvsStore from '../storage/kvs.js';
import { LOG_EMOJI, SCHEDULED_SYNC_DELAY_MS, MAX_PENDING_LINK_ATTEMPTS } from '../../constants.js';
import { sleep } from '../../utils/retry.js';
import { getRemoteKey, getLocalKey, storeLinkMapping, removeMapping, getAllMappings, addToMappingIndex, getOrganizationsWithTokens } from '../storage/mappings.js';
import { removePendingLink, getPendingLinks, removeIssueFromPendingLinksIndex } from '../storage/flags.js';
import { getFullIssue } from '../jira/local-client.js';
import { createRemoteIssue, updateRemoteIssue } from '../sync/issue-sync.js';
import { syncIssueLinks } from '../sync/link-sync.js';

/**
 * Check if a remote issue exists in the target Jira instance
 * @param {string} remoteKey - The remote issue key (e.g., "SCRUM-123")
 * @param {object} config - Sync config with remote credentials
 * @returns {Promise<boolean>} - True if issue exists, false if deleted/not found
 */
async function checkRemoteIssueExists(remoteKey, config) {
  try {
    const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
    
    const response = await fetch(
      `${config.remoteUrl}/rest/api/3/issue/${remoteKey}?fields=key`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.ok) {
      return true;
    }
    
    if (response.status === 404) {
      console.log(`${LOG_EMOJI.WARNING} Remote issue ${remoteKey} not found (deleted)`);
      return false;
    }
    
    // For other errors (401, 403, 500), assume issue might exist but we can't access it
    console.log(`${LOG_EMOJI.WARNING} Could not verify remote issue ${remoteKey} (status: ${response.status})`);
    return true; // Assume exists to avoid accidental recreation
    
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error checking remote issue ${remoteKey}:`, error);
    return true; // Assume exists on error to be safe
  }
}

/**
 * Check all existing mappings to find and recreate deleted remote issues
 * This runs when "Recreate Deleted Issues" option is enabled
 */
async function checkAndRecreateDeletedIssues(config, mappings, syncOptions, orgId, orgName, stats, startTime, timeoutThreshold) {
  console.log(`${LOG_EMOJI.INFO} Checking all mappings for deleted remote issues...`);
  
  // Get all mappings for this org
  const allMappings = await getAllMappings(orgId);
  
  // Also check legacy mappings if no org-specific ones
  let legacyMappings = [];
  if (allMappings.length === 0 && (!orgId || orgId === 'legacy')) {
    legacyMappings = await getAllMappings(null);
  }
  
  const mappingsToCheck = allMappings.length > 0 ? allMappings : legacyMappings;
  
  if (mappingsToCheck.length === 0) {
    console.log(`${LOG_EMOJI.INFO} No existing mappings found for ${orgName}`);
    return;
  }
  
  console.log(`${LOG_EMOJI.INFO} Found ${mappingsToCheck.length} existing mapping(s) to verify for ${orgName}`);
  
  let checkedCount = 0;
  let deletedCount = 0;
  
  for (const mapping of mappingsToCheck) {
    // Check for timeout
    if (startTime && timeoutThreshold && (Date.now() - startTime > timeoutThreshold)) {
      console.warn(`⚠️ Recreate deleted issues stopped early for ${orgName} due to timeout risk`);
      stats.errors.push(`Recreate check stopped early for ${orgName} due to timeout risk`);
      break;
    }

    checkedCount++;
    const { localKey, remoteKey } = mapping;
    
    // Check if remote issue still exists
    const remoteExists = await checkRemoteIssueExists(remoteKey, config);
    
    if (!remoteExists) {
      deletedCount++;
      console.log(`${LOG_EMOJI.WARNING} Remote issue ${remoteKey} was deleted, will recreate from ${localKey}`);
      
      try {
        // Get the local issue
        const issue = await getFullIssue(localKey);
        
        if (!issue) {
          console.log(`${LOG_EMOJI.WARNING} Local issue ${localKey} not found, removing stale mapping`);
          await removeMapping(localKey, remoteKey, orgId);
          recordEvent(stats, {
            type: 'error',
            issueKey: localKey,
            message: 'Local issue not found, removed stale mapping',
            orgName
          });
          continue;
        }
        
        // Clear the old mapping
        await removeMapping(localKey, remoteKey, orgId);
        
        // Recreate the issue with attachments and links
        console.log(`${LOG_EMOJI.WARNING} Recreating ${localKey} (was ${remoteKey})`);
        const createResult = await createRemoteIssue(issue, config, mappings, null, syncOptions);
        const newRemoteKey = createResult?.key || createResult; // Handle both object and string returns
        const createDetails = createResult?.details;
        
        if (newRemoteKey) {
          stats.issuesRecreated++;
          recordEvent(stats, {
            type: 'recreate',
            issueKey: localKey,
            remoteKey: newRemoteKey,
            previousRemoteKey: remoteKey,
            orgName,
            details: createDetails
          });
          console.log(`${LOG_EMOJI.SUCCESS} Recreated ${localKey} → ${newRemoteKey} (with attachments/links)`);
        } else {
          stats.errors.push(`Failed to recreate ${localKey} in ${orgName}`);
          recordEvent(stats, {
            type: 'error',
            issueKey: localKey,
            message: 'Failed to recreate deleted issue',
            orgName
          });
        }
        
        // Small delay to avoid rate limiting
        await sleep(SCHEDULED_SYNC_DELAY_MS);
        
      } catch (error) {
        console.error(`${LOG_EMOJI.ERROR} Error recreating ${localKey}:`, error);
        stats.errors.push(`${localKey}: ${error.message}`);
        recordEvent(stats, {
          type: 'error',
          issueKey: localKey,
          message: error.message,
          orgName
        });
      }
    }
    
    // Small delay between checks to avoid rate limiting
    if (checkedCount % 10 === 0) {
      await sleep(100);
    }
  }
  
  console.log(`${LOG_EMOJI.INFO} Mapping verification complete: ${checkedCount} checked, ${deletedCount} deleted issues found`);
}

/**
 * Sync ALL missing issues from local to remote
 * This finds issues that were never synced and creates them on remote
 */
async function syncAllMissingIssues(config, mappings, syncOptions, orgId, orgName, stats, scheduledConfig, startTime, timeoutThreshold) {
  const scope = scheduledConfig?.syncScope || 'recent';
  console.log(`${LOG_EMOJI.INFO} Checking for issues that were NEVER synced to ${orgName} (Scope: ${scope})...`);
  
  // Get all local projects
  const projectsResponse = await api.asApp().requestJira(
    route`/rest/api/3/project/search?maxResults=100`,
    { method: 'GET' }
  );

  if (!projectsResponse.ok) {
    console.error(`${LOG_EMOJI.ERROR} Failed to fetch local projects`);
    return;
  }

  const projectsData = await projectsResponse.json();
  const localProjects = projectsData.values || [];
  
  // Filter to allowed projects
  const allowedProjects = Array.isArray(config.allowedProjects)
    ? config.allowedProjects.filter(Boolean)
    : [];

  if (allowedProjects.length === 0) {
    console.log(`${LOG_EMOJI.WARNING} Skipping never-synced check for ${orgName} - no project filters selected`);
    return;
  }

  const projectsToScan = localProjects.filter(p => allowedProjects.includes(p.key));

  let neverSyncedCount = 0;
  let createdCount = 0;

  for (const project of projectsToScan) {
    // Check for timeout at project level
    if (startTime && timeoutThreshold && (Date.now() - startTime > timeoutThreshold)) {
      console.warn(`⚠️ Missing issues check stopped early for ${orgName} due to timeout risk`);
      stats.errors.push(`Missing issues check stopped early for ${orgName} due to timeout risk`);
      break;
    }

    const projectKey = project.key;
    
    // Build JQL with optional filter
    let baseJql = `project = ${projectKey}`;
    if (config.jqlFilter && config.jqlFilter.trim()) {
      baseJql = `project = ${projectKey} AND (${config.jqlFilter})`;
    }

    // Apply scope filter
    if (scope === 'recent') {
      baseJql += ` AND updated >= -24h`;
    }

    const jql = `${baseJql} ORDER BY key ASC`;
    
    let hasMore = true;
    let nextPageToken = null;

    while (hasMore) {
      // Check for timeout inside pagination loop
      if (startTime && timeoutThreshold && (Date.now() - startTime > timeoutThreshold)) {
        hasMore = false;
        break;
      }

      const requestBody = {
        jql,
        maxResults: 50,
        fields: ['key']
      };
      
      if (nextPageToken) {
        requestBody.nextPageToken = nextPageToken;
      }

      const response = await api.asApp().requestJira(
        route`/rest/api/3/search/jql`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        }
      );

      if (!response.ok) {
        break;
      }

      const data = await response.json();
      const issues = data.issues || [];
      
      for (const issue of issues) {
        // Check for timeout inside issue loop
        if (startTime && timeoutThreshold && (Date.now() - startTime > timeoutThreshold)) {
          console.warn(`⚠️ Missing issues check stopped early for ${orgName} due to timeout risk`);
          hasMore = false;
          break;
        }

        const localKey = issue.key;
        
        // Check if mapping exists
        let remoteKey = await getRemoteKey(localKey, orgId);
        if (!remoteKey && orgId) {
          remoteKey = await getRemoteKey(localKey, null); // Try legacy
        }

        if (!remoteKey) {
          // Never synced - but first check if issue already exists on remote to avoid duplicates
          neverSyncedCount++;
          
          try {
            const fullIssue = await getFullIssue(localKey);
            if (fullIssue) {
              // Search for existing issue on remote with same summary
              const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
              const searchJql = `project = ${config.remoteProjectKey} AND summary ~ "${fullIssue.fields.summary.replace(/"/g, '\\"').substring(0, 50)}"`;
              
              const searchResponse = await fetch(
                `${config.remoteUrl}/rest/api/3/search/jql`,
                {
                  method: 'POST',
                  headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    jql: searchJql,
                    maxResults: 5,
                    fields: ['key', 'summary']
                  })
                }
              );
              
              let existingRemoteIssue = null;
              if (searchResponse.ok) {
                const searchData = await searchResponse.json();
                for (const remoteIssue of (searchData.issues || [])) {
                  if (remoteIssue.fields.summary === fullIssue.fields.summary) {
                    existingRemoteIssue = remoteIssue;
                    break;
                  }
                }
              }
              
              if (existingRemoteIssue) {
                // Issue already exists - just store the mapping
                console.log(`${LOG_EMOJI.WARNING} ${localKey} already exists on remote as ${existingRemoteIssue.key} - storing mapping only`);
                const { storeMapping } = await import('../storage/mappings.js');
                await storeMapping(localKey, existingRemoteIssue.key, orgId);
                recordEvent(stats, {
                  type: 'mapped',
                  issueKey: localKey,
                  remoteKey: existingRemoteIssue.key,
                  orgName,
                  reason: 'found-existing'
                });
              } else {
                // Actually create the issue
                console.log(`${LOG_EMOJI.WARNING} ${localKey} was NEVER synced - creating on ${orgName}`);
                const createResult = await createRemoteIssue(fullIssue, config, mappings, null, syncOptions);
                const newRemoteKey = createResult?.key || createResult;
                
                if (newRemoteKey) {
                  createdCount++;
                  stats.issuesCreated++;
                  console.log(`${LOG_EMOJI.SUCCESS} Created ${localKey} → ${newRemoteKey}`);
                  recordEvent(stats, {
                    type: 'create',
                    issueKey: localKey,
                    remoteKey: newRemoteKey,
                    orgName,
                    reason: 'never-synced'
                  });
                } else {
                  stats.errors.push(`Failed to create ${localKey} in ${orgName}`);
                  recordEvent(stats, {
                    type: 'error',
                    issueKey: localKey,
                    message: 'Failed to create (never synced)',
                    orgName
                  });
                }
              }
            }
            
            await sleep(SCHEDULED_SYNC_DELAY_MS);
            
          } catch (error) {
            console.error(`${LOG_EMOJI.ERROR} Error creating ${localKey}:`, error);
            stats.errors.push(`${localKey}: ${error.message}`);
          }
        }
      }

      nextPageToken = data.nextPageToken;
      hasMore = !!nextPageToken && issues.length > 0;
    }
  }
  
  console.log(`${LOG_EMOJI.INFO} Never-synced check complete: ${neverSyncedCount} found, ${createdCount} created`);
}

async function checkIfIssueNeedsSync(issueKey, issue, config, mappings, syncOptions = {}, orgId = null) {
  // Check if issue was created by remote sync
  const createdByRemote = await getLocalKey(issueKey);
  if (createdByRemote) {
    return { needsSync: false, reason: 'created-by-remote' };
  }

  // Check if issue has remote mapping (check both org-specific and legacy)
  let remoteKey = await getRemoteKey(issueKey, orgId);
  if (!remoteKey && orgId) {
    // Try legacy mapping
    remoteKey = await getRemoteKey(issueKey, null);
  }

  if (!remoteKey) {
    // No mapping exists - needs creation
    return { needsSync: true, action: 'create' };
  }

  // Has mapping - add to index for future recreate-deleted checks
  await addToMappingIndex(issueKey, remoteKey, orgId);

  // Has mapping - check if remote issue still exists (if recreateDeletedIssues is enabled)
  if (syncOptions.recreateDeletedIssues) {
    const remoteExists = await checkRemoteIssueExists(remoteKey, config);
    
    if (!remoteExists) {
      // Remote issue was deleted - clear mapping and recreate
      console.log(`${LOG_EMOJI.WARNING} Remote issue ${remoteKey} was deleted, clearing mapping for ${issueKey}`);
      await removeMapping(issueKey, remoteKey, orgId);
      return { needsSync: true, action: 'create', wasDeleted: true, previousRemoteKey: remoteKey };
    }
  }

  // Has mapping and remote exists (or we didn't check) - update
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

export async function performScheduledSync() {
  const startTime = Date.now();
  const TIMEOUT_THRESHOLD_MS = 800 * 1000; // 13 minutes 20 seconds (leaving buffer before 900s limit)
  
  console.log(`⏰ Scheduled sync starting...`);

  let scheduledConfig = await kvsStore.get('scheduledSyncConfig');

  if (!scheduledConfig) {
    scheduledConfig = {
      enabled: true,
      syncScope: 'recent',
      createdAt: new Date().toISOString()
    };
    await kvsStore.set('scheduledSyncConfig', scheduledConfig);
    console.log(`⚙️ Created default scheduled sync config (enabled, recent scope)`);
  }

  if (!scheduledConfig.enabled) {
    console.log(`⏭️ Scheduled sync disabled`);
    return;
  }
  
  // Get organizations with their API tokens from secure storage
  const organizations = await getOrganizationsWithTokens();
  
  // Fallback to legacy syncConfig if no organizations defined
  let configs = [];
  if (organizations.length > 0) {
    configs = organizations.filter(org => org.remoteUrl && org.remoteProjectKey);
    console.log(`📋 Found ${configs.length} configured organization(s)`);
  } else {
    // Legacy support
    const legacyConfig = await kvsStore.get('syncConfig');
    if (legacyConfig && legacyConfig.remoteUrl && legacyConfig.remoteProjectKey) {
      configs = [legacyConfig];
      console.log(`📋 Using legacy syncConfig`);
    }
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

      if (effectiveSyncOptions.recreateDeletedIssues) {
        console.log(`${LOG_EMOJI.INFO} Recreate deleted issues is ENABLED for ${orgName}`);
        
        // Check ALL existing mappings for deleted remote issues (not just recently updated)
        await checkAndRecreateDeletedIssues(config, mappings, effectiveSyncOptions, orgId, orgName, stats, startTime, TIMEOUT_THRESHOLD_MS);
      }
      
      // ALWAYS sync issues that were never synced (no mapping exists)
      // This ensures NO issue is left behind
      console.log(`${LOG_EMOJI.INFO} Checking for never-synced issues for ${orgName}...`);
      await syncAllMissingIssues(config, mappings, effectiveSyncOptions, orgId, orgName, stats, scheduledConfig, startTime, TIMEOUT_THRESHOLD_MS);
      
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
          
          if (syncCheck.action === 'create') {
            if (syncCheck.wasDeleted) {
              console.log(`${LOG_EMOJI.WARNING} Scheduled RECREATE: ${issueKey} (was ${syncCheck.previousRemoteKey})`);
            } else {
              console.log(`✨ Scheduled CREATE: ${issueKey}`);
            }
            
            const createResult = await createRemoteIssue(issue, config, mappings, null, effectiveSyncOptions);
            const remoteKey = createResult?.key || createResult; // Handle both object and string returns
            const createDetails = createResult?.details;
            if (remoteKey) {
              if (syncCheck.wasDeleted) {
                stats.issuesRecreated++;
                recordEvent(stats, {
                  type: 'recreate',
                  issueKey,
                  remoteKey,
                  previousRemoteKey: syncCheck.previousRemoteKey,
                  orgName,
                  details: createDetails
                });
              } else {
                stats.issuesCreated++;
                recordEvent(stats, {
                  type: 'create',
                  issueKey,
                  remoteKey,
                  orgName,
                  details: createDetails
                });
              }
            } else {
              stats.errors.push(`Failed to create ${issueKey} in ${orgName}`);
              recordEvent(stats, {
                type: 'error',
                issueKey,
                message: syncCheck.wasDeleted ? 'Failed to recreate' : 'Failed to create',
                orgName
              });
            }
          } else if (syncCheck.action === 'update') {
            console.log(`🔄 Scheduled UPDATE: ${issueKey} → ${syncCheck.remoteKey}`);
            const syncDetails = await updateRemoteIssue(issueKey, syncCheck.remoteKey, issue, config, mappings, null, effectiveSyncOptions);
            
            // Force verify and sync links directly (same as Scan & Recreate)
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
