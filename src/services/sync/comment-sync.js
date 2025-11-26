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

  // Get all organizations
  const organizations = await storage.get('organizations') || [];
  
  // Legacy support: check for old single-org config
  const legacyConfig = await storage.get('syncConfig');
  if (legacyConfig && legacyConfig.remoteUrl && organizations.length === 0) {
    console.log('⚠️ Using legacy single-org config for comment sync');
    organizations.push({
      id: 'legacy',
      name: 'Legacy Organization',
      ...legacyConfig
    });
  }

  if (organizations.length === 0) {
    console.log('Comment sync skipped: no organizations configured');
    await trackWebhookSync('comment', false, 'No organizations configured', null, issueKey, {
      reason: 'No target organizations configured in settings',
      commentId
    });
    return;
  }

  // Get issue to check project
  const issue = await getFullIssue(issueKey);
  if (!issue) {
    console.log('Could not fetch issue data for comment sync');
    await trackWebhookSync('comment', false, 'Could not fetch issue data', null, issueKey, {
      reason: 'Failed to retrieve issue from Jira API',
      commentId
    });
    return;
  }

  const projectKey = issue.fields.project.key;
  const fullComment = await getFullComment(issueKey, commentId);
  if (!fullComment) {
    console.log('Could not fetch full comment data');
    await trackWebhookSync('comment', false, 'Could not fetch comment data', null, issueKey, {
      reason: 'Failed to retrieve comment from Jira API',
      commentId,
      projectKey
    });
    return;
  }

  const orgName = await getOrgName();
  const userName = fullComment.author?.displayName || fullComment.author?.emailAddress || 'Unknown User';

  let commentText = '';
  if (fullComment.body && typeof fullComment.body === 'object') {
    commentText = extractTextFromADF(fullComment.body);
  } else {
    commentText = fullComment.body || '';
  }

  const commentBody = textToADFWithAuthor(commentText, orgName, userName);

  // Sync comment to all organizations
  for (const org of organizations) {
    const orgId = org.id === 'legacy' ? null : org.id;

    // Check if comment sync is enabled for this org
    const syncOptionsKey = org.id === 'legacy' ? 'syncOptions' : `syncOptions:${org.id}`;
    const syncOptions = await storage.get(syncOptionsKey) || { syncComments: true };
    if (!syncOptions.syncComments) {
      console.log(`⏭️ Comment sync skipped for ${org.name}: disabled in sync options`);
      continue;
    }

    // Check if project is allowed to sync for this org
    const isAllowed = await isProjectAllowedToSync(projectKey, org);
    if (!isAllowed) {
      console.log(`⏭️ Skipping comment on ${issueKey} for ${org.name} - project ${projectKey} not in allowed list`);
      continue;
    }

    const remoteKey = await getRemoteKey(issueKey, orgId);
    if (!remoteKey) {
      console.log(`No remote issue found for ${issueKey} in ${org.name}`);
      continue;
    }

    const auth = Buffer.from(`${org.remoteEmail}:${org.remoteApiToken}`).toString('base64');
    const syncResult = new SyncResult('comment');

    try {
      console.log(`${LOG_EMOJI.COMMENT} Syncing comment to ${org.name}: ${issueKey} → ${remoteKey} (from ${orgName} - ${userName})`);

      const response = await retryWithBackoff(async () => {
        return await fetch(
          `${org.remoteUrl}/rest/api/3/issue/${remoteKey}/comment`,
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
        console.log(`${LOG_EMOJI.SUCCESS} Comment synced to ${org.name} (${remoteKey})`);
        syncResult.details.comments.success++;
        await trackWebhookSync('comment', true, null, org.id, issueKey, {
          remoteKey,
          projectKey,
          commentId,
          author: userName
        });
      } else {
        const errorText = await response.text();
        console.error(`${LOG_EMOJI.ERROR} Comment sync failed for ${org.name}: ${errorText}`);
        syncResult.details.comments.failed++;
        syncResult.addError(`Comment sync failed: ${errorText}`);
        await trackWebhookSync('comment', false, errorText, org.id, issueKey, {
          remoteKey,
          projectKey,
          commentId,
          author: userName,
          httpStatus: response.status,
          errorDetails: errorText
        });
      }
    } catch (error) {
      console.error(`${LOG_EMOJI.ERROR} Error syncing comment to ${org.name}:`, error);
      syncResult.details.comments.failed++;
      syncResult.addError(`Error syncing comment: ${error.message}`);
      await trackWebhookSync('comment', false, error.message, org.id, issueKey, {
        remoteKey,
        projectKey,
        commentId,
        author: userName,
        errorStack: error.stack,
        errorDetails: error.toString()
      });
    }

    // Log summary for this org
    syncResult.logSummary(issueKey, remoteKey, org.name);
  }

  console.log(`\n✅ Completed comment sync for ${issueKey} across ${organizations.length} organization(s)`);
}
