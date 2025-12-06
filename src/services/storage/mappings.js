import * as kvsStore from './kvs.js';

// Cache for organizations to reduce KVS calls
let orgsCache = {
  data: null,
  timestamp: 0
};
const ORG_CACHE_TTL = 5000; // 5 seconds

// Helper to get organizations with their API tokens from secret storage
export async function getOrganizationsWithTokens() {
  const now = Date.now();
  if (orgsCache.data && (now - orgsCache.timestamp < ORG_CACHE_TTL)) {
    return orgsCache.data;
  }

  const orgs = await kvsStore.get('organizations') || [];
  const orgsWithTokens = await Promise.all(orgs.map(async (org) => {
    const token = await kvsStore.getSecret(`secret:${org.id}:token`);
    return {
      ...org,
      remoteApiToken: token || org.remoteApiToken || '' // Fallback for migration
    };
  }));

  orgsCache = {
    data: orgsWithTokens,
    timestamp: now
  };
  
  return orgsWithTokens;
}

// Multi-org support: namespace mappings by orgId
export async function getRemoteKey(localKey, orgId = null) {
  const key = orgId ? `${orgId}:local-to-remote:${localKey}` : `local-to-remote:${localKey}`;
  return await kvsStore.get(key);
}

export async function getLocalKey(remoteKey, orgId = null) {
  const key = orgId ? `${orgId}:remote-to-local:${remoteKey}` : `remote-to-local:${remoteKey}`;
  return await kvsStore.get(key);
}

/**
 * Store a mapping between local and remote issue keys
 * Uses kvs.query() for retrieval instead of maintaining a separate index array
 */
export async function storeMapping(localKey, remoteKey, orgId = null) {
  const localToRemoteKey = orgId ? `${orgId}:local-to-remote:${localKey}` : `local-to-remote:${localKey}`;
  const remoteToLocalKey = orgId ? `${orgId}:remote-to-local:${remoteKey}` : `remote-to-local:${remoteKey}`;
  
  // Use transaction for atomic write (both mappings succeed or fail together)
  try {
    await kvsStore.transaction()
      .set(localToRemoteKey, remoteKey)
      .set(remoteToLocalKey, localKey)
      .execute();
  } catch (error) {
    // Fallback to individual writes if transaction fails
    console.warn('Transaction failed, falling back to individual writes:', error.message);
    await kvsStore.set(localToRemoteKey, remoteKey);
    await kvsStore.set(remoteToLocalKey, localKey);
  }
  
  // Store mapping metadata for queryability (replaces mappings-index array)
  // Key pattern: mapping-meta:{orgId}:{localKey} 
  const metaKey = orgId ? `mapping-meta:${orgId}:${localKey}` : `mapping-meta:legacy:${localKey}`;
  await kvsStore.set(metaKey, { 
    localKey, 
    remoteKey, 
    createdAt: new Date().toISOString() 
  });
}

export async function removeMapping(localKey, remoteKey, orgId = null) {
  const keysToDelete = [];
  
  if (localKey) {
    const localKeyName = orgId ? `${orgId}:local-to-remote:${localKey}` : `local-to-remote:${localKey}`;
    keysToDelete.push(localKeyName);
    
    // Remove mapping metadata
    const metaKey = orgId ? `mapping-meta:${orgId}:${localKey}` : `mapping-meta:legacy:${localKey}`;
    keysToDelete.push(metaKey);
  }
  if (remoteKey) {
    const remoteKeyName = orgId ? `${orgId}:remote-to-local:${remoteKey}` : `remote-to-local:${remoteKey}`;
    keysToDelete.push(remoteKeyName);
  }
  
  // Delete all keys (parallelize for efficiency)
  await Promise.all(keysToDelete.map(key => kvsStore.del(key)));
}

/**
 * Get all mappings for an org using kvs.query() instead of index array
 * This is more scalable and doesn't hit the 240 KiB value limit
 */
export async function getAllMappings(orgId = null) {
  const prefix = orgId ? `mapping-meta:${orgId}:` : `mapping-meta:legacy:`;
  const results = await kvsStore.queryByPrefix(prefix, 1000);
  return results.map(r => r.value);
}

/**
 * Add a mapping to the metadata store (for bootstrapping existing mappings)
 */
export async function addToMappingIndex(localKey, remoteKey, orgId = null) {
  const metaKey = orgId ? `mapping-meta:${orgId}:${localKey}` : `mapping-meta:legacy:${localKey}`;
  const existing = await kvsStore.get(metaKey);
  if (!existing) {
    await kvsStore.set(metaKey, { 
      localKey, 
      remoteKey, 
      createdAt: new Date().toISOString() 
    });
    return true; // Added
  }
  return false; // Already existed
}

export async function storeAttachmentMapping(localAttachmentId, remoteAttachmentId, orgId = null) {
  const key = orgId ? `${orgId}:attachment-mapping:${localAttachmentId}` : `attachment-mapping:${localAttachmentId}`;
  await kvsStore.set(key, remoteAttachmentId);
}

export async function getAttachmentMapping(localAttachmentId, orgId = null) {
  const key = orgId ? `${orgId}:attachment-mapping:${localAttachmentId}` : `attachment-mapping:${localAttachmentId}`;
  return await kvsStore.get(key);
}

export async function storeLinkMapping(localLinkId, remoteLinkId, orgId = null) {
  const key = orgId ? `${orgId}:link-mapping:${localLinkId}` : `link-mapping:${localLinkId}`;
  await kvsStore.set(key, remoteLinkId);
}

export async function getLinkMapping(localLinkId, orgId = null) {
  const key = orgId ? `${orgId}:link-mapping:${localLinkId}` : `link-mapping:${localLinkId}`;
  return await kvsStore.get(key);
}

export async function removeLinkMapping(localLinkId, orgId = null) {
  const key = orgId ? `${orgId}:link-mapping:${localLinkId}` : `link-mapping:${localLinkId}`;
  await kvsStore.del(key);
}

// Get all remote keys for a local issue (across all orgs)
export async function getAllRemoteKeys(localKey) {
  const orgs = await kvsStore.get('organizations') || [];
  const remoteKeys = [];
  
  for (const org of orgs) {
    const remoteKey = await getRemoteKey(localKey, org.id);
    if (remoteKey) {
      remoteKeys.push({ orgId: org.id, orgName: org.name, remoteKey });
    }
  }
  
  return remoteKeys;
}

/**
 * Migration helper: migrate from old mappings-index array to new metadata keys
 * Run this once per org to migrate existing data
 */
export async function migrateMappingsIndex(orgId = null) {
  const indexKey = orgId ? `mappings-index:${orgId}` : 'mappings-index';
  const oldIndex = await kvsStore.get(indexKey);
  
  if (!oldIndex || oldIndex.length === 0) {
    return { migrated: 0, message: 'No legacy index found' };
  }
  
  let migrated = 0;
  for (const mapping of oldIndex) {
    const metaKey = orgId ? `mapping-meta:${orgId}:${mapping.localKey}` : `mapping-meta:legacy:${mapping.localKey}`;
    const existing = await kvsStore.get(metaKey);
    if (!existing) {
      await kvsStore.set(metaKey, mapping);
      migrated++;
    }
  }
  
  return { migrated, total: oldIndex.length, message: 'Migration complete' };
}
