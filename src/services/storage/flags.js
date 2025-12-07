import * as kvsStore from './kvs.js';
import { SYNC_FLAG_TTL_MS, MAX_PENDING_LINK_ATTEMPTS } from '../../constants.js';

export async function markSyncing(issueKey) {
  // @forge/kvs doesn't support TTL directly, so we store expiration time
  await kvsStore.set(`syncing:${issueKey}`, { 
    value: 'true', 
    expiresAt: Date.now() + SYNC_FLAG_TTL_MS 
  });
}

export async function clearSyncFlag(issueKey) {
  await kvsStore.del(`syncing:${issueKey}`);
}

export async function isSyncing(issueKey) {
  const data = await kvsStore.get(`syncing:${issueKey}`);
  if (!data) return false;
  
  // Check if TTL-based flag has expired
  if (data.expiresAt && Date.now() > data.expiresAt) {
    // Clean up expired flag
    await kvsStore.del(`syncing:${issueKey}`);
    return false;
  }
  
  // Handle both old format (string) and new format (object with value)
  return data === 'true' || data.value === 'true';
}

export async function storePendingLink(issueKey, linkData) {
  const pendingLinks = await kvsStore.get(`pending-links:${issueKey}`) || [];
  // Check if link already pending to avoid duplicates
  const existingIndex = pendingLinks.findIndex(l => l.linkId === linkData.linkId);
  if (existingIndex >= 0) {
    // Update existing pending link
    pendingLinks[existingIndex] = {
      ...linkData,
      attempts: (pendingLinks[existingIndex].attempts || 0) + 1,
      lastAttempt: new Date().toISOString()
    };
  } else {
    // Add new pending link
    pendingLinks.push({
      ...linkData,
      attempts: 1,
      lastAttempt: new Date().toISOString()
    });
  }
  await kvsStore.set(`pending-links:${issueKey}`, pendingLinks);

  // Store as queryable key instead of maintaining index array
  // Key pattern allows finding all pending links via query
  // OPTIMIZATION: Store the pending links in the index value to avoid N+1 lookups
  await kvsStore.set(`pending-link-idx:${issueKey}`, pendingLinks);

  console.log(`📌 Stored pending link: ${issueKey} → ${linkData.linkedIssueKey}`);
}

export async function getPendingLinks(issueKey) {
  return await kvsStore.get(`pending-links:${issueKey}`) || [];
}

/**
 * Find all pending links that reference a specific target issue
 * Uses kvs.query() to find all pending link keys
 */
export async function findPendingLinksToIssue(targetIssueKey) {
  // Query for all pending link index entries
  // OPTIMIZATION: The value now contains the pending links array
  const indexEntries = await kvsStore.queryByPrefix('pending-link-idx:', 500);
  const results = [];
  
  for (const entry of indexEntries) {
    const sourceIssueKey = entry.key.replace('pending-link-idx:', '');
    // Use the value from the query if available (new format), otherwise fetch (migration/fallback)
    let pendingLinks = entry.value;
    
    // Handle legacy case where value was just 'true'
    if (pendingLinks === true || pendingLinks === 'true') {
      pendingLinks = await kvsStore.get(`pending-links:${sourceIssueKey}`) || [];
    }
    
    if (Array.isArray(pendingLinks)) {
      for (const link of pendingLinks) {
        if (link.linkedIssueKey === targetIssueKey) {
          results.push({
            sourceIssueKey,
            ...link
          });
        }
      }
    }
  }
  
  return results;
}

export async function removePendingLink(issueKey, linkId) {
  const pendingLinks = await kvsStore.get(`pending-links:${issueKey}`) || [];
  const filtered = pendingLinks.filter(l => l.linkId !== linkId);
  if (filtered.length === 0) {
    await kvsStore.del(`pending-links:${issueKey}`);
    await kvsStore.del(`pending-link-idx:${issueKey}`);
  } else {
    await kvsStore.set(`pending-links:${issueKey}`, filtered);
    // Update the index with the new filtered list
    await kvsStore.set(`pending-link-idx:${issueKey}`, filtered);
  }
}

export async function removeIssueFromPendingLinksIndex(issueKey) {
  await kvsStore.del(`pending-link-idx:${issueKey}`);
}

function buildPendingChildKey(parentKey, orgId) {
  const prefix = orgId || 'legacy';
  return `${prefix}:pending-child:${parentKey}`;
}

export async function enqueuePendingChildIssue(parentKey, childKey, orgId) {
  if (!parentKey || !childKey) {
    return;
  }

  const key = buildPendingChildKey(parentKey, orgId);
  const existing = await kvsStore.get(key) || [];
  if (!existing.includes(childKey)) {
    existing.push(childKey);
    await kvsStore.set(key, existing);
  }
}

export async function consumePendingChildIssues(parentKey, orgId) {
  if (!parentKey) {
    return [];
  }

  const key = buildPendingChildKey(parentKey, orgId);
  const pending = await kvsStore.get(key) || [];
  if (pending.length > 0) {
    await kvsStore.del(key);
  }
  return pending;
}
