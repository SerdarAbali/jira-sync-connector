import api, { route, fetch } from '../services/jira/guarded-api.js';
import { getRemoteKey, getOrganizationsWithTokens, removeLinkMapping } from '../services/storage/mappings.js';
import { assertPilotWritesAllowed } from '../services/sync/pilot-pause.js';
import { assertOutboundRemoteScope } from '../services/sync/outbound-scope.js';
import { extractLinkEventFields, describeLinkEventFields } from './link-event-fields.js';

export async function run(event, context) {
  console.log(`🔗🗑️ Link deleted trigger fired`);

  try {
    // Forge issue-link events carry the link ID and both endpoint issue IDs at the payload root
    const { linkId, sourceIssueId, destinationIssueId, linkTypeName } = extractLinkEventFields(event);

    if (!linkId) {
      console.log(`⚠️ Could not determine link ID from delete event (fields: ${describeLinkEventFields(event)})`);
      return;
    }

    // Get source and destination issue info
    let sourceIssueKey = null;
    let destinationIssueKey = null;

    if (sourceIssueId) {
      try {
        const response = await api.asApp().requestJira(
          route`/rest/api/3/issue/${sourceIssueId}`
        );
        if (response.ok) {
          const issue = await response.json();
          sourceIssueKey = issue.key;
        }
      } catch (e) {
        console.log(`⚠️ Could not fetch source issue: ${e.message}`);
      }
    }

    if (destinationIssueId) {
      try {
        const response = await api.asApp().requestJira(
          route`/rest/api/3/issue/${destinationIssueId}`
        );
        if (response.ok) {
          const issue = await response.json();
          destinationIssueKey = issue.key;
        }
      } catch (e) {
        console.log(`⚠️ Could not fetch destination issue: ${e.message}`);
      }
    }

    if (!sourceIssueKey || !destinationIssueKey) {
      console.log(`⚠️ Could not determine both issue keys for link deletion (fields: ${describeLinkEventFields(event)})`);
      return;
    }

    console.log(`🔗🗑️ Link deleted: ${sourceIssueKey} → ${destinationIssueKey} (${linkTypeName})`);

    // Get all organizations
    const organizations = await getOrganizationsWithTokens();

    if (organizations.length === 0) {
      console.log(`⚠️ No organizations configured`);
      return;
    }

    // Delete link from each org
    for (const org of organizations) {
      const orgId = org.id === 'legacy' ? null : org.id;
      
      // Get remote keys for both issues
      const remoteSourceKey = await getRemoteKey(sourceIssueKey, orgId);
      const remoteDestKey = await getRemoteKey(destinationIssueKey, orgId);

      if (!remoteSourceKey || !remoteDestKey) {
        console.log(`⏭️ One or both issues not synced to ${org.id || 'organization'}, skipping link deletion`);
        continue;
      }

      console.log(`🔗🗑️ Looking for link ${remoteSourceKey} → ${remoteDestKey} in ${org.id || 'organization'}`);

      const auth = Buffer.from(`${org.remoteEmail}:${org.remoteApiToken}`).toString('base64');

      try {
        // First, find the link on remote by fetching the issue's links
        const issueResponse = await fetch(
          `${org.remoteUrl}/rest/api/3/issue/${remoteSourceKey}?fields=issuelinks`,
          {
            method: 'GET',
            headers: {
              'Authorization': `Basic ${auth}`,
              'Content-Type': 'application/json'
            }
          }
        );

        if (!issueResponse.ok) {
          console.log(`⚠️ Could not fetch remote issue ${remoteSourceKey}`);
          continue;
        }

        const remoteIssue = await issueResponse.json();
        const remoteLinks = remoteIssue.fields?.issuelinks || [];

        // Find the matching link
        const matchingLink = remoteLinks.find(link => {
          const linkedKey = link.outwardIssue?.key || link.inwardIssue?.key;
          return linkedKey === remoteDestKey && 
                 (link.type.name === linkTypeName || !linkTypeName);
        });

        if (!matchingLink) {
          console.log(`⏭️ Link not found on remote, may have been already deleted`);
          continue;
        }

        // Delete the link
        await assertPilotWritesAllowed('link_delete_remote');
        await assertOutboundRemoteScope({ orgId, remoteKeys: [remoteSourceKey, remoteDestKey] });
        const deleteResponse = await fetch(
          `${org.remoteUrl}/rest/api/3/issueLink/${matchingLink.id}`,
          {
            method: 'DELETE',
            headers: {
              'Authorization': `Basic ${auth}`,
              'Content-Type': 'application/json'
            }
          }
        );

        if (deleteResponse.ok || deleteResponse.status === 204) {
          console.log(`✅ Deleted link ${matchingLink.id} from ${org.id || 'organization'}`);
          // Remove the link mapping
          await removeLinkMapping(linkId, orgId);
        } else {
          console.error(`❌ Failed to delete link from ${org.id || 'organization'}`);
        }
      } catch (error) {
        console.error(`❌ Error deleting link from ${org.id || 'organization'}:`, error);
      }
    }

    console.log(`✅ Completed link deletion processing`);
  } catch (error) {
    console.error(`❌ Error processing link deletion:`, error);
  }
}
