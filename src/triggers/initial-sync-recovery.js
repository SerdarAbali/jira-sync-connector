import { recoverInitialSyncJobs } from '../services/sync/initial-sync.js';

/**
 * Recovery only requeues persisted running jobs. It cannot reset a cursor,
 * recreate issues, or start a new backfill.
 */
export async function run() {
  try {
    const result = await recoverInitialSyncJobs();
    console.log(`Initial-sync recovery requeued ${result.recovered} job(s)`);
    return result;
  } catch {
    console.error('Initial-sync recovery failed safely');
    return { success: false, recovered: 0 };
  }
}
