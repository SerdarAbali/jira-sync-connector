import { recoverInitialSyncJobs } from '../services/sync/initial-sync.js';
import { runDueReconciliations } from '../services/sync/source-reconciliation.js';
import { recoverCommentVerifications } from '../services/sync/comment-verification-recovery.js';
import { syncComment } from '../services/sync/comment-sync.js';
import { processIncomingWebhook } from '../services/sync/incoming-sync.js';
import { getPilotPause } from '../services/sync/pilot-pause.js';
import { recoverPostCreateAttachments } from '../services/sync/post-create-attachments.js';
import * as storage from '../services/storage/kvs.js';

/**
 * Recovery only requeues persisted running jobs. It cannot reset a cursor,
 * recreate issues, or start a new backfill. The same hourly heartbeat schedules
 * opt-in recurring local-to-remote source reconciliation after initial-sync
 * recovery; no separate manifest trigger or queue is introduced.
 */
export async function run() {
  let initialSync;
  try {
    initialSync = await recoverInitialSyncJobs();
    console.log(`Initial-sync recovery requeued ${initialSync.recovered} job(s)`);
  } catch {
    console.error('Initial-sync recovery failed safely');
    initialSync = { success: false, recovered: 0 };
  }

  let reconciliation;
  try {
    reconciliation = await runDueReconciliations();
    console.log(
      `Recurring reconciliation scheduled ${reconciliation.scheduled} job(s)`
    );
  } catch {
    console.error('Recurring reconciliation scheduling failed safely');
    reconciliation = { success: false, scheduled: 0 };
  }

  let comments;
  try {
    comments = await recoverCommentVerifications(async record => {
      if ((await getPilotPause()).paused) return { status: 'COMMENT_RETRY', reason: 'paused' };
      const organizations = await storage.get('organizations') || [];
      const org = organizations.find(candidate => candidate.id === record.orgId);
      const legacy = record.orgId === 'legacy' && record.direction === 'local-to-remote'
        && await storage.get('syncConfig');
      if (!org && !legacy) return { status: 'CANCELLED' };
      if (record.direction === 'local-to-remote') {
        return await syncComment({ issue: { key: record.issueKey }, comment: { id: record.commentId, ...(record.parentId ? { parentId: record.parentId } : {}) } }, record.orgId);
      }
      const credential = await storage.getSecret(`secret:${record.orgId}:incomingSecret`);
      return await processIncomingWebhook({ webhookEvent: 'comment_created',
        issue: { key: record.issueKey }, comment: { id: record.commentId, ...(record.parentId ? { parentId: record.parentId } : {}) } }, { orgId: record.orgId, credential }, { commentAncestry: record.ancestry });
    });
  } catch {
    console.warn('Comment verification recovery deferred');
    comments = { recovered: 0 };
  }

  let attachments;
  try { attachments = await recoverPostCreateAttachments(); }
  catch { attachments = { completed: 0 }; }

  return {
    ...initialSync,
    reconciliation,
    comments,
    attachments
  };
}
