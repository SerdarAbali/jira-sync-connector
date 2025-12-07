import api, { route, fetch } from '@forge/api';
import * as kvsStore from '../storage/kvs.js';
import { LOG_EMOJI } from '../../constants.js';
import { retryWithBackoff } from '../../utils/retry.js';
import { extractTextFromADF, textToADFWithAuthor } from '../../utils/adf.js';
import { getRemoteKey, getLocalKey, getOrganizationsWithTokens } from '../storage/mappings.js';
import { getFullIssue, getFullComment, getOrgName } from '../jira/local-client.js';
import { trackWebhookSync } from '../storage/stats.js';
import { isProjectAllowedToSync } from '../../utils/validation.js';
import { SyncResult } from './sync-result.js';
import { isSyncing } from '../storage/flags.js';

/**
 * Sync all comments from a local issue to a remote issue
 * Used during scheduled sync to catch missed comment webhooks
 */
export async function syncAllComments(localKey, remoteKey, issue, org, syncResult = null, orgId = null) {
  const auth = Buffer.from(`${org.remoteEmail}:${org.remoteApiToken}`).toString('base64');
  const orgName = await getOrgName();
  
  // Get all comments from local issue
  try {
    const commentsResponse = await api.asApp().requestJira(
      route`/rest/api/3/issue/${localKey}/comment?maxResults=100`,
      { method: 'GET' }
    );
    
    if (!commentsResponse.ok) {
      console.log(`${LOG_EMOJI.WARNING} Could not fetch comments for ${localKey}`);
      return { synced: 0, skipped: 0, failed: 0 };
    }
    
    const commentsData = await commentsResponse.json();
    const localComments = commentsData.comments || [];
    
    if (localComments.length === 0) {
      return { synced: 0, skipped: 0, failed: 0 };
    }
    
    console.log(`${LOG_EMOJI.COMMENT} Found ${localComments.length} comments on ${localKey}`);
    
    // Get existing comments on remote issue
    const remoteCommentsResponse = await fetch(
      `${org.remoteUrl}/rest/api/3/issue/${remoteKey}/comment?maxResults=100`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    let existingRemoteComments = [];
    if (remoteCommentsResponse.ok) {
      const remoteData = await remoteCommentsResponse.json();
      existingRemoteComments = remoteData.comments || [];
    }
    
    // Build a set of existing comment signatures to avoid duplicates
    // We use "[Comment from OrgName" prefix to identify synced comments
    const existingSignatures = new Set();
    for (const rc of existingRemoteComments) {
      if (rc.body && typeof rc.body === 'object') {
        const text = extractTextFromADF(rc.body);
        // Extract first 100 chars as signature
        existingSignatures.add(text.substring(0, 100));
      }
    }
    
    let synced = 0;
    let skipped = 0;
    let failed = 0;
    
    for (const comment of localComments) {
      if (comment.author?.accountType === 'app') {
        console.log(`${LOG_EMOJI.INFO} Skipping app-authored comment ${comment.id} on ${localKey}`);
        skipped++;
        continue;
      }

      const userName = comment.author?.displayName || comment.author?.emailAddress || 'Unknown User';
      
      let commentText = '';
      if (comment.body && typeof comment.body === 'object') {
        commentText = extractTextFromADF(comment.body);
      } else {
        commentText = comment.body || '';
      }
      
      // Create the comment body with author attribution
      const commentBody = textToADFWithAuthor(commentText, orgName, userName);
      const signature = `[Comment from ${orgName} - User: ${userName}]`;
      
      // Check if this comment likely already exists (by checking for similar content)
      const checkText = `${signature}\n\n${commentText}`.substring(0, 100);
      if (existingSignatures.has(checkText)) {
        skipped++;
        continue;
      }
      
      // Also check if any remote comment contains this signature + partial text
      let alreadyExists = false;
      for (const rc of existingRemoteComments) {
        if (rc.body && typeof rc.body === 'object') {
          const rcText = extractTextFromADF(rc.body);
          if (rcText.includes(signature) && rcText.includes(commentText.substring(0, 50))) {
            alreadyExists = true;
            break;
          }
        }
      }
      
      if (alreadyExists) {
        skipped++;
        continue;
      }
      
      // Sync the comment
      try {
        const response = await retryWithBackoff(async () => {
          return await fetch(
            `${org.remoteUrl}/rest/api/3/issue/${remoteKey}/comment?notifyUsers=false`,
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
          synced++;
          if (syncResult) syncResult.details.comments.success++;
        } else {
          failed++;
          if (syncResult) syncResult.details.comments.failed++;
        }
      } catch (error) {
        console.error(`${LOG_EMOJI.ERROR} Error syncing comment:`, error);
        failed++;
        if (syncResult) syncResult.details.comments.failed++;
      }
    }
    
    if (synced > 0 || failed > 0) {
      console.log(`${LOG_EMOJI.COMMENT} Comments for ${localKey}: ${synced} synced, ${skipped} skipped, ${failed} failed`);
    }
    
    return { synced, skipped, failed };
    
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error syncing comments for ${localKey}:`, error);
    return { synced: 0, skipped: 0, failed: 0 };
  }
}

export async function syncComment(event) {
  const issueKey = event.issue.key;
  const commentId = event.comment?.id;

  if (await isSyncing(issueKey)) {
    console.log(`⏭️ Skipping comment sync for ${issueKey} - issue is currently syncing`);
    await trackWebhookSync('comment', false, 'Issue currently syncing (loop prevention)', null, issueKey, {
      reason: 'loop-prevention',
      commentId
    });
    return;
  }

  // Get all organizations with their API tokens from secure storage
  let organizations = await getOrganizationsWithTokens();
  
  // Legacy support: check for old single-org config
  const legacyConfig = await kvsStore.get('syncConfig');
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

  if (fullComment.author?.accountType === 'app') {
    console.log(`${LOG_EMOJI.INFO} Skipping app-authored comment ${commentId} on ${issueKey}`);
    await trackWebhookSync('comment', false, 'Comment authored by SyncApp (loop prevention)', null, issueKey, {
      reason: 'app-authored',
      commentId,
      projectKey,
      author: fullComment.author?.displayName || 'SyncApp'
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
    const syncOptions = await kvsStore.get(syncOptionsKey) || { syncComments: true };
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
          `${org.remoteUrl}/rest/api/3/issue/${remoteKey}/comment?notifyUsers=false`,
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
