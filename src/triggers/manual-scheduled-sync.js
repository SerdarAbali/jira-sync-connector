/**
 * The legacy manual scheduled-sync queue consumer is intentionally fail-closed.
 * Recurring reconciliation uses the existing hourly recovery heartbeat; queued
 * events from older deployments must not force a legacy scheduled run.
 */
export async function run() {
  console.warn('Manual scheduled sync is disabled; no sync work was started');
  return {
    success: false,
    code: 'SCHEDULED_SYNC_MANUAL_TRIGGER_DISABLED'
  };
}
