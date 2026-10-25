import api, { route } from '@forge/api';
import { syncIssue } from '../services/sync/issue-sync.js';
import { LOG_EMOJI, LINK_CREATED_EVENT } from '../constants.js';
import { extractLinkEventFields, describeLinkEventFields } from './link-event-fields.js';

async function resolveIssueKey(issueId, label) {
  if (!issueId) return null;

  const response = await api.asApp().requestJira(
    route`/rest/api/3/issue/${issueId}`
  );
  if (!response.ok) {
    console.log(`${LOG_EMOJI.WARNING} Could not fetch ${label} issue ${issueId}: ${response.status}`);
    return null;
  }

  const issue = await response.json();
  return issue.key ?? null;
}

/**
 * syncIssue expects an issue-update event, but Forge issue-link events carry no
 * changelog. Without an explicit marker a mapped issue whose field hash still
 * matches the connector's last write is mistaken for an app-caused echo and the
 * link never reaches the destination. Only a verified, user-initiated link event
 * is tagged; events the app generated keep the echo gate in place.
 */
function buildLinkSyncEvent(issueKey, linkEvent) {
  const syncEvent = {
    eventType: 'avi:jira:updated:issue',
    issue: { key: issueKey }
  };

  if (linkEvent?.eventType === LINK_CREATED_EVENT && linkEvent.selfGenerated !== true) {
    syncEvent.linkChange = { eventType: LINK_CREATED_EVENT, userInitiated: true };
  }

  return syncEvent;
}

export async function run(event, context) {
  console.log(`${LOG_EMOJI.LINK} Link creation trigger fired`);
  
  try {
    // Forge issue-link events carry both endpoint issue IDs at the payload root
    const { sourceIssueId, destinationIssueId } = extractLinkEventFields(event);

    const sourceIssueKey = await resolveIssueKey(sourceIssueId, 'source');
    const targetIssueKey = await resolveIssueKey(destinationIssueId, 'destination');
    
    // Sync target issue first (e.g., the Epic) if it exists
    // This ensures the target is synced before we try to create the link
    if (targetIssueKey) {
      console.log(`${LOG_EMOJI.LINK} Syncing target issue first: ${targetIssueKey}`);
      await syncIssue(buildLinkSyncEvent(targetIssueKey, event));
    }
    
    // Now sync source issue (which will pick up the link)
    if (sourceIssueKey) {
      console.log(`${LOG_EMOJI.LINK} Syncing source issue: ${sourceIssueKey}`);
      await syncIssue(buildLinkSyncEvent(sourceIssueKey, event));
    }
    
    if (!sourceIssueKey && !targetIssueKey) {
      console.log(`${LOG_EMOJI.WARNING} Could not determine issue keys from link event (fields: ${describeLinkEventFields(event)})`);
    }
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error processing link creation:`, error);
  }
}
