import { storage, fetch } from '@forge/api';
import { LOG_EMOJI, HTTP_STATUS } from '../../constants.js';
import { retryWithBackoff } from '../../utils/retry.js';
import { extractTextFromADF, textToADF, replaceMediaIdsInADF, extractSprintIds } from '../../utils/adf.js';
import { mapUserToRemote, reverseMapping } from '../../utils/mapping.js';
import { getRemoteKey, getLocalKey, storeMapping } from '../storage/mappings.js';
import { markSyncing, clearSyncFlag, isSyncing } from '../storage/flags.js';
import { trackWebhookSync, logAuditEntry } from '../storage/stats.js';
import { getFullIssue } from '../jira/local-client.js';
import { syncAttachments } from './attachment-sync.js';
import { syncIssueLinks } from './link-sync.js';
import { transitionRemoteIssue } from './transition-sync.js';
import { SyncResult } from './sync-result.js';
import { isProjectAllowedToSync } from '../../utils/validation.js';

export async function createRemoteIssue(issue, config, mappings, syncResult = null) {
  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
  
  // For initial creation, use text-only description
  let initialDescription;
  if (issue.fields.description) {
    if (typeof issue.fields.description === 'object') {
      const extractedText = extractTextFromADF(issue.fields.description);
      initialDescription = extractedText ? textToADF(extractedText) : textToADF('');
    } else if (typeof issue.fields.description === 'string') {
      initialDescription = textToADF(issue.fields.description);
    } else {
      initialDescription = textToADF('');
    }
  } else {
    initialDescription = textToADF('');
  }
  
  const remoteIssue = {
    fields: {
      project: { key: config.remoteProjectKey },
      summary: issue.fields.summary,
      description: initialDescription,
      issuetype: { name: issue.fields.issuetype.name }
    }
  };
  
  if (issue.fields.priority) {
    remoteIssue.fields.priority = { name: issue.fields.priority.name };
  }
  
  if (issue.fields.labels && issue.fields.labels.length > 0) {
    remoteIssue.fields.labels = issue.fields.labels;
  }

  if (issue.fields.duedate) {
    remoteIssue.fields.duedate = issue.fields.duedate;
  }

  if (issue.fields.components && issue.fields.components.length > 0) {
    remoteIssue.fields.components = issue.fields.components.map(c => ({ name: c.name }));
    console.log(`🏷️ Syncing ${issue.fields.components.length} component(s): ${issue.fields.components.map(c => c.name).join(', ')}`);
  }

  if (issue.fields.fixVersions && issue.fields.fixVersions.length > 0) {
    remoteIssue.fields.fixVersions = issue.fields.fixVersions.map(v => ({ name: v.name }));
    console.log(`🔖 Syncing ${issue.fields.fixVersions.length} fix version(s): ${issue.fields.fixVersions.map(v => v.name).join(', ')}`);
  }

  if (issue.fields.versions && issue.fields.versions.length > 0) {
    remoteIssue.fields.versions = issue.fields.versions.map(v => ({ name: v.name }));
    console.log(`📌 Syncing ${issue.fields.versions.length} affects version(s): ${issue.fields.versions.map(v => v.name).join(', ')}`);
  }

  if (issue.fields.timetracking && Object.keys(issue.fields.timetracking).length > 0) {
    remoteIssue.fields.timetracking = {};
    if (issue.fields.timetracking.originalEstimate) {
      remoteIssue.fields.timetracking.originalEstimate = issue.fields.timetracking.originalEstimate;
    }
    if (issue.fields.timetracking.remainingEstimate) {
      remoteIssue.fields.timetracking.remainingEstimate = issue.fields.timetracking.remainingEstimate;
    }
    console.log(`⏱️ Syncing time tracking: ${issue.fields.timetracking.originalEstimate || 'no estimate'}`);
  }

  if (issue.fields.parent && issue.fields.parent.key) {
    const remoteParentKey = await getRemoteKey(issue.fields.parent.key);
    if (remoteParentKey) {
      remoteIssue.fields.parent = { key: remoteParentKey };
      console.log(`🔗 Mapped parent: ${issue.fields.parent.key} → ${remoteParentKey}`);
    }
  }

  // Map assignee and reporter DURING creation
  if (issue.fields.assignee && issue.fields.assignee.accountId) {
    const mappedAssignee = mapUserToRemote(issue.fields.assignee.accountId, mappings.userMappings);
    if (mappedAssignee) {
      remoteIssue.fields.assignee = { accountId: mappedAssignee };
      console.log(`👤 Mapped assignee: ${issue.fields.assignee.accountId} → ${mappedAssignee}`);
    }
  }
  
  if (issue.fields.reporter && issue.fields.reporter.accountId) {
    const mappedReporter = mapUserToRemote(issue.fields.reporter.accountId, mappings.userMappings);
    if (mappedReporter) {
      remoteIssue.fields.reporter = { accountId: mappedReporter };
      console.log(`👤 Mapped reporter: ${issue.fields.reporter.accountId} → ${mappedReporter}`);
    }
  }

  // Apply field mappings with improved sprint handling
  const syncFieldOptions = await storage.get('syncOptions') || { syncSprints: false };
  const reversedFieldMap = reverseMapping(mappings.fieldMappings);
  for (const [localFieldId, remoteFieldId] of Object.entries(reversedFieldMap)) {
    if (issue.fields[localFieldId] !== undefined && issue.fields[localFieldId] !== null) {
      let fieldValue = issue.fields[localFieldId];

      console.log(`📝 Processing field ${localFieldId} → ${remoteFieldId}, value type: ${typeof fieldValue}, isArray: ${Array.isArray(fieldValue)}`);

      // Try to extract sprint IDs if this is sprint data
      const sprintIds = extractSprintIds(fieldValue);
      if (sprintIds !== null) {
        // This is a sprint field - check if sprint sync is enabled
        if (!syncFieldOptions.syncSprints) {
          console.log(`⏭️ Skipping sprint field ${localFieldId} - sprint sync disabled`);
          continue;
        }
        fieldValue = sprintIds;
        console.log(`🏃 Extracted sprint IDs for ${localFieldId} → ${remoteFieldId}: ${JSON.stringify(fieldValue)}`);
      } else if (Array.isArray(fieldValue) && fieldValue.length > 0 && typeof fieldValue[0] === 'object') {
        // This might be sprint data but extraction failed - skip it to avoid errors
        console.warn(`⚠️ Skipping ${localFieldId} - looks like sprint data but couldn't extract IDs. Original value:`, JSON.stringify(fieldValue[0]));
        continue;
      }

      // Skip empty arrays to avoid errors
      if (Array.isArray(fieldValue) && fieldValue.length === 0) {
        console.log(`⚠️ Skipping empty array for ${localFieldId}`);
        continue;
      }

      remoteIssue.fields[remoteFieldId] = fieldValue;
    }
  }

  try {
    console.log('Creating remote issue for:', issue.key);

    // Mark issue as syncing to prevent concurrent sync operations
    await markSyncing(issue.key);

    const response = await retryWithBackoff(async () => {
      return await fetch(`${config.remoteUrl}/rest/api/3/issue`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(remoteIssue)
      });
    }, `Create issue ${issue.key}`);

    if (response.ok) {
      const result = await response.json();
      console.log(`${LOG_EMOJI.SUCCESS} Created ${issue.key} → ${result.key}`);

      // CRITICAL: Store mapping IMMEDIATELY to prevent duplicate creation
      await storeMapping(issue.key, result.key);

      if (issue.fields.status && issue.fields.status.name !== 'To Do') {
        await transitionRemoteIssue(result.key, issue.fields.status.name, config, mappings.statusMappings, syncResult);
      }

      // Get sync options
      const syncOptions = await storage.get('syncOptions') || { syncAttachments: true, syncLinks: true, syncSprints: false };

      // Sync attachments after issue creation and get mapping (if enabled)
      let attachmentMapping = {};
      if (syncOptions.syncAttachments) {
        attachmentMapping = await syncAttachments(issue.key, result.key, issue, config, syncResult);
      } else {
        console.log(`⏭️ Skipping attachments sync (disabled in sync options)`);
      }

      // Sync issue links after issue creation (if enabled)
      if (syncOptions.syncLinks) {
        await syncIssueLinks(issue.key, result.key, issue, config, syncResult);
      } else {
        console.log(`⏭️ Skipping links sync (disabled in sync options)`);
      }

      // If description had media nodes and we have mappings, update description with corrected IDs
      if (issue.fields.description &&
          typeof issue.fields.description === 'object' &&
          Object.keys(attachmentMapping).length > 0) {

        const correctedDescription = await replaceMediaIdsInADF(issue.fields.description, attachmentMapping);

        console.log(`🖼️ Updating description with corrected media references...`);
        const updateResponse = await retryWithBackoff(async () => {
          return await fetch(`${config.remoteUrl}/rest/api/3/issue/${result.key}`, {
            method: 'PUT',
            headers: {
              'Authorization': `Basic ${auth}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              fields: {
                description: correctedDescription
              }
            })
          });
        }, `Update description for ${result.key}`);

        if (updateResponse.ok || updateResponse.status === HTTP_STATUS.NO_CONTENT) {
          console.log(`${LOG_EMOJI.SUCCESS} Updated description with embedded media`);
        } else {
          const warningMsg = 'Could not update description with media - using text-only';
          console.log(`${LOG_EMOJI.WARNING} ${warningMsg}`);
          if (syncResult) syncResult.addWarning(warningMsg);
        }
      }

      // Clear sync flag on success
      await clearSyncFlag(issue.key);
      return result.key;
    } else {
      const errorText = await response.text();
      console.error(`${LOG_EMOJI.ERROR} Create failed: ${errorText}`);
      if (syncResult) syncResult.addError(`Create failed: ${errorText}`);
      await clearSyncFlag(issue.key);
    }
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error creating remote issue:`, error);
    if (syncResult) syncResult.addError(`Error creating remote issue: ${error.message}`);
    await clearSyncFlag(issue.key);
  }

  return null;
}

export async function updateRemoteIssue(localKey, remoteKey, issue, config, mappings, syncResult = null) {
  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');

  // Mark issue as syncing to prevent concurrent sync operations
  await markSyncing(localKey);

  // Get sync options
  const syncOptions = await storage.get('syncOptions') || { syncAttachments: true, syncLinks: true, syncSprints: false };

  // Sync attachments first to get ID mappings (if enabled)
  let attachmentMapping = {};
  if (syncOptions.syncAttachments) {
    attachmentMapping = await syncAttachments(localKey, remoteKey, issue, config, syncResult);
  } else {
    console.log(`⏭️ Skipping attachments sync (disabled in sync options)`);
  }

  // Sync issue links (if enabled)
  if (syncOptions.syncLinks) {
    await syncIssueLinks(localKey, remoteKey, issue, config, syncResult);
  } else {
    console.log(`⏭️ Skipping links sync (disabled in sync options)`);
  }

  let description;
  if (issue.fields.description) {
    if (typeof issue.fields.description === 'object') {
      // Always extract text only for updates to avoid media ID mapping issues
      const extractedText = extractTextFromADF(issue.fields.description);
      description = extractedText ? textToADF(extractedText) : textToADF('');
    } else if (typeof issue.fields.description === 'string') {
      description = textToADF(issue.fields.description);
    } else {
      description = textToADF('');
    }
  } else {
    description = textToADF('');
  }
  
  const updateData = {
    fields: {
      summary: issue.fields.summary,
      description: description
    }
  };
  
  if (issue.fields.priority) {
    updateData.fields.priority = { name: issue.fields.priority.name };
  }
  
  if (issue.fields.labels) {
    updateData.fields.labels = issue.fields.labels;
  }

  if (issue.fields.duedate) {
    updateData.fields.duedate = issue.fields.duedate;
  }

  if (issue.fields.components && issue.fields.components.length > 0) {
    updateData.fields.components = issue.fields.components.map(c => ({ name: c.name }));
    console.log(`🏷️ Updating ${issue.fields.components.length} component(s): ${issue.fields.components.map(c => c.name).join(', ')}`);
  } else if (issue.fields.components && issue.fields.components.length === 0) {
    updateData.fields.components = [];
    console.log(`🏷️ Clearing components`);
  }

  if (issue.fields.fixVersions && issue.fields.fixVersions.length > 0) {
    updateData.fields.fixVersions = issue.fields.fixVersions.map(v => ({ name: v.name }));
    console.log(`🔖 Updating ${issue.fields.fixVersions.length} fix version(s): ${issue.fields.fixVersions.map(v => v.name).join(', ')}`);
  } else if (issue.fields.fixVersions && issue.fields.fixVersions.length === 0) {
    updateData.fields.fixVersions = [];
    console.log(`🔖 Clearing fix versions`);
  }

  if (issue.fields.versions && issue.fields.versions.length > 0) {
    updateData.fields.versions = issue.fields.versions.map(v => ({ name: v.name }));
    console.log(`📌 Updating ${issue.fields.versions.length} affects version(s): ${issue.fields.versions.map(v => v.name).join(', ')}`);
  } else if (issue.fields.versions && issue.fields.versions.length === 0) {
    updateData.fields.versions = [];
    console.log(`📌 Clearing affects versions`);
  }

  if (issue.fields.timetracking && Object.keys(issue.fields.timetracking).length > 0) {
    updateData.fields.timetracking = {};
    if (issue.fields.timetracking.originalEstimate) {
      updateData.fields.timetracking.originalEstimate = issue.fields.timetracking.originalEstimate;
    }
    if (issue.fields.timetracking.remainingEstimate) {
      updateData.fields.timetracking.remainingEstimate = issue.fields.timetracking.remainingEstimate;
    }
    console.log(`⏱️ Updating time tracking: ${issue.fields.timetracking.originalEstimate || 'no estimate'}`);
  }

  // Handle parent field changes
  if (issue.fields.parent && issue.fields.parent.key) {
    const remoteParentKey = await getRemoteKey(issue.fields.parent.key);
    if (remoteParentKey) {
      updateData.fields.parent = { key: remoteParentKey };
      console.log(`🔗 Mapped parent: ${issue.fields.parent.key} → ${remoteParentKey}`);
    }
  } else if (issue.fields.parent === null) {
    updateData.fields.parent = null;
    console.log(`🔗 Removing parent link`);
  }

  if (issue.fields.assignee && issue.fields.assignee.accountId) {
    const mappedAssignee = mapUserToRemote(issue.fields.assignee.accountId, mappings.userMappings);
    if (mappedAssignee) {
      updateData.fields.assignee = { accountId: mappedAssignee };
      console.log(`👤 Mapped assignee: ${issue.fields.assignee.accountId} → ${mappedAssignee}`);
    }
  } else if (issue.fields.assignee === null) {
    updateData.fields.assignee = null;
    console.log(`👤 Unassigning issue`);
  }

  // Apply field mappings with improved sprint handling
  const reversedFieldMap = reverseMapping(mappings.fieldMappings);

  for (const [localFieldId, remoteFieldId] of Object.entries(reversedFieldMap)) {
    if (issue.fields[localFieldId] !== undefined && issue.fields[localFieldId] !== null) {
      let fieldValue = issue.fields[localFieldId];

      console.log(`📝 Processing field ${localFieldId} → ${remoteFieldId}, value type: ${typeof fieldValue}, isArray: ${Array.isArray(fieldValue)}`);

      // Try to extract sprint IDs if this is sprint data
      const sprintIds = extractSprintIds(fieldValue);
      if (sprintIds !== null) {
        // This is a sprint field - check if sprint sync is enabled
        if (!syncOptions.syncSprints) {
          console.log(`⏭️ Skipping sprint field ${localFieldId} - sprint sync disabled`);
          continue;
        }
        fieldValue = sprintIds;
        console.log(`🏃 Extracted sprint IDs for ${localFieldId} → ${remoteFieldId}: ${JSON.stringify(fieldValue)}`);
      } else if (Array.isArray(fieldValue) && fieldValue.length > 0 && typeof fieldValue[0] === 'object') {
        // This might be sprint data but extraction failed - skip it to avoid errors
        console.warn(`⚠️ Skipping ${localFieldId} - looks like sprint data but couldn't extract IDs. Original value:`, JSON.stringify(fieldValue[0]));
        continue;
      }

      // Skip empty arrays to avoid errors
      if (Array.isArray(fieldValue) && fieldValue.length === 0) {
        console.log(`⚠️ Skipping empty array for ${localFieldId}`);
        continue;
      }

      updateData.fields[remoteFieldId] = fieldValue;
    }
  }

  try {
    console.log(`Updating remote issue: ${localKey} → ${remoteKey}`);

    const response = await retryWithBackoff(async () => {
      return await fetch(`${config.remoteUrl}/rest/api/3/issue/${remoteKey}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updateData)
      });
    }, `Update issue ${remoteKey}`);

    if (response.ok || response.status === HTTP_STATUS.NO_CONTENT) {
      console.log(`${LOG_EMOJI.SUCCESS} Updated ${remoteKey} fields`);

      if (issue.fields.status) {
        await transitionRemoteIssue(remoteKey, issue.fields.status.name, config, mappings.statusMappings, syncResult);
      }
      await clearSyncFlag(localKey);
    } else {
      const errorText = await response.text();
      console.error(`${LOG_EMOJI.ERROR} Update failed: ${errorText}`);
      if (syncResult) syncResult.addError(`Update failed: ${errorText}`);
      await clearSyncFlag(localKey);
    }
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error updating remote issue:`, error);
    if (syncResult) syncResult.addError(`Error updating remote issue: ${error.message}`);
    await clearSyncFlag(localKey);
  }
}

export async function syncIssue(event) {
  const issueKey = event.issue.key;

  // Check if LOCAL issue is syncing
  if (await isSyncing(issueKey)) {
    console.log(`⏭️ Skipping ${issueKey} - currently syncing`);
    await trackWebhookSync('skip', false, 'Already syncing');
    return;
  }

  const config = await storage.get('syncConfig');

  if (!config || !config.remoteUrl) {
    console.log('Sync skipped: not configured');
    await trackWebhookSync('skip', false, 'Not configured');
    return;
  }

  const issue = await getFullIssue(issueKey);
  if (!issue) {
    console.error('Could not fetch issue data');
    await trackWebhookSync('skip', false, `Could not fetch issue data for ${issueKey}`);
    return;
  }

  // Check if project is allowed to sync
  const projectKey = issue.fields.project.key;
  const isAllowed = await isProjectAllowedToSync(projectKey, config);
  if (!isAllowed) {
    console.log(`⏭️ Skipping ${issueKey} - project ${projectKey} not in allowed list`);
    await trackWebhookSync('skip', false, `Project ${projectKey} not allowed`);
    return;
  }

  // Fetch all mappings ONCE
  const [userMappings, fieldMappings, statusMappings] = await Promise.all([
    storage.get('userMappings'),
    storage.get('fieldMappings'),
    storage.get('statusMappings')
  ]);

  const mappings = {
    userMappings: userMappings || {},
    fieldMappings: fieldMappings || {},
    statusMappings: statusMappings || {}
  };

  console.log(`${LOG_EMOJI.INFO} Processing ${issueKey}, event: ${event.eventType}`);

  const existingRemoteKey = await getRemoteKey(issueKey);

  // Create sync result tracker
  const syncResult = new SyncResult(existingRemoteKey ? 'update' : 'create');

  let remoteKey = existingRemoteKey;

  try {
    if (existingRemoteKey) {
      console.log(`${LOG_EMOJI.UPDATE} UPDATE: ${issueKey} → ${existingRemoteKey}`);
      await updateRemoteIssue(issueKey, existingRemoteKey, issue, config, mappings, syncResult);
      await trackWebhookSync('update', syncResult.success, syncResult.errors.join('; '));
      await logAuditEntry({
        action: 'update',
        sourceIssue: issueKey,
        targetIssue: existingRemoteKey,
        success: syncResult.success,
        errors: syncResult.errors
      });
    } else {
      console.log(`${LOG_EMOJI.CREATE} CREATE: ${issueKey}`);
      remoteKey = await createRemoteIssue(issue, config, mappings, syncResult);
      await trackWebhookSync('create', syncResult.success && remoteKey, syncResult.errors.join('; '));
      await logAuditEntry({
        action: 'create',
        sourceIssue: issueKey,
        targetIssue: remoteKey,
        success: syncResult.success && remoteKey,
        errors: syncResult.errors
      });
    }
  } catch (error) {
    await trackWebhookSync(existingRemoteKey ? 'update' : 'create', false, error.message);
    await logAuditEntry({
      action: existingRemoteKey ? 'update' : 'create',
      sourceIssue: issueKey,
      targetIssue: existingRemoteKey || null,
      success: false,
      errors: [error.message]
    });
    throw error;
  }

  // Log comprehensive summary
  syncResult.logSummary(issueKey, remoteKey);
}
