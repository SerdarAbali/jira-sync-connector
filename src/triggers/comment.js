import { syncComment } from '../services/sync/comment-sync.js';

export async function run(event, context) {
  console.log(`💬 Comment trigger fired`);
  await syncComment(event);
}
