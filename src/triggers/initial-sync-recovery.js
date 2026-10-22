import { recoverInitialSyncJobs } from '../services/sync/initial-sync.js';
import { runDueReconciliations } from '../services/sync/source-reconciliation.js';

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

  return {
    ...initialSync,
    reconciliation
  };
}
