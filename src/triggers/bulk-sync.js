import api, { route, fetch } from '@forge/api';
import * as kvsStore from '../services/storage/kvs.js';
import { getRemoteKey, addToMappingIndex, removeMapping, getOrganizationsWithTokens, storeMapping } from '../services/storage/mappings.js';
import { getFullIssue } from '../services/jira/local-client.js';
import { createRemoteIssue, updateRemoteIssue } from '../services/sync/issue-sync.js';
import { syncAttachments } from '../services/sync/attachment-sync.js';
import { syncIssueLinks } from '../services/sync/link-sync.js';
import { syncAllComments } from '../services/sync/comment-sync.js';

/**
 * Async event consumer for bulk sync operations.
 * This runs with 900 second timeout, allowing full sync of all issues.
 */
export async function run(event, context) {
  const startTime = Date.now();
  // Queue events have payload in event.body (from queue.push({ body: {...} }))
  const { orgId, syncMissingData = false, updateExisting = false, dryRun = false } = event.body || event.payload || {};
  
  console.log(`🚀 Bulk sync started (org: ${orgId || 'all'}, syncMissingData: ${syncMissingData}, updateExisting: ${updateExisting}, dryRun: ${dryRun})`);

  try {
    // Get organizations
    const organizations = await kvsStore.get('organizations') || [];
    
    if (organizations.length === 0) {
      console.log('❌ No organizations configured');
      return { success: false, error: 'No organizations configured' };
    }

    const orgsToScan = orgId 
      ? organizations.filter(o => o.id === orgId)
      : organizations;

    if (orgsToScan.length === 0) {
      console.log('❌ Organization not found');
      return { success: false, error: 'Organization not found' };
    }

    let totalScanned = 0;
    let totalCreated = 0;
    let totalAlreadySynced = 0;
    let totalRecreated = 0;
    let totalUpdated = 0;
    let totalErrors = 0;

    for (const org of orgsToScan) {
      console.log(`📋 Processing organization: ${org.name}`);
      
      // Fetch API token from secret storage
      const token = await kvsStore.getSecret(`secret:${org.id}:token`);
      const orgWithToken = {
        ...org,
        remoteApiToken: token || org.remoteApiToken || ''
      };
      
      if (!orgWithToken.remoteApiToken) {
        console.error(`❌ No API token found for organization ${org.name}`);
        totalErrors++;
        continue;
      }
      
      // Get org-specific mappings
      const [userMappings, fieldMappings, statusMappings, issueTypeMappings, syncOptions] = await Promise.all([
        kvsStore.get(`userMappings:${orgWithToken.id}`),
        kvsStore.get(`fieldMappings:${orgWithToken.id}`),
        kvsStore.get(`statusMappings:${orgWithToken.id}`),
        kvsStore.get(`issueTypeMappings:${orgWithToken.id}`),
        kvsStore.get(`syncOptions:${orgWithToken.id}`)
      ]);

      const mappings = {
        userMappings: userMappings || {},
        fieldMappings: fieldMappings || {},
        statusMappings: statusMappings || {},
        issueTypeMappings: issueTypeMappings || {}
      };

      const effectiveSyncOptions = syncOptions || {
        syncComments: true,
        syncAttachments: true,
        syncLinks: true
      };
      
      // Add dryRun to sync options
      if (dryRun) {
        effectiveSyncOptions.dryRun = true;
      }

      console.log(`⚙️ Sync options for ${org.name}:`, JSON.stringify({
        syncAttachments: effectiveSyncOptions.syncAttachments !== false,
        syncLinks: effectiveSyncOptions.syncLinks !== false,
        syncComments: effectiveSyncOptions.syncComments !== false,
        dryRun: !!effectiveSyncOptions.dryRun,
        forceCheckAttachments: !!effectiveSyncOptions.forceCheckAttachments,
        forceCheckLinks: !!effectiveSyncOptions.forceCheckLinks
      }));

      // If updating existing, force check attachments and links to ensure consistency
      if (updateExisting) {
        effectiveSyncOptions.forceCheckAttachments = true;
        effectiveSyncOptions.forceCheckLinks = true;
      }
      
      // Get LOCAL projects
      const allowedProjects = Array.isArray(orgWithToken.allowedProjects)
        ? orgWithToken.allowedProjects.filter(Boolean)
        : [];

      if (allowedProjects.length === 0) {
        console.log(`⛔ Skipping ${org.name} - no project filters selected`);
        continue;
      }
      
      const projectsResponse = await api.asApp().requestJira(
        route`/rest/api/3/project/search?maxResults=100`,
        { method: 'GET' }
      );

      if (!projectsResponse.ok) {
        console.error(`Failed to fetch local projects`);
        continue;
      }

      const projectsData = await projectsResponse.json();
      const localProjects = projectsData.values || [];
      
      const projectsToScan = localProjects.filter(p => allowedProjects.includes(p.key));

      console.log(`📋 Found ${projectsToScan.length} local projects to scan`);
      
      for (const project of projectsToScan) {
        const projectKey = project.key;
        console.log(`📋 Scanning project: ${projectKey}`);
        
        // Build JQL
        let jql = `project = ${projectKey} ORDER BY key ASC`;
        if (orgWithToken.jqlFilter) {
          jql = `project = ${projectKey} AND (${orgWithToken.jqlFilter}) ORDER BY key ASC`;
        }
        
        let hasMore = true;
        let nextPageToken = null;

        while (hasMore) {
          const requestBody = {
            jql,
            maxResults: 100,
            fields: ['key', 'summary', 'issuetype', 'status', 'priority', 'assignee', 'reporter', 'description', 'created', 'updated']
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
            const errorText = await response.text();
            console.error(`Failed to search issues in ${projectKey}: ${response.status} - ${errorText}`);
            break;
          }

          const data = await response.json();
          const issues = data.issues || [];
          console.log(`📋 Processing batch of ${issues.length} issues from ${projectKey}`);
          
          for (const issue of issues) {
            const localKey = issue.key;
            totalScanned++;

            // Update progress and check cancellation every 5 issues
            if (totalScanned % 5 === 0) {
              await kvsStore.set('bulkSyncStatus', {
                status: 'running',
                timestamp: new Date().toISOString(),
                orgId: orgId || 'all',
                syncMissingData,
                updateExisting,
                dryRun,
                progress: {
                  scanned: totalScanned,
                  created: totalCreated,
                  updated: totalUpdated,
                  alreadySynced: totalAlreadySynced,
                  recreated: totalRecreated,
                  errors: totalErrors
                }
              });

              const currentStatus = await kvsStore.get('bulkSyncStatus');
              if (currentStatus && currentStatus.status === 'cancelled') {
                console.log('🛑 Bulk sync was cancelled by user - stopping');
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                await kvsStore.set('bulkSyncStatus', {
                  status: 'cancelled',
                  timestamp: new Date().toISOString(),
                  results: {
                    scanned: totalScanned,
                    created: totalCreated,
                    updated: totalUpdated,
                    alreadySynced: totalAlreadySynced,
                    recreated: totalRecreated,
                    errors: totalErrors,
                    elapsedSeconds: elapsed,
                    stoppedEarly: true,
                    dryRun
                  }
                });
                return { success: false, message: 'Cancelled by user' };
              }
            }
            
            // Check if this issue has a remote mapping
            let remoteKey = await getRemoteKey(localKey, orgWithToken.id);
            
            if (!remoteKey) {
              remoteKey = await getRemoteKey(localKey, null); // Try legacy
            }

            if (!remoteKey) {
              // No mapping - check if issue with same summary exists on remote to avoid duplicates
              console.log(`🆕 ${localKey} has no mapping - checking remote...`);
              
              try {
                const fullIssue = await getFullIssue(localKey);
                if (fullIssue) {
                  // Search for existing issue on remote
                  const auth = Buffer.from(`${orgWithToken.remoteEmail}:${orgWithToken.remoteApiToken}`).toString('base64');
                  const searchJql = `project = ${orgWithToken.remoteProjectKey} AND summary ~ "${fullIssue.fields.summary.replace(/"/g, '\\"').substring(0, 50)}"`;
                  
                  const searchResponse = await fetch(
                    `${orgWithToken.remoteUrl}/rest/api/3/search/jql`,
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
                    console.log(`⚠️ ${localKey} already exists on remote as ${existingRemoteIssue.key} - storing mapping`);
                    await storeMapping(localKey, existingRemoteIssue.key, orgWithToken.id);
                    totalAlreadySynced++;
                  } else {
                    // Create the issue
                    const createResult = await createRemoteIssue(fullIssue, orgWithToken, mappings, null, effectiveSyncOptions);
                    
                    // Handle Dry Run Result
                    if (effectiveSyncOptions.dryRun && createResult?.dryRun) {
                      console.log(`[DRY RUN] Would create ${localKey}`);
                      totalCreated++;
                    } else {
                      const newRemoteKey = createResult?.key || createResult;
                      
                      if (newRemoteKey) {
                        console.log(`✅ Created ${localKey} → ${newRemoteKey}`);
                        totalCreated++;
                      } else {
                        console.error(`❌ Failed to create ${localKey}`);
                        totalErrors++;
                      }
                    }
                  }
                }
              } catch (createError) {
                console.error(`❌ Error creating ${localKey}:`, createError.message);
                totalErrors++;
              }
            } else {
              // Has mapping - verify remote issue still exists
              const auth = Buffer.from(`${orgWithToken.remoteEmail}:${orgWithToken.remoteApiToken}`).toString('base64');
              
              let remoteExists = true;
              try {
                const checkResponse = await fetch(
                  `${orgWithToken.remoteUrl}/rest/api/3/issue/${remoteKey}?fields=key`,
                  {
                    method: 'GET',
                    headers: {
                      'Authorization': `Basic ${auth}`,
                      'Content-Type': 'application/json'
                    }
                  }
                );
                remoteExists = checkResponse.ok;
                
                if (checkResponse.status === 404) {
                  console.log(`⚠️ STALE MAPPING: ${localKey} → ${remoteKey} (remote deleted)`);
                  remoteExists = false;
                }
              } catch (e) {
                console.log(`⚠️ Could not verify ${remoteKey}: ${e.message}`);
              }
              
              if (!remoteExists) {
                // Remote was deleted - remove stale mapping and recreate
                if (!effectiveSyncOptions.dryRun) {
                  console.log(`🔄 Removing stale mapping and recreating ${localKey}`);
                  await removeMapping(localKey, remoteKey, orgWithToken.id);
                } else {
                  console.log(`[DRY RUN] Would remove stale mapping for ${localKey}`);
                }
                
                const fullIssue = await getFullIssue(localKey);
                if (fullIssue) {
                  const createResult = await createRemoteIssue(fullIssue, orgWithToken, mappings, null, effectiveSyncOptions);
                  
                  // Handle Dry Run Result
                  if (effectiveSyncOptions.dryRun && createResult?.dryRun) {
                    console.log(`[DRY RUN] Would recreate ${localKey}`);
                    totalRecreated++;
                  } else {
                    const newRemoteKey = createResult?.key || createResult;
                    
                    if (newRemoteKey) {
                      console.log(`✅ Recreated ${localKey} → ${newRemoteKey}`);
                      totalRecreated++;
                    } else {
                      console.error(`❌ Failed to recreate ${localKey}`);
                      totalErrors++;
                    }
                  }
                }
              } else {
                // Remote exists - count as already synced
                totalAlreadySynced++;
                
                // Update existing issues if updateExisting is enabled
                if (updateExisting) {
                  try {
                    const fullIssue = await getFullIssue(localKey);
                    if (fullIssue) {
                      console.log(`🔄 Updating existing issue ${localKey} → ${remoteKey}`);
                      const updateResult = await updateRemoteIssue(localKey, remoteKey, fullIssue, orgWithToken, mappings, null, effectiveSyncOptions);
                      
                      if (effectiveSyncOptions.dryRun && updateResult?.dryRun) {
                        console.log(`[DRY RUN] Would update ${localKey}`);
                        totalUpdated++;
                      } else {
                        totalUpdated++;
                      }
                    }
                  } catch (updateError) {
                    console.error(`❌ Error updating ${localKey}:`, updateError.message);
                    totalErrors++;
                  }
                }
                // Sync missing data if enabled
                else if (syncMissingData) {
                  try {
                    const fullIssue = await getFullIssue(localKey);
                    if (fullIssue) {
                      if (effectiveSyncOptions.syncAttachments !== false) {
                        await syncAttachments(localKey, remoteKey, fullIssue, orgWithToken, null, orgWithToken.id, true);
                      }
                      if (effectiveSyncOptions.syncLinks !== false) {
                        await syncIssueLinks(localKey, remoteKey, fullIssue, orgWithToken, null, orgWithToken.id, true);
                      }
                      if (effectiveSyncOptions.syncComments !== false) {
                        await syncAllComments(localKey, remoteKey, fullIssue, orgWithToken, null, orgWithToken.id);
                      }
                    }
                  } catch (error) {
                    console.error(`Error syncing missing data for ${localKey}:`, error.message);
                  }
                }
              }
            }
          }

          nextPageToken = data.nextPageToken;
          hasMore = !!nextPageToken && issues.length > 0;
        }
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const message = `Bulk sync complete: ${totalScanned} scanned, ${totalCreated} created, ${totalUpdated} updated, ${totalAlreadySynced} already synced, ${totalRecreated} recreated, ${totalErrors} errors (${elapsed}s)`;
    console.log(`✅ ${message}`);

    // Store sync result for UI to poll
    await kvsStore.set('bulkSyncStatus', {
      status: 'complete',
      timestamp: new Date().toISOString(),
      results: {
        scanned: totalScanned,
        created: totalCreated,
        updated: totalUpdated,
        alreadySynced: totalAlreadySynced,
        recreated: totalRecreated,
        errors: totalErrors,
        elapsedSeconds: elapsed,
        dryRun
      }
    });

    return { success: true, message };
  } catch (error) {
    console.error('❌ Bulk sync failed:', error);
    
    await kvsStore.set('bulkSyncStatus', {
      status: 'error',
      timestamp: new Date().toISOString(),
      error: error.message
    });
    
    return { success: false, error: error.message };
  }
}
