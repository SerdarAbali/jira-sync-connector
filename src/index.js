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
    
    const transition = transitions.transitions.find(t => 
      t.to.name.toLowerCase() === statusName.toLowerCase()
    );
    
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
      console.log(`✅ Transitioned ${remoteKey} to ${statusName}`);
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
