import api, { route, fetch } from '@forge/api';
import * as kvsStore from '../storage/kvs.js';
import { LOG_EMOJI, HTTP_STATUS, MAX_PARENT_SYNC_DEPTH } from '../../constants.js';
import { retryWithBackoff } from '../../utils/retry.js';
import { extractTextFromADF, textToADF, replaceMediaIdsInADF, extractSprintIds, prependCrossReferenceToADF } from '../../utils/adf.js';
import { mapUserToRemote, reverseMapping } from '../../utils/mapping.js';
import { getRemoteKey, getLocalKey, storeMapping, getOrganizationsWithTokens } from '../storage/mappings.js';
import { markSyncing, clearSyncFlag, isSyncing, findPendingLinksToIssue, removePendingLink } from '../storage/flags.js';
import { trackWebhookSync, logAuditEntry } from '../storage/stats.js';
import { getFullIssue, getOrgName, updateLocalIssueDescription } from '../jira/local-client.js';
import { syncAttachments } from './attachment-sync.js';
import { syncIssueLinks, createLinkOnRemote } from './link-sync.js';
import { syncAllComments } from './comment-sync.js';
import { transitionRemoteIssue } from './transition-sync.js';
import { SyncResult } from './sync-result.js';
import { isProjectAllowedToSync } from '../../utils/validation.js';

// Cache for Epic Link field IDs
let epicLinkFieldCache = {
  local: { id: null, expiresAt: 0 },
  remote: {} // keyed by org id: { id: string, expiresAt: number }
};

const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour

function isRankLikeString(value) {
  return typeof value === 'string' && /^\d+\|[A-Za-z0-9]+:/.test(value);
}

/**
 * Find the Epic Link custom field ID for the local Jira instance
 */
async function getLocalEpicLinkFieldId() {
  const now = Date.now();
  if (epicLinkFieldCache.local.id && epicLinkFieldCache.local.expiresAt > now) {
    return epicLinkFieldCache.local.id;
  }
  
  try {
    const response = await api.asApp().requestJira(route`/rest/api/3/field`);
    if (response.ok) {
      const fields = await response.json();
      const epicLinkField = fields.find(f => 
        f.name === 'Epic Link' || 
        f.key === 'com.pyxis.greenhopper.jira:gh-epic-link' ||
        (f.schema && f.schema.custom === 'com.pyxis.greenhopper.jira:gh-epic-link')
      );
      if (epicLinkField) {
        epicLinkFieldCache.local = { id: epicLinkField.id, expiresAt: now + CACHE_TTL_MS };
        console.log(`🎯 Found local Epic Link field: ${epicLinkField.id}`);
        return epicLinkField.id;
      }
    }
  } catch (e) {
    console.log(`⚠️ Could not find local Epic Link field: ${e.message}`);
  }
  return null;
}

/**
 * Find the Epic Link custom field ID for a remote Jira instance
 */
async function getRemoteEpicLinkFieldId(org) {
  const now = Date.now();
  if (epicLinkFieldCache.remote[org.id] && epicLinkFieldCache.remote[org.id].expiresAt > now) {
    return epicLinkFieldCache.remote[org.id].id;
  }
  
  const auth = Buffer.from(`${org.remoteEmail}:${org.remoteApiToken}`).toString('base64');
  
  try {
    const response = await fetch(`${org.remoteUrl}/rest/api/3/field`, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.ok) {
      const fields = await response.json();
      const epicLinkField = fields.find(f => 
        f.name === 'Epic Link' || 
        f.key === 'com.pyxis.greenhopper.jira:gh-epic-link' ||
        (f.schema && f.schema.custom === 'com.pyxis.greenhopper.jira:gh-epic-link')
      );
      if (epicLinkField) {
        epicLinkFieldCache.remote[org.id] = { id: epicLinkField.id, expiresAt: now + CACHE_TTL_MS };
        console.log(`🎯 Found remote Epic Link field for ${org.name}: ${epicLinkField.id}`);
        return epicLinkField.id;
      }
    }
  } catch (e) {
    console.log(`⚠️ Could not find remote Epic Link field for ${org.name}: ${e.message}`);
  }
  return null;
}

/**
 * Check if an issue matches the organization's JQL filter
 * @param {string} issueKey - The issue key to check
 * @param {string} jqlFilter - The JQL filter to match against
 * @returns {Promise<boolean>} - True if issue matches filter (or no filter set)
 */
async function matchesJqlFilter(issueKey, jqlFilter) {
  // No filter means all issues match
  if (!jqlFilter || jqlFilter.trim() === '') {
    return true;
  }
  
  try {
    // Search for the specific issue with the JQL filter appended
    const combinedJql = `key = ${issueKey} AND (${jqlFilter})`;
    const response = await api.asApp().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jql: combinedJql,
        maxResults: 1,
        fields: ['key']
      })
    });
    
    if (!response.ok) {
      // If JQL is invalid, log warning but allow sync (fail-open)
      console.log(`${LOG_EMOJI.WARNING} JQL filter check failed (status ${response.status}), allowing sync`);
      return true;
    }
    
    const result = await response.json();
    const matches = result.total > 0;
    
    if (!matches) {
      console.log(`${LOG_EMOJI.INFO} Issue ${issueKey} does not match JQL filter: ${jqlFilter}`);
    }
    
    return matches;
  } catch (error) {
    // On error, allow sync to proceed (fail-open)
    console.log(`${LOG_EMOJI.WARNING} JQL filter check error: ${error.message}, allowing sync`);
    return true;
  }
}

/**
 * Sync Epic Link from local to remote issue
 * Returns the remote epic key if successful, null otherwise
 */
/**
 * Sync Epic Link from local to remote issue
 * Returns the remote epic key if successful, null otherwise
 * @param {number} depth - Current recursion depth (default 0)
 */
async function syncEpicLink(issue, org, mappings, syncResult, orgId, depth = 0) {
  const localEpicFieldId = await getLocalEpicLinkFieldId();
  if (!localEpicFieldId) {
    return null;
  }
  
  const localEpicKey = issue.fields[localEpicFieldId];
  if (!localEpicKey) {
    return null; // No epic link on source issue
  }
  
  console.log(`🎯 Issue has Epic Link: ${localEpicKey}`);
  
  // Find the remote epic link field
  const remoteEpicFieldId = await getRemoteEpicLinkFieldId(org);
  if (!remoteEpicFieldId) {
    console.log(`${LOG_EMOJI.WARNING} Remote org ${org.name} doesn't have Epic Link field (might be next-gen project)`);
    return null;
  }
  
  // Check if the epic is synced to remote
  let remoteEpicKey = await getRemoteKey(localEpicKey, orgId);
  
  if (!remoteEpicKey && depth < MAX_PARENT_SYNC_DEPTH) {
    // Epic not synced yet - sync it first
    console.log(`🎯 Epic ${localEpicKey} not synced yet, syncing epic first (depth: ${depth + 1})...`);
    const epicIssue = await getFullIssue(localEpicKey);
    if (epicIssue) {
      remoteEpicKey = await createRemoteIssueForOrg(epicIssue, org, mappings, null, syncResult, orgId, depth + 1);
      if (remoteEpicKey) {
        console.log(`🎯 Epic synced: ${localEpicKey} → ${remoteEpicKey}`);
      }
    }
  } else if (!remoteEpicKey) {
    console.log(`${LOG_EMOJI.WARNING} Max depth reached, skipping epic ${localEpicKey} sync`);
  }
  
  if (remoteEpicKey) {
    return { fieldId: remoteEpicFieldId, epicKey: remoteEpicKey };
  }
  
  console.log(`${LOG_EMOJI.WARNING} Could not sync Epic Link - epic ${localEpicKey} not available`);
  return null;
}

/**
 * Process pending links that were waiting for this issue to be synced
 * Called after an issue is successfully created on remote
 */
async function processPendingLinksForNewlySyncedIssue(localIssueKey, remoteIssueKey, org, orgId) {
  try {
    // Find any pending links that were waiting for this issue
    const pendingLinks = await findPendingLinksToIssue(localIssueKey);
    
    if (pendingLinks.length === 0) {
      return;
    }
    
    console.log(`🔗 Found ${pendingLinks.length} pending link(s) waiting for ${localIssueKey}`);
    
    for (const pending of pendingLinks) {
      // Only process links for this org
      if (pending.orgId !== orgId && !(pending.orgId === null && orgId === null)) {
        continue;
      }
      
      try {
        // Get the remote key for the source issue (the one that has the pending link)
        const sourceRemoteKey = await getRemoteKey(pending.sourceIssueKey, orgId);
        
        if (!sourceRemoteKey) {
          console.log(`⚠️ Source issue ${pending.sourceIssueKey} not synced yet, keeping link pending`);
          continue;
        }
        
        // Create the link on remote
        const result = await createLinkOnRemote(
          org,
          sourceRemoteKey,
          remoteIssueKey,
          pending.linkTypeName,
          pending.direction
        );
        
        if (result.success) {
          console.log(`${LOG_EMOJI.SUCCESS} Created pending link: ${pending.sourceIssueKey} → ${localIssueKey}`);
          // Remove from pending
          await removePendingLink(pending.sourceIssueKey, pending.linkId);
        } else {
          console.log(`${LOG_EMOJI.WARNING} Failed to create pending link: ${result.error}`);
        }
      } catch (error) {
        console.error(`${LOG_EMOJI.ERROR} Error processing pending link:`, error);
      }
    }
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error processing pending links for ${localIssueKey}:`, error);
  }
}

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

  // Get all organizations with their API tokens from secure storage
  let organizations = await getOrganizationsWithTokens();
  
  // Legacy support: check for old single-org config
  const legacyConfig = await kvsStore.get('syncConfig');
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

    // Check if issue matches JQL filter (if configured)
    if (org.jqlFilter) {
      const matchesFilter = await matchesJqlFilter(issueKey, org.jqlFilter);
      if (!matchesFilter) {
        console.log(`⏭️ Skipping ${issueKey} for ${org.name} - does not match JQL filter`);
        continue;
      }
    }

    // Fetch org-specific mappings
    const [userMappings, fieldMappings, statusMappings, issueTypeMappings, syncOptions] = await Promise.all([
      kvsStore.get(org.id === 'legacy' ? 'userMappings' : `userMappings:${org.id}`),
      kvsStore.get(org.id === 'legacy' ? 'fieldMappings' : `fieldMappings:${org.id}`),
      kvsStore.get(org.id === 'legacy' ? 'statusMappings' : `statusMappings:${org.id}`),
      kvsStore.get(org.id === 'legacy' ? 'issueTypeMappings' : `issueTypeMappings:${org.id}`),
      kvsStore.get(org.id === 'legacy' ? 'syncOptions' : `syncOptions:${org.id}`)
    ]);

    const mappings = {
      userMappings: userMappings || {},
      fieldMappings: fieldMappings || {},
      statusMappings: statusMappings || {},
      issueTypeMappings: issueTypeMappings || {}
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
async function createRemoteIssueForOrg(issue, org, mappings, syncOptions, syncResult = null, orgIdOverride = null, depth = 0) {
  const orgId = orgIdOverride !== null ? orgIdOverride : (org.id === 'legacy' ? null : org.id);
  const auth = Buffer.from(`${org.remoteEmail}:${org.remoteApiToken}`).toString('base64');
  
  // Check depth limit for recursive parent/epic sync
  if (depth > MAX_PARENT_SYNC_DEPTH) {
    console.log(`${LOG_EMOJI.WARNING} Max sync depth (${MAX_PARENT_SYNC_DEPTH}) reached for ${issue.key}, skipping parent/epic sync`);
  }
  
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

  // Map issue type if mapping exists
  const localIssueTypeName = issue.fields.issuetype.name;
  let remoteIssueTypeName = localIssueTypeName;
  
  // Check if there's a mapping for this issue type (mappings are keyed by local ID, value contains remote info)
  if (mappings.issueTypeMappings) {
    for (const [remoteId, mapping] of Object.entries(mappings.issueTypeMappings)) {
      if (mapping.localName === localIssueTypeName || mapping.localId === issue.fields.issuetype.id) {
        remoteIssueTypeName = mapping.remoteName;
        console.log(`🔄 Mapped issue type: ${localIssueTypeName} → ${remoteIssueTypeName}`);
        break;
      }
    }
  }
  
  const remoteIssue = {
    fields: {
      project: { key: org.remoteProjectKey },
      summary: issue.fields.summary,
      description: initialDescription,
      issuetype: { name: remoteIssueTypeName }
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
    
    // If parent isn't synced yet, sync it first (respecting depth limit)
    if (!remoteParentKey && depth < MAX_PARENT_SYNC_DEPTH) {
      console.log(`${LOG_EMOJI.LINK} Parent ${issue.fields.parent.key} not synced yet, syncing parent first (depth: ${depth + 1})...`);
      const parentIssue = await getFullIssue(issue.fields.parent.key);
      if (parentIssue) {
        // Recursively create the parent (without syncOptions to avoid infinite loops with attachments)
        remoteParentKey = await createRemoteIssueForOrg(parentIssue, org, mappings, null, syncResult, orgId, depth + 1);
        if (remoteParentKey) {
          console.log(`${LOG_EMOJI.LINK} Parent synced: ${issue.fields.parent.key} → ${remoteParentKey}`);
        }
      }
    } else if (!remoteParentKey) {
      console.log(`${LOG_EMOJI.WARNING} Max depth reached, skipping parent ${issue.fields.parent.key} sync`);
    }
    
    if (remoteParentKey) {
      remoteIssue.fields.parent = { key: remoteParentKey };
      console.log(`🔗 Mapped parent: ${issue.fields.parent.key} → ${remoteParentKey}`);
    } else {
      console.log(`⚠️ Could not sync parent ${issue.fields.parent.key}, creating child without parent link`);
    }
  }

  // Sync Epic Link for classic projects (next-gen uses parent field above)
  const epicLinkResult = await syncEpicLink(issue, org, mappings, syncResult, orgId, depth);
  if (epicLinkResult) {
    remoteIssue.fields[epicLinkResult.fieldId] = epicLinkResult.epicKey;
    console.log(`🎯 Mapped Epic Link: → ${epicLinkResult.epicKey}`);
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
  console.log(`🗺️ Field mappings to process:`, JSON.stringify(Object.keys(reversedFieldMap)));
  
  // Fields that should never be synced (Jira internal fields)
  const blockedFields = [
    'rankBeforeIssue', 'rankAfterIssue', 'rank', 'lexoRank',
    'created', 'updated', 'creator', 'reporter', 'project',
    'issuetype', 'status', 'resolution', 'resolutiondate',
    'watches', 'votes', 'worklog', 'aggregatetimespent',
    'aggregatetimeoriginalestimate', 'aggregatetimeestimate',
    'aggregateprogress', 'progress', 'lastViewed', 'issuelinks',
    'subtasks', 'attachment', 'comment'
  ];

  for (const [localFieldId, remoteFieldId] of Object.entries(reversedFieldMap)) {
    // Skip blocked fields by name
    if (blockedFields.includes(localFieldId) || blockedFields.includes(remoteFieldId)) {
      console.log(`⏭️ Skipping blocked field: ${localFieldId} → ${remoteFieldId}`);
      continue;
    }

    if (issue.fields[localFieldId] !== undefined && issue.fields[localFieldId] !== null) {
      let fieldValue = issue.fields[localFieldId];
      
      // Log the actual field value for debugging
      console.log(`🔍 Field ${localFieldId} raw value:`, JSON.stringify(fieldValue).substring(0, 200));
      
      // Skip rank/lexorank fields (string values like "0|i00067:")
      if (isRankLikeString(fieldValue)) {
        console.log(`⏭️ Skipping lexorank field ${localFieldId} - value looks like rank data`);
        continue;
      }
      
      // Skip rank fields that might be stored with customfield IDs
      // These fields have object values with rankBeforeIssue/rankAfterIssue properties
      if (typeof fieldValue === 'object' && fieldValue !== null && !Array.isArray(fieldValue)) {
        if (fieldValue.rankBeforeIssue !== undefined || fieldValue.rankAfterIssue !== undefined) {
          console.log(`⏭️ Skipping rank field ${localFieldId} - contains rank data`);
          continue;
        }
      }

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
    console.log('📦 Payload fields:', JSON.stringify(Object.keys(remoteIssue.fields)));

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

      // Process any pending links that were waiting for this issue to be synced
      await processPendingLinksForNewlySyncedIssue(issue.key, result.key, org, orgId);

      if (issue.fields.status && issue.fields.status.name !== 'To Do') {
        await transitionRemoteIssue(result.key, issue.fields.status.name, org, mappings.statusMappings, syncResult);
      }

      const attachmentEnabled = syncOptions?.syncAttachments !== false;
      const linksEnabled = syncOptions?.syncLinks !== false;
      const commentsEnabled = syncOptions?.syncComments !== false;

      // Track sync details for event logging
      const syncDetails = {
        fields: true,
        attachments: 0,
        links: 0,
        comments: 0,
        status: issue.fields.status && issue.fields.status.name !== 'To Do'
      };

      let attachmentMapping = {};
      if (attachmentEnabled) {
        attachmentMapping = await syncAttachments(issue.key, result.key, issue, org, syncResult, orgId);
        syncDetails.attachments = Object.keys(attachmentMapping).length;
      } else {
        console.log(`⏭️ Skipping attachments sync (disabled in sync options)`);
      }

      if (linksEnabled) {
        const linkResult = await syncIssueLinks(issue.key, result.key, issue, org, syncResult, orgId);
        syncDetails.links = linkResult?.synced || 0;
      } else {
        console.log(`⏭️ Skipping links sync (disabled in sync options)`);
      }

      if (commentsEnabled) {
        const commentResult = await syncAllComments(issue.key, result.key, issue, org, syncResult, orgId);
        syncDetails.comments = commentResult?.synced || 0;
      } else {
        console.log(`⏭️ Skipping comments sync (disabled in sync options)`);
      }

      // Check if cross-reference is enabled (default true for backward compatibility)
      const crossReferenceEnabled = syncOptions?.syncCrossReference !== false;

      if (crossReferenceEnabled) {
        // Add cross-reference to both issues' descriptions
        const localOrgName = await getOrgName();
        const remoteOrgName = org.name;

        // Update REMOTE issue description with cross-reference
        // Use the original ADF structure, replacing media IDs if needed
        let remoteDescription;
        if (issue.fields.description && typeof issue.fields.description === 'object') {
          remoteDescription = Object.keys(attachmentMapping).length > 0
            ? await replaceMediaIdsInADF(issue.fields.description, attachmentMapping)
            : JSON.parse(JSON.stringify(issue.fields.description)); // Deep clone
        } else if (issue.fields.description && typeof issue.fields.description === 'string') {
          remoteDescription = textToADF(issue.fields.description);
        } else {
          remoteDescription = { type: 'doc', version: 1, content: [] };
        }

        // Prepend cross-reference to remote description
        const remoteDescriptionWithRef = prependCrossReferenceToADF(
          remoteDescription,
          issue.key,
          result.key,
          localOrgName,
          remoteOrgName
        );

        console.log(`🔗 Updating remote issue ${result.key} with cross-reference...`);
        const updateResponse = await retryWithBackoff(async () => {
          return await fetch(`${org.remoteUrl}/rest/api/3/issue/${result.key}`, {
            method: 'PUT',
            headers: {
              'Authorization': `Basic ${auth}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              fields: {
                description: remoteDescriptionWithRef
              }
            })
          });
        }, `Update description for ${result.key}`);

        if (updateResponse.ok || updateResponse.status === HTTP_STATUS.NO_CONTENT) {
          console.log(`${LOG_EMOJI.SUCCESS} Updated remote issue with cross-reference`);
        } else {
          const warningMsg = 'Could not update remote description with cross-reference';
          console.log(`${LOG_EMOJI.WARNING} ${warningMsg}`);
          if (syncResult) syncResult.addWarning(warningMsg);
        }

        // Update LOCAL issue description with cross-reference back to remote
        const localDescription = issue.fields.description && typeof issue.fields.description === 'object'
          ? JSON.parse(JSON.stringify(issue.fields.description)) // Deep clone
          : { type: 'doc', version: 1, content: [] };
        
        const localDescriptionWithRef = prependCrossReferenceToADF(
          localDescription,
          issue.key,
          result.key,
          localOrgName,
          remoteOrgName
        );

        const localUpdateSuccess = await updateLocalIssueDescription(issue.key, localDescriptionWithRef);
        if (localUpdateSuccess) {
          console.log(`${LOG_EMOJI.SUCCESS} Updated local issue ${issue.key} with cross-reference`);
        } else {
          const warningMsg = 'Could not update local description with cross-reference';
          console.log(`${LOG_EMOJI.WARNING} ${warningMsg}`);
          if (syncResult) syncResult.addWarning(warningMsg);
        }
      } else {
        // Still need to update description with media IDs if there are attachments
        if (issue.fields.description &&
            typeof issue.fields.description === 'object' &&
            Object.keys(attachmentMapping).length > 0) {
          const correctedDescription = await replaceMediaIdsInADF(issue.fields.description, attachmentMapping);
          console.log(`🖼️ Updating description with corrected media references...`);
          await retryWithBackoff(async () => {
            return await fetch(`${org.remoteUrl}/rest/api/3/issue/${result.key}`, {
              method: 'PUT',
              headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                fields: { description: correctedDescription }
              })
            });
          }, `Update description for ${result.key}`);
        }
        console.log(`⏭️ Skipping cross-reference sync (disabled in sync options)`);
      }

      await clearSyncFlag(issue.key);
      return { key: result.key, details: syncDetails };
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

  // Track sync details for event logging
  const syncDetails = {
    fields: true,
    attachments: 0,
    attachmentsTotal: 0,
    links: 0,
    linksTotal: 0,
    comments: 0,
    commentsTotal: 0,
    status: false
  };

  // Count totals from the issue for context
  syncDetails.attachmentsTotal = issue.fields.attachment?.length || 0;
  syncDetails.linksTotal = issue.fields.issuelinks?.length || 0;

  const attachmentEnabled = syncOptions?.syncAttachments !== false;
  const linksEnabled = syncOptions?.syncLinks !== false;
  const commentsEnabled = syncOptions?.syncComments !== false;

  let attachmentMapping = {};
  if (attachmentEnabled) {
    attachmentMapping = await syncAttachments(localKey, remoteKey, issue, org, syncResult, orgId);
    // Count newly synced attachments (those in the mapping)
    syncDetails.attachments = Object.keys(attachmentMapping).length;
  } else {
    console.log(`⏭️ Skipping attachments sync (disabled in sync options)`);
  }

  if (linksEnabled) {
    const forceCheckLinks = syncOptions?.forceCheckLinks || false;
    const linkResult = await syncIssueLinks(localKey, remoteKey, issue, org, syncResult, orgId, forceCheckLinks);
    syncDetails.links = linkResult?.synced || 0;
  } else {
    console.log(`⏭️ Skipping links sync (disabled in sync options)`);
  }

  if (commentsEnabled) {
    const commentResult = await syncAllComments(localKey, remoteKey, issue, org, syncResult, orgId);
    syncDetails.comments = commentResult?.synced || 0;
    syncDetails.commentsTotal = commentResult?.synced + commentResult?.skipped || 0;
  } else {
    console.log(`⏭️ Skipping comments sync (disabled in sync options)`);
  }

  // Check if cross-reference is enabled (default true for backward compatibility)
  const crossReferenceEnabled = syncOptions?.syncCrossReference !== false;

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

  // Add cross-reference to description if enabled
  let finalDescription = description;
  let localOrgName, remoteOrgName;
  if (crossReferenceEnabled) {
    localOrgName = await getOrgName();
    remoteOrgName = org.name;
    finalDescription = prependCrossReferenceToADF(
      description,
      localKey,
      remoteKey,
      localOrgName,
      remoteOrgName
    );
  } else {
    console.log(`⏭️ Skipping cross-reference sync (disabled in sync options)`);
  }
  
  // Map issue type if mapping exists
  const localIssueTypeName = issue.fields.issuetype.name;
  let remoteIssueTypeName = localIssueTypeName;
  
  if (mappings.issueTypeMappings) {
    for (const [remoteId, mapping] of Object.entries(mappings.issueTypeMappings)) {
      if (mapping.localName === localIssueTypeName || mapping.localId === issue.fields.issuetype.id) {
        remoteIssueTypeName = mapping.remoteName;
        console.log(`🔄 Mapped issue type: ${localIssueTypeName} → ${remoteIssueTypeName}`);
        break;
      }
    }
  }

  const updateData = {
    fields: {
      summary: issue.fields.summary,
      description: finalDescription,
      issuetype: { name: remoteIssueTypeName }
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

  // Sync Epic Link for classic projects (next-gen uses parent field above)
  // Note: During update, we don't recursively sync missing epics (depth 0 with check)
  const epicLinkResult = await syncEpicLink(issue, org, mappings, syncResult, orgId, 0);
  if (epicLinkResult) {
    updateData.fields[epicLinkResult.fieldId] = epicLinkResult.epicKey;
    console.log(`🎯 Updated Epic Link: → ${epicLinkResult.epicKey}`);
  } else {
    // Check if epic link was removed - need to clear it
    const localEpicFieldId = await getLocalEpicLinkFieldId();
    if (localEpicFieldId && issue.fields[localEpicFieldId] === null) {
      const remoteEpicFieldId = await getRemoteEpicLinkFieldId(org);
      if (remoteEpicFieldId) {
        updateData.fields[remoteEpicFieldId] = null;
        console.log(`🎯 Clearing Epic Link`);
      }
    }
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
  
  // Fields that should never be synced (Jira internal fields)
  const blockedFields = [
    'rankBeforeIssue', 'rankAfterIssue', 'rank', 'lexoRank',
    'created', 'updated', 'creator', 'reporter', 'project',
    'issuetype', 'status', 'resolution', 'resolutiondate',
    'watches', 'votes', 'worklog', 'aggregatetimespent',
    'aggregatetimeoriginalestimate', 'aggregatetimeestimate',
    'aggregateprogress', 'progress', 'lastViewed', 'issuelinks',
    'subtasks', 'attachment', 'comment'
  ];

  for (const [localFieldId, remoteFieldId] of Object.entries(reversedFieldMap)) {
    // Skip blocked fields
    if (blockedFields.includes(localFieldId) || blockedFields.includes(remoteFieldId)) {
      console.log(`⏭️ Skipping blocked field: ${localFieldId} → ${remoteFieldId}`);
      continue;
    }
    
    if (issue.fields[localFieldId] !== undefined && issue.fields[localFieldId] !== null) {
      let fieldValue = issue.fields[localFieldId];
      
      // Skip rank/lexorank fields (string values like "0|i00067:")
      if (isRankLikeString(fieldValue)) {
        console.log(`⏭️ Skipping lexorank field ${localFieldId} - value looks like rank data`);
        continue;
      }
      
      // Skip rank fields that might be stored with customfield IDs
      // These fields have object values with rankBeforeIssue/rankAfterIssue properties
      if (typeof fieldValue === 'object' && fieldValue !== null && !Array.isArray(fieldValue)) {
        if (fieldValue.rankBeforeIssue !== undefined || fieldValue.rankAfterIssue !== undefined) {
          console.log(`⏭️ Skipping rank field ${localFieldId} - contains rank data`);
          continue;
        }
      }

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

      // Also update local issue with cross-reference (if enabled)
      if (crossReferenceEnabled) {
        const localDescriptionWithRef = prependCrossReferenceToADF(
          issue.fields.description || { type: 'doc', version: 1, content: [] },
          localKey,
          remoteKey,
          localOrgName,
          remoteOrgName
        );
        await updateLocalIssueDescription(localKey, localDescriptionWithRef);
      }

      if (issue.fields.status) {
        const transitioned = await transitionRemoteIssue(remoteKey, issue.fields.status.name, org, mappings.statusMappings, syncResult);
        syncDetails.status = transitioned || false;
      }
      await clearSyncFlag(localKey);
      return syncDetails;
    } else {
      const errorText = await response.text();
      console.error(`${LOG_EMOJI.ERROR} Update failed: ${errorText}`);
      if (syncResult) syncResult.addError(`Update failed: ${errorText}`);
      await clearSyncFlag(localKey);
      return null;
    }
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error updating remote issue:`, error);
    if (syncResult) syncResult.addError(`Error updating remote issue: ${error.message}`);
    await clearSyncFlag(localKey);
    return null;
  }
}

export async function createIssueForOrg(issue, org, mappings, syncOptions = null, syncResult = null) {
  return await createRemoteIssueForOrg(issue, org, mappings, syncOptions, syncResult);
}

export async function updateIssueForOrg(localKey, remoteKey, issue, org, mappings, syncOptions = null, syncResult = null) {
  return await updateRemoteIssueForOrg(localKey, remoteKey, issue, org, mappings, syncOptions, syncResult);
}
