import { storage } from '@forge/api';

// Helper to get organizations with their API tokens from secret storage
export async function getOrganizationsWithTokens() {
  const orgs = await storage.get('organizations') || [];
  const orgsWithTokens = await Promise.all(orgs.map(async (org) => {
    const token = await storage.getSecret(`secret:${org.id}:token`);
    return {
      ...org,
      remoteApiToken: token || org.remoteApiToken || '' // Fallback for migration
    };
  }));
  return orgsWithTokens;
}

// Multi-org support: namespace mappings by orgId
export async function getRemoteKey(localKey, orgId = null) {
  const key = orgId ? `${orgId}:local-to-remote:${localKey}` : `local-to-remote:${localKey}`;
  return await storage.get(key);
}

export async function getLocalKey(remoteKey, orgId = null) {
  const key = orgId ? `${orgId}:remote-to-local:${remoteKey}` : `remote-to-local:${remoteKey}`;
  return await storage.get(key);
}

export async function storeMapping(localKey, remoteKey, orgId = null) {
  const localToRemoteKey = orgId ? `${orgId}:local-to-remote:${localKey}` : `local-to-remote:${localKey}`;
  const remoteToLocalKey = orgId ? `${orgId}:remote-to-local:${remoteKey}` : `remote-to-local:${remoteKey}`;
  
  await storage.set(localToRemoteKey, remoteKey);
  await storage.set(remoteToLocalKey, localKey);
  
  // Maintain an index of all mappings for this org (for scheduled sync to check deleted issues)
  const indexKey = orgId ? `mappings-index:${orgId}` : 'mappings-index';
  const index = await storage.get(indexKey) || [];
  if (!index.find(m => m.localKey === localKey)) {
    index.push({ localKey, remoteKey, createdAt: new Date().toISOString() });
    await storage.set(indexKey, index);
  }
}

export async function removeMapping(localKey, remoteKey, orgId = null) {
  if (localKey) {
    const localKeyName = orgId ? `${orgId}:local-to-remote:${localKey}` : `local-to-remote:${localKey}`;
    await storage.delete(localKeyName);
    
    // Remove from index
    const indexKey = orgId ? `mappings-index:${orgId}` : 'mappings-index';
    const index = await storage.get(indexKey) || [];
    const updatedIndex = index.filter(m => m.localKey !== localKey);
    await storage.set(indexKey, updatedIndex);
  }
  if (remoteKey) {
    const remoteKeyName = orgId ? `${orgId}:remote-to-local:${remoteKey}` : `remote-to-local:${remoteKey}`;
    await storage.delete(remoteKeyName);
  }
}

// Get all mappings for an org (for checking deleted remote issues)
export async function getAllMappings(orgId = null) {
  const indexKey = orgId ? `mappings-index:${orgId}` : 'mappings-index';
  return await storage.get(indexKey) || [];
}

// Add a mapping to the index (for bootstrapping existing mappings)
export async function addToMappingIndex(localKey, remoteKey, orgId = null) {
  const indexKey = orgId ? `mappings-index:${orgId}` : 'mappings-index';
  const index = await storage.get(indexKey) || [];
  if (!index.find(m => m.localKey === localKey)) {
    index.push({ localKey, remoteKey, createdAt: new Date().toISOString() });
    await storage.set(indexKey, index);
    return true; // Added
  }
  return false; // Already existed
}

export async function storeAttachmentMapping(localAttachmentId, remoteAttachmentId, orgId = null) {
  const key = orgId ? `${orgId}:attachment-mapping:${localAttachmentId}` : `attachment-mapping:${localAttachmentId}`;
  await storage.set(key, remoteAttachmentId);
}

export async function getAttachmentMapping(localAttachmentId, orgId = null) {
  const key = orgId ? `${orgId}:attachment-mapping:${localAttachmentId}` : `attachment-mapping:${localAttachmentId}`;
  return await storage.get(key);
}

export async function storeLinkMapping(localLinkId, remoteLinkId, orgId = null) {
  const key = orgId ? `${orgId}:link-mapping:${localLinkId}` : `link-mapping:${localLinkId}`;
  await storage.set(key, remoteLinkId);
}

export async function getLinkMapping(localLinkId, orgId = null) {
  const key = orgId ? `${orgId}:link-mapping:${localLinkId}` : `link-mapping:${localLinkId}`;
  return await storage.get(key);
}

// Get all remote keys for a local issue (across all orgs)
export async function getAllRemoteKeys(localKey) {
  const orgs = await storage.get('organizations') || [];
  const remoteKeys = [];
  
  for (const org of orgs) {
    const remoteKey = await getRemoteKey(localKey, org.id);
    if (remoteKey) {
      remoteKeys.push({ orgId: org.id, orgName: org.name, remoteKey });
    }
  }
  
  return remoteKeys;
}
