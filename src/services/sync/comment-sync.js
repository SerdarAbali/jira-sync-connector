import api, { route, fetch } from '@forge/api';
import * as kvsStore from '../storage/kvs.js';
import { LOG_EMOJI } from '../../constants.js';
import { executeWriteOnce } from '../../utils/retry.js';
import { extractTextFromADF, buildSyncedCommentADF, stripSyncPrefix, sanitizeCommentText, isConnectorGeneratedComment } from '../../utils/adf.js';
import { getRemoteKey, getOrganizationsWithTokens, getRemoteCommentId, storeCommentMapping } from '../storage/mappings.js';
import { getFullIssue, getFullComment, getOrgName } from '../jira/local-client.js';
import { trackWebhookSync } from '../storage/stats.js';
import { isProjectAllowedToSync } from '../../utils/validation.js';
import { SyncResult } from './sync-result.js';
import { isSyncing } from '../storage/flags.js';
import { formatHttpFailure } from '../../utils/http-error.js';
import { safeErrorSummary, safeErrorForLog } from '../../utils/redaction.js';
import { getPilotPause, assertPilotWritesAllowed } from './pilot-pause.js';
import { verifyCommentThread, commentParentId, withParentHints, verifyFreshCommentThread } from './comment-confidentiality.js';
import { commentReadBudget } from '../jira/comment-read.js';
import { getCommentProjectType } from '../jira/comment-project.js';
import { deferCommentVerification, markDeferredCommentSubmission, assertCommentVerificationReady } from './comment-verification-recovery.js';
// Threading helpers were removed because Jira flattens replies; we now embed context inline.

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
      route`/rest/api/3/issue/${localKey}/comment?maxResults=100&expand=renderedBody,properties`,
      { method: 'GET' }
    );
    
    if (!commentsResponse.ok) {
      console.log(`${LOG_EMOJI.WARNING} Could not fetch comments for ${localKey}`);
      return { synced: 0, skipped: 0, failed: 0 };
    }
    
    const commentsData = await commentsResponse.json();
    const localComments = commentsData.comments || [];
    const commentLookup = new Map(localComments.map(comment => [String(comment.id), comment]));
    
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
    const projectContextCache = new Map();
    
    for (const comment of localComments) {
      let verification;
      try {
        await assertCommentVerificationReady({ direction: 'local-to-remote', orgId: orgId || org.id || 'legacy',
          issueKey: localKey, commentId: comment.id });
        const budget = commentReadBudget();
        budget.cache = projectContextCache;
        verification = await verifyCommentThread(comment, {
          expectedId: comment.id,
          readParent: id => commentLookup.get(String(id)) || getFullComment(localKey, id, budget),
          projectType: () => getCommentProjectType(localKey, null, budget)
        });
      } catch (error) {
        if (error?.code !== 'COMMENT_VERIFICATION_DEFERRED') throw error;
        await deferCommentVerification({ direction: 'local-to-remote', orgId: orgId || org.id || 'legacy',
          issueKey: localKey, commentId: comment.id }, error);
        skipped++;
        continue;
      }
      if (!verification.allowed) {
        console.log('Comment copy skipped: confidentiality not verified');
        skipped++;
        continue;
      }
      if (comment.author?.accountType === 'app' || isConnectorGeneratedComment(comment.body)) {
        console.log(`${LOG_EMOJI.INFO} Skipping connector-generated comment ${comment.id} on ${localKey}`);
        skipped++;
        continue;
      }

      const existingRemoteCommentId = await getRemoteCommentId(comment.id, orgId);
      if (existingRemoteCommentId) {
        console.log(`${LOG_EMOJI.SKIP} Comment ${comment.id} already mapped to remote comment ${existingRemoteCommentId}, skipping resend`);
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
      commentText = sanitizeCommentText(stripSyncPrefix(commentText)) || '';
      
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
        await assertPilotWritesAllowed('comment_create_remote');
        const finalBudget = commentReadBudget();
        const final = await verifyFreshCommentThread({
          readComment: () => getFullComment(localKey, comment.id, finalBudget), expectedId: comment.id,
          readParent: id => getFullComment(localKey, id, finalBudget),
          projectType: () => getCommentProjectType(localKey, null, finalBudget), hints: comment, knownAncestry: verification.ancestry
        });
        if (!final.allowed) { skipped++; continue; }
        if (final.comment.author?.accountType === 'app' || isConnectorGeneratedComment(final.comment.body)) { skipped++; continue; }
        const finalBody = verifiedCommentBody(final.comment, final.parent, orgName);
        await assertPilotWritesAllowed('comment_create_remote');
        await markDeferredCommentSubmission({ direction: 'local-to-remote', orgId: orgId || org.id || 'legacy',
          issueKey: localKey, commentId: comment.id });
        const response = await executeWriteOnce(async () => {
          return await fetch(
            `${org.remoteUrl}/rest/api/3/issue/${remoteKey}/comment?notifyUsers=false`,
            {
              method: 'POST',
              headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ body: finalBody })
            }
          );
        }, `Sync comment to ${remoteKey}`);
        
        if (response.ok) {
          const remoteComment = await parseJsonSafely(response);
          const remoteCommentId = remoteComment?.id;
          if (remoteCommentId) {
            await storeCommentMapping(comment.id, remoteCommentId, orgId);
          }
          existingSignatures.add(checkText);
          synced++;
          if (syncResult) syncResult.details.comments.success++;
        } else {
          failed++;
          if (syncResult) syncResult.details.comments.failed++;
        }
      } catch (error) {
        if (error?.code === 'COMMENT_VERIFICATION_DEFERRED') {
          await deferCommentVerification({ direction: 'local-to-remote', orgId: orgId || org.id || 'legacy', issueKey: localKey, commentId: comment.id }, error);
          skipped++; continue;
        }
        console.error('Error syncing comment:', safeErrorForLog(error));
        failed++;
        if (syncResult) syncResult.details.comments.failed++;
      }
    }
    
    if (synced > 0 || failed > 0) {
      console.log(`${LOG_EMOJI.COMMENT} Comments for ${localKey}: ${synced} synced, ${skipped} skipped, ${failed} failed`);
    }
    
    return { synced, skipped, failed };
    
  } catch (error) {
    console.error('Error syncing comments:', safeErrorForLog(error));
    return { synced: 0, skipped: 0, failed: 0 };
  }
}

export async function syncComment(event, recoveryOrgId = null) {
  if (recoveryOrgId && (await getPilotPause()).paused) return { status: 'COMMENT_RETRY', reason: 'paused' };
  let recoveryOutcome = { status: 'COMMENT_RETRY' };
  const issueKey = event.issue.key;
  const commentId = event.comment?.id;

  if (await isSyncing(issueKey)) {
    console.log(`⏭️ Skipping comment sync for ${issueKey} - issue is currently syncing`);
    await trackWebhookSync('comment', false, 'Issue currently syncing (loop prevention)', null, issueKey, {
      reason: 'loop-prevention',
      commentId
    });
    return { status: 'COMMENT_RETRY' };
  }

  // Get all organizations with their API tokens from secure storage
  const organizations = (await getOrganizationsWithTokens()).filter(org => !recoveryOrgId || org.id === recoveryOrgId);

  if (organizations.length === 0) {
    console.log('Comment sync skipped: no organizations configured');
    await trackWebhookSync('comment', false, 'No organizations configured', null, issueKey, {
      reason: 'No target organizations configured in settings',
      commentId
    });
    return { status: 'COMMENT_RETRY' };
  }

  // Get issue to check project
  const issue = await getFullIssue(issueKey);
  if (!issue) {
    console.log('Could not fetch issue data for comment sync');
    await trackWebhookSync('comment', false, 'Could not fetch issue data', null, issueKey, {
      reason: 'Failed to retrieve issue from Jira API',
      commentId
    });
    return { status: 'COMMENT_RETRY' };
  }

  const projectKey = issue.fields.project.key;
  const budget = commentReadBudget();
  let fullComment;
  let verification;
  try {
    for (const org of organizations) await assertCommentVerificationReady({ direction: 'local-to-remote',
      orgId: org.id || 'legacy', issueKey, commentId });
    fullComment = await getFullComment(issueKey, commentId, budget);
    // Event parent references are used only as identifiers, never as content.
    const source = withParentHints(fullComment, event.comment);
    verification = await verifyCommentThread(source, {
      expectedId: commentId,
      readParent: id => getFullComment(issueKey, id, budget),
      projectType: () => getCommentProjectType(issueKey, null, budget)
    });
  } catch (error) {
    if (error?.code === 'COMMENT_RECONCILIATION_REQUIRED') return { status: error.code };
    if (error?.code !== 'COMMENT_VERIFICATION_DEFERRED') throw error;
    for (const org of organizations) {
      if (Array.isArray(org.allowedProjects) && org.allowedProjects.includes(projectKey)) {
        await deferCommentVerification({ direction: 'local-to-remote', orgId: org.id || 'legacy',
          issueKey, commentId, parentId: commentParentId(event.comment) }, error);
      }
    }
    return { status: 'COMMENT_VERIFICATION_DEFERRED' };
  }
  if (!fullComment) {
    console.log('Could not fetch full comment data');
    await trackWebhookSync('comment', false, 'Could not fetch comment data', null, issueKey, {
      reason: 'Failed to retrieve comment from Jira API',
      commentId,
      projectKey
    });
    return { status: 'COMMENT_RETRY' };
  }

  if (!verification.allowed) {
    console.log('Comment copy skipped: confidentiality not verified');
    return { status: 'COMMENT_REJECTED' };
  }

  if (fullComment.author?.accountType === 'app'
      || isConnectorGeneratedComment(fullComment.body)) {
    console.log(`${LOG_EMOJI.INFO} Skipping connector-generated comment ${commentId} on ${issueKey}`);
    await trackWebhookSync('comment', false, 'Comment authored by SyncApp (loop prevention)', null, issueKey, {
      reason: 'app-authored',
      commentId,
      projectKey,
      author: fullComment.author?.displayName || 'SyncApp'
    });
    return { status: 'COMMENT_IGNORED_CONNECTOR' };
  }

  const orgName = await getOrgName();
  const userName = fullComment.author?.displayName || fullComment.author?.emailAddress || 'Unknown User';

  const parentContext = verifiedParentContext(verification.parent);
  const parentLocalId = parentContext?.parentId || null;


  // Sync comment to all organizations
  for (const org of organizations) {
    const orgId = org.id === 'legacy' ? null : org.id;
    const existingRemoteCommentId = await getRemoteCommentId(commentId, orgId);
    if (existingRemoteCommentId) {
      console.log(`${LOG_EMOJI.SKIP} Comment ${commentId} already synced to ${org.id || 'organization'} as ${existingRemoteCommentId}`);
      recoveryOutcome = { status: 'COMMENT_ALREADY_MAPPED' };
      continue;
    }

    // Check if comment sync is enabled for this org
    const syncOptionsKey = org.id === 'legacy' ? 'syncOptions' : `syncOptions:${org.id}`;
    const syncOptions = await kvsStore.get(syncOptionsKey) || { syncComments: true };
    if (!syncOptions.syncComments) {
      console.log(`⏭️ Comment sync skipped for ${org.id || 'organization'}: disabled in sync options`);
      continue;
    }

    // Check if project is allowed to sync for this org
    const isAllowed = await isProjectAllowedToSync(projectKey, org);
    if (!isAllowed) {
      console.log(`⏭️ Skipping comment on ${issueKey} for ${org.id || 'organization'} - project ${projectKey} not in allowed list`);
      continue;
    }

    const remoteKey = await getRemoteKey(issueKey, orgId);
    if (!remoteKey) {
      console.log(`No remote issue found for ${issueKey} in ${org.id || 'organization'}`);
      continue;
    }

    const auth = Buffer.from(`${org.remoteEmail}:${org.remoteApiToken}`).toString('base64');
    const syncResult = new SyncResult('comment');
    try {
      console.log(`${LOG_EMOJI.COMMENT} Syncing comment to ${org.id || 'organization'}: ${issueKey} → ${remoteKey}`);

      const finalBudget = commentReadBudget();
      const final = await verifyFreshCommentThread({
        readComment: () => getFullComment(issueKey, commentId, finalBudget), expectedId: commentId,
        readParent: id => getFullComment(issueKey, id, finalBudget),
        projectType: () => getCommentProjectType(issueKey, null, finalBudget), hints: fullComment, knownAncestry: verification.ancestry
      });
      if (!final.allowed) { recoveryOutcome = { status: 'COMMENT_REJECTED' }; continue; }
      if (final.comment.author?.accountType === 'app' || isConnectorGeneratedComment(final.comment.body)) {
        recoveryOutcome = { status: 'COMMENT_IGNORED_CONNECTOR' }; continue;
      }
      const finalBody = verifiedCommentBody(final.comment, final.parent, orgName);
      await assertPilotWritesAllowed('comment_create_remote');
      await markDeferredCommentSubmission({ direction: 'local-to-remote', orgId: org.id || 'legacy',
        issueKey, commentId });
      const response = await executeWriteOnce(async () => {
        return await fetch(
          `${org.remoteUrl}/rest/api/3/issue/${remoteKey}/comment?notifyUsers=false`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${auth}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ body: finalBody })
          }
        );
      }, `Sync comment to ${remoteKey}`);

      if (response.ok) {
        const remoteComment = await parseJsonSafely(response);
        const remoteCommentId = remoteComment?.id;
        if (remoteCommentId) {
          await storeCommentMapping(commentId, remoteCommentId, orgId);
          recoveryOutcome = { status: 'COMMENT_SYNCED' };
        } else if (recoveryOrgId) {
          return { status: 'COMMENT_RECONCILIATION_REQUIRED' };
        }

        console.log(`${LOG_EMOJI.SUCCESS} Comment synced to ${org.id || 'organization'} (${remoteKey})${remoteCommentId ? ` → remote comment ${remoteCommentId}` : ''}`);
        syncResult.details.comments.success++;
        await trackWebhookSync('comment', true, null, org.id, issueKey, {
          remoteKey,
          projectKey,
          commentId,
          author: userName,
          remoteCommentId,
          parentLocalId,
          parentRemoteId: null
        });
      } else {
        if (recoveryOrgId) return { status: 'COMMENT_RECONCILIATION_REQUIRED' };
        console.error(`${LOG_EMOJI.ERROR} Comment sync failed for ${org.id || 'organization'}`);
        const safeFailure = formatHttpFailure(response.status);
        syncResult.details.comments.failed++;
        syncResult.addError(`Comment sync failed: ${safeFailure}`);
        await trackWebhookSync('comment', false, safeFailure, org.id, issueKey, {
          remoteKey,
          projectKey,
          commentId,
          httpStatus: response.status
        });
      }
    } catch (error) {
      if (error?.code === 'COMMENT_VERIFICATION_DEFERRED') {
        await deferCommentVerification({ direction: 'local-to-remote', orgId: org.id || 'legacy', issueKey, commentId }, error);
        recoveryOutcome = { status: error.code };
        continue;
      }
      if (error?.code === 'PILOT_PAUSED') return { status: 'COMMENT_RETRY', reason: 'paused' };
      console.error('Error syncing comment:', safeErrorForLog(error));
      const safeFailure = safeErrorSummary(error.message);
      syncResult.details.comments.failed++;
      syncResult.addError(`Error syncing comment: ${safeFailure}`);
      await trackWebhookSync('comment', false, safeFailure, org.id, issueKey, {
        remoteKey,
        projectKey,
        commentId
      });
      if (recoveryOrgId) return { status: 'COMMENT_RECONCILIATION_REQUIRED' };
    }

    // Log summary for this org
    syncResult.logSummary(issueKey, remoteKey, org.name);
  }

  console.log(`\n✅ Completed comment sync for ${issueKey} across ${organizations.length} organization(s)`);
  return recoveryOutcome;
}

function verifiedParentContext(parentComment) {
  if (!parentComment) return null;
  return {
    parentId: String(parentComment.id),
    parentAuthor: parentComment.author?.displayName || parentComment.author?.emailAddress || null,
    parentSnippet: extractPlainTextFromComment(parentComment)
  };
}

function extractPlainTextFromComment(comment) {
  if (!comment) {
    return '';
  }

  if (comment.body && typeof comment.body === 'object') {
    return summarizeText(extractTextFromADF(comment.body));
  }

  if (typeof comment.body === 'string') {
    return summarizeText(comment.body);
  }

  return '';
}

function summarizeText(text, maxLength = 140) {
  if (!text) {
    return '';
  }

  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.substring(0, maxLength - 3)}...`;
}

async function parseJsonSafely(response) {
  if (!response) {
    return null;
  }
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

function verifiedCommentBody(comment, parent, orgName) {
  const context = verifiedParentContext(parent);
  const text = typeof comment.body === 'object' ? extractTextFromADF(comment.body) : comment.body || '';
  return buildSyncedCommentADF({ orgName,
    userName: comment.author?.displayName || comment.author?.emailAddress || 'Unknown User',
    parentAuthor: context?.parentAuthor || null, parentSnippet: context?.parentSnippet || null,
    responseText: sanitizeCommentText(stripSyncPrefix(text)) || '' });
}
