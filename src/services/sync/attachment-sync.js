import { LOG_EMOJI, MAX_ATTACHMENT_SIZE, MAX_ATTACHMENT_SIZE_MB } from '../../constants.js';
import { getAttachmentMapping, storeAttachmentMapping } from '../storage/mappings.js';
import { downloadAttachment } from '../jira/local-client.js';
import { uploadAttachment, getRemoteIssueAttachments } from '../jira/remote-client.js';

export async function syncAttachments(localIssueKey, remoteIssueKey, issue, config, syncResult = null, orgId = null) {
  const attachmentMapping = {}; // localId -> remoteId

  if (!issue.fields.attachment || issue.fields.attachment.length === 0) {
    console.log(`No attachments to sync for ${localIssueKey}`);
    return attachmentMapping;
  }

  console.log(`${LOG_EMOJI.ATTACHMENT} Found ${issue.fields.attachment.length} attachment(s) on ${localIssueKey}`);

  // Get existing attachments on remote issue to prevent duplicates
  const remoteAttachments = await getRemoteIssueAttachments(remoteIssueKey, config);
  console.log(`${LOG_EMOJI.INFO} Remote issue ${remoteIssueKey} has ${remoteAttachments.length} existing attachment(s)`);

  for (const attachment of issue.fields.attachment) {
    try {
      // Check if already synced (org-specific mapping)
      const existingMapping = await getAttachmentMapping(attachment.id, orgId);
      if (existingMapping) {
        console.log(`${LOG_EMOJI.SKIP} Attachment ${attachment.filename} already synced (mapping exists: ${existingMapping})`);
        attachmentMapping[attachment.id] = existingMapping;
        if (syncResult) syncResult.addAttachmentSkipped(attachment.filename, 'already synced');
        continue;
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

    } catch (error) {
      console.error(`${LOG_EMOJI.ERROR} Error syncing attachment ${attachment.filename}:`, error);
      if (syncResult) syncResult.addAttachmentFailure(attachment.filename, error.message);
    }
  }

  return attachmentMapping;
}
