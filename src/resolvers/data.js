import api, { route, storage, fetch } from '@forge/api';
import { getOrgName, getFullIssue } from '../services/jira/local-client.js';
import { getAllRemoteKeys, getRemoteKey, removeMapping } from '../services/storage/mappings.js';
import { createIssueForOrg, updateIssueForOrg } from '../services/sync/issue-sync.js';

const MAX_ISSUE_EXPORT = 250;
const ISSUE_EXPORT_PAGE_SIZE = 50;

export function defineDataResolvers(resolver) {
  resolver.define('fetchLocalProjects', async () => {
    try {
      const projectsResponse = await api.asApp().requestJira(
        route`/rest/api/3/project/search?maxResults=1000`
      );
      const projectsData = await projectsResponse.json();

      return {
        projects: projectsData.values.map(p => ({
          key: p.key,
          name: p.name,
          id: p.id
        }))
      };
    } catch (error) {
      console.error('Error fetching local projects:', error);
      throw error;
    }
  });

  resolver.define('fetchLocalData', async (req) => {
    try {
      // Log everything for debugging
      console.log('fetchLocalData FULL REQUEST:', JSON.stringify(req));
      console.log('fetchLocalData payload:', req.payload);

      // Get organization config
      const orgId = req?.payload?.orgId;
      let projectKey;

      console.log('fetchLocalData extracted orgId:', orgId);

      if (orgId) {
        // Use new organization format
        const orgs = await storage.get('organizations') || [];
        console.log('Found organizations:', orgs);
        const org = orgs.find(o => o.id === orgId);
        if (!org) {
          throw new Error(`Organization with ID ${orgId} not found`);
        }
        if (!org.remoteProjectKey) {
          throw new Error('Organization missing remoteProjectKey');
        }
        projectKey = org.remoteProjectKey;
      } else {
        // Fallback to legacy format
        console.log('No orgId provided, falling back to legacy config');
        const config = await storage.get('syncConfig');
        if (!config || !config.remoteProjectKey) {
          throw new Error('Project key not configured');
        }
        projectKey = config.remoteProjectKey;
      }

      const usersResponse = await api.asApp().requestJira(
        route`/rest/api/3/users/search?maxResults=1000`
      );
      const allUsers = await usersResponse.json();

      const users = allUsers.filter(u =>
        u.accountType === 'atlassian' &&
        u.active === true &&
        !u.displayName.includes('(')
      );

      const fieldsResponse = await api.asApp().requestJira(
        route`/rest/api/3/field`
      );
      const allFields = await fieldsResponse.json();
      const customFields = allFields.filter(f => f.custom);

      const statusesResponse = await api.asApp().requestJira(
        route`/rest/api/3/project/${projectKey}/statuses`
      );
      const statusData = await statusesResponse.json();

      const statusMap = new Map();
      const issueTypeMap = new Map();
      statusData.forEach(issueType => {
        // Collect issue types
        if (!issueTypeMap.has(issueType.id)) {
          issueTypeMap.set(issueType.id, {
            id: issueType.id,
            name: issueType.name
          });
        }
        issueType.statuses.forEach(status => {
          if (!statusMap.has(status.id)) {
            statusMap.set(status.id, {
              id: status.id,
              name: status.name
            });
          }
        });
      });
      const statuses = Array.from(statusMap.values());
      const issueTypes = Array.from(issueTypeMap.values());

      return {
        users: users.map(u => ({
          accountId: u.accountId,
          displayName: u.displayName,
          emailAddress: u.emailAddress || ''
        })),
        fields: customFields.map(f => ({
          id: f.id,
          name: f.name
        })),
        statuses: statuses,
        issueTypes: issueTypes
      };
    } catch (error) {
      console.error('Error fetching local data:', error);
      throw error;
    }
  });

  resolver.define('fetchRemoteData', async ({ payload }) => {
    try {
      // Get organization config
      const orgId = payload?.orgId;
      let config;

      console.log('fetchRemoteData called with orgId:', orgId);

      if (orgId) {
        // Use new organization format
        const orgs = await storage.get('organizations') || [];
        console.log('Found organizations:', orgs);
        const org = orgs.find(o => o.id === orgId);
        if (!org) {
          throw new Error(`Organization with ID ${orgId} not found`);
        }
        if (!org.remoteUrl || !org.remoteEmail || !org.remoteApiToken || !org.remoteProjectKey) {
          throw new Error('Organization missing required fields');
        }
        config = {
          remoteUrl: org.remoteUrl,
          remoteEmail: org.remoteEmail,
          remoteApiToken: org.remoteApiToken,
          remoteProjectKey: org.remoteProjectKey
        };
      } else {
        // Fallback to legacy format
        console.log('No orgId provided, falling back to legacy config');
        config = await storage.get('syncConfig');
        if (!config || !config.remoteUrl || !config.remoteEmail || !config.remoteApiToken) {
          throw new Error('Remote configuration not complete');
        }
      }

      const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
      const headers = {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      };

      const usersResponse = await fetch(
        `${config.remoteUrl}/rest/api/3/users/search?maxResults=1000`,
        { headers }
      );
      const allUsers = await usersResponse.json();

      const users = allUsers.filter(u =>
        u.accountType === 'atlassian' &&
        u.active === true &&
        !u.displayName.includes('(')
      );

      const fieldsResponse = await fetch(
        `${config.remoteUrl}/rest/api/3/field`,
        { headers }
      );
      const allFields = await fieldsResponse.json();
      const customFields = allFields.filter(f => f.custom);

      const statusesResponse = await fetch(
        `${config.remoteUrl}/rest/api/3/project/${config.remoteProjectKey}/statuses`,
        { headers }
      );
      const statusData = await statusesResponse.json();

      const statusMap = new Map();
      const issueTypeMap = new Map();
      statusData.forEach(issueType => {
        // Collect issue types
        if (!issueTypeMap.has(issueType.id)) {
          issueTypeMap.set(issueType.id, {
            id: issueType.id,
            name: issueType.name
          });
        }
        issueType.statuses.forEach(status => {
          if (!statusMap.has(status.id)) {
            statusMap.set(status.id, {
              id: status.id,
              name: status.name
            });
          }
        });
      });
      const statuses = Array.from(statusMap.values());
      const issueTypes = Array.from(issueTypeMap.values());

      return {
        users: users.map(u => ({
          accountId: u.accountId,
          displayName: u.displayName,
          emailAddress: u.emailAddress || ''
        })),
        fields: customFields.map(f => ({
          id: f.id,
          name: f.name
        })),
        statuses: statuses,
        issueTypes: issueTypes
      };
    } catch (error) {
      console.error('Error fetching remote data:', error);
      throw error;
    }
  });

  resolver.define('exportIssues', async ({ payload, context }) => {
    try {
      const jql = payload?.jql?.trim();
      console.log('[Export Debug] Received JQL:', jql);
      
      if (!jql) {
        return { success: false, error: 'JQL query is required' };
      }

      const requestingAccountId = context?.accountId;
      let effectiveJql = jql;
      const currentUserPattern = /\bcurrentUser\s*\(\s*\)/gi;

      if (currentUserPattern.test(jql)) {
        if (requestingAccountId) {
          const accountLiteral = requestingAccountId.replace(/"/g, '');
          effectiveJql = jql.replace(currentUserPattern, accountLiteral);
          console.log('[Export Debug] currentUser() replaced with accountId literal for user:', requestingAccountId);
        } else {
          console.warn('[Export Debug] JQL uses currentUser() but no accountId found in context');
        }
      }

      const requestedMax = Number(payload?.maxResults) || 50;
      const maxResults = Math.min(Math.max(requestedMax, 1), MAX_ISSUE_EXPORT);
      const includeComments = payload?.includeComments !== false;
      const includeAttachments = payload?.includeAttachments !== false;
      const includeChangelog = !!payload?.includeChangelog;
      const includeIssueLinks = payload?.includeIssueLinks !== false;

      const sourceOrg = await getOrgName();
      const exportedIssues = [];
      let nextPageToken = null;
      let total = 0;

      while (exportedIssues.length < maxResults) {
        const batchSize = Math.min(ISSUE_EXPORT_PAGE_SIZE, maxResults - exportedIssues.length);
        const requestBody = {
          jql: effectiveJql,
          maxResults: batchSize,
          fields: ['summary', 'status', 'priority', 'assignee', 'reporter', 'created', 'updated', 'description'],
          expand: 'names,schema'
        };

        if (nextPageToken) {
          requestBody.nextPageToken = nextPageToken;
        }
        
        console.log('[Export Debug] POST body:', JSON.stringify(requestBody));
        console.log('[Export Debug] JQL being sent:', effectiveJql);
        
        const searchResponse = await api.asApp().requestJira(
          route`/rest/api/3/search/jql`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
          }
        );

        if (!searchResponse.ok) {
          const errorText = await searchResponse.text();
          return { success: false, error: `Search failed: ${errorText}` };
        }

        const searchData = await searchResponse.json();
        if (typeof searchData.total === 'number') {
          total = searchData.total;
        } else {
          total = Math.max(total, exportedIssues.length + (searchData.issues?.length || 0));
        }

        if (!Array.isArray(searchData.issues) || searchData.issues.length === 0) {
          break;
        }

        for (const issue of searchData.issues) {
          if (exportedIssues.length >= maxResults) {
            break;
          }

          const expandParts = ['renderedFields', 'names'];
          if (includeChangelog) {
            expandParts.push('changelog');
          }
          const expandParam = expandParts.join(',');
          const issueResponse = await api.asApp().requestJira(
            route`/rest/api/3/issue/${issue.key}?expand=${expandParam}`
          );

          if (!issueResponse.ok) {
            const errorText = await issueResponse.text();
            return { success: false, error: `Failed to fetch ${issue.key}: ${errorText}` };
          }

          const issueDetail = await issueResponse.json();
          const issueFields = issueDetail.fields || {};

          if (!includeComments && issueFields.comment) {
            delete issueFields.comment;
          }
          if (!includeAttachments && issueFields.attachment) {
            delete issueFields.attachment;
          }
          if (!includeIssueLinks && issueFields.issuelinks) {
            delete issueFields.issuelinks;
          }

          const exportRecord = {
            key: issueDetail.key,
            id: issueDetail.id,
            self: issueDetail.self,
            fields: issueFields,
            renderedFields: issueDetail.renderedFields,
            names: issueDetail.names,
            remoteMappings: await getAllRemoteKeys(issueDetail.key)
          };

          if (includeComments) {
            const comments = issueDetail.fields?.comment?.comments || [];
            exportRecord.comments = comments.map(comment => ({
              id: comment.id,
              body: comment.body,
              created: comment.created,
              updated: comment.updated,
              author: comment.author,
              updateAuthor: comment.updateAuthor
            }));
          }

          if (includeAttachments) {
            const attachments = issueDetail.fields?.attachment || [];
            exportRecord.attachments = attachments.map(attachment => ({
              id: attachment.id,
              filename: attachment.filename,
              mimeType: attachment.mimeType,
              size: attachment.size,
              content: attachment.content
            }));
          }

          if (includeIssueLinks) {
            exportRecord.issueLinks = issueDetail.fields?.issuelinks || [];
          }

          if (includeChangelog && issueDetail.changelog) {
            exportRecord.changelog = issueDetail.changelog;
          }

          exportedIssues.push(exportRecord);
        }

        nextPageToken = searchData.nextPageToken || null;
        if (!nextPageToken) {
          break;
        }
      }

      return {
        success: true,
        data: {
          exportedAt: new Date().toISOString(),
          sourceOrg,
          query: jql,
          effectiveQuery: effectiveJql,
          totalMatches: total,
          issueCount: exportedIssues.length,
          options: {
            maxResults,
            includeComments,
            includeAttachments,
            includeChangelog,
            includeIssueLinks
          },
          issues: exportedIssues
        }
      };
    } catch (error) {
      console.error('Error exporting issues:', error);
      return { success: false, error: error.message };
    }
  });

  resolver.define('importIssues', async ({ payload }) => {
    try {
      const orgId = payload?.orgId;
      const issueKeys = Array.isArray(payload?.issueKeys) ? payload.issueKeys.filter(Boolean) : [];
      const options = payload?.options || {};
      const snapshots = payload?.snapshots || {};

      if (!orgId) {
        return { success: false, error: 'orgId is required' };
      }

      if (issueKeys.length === 0) {
        return { success: false, error: 'No issue keys provided for import' };
      }

      const orgs = await storage.get('organizations') || [];
      const org = orgs.find(o => o.id === orgId);
      if (!org) {
        return { success: false, error: 'Organization not found' };
      }

      const storageOrgId = org.id === 'legacy' ? null : org.id;

      const [userMappings, fieldMappings, statusMappings, syncOptions] = await Promise.all([
        storage.get(storageOrgId ? `userMappings:${storageOrgId}` : 'userMappings'),
        storage.get(storageOrgId ? `fieldMappings:${storageOrgId}` : 'fieldMappings'),
        storage.get(storageOrgId ? `statusMappings:${storageOrgId}` : 'statusMappings'),
        storage.get(storageOrgId ? `syncOptions:${storageOrgId}` : 'syncOptions')
      ]);

      const mappings = {
        userMappings: userMappings || {},
        fieldMappings: fieldMappings || {},
        statusMappings: statusMappings || {}
      };

      const forceRecreate = !!options.forceRecreate;
      const skipIfRemoteExists = !!options.skipIfRemoteExists;
      const refreshFromSource = options.refreshFromSource !== false;

      const results = {
        processed: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        errors: []
      };

      for (const issueKey of issueKeys) {
        results.processed++;
        try {
          let issueData = null;

          if (refreshFromSource) {
            issueData = await getFullIssue(issueKey);
          }

          if (!issueData && snapshots[issueKey]) {
            issueData = snapshots[issueKey];
          }

          if (!issueData) {
            results.skipped++;
            results.errors.push({ issueKey, message: 'Issue not found in source environment' });
            continue;
          }

          issueData.key = issueData.key || issueKey;

          let remoteKey = await getRemoteKey(issueKey, storageOrgId);

          if (!remoteKey && Array.isArray(snapshots[issueKey]?.remoteMappings)) {
            const hint = snapshots[issueKey].remoteMappings.find(entry => entry.orgId === org.id || entry.orgId === storageOrgId);
            if (hint?.remoteKey) {
              remoteKey = hint.remoteKey;
            }
          }

          if (remoteKey && forceRecreate) {
            await removeMapping(issueKey, remoteKey, storageOrgId);
            remoteKey = null;
          }

          if (remoteKey && skipIfRemoteExists) {
            results.skipped++;
            continue;
          }

          if (remoteKey) {
            await updateIssueForOrg(issueKey, remoteKey, issueData, org, mappings, syncOptions || {});
            results.updated++;
          } else {
            const createdKey = await createIssueForOrg(issueData, org, mappings, syncOptions || {});
            if (createdKey) {
              results.created++;
            } else {
              throw new Error('Remote issue creation failed');
            }
          }
        } catch (error) {
          console.error(`Error importing ${issueKey}:`, error);
          results.errors.push({ issueKey, message: error.message });
        }
      }

      return { success: true, results };
    } catch (error) {
      console.error('Error importing issues:', error);
      return { success: false, error: error.message };
    }
  });
}
