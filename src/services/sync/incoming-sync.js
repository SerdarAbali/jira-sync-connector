import api, { route } from '@forge/api';
import * as kvsStore from '../storage/kvs.js';
import { getLocalKey, storeMapping } from '../storage/mappings.js';
import { markSyncing, isSyncing, clearSyncFlag } from '../storage/flags.js';
import { LOG_EMOJI } from '../../constants.js';
import { textToADF } from '../../utils/adf.js';

export async function processIncomingWebhook(payload, secret) {
  // 1. Find Organization
  const orgs = await kvsStore.get('organizations') || [];
  console.log(`🔍 Checking ${orgs.length} organizations for secret match. Received secret length: ${secret?.length}`);
  
  // Find org by checking secrets (secrets are not stored in the main org object)
  let org = null;
  for (const o of orgs) {
    const storedSecret = await kvsStore.getSecret(`secret:${o.id}:incomingSecret`);
    // console.log(`Checking org ${o.id}, stored secret length: ${storedSecret?.length}`);
    if (storedSecret === secret) {
      org = o;
      console.log(`✅ Match found for org: ${o.id}`);
      break;
    }
  }

  if (!org) {
    console.warn(`${LOG_EMOJI.WARNING} Incoming webhook with invalid secret. Received: ${secret?.substring(0, 3)}...`);
    return { status: 401, body: { error: 'Invalid secret' } };
  }

  if (org.syncDirection !== 'bidirectional') {
    console.warn(`${LOG_EMOJI.WARNING} Incoming webhook for non-bidirectional org: ${org.name}`);
    return { status: 403, body: { error: 'Bidirectional sync not enabled' } };
  }

  const { webhookEvent, issue } = payload;
  
  if (!issue) {
      return { status: 400, body: { error: 'No issue in payload' } };
  }

  // 2. Route Event
  try {
    if (webhookEvent === 'jira:issue_created') {
      await handleRemoteIssueCreated(issue, org);
    } else if (webhookEvent === 'jira:issue_updated') {
      await handleRemoteIssueUpdated(issue, org);
    } else if (webhookEvent === 'jira:issue_deleted') {
      await handleRemoteIssueDeleted(issue, org);
    } else {
      console.log(`ℹ️ Ignoring event: ${webhookEvent}`);
    }
    
    return { status: 200, body: { message: 'Processed' } };
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error processing incoming webhook:`, error);
    return { status: 500, body: { error: error.message } };
  }
}

async function handleRemoteIssueCreated(remoteIssue, org) {
  console.log(`${LOG_EMOJI.SYNC} Received remote issue create: ${remoteIssue.key}`);
  
  // Check if already mapped (idempotency)
  const existingLocalKey = await getLocalKey(remoteIssue.key, org.id);
  if (existingLocalKey) {
    console.log(`ℹ️ Issue ${remoteIssue.key} already mapped to ${existingLocalKey}. Treating as update.`);
    return handleRemoteIssueUpdated(remoteIssue, org);
  }

  // Determine Target Project
  // Use the first allowed project as the target for incoming issues
  const targetProject = org.allowedProjects && org.allowedProjects.length > 0 ? org.allowedProjects[0] : null;
  if (!targetProject) {
      throw new Error(`No allowed local project configured for org ${org.name}`);
  }

  // Create Local Issue
  const payload = buildCreatePayload(remoteIssue, targetProject);
  
  const response = await api.asApp().requestJira(route`/rest/api/3/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to create local issue: ${err}`);
  }

  const data = await response.json();
  const localKey = data.key;
  const localId = data.id;

  console.log(`${LOG_EMOJI.SUCCESS} Created local issue ${localKey} from remote ${remoteIssue.key}`);

  // Store Mapping
  await storeMapping(localKey, remoteIssue.key, org.id);
  
  // Add comment linking back
  await api.asApp().requestJira(route`/rest/api/3/issue/${localKey}/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      body: textToADF(`Synced from remote issue: ${org.remoteUrl}/browse/${remoteIssue.key}`)
    })
  });
}

async function handleRemoteIssueUpdated(remoteIssue, org) {
  const localKey = await getLocalKey(remoteIssue.key, org.id);
  if (!localKey) {
    console.log(`⚠️ Remote issue ${remoteIssue.key} not mapped. Ignoring update.`);
    return;
  }

  console.log(`${LOG_EMOJI.SYNC} Processing update for ${localKey} (from ${remoteIssue.key})`);

  // Prevent Loop
  if (await isSyncing(localKey)) {
    console.log(`🔄 Loop detected: ${localKey} is already syncing. Skipping.`);
    return;
  }

  await markSyncing(localKey);
  try {
    const payload = buildUpdatePayload(remoteIssue);
    if (Object.keys(payload.fields).length === 0) {
       console.log(`ℹ️ No fields to update for ${localKey}`);
       return;
    }

    const response = await api.asApp().requestJira(route`/rest/api/3/issue/${localKey}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
       throw new Error(`Failed to update local issue: ${await response.text()}`);
    }
    console.log(`${LOG_EMOJI.SUCCESS} Updated local issue ${localKey}`);
  } finally {
    await clearSyncFlag(localKey);
  }
}

async function handleRemoteIssueDeleted(remoteIssue, org) {
    const localKey = await getLocalKey(remoteIssue.key, org.id);
    if (!localKey) {
        return;
    }
    
    console.log(`${LOG_EMOJI.SYNC} Remote issue ${remoteIssue.key} deleted. Deleting local ${localKey}`);
    
    await markSyncing(localKey);
    try {
        const response = await api.asApp().requestJira(route`/rest/api/3/issue/${localKey}`, {
            method: 'DELETE'
        });
        
        if (!response.ok) {
             throw new Error(`Failed to delete local issue: ${await response.text()}`);
        }
        console.log(`${LOG_EMOJI.SUCCESS} Deleted local issue ${localKey}`);
    } finally {
        await clearSyncFlag(localKey);
    }
}

function buildCreatePayload(remoteIssue, targetProjectKey) {
  // Basic mapping for MVP
  return {
    fields: {
      project: { key: targetProjectKey },
      summary: remoteIssue.fields.summary,
      description: remoteIssue.fields.description, 
      issuetype: { name: 'Task' } // Fallback to Task. Ideally we map this.
    }
  };
}

function buildUpdatePayload(remoteIssue) {
    return {
        fields: {
            summary: remoteIssue.fields.summary,
            description: remoteIssue.fields.description
        }
    };
}
