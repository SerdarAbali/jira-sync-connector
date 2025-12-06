import { getRemoteKey, getOrganizationsWithTokens } from '../services/storage/mappings.js';
import { cleanupIssueData } from '../services/storage/cleanup.js';
import { fetch } from '@forge/api';

export async function run(event, context) {
  console.log(`🗑️ Issue deleted trigger fired`);
  console.log(`🗑️ Delete event:`, JSON.stringify(event, null, 2));

  try {
    const issueId = event.issue?.id;
    const issueKey = event.issue?.key;
    
    if (!issueKey && !issueId) {
      console.log(`⚠️ Could not determine issue from delete event`);
      return;
    }

    console.log(`🗑️ Processing deletion for issue: ${issueKey || issueId}`);

    // Get all organizations
    const organizations = await getOrganizationsWithTokens();
    
    if (organizations.length === 0) {
      console.log(`⚠️ No organizations configured`);
      return;
    }

    // Delete from each org where it was synced
    for (const org of organizations) {
      const orgId = org.id === 'legacy' ? null : org.id;
      const remoteKey = await getRemoteKey(issueKey, orgId);

      if (!remoteKey) {
        console.log(`⏭️ Issue ${issueKey} not synced to ${org.name}, skipping`);
        continue;
      }

      console.log(`🗑️ Found remote issue ${remoteKey} in ${org.name}, deleting...`);

      const auth = Buffer.from(`${org.remoteEmail}:${org.remoteApiToken}`).toString('base64');

      try {
        const response = await fetch(`${org.remoteUrl}/rest/api/3/issue/${remoteKey}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json'
          }
        });

        if (response.ok || response.status === 204) {
          console.log(`✅ Deleted remote issue ${remoteKey}`);
          // Use centralized cleanup
          await cleanupIssueData(issueKey, remoteKey, orgId);
        } else {
          console.error(`❌ Failed to delete remote issue ${remoteKey}: ${response.status}`);
        }
      } catch (error) {
        console.error(`Error deleting remote issue ${remoteKey}:`, error);
      }
    }
  } catch (error) {
    console.error(`Error processing issue deletion:`, error);
  }
}
