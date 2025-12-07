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

  // Deep Verification of a Single Issue
  resolver.define('verifyIssueSync', async ({ payload }) => {
    const { issueKey, orgId } = payload;
    const results = {
      localKey: issueKey,
      remoteKey: null,
      synced: false,
      discrepancies: [],
      details: {}
    };

    try {
      // 1. Get Organization
      const orgs = await getOrganizationsWithTokens();
      const org = orgs.find(o => o.id === orgId);
      if (!org) throw new Error('Organization not found');

      // 2. Get Local Issue
      const { getFullIssue } = await import('../services/jira/local-client.js');
      const localIssue = await getFullIssue(issueKey);
      if (!localIssue) throw new Error(`Local issue ${issueKey} not found`);

      // 3. Get Mapping
      const { getRemoteKey } = await import('../services/storage/mappings.js');
      const remoteKey = await getRemoteKey(issueKey, org.id === 'legacy' ? null : org.id);
      results.remoteKey = remoteKey;

      if (!remoteKey) {
        results.discrepancies.push('No remote mapping found');
        return results;
      }

      // 4. Get Remote Issue
      const auth = Buffer.from(`${org.remoteEmail}:${org.remoteApiToken}`).toString('base64');
      const remoteRes = await fetch(`${org.remoteUrl}/rest/api/3/issue/${remoteKey}`, {
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' }
      });

      if (!remoteRes.ok) {
        results.discrepancies.push(`Remote issue ${remoteKey} not found (Status: ${remoteRes.status})`);
        return results;
      }

      const remoteIssue = await remoteRes.json();
      results.synced = true;

      // 5. Compare Fields
      
      // Summary
      if (localIssue.fields.summary !== remoteIssue.fields.summary) {
        results.discrepancies.push(`Summary mismatch: "${localIssue.fields.summary}" vs "${remoteIssue.fields.summary}"`);
      }

      // Status
      // Note: Statuses might have different names/IDs, so we just report them
      results.details.status = { local: localIssue.fields.status.name, remote: remoteIssue.fields.status.name };

      // Attachments
      const localAttachments = localIssue.fields.attachment || [];
      const remoteAttachments = remoteIssue.fields.attachment || [];
      
      results.details.attachments = { local: localAttachments.length, remote: remoteAttachments.length };
      
      if (localAttachments.length !== remoteAttachments.length) {
        results.discrepancies.push(`Attachment count mismatch: ${localAttachments.length} vs ${remoteAttachments.length}`);
      }

      // Check for missing attachments by filename/size
      const missingAttachments = localAttachments.filter(localAtt => {
        return !remoteAttachments.some(remoteAtt => 
          remoteAtt.filename === localAtt.filename && remoteAtt.size === localAtt.size
        );
      });

      if (missingAttachments.length > 0) {
        missingAttachments.forEach(att => {
          results.discrepancies.push(`Missing attachment on remote: ${att.filename} (${att.size} bytes)`);
        });
      }

      // Comments
      const localComments = localIssue.fields.comment?.comments || [];
      const remoteComments = remoteIssue.fields.comment?.comments || [];
      
      // Note: Remote might have more comments (sync footer, etc), so we check if local count > remote count
      if (localComments.length > remoteComments.length) {
        results.discrepancies.push(`Comment count warning: Local (${localComments.length}) > Remote (${remoteComments.length})`);
      }
      results.details.comments = { local: localComments.length, remote: remoteComments.length };

    } catch (error) {
      results.error = error.message;
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
      
      // Determine a valid local project key
      // We'll try to use the first allowed project from the org config, or fallback to 'TEST'
      let localProjectKey = 'TEST';
      if (org.allowedProjects && org.allowedProjects.length > 0) {
        localProjectKey = org.allowedProjects[0];
      }
      
      log(`Using local project: ${localProjectKey}`);

      const testSummary = `[System Test] Auto-generated ${Date.now()}`;
      const createRes = await api.asApp().requestJira(route`/rest/api/3/issue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            project: { key: localProjectKey },
            summary: testSummary,
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

      // 3. Wait for Sync
      log('Waiting 15s for sync...');
      await new Promise(r => setTimeout(r, 15000));

      // 4. Verify Sync via Audit Log & Remote Check
      log(`Checking sync status...`);
      
      const auditLog = await kvsStore.get('auditLog') || [];
      const entry = auditLog.find(e => e.sourceIssue === localKey);
      
      let remoteKey = null;
      
      if (entry) {
        if (entry.success) {
          remoteKey = entry.targetIssue;
          log(`✅ Found successful sync record in audit log. Remote Key: ${remoteKey}`);
        } else {
          // Sync explicitly failed
          await api.asApp().requestJira(route`/rest/api/3/issue/${localKey}`, { method: 'DELETE' });
          throw new Error(`Sync failed: ${entry.errors ? entry.errors.join(', ') : 'Unknown error'}`);
        }
      } else {
        log(`⚠️ No audit log entry found for ${localKey}. Sync might be delayed or failed silently.`);
        
        // Fallback: Search by summary
        log(`Attempting fallback search by summary...`);
        const searchRes = await fetch(`${org.remoteUrl}/rest/api/3/search/jql`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jql: `project = "${org.remoteProjectKey}" AND summary ~ "\\"${testSummary}\\""`,
            fields: ['key', 'summary']
          })
        });
        
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          if (searchData.issues && searchData.issues.length > 0) {
            remoteKey = searchData.issues[0].key;
            log(`✅ Found remote issue via summary search: ${remoteKey}`);
          }
        }
      }

      if (remoteKey) {
        // Verify the issue actually exists on remote
        log(`Verifying remote issue ${remoteKey} exists...`);
        const remoteIssueRes = await fetch(`${org.remoteUrl}/rest/api/3/issue/${remoteKey}`, { headers });
        
        if (remoteIssueRes.ok) {
          log(`✅ Verified remote issue ${remoteKey} is accessible.`);
          
          // Cleanup Remote
          log(`Cleaning up Remote (Deleting ${remoteKey})...`);
          const delRemote = await fetch(`${org.remoteUrl}/rest/api/3/issue/${remoteKey}`, { 
            method: 'DELETE',
            headers
          });
          if (delRemote.ok) log(`✅ Deleted remote issue ${remoteKey}`);
          else log(`⚠️ Failed to delete remote issue ${remoteKey}: ${delRemote.status}`);
          
        } else {
          log(`❌ Remote issue ${remoteKey} not found (HTTP ${remoteIssueRes.status}). It might have been deleted.`);
          // We still consider this a failure of the test verification
          await api.asApp().requestJira(route`/rest/api/3/issue/${localKey}`, { method: 'DELETE' });
          throw new Error(`Sync reported success but remote issue ${remoteKey} could not be accessed.`);
        }
      } else {
        await api.asApp().requestJira(route`/rest/api/3/issue/${localKey}`, { method: 'DELETE' });
        throw new Error('Sync timed out - No audit log entry and issue not found via search.');
      }

      // Cleanup Local
      log(`Cleaning up Local (Deleting ${localKey})...`);
      await api.asApp().requestJira(route`/rest/api/3/issue/${localKey}`, { method: 'DELETE' });
      log(`✅ Deleted local issue ${localKey}`);

      return { success: true, logs };

    } catch (error) {
      log(`❌ Test Failed: ${error.message}`);
      return { success: false, logs, error: error.message };
    }
  });
}
