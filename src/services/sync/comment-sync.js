import api, { route } from '../jira/guarded-api.js';
import * as kvsStore from '../storage/kvs.js';
import { LOG_EMOJI } from '../../constants.js';
import { executeWriteOnce } from '../../utils/retry.js';
import { extractTextFromADF, buildSyncedCommentADF, stripSyncPrefix, sanitizeCommentText, isConnectorGeneratedComment, commentAuthorName, commentAuthorDisplayName } from '../../utils/adf.js';
import { getRemoteKey, getOrganizationsWithTokens, getRemoteCommentId } from '../storage/mappings.js';
import { getFullIssue, getFullComment, getOrgName } from '../jira/local-client.js';
import { trackWebhookSync } from '../storage/stats.js';
import { isProjectAllowedToSync } from '../../utils/validation.js';
import { SyncResult } from './sync-result.js';
import { isSyncing } from '../storage/flags.js';
import { safeErrorSummary, safeErrorForLog } from '../../utils/redaction.js';
import { getPilotPause, assertPilotWritesAllowed } from './pilot-pause.js';
import { verifyCommentThread, commentParentId, withParentHints, verifyFreshCommentThread } from './comment-confidentiality.js';
import { submitOutboundComment, PRE_SUBMISSION_CODES } from './comment-submission.js';
import { commentReadBudget } from '../jira/comment-read.js';
import { getCommentProjectType } from '../jira/comment-project.js';
import { deferCommentVerification, markDeferredCommentSubmission, assertCommentVerificationReady } from './comment-verification-recovery.js';
import { isOutboundScopeError } from './outbound-scope.js';
// Threading helpers were removed because Jira flattens replies; we now embed context inline.

/**
 * Sync all comments from a local issue to a remote issue
 * Used during scheduled sync to catch missed comment webhooks
 */
export async function syncAllComments(localKey, remoteKey, issue, org, syncResult = null, orgId = null) {
  orgId = (orgId || org.id) === 'legacy' ? null : (orgId || org.id || null);
  const syncOptionsKey = orgId ? `syncOptions:${orgId}` : 'syncOptions';
  const syncOptions = await kvsStore.get(syncOptionsKey) || { syncComments: true };
  if (!syncOptions.syncComments) {
    console.log(`⏭️ Comment catch-up skipped for ${org.id || 'organization'}: disabled in sync options`);
    return { synced: 0, skipped: 0, failed: 0 };
  }
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
        if (error?.code === 'COMMENT_RECONCILIATION_REQUIRED') { skipped++; continue; }
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
        await submitOutboundComment({ orgId: orgId || org.id || 'legacy', issueKey: localKey,
          commentId: comment.id, remoteKey }, async (send) => {
          await markDeferredCommentSubmission({ direction: 'local-to-remote', orgId: orgId || org.id || 'legacy',
            issueKey: localKey, commentId: comment.id });
          return executeWriteOnce(() => send(
            `${org.remoteUrl}/rest/api/3/issue/${remoteKey}/comment?notifyUsers=false`,
            { method: 'POST', headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ body: finalBody }) }
          ), `Sync comment to ${remoteKey}`);
        });
        synced++;
        if (syncResult) syncResult.details.comments.success++;
      } catch (error) {
        if (isOutboundScopeError(error)) throw error;
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
    if (isOutboundScopeError(error)) throw error;
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
      author: commentAuthorName(fullComment.author)
    });
    return { status: 'COMMENT_IGNORED_CONNECTOR' };
  }

  const orgName = await getOrgName();
  const userName = commentAuthorName(fullComment.author);

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
      const { destinationCommentId: remoteCommentId } = await submitOutboundComment({
        orgId: org.id || 'legacy', issueKey, commentId, remoteKey
      }, async (send) => {
        await markDeferredCommentSubmission({ direction: 'local-to-remote', orgId: org.id || 'legacy', issueKey, commentId });
        return executeWriteOnce(() => send(
          `${org.remoteUrl}/rest/api/3/issue/${remoteKey}/comment?notifyUsers=false`,
          { method: 'POST', headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: finalBody }) }
        ), `Sync comment to ${remoteKey}`);
      });
      recoveryOutcome = { status: 'COMMENT_SYNCED' };
      syncResult.details.comments.success++;
      await trackWebhookSync('comment', true, null, org.id, issueKey, {
        remoteKey, projectKey, commentId, author: userName, remoteCommentId,
        parentLocalId, parentRemoteId: null
      });
    } catch (error) {
      if (isOutboundScopeError(error)) {
        recoveryOutcome = { status: 'COMMENT_RETRY', reason: error.reason, code: error.code };
        continue;
      }
      if (error?.code === 'COMMENT_VERIFICATION_DEFERRED') {
        await deferCommentVerification({ direction: 'local-to-remote', orgId: org.id || 'legacy', issueKey, commentId }, error);
        recoveryOutcome = { status: error.code };
        continue;
      }
      if (error?.code === 'COMMENT_RECONCILIATION_REQUIRED') {
        recoveryOutcome = { status: error.code, reason: error.reason };
        await trackWebhookSync('comment', false, 'Comment submission requires reconciliation', org.id, issueKey, {
          remoteKey, projectKey, commentId, reason: error.reason
        });
        continue;
      }
      // A global Pause, or an unverifiable Pause state, blocks every
      // organization: stop the pass and keep the work retryable. The F06 phase
      // was re-armed for these codes, so nothing reached Jira.
      if (error?.code === 'PILOT_PAUSED' || error?.code === 'PAUSE_STATE_UNAVAILABLE') {
        return { status: 'COMMENT_RETRY', reason: error.code === 'PILOT_PAUSED' ? 'paused' : error.code };
      }
      // F07 guard failures are scoped to this organization's lease, so other
      // organizations keep processing. Recovery must still keep the comment
      // pending instead of escalating it to manual attention.
      if (recoveryOrgId && PRE_SUBMISSION_CODES.has(error?.code)) {
        return { status: 'COMMENT_RETRY', reason: error.code };
      }
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
  if (!parentComment
      || parentComment.author?.accountType === 'app'
      || isConnectorGeneratedComment(parentComment.body)) return null;
  return {
    parentId: String(parentComment.id),
    parentAuthor: commentAuthorDisplayName(parentComment.author),
    parentSnippet: extractPlainTextFromComment(parentComment)
  };
}

function extractPlainTextFromComment(comment) {
  if (!comment) {
    return '';
  }

  if (comment.body && typeof comment.body === 'object') {
    return summarizeText(sanitizeCommentText(stripSyncPrefix(extractTextFromADF(comment.body))));
  }

  if (typeof comment.body === 'string') {
    return summarizeText(sanitizeCommentText(stripSyncPrefix(comment.body)));
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


function verifiedCommentBody(comment, parent, orgName) {
  const context = verifiedParentContext(parent);
  const text = typeof comment.body === 'object' ? extractTextFromADF(comment.body) : comment.body || '';
  return buildSyncedCommentADF({ orgName,
    userName: commentAuthorName(comment.author),
    parentAuthor: context?.parentAuthor || null, parentSnippet: context?.parentSnippet || null,
    responseText: sanitizeCommentText(stripSyncPrefix(text)) || '',
    responseBody: comment.body });
}
