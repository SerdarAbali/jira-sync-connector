import api, { route, storage, fetch } from '@forge/api';

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
      statusData.forEach(issueType => {
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
        statuses: statuses
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
      statusData.forEach(issueType => {
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
        statuses: statuses
      };
    } catch (error) {
      console.error('Error fetching remote data:', error);
      throw error;
    }
  });
}
