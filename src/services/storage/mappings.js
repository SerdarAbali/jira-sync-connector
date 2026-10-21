import * as kvsStore from './kvs.js';
import { redactSecrets } from '../../utils/redaction.js';

const ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

export class MappingConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'MappingConflictError';
    this.code = 'MAPPING_CONFLICT';
    this.details = details;
  }
}

export function isValidIssueKey(key) {
  return typeof key === 'string' && key.length <= 100 && ISSUE_KEY_PATTERN.test(key);
}

function mappingKeys(localKey, remoteKey, orgId) {
  return {
    localToRemote: orgId ? `${orgId}:local-to-remote:${localKey}` : `local-to-remote:${localKey}`,
    remoteToLocal: orgId ? `${orgId}:remote-to-local:${remoteKey}` : `remote-to-local:${remoteKey}`,
    meta: orgId ? `mapping-meta:${orgId}:${localKey}` : `mapping-meta:legacy:${localKey}`,
    repair: orgId ? `mapping-repair:${orgId}:${localKey}:${remoteKey}` : `mapping-repair:legacy:${localKey}:${remoteKey}`
  };
}

// Cache for organizations to reduce KVS calls
let orgsCache = {
  data: null,
  timestamp: 0
};
const ORG_CACHE_TTL = 5000; // 5 seconds

// Helper to get organizations with their API tokens from secret storage.
// Plaintext tokens in organization records are deliberately ignored.
export async function getOrganizationsWithTokens() {
  const now = Date.now();
  if (orgsCache.data && (now - orgsCache.timestamp < ORG_CACHE_TTL)) {
    return orgsCache.data;
  }

  const orgs = await kvsStore.get('organizations') || [];
  const orgsWithTokens = await Promise.all(orgs.map(async (org) => {
    const token = await kvsStore.getSecret(`secret:${org.id}:token`);
    return {
      ...redactSecrets(org),
      remoteApiToken: token || ''
    };
  }));

  // Legacy fallback uses only secret storage. If a legacy configuration exists
  // without a migrated secret, it is not usable until migration completes.
  if (orgs.length === 0) {
    const legacyOrg = await getLegacyOrganizationWithToken();
    if (legacyOrg) {
      orgsCache = { data: [legacyOrg], timestamp: now };
      return [legacyOrg];
    }
  }

  orgsCache = {
    data: orgsWithTokens,
    timestamp: now
  };
  
  return orgsWithTokens;
}

async function getLegacyOrganizationWithToken() {
  const legacyConfig = await kvsStore.get('syncConfig');
  if (!legacyConfig || !legacyConfig.remoteUrl) {
    return null;
  }

  const token = await kvsStore.getSecret('secret:legacy:token');
  return {
    id: 'legacy',
    name: 'Legacy Organization',
    remoteUrl: legacyConfig.remoteUrl,
    remoteEmail: legacyConfig.remoteEmail,
    remoteProjectKey: legacyConfig.remoteProjectKey,
    allowedProjects: legacyConfig.allowedProjects || [],
    jqlFilter: legacyConfig.jqlFilter || '',
    syncDirection: legacyConfig.syncDirection || 'push',
    remoteApiToken: token || ''
  };
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
  if (!isValidIssueKey(localKey) || !isValidIssueKey(remoteKey)) {
    throw new Error('Invalid issue key in mapping');
  }

  const keys = mappingKeys(localKey, remoteKey, orgId);
  const [existingRemote, existingLocal] = await Promise.all([
    kvsStore.get(keys.localToRemote),
    kvsStore.get(keys.remoteToLocal)
  ]);

  if (existingRemote && existingRemote !== remoteKey) {
    throw new MappingConflictError('Local issue already maps to a different remote issue', {
      localKey, remoteKey, existingRemote
    });
  }
  if (existingLocal && existingLocal !== localKey) {
    throw new MappingConflictError('Remote issue already maps to a different local issue', {
      localKey, remoteKey, existingLocal
    });
  }

  const metadata = {
    localKey,
    remoteKey,
    orgId: orgId || 'legacy',
    updatedAt: new Date().toISOString()
  };
  const idempotent = !!(existingRemote === remoteKey && existingLocal === localKey);

  let atomicWriteSucceeded = false;
  if (typeof kvsStore.transaction === 'function') {
    try {
      await kvsStore.transaction()
        .set(keys.localToRemote, remoteKey)
        .set(keys.remoteToLocal, localKey)
        .set(keys.meta, metadata)
        .execute();
      atomicWriteSucceeded = true;
    } catch {
      console.warn('Mapping transaction failed; using compensating writes');
    }
  }

  if (!atomicWriteSucceeded) {
    const results = [];
    results.push(await settleWrite(keys.remoteToLocal, localKey));
    results.push(await settleWrite(keys.localToRemote, remoteKey));
    results.push(await settleWrite(keys.meta, metadata));

    if (results.some(result => !result.ok)) {
      try {
        await kvsStore.set(keys.repair, {
          localKey,
          remoteKey,
          orgId: orgId || 'legacy',
          reason: 'partial-mapping-write',
          detectedAt: new Date().toISOString()
        });
      } catch {
        // The mismatch is still observable by reading both directions.
      }
      throw new Error('Partial mapping write requires repair');
    }
  }

  return { localKey, remoteKey, idempotent };
}

async function settleWrite(key, value) {
  try {
    await kvsStore.set(key, value);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function ensureMappingPair(localKey, remoteKey, orgId = null) {
  if (!isValidIssueKey(localKey) || !isValidIssueKey(remoteKey)) {
    throw new Error('Invalid issue key in mapping');
  }
  const keys = mappingKeys(localKey, remoteKey, orgId);
  const [existingRemote, existingLocal] = await Promise.all([
    kvsStore.get(keys.localToRemote),
    kvsStore.get(keys.remoteToLocal)
  ]);
  if ((existingRemote && existingRemote !== remoteKey) || (existingLocal && existingLocal !== localKey)) {
    throw new MappingConflictError('Existing mapping refers to a different issue pair', {
      localKey, remoteKey
    });
  }
  if (!existingRemote) await kvsStore.set(keys.localToRemote, remoteKey);
  if (!existingLocal) await kvsStore.set(keys.remoteToLocal, localKey);
  return { localKey, remoteKey, repaired: !existingRemote || !existingLocal };
}

export async function getMappingRepairRecord(localKey, remoteKey, orgId = null) {
  const keys = mappingKeys(localKey, remoteKey, orgId);
  return await kvsStore.get(keys.repair);
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

export async function removeAttachmentMapping(localAttachmentId, orgId = null) {
  const key = orgId ? `${orgId}:attachment-mapping:${localAttachmentId}` : `attachment-mapping:${localAttachmentId}`;
  await kvsStore.del(key);
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

function buildCommentLocalKey(localCommentId, orgId) {
  return orgId ? `${orgId}:comment-local-to-remote:${localCommentId}` : `comment-local-to-remote:${localCommentId}`;
}

function buildCommentRemoteKey(remoteCommentId, orgId) {
  return orgId ? `${orgId}:comment-remote-to-local:${remoteCommentId}` : `comment-remote-to-local:${remoteCommentId}`;
}

function buildCommentMetaKey(remoteCommentId, orgId) {
  return orgId ? `comment-meta:${orgId}:${remoteCommentId}` : `comment-meta:legacy:${remoteCommentId}`;
}

function buildCommentMetaLocalKey(localCommentId, orgId) {
  return orgId ? `comment-meta-local:${orgId}:${localCommentId}` : `comment-meta-local:legacy:${localCommentId}`;
}

export async function storeCommentMapping(localCommentId, remoteCommentId, orgId = null, metadata = {}) {
  if (!localCommentId || !remoteCommentId) {
    throw new Error('Both localCommentId and remoteCommentId are required to store comment mapping');
  }

  const localKey = buildCommentLocalKey(localCommentId, orgId);
  const remoteKey = buildCommentRemoteKey(remoteCommentId, orgId);
  const metaKeyRemote = buildCommentMetaKey(remoteCommentId, orgId);
  const metaKeyLocal = buildCommentMetaLocalKey(localCommentId, orgId);

  const payload = {
    localCommentId,
    remoteCommentId,
    parentLocalId: metadata.parentLocalId || null,
    parentRemoteId: metadata.parentRemoteId || null,
    orgId: orgId || 'legacy',
    createdAt: new Date().toISOString()
  };

  try {
    await kvsStore.transaction()
      .set(localKey, remoteCommentId)
      .set(remoteKey, localCommentId)
      .set(metaKeyRemote, payload)
      .set(metaKeyLocal, payload)
      .execute();
  } catch (error) {
    console.warn('Comment mapping transaction failed, falling back to individual writes:', error.message);
    await Promise.all([
      kvsStore.set(localKey, remoteCommentId),
      kvsStore.set(remoteKey, localCommentId),
      kvsStore.set(metaKeyRemote, payload),
      kvsStore.set(metaKeyLocal, payload)
    ]);
  }
}

export async function getRemoteCommentId(localCommentId, orgId = null) {
  if (!localCommentId) {
    return null;
  }
  return await kvsStore.get(buildCommentLocalKey(localCommentId, orgId));
}

export async function getLocalCommentId(remoteCommentId, orgId = null) {
  if (!remoteCommentId) {
    return null;
  }
  return await kvsStore.get(buildCommentRemoteKey(remoteCommentId, orgId));
}

export async function getCommentMetadataByRemoteId(remoteCommentId, orgId = null) {
  if (!remoteCommentId) {
    return null;
  }
  return await kvsStore.get(buildCommentMetaKey(remoteCommentId, orgId));
}

export async function getCommentMetadataByLocalId(localCommentId, orgId = null) {
  if (!localCommentId) {
    return null;
  }
  return await kvsStore.get(buildCommentMetaLocalKey(localCommentId, orgId));
}

export async function removeCommentMapping(localCommentId, remoteCommentId, orgId = null) {
  const tasks = [];
  if (localCommentId) {
    tasks.push(kvsStore.del(buildCommentLocalKey(localCommentId, orgId)));
    tasks.push(kvsStore.del(buildCommentMetaLocalKey(localCommentId, orgId)));
  }
  if (remoteCommentId) {
    tasks.push(kvsStore.del(buildCommentRemoteKey(remoteCommentId, orgId)));
    tasks.push(kvsStore.del(buildCommentMetaKey(remoteCommentId, orgId)));
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
  }
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

export async function getLastSyncedLocalUpdated(localKey, orgId = null) {
  const key = orgId ? `${orgId}:last-synced-updated:${localKey}` : `last-synced-updated:${localKey}`;
  return await kvsStore.get(key);
}

export async function setLastSyncedLocalUpdated(localKey, updatedStr, orgId = null) {
  const key = orgId ? `${orgId}:last-synced-updated:${localKey}` : `last-synced-updated:${localKey}`;
  await kvsStore.set(key, updatedStr);
}
