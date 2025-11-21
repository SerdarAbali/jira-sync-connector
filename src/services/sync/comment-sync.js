import { storage, fetch } from '@forge/api';
import { LOG_EMOJI } from '../../constants.js';
import { retryWithBackoff } from '../../utils/retry.js';
import { extractTextFromADF, textToADFWithAuthor } from '../../utils/adf.js';
import { getRemoteKey, getLocalKey } from '../storage/mappings.js';
import { getFullIssue, getFullComment, getOrgName } from '../jira/local-client.js';
import { trackWebhookSync } from '../storage/stats.js';
import { isProjectAllowedToSync } from '../../utils/validation.js';
import { SyncResult } from './sync-result.js';

export async function syncComment(event) {
  const issueKey = event.issue.key;
  const commentId = event.comment?.id;
  const config = await storage.get('syncConfig');

  if (!config || !config.remoteUrl) {
    console.log('Comment sync skipped: not configured');
    await trackWebhookSync('comment', false, 'Not configured');
    return;
  }

  // Check if comment sync is enabled
  const syncOptions = await storage.get('syncOptions') || { syncComments: true };
  if (!syncOptions.syncComments) {
    console.log('⏭️ Comment sync skipped: disabled in sync options');
    return;
  }

  // Get issue to check project
  const issue = await getFullIssue(issueKey);
  if (!issue) {
    console.log('Could not fetch issue data for comment sync');
    await trackWebhookSync('comment', false, 'Could not fetch issue data');
    return;
  }

  // Check if project is allowed to sync
  const projectKey = issue.fields.project.key;
  const isAllowed = await isProjectAllowedToSync(projectKey, config);
  if (!isAllowed) {
    console.log(`⏭️ Skipping comment on ${issueKey} - project ${projectKey} not in allowed list`);
    await trackWebhookSync('comment', false, `Project ${projectKey} not allowed`);
    return;
  }

  const remoteKey = await getRemoteKey(issueKey);
  if (!remoteKey) {
    console.log(`No remote issue found for ${issueKey}`);
    await trackWebhookSync('comment', false, `No remote issue found for ${issueKey}`);
    return;
  }

  const fullComment = await getFullComment(issueKey, commentId);
  if (!fullComment) {
    console.log('Could not fetch full comment data');
    await trackWebhookSync('comment', false, 'Could not fetch comment data');
    return;
  }

  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
  const orgName = await getOrgName();
  const userName = fullComment.author?.displayName || fullComment.author?.emailAddress || 'Unknown User';

  let commentText = '';
  if (fullComment.body && typeof fullComment.body === 'object') {
    commentText = extractTextFromADF(fullComment.body);
  } else {
    commentText = fullComment.body || '';
  }

  const commentBody = textToADFWithAuthor(commentText, orgName, userName);

  // Create sync result tracker for comment
  const syncResult = new SyncResult('comment');

  try {
    console.log(`${LOG_EMOJI.COMMENT} Syncing comment: ${issueKey} → ${remoteKey} (from ${orgName} - ${userName})`);

    const response = await retryWithBackoff(async () => {
      return await fetch(
        `${config.remoteUrl}/rest/api/3/issue/${remoteKey}/comment`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ body: commentBody })
        }
      );
    }, `Sync comment to ${remoteKey}`);

    if (response.ok) {
      console.log(`${LOG_EMOJI.SUCCESS} Comment synced to ${remoteKey}`);
      syncResult.details.comments.success++;
      await trackWebhookSync('comment', true);
    } else {
      const errorText = await response.text();
      console.error(`${LOG_EMOJI.ERROR} Comment sync failed: ${errorText}`);
      syncResult.details.comments.failed++;
      syncResult.addError(`Comment sync failed: ${errorText}`);
      await trackWebhookSync('comment', false, errorText);
    }
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error syncing comment:`, error);
    syncResult.details.comments.failed++;
    syncResult.addError(`Error syncing comment: ${error.message}`);
    await trackWebhookSync('comment', false, error.message);
  }

  // Log summary
  syncResult.logSummary(issueKey, remoteKey);
}
