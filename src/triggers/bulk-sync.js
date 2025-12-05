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
  const { orgId, syncMissingData = false, updateExisting = false } = event.body || event.payload || {};
  
  console.log(`🚀 Bulk sync started (org: ${orgId || 'all'}, syncMissingData: ${syncMissingData}, updateExisting: ${updateExisting})`);

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
      
      // Get LOCAL projects
      const allowedProjects = orgWithToken.allowedProjects || [];
      
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
      
      const projectsToScan = allowedProjects.length > 0
        ? localProjects.filter(p => allowedProjects.includes(p.key))
        : localProjects;

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
          
          // Check for cancellation every batch
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
                alreadySynced: totalAlreadySynced,
                recreated: totalRecreated,
                errors: totalErrors,
                elapsedSeconds: elapsed,
                stoppedEarly: true
              }
            });
            return { success: false, message: 'Cancelled by user' };
          }
          
          for (const issue of issues) {
            const localKey = issue.key;
            totalScanned++;
            
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
                    `${orgWithToken.remoteUrl}/rest/api/3/search?jql=${encodeURIComponent(searchJql)}&maxResults=5&fields=key,summary`,
                    {
                      method: 'GET',
                      headers: {
                        'Authorization': `Basic ${auth}`,
                        'Content-Type': 'application/json'
                      }
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
              } catch (createError) {
                console.error(`❌ Error creating ${localKey}:`, createError.message);
                totalErrors++;
              }
            } else {
              // Has mapping - already synced
              totalAlreadySynced++;
              
              // Update existing issues if updateExisting is enabled
              if (updateExisting) {
                try {
                  const fullIssue = await getFullIssue(localKey);
                  if (fullIssue) {
                    console.log(`🔄 Updating existing issue ${localKey} → ${remoteKey}`);
                    await updateRemoteIssue(localKey, remoteKey, fullIssue, orgWithToken, mappings, null, effectiveSyncOptions);
                    totalUpdated++;
                  }
                } catch (updateError) {
                  console.error(`❌ Error updating ${localKey}:`, updateError.message);
                  totalErrors++;
                }
              }
              // Only do expensive verification if syncMissingData is enabled
              else if (syncMissingData) {
                const auth = Buffer.from(`${orgWithToken.remoteEmail}:${orgWithToken.remoteApiToken}`).toString('base64');
                
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

                  if (checkResponse.status === 404) {
                    // Remote was deleted - recreate
                    console.log(`❌ Remote ${remoteKey} was DELETED - recreating`);
                    await removeMapping(localKey, remoteKey, orgWithToken.id);

                    const fullIssue = await getFullIssue(localKey);
                    if (fullIssue) {
                      const createResult = await createRemoteIssue(fullIssue, orgWithToken, mappings, null, effectiveSyncOptions);
                      const newRemoteKey = createResult?.key || createResult;
                      
                      if (newRemoteKey) {
                        console.log(`✅ Recreated ${localKey} → ${newRemoteKey}`);
                        totalRecreated++;
                      } else {
                        totalErrors++;
                      }
                    }
                  } else if (checkResponse.ok) {
                    // Sync missing data
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
                  }
                } catch (error) {
                  console.error(`Error verifying ${remoteKey}:`, error.message);
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
        elapsedSeconds: elapsed
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
