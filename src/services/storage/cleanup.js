import * as kvsStore from './kvs.js';
import { removeMapping } from './mappings.js';
import { removeIssueFromPendingLinksIndex } from './flags.js';
import { LOG_EMOJI } from '../../constants.js';

/**
 * Centralized cleanup for issue data when an issue is deleted
 * Ensures all related storage keys are removed
 */
export async function cleanupIssueData(issueKey, remoteKey, orgId = null) {
  console.log(`${LOG_EMOJI.INFO} Cleaning up storage for issue ${issueKey}`);
  
  try {
    // 1. Remove mappings (local <-> remote)
    await removeMapping(issueKey, remoteKey, orgId);
    
    // 2. Remove pending links (both the list and the index)
    await kvsStore.del(`pending-links:${issueKey}`);
    await removeIssueFromPendingLinksIndex(issueKey);
    
    // 3. Remove creation timestamp
    await kvsStore.del(`created-timestamp:${issueKey}`);
    
    // 4. Remove syncing flag
    await kvsStore.del(`syncing:${issueKey}`);
    
    console.log(`${LOG_EMOJI.SUCCESS} Cleanup complete for ${issueKey}`);
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error during cleanup for ${issueKey}:`, error);
  }
}
