import api, { route } from '@forge/api';
import { syncIssue } from '../services/sync/issue-sync.js';

export async function run(event, context) {
  console.log(`🔗 Link creation trigger fired`);
  console.log(`🔗 Link event:`, JSON.stringify(event, null, 2));
  
  // The link event contains information about both issues in the link
  // We need to trigger a sync for the source issue to pick up the new link
  try {
    // Try to get the issue key from the event
    let issueKey = null;
    
    if (event.issueLink && event.issueLink.sourceIssueId) {
      // Fetch the source issue to get its key
      const response = await api.asApp().requestJira(
        route`/rest/api/3/issue/${event.issueLink.sourceIssueId}`
      );
      const issue = await response.json();
      issueKey = issue.key;
    }
    
    if (issueKey) {
      console.log(`🔗 Triggering sync for issue: ${issueKey}`);
      // Create a synthetic event to trigger sync
      const syntheticEvent = {
        eventType: 'avi:jira:updated:issue',
        issue: { key: issueKey }
      };
      await syncIssue(syntheticEvent);
    } else {
      console.log(`⚠️ Could not determine issue key from link event`);
    }
  } catch (error) {
    console.error(`❌ Error processing link creation:`, error);
  }
}
