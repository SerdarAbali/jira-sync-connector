import Resolver from '@forge/resolver';
import api, { route, storage, fetch } from '@forge/api';

const resolver = new Resolver();

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
    const jql = scheduledConfig.syncScope === 'recent' 
      ? `project = ${config.remoteProjectKey} AND updated >= -24h ORDER BY updated DESC`
      : `project = ${config.remoteProjectKey} ORDER BY updated DESC`;
    
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
        await new Promise(resolve => setTimeout(resolve, 500));
        
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
  
  function traverse(node) {
    if (node.type === 'text') {
      text += node.text;
    }
    if (node.content && Array.isArray(node.content)) {
      node.content.forEach(traverse);
    }
  }
  
  traverse(adf);
  return text;
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
  if (!text) {
    return {
      type: 'doc',
      version: 1,
      content: []
    };
  }
  
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: text
          }
        ]
      }
    ]
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

async function markSyncing(issueKey) {
  await storage.set(`syncing:${issueKey}`, 'true', { ttl: 5 });
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

async function transitionRemoteIssue(remoteKey, statusName, config, statusMappings) {
  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
  const reversedStatusMap = reverseMapping(statusMappings);
  
  console.log(`🔄 Attempting to transition ${remoteKey} to status: ${statusName}`);
  
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
      console.error(`❌ No transition found to status: ${statusName}`);
      console.error(`Available target statuses: ${transitions.transitions.map(t => t.to.name).join(', ')}`);
      return;
    }
    
    console.log(`Using transition: ${transition.name} → ${transition.to.name}`);
    
    const transitionResponse = await fetch(
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
    
    if (transitionResponse.ok || transitionResponse.status === 204) {
      console.log(`✅ Transitioned ${remoteKey} to ${transition.to.name}`);
    } else {
      const errorText = await transitionResponse.text();
      console.error(`❌ Transition failed: ${errorText}`);
    }
  } catch (error) {
    console.error(`❌ Error transitioning issue:`, error);
  }
}

async function createRemoteIssue(issue, config, mappings) {
  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
  
  let description;
  if (issue.fields.description) {
    if (typeof issue.fields.description === 'object') {
      description = issue.fields.description;
    } else {
      description = textToADF(issue.fields.description);
    }
  } else {
    description = textToADF(`Synced from ${issue.key}`);
  }
  
  const remoteIssue = {
    fields: {
      project: { key: config.remoteProjectKey },
      summary: issue.fields.summary,
      description: description,
      issuetype: { name: issue.fields.issuetype.name }
    }
  };
  
  if (issue.fields.priority) {
    remoteIssue.fields.priority = { name: issue.fields.priority.name };
  }
  
  if (issue.fields.labels && issue.fields.labels.length > 0) {
    remoteIssue.fields.labels = issue.fields.labels;
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
    
    const response = await fetch(`${config.remoteUrl}/rest/api/3/issue`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(remoteIssue)
    });

    if (response.ok) {
      const result = await response.json();
      console.log(`✅ Created ${issue.key} → ${result.key}`);
      
      await storeMapping(issue.key, result.key);
      
      if (issue.fields.status && issue.fields.status.name !== 'To Do') {
        await transitionRemoteIssue(result.key, issue.fields.status.name, config, mappings.statusMappings);
      }
      
      return result.key;
    } else {
      const errorText = await response.text();
      console.error('❌ Create failed:', errorText);
    }
  } catch (error) {
    console.error('Error creating remote issue:', error);
  }
  
  return null;
}

async function updateRemoteIssue(localKey, remoteKey, issue, config, mappings) {
  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
  
  let description;
  if (issue.fields.description) {
    if (typeof issue.fields.description === 'object') {
      description = issue.fields.description;
    } else {
      description = textToADF(issue.fields.description);
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
    
    const response = await fetch(`${config.remoteUrl}/rest/api/3/issue/${remoteKey}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updateData)
    });

    if (response.ok || response.status === 204) {
      console.log(`✅ Updated ${remoteKey} fields`);
      
      if (issue.fields.status) {
        await transitionRemoteIssue(remoteKey, issue.fields.status.name, config, mappings.statusMappings);
      }
    } else {
      const errorText = await response.text();
      console.error('Update failed:', errorText);
    }
  } catch (error) {
    console.error('Error updating remote issue:', error);
  }
}

export async function syncIssue(event) {
  const issueKey = event.issue.key;
  
  // Check if LOCAL issue is syncing
  if (await isSyncing(issueKey)) {
    console.log(`⏭️ Skipping ${issueKey} - currently syncing`);
    return;
  }
  
  const config = await storage.get('syncConfig');
  
  if (!config || !config.remoteUrl) {
    console.log('Sync skipped: not configured');
    return;
  }
  
  const createdByRemoteSync = await getLocalKey(issueKey);
  if (createdByRemoteSync) {
    console.log(`⏭️ Skipping ${issueKey} - was created by remote sync`);
    return;
  }
  
  const issue = await getFullIssue(issueKey);
  if (!issue) {
    console.error('Could not fetch issue data');
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
  
  console.log(`📋 Processing ${issueKey}, event: ${event.eventType}`);
  
  const existingRemoteKey = await getRemoteKey(issueKey);
  
  if (existingRemoteKey) {
    console.log(`🔄 UPDATE: ${issueKey} → ${existingRemoteKey}`);
    await updateRemoteIssue(issueKey, existingRemoteKey, issue, config, mappings);
  } else {
    console.log(`✨ CREATE: ${issueKey}`);
    await createRemoteIssue(issue, config, mappings);
  }
}

export async function syncComment(event) {
  const issueKey = event.issue.key;
  const commentId = event.comment?.id;
  const config = await storage.get('syncConfig');
  
  if (!config || !config.remoteUrl) {
    console.log('Comment sync skipped: not configured');
    return;
  }
  
  const createdByRemoteSync = await getLocalKey(issueKey);
  if (createdByRemoteSync) {
    console.log(`⏭️ Skipping comment on ${issueKey} - issue was created by remote sync`);
    return;
  }
  
  const remoteKey = await getRemoteKey(issueKey);
  if (!remoteKey) {
    console.log(`No remote issue found for ${issueKey}`);
    return;
  }
  
  const fullComment = await getFullComment(issueKey, commentId);
  if (!fullComment) {
    console.log('Could not fetch full comment data');
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

  try {
    console.log(`💬 Syncing comment: ${issueKey} → ${remoteKey} (from ${orgName} - ${userName})`);
    
    const response = await fetch(
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

    if (response.ok) {
      console.log(`✅ Comment synced to ${remoteKey}`);
    } else {
      const errorText = await response.text();
      console.error('Comment sync failed:', errorText);
    }
  } catch (error) {
    console.error('Error syncing comment:', error);
  }
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
      if (timeSinceCreation < 3000) { // Less than 3 seconds since creation
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