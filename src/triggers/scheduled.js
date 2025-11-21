import { performScheduledSync } from '../services/scheduled/scheduled-sync.js';

export async function run(event, context) {
  console.log(`⏰ Scheduled sync trigger fired`);
  try {
    const stats = await performScheduledSync();
    console.log(`✅ Scheduled sync completed:`, stats);
  } catch (error) {
    console.error(`❌ Scheduled sync failed:`, error);
  }
}
