import api, { route } from '@forge/api';
import { syncIssue } from '../services/sync/issue-sync.js';
import { LOG_EMOJI } from '../constants.js';

export async function run(event, context) {
  console.log(`${LOG_EMOJI.LINK} Link creation trigger fired`);
  console.log(`${LOG_EMOJI.LINK} Link event:`, JSON.stringify(event, null, 2));
  
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
        if (!response.ok) {
          console.log(`${LOG_EMOJI.WARNING} Could not fetch source issue ${event.issueLink.sourceIssueId}: ${response.status}`);
        } else {
          const issue = await response.json();
          sourceIssueKey = issue.key;
        }
      }
      
      // Get target/destination issue
      if (event.issueLink.destinationIssueId) {
        const response = await api.asApp().requestJira(
          route`/rest/api/3/issue/${event.issueLink.destinationIssueId}`
        );
        if (!response.ok) {
          console.log(`${LOG_EMOJI.WARNING} Could not fetch destination issue ${event.issueLink.destinationIssueId}: ${response.status}`);
        } else {
          const issue = await response.json();
          targetIssueKey = issue.key;
        }
      }
    }
    
    // Sync target issue first (e.g., the Epic) if it exists
    // This ensures the target is synced before we try to create the link
    if (targetIssueKey) {
      console.log(`${LOG_EMOJI.LINK} Syncing target issue first: ${targetIssueKey}`);
      const targetEvent = {
        eventType: 'avi:jira:updated:issue',
        issue: { key: targetIssueKey }
      };
      await syncIssue(targetEvent);
    }
    
    // Now sync source issue (which will pick up the link)
    if (sourceIssueKey) {
      console.log(`${LOG_EMOJI.LINK} Syncing source issue: ${sourceIssueKey}`);
      const sourceEvent = {
        eventType: 'avi:jira:updated:issue',
        issue: { key: sourceIssueKey }
      };
      await syncIssue(sourceEvent);
    }
    
    if (!sourceIssueKey && !targetIssueKey) {
      console.log(`${LOG_EMOJI.WARNING} Could not determine issue keys from link event`);
    }
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error processing link creation:`, error);
  }
}
