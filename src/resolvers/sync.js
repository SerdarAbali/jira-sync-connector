import api, { route, storage, fetch } from '@forge/api';
import { getRemoteKey, addToMappingIndex, removeMapping, getAllMappings } from '../services/storage/mappings.js';
import { getFullIssue } from '../services/jira/local-client.js';
import { createRemoteIssue, updateRemoteIssue, syncIssue } from '../services/sync/issue-sync.js';
import { syncAttachments } from '../services/sync/attachment-sync.js';
import { syncIssueLinks } from '../services/sync/link-sync.js';
import { syncAllComments } from '../services/sync/comment-sync.js';
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
        const createResult = await createRemoteIssue(issue, config, mappings);
        const remoteKey = createResult?.key || createResult; // Handle both object and string returns
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

  // New resolver to scan all synced issues and check for deleted remote issues
  resolver.define('scanForDeletedIssues', async ({ payload }) => {
    try {
      const { orgId } = payload || {};
      console.log(`🔍 Scanning for deleted remote issues (org: ${orgId || 'all'})...`);

      // Get organizations
      const organizations = await storage.get('organizations') || [];
      
      if (organizations.length === 0) {
        return { success: false, error: 'No organizations configured' };
      }

      const orgsToScan = orgId 
        ? organizations.filter(o => o.id === orgId)
        : organizations;

      if (orgsToScan.length === 0) {
        return { success: false, error: 'Organization not found' };
      }

      let totalScanned = 0;
      let totalDeleted = 0;
      let totalRecreated = 0;
      let totalSyncedMissing = 0;
      let totalErrors = 0;
      const details = [];

      for (const org of orgsToScan) {
        console.log(`📋 Scanning organization: ${org.name}`);
        
        // Get LOCAL projects from the Jira instance where this app is installed
        // The allowedProjects in org config refers to which local projects are allowed to sync TO the remote
        const allowedProjects = org.allowedProjects || [];
        
        // First, get all projects from local Jira
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
        
        // Filter to only allowed projects if configured, otherwise scan all
        const projectsToScan = allowedProjects.length > 0
          ? localProjects.filter(p => allowedProjects.includes(p.key))
          : localProjects;

        console.log(`📋 Found ${projectsToScan.length} local projects to scan`);
        
        for (const project of projectsToScan) {
          const projectKey = project.key;
          console.log(`📋 Scanning local project: ${projectKey}`);
          
          // Get all issues from the LOCAL project
          const jql = `project = ${projectKey} ORDER BY key ASC`;
          let startAt = 0;
          const maxResults = 100;
          let hasMore = true;
          let nextPageToken = null;

          while (hasMore) {
            const requestBody = {
              jql,
              maxResults,
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
              const errorText = await response.text();
              console.error(`Failed to search issues in ${projectKey}: ${response.status} - ${errorText}`);
              break;
            }

            const data = await response.json();
            const issueCount = data.issues?.length || 0;
            console.log(`📋 Found ${issueCount} issues in ${projectKey}`);
            
            for (const issue of (data.issues || [])) {
              const localKey = issue.key;
              
              // Check if this issue has a remote mapping
              let remoteKey = await getRemoteKey(localKey, org.id);
              if (!remoteKey) {
                remoteKey = await getRemoteKey(localKey, null); // Try legacy
              }

              if (remoteKey) {
                totalScanned++;
                console.log(`🔍 Checking ${localKey} → ${remoteKey}`);
                
                // Add to index for future scans
                await addToMappingIndex(localKey, remoteKey, org.id);

                // Check if remote issue still exists
                const auth = Buffer.from(`${org.remoteEmail}:${org.remoteApiToken}`).toString('base64');
                
                try {
                  const checkResponse = await fetch(
                    `${org.remoteUrl}/rest/api/3/issue/${remoteKey}?fields=key`,
                    {
                      method: 'GET',
                      headers: {
                        'Authorization': `Basic ${auth}`,
                        'Content-Type': 'application/json'
                      }
                    }
                  );

                  if (checkResponse.status === 404) {
                    console.log(`❌ Remote issue ${remoteKey} was DELETED (local: ${localKey})`);
                    totalDeleted++;

                    // Clear the mapping
                    await removeMapping(localKey, remoteKey, org.id);

                    // Get full issue and recreate
                    const fullIssue = await getFullIssue(localKey);
                    if (fullIssue) {
                      const [userMappings, fieldMappings, statusMappings, syncOptions] = await Promise.all([
                        storage.get(`userMappings:${org.id}`) || storage.get('userMappings'),
                        storage.get(`fieldMappings:${org.id}`) || storage.get('fieldMappings'),
                        storage.get(`statusMappings:${org.id}`) || storage.get('statusMappings'),
                        storage.get(`syncOptions:${org.id}`) || storage.get('syncOptions')
                      ]);

                      const mappings = {
                        userMappings: userMappings || {},
                        fieldMappings: fieldMappings || {},
                        statusMappings: statusMappings || {}
                      };

                      const effectiveSyncOptions = syncOptions || {
                        syncComments: true,
                        syncAttachments: true,
                        syncLinks: true
                      };

                      const createResult = await createRemoteIssue(fullIssue, org, mappings, null, effectiveSyncOptions);
                      const newRemoteKey = createResult?.key || createResult; // Handle both object and string returns
                      if (newRemoteKey) {
                        console.log(`✅ Recreated ${localKey} → ${newRemoteKey} (with attachments/links/comments)`);
                        totalRecreated++;
                        details.push({
                          localKey,
                          previousRemoteKey: remoteKey,
                          newRemoteKey,
                          status: 'recreated'
                        });
                      } else {
                        console.error(`Failed to recreate ${localKey}`);
                        totalErrors++;
                        details.push({
                          localKey,
                          previousRemoteKey: remoteKey,
                          status: 'error',
                          error: 'Failed to create remote issue'
                        });
                      }
                    }
                  } else if (checkResponse.ok) {
                    // Issue exists - check for missing attachments, links, comments
                    const fullIssue = await getFullIssue(localKey);
                    if (fullIssue) {
                      const syncOptions = await storage.get(`syncOptions:${org.id}`) || await storage.get('syncOptions') || {
                        syncComments: true,
                        syncAttachments: true,
                        syncLinks: true
                      };

                      let syncedSomething = false;

                      // Sync missing attachments (forceCheck = true to verify on remote)
                      if (syncOptions.syncAttachments !== false) {
                        const attachmentResult = await syncAttachments(localKey, remoteKey, fullIssue, org, null, org.id, true);
                        if (Object.keys(attachmentResult).length > 0) {
                          console.log(`📎 Checked ${Object.keys(attachmentResult).length} attachment(s) for ${localKey}`);
                          syncedSomething = true;
                        }
                      }

                      // Sync missing links (forceCheck = true to verify on remote)
                      if (syncOptions.syncLinks !== false) {
                        await syncIssueLinks(localKey, remoteKey, fullIssue, org, null, org.id, true);
                      }

                      // Sync missing comments
                      if (syncOptions.syncComments !== false) {
                        const commentResult = await syncAllComments(localKey, remoteKey, fullIssue, org, null, org.id);
                        if (commentResult && commentResult.synced > 0) {
                          console.log(`💬 Synced ${commentResult.synced} comment(s) for ${localKey}`);
                        syncedSomething = true;
                        }
                      }

                      if (syncedSomething) {
                        totalSyncedMissing++;
                        details.push({
                          localKey,
                          remoteKey,
                          status: 'synced-missing'
                        });
                      }
                    }
                  }
                } catch (error) {
                  console.error(`Error checking ${remoteKey}:`, error);
                }
              }
            }

            // Use nextPageToken for pagination
            nextPageToken = data.nextPageToken;
            hasMore = !!nextPageToken && (data.issues?.length || 0) > 0;
          }
        }
      }

      const message = `Scanned ${totalScanned} issues: ${totalDeleted} deleted, ${totalRecreated} recreated, ${totalSyncedMissing} synced missing data, ${totalErrors} errors`;
      console.log(`✅ ${message}`);

      return {
        success: true,
        message,
        results: {
          scanned: totalScanned,
          deleted: totalDeleted,
          recreated: totalRecreated,
          syncedMissing: totalSyncedMissing,
          errors: totalErrors,
          details
        }
      };

    } catch (error) {
      console.error('Error scanning for deleted issues:', error);
      return { success: false, error: error.message };
    }
  });
}
