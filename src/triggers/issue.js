import * as kvsStore from '../services/storage/kvs.js';
import { RECENT_CREATION_WINDOW_MS } from '../constants.js';
import { getRemoteKey } from '../services/storage/mappings.js';
import { syncIssue } from '../services/sync/issue-sync.js';

export async function run(event, context) {
  console.log(`🔔 Trigger fired: ${event.eventType}`);
  console.log(`📝 Issue: ${event.issue?.key}`);
  
  // Log what changed
  if (event.changelog?.items) {
    console.log(`🔄 Changes detected:`);
    let hasLinkChanges = false;
    event.changelog.items.forEach(item => {
      console.log(`   - ${item.field}: "${item.fromString}" → "${item.toString}"`);
      if (item.field === 'Link') {
        hasLinkChanges = true;
        console.log(`   🔗 LINK CHANGE DETECTED: "${item.fromString}" → "${item.toString}"`);
      }
    });
    if (hasLinkChanges) {
      console.log(`🔗 This update includes link changes - will sync links`);
    }
  } else {
    console.log(`⚠️ No changelog available in event`);
    if (event.eventType === 'avi:jira:updated:issue') {
      console.log(`ℹ️ Update event without changelog - may be a link addition, will process`);
    }
  }
  
  // For updated events, check if this is right after creation (prevents duplicate creation)
  if (event.eventType === 'avi:jira:updated:issue') {
    const createdData = await kvsStore.get(`created-timestamp:${event.issue.key}`);
    let createdAt = null;

    // Handle both old format (string) and new format (object with expiresAt)
    if (createdData) {
      if (typeof createdData === 'string') {
        createdAt = createdData;
      } else if (createdData.value && createdData.expiresAt) {
        // Check expiration
        if (Date.now() < createdData.expiresAt) {
          createdAt = createdData.value;
        } else {
          // Expired, clean it up
          await kvsStore.del(`created-timestamp:${event.issue.key}`);
        }
      }
    }

    if (createdAt) {
      const timeSinceCreation = Date.now() - parseInt(createdAt, 10);
      if (timeSinceCreation < RECENT_CREATION_WINDOW_MS) {
        // Only skip if remote issue doesn't exist yet (still being created)
        const remoteKey = await getRemoteKey(event.issue.key);
        if (!remoteKey) {
          console.log(`⏭️ Skipping UPDATE event - issue was just created ${timeSinceCreation}ms ago (still creating remote)`);
          return;
        } else {
          console.log(`✅ Remote issue exists (${remoteKey}), processing update even though issue was just created`);
        }
      }
    }
  }
  
  // Store creation timestamp for new issues with TTL (1 hour)
  if (event.eventType === 'avi:jira:created:issue') {
    const TTL_MS = 60 * 60 * 1000; // 1 hour
    await kvsStore.set(`created-timestamp:${event.issue.key}`, {
      value: Date.now().toString(),
      expiresAt: Date.now() + TTL_MS
    });
  }
  
  await syncIssue(event);
}
