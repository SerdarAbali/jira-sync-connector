import { LOG_EMOJI, MAX_ATTACHMENT_SIZE, MAX_ATTACHMENT_SIZE_MB } from '../../constants.js';
import { getAttachmentMapping, storeAttachmentMapping, removeAttachmentMapping } from '../storage/mappings.js';
import { downloadAttachment } from '../jira/local-client.js';
import { uploadAttachment, getRemoteIssueAttachments } from '../jira/remote-client.js';
import * as kvsStore from '../storage/kvs.js';

// Lock timeout for attachment sync (30 seconds)
const ATTACHMENT_LOCK_TTL_MS = 30000;

function normalizeAttachmentMappingValue(mapping) {
  if (!mapping) {
    return null;
  }

  if (typeof mapping === 'string') {
    return mapping;
  }

  if (typeof mapping === 'number') {
    return String(mapping);
  }

  if (typeof mapping === 'object') {
    if (typeof mapping.remoteAttachmentId === 'string') {
      return mapping.remoteAttachmentId;
    }
    if (typeof mapping.remoteId === 'string') {
      return mapping.remoteId;
    }
    if (typeof mapping.id === 'string') {
      return mapping.id;
    }
  }

  return null;
}

/**
 * Try to acquire a lock for syncing a specific attachment
 * Returns true if lock acquired, false if already locked
 */
async function tryAcquireAttachmentLock(attachmentId, orgId) {
  const lockKey = orgId 
    ? `attachment-lock:${orgId}:${attachmentId}` 
    : `attachment-lock:${attachmentId}`;
  
  const existing = await kvsStore.get(lockKey);
  if (existing && existing.expiresAt > Date.now()) {
    // Lock exists and hasn't expired
    return false;
  }
  
  // Acquire lock
  await kvsStore.set(lockKey, { 
    lockedAt: Date.now(), 
    expiresAt: Date.now() + ATTACHMENT_LOCK_TTL_MS 
  });
  return true;
}

/**
 * Release attachment lock
 */
async function releaseAttachmentLock(attachmentId, orgId) {
  const lockKey = orgId 
    ? `attachment-lock:${orgId}:${attachmentId}` 
    : `attachment-lock:${attachmentId}`;
  await kvsStore.del(lockKey);
}

export async function syncAttachments(localIssueKey, remoteIssueKey, issue, config, syncResult = null, orgId = null, forceCheck = false) {
  const attachmentMapping = {}; // localId -> remoteId

  if (!issue.fields.attachment || issue.fields.attachment.length === 0) {
    console.log(`No attachments to sync for ${localIssueKey}`);
    return attachmentMapping;
  }

  console.log(`${LOG_EMOJI.ATTACHMENT} Found ${issue.fields.attachment.length} attachment(s) on ${localIssueKey}`);

  // Get existing attachments on remote issue to prevent duplicates
  let remoteAttachments = await getRemoteIssueAttachments(remoteIssueKey, config);
  console.log(`${LOG_EMOJI.INFO} Remote issue ${remoteIssueKey} has ${remoteAttachments.length} existing attachment(s)`);

  for (const attachment of issue.fields.attachment) {
    try {
      // Check if already synced (org-specific mapping)
      const rawMapping = await getAttachmentMapping(attachment.id, orgId);
      let existingMapping = normalizeAttachmentMappingValue(rawMapping);

      if (rawMapping && !existingMapping) {
        console.log(`${LOG_EMOJI.WARNING} Attachment ${attachment.filename} had invalid mapping data, removing to force re-sync`);
        await removeAttachmentMapping(attachment.id, orgId);
      } else if (rawMapping && existingMapping && rawMapping !== existingMapping) {
        console.log(`${LOG_EMOJI.INFO} Attachment ${attachment.filename} mapping normalized to id ${existingMapping}`);
        await storeAttachmentMapping(attachment.id, existingMapping, orgId);
      }
      
      if (existingMapping) {
        const existsOnRemote = remoteAttachments.some(
          remote => remote.id === existingMapping
        );

        if (existsOnRemote) {
          if (forceCheck) {
            console.log(`${LOG_EMOJI.SKIP} Attachment ${attachment.filename} verified on remote`);
            if (syncResult) syncResult.addAttachmentSkipped(attachment.filename, 'verified on remote');
          } else {
            console.log(`${LOG_EMOJI.SKIP} Attachment ${attachment.filename} already synced (mapping exists: ${existingMapping})`);
            if (syncResult) syncResult.addAttachmentSkipped(attachment.filename, 'already synced');
          }

          attachmentMapping[attachment.id] = existingMapping;
          continue;
        }

        console.log(`${LOG_EMOJI.WARNING} Attachment ${attachment.filename} mapping exists but not on remote - will re-upload`);
        await removeAttachmentMapping(attachment.id, orgId);
        existingMapping = null;
      }

      // Additional check: Does remote issue already have this file by name and size?
      const duplicateOnRemote = remoteAttachments.find(
        remote => remote.filename === attachment.filename && 
                  remote.size === attachment.size
      );
      
      if (duplicateOnRemote) {
        console.log(`${LOG_EMOJI.SKIP} Attachment ${attachment.filename} already exists on remote (id: ${duplicateOnRemote.id})`);
        // Store the mapping for future reference
        await storeAttachmentMapping(attachment.id, duplicateOnRemote.id, orgId);
        attachmentMapping[attachment.id] = duplicateOnRemote.id;
        if (syncResult) syncResult.addAttachmentSkipped(attachment.filename, 'already exists on remote');
        continue;
      }

      // Check file size
      if (attachment.size > MAX_ATTACHMENT_SIZE) {
        console.log(`${LOG_EMOJI.WARNING} Skipping ${attachment.filename} - too large (${(attachment.size / 1024 / 1024).toFixed(2)}MB > ${MAX_ATTACHMENT_SIZE_MB}MB)`);
        if (syncResult) syncResult.addAttachmentSkipped(attachment.filename, `too large (${(attachment.size / 1024 / 1024).toFixed(2)}MB)`);
        continue;
      }

      // Try to acquire lock to prevent concurrent uploads of same attachment
      const lockAcquired = await tryAcquireAttachmentLock(attachment.id, orgId);
      if (!lockAcquired) {
        console.log(`${LOG_EMOJI.SKIP} Attachment ${attachment.filename} is being synced by another process`);
        if (syncResult) syncResult.addAttachmentSkipped(attachment.filename, 'sync in progress');
        continue;
      }

      try {
        // Re-check mapping after acquiring lock (another process may have completed)
        const mappingAfterLock = await getAttachmentMapping(attachment.id, orgId);
        if (mappingAfterLock) {
          console.log(`${LOG_EMOJI.SKIP} Attachment ${attachment.filename} was synced by another process`);
          attachmentMapping[attachment.id] = mappingAfterLock;
          if (syncResult) syncResult.addAttachmentSkipped(attachment.filename, 'synced by another process');
          continue;
        }

        // Re-fetch remote attachments to catch any concurrent uploads
        remoteAttachments = await getRemoteIssueAttachments(remoteIssueKey, config);
        const recentDuplicate = remoteAttachments.find(
          remote => remote.filename === attachment.filename && 
                    remote.size === attachment.size
        );
        
        if (recentDuplicate) {
          console.log(`${LOG_EMOJI.SKIP} Attachment ${attachment.filename} was uploaded concurrently (id: ${recentDuplicate.id})`);
          await storeAttachmentMapping(attachment.id, recentDuplicate.id, orgId);
          attachmentMapping[attachment.id] = recentDuplicate.id;
          if (syncResult) syncResult.addAttachmentSkipped(attachment.filename, 'uploaded concurrently');
          continue;
        }

        console.log(`${LOG_EMOJI.DOWNLOAD} Downloading ${attachment.filename} (${(attachment.size / 1024).toFixed(2)}KB)...`);

        // Download from local Jira
        const fileBuffer = await downloadAttachment(attachment.content);
        if (!fileBuffer) {
          console.error(`${LOG_EMOJI.ERROR} Failed to download ${attachment.filename}`);
          if (syncResult) syncResult.addAttachmentFailure(attachment.filename, 'download failed');
          continue;
        }

        // Upload to remote Jira
        console.log(`${LOG_EMOJI.UPLOAD} Uploading ${attachment.filename} to ${remoteIssueKey}...`);
        const remoteAttachmentId = await uploadAttachment(remoteIssueKey, attachment.filename, fileBuffer, config);

        if (remoteAttachmentId) {
          // Store mapping to prevent re-syncing (org-specific)
          await storeAttachmentMapping(attachment.id, remoteAttachmentId, orgId);
          attachmentMapping[attachment.id] = remoteAttachmentId;
          console.log(`${LOG_EMOJI.SUCCESS} Synced attachment: ${attachment.filename} (remote id: ${remoteAttachmentId})`);
          if (syncResult) syncResult.addAttachmentSuccess(attachment.filename);
        } else {
          console.error(`${LOG_EMOJI.ERROR} Failed to upload ${attachment.filename}`);
          if (syncResult) syncResult.addAttachmentFailure(attachment.filename, 'upload failed');
        }
      } finally {
        // Always release the lock
        await releaseAttachmentLock(attachment.id, orgId);
      }

    } catch (error) {
      console.error(`${LOG_EMOJI.ERROR} Error syncing attachment ${attachment.filename}:`, error);
      if (syncResult) syncResult.addAttachmentFailure(attachment.filename, error.message);
    }
  }

  return attachmentMapping;
}
