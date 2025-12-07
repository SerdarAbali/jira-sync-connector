import { performScheduledSync } from '../services/scheduled/scheduled-sync.js';

/**
 * Async consumer to run the scheduled sync logic manually.
 * This runs with a 900s (15m) timeout via the Async Events API.
 */
export async function run(event, context) {
  console.log('🚀 Manually triggered scheduled sync started via Async Queue');
  try {
    await performScheduledSync();
    console.log('✅ Manually triggered scheduled sync finished');
  } catch (error) {
    console.error('❌ Manually triggered scheduled sync failed:', error);
  }
}
