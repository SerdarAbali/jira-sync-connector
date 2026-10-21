import api, { route, fetch } from '@forge/api';
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
      
      results.steps.push({ name: 'Load Configuration', status: 'success', message: 'Organization configuration loaded' });

      const auth = Buffer.from(`${org.remoteEmail}:${org.remoteApiToken}`).toString('base64');
      const headers = {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      };

      // 2. Check Authentication (Remote)
      const myselfRes = await fetch(`${org.remoteUrl}/rest/api/3/myself`, { headers });
      if (!myselfRes.ok) throw new Error('Authentication check failed');
      await myselfRes.json();
      results.steps.push({ name: 'Remote Authentication', status: 'success', message: 'Remote authentication succeeded' });

      // 3. Check Remote Project Access
      const projectRes = await fetch(`${org.remoteUrl}/rest/api/3/project/${org.remoteProjectKey}`, { headers });
      if (!projectRes.ok) {
        if (projectRes.status === 404) throw new Error('Remote project not found or not accessible');
        throw new Error('Remote project check failed');
      }
      results.steps.push({ name: 'Remote Project Access', status: 'success', message: 'Remote project accessible' });

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
        results.steps.push({ name: 'Local App Permissions', status: 'warning', message: 'Could not verify local permissions' });
      }

    } catch (error) {
      results.success = false;
      results.steps.push({ name: 'Fatal Error', status: 'error', message: 'Health check failed' });
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
        results.discrepancies.push('Summary mismatch');
      }

      // Status
      results.details.status = {
        match: localIssue.fields.status?.name === remoteIssue.fields.status?.name
      };

      // Attachments
      const localAttachments = localIssue.fields.attachment || [];
      const remoteAttachments = remoteIssue.fields.attachment || [];
      
      results.details.attachments = { local: localAttachments.length, remote: remoteAttachments.length };
      
      if (localAttachments.length !== remoteAttachments.length) {
        results.discrepancies.push('Attachment count mismatch');
      }

      // Check for missing attachments by filename/size
      const missingAttachments = localAttachments.filter(localAtt => {
        return !remoteAttachments.some(remoteAtt => 
          remoteAtt.filename === localAtt.filename && remoteAtt.size === localAtt.size
        );
      });

      if (missingAttachments.length > 0) {
        results.discrepancies.push(`Missing attachment count: ${missingAttachments.length}`);
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
      results.error = 'VERIFICATION_FAILED';
    }

    return results;
  });

  // The destructive system test is intentionally disabled for corporate pilot
  // safety. It performs zero Jira writes and zero deletes. Use the existing
  // read-only runHealthCheck resolver instead.
  resolver.define('runSystemTest', async () => ({
    success: false,
    disabled: true,
    code: 'SYSTEM_TEST_DISABLED',
    error: 'System test is disabled in production/pilot builds.',
    message: 'No Jira writes or deletes were performed. Use the read-only health check instead.'
  }));

}
