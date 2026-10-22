import { processInitialSyncJob } from '../services/sync/initial-sync.js';
import {
  RECONCILIATION_QUEUE_JOB_TYPE,
  processReconciliationJob
} from '../services/sync/source-reconciliation.js';

/**
 * Bounded async consumer for initial-sync and recurring reconciliation jobs.
 * The queue body contains only the organization and job identifiers; it never
 * contains Jira issue content.
 */
export async function run(event) {
  const body = event?.body || event?.payload || {};
  if (body.type !== 'initial-sync'
      && body.type !== RECONCILIATION_QUEUE_JOB_TYPE) {
    return {
      success: false,
      code: 'INITIAL_SYNC_EVENT_INVALID',
      message: 'No Jira operations were performed.'
    };
  }
  if (typeof body.orgId !== 'string' || typeof body.jobId !== 'string') {
    return {
      success: false,
      code: 'INITIAL_SYNC_EVENT_INVALID',
      message: 'No Jira operations were performed.'
    };
  }

  try {
    if (body.type === RECONCILIATION_QUEUE_JOB_TYPE) {
      return await processReconciliationJob({
        orgId: body.orgId,
        jobId: body.jobId
      });
    }
    return await processInitialSyncJob({
      orgId: body.orgId,
      jobId: body.jobId
    });
  } catch {
    return {
      success: false,
      code: body.type === RECONCILIATION_QUEUE_JOB_TYPE
        ? 'RECONCILIATION_PROCESSING_FAILED'
        : 'INITIAL_SYNC_PROCESSING_FAILED',
      message: 'The event ended without exposing issue content.'
    };
  }
}
