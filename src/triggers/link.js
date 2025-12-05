import api, { route } from '@forge/api';
import { syncIssue } from '../services/sync/issue-sync.js';

export async function run(event, context) {
  console.log(`🔗 Link creation trigger fired`);
  console.log(`🔗 Link event:`, JSON.stringify(event, null, 2));
  
  try {
    // Get both source and target issue keys from the link
    let sourceIssueKey = null;
    let targetIssueKey = null;
    
    if (event.issueLink) {
      // Get source issue
      if (event.issueLink.sourceIssueId) {
        const response = await api.asApp().requestJira(
          route`/rest/api/3/issue/${event.issueLink.sourceIssueId}`
        );
        const issue = await response.json();
        sourceIssueKey = issue.key;
      }
      
      // Get target/destination issue
      if (event.issueLink.destinationIssueId) {
        const response = await api.asApp().requestJira(
          route`/rest/api/3/issue/${event.issueLink.destinationIssueId}`
        );
        const issue = await response.json();
        targetIssueKey = issue.key;
      }
    }
    
    // Sync target issue first (e.g., the Epic) if it exists
    // This ensures the target is synced before we try to create the link
    if (targetIssueKey) {
      console.log(`🔗 Syncing target issue first: ${targetIssueKey}`);
      const targetEvent = {
        eventType: 'avi:jira:updated:issue',
        issue: { key: targetIssueKey }
      };
      await syncIssue(targetEvent);
    }
    
    // Now sync source issue (which will pick up the link)
    if (sourceIssueKey) {
      console.log(`🔗 Syncing source issue: ${sourceIssueKey}`);
      const sourceEvent = {
        eventType: 'avi:jira:updated:issue',
        issue: { key: sourceIssueKey }
      };
      await syncIssue(sourceEvent);
    }
    
    if (!sourceIssueKey && !targetIssueKey) {
      console.log(`⚠️ Could not determine issue keys from link event`);
    }
  } catch (error) {
    console.error(`❌ Error processing link creation:`, error);
  }
}
