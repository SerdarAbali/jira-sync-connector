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

// Fetch local Jira data (users, fields, statuses)
resolver.define('fetchLocalData', async () => {
  try {
    const config = await storage.get('syncConfig');
    if (!config || !config.remoteProjectKey) {
      throw new Error('Project key not configured');
    }

    // Fetch local users
    const usersResponse = await api.asApp().requestJira(
      route`/rest/api/3/users/search?maxResults=1000`
    );
    const allUsers = await usersResponse.json();
    
    // Filter out bots and service accounts
    const users = allUsers.filter(u => 
      u.accountType === 'atlassian' && 
      u.active === true &&
      !u.displayName.includes('(') // Filters out "Automation for Jira ()", "Slack ()", etc.
    );

    // Fetch all fields
    const fieldsResponse = await api.asApp().requestJira(
      route`/rest/api/3/field`
    );
    const allFields = await fieldsResponse.json();
    
    // Filter to custom fields only
    const customFields = allFields.filter(f => f.custom);

    // Fetch statuses for the project
    const statusesResponse = await api.asApp().requestJira(
      route`/rest/api/3/project/${config.remoteProjectKey}/statuses`
    );
    const statusData = await statusesResponse.json();
    
    // Extract unique statuses from all issue types
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
        emailAddress: u.emailAddress || '' // Add fallback for missing email
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

// Fetch remote Jira data (users, fields, statuses)
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

    // Fetch remote users
    const usersResponse = await fetch(
      `${config.remoteUrl}/rest/api/3/users/search?maxResults=1000`,
      { headers }
    );
    const allUsers = await usersResponse.json();
    
    // Filter out bots and service accounts
    const users = allUsers.filter(u => 
      u.accountType === 'atlassian' && 
      u.active === true &&
      !u.displayName.includes('(') // Filters out "Automation for Jira ()", "Slack ()", etc.
    );

    // Fetch all fields from remote
    const fieldsResponse = await fetch(
      `${config.remoteUrl}/rest/api/3/field`,
      { headers }
    );
    const allFields = await fieldsResponse.json();
    
    // Filter to custom fields only
    const customFields = allFields.filter(f => f.custom);

    // Fetch statuses from remote project
    const statusesResponse = await fetch(
      `${config.remoteUrl}/rest/api/3/project/${config.remoteProjectKey}/statuses`,
      { headers }
    );
    const statusData = await statusesResponse.json();
    
    // Extract unique statuses from all issue types
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
        emailAddress: u.emailAddress || '' // Add fallback for missing email
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

// Helper functions to get mappings
async function getUserMappings() {
  const data = await storage.get('userMappings');
  const config = await storage.get('userMappingConfig');
  return {
    mappings: data || {},
    config: config || { autoMapUsers: true, fallbackUser: 'unassigned' }
  };
}

async function getFieldMappings() {
  return await storage.get('fieldMappings') || {};
}

async function getStatusMappings() {
  return await storage.get('statusMappings') || {};
}

// Helper to map a local user account ID to remote user account ID
function mapUserToRemote(localAccountId, userMappingsData) {
  if (!localAccountId) return null;
  
  const { mappings } = userMappingsData;
  
  // Look through mappings to find if this local user is mapped
  for (const [remoteId, mapping] of Object.entries(mappings)) {
    const localId = typeof mapping === 'string' ? mapping : mapping.localId;
    if (localId === localAccountId) {
      return remoteId;
    }
  }
  
  // No mapping found, return null (caller should handle fallback)
  return null;
}

// Helper to reverse mapping (local -> remote)
function reverseMapping(mapping) {
  const reversed = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (value) {
      // Handle both old format (string) and new format (object with localId)
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
  await storage.set(`syncing:${issueKey}`, 'true', { ttl: 10 });
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

// Get comment with full author info
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

// Get organization name from Jira instance
async function getOrgName() {
  try {
    const response = await api.asApp().requestJira(
      route`/rest/api/3/serverInfo`
    );
    const serverInfo = await response.json();
    const match = serverInfo.baseUrl.match(/https?:\/\/([^.]+)/);
    if (match && match[1]) {
      return match[1]; // Fully dynamic - returns subdomain
    }
    return 'Jira';
  } catch (error) {
    console.error('Error fetching org name:', error);
    return 'Jira';
  }
}

async function transitionRemoteIssue(remoteKey, statusName, config) {
  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
  
  // Apply status mapping if configured
  const statusMappings = await getStatusMappings();
  const reversedStatusMap = reverseMapping(statusMappings);
  
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
      return;
    }
    
    const transitions = await transitionsResponse.json();
    
    // First try to find by exact name match
    let transition = transitions.transitions.find(t => 
      t.to.name.toLowerCase() === statusName.toLowerCase()
    );
    
    // If mapping exists, try to find by mapped status ID
    if (!transition && reversedStatusMap[statusName]) {
      const mappedStatusId = reversedStatusMap[statusName];
      transition = transitions.transitions.find(t => t.to.id === mappedStatusId);
    }
    
    if (!transition) {
      console.log(`No transition found to status: ${statusName}`);
      return;
    }
    
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
    }
  } catch (error) {
    console.error('Error transitioning issue:', error);
  }
}

async function createRemoteIssue(issue, config) {
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

    // Handle parent (epic) link
  if (issue.fields.parent && issue.fields.parent.key) {
    const remoteParentKey = await getRemoteKey(issue.fields.parent.key);
    if (remoteParentKey) {
      remoteIssue.fields.parent = { key: remoteParentKey };
      console.log(`🔗 Mapped parent: ${issue.fields.parent.key} → ${remoteParentKey}`);
    } else {
      console.log(`⚠️ Parent ${issue.fields.parent.key} not found in remote, skipping parent link`);
    }
  }

  // Store user mapping info for after creation
  const userMappingsData = await getUserMappings();
  let mappedAssignee = null;
  let mappedReporter = null;
  
  // Map reporter (can be set during creation)
  if (issue.fields.reporter && issue.fields.reporter.accountId) {
    mappedReporter = mapUserToRemote(issue.fields.reporter.accountId, userMappingsData);
    if (mappedReporter) {
      remoteIssue.fields.reporter = { accountId: mappedReporter };
      console.log(`👤 Mapped reporter: ${issue.fields.reporter.accountId} → ${mappedReporter}`);
    } else {
      console.log(`⚠️ No reporter mapping found for ${issue.fields.reporter.accountId}, using default`);
    }
  }
  
  // Get mapped assignee but DON'T set it during creation (will set after)
  if (issue.fields.assignee && issue.fields.assignee.accountId) {
    mappedAssignee = mapUserToRemote(issue.fields.assignee.accountId, userMappingsData);
    if (mappedAssignee) {
      console.log(`👤 Will assign to: ${issue.fields.assignee.accountId} → ${mappedAssignee}`);
    } else {
      console.log(`⚠️ No assignee mapping found for ${issue.fields.assignee.accountId}`);
    }
  }

  // Apply field mappings for custom fields
  const fieldMappings = await getFieldMappings();
  const reversedFieldMap = reverseMapping(fieldMappings);
  
  for (const [localFieldId, remoteFieldId] of Object.entries(reversedFieldMap)) {
    if (issue.fields[localFieldId] !== undefined && issue.fields[localFieldId] !== null) {
      remoteIssue.fields[remoteFieldId] = issue.fields[localFieldId];
      console.log(`📋 Mapped field ${localFieldId} -> ${remoteFieldId}`);
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
      await markSyncing(result.key);
      
      // Set assignee AFTER creation if mapped
      if (mappedAssignee) {
        try {
          const assignResponse = await fetch(
            `${config.remoteUrl}/rest/api/3/issue/${result.key}/assignee`,
            {
              method: 'PUT',
              headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ accountId: mappedAssignee })
            }
          );
          
          if (assignResponse.ok || assignResponse.status === 204) {
            console.log(`✅ Assigned ${result.key} to ${mappedAssignee}`);
          } else {
            const errorText = await assignResponse.text();
            console.error(`Failed to assign: ${errorText}`);
          }
        } catch (error) {
          console.error('Error assigning issue:', error);
        }
      }
      
      // Transition to correct status if needed
      if (issue.fields.status && issue.fields.status.name !== 'To Do') {
        await transitionRemoteIssue(result.key, issue.fields.status.name, config);
      }
      
      return result.key;
    } else {
      const errorText = await response.text();
      console.error('Create failed:', errorText);
    }
  } catch (error) {
    console.error('Error creating remote issue:', error);
  }
  
  return null;
}

async function updateRemoteIssue(localKey, remoteKey, issue, config) {
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

  // Apply user mappings for assignee
  const userMappingsData = await getUserMappings();
  
  if (issue.fields.assignee && issue.fields.assignee.accountId) {
    const mappedAssignee = mapUserToRemote(issue.fields.assignee.accountId, userMappingsData);
    if (mappedAssignee) {
      updateData.fields.assignee = { accountId: mappedAssignee };
      console.log(`👤 Mapped assignee: ${issue.fields.assignee.accountId} → ${mappedAssignee}`);
    } else {
      console.log(`⚠️ No assignee mapping found for ${issue.fields.assignee.accountId}`);
    }
  } else if (issue.fields.assignee === null) {
    // Handle unassign
    updateData.fields.assignee = null;
    console.log(`👤 Unassigning issue`);
  }

  // Apply field mappings for custom fields
  const fieldMappings = await getFieldMappings();
  const reversedFieldMap = reverseMapping(fieldMappings);
  
  for (const [localFieldId, remoteFieldId] of Object.entries(reversedFieldMap)) {
    if (issue.fields[localFieldId] !== undefined && issue.fields[localFieldId] !== null) {
      updateData.fields[remoteFieldId] = issue.fields[localFieldId];
      console.log(`📋 Mapped field ${localFieldId} -> ${remoteFieldId}`);
    }
  }

  try {
    console.log(`Updating remote issue: ${localKey} → ${remoteKey}`);
    
    await markSyncing(remoteKey);
    
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
        await transitionRemoteIssue(remoteKey, issue.fields.status.name, config);
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
  
  console.log(`📋 Processing ${issueKey}, event: ${event.eventType}`);
  
  const existingRemoteKey = await getRemoteKey(issueKey);
  
  if (existingRemoteKey) {
    console.log(`🔄 UPDATE: ${issueKey} → ${existingRemoteKey}`);
    await updateRemoteIssue(issueKey, existingRemoteKey, issue, config);
  } else {
    console.log(`✨ CREATE: ${issueKey}`);
    await createRemoteIssue(issue, config);
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
  
  // Fetch full comment with author info
  const fullComment = await getFullComment(issueKey, commentId);
  if (!fullComment) {
    console.log('Could not fetch full comment data');
    return;
  }
  
  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
  
  // Get org name dynamically
  const orgName = await getOrgName();
  
  // Get user name dynamically from full comment
  const userName = fullComment.author?.displayName || fullComment.author?.emailAddress || 'Unknown User';
  
  // Extract comment text from ADF
  let commentText = '';
  if (fullComment.body && typeof fullComment.body === 'object') {
    commentText = extractTextFromADF(fullComment.body);
  } else {
    commentText = fullComment.body || '';
  }
  
  // Create comment body with dynamic org and author
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

export const handler = resolver.getDefinitions();