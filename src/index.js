import Resolver from '@forge/resolver';
import api, { route, storage, fetch } from '@forge/api';
import {
  MAX_RETRY_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  RATE_LIMIT_RETRY_DELAY_MS,
  HTTP_STATUS,
  ERROR_MESSAGES,
  LOG_EMOJI,
  MAX_ATTACHMENT_SIZE,
  MAX_ATTACHMENT_SIZE_MB,
  SYNC_FLAG_TTL_SECONDS,
  SCHEDULED_SYNC_DELAY_MS,
  STORAGE_KEYS,
  RECENT_CREATION_WINDOW_MS,
  OPERATION_RESULT
} from './constants.js';

const resolver = new Resolver();

// Class to track sync operation results
class SyncResult {
  constructor(operation) {
    this.operation = operation;
    this.success = true;
    this.warnings = [];
    this.errors = [];
    this.details = {
      attachments: { success: 0, failed: 0, skipped: 0, errors: [] },
      links: { success: 0, failed: 0, skipped: 0, errors: [] },
      transitions: { success: 0, failed: 0, errors: [] },
      comments: { success: 0, failed: 0, errors: [] },
      fields: { updated: [], failed: [] }
    };
  }

  addWarning(message) {
    this.warnings.push(message);
    console.warn(`${LOG_EMOJI.WARNING} ${message}`);
  }

  addError(message) {
    this.errors.push(message);
    this.success = false;
    console.error(`${LOG_EMOJI.ERROR} ${message}`);
  }

  addAttachmentSuccess(filename) {
    this.details.attachments.success++;
  }

  addAttachmentFailure(filename, error) {
    this.details.attachments.failed++;
    this.details.attachments.errors.push(`${filename}: ${error}`);
    this.addWarning(`Attachment failed: ${filename} - ${error}`);
  }

  addAttachmentSkipped(filename, reason) {
    this.details.attachments.skipped++;
  }

  addLinkSuccess(linkedIssue, linkType) {
    this.details.links.success++;
  }

  addLinkFailure(linkedIssue, error) {
    this.details.links.failed++;
    this.details.links.errors.push(`${linkedIssue}: ${error}`);
    this.addWarning(`Link failed: ${linkedIssue} - ${error}`);
  }

  addLinkSkipped(linkedIssue, reason) {
    this.details.links.skipped++;
  }

  addTransitionSuccess(status) {
    this.details.transitions.success++;
  }

  addTransitionFailure(status, error) {
    this.details.transitions.failed++;
    this.details.transitions.errors.push(`${status}: ${error}`);
    this.addWarning(`Transition failed: ${status} - ${error}`);
  }

  logSummary(issueKey, remoteKey) {
    const hasWarnings = this.warnings.length > 0;
    const hasErrors = this.errors.length > 0;

    let status = OPERATION_RESULT.SUCCESS;
    if (hasErrors) status = OPERATION_RESULT.FAILURE;
    else if (hasWarnings) status = OPERATION_RESULT.PARTIAL;

    // Clear separator for visibility
    console.log(`${LOG_EMOJI.SUMMARY} ════════════════════════════════════════════════════`);
    console.log(`${LOG_EMOJI.SUMMARY} SYNC SUMMARY: ${issueKey}${remoteKey ? ' → ' + remoteKey : ''}`);
    console.log(`${LOG_EMOJI.SUMMARY} Status: ${status.toUpperCase()}`);

    // Attachments
    const totalAttachments = this.details.attachments.success + this.details.attachments.failed + this.details.attachments.skipped;
    if (totalAttachments > 0) {
      console.log(`${LOG_EMOJI.SUMMARY} ${LOG_EMOJI.ATTACHMENT} Attachments: ${this.details.attachments.success}/${totalAttachments} synced, ${this.details.attachments.failed} failed, ${this.details.attachments.skipped} skipped`);
    }

    // Links
    const totalLinks = this.details.links.success + this.details.links.failed + this.details.links.skipped;
    if (totalLinks > 0) {
      console.log(`${LOG_EMOJI.SUMMARY} ${LOG_EMOJI.LINK} Links: ${this.details.links.success}/${totalLinks} synced, ${this.details.links.failed} failed, ${this.details.links.skipped} skipped`);
    }

    // Transitions
    const totalTransitions = this.details.transitions.success + this.details.transitions.failed;
    if (totalTransitions > 0) {
      console.log(`${LOG_EMOJI.SUMMARY} ${LOG_EMOJI.STATUS} Transitions: ${this.details.transitions.success}/${totalTransitions} successful`);
    }

    // Comments
    const totalComments = this.details.comments.success + this.details.comments.failed;
    if (totalComments > 0) {
      console.log(`${LOG_EMOJI.SUMMARY} ${LOG_EMOJI.COMMENT} Comments: ${this.details.comments.success}/${totalComments} synced`);
    }

    // Warnings
    if (this.warnings.length > 0) {
      console.log(`${LOG_EMOJI.SUMMARY} ${LOG_EMOJI.WARNING} Warnings: ${this.warnings.length}`);
      this.warnings.forEach(w => console.log(`${LOG_EMOJI.SUMMARY}    - ${w}`));
    }

    // Errors
    if (this.errors.length > 0) {
      console.log(`${LOG_EMOJI.SUMMARY} ${LOG_EMOJI.ERROR} Errors: ${this.errors.length}`);
      this.errors.forEach(e => console.log(`${LOG_EMOJI.SUMMARY}    - ${e}`));
    }

    console.log(`${LOG_EMOJI.SUMMARY} ════════════════════════════════════════════════════`);

    return status;
  }
}

// Utility: Retry with exponential backoff
async function retryWithBackoff(fn, operation = 'operation', maxRetries = MAX_RETRY_ATTEMPTS) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await fn();

      // Check for rate limiting (HTTP 429)
      if (result && result.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
        console.warn(`${LOG_EMOJI.WARNING} Rate limit hit during ${operation}, waiting ${RATE_LIMIT_RETRY_DELAY_MS}ms...`);
        await sleep(RATE_LIMIT_RETRY_DELAY_MS);
        continue; // Don't count this as a regular retry attempt
      }

      return result;
    } catch (error) {
      const isLastAttempt = attempt === maxRetries - 1;

      if (isLastAttempt) {
        console.error(`${LOG_EMOJI.ERROR} ${operation} failed after ${maxRetries} attempts:`, error.message);
        throw error;
      }

      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt); // Exponential backoff: 1s, 2s, 4s
      console.warn(`${LOG_EMOJI.WARNING} ${operation} failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
}

// Utility: Sleep helper
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

resolver.define('getConfig', async () => {
  const config = await storage.get('syncConfig');
  return config || null;
});

resolver.define('saveConfig', async ({ payload }) => {
  await storage.set('syncConfig', payload.config);
  return { success: true };
});

resolver.define('getUserMappings', async () => {
  const mappings = await storage.get('userMappings');
  const config = await storage.get('userMappingConfig');
  return {
    mappings: mappings || {},
    config: config || { autoMapUsers: true, fallbackUser: 'unassigned' }
  };
});

resolver.define('saveUserMappings', async ({ payload }) => {
  await storage.set('userMappings', payload.mappings);
  await storage.set('userMappingConfig', payload.config);
  return { success: true };
});

resolver.define('getFieldMappings', async () => {
  const mappings = await storage.get('fieldMappings');
  return mappings || {};
});

resolver.define('saveFieldMappings', async ({ payload }) => {
  await storage.set('fieldMappings', payload.mappings);
  return { success: true };
});

resolver.define('getStatusMappings', async () => {
  const mappings = await storage.get('statusMappings');
  return mappings || {};
});

resolver.define('saveStatusMappings', async ({ payload }) => {
  await storage.set('statusMappings', payload.mappings);
  return { success: true };
});

resolver.define('forceSyncIssue', async ({ payload }) => {
  try {
    const { issueKey } = payload;
    
    if (!issueKey) {
      throw new Error('Issue key is required');
    }
    
    console.log(`🔄 Manual sync requested for: ${issueKey}`);
    
    const config = await storage.get('syncConfig');
    if (!config || !config.remoteUrl) {
      throw new Error('Sync not configured');
    }
    
    const issue = await getFullIssue(issueKey);
    if (!issue) {
      throw new Error('Could not fetch issue data');
    }
    
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
    
    const existingRemoteKey = await getRemoteKey(issueKey);
    
    if (existingRemoteKey) {
      console.log(`🔄 Force UPDATE: ${issueKey} → ${existingRemoteKey}`);
      await updateRemoteIssue(issueKey, existingRemoteKey, issue, config, mappings);
      return { success: true, message: `Synced ${issueKey} to ${existingRemoteKey}` };
    } else {
      console.log(`✨ Force CREATE: ${issueKey}`);
      const remoteKey = await createRemoteIssue(issue, config, mappings);
      if (remoteKey) {
        return { success: true, message: `Created ${issueKey} as ${remoteKey}` };
      } else {
        throw new Error('Failed to create remote issue');
      }
    }
  } catch (error) {
    console.error('Force sync error:', error);
    return { success: false, error: error.message };
  }
});

resolver.define('getScheduledSyncConfig', async () => {
  const config = await storage.get('scheduledSyncConfig');
  return config || { 
    enabled: false, 
    intervalMinutes: 60,
    lastRun: null,
    syncScope: 'recent' // 'recent' or 'all'
  };
});

resolver.define('saveScheduledSyncConfig', async ({ payload }) => {
  await storage.set('scheduledSyncConfig', payload.config);
  return { success: true };
});

resolver.define('getScheduledSyncStats', async () => {
  const stats = await storage.get('scheduledSyncStats');
  return stats || {
    lastRun: null,
    issuesChecked: 0,
    issuesCreated: 0,
    issuesUpdated: 0,
    issuesSkipped: 0,
    errors: []
  };
});

resolver.define('getWebhookSyncStats', async () => {
  const stats = await storage.get('webhookSyncStats');
  return stats || {
    totalSyncs: 0,
    issuesCreated: 0,
    issuesUpdated: 0,
    commentsSynced: 0,
    issuesSkipped: 0,
    errors: [],
    lastSync: null
  };
});

async function checkIfIssueNeedsSync(issueKey, issue, config, mappings) {
  // Check if issue was created by remote sync
  const createdByRemote = await getLocalKey(issueKey);
  if (createdByRemote) {
    return { needsSync: false, reason: 'created-by-remote' };
  }

  // Check if issue has remote mapping
  const remoteKey = await getRemoteKey(issueKey);

  if (!remoteKey) {
    // No mapping exists - needs creation
    return { needsSync: true, action: 'create' };
  }

  // Has mapping - check if fields have changed
  // For now, we'll sync it (in future, we can add change detection)
  return { needsSync: true, action: 'update', remoteKey };
}

// Track real-time webhook sync statistics
async function trackWebhookSync(type, success, error = null) {
  try {
    const stats = await storage.get('webhookSyncStats') || {
      totalSyncs: 0,
      issuesCreated: 0,
      issuesUpdated: 0,
      commentsSynced: 0,
      issuesSkipped: 0,
      errors: [],
      lastSync: null
    };

    stats.totalSyncs++;
    stats.lastSync = new Date().toISOString();

    if (success) {
      if (type === 'create') stats.issuesCreated++;
      else if (type === 'update') stats.issuesUpdated++;
      else if (type === 'comment') stats.commentsSynced++;
    } else {
      stats.issuesSkipped++;
      if (error) {
        // Keep only last 50 errors
        stats.errors.unshift({ timestamp: new Date().toISOString(), error });
        if (stats.errors.length > 50) stats.errors = stats.errors.slice(0, 50);
      }
    }

    await storage.set('webhookSyncStats', stats);
  } catch (err) {
    console.error('Error tracking webhook stats:', err);
  }
}

async function performScheduledSync() {
  console.log(`⏰ Scheduled sync starting...`);
  
  const scheduledConfig = await storage.get('scheduledSyncConfig');
  if (!scheduledConfig || !scheduledConfig.enabled) {
    console.log(`⏭️ Scheduled sync disabled`);
    return;
  }
  
  const config = await storage.get('syncConfig');
  if (!config || !config.remoteUrl || !config.remoteProjectKey) {
    console.log(`⏭️ Sync not configured`);
    return;
  }
  
  const stats = {
    lastRun: new Date().toISOString(),
    issuesChecked: 0,
    issuesCreated: 0,
    issuesUpdated: 0,
    issuesSkipped: 0,
    errors: []
  };
  
  try {
    // Fetch all mappings once
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
    
    // Fetch recent issues from local Jira
    // Build project filter for JQL
    let projectFilter;
    if (config.allowedProjects && Array.isArray(config.allowedProjects) && config.allowedProjects.length > 0) {
      // Use allowed projects list
      if (config.allowedProjects.length === 1) {
        projectFilter = `project = ${config.allowedProjects[0]}`;
      } else {
        projectFilter = `project IN (${config.allowedProjects.join(', ')})`;
      }
    } else {
      // Fallback to remoteProjectKey for backward compatibility
      projectFilter = `project = ${config.remoteProjectKey}`;
    }

    const jql = scheduledConfig.syncScope === 'recent'
      ? `${projectFilter} AND updated >= -24h ORDER BY updated DESC`
      : `${projectFilter} ORDER BY updated DESC`;
    
    const searchResponse = await api.asApp().requestJira(
      route`/rest/api/3/search?jql=${jql}&maxResults=100`
    );
    const searchResults = await searchResponse.json();
    
    console.log(`📋 Found ${searchResults.issues.length} issues to check`);
    
    for (const issueData of searchResults.issues) {
      stats.issuesChecked++;
      const issueKey = issueData.key;
      
      try {
        // Get full issue details
        const issue = await getFullIssue(issueKey);
        if (!issue) {
          console.log(`⏭️ Could not fetch ${issueKey}`);
          stats.issuesSkipped++;
          continue;
        }
        
        // Check if sync is needed
        const syncCheck = await checkIfIssueNeedsSync(issueKey, issue, config, mappings);
        
        if (!syncCheck.needsSync) {
          console.log(`⏭️ ${issueKey} - ${syncCheck.reason}`);
          stats.issuesSkipped++;
          continue;
        }
        
        // Perform sync
        if (syncCheck.action === 'create') {
          console.log(`✨ Scheduled CREATE: ${issueKey}`);
          const remoteKey = await createRemoteIssue(issue, config, mappings);
          if (remoteKey) {
            stats.issuesCreated++;
          } else {
            stats.errors.push(`Failed to create ${issueKey}`);
          }
        } else if (syncCheck.action === 'update') {
          console.log(`🔄 Scheduled UPDATE: ${issueKey} → ${syncCheck.remoteKey}`);
          await updateRemoteIssue(issueKey, syncCheck.remoteKey, issue, config, mappings);
          stats.issuesUpdated++;
        }
        
        // Small delay to avoid rate limiting
        await sleep(SCHEDULED_SYNC_DELAY_MS);
        
      } catch (error) {
        console.error(`Error syncing ${issueKey}:`, error);
        stats.errors.push(`${issueKey}: ${error.message}`);
      }
    }
    
  } catch (error) {
    console.error('Scheduled sync error:', error);
    stats.errors.push(`General error: ${error.message}`);
  }
  
  // Save stats
  await storage.set('scheduledSyncStats', stats);
  
  console.log(`✅ Scheduled sync complete:`, stats);
  return stats;
}

resolver.define('fetchLocalProjects', async () => {
  try {
    const projectsResponse = await api.asApp().requestJira(
      route`/rest/api/3/project/search?maxResults=1000`
    );
    const projectsData = await projectsResponse.json();

    return {
      projects: projectsData.values.map(p => ({
        key: p.key,
        name: p.name,
        id: p.id
      }))
    };
  } catch (error) {
    console.error('Error fetching local projects:', error);
    throw error;
  }
});

resolver.define('fetchLocalData', async () => {
  try {
    const config = await storage.get('syncConfig');
    if (!config || !config.remoteProjectKey) {
      throw new Error('Project key not configured');
    }

    const usersResponse = await api.asApp().requestJira(
      route`/rest/api/3/users/search?maxResults=1000`
    );
    const allUsers = await usersResponse.json();

    const users = allUsers.filter(u =>
      u.accountType === 'atlassian' &&
      u.active === true &&
      !u.displayName.includes('(')
    );

    const fieldsResponse = await api.asApp().requestJira(
      route`/rest/api/3/field`
    );
    const allFields = await fieldsResponse.json();
    const customFields = allFields.filter(f => f.custom);

    const statusesResponse = await api.asApp().requestJira(
      route`/rest/api/3/project/${config.remoteProjectKey}/statuses`
    );
    const statusData = await statusesResponse.json();

    const statusMap = new Map();
    statusData.forEach(issueType => {
      issueType.statuses.forEach(status => {
        if (!statusMap.has(status.id)) {
          statusMap.set(status.id, {
            id: status.id,
            name: status.name
          });
        }
      });
    });
    const statuses = Array.from(statusMap.values());

    return {
      users: users.map(u => ({
        accountId: u.accountId,
        displayName: u.displayName,
        emailAddress: u.emailAddress || ''
      })),
      fields: customFields.map(f => ({
        id: f.id,
        name: f.name
      })),
      statuses: statuses
    };
  } catch (error) {
    console.error('Error fetching local data:', error);
    throw error;
  }
});

resolver.define('fetchRemoteData', async () => {
  try {
    const config = await storage.get('syncConfig');
    if (!config || !config.remoteUrl || !config.remoteEmail || !config.remoteApiToken) {
      throw new Error('Remote configuration not complete');
    }

    const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
    const headers = {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    };

    const usersResponse = await fetch(
      `${config.remoteUrl}/rest/api/3/users/search?maxResults=1000`,
      { headers }
    );
    const allUsers = await usersResponse.json();
    
    const users = allUsers.filter(u => 
      u.accountType === 'atlassian' && 
      u.active === true &&
      !u.displayName.includes('(')
    );

    const fieldsResponse = await fetch(
      `${config.remoteUrl}/rest/api/3/field`,
      { headers }
    );
    const allFields = await fieldsResponse.json();
    const customFields = allFields.filter(f => f.custom);

    const statusesResponse = await fetch(
      `${config.remoteUrl}/rest/api/3/project/${config.remoteProjectKey}/statuses`,
      { headers }
    );
    const statusData = await statusesResponse.json();
    
    const statusMap = new Map();
    statusData.forEach(issueType => {
      issueType.statuses.forEach(status => {
        if (!statusMap.has(status.id)) {
          statusMap.set(status.id, {
            id: status.id,
            name: status.name
          });
        }
      });
    });
    const statuses = Array.from(statusMap.values());

    return {
      users: users.map(u => ({
        accountId: u.accountId,
        displayName: u.displayName,
        emailAddress: u.emailAddress || ''
      })),
      fields: customFields.map(f => ({
        id: f.id,
        name: f.name
      })),
      statuses: statuses
    };
  } catch (error) {
    console.error('Error fetching remote data:', error);
    throw error;
  }
});

function mapUserToRemote(localAccountId, userMappings) {
  if (!localAccountId) return null;
  
  for (const [remoteId, mapping] of Object.entries(userMappings)) {
    const localId = typeof mapping === 'string' ? mapping : mapping.localId;
    if (localId === localAccountId) {
      return remoteId;
    }
  }
  
  return null;
}

function reverseMapping(mapping) {
  const reversed = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (value) {
      const localId = typeof value === 'string' ? value : value.localId;
      if (localId) {
        reversed[localId] = key;
      }
    }
  }
  return reversed;
}

function extractTextFromADF(adf) {
  if (!adf || typeof adf !== 'object') return '';
  
  let text = '';
  
  function traverse(node, isFirstNode = false) {
    if (node.type === 'text') {
      text += node.text;
    } else if (node.type === 'paragraph' && !isFirstNode && text.length > 0) {
      // Add line breaks between paragraphs
      text += '\n\n';
    } else if (node.type === 'hardBreak') {
      text += '\n';
    }
    
    if (node.content && Array.isArray(node.content)) {
      node.content.forEach((child, index) => traverse(child, index === 0 && isFirstNode));
    }
  }
  
  traverse(adf, true);
  return text.trim();
}

async function replaceMediaIdsInADF(adf, attachmentMapping) {
  if (!adf || typeof adf !== 'object') return adf;
  
  // Deep clone to avoid mutating original
  const cloned = JSON.parse(JSON.stringify(adf));
  
  function traverse(node) {
    if (node.type === 'media' && node.attrs && node.attrs.id) {
      const localId = node.attrs.id;
      const remoteId = attachmentMapping[localId];
      if (remoteId) {
        console.log(`🖼️ Replacing media ID: ${localId} → ${remoteId}`);
        node.attrs.id = remoteId;
      } else {
        console.log(`⚠️ No mapping found for media ID: ${localId}`);
      }
    }
    
    if (node.content && Array.isArray(node.content)) {
      node.content.forEach(traverse);
    }
  }
  
  traverse(cloned);
  return cloned;
}

function textToADFWithAuthor(text, orgName, userName) {
  const prefix = `[Comment from ${orgName} - User: ${userName}]:\n\n`;
  const fullText = prefix + (text || '');
  
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: fullText
          }
        ]
      }
    ]
  };
}

function textToADF(text) {
  if (!text || text.trim() === '') {
    return {
      type: 'doc',
      version: 1,
      content: []
    };
  }
  
  // Split by double line breaks for paragraphs
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
  
  if (paragraphs.length === 0) {
    return {
      type: 'doc',
      version: 1,
      content: []
    };
  }
  
  const content = paragraphs.map(para => ({
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text: para.trim()
      }
    ]
  }));
  
  return {
    type: 'doc',
    version: 1,
    content: content
  };
}

function extractSprintIds(fieldValue) {
  if (!Array.isArray(fieldValue) || fieldValue.length === 0) {
    return null;
  }
  
  // Check if this is sprint data (array of objects with id property)
  if (typeof fieldValue[0] === 'object' && fieldValue[0] !== null) {
    const ids = fieldValue
      .map(item => {
        // Sprint objects can have id as number or string
        if (typeof item.id === 'number') return item.id;
        if (typeof item.id === 'string') {
          const parsed = parseInt(item.id, 10);
          return isNaN(parsed) ? null : parsed;
        }
        return null;
      })
      .filter(id => id !== null);
    
    return ids.length > 0 ? ids : null;
  }
  
  // Already an array of numbers
  if (typeof fieldValue[0] === 'number') {
    return fieldValue;
  }
  
  return null;
}

async function getRemoteKey(localKey) {
  return await storage.get(`local-to-remote:${localKey}`);
}

async function getLocalKey(remoteKey) {
  return await storage.get(`remote-to-local:${remoteKey}`);
}

async function storeMapping(localKey, remoteKey) {
  await storage.set(`local-to-remote:${localKey}`, remoteKey);
  await storage.set(`remote-to-local:${remoteKey}`, localKey);
}

async function storeAttachmentMapping(localAttachmentId, remoteAttachmentId) {
  await storage.set(`attachment-mapping:${localAttachmentId}`, remoteAttachmentId);
}

async function getAttachmentMapping(localAttachmentId) {
  return await storage.get(`attachment-mapping:${localAttachmentId}`);
}

async function storeLinkMapping(localLinkId, remoteLinkId) {
  await storage.set(`link-mapping:${localLinkId}`, remoteLinkId);
}

async function getLinkMapping(localLinkId) {
  return await storage.get(`link-mapping:${localLinkId}`);
}

async function markSyncing(issueKey) {
  await storage.set(`syncing:${issueKey}`, 'true', { ttl: SYNC_FLAG_TTL_SECONDS });
}

async function isSyncing(issueKey) {
  const syncing = await storage.get(`syncing:${issueKey}`);
  return syncing === 'true';
}

async function getFullIssue(issueKey) {
  try {
    const response = await api.asApp().requestJira(
      route`/rest/api/3/issue/${issueKey}`
    );
    return await response.json();
  } catch (error) {
    console.error('Error fetching issue:', error);
    return null;
  }
}

async function getFullComment(issueKey, commentId) {
  try {
    const response = await api.asApp().requestJira(
      route`/rest/api/3/issue/${issueKey}/comment/${commentId}`
    );
    return await response.json();
  } catch (error) {
    console.error('Error fetching comment:', error);
    return null;
  }
}

async function getOrgName() {
  try {
    const response = await api.asApp().requestJira(
      route`/rest/api/3/serverInfo`
    );
    const serverInfo = await response.json();
    const match = serverInfo.baseUrl.match(/https?:\/\/([^.]+)/);
    if (match && match[1]) {
      return match[1];
    }
    return 'Jira';
  } catch (error) {
    console.error('Error fetching org name:', error);
    return 'Jira';
  }
}

async function isProjectAllowedToSync(projectKey, config) {
  // If no filter is configured, allow all projects (backward compatibility)
  if (!config.allowedProjects || !Array.isArray(config.allowedProjects) || config.allowedProjects.length === 0) {
    console.log(`✅ No project filter configured - allowing ${projectKey}`);
    return true;
  }

  // Check if project is in allowed list
  const isAllowed = config.allowedProjects.includes(projectKey);

  if (isAllowed) {
    console.log(`✅ Project ${projectKey} is in allowed list`);
  } else {
    console.log(`⛔ Project ${projectKey} is NOT in allowed list [${config.allowedProjects.join(', ')}] - skipping sync`);
  }

  return isAllowed;
}

async function downloadAttachment(attachmentUrl) {
  try {
    // Extract attachment ID from URL
    // URL format: https://serdarjiraone.atlassian.net/rest/api/3/attachment/content/10004
    const matches = attachmentUrl.match(/\/attachment\/content\/(\d+)/);
    if (!matches || !matches[1]) {
      console.error('Could not extract attachment ID from URL:', attachmentUrl);
      return null;
    }
    
    const attachmentId = matches[1];
    console.log(`Downloading attachment ID: ${attachmentId}`);
    
    const response = await api.asApp().requestJira(
      route`/rest/api/3/attachment/content/${attachmentId}`,
      {
        headers: {
          'Accept': '*/*'
        }
      }
    );
    
    if (!response.ok) {
      console.error(`Failed to download attachment: ${response.status}`);
      return null;
    }
    
    // Get the binary data as ArrayBuffer
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    console.error('Error downloading attachment:', error);
    return null;
  }
}

async function uploadAttachment(remoteKey, filename, fileBuffer, config) {
  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
  
  try {
    // Create form data boundary
    const boundary = `----ForgeFormBoundary${Date.now()}`;
    
    // Build multipart form data manually
    const formDataParts = [];
    formDataParts.push(`--${boundary}\r\n`);
    formDataParts.push(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`);
    formDataParts.push(`Content-Type: application/octet-stream\r\n\r\n`);
    
    // Convert string parts to buffers
    const header = Buffer.from(formDataParts.join(''));
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    
    // Combine all parts
    const body = Buffer.concat([header, fileBuffer, footer]);
    
    const response = await retryWithBackoff(async () => {
      return await fetch(
        `${config.remoteUrl}/rest/api/3/issue/${remoteKey}/attachments`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'X-Atlassian-Token': 'no-check'
          },
          body: body
        }
      );
    }, `Upload attachment ${filename} to ${remoteKey}`);

    if (response.ok) {
      const result = await response.json();
      console.log(`${LOG_EMOJI.SUCCESS} Uploaded attachment: ${filename}`);
      return result[0]?.id || null; // Return the remote attachment ID
    } else {
      const errorText = await response.text();
      console.error(`❌ Failed to upload attachment ${filename}:`, errorText);
      return null;
    }
  } catch (error) {
    console.error(`Error uploading attachment ${filename}:`, error);
    return null;
  }
}

async function syncAttachments(localIssueKey, remoteIssueKey, issue, config, syncResult = null) {
  const attachmentMapping = {}; // localId -> remoteId

  if (!issue.fields.attachment || issue.fields.attachment.length === 0) {
    console.log(`No attachments to sync for ${localIssueKey}`);
    return attachmentMapping;
  }

  console.log(`${LOG_EMOJI.ATTACHMENT} Found ${issue.fields.attachment.length} attachment(s) on ${localIssueKey}`);

  for (const attachment of issue.fields.attachment) {
    try {
      // Check if already synced
      const existingMapping = await getAttachmentMapping(attachment.id);
      if (existingMapping) {
        console.log(`${LOG_EMOJI.SKIP} Attachment ${attachment.filename} already synced`);
        attachmentMapping[attachment.id] = existingMapping;
        if (syncResult) syncResult.addAttachmentSkipped(attachment.filename, 'already synced');
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
        // Store mapping to prevent re-syncing
        await storeAttachmentMapping(attachment.id, remoteAttachmentId);
        attachmentMapping[attachment.id] = remoteAttachmentId;
        console.log(`${LOG_EMOJI.SUCCESS} Synced attachment: ${attachment.filename}`);
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
async function syncIssueLinks(localIssueKey, remoteIssueKey, issue, config, syncResult = null) {
  if (!issue.fields.issuelinks || issue.fields.issuelinks.length === 0) {
    console.log(`No issue links to sync for ${localIssueKey}`);
    return;
  }

  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');

  console.log(`${LOG_EMOJI.LINK} Found ${issue.fields.issuelinks.length} issue link(s) on ${localIssueKey}`);

  for (const link of issue.fields.issuelinks) {
    try {
      // Check if already synced
      const existingMapping = await getLinkMapping(link.id);
      if (existingMapping) {
        console.log(`${LOG_EMOJI.SKIP} Link ${link.id} already synced`);
        const linkedKey = link.outwardIssue?.key || link.inwardIssue?.key || 'unknown';
        if (syncResult) syncResult.addLinkSkipped(linkedKey, 'already synced');
        continue;
      }

      const linkTypeName = link.type.name;
      let linkedIssueKey = null;
      let direction = null;

      // Determine linked issue and direction
      if (link.outwardIssue) {
        linkedIssueKey = link.outwardIssue.key;
        direction = 'outward';
      } else if (link.inwardIssue) {
        linkedIssueKey = link.inwardIssue.key;
        direction = 'inward';
      }

      if (!linkedIssueKey) {
        console.log(`${LOG_EMOJI.WARNING} No linked issue found for link ${link.id}`);
        if (syncResult) syncResult.addLinkSkipped('unknown', 'no linked issue found');
        continue;
      }

      // Check if linked issue is synced
      const remoteLinkedKey = await getRemoteKey(linkedIssueKey);
      if (!remoteLinkedKey) {
        console.log(`${LOG_EMOJI.SKIP} Skipping link to ${linkedIssueKey} - not synced yet`);
        if (syncResult) syncResult.addLinkSkipped(linkedIssueKey, 'linked issue not synced yet');
        continue;
      }

      // Create the link in remote org
      const linkPayload = {
        type: { name: linkTypeName }
      };

      if (direction === 'outward') {
        linkPayload.inwardIssue = { key: remoteIssueKey };
        linkPayload.outwardIssue = { key: remoteLinkedKey };
        console.log(`${LOG_EMOJI.LINK} Creating link: ${remoteIssueKey} ${link.type.outward} ${remoteLinkedKey}`);
      } else {
        linkPayload.inwardIssue = { key: remoteLinkedKey };
        linkPayload.outwardIssue = { key: remoteIssueKey };
        console.log(`${LOG_EMOJI.LINK} Creating link: ${remoteLinkedKey} ${link.type.outward} ${remoteIssueKey}`);
      }

      const response = await fetch(
        `${config.remoteUrl}/rest/api/3/issueLink`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(linkPayload)
        }
      );

      if (response.ok || response.status === 201) {
        console.log(`${LOG_EMOJI.SUCCESS} Synced issue link: ${linkedIssueKey} (${linkTypeName})`);
        // Store mapping to prevent re-creating
        await storeLinkMapping(link.id, 'synced');
        if (syncResult) syncResult.addLinkSuccess(linkedIssueKey, linkTypeName);
      } else {
        const errorText = await response.text();
        console.error(`${LOG_EMOJI.ERROR} Failed to create link: ${errorText}`);
        if (syncResult) syncResult.addLinkFailure(linkedIssueKey, errorText);
      }

    } catch (error) {
      console.error(`${LOG_EMOJI.ERROR} Error syncing link ${link.id}:`, error);
      const linkedKey = link.outwardIssue?.key || link.inwardIssue?.key || 'unknown';
      if (syncResult) syncResult.addLinkFailure(linkedKey, error.message);
    }
  }
}

async function transitionRemoteIssue(remoteKey, statusName, config, statusMappings, syncResult = null) {
  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
  const reversedStatusMap = reverseMapping(statusMappings);

  console.log(`${LOG_EMOJI.STATUS} Attempting to transition ${remoteKey} to status: ${statusName}`);
  
  try {
    const transitionsResponse = await fetch(
      `${config.remoteUrl}/rest/api/3/issue/${remoteKey}/transitions`,
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    if (!transitionsResponse.ok) {
      console.error(`❌ Failed to fetch transitions for ${remoteKey}: ${transitionsResponse.status}`);
      return;
    }
    
    const transitions = await transitionsResponse.json();
    console.log(`Available transitions for ${remoteKey}:`, transitions.transitions.map(t => `${t.name} (${t.to.name})`).join(', '));
    
    let transition = transitions.transitions.find(t => 
      t.to.name.toLowerCase() === statusName.toLowerCase()
    );
    
    if (!transition && reversedStatusMap[statusName]) {
      const mappedStatusId = reversedStatusMap[statusName];
      console.log(`Trying mapped status ID: ${mappedStatusId}`);
      transition = transitions.transitions.find(t => t.to.id === mappedStatusId);
    }

    if (!transition) {
      const errorMsg = `No transition found to status: ${statusName}. Available: ${transitions.transitions.map(t => t.to.name).join(', ')}`;
      console.error(`${LOG_EMOJI.ERROR} ${errorMsg}`);
      if (syncResult) syncResult.addTransitionFailure(statusName, errorMsg);
      return;
    }

    console.log(`Using transition: ${transition.name} → ${transition.to.name}`);

    const transitionResponse = await retryWithBackoff(async () => {
      return await fetch(
        `${config.remoteUrl}/rest/api/3/issue/${remoteKey}/transitions`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            transition: { id: transition.id }
          })
        }
      );
    }, `Transition ${remoteKey} to ${statusName}`);

    if (transitionResponse.ok || transitionResponse.status === HTTP_STATUS.NO_CONTENT) {
      console.log(`${LOG_EMOJI.SUCCESS} Transitioned ${remoteKey} to ${transition.to.name}`);
      if (syncResult) syncResult.addTransitionSuccess(transition.to.name);
    } else {
      const errorText = await transitionResponse.text();
      console.error(`${LOG_EMOJI.ERROR} Transition failed: ${errorText}`);
      if (syncResult) syncResult.addTransitionFailure(statusName, errorText);
    }
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error transitioning issue:`, error);
    if (syncResult) syncResult.addTransitionFailure(statusName, error.message);
  }
}

async function createRemoteIssue(issue, config, mappings, syncResult = null) {
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
  const reversedFieldMap = reverseMapping(mappings.fieldMappings);
  for (const [localFieldId, remoteFieldId] of Object.entries(reversedFieldMap)) {
    if (issue.fields[localFieldId] !== undefined && issue.fields[localFieldId] !== null) {
      let fieldValue = issue.fields[localFieldId];
      
      // Try to extract sprint IDs if this is sprint data
      const sprintIds = extractSprintIds(fieldValue);
      if (sprintIds !== null) {
        fieldValue = sprintIds;
        console.log(`🏃 Extracted sprint IDs for ${localFieldId} → ${remoteFieldId}: ${JSON.stringify(fieldValue)}`);
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
      
      await storeMapping(issue.key, result.key);

      if (issue.fields.status && issue.fields.status.name !== 'To Do') {
        await transitionRemoteIssue(result.key, issue.fields.status.name, config, mappings.statusMappings, syncResult);
      }

      // Sync attachments after issue creation and get mapping
      const attachmentMapping = await syncAttachments(issue.key, result.key, issue, config, syncResult);

      // Sync issue links after issue creation
      await syncIssueLinks(issue.key, result.key, issue, config, syncResult);
      
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

      return result.key;
    } else {
      const errorText = await response.text();
      console.error(`${LOG_EMOJI.ERROR} Create failed: ${errorText}`);
      if (syncResult) syncResult.addError(`Create failed: ${errorText}`);
    }
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error creating remote issue:`, error);
    if (syncResult) syncResult.addError(`Error creating remote issue: ${error.message}`);
  }

  return null;
}

async function updateRemoteIssue(localKey, remoteKey, issue, config, mappings, syncResult = null) {
  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
  
  // Sync attachments first to get ID mappings
  const attachmentMapping = await syncAttachments(localKey, remoteKey, issue, config, syncResult);

  // Sync issue links
  await syncIssueLinks(localKey, remoteKey, issue, config, syncResult);
  
  let description;
  if (issue.fields.description) {
    if (typeof issue.fields.description === 'object') {
      // Always extract text only for updates to avoid media ID mapping issues
      // Attachments are synced separately as files
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
      
      // Try to extract sprint IDs if this is sprint data
      const sprintIds = extractSprintIds(fieldValue);
      if (sprintIds !== null) {
        fieldValue = sprintIds;
        console.log(`🏃 Extracted sprint IDs for ${localFieldId} → ${remoteFieldId}: ${JSON.stringify(fieldValue)}`);
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
    } else {
      const errorText = await response.text();
      console.error(`${LOG_EMOJI.ERROR} Update failed: ${errorText}`);
      if (syncResult) syncResult.addError(`Update failed: ${errorText}`);
    }
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error updating remote issue:`, error);
    if (syncResult) syncResult.addError(`Error updating remote issue: ${error.message}`);
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

  const createdByRemoteSync = await getLocalKey(issueKey);
  if (createdByRemoteSync) {
    console.log(`⏭️ Skipping ${issueKey} - was created by remote sync`);
    await trackWebhookSync('skip', false, 'Created by remote sync');
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
    } else {
      console.log(`${LOG_EMOJI.CREATE} CREATE: ${issueKey}`);
      remoteKey = await createRemoteIssue(issue, config, mappings, syncResult);
      await trackWebhookSync('create', syncResult.success && remoteKey, syncResult.errors.join('; '));
    }
  } catch (error) {
    await trackWebhookSync(existingRemoteKey ? 'update' : 'create', false, error.message);
    throw error;
  }

  // Log comprehensive summary
  syncResult.logSummary(issueKey, remoteKey);
}

export async function syncComment(event) {
  const issueKey = event.issue.key;
  const commentId = event.comment?.id;
  const config = await storage.get('syncConfig');

  if (!config || !config.remoteUrl) {
    console.log('Comment sync skipped: not configured');
    await trackWebhookSync('comment', false, 'Not configured');
    return;
  }

  const createdByRemoteSync = await getLocalKey(issueKey);
  if (createdByRemoteSync) {
    console.log(`⏭️ Skipping comment on ${issueKey} - issue was created by remote sync`);
    await trackWebhookSync('comment', false, 'Issue created by remote sync');
    return;
  }

  // Get issue to check project
  const issue = await getFullIssue(issueKey);
  if (!issue) {
    console.log('Could not fetch issue data for comment sync');
    await trackWebhookSync('comment', false, 'Could not fetch issue data');
    return;
  }

  // Check if project is allowed to sync
  const projectKey = issue.fields.project.key;
  const isAllowed = await isProjectAllowedToSync(projectKey, config);
  if (!isAllowed) {
    console.log(`⏭️ Skipping comment on ${issueKey} - project ${projectKey} not in allowed list`);
    await trackWebhookSync('comment', false, `Project ${projectKey} not allowed`);
    return;
  }

  const remoteKey = await getRemoteKey(issueKey);
  if (!remoteKey) {
    console.log(`No remote issue found for ${issueKey}`);
    await trackWebhookSync('comment', false, `No remote issue found for ${issueKey}`);
    return;
  }

  const fullComment = await getFullComment(issueKey, commentId);
  if (!fullComment) {
    console.log('Could not fetch full comment data');
    await trackWebhookSync('comment', false, 'Could not fetch comment data');
    return;
  }

  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
  const orgName = await getOrgName();
  const userName = fullComment.author?.displayName || fullComment.author?.emailAddress || 'Unknown User';

  let commentText = '';
  if (fullComment.body && typeof fullComment.body === 'object') {
    commentText = extractTextFromADF(fullComment.body);
  } else {
    commentText = fullComment.body || '';
  }

  const commentBody = textToADFWithAuthor(commentText, orgName, userName);

  // Create sync result tracker for comment
  const syncResult = new SyncResult('comment');

  try {
    console.log(`${LOG_EMOJI.COMMENT} Syncing comment: ${issueKey} → ${remoteKey} (from ${orgName} - ${userName})`);

    const response = await retryWithBackoff(async () => {
      return await fetch(
        `${config.remoteUrl}/rest/api/3/issue/${remoteKey}/comment`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ body: commentBody })
        }
      );
    }, `Sync comment to ${remoteKey}`);

    if (response.ok) {
      console.log(`${LOG_EMOJI.SUCCESS} Comment synced to ${remoteKey}`);
      syncResult.details.comments.success++;
      await trackWebhookSync('comment', true);
    } else {
      const errorText = await response.text();
      console.error(`${LOG_EMOJI.ERROR} Comment sync failed: ${errorText}`);
      syncResult.details.comments.failed++;
      syncResult.addError(`Comment sync failed: ${errorText}`);
      await trackWebhookSync('comment', false, errorText);
    }
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error syncing comment:`, error);
    syncResult.details.comments.failed++;
    syncResult.addError(`Error syncing comment: ${error.message}`);
    await trackWebhookSync('comment', false, error.message);
  }

  // Log summary
  syncResult.logSummary(issueKey, remoteKey);
}

export async function run(event, context) {
  console.log(`🔔 Trigger fired: ${event.eventType}`);
  console.log(`📝 Issue: ${event.issue?.key}`);
  
  // Log what changed
  if (event.changelog?.items) {
    console.log(`🔄 Changes detected:`);
    event.changelog.items.forEach(item => {
      console.log(`   - ${item.field}: "${item.fromString}" → "${item.toString}"`);
    });
  } else {
    console.log(`⚠️ No changelog available in event`);
  }
  
  // For updated events, check if this is right after creation (prevents duplicate creation)
  if (event.eventType === 'avi:jira:updated:issue') {
    const createdAt = await storage.get(`created-timestamp:${event.issue.key}`);
    if (createdAt) {
      const timeSinceCreation = Date.now() - parseInt(createdAt, 10);
      if (timeSinceCreation < RECENT_CREATION_WINDOW_MS) {
        // Only skip if remote issue doesn't exist yet (still being created)
        const remoteKey = await getRemoteKey(event.issue.key);
        if (!remoteKey) {
          console.log(`⏭️ Skipping UPDATE event - issue was just created ${timeSinceCreation}ms ago (still creating remote)`);
          return;
        }
      }
    }
  }
  
  // Store creation timestamp for new issues
  if (event.eventType === 'avi:jira:created:issue') {
    await storage.set(`created-timestamp:${event.issue.key}`, Date.now().toString(), { ttl: 10 });
  }
  
  await syncIssue(event);
}

export async function runComment(event, context) {
  console.log(`💬 Comment trigger fired`);
  await syncComment(event);
}

export async function runScheduledSync(event, context) {
  console.log(`⏰ Scheduled sync trigger fired`);
  try {
    const stats = await performScheduledSync();
    console.log(`✅ Scheduled sync completed:`, stats);
  } catch (error) {
    console.error(`❌ Scheduled sync failed:`, error);
  }
}

// Resolver handler (called by admin UI)
export const handler = resolver.getDefinitions();