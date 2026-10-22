import { processInitialSyncJob } from '../services/sync/initial-sync.js';

/**
 * Bounded async consumer for initial-sync jobs. The queue body contains only
 * the organization and job identifiers; it never contains Jira issue content.
 */
export async function run(event) {
  const body = event?.body || event?.payload || {};
  if (body.type !== 'initial-sync'
      || typeof body.orgId !== 'string'
      || typeof body.jobId !== 'string') {
    return {
      success: false,
      code: 'INITIAL_SYNC_EVENT_INVALID',
      message: 'No Jira operations were performed.'
    };
  }

  try {
    return await processInitialSyncJob({
      orgId: body.orgId,
      jobId: body.jobId
    });
  } catch {
    return {
      success: false,
      code: 'INITIAL_SYNC_PROCESSING_FAILED',
      message: 'The initial-sync event ended without exposing issue content.'
    };
  }
}
