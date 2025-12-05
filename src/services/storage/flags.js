import { storage } from '@forge/api';
import { SYNC_FLAG_TTL_MS, MAX_PENDING_LINK_ATTEMPTS } from '../../constants.js';

export async function markSyncing(issueKey) {
  await storage.set(`syncing:${issueKey}`, 'true', { ttl: SYNC_FLAG_TTL_MS });
}

export async function clearSyncFlag(issueKey) {
  await storage.delete(`syncing:${issueKey}`);
}

export async function isSyncing(issueKey) {
  const syncing = await storage.get(`syncing:${issueKey}`);
  return syncing === 'true';
}

export async function storePendingLink(issueKey, linkData) {
  const pendingLinks = await storage.get(`pending-links:${issueKey}`) || [];
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
  await storage.set(`pending-links:${issueKey}`, pendingLinks);

  // Update index
  const pendingLinksIndex = await storage.get('pending-links-index') || [];
  if (!pendingLinksIndex.includes(issueKey)) {
    pendingLinksIndex.push(issueKey);
    await storage.set('pending-links-index', pendingLinksIndex);
  }

  console.log(`📌 Stored pending link: ${issueKey} → ${linkData.linkedIssueKey}`);
}

export async function getPendingLinks(issueKey) {
  return await storage.get(`pending-links:${issueKey}`) || [];
}

/**
 * Find all pending links that reference a specific target issue
 * Used when an issue gets synced to process any links waiting for it
 */
export async function findPendingLinksToIssue(targetIssueKey) {
  const pendingLinksIndex = await storage.get('pending-links-index') || [];
  const results = [];
  
  for (const sourceIssueKey of pendingLinksIndex) {
    const pendingLinks = await storage.get(`pending-links:${sourceIssueKey}`) || [];
    for (const link of pendingLinks) {
      if (link.linkedIssueKey === targetIssueKey) {
        results.push({
          sourceIssueKey,
          ...link
        });
      }
    }
  }
  
  return results;
}

export async function removePendingLink(issueKey, linkId) {
  const pendingLinks = await storage.get(`pending-links:${issueKey}`) || [];
  const filtered = pendingLinks.filter(l => l.linkId !== linkId);
  if (filtered.length === 0) {
    await storage.delete(`pending-links:${issueKey}`);
    await removeIssueFromPendingLinksIndex(issueKey);
  } else {
    await storage.set(`pending-links:${issueKey}`, filtered);
  }
}

export async function removeIssueFromPendingLinksIndex(issueKey) {
  const pendingLinksIndex = await storage.get('pending-links-index') || [];
  const updatedIndex = pendingLinksIndex.filter(key => key !== issueKey);
  await storage.set('pending-links-index', updatedIndex);
}
