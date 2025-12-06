import api, { route, fetch } from '@forge/api';
import * as kvsStore from '../services/storage/kvs.js';
import { getOrganizationsWithTokens } from '../services/storage/mappings.js';

export function defineDiagnosticsResolvers(resolver) {
  
  // Comprehensive Health Check (Read-Only)
  resolver.define('runHealthCheck', async ({ payload }) => {
    const { orgId } = payload;
    const results = {
      steps: [],
      success: true
    };

    try {
      // 1. Load Config
      const orgs = await getOrganizationsWithTokens();
      const org = orgs.find(o => o.id === orgId);
      
      if (!org) throw new Error('Organization not found');
      
      results.steps.push({ name: 'Load Configuration', status: 'success', message: `Loaded config for ${org.name}` });

      const auth = Buffer.from(`${org.remoteEmail}:${org.remoteApiToken}`).toString('base64');
      const headers = {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      };

      // 2. Check Authentication (Remote)
      const myselfRes = await fetch(`${org.remoteUrl}/rest/api/3/myself`, { headers });
      if (!myselfRes.ok) throw new Error(`Authentication failed: ${myselfRes.status}`);
      const user = await myselfRes.json();
      results.steps.push({ name: 'Remote Authentication', status: 'success', message: `Authenticated as ${user.displayName}` });

      // 3. Check Remote Project Access
      const projectRes = await fetch(`${org.remoteUrl}/rest/api/3/project/${org.remoteProjectKey}`, { headers });
      if (!projectRes.ok) {
        if (projectRes.status === 404) throw new Error(`Project ${org.remoteProjectKey} not found or not accessible`);
        throw new Error(`Project check failed: ${projectRes.status}`);
      }
      results.steps.push({ name: 'Remote Project Access', status: 'success', message: `Found project ${org.remoteProjectKey}` });

      // 4. Check Create Permissions (Remote)
      const permRes = await fetch(`${org.remoteUrl}/rest/api/3/mypermissions?projectKey=${org.remoteProjectKey}&permissions=CREATE_ISSUES,EDIT_ISSUES,DELETE_ISSUES`, { headers });
      if (permRes.ok) {
        const perms = await permRes.json();
        const permissions = perms.permissions;
        
        if (permissions.CREATE_ISSUES.havePermission) {
          results.steps.push({ name: 'Create Permission', status: 'success', message: 'Can create issues' });
        } else {
          results.steps.push({ name: 'Create Permission', status: 'error', message: 'Missing CREATE_ISSUES permission' });
          results.success = false;
        }

        if (permissions.EDIT_ISSUES.havePermission) {
          results.steps.push({ name: 'Edit Permission', status: 'success', message: 'Can edit issues' });
        } else {
          results.steps.push({ name: 'Edit Permission', status: 'warning', message: 'Missing EDIT_ISSUES permission (sync updates will fail)' });
        }
      }

      // 5. Check Local Permissions (App)
      try {
        const localPermRes = await api.asApp().requestJira(route`/rest/api/3/mypermissions?permissions=CREATE_ISSUES`);
        if (localPermRes.ok) {
          const localPerms = await localPermRes.json();
          if (localPerms.permissions.CREATE_ISSUES.havePermission) {
            results.steps.push({ name: 'Local App Permissions', status: 'success', message: 'App has CREATE_ISSUES permission' });
          } else {
            results.steps.push({ name: 'Local App Permissions', status: 'error', message: 'App missing CREATE_ISSUES permission' });
            results.success = false;
          }
        }
      } catch (e) {
        results.steps.push({ name: 'Local App Permissions', status: 'warning', message: `Could not check local permissions: ${e.message}` });
      }

    } catch (error) {
      results.success = false;
      results.steps.push({ name: 'Fatal Error', status: 'error', message: error.message });
    }

    return results;
  });

  // Full System Test (Write Operations)
  resolver.define('runSystemTest', async ({ payload }) => {
    const { orgId } = payload;
    const logs = [];
    const log = (msg) => logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);

    try {
      log('🚀 Starting System Test...');
      
      // 1. Load Config
      const orgs = await getOrganizationsWithTokens();
      const org = orgs.find(o => o.id === orgId);
      if (!org) throw new Error('Organization not found');

      const auth = Buffer.from(`${org.remoteEmail}:${org.remoteApiToken}`).toString('base64');
      const headers = {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      };

      // 2. Create Local Issue
      log('Creating test issue in Local Jira...');
      const createRes = await api.asApp().requestJira(route`/rest/api/3/issue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            project: { key: 'TEST' }, // TODO: Need to know which local project to use. For now, we might fail if TEST doesn't exist.
            summary: `[System Test] Auto-generated ${Date.now()}`,
            issuetype: { name: 'Task' }
          }
        })
      });

      if (!createRes.ok) {
        const err = await createRes.text();
        throw new Error(`Failed to create local issue: ${err}`);
      }

      const createdIssue = await createRes.json();
      const localKey = createdIssue.key;
      log(`✅ Created Local Issue: ${localKey}`);

      // 3. Wait for Sync (Short wait due to 25s timeout limit)
      log('Waiting 5s for sync...');
      await new Promise(r => setTimeout(r, 5000));

      // 4. Check Remote
      log(`Checking Remote Jira (${org.remoteUrl})...`);
      const searchRes = await fetch(`${org.remoteUrl}/rest/api/3/search?jql=summary ~ "${localKey}"`, { headers });
      
      if (!searchRes.ok) throw new Error('Failed to search remote Jira');
      
      const searchData = await searchRes.json();
      if (searchData.issues && searchData.issues.length > 0) {
        const remoteKey = searchData.issues[0].key;
        log(`✅ Sync Successful! Found Remote Issue: ${remoteKey}`);
        
        // 5. Cleanup (Delete Local)
        log(`Cleaning up (Deleting ${localKey})...`);
        await api.asApp().requestJira(route`/rest/api/3/issue/${localKey}`, { method: 'DELETE' });
        log(`✅ Deleted ${localKey}`);
        
        return { success: true, logs };
      } else {
        // Cleanup even if failed
        await api.asApp().requestJira(route`/rest/api/3/issue/${localKey}`, { method: 'DELETE' });
        throw new Error('Sync timed out or failed - Issue not found in Remote');
      }

    } catch (error) {
      log(`❌ Test Failed: ${error.message}`);
      return { success: false, logs, error: error.message };
    }
  });
}
