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
 * Atomically move an existing pair to a replacement local/remote key. The old
 * lookup directions and metadata are removed only in the same transaction that
 * writes both new directions, so no partial active pair is observable.
 */
export async function replaceIssueMapping({
  oldLocalKey,
  oldRemoteKey,
  newLocalKey,
  newRemoteKey,
  orgId = null,
  now = Date.now()
}) {
  if (![oldLocalKey, oldRemoteKey, newLocalKey, newRemoteKey].every(isValidIssueKey)) {
    return { success: false, code: 'MAPPING_INVALID' };
  }
  if (typeof kvsStore.transaction !== 'function') {
    return { success: false, code: 'MAPPING_TRANSACTION_UNAVAILABLE' };
  }

  const oldKeys = mappingKeys(oldLocalKey, oldRemoteKey, orgId);
  const newKeys = mappingKeys(newLocalKey, newRemoteKey, orgId);
  const [existingLocalToRemote, existingRemoteToLocal] = await Promise.all([
    kvsStore.get(newKeys.localToRemote),
    kvsStore.get(newKeys.remoteToLocal)
  ]);
  if (existingLocalToRemote && existingLocalToRemote !== oldRemoteKey
      && existingLocalToRemote !== newRemoteKey) {
    throw new MappingConflictError('Replacement local issue already maps to a different remote issue', {
      localKey: newLocalKey, remoteKey: newRemoteKey, existingRemote: existingLocalToRemote
    });
  }
  if (existingRemoteToLocal && existingRemoteToLocal !== oldLocalKey
      && existingRemoteToLocal !== newLocalKey) {
    throw new MappingConflictError('Replacement remote issue already maps to a different local issue', {
      localKey: newLocalKey, remoteKey: newRemoteKey, existingLocal: existingRemoteToLocal
    });
  }

  const timestamp = new Date(now).toISOString();
  const metadata = {
    localKey: newLocalKey,
    remoteKey: newRemoteKey,
    orgId: orgId || 'legacy',
    updatedAt: timestamp,
    replacedAt: timestamp,
    previousLocalKey: oldLocalKey,
    previousRemoteKey: oldRemoteKey
  };

  const transaction = kvsStore.transaction();
  for (const key of new Set([oldKeys.localToRemote, oldKeys.remoteToLocal, oldKeys.meta])) {
    if (key !== newKeys.localToRemote && key !== newKeys.remoteToLocal && key !== newKeys.meta) {
      transaction.delete(key);
    }
  }
  await transaction
    .set(newKeys.localToRemote, newRemoteKey)
    .set(newKeys.remoteToLocal, newLocalKey)
    .set(newKeys.meta, metadata)
    .execute();

  return {
    success: true,
    localKey: newLocalKey,
    remoteKey: newRemoteKey,
    previousLocalKey: oldLocalKey,
    previousRemoteKey: oldRemoteKey
  };
}

/**
 * Permanently deactivate both active lookup directions. A safe ending record is
 * written in the same transaction. No Jira issue is deleted.
 */
export async function deactivateIssueMapping({
  localKey,
  remoteKey,
  orgId = null,
  endedAt = null,
  endedBy = null,
  reasonCode = 'administrator_ended',
  now = Date.now()
}) {
  if (!isValidIssueKey(localKey) || !isValidIssueKey(remoteKey)) {
    return { success: false, code: 'MAPPING_INVALID' };
  }
  if (typeof kvsStore.transaction !== 'function') {
    return { success: false, code: 'MAPPING_TRANSACTION_UNAVAILABLE' };
  }

  const keys = mappingKeys(localKey, remoteKey, orgId);
  const timestamp = new Date(now).toISOString();
  const endedRecordKey = orgId
    ? `mapping-ended:${orgId}:${localKey}:${remoteKey}`
    : `mapping-ended:legacy:${localKey}:${remoteKey}`;
  const endedRecord = {
    localKey,
    remoteKey,
    orgId: orgId || 'legacy',
    endedAt: typeof endedAt === 'string' ? endedAt : timestamp,
    endedBy: typeof endedBy === 'string' ? endedBy.slice(0, 100) : null,
    reasonCode: typeof reasonCode === 'string' ? reasonCode.slice(0, 80) : 'administrator_ended'
  };

  await kvsStore.transaction()
    .delete(keys.localToRemote)
    .delete(keys.remoteToLocal)
    .delete(keys.meta)
    .set(endedRecordKey, endedRecord)
    .execute();

  return { success: true, endedRecord };
}

export async function getMappingEndedRecord(localKey, remoteKey, orgId = null) {
  if (!isValidIssueKey(localKey) || !isValidIssueKey(remoteKey)) return null;
  const key = orgId
    ? `mapping-ended:${orgId}:${localKey}:${remoteKey}`
    : `mapping-ended:legacy:${localKey}:${remoteKey}`;
  return await kvsStore.get(key);
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

export async function storeAttachmentMapping(localAttachmentId, remoteAttachmentId, orgId = null, direction = null) {
  const key = attachmentMappingKey(localAttachmentId, orgId, direction);
  await kvsStore.set(key, remoteAttachmentId);
}

export async function getAttachmentMapping(localAttachmentId, orgId = null, direction = null) {
  const key = attachmentMappingKey(localAttachmentId, orgId, direction);
  const mapping = await kvsStore.get(key);
  if (mapping || direction !== 'local-to-remote') {
    return mapping;
  }
  // Read-only compatibility for mappings written before direction-scoped keys.
  return await kvsStore.get(attachmentMappingKey(localAttachmentId, orgId, null));
}

export async function removeAttachmentMapping(localAttachmentId, orgId = null, direction = null) {
  const keys = [attachmentMappingKey(localAttachmentId, orgId, direction)];
  if (direction === 'local-to-remote') {
    keys.push(attachmentMappingKey(localAttachmentId, orgId, null));
  }
  await Promise.all(keys.map(key => kvsStore.del(key)));
}

function attachmentMappingKey(attachmentId, orgId, direction) {
  const scope = orgId ? `${orgId}:` : '';
  if (direction === 'local-to-remote' || direction === 'remote-to-local') {
    return `${scope}attachment-mapping:${direction}:${attachmentId}`;
  }
  return `${scope}attachment-mapping:${attachmentId}`;
}

/**
 * Persist deletion/mapping history without filenames, URLs or content. This is
 * retained when deletion propagation is Off and after an enabled deletion
 * removes the active mapping.
 */
export async function storeAttachmentMappingHistory({
  orgId = null,
  direction,
  sourceAttachmentId,
  destinationAttachmentId,
  localKey = null,
  remoteKey = null,
  outcome = 'retained',
  now = new Date().toISOString()
}) {
  if (direction !== 'local-to-remote' && direction !== 'remote-to-local') {
    return null;
  }
  const scope = orgId ? String(orgId) : 'legacy';
  const key = `attachment-mapping-history:${scope}:${direction}:${sourceAttachmentId}`;
  const record = {
    orgId: orgId || null,
    direction,
    sourceAttachmentId: String(sourceAttachmentId),
    destinationAttachmentId: String(destinationAttachmentId),
    localKey,
    remoteKey,
    outcome,
    recordedAt: now
  };
  await kvsStore.set(key, record);
  return record;
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
