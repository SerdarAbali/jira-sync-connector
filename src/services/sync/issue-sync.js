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
import { syncAllComments } from './comment-sync.js';
import { transitionRemoteIssue } from './transition-sync.js';
import { SyncResult } from './sync-result.js';
import { isProjectAllowedToSync } from '../../utils/validation.js';

export async function syncIssue(event) {
  const issueKey = event.issue.key;

  // Check if LOCAL issue is syncing
  if (await isSyncing(issueKey)) {
    console.log(`⏭️ Skipping ${issueKey} - currently syncing`);
    await trackWebhookSync('skip', false, 'Already syncing', null, issueKey, {
      reason: 'Issue is currently being synced by another process',
      eventType: event.eventType
    });
    return;
  }

  // Get all organizations
  const organizations = await storage.get('organizations') || [];
  
  // Legacy support: check for old single-org config
  const legacyConfig = await storage.get('syncConfig');
  if (legacyConfig && legacyConfig.remoteUrl && organizations.length === 0) {
    console.log('⚠️ Using legacy single-org config - consider migrating to multi-org');
    organizations.push({
      id: 'legacy',
      name: 'Legacy Organization',
      ...legacyConfig
    });
  }

  if (organizations.length === 0) {
    console.log('Sync skipped: no organizations configured');
    await trackWebhookSync('skip', false, 'No organizations configured', null, issueKey, {
      reason: 'No target organizations configured in settings'
    });
    return;
  }

  const issue = await getFullIssue(issueKey);
  if (!issue) {
    console.error('Could not fetch issue data');
    await trackWebhookSync('skip', false, `Could not fetch issue data`, null, issueKey, {
      reason: 'Failed to retrieve issue from Jira API',
      eventType: event.eventType
    });
    return;
  }

  const projectKey = issue.fields.project.key;
  console.log(`${LOG_EMOJI.INFO} Processing ${issueKey}, event: ${event.eventType}`);
  console.log(`📦 Found ${organizations.length} configured organization(s)`);

  // Sync to all organizations
  for (const org of organizations) {
    console.log(`\n🌐 Syncing to organization: ${org.name} (${org.id})`);

    // Check if project is allowed to sync for this org
    const isAllowed = await isProjectAllowedToSync(projectKey, org);
    if (!isAllowed) {
      console.log(`⏭️ Skipping ${issueKey} for ${org.name} - project ${projectKey} not in allowed list`);
      continue;
    }

    // Fetch org-specific mappings
    const [userMappings, fieldMappings, statusMappings, syncOptions] = await Promise.all([
      storage.get(org.id === 'legacy' ? 'userMappings' : `userMappings:${org.id}`),
      storage.get(org.id === 'legacy' ? 'fieldMappings' : `fieldMappings:${org.id}`),
      storage.get(org.id === 'legacy' ? 'statusMappings' : `statusMappings:${org.id}`),
      storage.get(org.id === 'legacy' ? 'syncOptions' : `syncOptions:${org.id}`)
    ]);

    const mappings = {
      userMappings: userMappings || {},
      fieldMappings: fieldMappings || {},
      statusMappings: statusMappings || {}
    };

    const existingRemoteKey = await getRemoteKey(issueKey, org.id === 'legacy' ? null : org.id);

    // Create sync result tracker
    const syncResult = new SyncResult(existingRemoteKey ? 'update' : 'create');
    let remoteKey = existingRemoteKey;

    try {
      if (existingRemoteKey) {
        console.log(`${LOG_EMOJI.UPDATE} UPDATE for ${org.name}: ${issueKey} → ${existingRemoteKey}`);
        await updateRemoteIssueForOrg(issueKey, existingRemoteKey, issue, org, mappings, syncOptions, syncResult);
        await trackWebhookSync('update', syncResult.success, syncResult.errors.join('; '), org.id, issueKey, {
          remoteKey: existingRemoteKey,
          projectKey,
          issueType: issue.fields.issuetype.name,
          fieldsUpdated: Object.keys(syncResult.fieldsUpdated || {}),
          warnings: syncResult.warnings
        });
        await logAuditEntry({
          action: 'update',
          sourceIssue: issueKey,
          targetIssue: existingRemoteKey,
          orgId: org.id,
          orgName: org.name,
          success: syncResult.success,
          errors: syncResult.errors
        });
      } else {
        console.log(`${LOG_EMOJI.CREATE} CREATE for ${org.name}: ${issueKey}`);
        remoteKey = await createRemoteIssueForOrg(issue, org, mappings, syncOptions, syncResult);
        await trackWebhookSync('create', syncResult.success && remoteKey, syncResult.errors.join('; '), org.id, issueKey, {
          remoteKey: remoteKey || 'failed',
          projectKey,
          issueType: issue.fields.issuetype.name,
          fieldsCreated: Object.keys(syncResult.fieldsUpdated || {}),
          warnings: syncResult.warnings
        });
        await logAuditEntry({
          action: 'create',
          sourceIssue: issueKey,
          targetIssue: remoteKey,
          orgId: org.id,
          orgName: org.name,
          success: syncResult.success && remoteKey,
          errors: syncResult.errors
        });
      }

      // Log comprehensive summary for this org
      syncResult.logSummary(issueKey, remoteKey, org.name);
    } catch (error) {
      console.error(`${LOG_EMOJI.ERROR} Error syncing to ${org.name}:`, error);
      await trackWebhookSync(existingRemoteKey ? 'update' : 'create', false, error.message, org.id, issueKey, {
        remoteKey: existingRemoteKey || 'none',
        projectKey,
        issueType: issue.fields.issuetype?.name || 'unknown',
        errorStack: error.stack,
        errorDetails: error.toString()
      });
      await logAuditEntry({
        action: existingRemoteKey ? 'update' : 'create',
        sourceIssue: issueKey,
        targetIssue: existingRemoteKey || null,
        orgId: org.id,
        orgName: org.name,
        success: false,
        errors: [error.message]
      });
    }
  }

  console.log(`\n✅ Completed sync for ${issueKey} across ${organizations.length} organization(s)`);
}

// Legacy exports for backward compatibility with scheduled sync and manual sync
// These work with single-org (legacy) or first organization
export async function createRemoteIssue(issue, config, mappings, syncResult = null, syncOptions = null) {
  // Determine orgId - if config has an id, use it, otherwise null for legacy
  const orgId = config.id && config.id !== 'legacy' ? config.id : null;
  return await createRemoteIssueForOrg(issue, config, mappings, syncOptions, syncResult, orgId);
}

export async function updateRemoteIssue(localKey, remoteKey, issue, config, mappings, syncResult = null, syncOptions = null) {
  // Determine orgId - if config has an id, use it, otherwise null for legacy
  const orgId = config.id && config.id !== 'legacy' ? config.id : null;
  return await updateRemoteIssueForOrg(localKey, remoteKey, issue, config, mappings, syncOptions, syncResult, orgId);
}

// Internal multi-org functions
async function createRemoteIssueForOrg(issue, org, mappings, syncOptions, syncResult = null, orgIdOverride = null) {
  const orgId = orgIdOverride !== null ? orgIdOverride : (org.id === 'legacy' ? null : org.id);
  const auth = Buffer.from(`${org.remoteEmail}:${org.remoteApiToken}`).toString('base64');
  
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
      project: { key: org.remoteProjectKey },
      summary: issue.fields.summary,
      description: initialDescription,
      issuetype: { name: issue.fields.issuetype.name }
    }
  };
  
  // ...existing field mapping code...
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
    let remoteParentKey = await getRemoteKey(issue.fields.parent.key, orgId);
    
    // If parent isn't synced yet, sync it first
    if (!remoteParentKey) {
      console.log(`🔗 Parent ${issue.fields.parent.key} not synced yet, syncing parent first...`);
      const parentIssue = await getFullIssue(issue.fields.parent.key);
      if (parentIssue) {
        // Recursively create the parent (without syncOptions to avoid infinite loops with attachments)
        remoteParentKey = await createRemoteIssueForOrg(parentIssue, org, mappings, null, syncResult, orgId);
        if (remoteParentKey) {
          console.log(`🔗 Parent synced: ${issue.fields.parent.key} → ${remoteParentKey}`);
        }
      }
    }
    
    if (remoteParentKey) {
      remoteIssue.fields.parent = { key: remoteParentKey };
      console.log(`🔗 Mapped parent: ${issue.fields.parent.key} → ${remoteParentKey}`);
    } else {
      console.log(`⚠️ Could not sync parent ${issue.fields.parent.key}, creating child without parent link`);
    }
  }

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

  const syncFieldOptions = syncOptions || { syncSprints: false };
  const reversedFieldMap = reverseMapping(mappings.fieldMappings);
  for (const [localFieldId, remoteFieldId] of Object.entries(reversedFieldMap)) {
    if (issue.fields[localFieldId] !== undefined && issue.fields[localFieldId] !== null) {
      let fieldValue = issue.fields[localFieldId];

      console.log(`📝 Processing field ${localFieldId} → ${remoteFieldId}, value type: ${typeof fieldValue}, isArray: ${Array.isArray(fieldValue)}`);

      const sprintIds = extractSprintIds(fieldValue);
      if (sprintIds !== null) {
        if (!syncFieldOptions.syncSprints) {
          console.log(`⏭️ Skipping sprint field ${localFieldId} - sprint sync disabled`);
          continue;
        }
        fieldValue = sprintIds;
        console.log(`🏃 Extracted sprint IDs for ${localFieldId} → ${remoteFieldId}: ${JSON.stringify(fieldValue)}`);
      } else if (Array.isArray(fieldValue) && fieldValue.length > 0 && typeof fieldValue[0] === 'object') {
        console.warn(`⚠️ Skipping ${localFieldId} - looks like sprint data but couldn't extract IDs. Original value:`, JSON.stringify(fieldValue[0]));
        continue;
      }

      if (Array.isArray(fieldValue) && fieldValue.length === 0) {
        console.log(`⚠️ Skipping empty array for ${localFieldId}`);
        continue;
      }

      remoteIssue.fields[remoteFieldId] = fieldValue;
    }
  }

  try {
    console.log('Creating remote issue for:', issue.key);

    await markSyncing(issue.key);

    const response = await retryWithBackoff(async () => {
      return await fetch(`${org.remoteUrl}/rest/api/3/issue`, {
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

      await storeMapping(issue.key, result.key, orgId);

      if (issue.fields.status && issue.fields.status.name !== 'To Do') {
        await transitionRemoteIssue(result.key, issue.fields.status.name, org, mappings.statusMappings, syncResult);
      }

      const attachmentEnabled = syncOptions?.syncAttachments !== false;
      const linksEnabled = syncOptions?.syncLinks !== false;
      const commentsEnabled = syncOptions?.syncComments !== false;

      let attachmentMapping = {};
      if (attachmentEnabled) {
        attachmentMapping = await syncAttachments(issue.key, result.key, issue, org, syncResult, orgId);
      } else {
        console.log(`⏭️ Skipping attachments sync (disabled in sync options)`);
      }

      if (linksEnabled) {
        await syncIssueLinks(issue.key, result.key, issue, org, syncResult, orgId);
      } else {
        console.log(`⏭️ Skipping links sync (disabled in sync options)`);
      }

      if (commentsEnabled) {
        await syncAllComments(issue.key, result.key, issue, org, syncResult, orgId);
      } else {
        console.log(`⏭️ Skipping comments sync (disabled in sync options)`);
      }

      if (issue.fields.description &&
          typeof issue.fields.description === 'object' &&
          Object.keys(attachmentMapping).length > 0) {

        const correctedDescription = await replaceMediaIdsInADF(issue.fields.description, attachmentMapping);

        console.log(`🖼️ Updating description with corrected media references...`);
        const updateResponse = await retryWithBackoff(async () => {
          return await fetch(`${org.remoteUrl}/rest/api/3/issue/${result.key}`, {
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

async function updateRemoteIssueForOrg(localKey, remoteKey, issue, org, mappings, syncOptions, syncResult = null, orgIdOverride = null) {
  const orgId = orgIdOverride !== null ? orgIdOverride : (org.id === 'legacy' ? null : org.id);
  const auth = Buffer.from(`${org.remoteEmail}:${org.remoteApiToken}`).toString('base64');

  await markSyncing(localKey);

  const attachmentEnabled = syncOptions?.syncAttachments !== false;
  const linksEnabled = syncOptions?.syncLinks !== false;
  const commentsEnabled = syncOptions?.syncComments !== false;

  let attachmentMapping = {};
  if (attachmentEnabled) {
    attachmentMapping = await syncAttachments(localKey, remoteKey, issue, org, syncResult, orgId);
  } else {
    console.log(`⏭️ Skipping attachments sync (disabled in sync options)`);
  }

  if (linksEnabled) {
    await syncIssueLinks(localKey, remoteKey, issue, org, syncResult, orgId);
  } else {
    console.log(`⏭️ Skipping links sync (disabled in sync options)`);
  }

  if (commentsEnabled) {
    await syncAllComments(localKey, remoteKey, issue, org, syncResult, orgId);
  } else {
    console.log(`⏭️ Skipping comments sync (disabled in sync options)`);
  }

  let description;
  if (issue.fields.description) {
    if (typeof issue.fields.description === 'object') {
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
  
  // ...existing update field mapping code...
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

  if (issue.fields.parent && issue.fields.parent.key) {
    const remoteParentKey = await getRemoteKey(issue.fields.parent.key, orgId);
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

  const reversedFieldMap = reverseMapping(mappings.fieldMappings);
  const syncFieldOptions = syncOptions || { syncSprints: false };

  for (const [localFieldId, remoteFieldId] of Object.entries(reversedFieldMap)) {
    if (issue.fields[localFieldId] !== undefined && issue.fields[localFieldId] !== null) {
      let fieldValue = issue.fields[localFieldId];

      console.log(`📝 Processing field ${localFieldId} → ${remoteFieldId}, value type: ${typeof fieldValue}, isArray: ${Array.isArray(fieldValue)}`);

      const sprintIds = extractSprintIds(fieldValue);
      if (sprintIds !== null) {
        if (!syncFieldOptions.syncSprints) {
          console.log(`⏭️ Skipping sprint field ${localFieldId} - sprint sync disabled`);
          continue;
        }
        fieldValue = sprintIds;
        console.log(`🏃 Extracted sprint IDs for ${localFieldId} → ${remoteFieldId}: ${JSON.stringify(fieldValue)}`);
      } else if (Array.isArray(fieldValue) && fieldValue.length > 0 && typeof fieldValue[0] === 'object') {
        console.warn(`⚠️ Skipping ${localFieldId} - looks like sprint data but couldn't extract IDs. Original value:`, JSON.stringify(fieldValue[0]));
        continue;
      }

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
      return await fetch(`${org.remoteUrl}/rest/api/3/issue/${remoteKey}`, {
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
        await transitionRemoteIssue(remoteKey, issue.fields.status.name, org, mappings.statusMappings, syncResult);
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

export async function createIssueForOrg(issue, org, mappings, syncOptions = null, syncResult = null) {
  return await createRemoteIssueForOrg(issue, org, mappings, syncOptions, syncResult);
}

export async function updateIssueForOrg(localKey, remoteKey, issue, org, mappings, syncOptions = null, syncResult = null) {
  return await updateRemoteIssueForOrg(localKey, remoteKey, issue, org, mappings, syncOptions, syncResult);
}
