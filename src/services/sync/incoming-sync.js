const DEFAULT_USER_MAPPING_CONFIG = {
  autoMapUsers: true,
  fallbackUser: null
};

const BASE_REMOTE_FIELDS = [
  'summary',
  'description',
  'priority',
  'labels',
  'duedate',
  'components',
  'fixVersions',
  'versions',
  'timetracking',
  'assignee',
  'reporter',
  'parent',
  'status',
  'issuetype',
  'attachment'
];

const BLOCKED_FIELD_KEYS = new Set([
  'project',
  'issuetype',
  'status',
  'summary',
  'description',
  'priority',
  'labels',
  'duedate',
  'components',
  'fixVersions',
  'versions',
  'timetracking',
  'assignee',
  'reporter',
  'parent',
  'resolution',
  'resolutiondate',
  'creator',
  'created',
  'updated',
  'worklog',
  'comment',
  'attachment',
  'subtasks',
  'progress',
  'watches'
]);
import api, { route } from '@forge/api';
import * as kvsStore from '../storage/kvs.js';
import { getLocalKey, storeMapping, storeAttachmentMapping, getAttachmentMapping } from '../storage/mappings.js';
import { markSyncing, isSyncing, clearSyncFlag } from '../storage/flags.js';
import { LOG_EMOJI, MAX_ATTACHMENT_SIZE } from '../../constants.js';
import { textToADF, textToADFWithAuthor, extractTextFromADF } from '../../utils/adf.js';
import { getRemoteIssue } from '../jira/remote-client.js';
import { transitionLocalIssue } from './transition-sync.js';
import { mapUserToLocal } from '../../utils/mapping.js';
import { uploadAttachment, getFullIssue } from '../jira/local-client.js';

const ATTACHMENT_ISSUE_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const ATTACHMENT_ISSUE_CACHE_RETRY_ATTEMPTS = 6;
const ATTACHMENT_ISSUE_CACHE_RETRY_DELAY_MS = 500; // 0.5s wait between cache polls

export async function processIncomingWebhook(payload, secret) {
  const { webhookEvent } = payload;
  console.log(`📨 Received webhook event: ${webhookEvent}`);

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

  const remoteApiToken = await kvsStore.getSecret(`secret:${org.id}:token`);
  if (!remoteApiToken) {
    console.error(`${LOG_EMOJI.ERROR} Incoming webhook missing remote API token for org ${org.name}`);
    return { status: 500, body: { error: 'Remote credentials not configured' } };
  }

  const storageOrgId = org.id === 'legacy' ? null : org.id;
  const [userMappings, fieldMappings, statusMappings, issueTypeMappings, syncOptions] = await Promise.all([
    kvsStore.get(storageOrgId ? `userMappings:${storageOrgId}` : 'userMappings'),
    kvsStore.get(storageOrgId ? `fieldMappings:${storageOrgId}` : 'fieldMappings'),
    kvsStore.get(storageOrgId ? `statusMappings:${storageOrgId}` : 'statusMappings'),
    kvsStore.get(storageOrgId ? `issueTypeMappings:${storageOrgId}` : 'issueTypeMappings'),
    kvsStore.get(storageOrgId ? `syncOptions:${storageOrgId}` : 'syncOptions')
  ]);

  const context = {
    org: { ...org, remoteApiToken },
    orgId: storageOrgId,
    mappings: {
      userMappings: userMappings?.mappings || userMappings || {},
      fieldMappings: fieldMappings || {},
      statusMappings: statusMappings || {},
      issueTypeMappings: issueTypeMappings || {}
    },
    syncOptions: syncOptions || {},
    userMappingConfig: userMappings?.config || { autoMapUsers: true, fallbackUser: null }
  };

  const { issue } = payload;
  
  if (!issue) {
      if (isAttachmentEvent(webhookEvent)) {
        console.log(`${LOG_EMOJI.WARNING} Attachment webhook missing issue payload. Keys: ${Object.keys(payload).join(', ')}`);
      } else {
        return { status: 400, body: { error: 'No issue in payload' } };
      }
  }

  // 2. Route Event
  try {
    if (webhookEvent === 'jira:issue_created') {
      await handleRemoteIssueCreated(issue, context);
    } else if (webhookEvent === 'jira:issue_updated') {
      await handleRemoteIssueUpdated(issue, context, payload);
    } else if (webhookEvent === 'jira:issue_deleted') {
      await handleRemoteIssueDeleted(issue, context);
    } else if (webhookEvent === 'comment_created') {
      await handleRemoteCommentCreated(payload, context);
    } else if (webhookEvent === 'jira:issue_link_created' || webhookEvent === 'jira:issue_link_deleted') {
      console.log(`ℹ️ Inbound link sync coming soon: ${webhookEvent}`);
    } else if (webhookEvent === 'attachment_created' || webhookEvent === 'jira:attachment_created') {
        console.log(`${LOG_EMOJI.ATTACHMENT} Routing attachment event for ${payload.issue?.key || 'unknown issue'}`);
      await handleRemoteAttachmentCreated(payload, context);
    } else if (webhookEvent === 'attachment_deleted' || webhookEvent === 'jira:attachment_deleted') {
      console.log(`ℹ️ Inbound attachment deletion coming soon`);
    } else {
      console.log(`ℹ️ Ignoring event: ${webhookEvent}`);
    }
    
    return { status: 200, body: { message: 'Processed' } };
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error processing incoming webhook:`, error);
    return { status: 500, body: { error: error.message } };
  }
}

async function handleRemoteIssueCreated(remoteIssue, context) {
  const { org, orgId } = context;
  console.log(`${LOG_EMOJI.SYNC} Received remote issue create: ${remoteIssue.key}`);

  const existingLocalKey = await getLocalKey(remoteIssue.key, orgId);
  if (existingLocalKey) {
    console.log(`ℹ️ Issue ${remoteIssue.key} already mapped to ${existingLocalKey}. Treating as update.`);
    return handleRemoteIssueUpdated(remoteIssue, context);
  }

  const targetProject = Array.isArray(org.allowedProjects) && org.allowedProjects.length > 0
    ? org.allowedProjects[0]
    : null;

  if (!targetProject) {
    throw new Error(`No allowed local project configured for org ${org.name}`);
  }

  const resolvedRemoteIssue = await loadRemoteIssue(remoteIssue, context);
  if (!resolvedRemoteIssue) {
    throw new Error(`Unable to load remote issue ${remoteIssue.key} for creation`);
  }

  const payload = await buildCreatePayload(resolvedRemoteIssue, targetProject, context);

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

  console.log(`${LOG_EMOJI.SUCCESS} Created local issue ${localKey} from remote ${remoteIssue.key}`);

  await storeMapping(localKey, remoteIssue.key, orgId);

  // Sync attachments if present
  if (resolvedRemoteIssue.fields.attachment && resolvedRemoteIssue.fields.attachment.length > 0) {
    console.log(`${LOG_EMOJI.ATTACHMENT} Syncing ${resolvedRemoteIssue.fields.attachment.length} attachments for new issue...`);
    
    for (const attachment of resolvedRemoteIssue.fields.attachment) {
      try {
        if (attachment.size > MAX_ATTACHMENT_SIZE) {
          console.log(`${LOG_EMOJI.WARNING} Skipping attachment ${attachment.filename} - too large`);
          continue;
        }

        const auth = Buffer.from(`${context.org.remoteEmail}:${context.org.remoteApiToken}`).toString('base64');
        const downloadResponse = await fetch(attachment.content, {
          headers: {
            'Authorization': `Basic ${auth}`,
            'Accept': '*/*'
          }
        });

        if (!downloadResponse.ok) {
          console.error(`${LOG_EMOJI.ERROR} Failed to download remote attachment ${attachment.filename}: ${downloadResponse.status}`);
          continue;
        }

        const buffer = Buffer.from(await downloadResponse.arrayBuffer());
        const uploaded = await uploadAttachment(localKey, attachment.filename, buffer);

        if (uploaded) {
          await storeAttachmentMapping(uploaded.id, attachment.id, orgId);
          console.log(`${LOG_EMOJI.SUCCESS} Synced attachment ${attachment.filename}`);
        }
      } catch (error) {
        console.error(`${LOG_EMOJI.ERROR} Error syncing attachment ${attachment.filename}:`, error);
      }
    }
  }
}

async function handleRemoteIssueUpdated(remoteIssue, context, payload = null) {
  const { org, orgId, mappings } = context;
  const localKey = await getLocalKey(remoteIssue.key, orgId);
  if (!localKey) {
    console.log(`⚠️ Remote issue ${remoteIssue.key} not mapped. Ignoring update.`);
    return;
  }

  if (payload && shouldSkipUpdateForAttachmentOnly(payload)) {
    console.log(`${LOG_EMOJI.INFO} Skipping field update for ${localKey}; changelog contains attachment changes only.`);
    if (payload?.changelog?.items) {
      await recordAttachmentIssueMappingFromChangelog(payload.changelog.items, remoteIssue.key, context.orgId);
      console.log(`${LOG_EMOJI.INFO} Attachment changelog items: ${JSON.stringify(payload.changelog.items)}`);
    }
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
    const resolvedRemoteIssue = await loadRemoteIssue(remoteIssue, context);
    if (!resolvedRemoteIssue) {
      console.log(`${LOG_EMOJI.WARNING} Could not fetch remote issue ${remoteIssue.key}. Skipping update.`);
      return;
    }

    const payload = await buildUpdatePayload(resolvedRemoteIssue, context);
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

    if (resolvedRemoteIssue.fields?.status) {
      await transitionLocalIssue(localKey, resolvedRemoteIssue.fields.status, mappings.statusMappings);
    }
  } finally {
    await clearSyncFlag(localKey);
  }
}

async function handleRemoteIssueDeleted(remoteIssue, context) {
  const localKey = await getLocalKey(remoteIssue.key, context.orgId);
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

async function handleRemoteCommentCreated(payload, context) {
  if (!shouldSyncIncomingComments(context.syncOptions)) {
    console.log(`⏭️ Incoming comments disabled for ${context.org.name}`);
    return;
  }

  const remoteIssueKey = payload.issue?.key;
  const comment = payload.comment;

  if (!remoteIssueKey || !comment) {
    console.log(`${LOG_EMOJI.WARNING} Comment event missing issue or comment data`);
    return;
  }

  if (comment.author?.accountType === 'app') {
    console.log(`${LOG_EMOJI.INFO} Skipping SyncApp-authored comment ${comment.id} on ${remoteIssueKey}`);
    return;
  }

  if (isSyncAppComment(comment.body, context.org.name)) {
    console.log(`${LOG_EMOJI.INFO} Skipping comment from SyncApp to avoid loops`);
    return;
  }

  const localKey = await getLocalKey(remoteIssueKey, context.orgId);
  if (!localKey) {
    console.log(`${LOG_EMOJI.WARNING} No local mapping for remote comment on ${remoteIssueKey}`);
    return;
  }

  const dedupKey = buildIncomingCommentKey(context.orgId, comment.id);
  const alreadyProcessed = await kvsStore.get(dedupKey);
  if (alreadyProcessed) {
    console.log(`${LOG_EMOJI.INFO} Comment ${comment.id} already processed, skipping duplicate event`);
    return;
  }

  const authorName = comment.author?.displayName || comment.author?.emailAddress || 'Unknown User';
  let commentText = '';
  if (comment.body && typeof comment.body === 'object') {
    commentText = extractTextFromADF(comment.body);
  } else {
    commentText = comment.body || '';
  }

  const body = textToADFWithAuthor(commentText, context.org.name, authorName);

  await markSyncing(localKey);
  try {
    const response = await api.asApp().requestJira(route`/rest/api/3/issue/${localKey}/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body })
    });

    if (response.ok) {
      console.log(`${LOG_EMOJI.COMMENT} Synced comment from ${remoteIssueKey} to ${localKey}`);
      await kvsStore.set(dedupKey, { processedAt: new Date().toISOString() });
    } else {
      const err = await response.text();
      console.error(`${LOG_EMOJI.ERROR} Failed to sync incoming comment: ${err}`);
    }
  } finally {
    await clearSyncFlag(localKey);
  }
}

function shouldSyncIncomingComments(syncOptions) {
  if (!syncOptions) {
    return true;
  }
  if (typeof syncOptions.incomingComments === 'boolean') {
    return syncOptions.incomingComments;
  }
  if (typeof syncOptions.syncComments === 'boolean') {
    return syncOptions.syncComments;
  }
  return true;
}

function isSyncAppComment(body, orgName) {
  if (!body) {
    return false;
  }
  let text = '';
  if (typeof body === 'object') {
    text = extractTextFromADF(body);
  } else if (typeof body === 'string') {
    text = body;
  }

  return text.includes('[Comment from ') && text.includes(' - User: SyncApp') && text.includes(orgName);
}

function buildIncomingCommentKey(orgId, commentId) {
  const prefix = orgId || 'legacy';
  return `${prefix}:incoming-comment:${commentId}`;
}

async function buildCreatePayload(remoteIssue, targetProjectKey, context) {
  const remoteFields = remoteIssue.fields || {};
  const fields = {
    project: { key: targetProjectKey },
    summary: remoteFields.summary,
    description: normalizeDescription(remoteFields.description),
    issuetype: determineLocalIssueType(remoteFields.issuetype, context.mappings.issueTypeMappings)
  };

  applyCommonFieldMirroring(fields, remoteFields, context);
  applyCustomFieldMappings(fields, remoteFields, context.mappings.fieldMappings);
  await applyParentMapping(fields, remoteFields, context);

  return { fields };
}

async function buildUpdatePayload(remoteIssue, context) {
  const remoteFields = remoteIssue.fields || {};
  const fields = {
    summary: remoteFields.summary,
    description: normalizeDescription(remoteFields.description)
  };

  const issueType = determineLocalIssueType(remoteFields.issuetype, context.mappings.issueTypeMappings);
  if (issueType) {
    fields.issuetype = issueType;
  }

  applyCommonFieldMirroring(fields, remoteFields, context);
  applyCustomFieldMappings(fields, remoteFields, context.mappings.fieldMappings);
  await applyParentMapping(fields, remoteFields, context);

  // Ensure attachment field is never sent in update payload
  if (fields.attachment) {
    delete fields.attachment;
  }

  console.log(`📦 Update payload fields: ${Object.keys(fields).join(', ')}`);

  return { fields };
}

async function loadRemoteIssue(remoteIssue, context) {
  const fieldList = buildRemoteFieldList(context.mappings.fieldMappings);
  const fetched = await getRemoteIssue(remoteIssue.key, context.org, fieldList);
  if (fetched && fetched.fields) {
    return fetched;
  }

  console.log(`${LOG_EMOJI.WARNING} Falling back to webhook payload for ${remoteIssue.key}`);
  return remoteIssue;
}

function buildRemoteFieldList(fieldMappings) {
  const fields = new Set(BASE_REMOTE_FIELDS);
  for (const key of Object.keys(fieldMappings || {})) {
    if (key) {
      fields.add(key);
    }
  }
  return Array.from(fields);
}

function determineLocalIssueType(remoteIssueType, issueTypeMappings) {
  if (!remoteIssueType) {
    return { name: 'Task' };
  }

  if (issueTypeMappings) {
    const mapping = issueTypeMappings[remoteIssueType.id] || Object.values(issueTypeMappings).find(m => m.remoteName === remoteIssueType.name);
    if (mapping) {
      if (mapping.localId) {
        return { id: mapping.localId };
      }
      if (mapping.localName) {
        return { name: mapping.localName };
      }
    }
  }

  return { name: remoteIssueType.name || 'Task' };
}

function normalizeDescription(value) {
  if (!value) {
    return textToADF('');
  }
  if (typeof value === 'object') {
    const cloned = JSON.parse(JSON.stringify(value));
    const sanitized = stripMediaNodes(cloned);
    if (!sanitized || !Array.isArray(sanitized.content) || sanitized.content.length === 0) {
      return textToADF('');
    }
    return sanitized;
  }
  if (typeof value === 'string') {
    return textToADF(value);
  }
  return textToADF('');
}

function stripMediaNodes(adfNode) {
  if (!adfNode || typeof adfNode !== 'object') {
    return adfNode;
  }

  // Remove media-related nodes entirely
  const mediaTypes = new Set(['media', 'mediaSingle', 'mediaGroup']);
  if (mediaTypes.has(adfNode.type)) {
    return null;
  }

  if (Array.isArray(adfNode.content)) {
    const cleaned = adfNode.content
      .map(child => stripMediaNodes(child))
      .filter(child => child !== null);
    adfNode.content = cleaned;
  }

  return adfNode;
}

function applyCommonFieldMirroring(targetFields, remoteFields, context) {
  if (remoteFields.priority) {
    targetFields.priority = { name: remoteFields.priority.name };
  }

  if ('labels' in remoteFields) {
    targetFields.labels = Array.isArray(remoteFields.labels) ? [...remoteFields.labels] : [];
  }

  if ('duedate' in remoteFields) {
    targetFields.duedate = remoteFields.duedate || null;
  }

  if ('components' in remoteFields) {
    const components = remoteFields.components || [];
    targetFields.components = components.map(component => ({ name: component.name }));
  }

  if ('fixVersions' in remoteFields) {
    const versions = remoteFields.fixVersions || [];
    targetFields.fixVersions = versions.map(version => ({ name: version.name }));
  }

  if ('versions' in remoteFields) {
    const versions = remoteFields.versions || [];
    targetFields.versions = versions.map(version => ({ name: version.name }));
  }

  if (remoteFields.timetracking && Object.keys(remoteFields.timetracking).length > 0) {
    targetFields.timetracking = deepClone(remoteFields.timetracking);
  }

  if ('assignee' in remoteFields) {
    if (remoteFields.assignee === null) {
      targetFields.assignee = null;
    } else if (remoteFields.assignee?.accountId) {
      const mapped = mapUserToLocal(remoteFields.assignee.accountId, context.mappings.userMappings);
      if (mapped) {
        targetFields.assignee = { accountId: mapped };
      }
      else {
        console.log(`${LOG_EMOJI.WARNING} No local mapping for remote assignee ${remoteFields.assignee.accountId}`);
      }
    }
  }

  if ('reporter' in remoteFields) {
    if (remoteFields.reporter === null) {
      targetFields.reporter = null;
    } else if (remoteFields.reporter?.accountId) {
      const mapped = mapUserToLocal(remoteFields.reporter.accountId, context.mappings.userMappings);
      if (mapped) {
        targetFields.reporter = { accountId: mapped };
      }
      else {
        console.log(`${LOG_EMOJI.WARNING} No local mapping for remote reporter ${remoteFields.reporter.accountId}`);
      }
    }
  }
}

function applyCustomFieldMappings(targetFields, remoteFields, fieldMappings) {
  if (!fieldMappings) {
    return;
  }

  for (const [remoteFieldId, mapping] of Object.entries(fieldMappings)) {
    const localFieldId = typeof mapping === 'string' ? mapping : mapping.localId;
    if (!localFieldId || BLOCKED_FIELD_KEYS.has(localFieldId) || localFieldId === 'attachment') {
      continue;
    }

    if (!(remoteFieldId in remoteFields)) {
      continue;
    }

    const value = remoteFields[remoteFieldId];
    if (value === undefined) {
      continue;
    }

     if (isRankLikeString(value) || containsRankMetadata(value)) {
       console.log(`⏭️ Skipping rank-like field ${remoteFieldId} → ${localFieldId}`);
       continue;
     }

    if (isAttachmentLikeValue(value)) {
      console.log(`${LOG_EMOJI.WARNING} Skipping attachment-like field ${remoteFieldId} → ${localFieldId}`);
      continue;
    }

    targetFields[localFieldId] = deepClone(value);
  }
}

function deepClone(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    console.log(`${LOG_EMOJI.WARNING} Could not deep clone field value, passing by reference`);
    return value;
  }
}

function isRankLikeString(value) {
  return typeof value === 'string' && /^\d+\|[A-Za-z0-9]+:/.test(value);
}

function containsRankMetadata(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some(item => containsRankMetadata(item));
  }

  return value.rankBeforeIssue !== undefined || value.rankAfterIssue !== undefined || value.lexoRank !== undefined;
}

function isAttachmentLikeValue(value) {
  if (!value) {
    return false;
  }

  const looksLikeAttachment = (candidate) => {
    return (
      candidate &&
      typeof candidate === 'object' &&
      typeof candidate.filename === 'string' &&
      (candidate.content !== undefined || candidate.mimeType !== undefined || candidate.size !== undefined)
    );
  };

  if (Array.isArray(value)) {
    return value.length > 0 && value.every(looksLikeAttachment);
  }

  return looksLikeAttachment(value);
}

async function applyParentMapping(targetFields, remoteFields, context) {
  if (!('parent' in remoteFields)) {
    return;
  }

  if (remoteFields.parent === null) {
    targetFields.parent = null;
    return;
  }

  const parentKey = remoteFields.parent?.key;
  if (!parentKey) {
    return;
  }

  const localParentKey = await getLocalKey(parentKey, context.orgId);
  if (localParentKey) {
    targetFields.parent = { key: localParentKey };
    console.log(`${LOG_EMOJI.LINK} Mapped parent ${parentKey} → ${localParentKey}`);
  } else {
    console.log(`${LOG_EMOJI.WARNING} Parent ${parentKey} not synced locally yet - child will be standalone`);
  }
}

async function handleRemoteAttachmentCreated(payload, context) {
  console.log(`${LOG_EMOJI.ATTACHMENT} Handling attachment_created event for ${payload.issue?.key || 'unknown issue'} (attachment ${payload.attachment?.id || 'unknown'})`);
  
  if (!shouldSyncIncomingAttachments(context.syncOptions)) {
    console.log(`⏭️ Incoming attachments disabled for ${context.org.name}`);
    return;
  }

  const attachment = payload.attachment;
  let remoteIssueKey = payload.issue?.key;

  if (!attachment) {
    console.log(`${LOG_EMOJI.WARNING} Attachment event missing attachment data. Keys: ${Object.keys(payload).join(', ')}`);
    return;
  }

  if (!remoteIssueKey && payload?.changelog?.items) {
    await recordAttachmentIssueMappingFromChangelog(payload.changelog.items, remoteIssue?.key || null, context.orgId);
  }

  if (!remoteIssueKey) {
    remoteIssueKey = await waitForAttachmentIssueKey(attachment.id, context.orgId);
  }

  if (!remoteIssueKey) {
    console.log(`${LOG_EMOJI.ERROR} Could not determine remote issue key for attachment ${attachment.id}`);
    console.log(`${LOG_EMOJI.INFO} Attachment payload: ${JSON.stringify(attachment)}`);
    return;
  }

  const localKey = await getLocalKey(remoteIssueKey, context.orgId);
  if (!localKey) {
    console.log(`${LOG_EMOJI.WARNING} No local mapping for remote attachment on ${remoteIssueKey}`);
    return;
  }

  console.log(`${LOG_EMOJI.INFO} Local issue for ${remoteIssueKey} resolved to ${localKey}`);

  // Check if already synced
  const existingMapping = await getAttachmentMapping(attachment.id, context.orgId);
  if (existingMapping) {
    console.log(`${LOG_EMOJI.SKIP} Attachment ${attachment.filename} already synced (mapping exists)`);
    return;
  }

  console.log(`${LOG_EMOJI.INFO} Attachment ${attachment.filename} (${attachment.size} bytes) not mapped yet; proceeding with download`);

  // Check file size
  if (attachment.size > MAX_ATTACHMENT_SIZE) {
    console.log(`${LOG_EMOJI.WARNING} Skipping attachment ${attachment.filename} - too large (${(attachment.size / 1024 / 1024).toFixed(2)} MB)`);
    return;
  }

  console.log(`${LOG_EMOJI.ATTACHMENT} Syncing incoming attachment ${attachment.filename} (${attachment.size} bytes)`);

  await markSyncing(localKey);
  try {
    // 1. Download from Remote
    console.log(`⬇️ Downloading from: ${attachment.content}`);
    const auth = Buffer.from(`${context.org.remoteEmail}:${context.org.remoteApiToken}`).toString('base64');
    const downloadResponse = await fetch(attachment.content, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': '*/*'
      }
    });

    console.log(`⬇️ Download status: ${downloadResponse.status}`);

    if (!downloadResponse.ok) {
      console.error(`${LOG_EMOJI.ERROR} Failed to download remote attachment: ${downloadResponse.status}`);
      return;
    }

    const arrayBuffer = await downloadResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    console.log(`⬇️ Downloaded ${buffer.length} bytes`);

    // 2. Upload to Local
    console.log(`⬆️ Uploading to local issue ${localKey}...`);
    const uploadedAttachment = await uploadAttachment(localKey, attachment.filename, buffer);

    if (uploadedAttachment) {
      console.log(`${LOG_EMOJI.SUCCESS} Synced attachment ${attachment.filename} to ${localKey}`);
      // Store mapping: Remote ID -> Local ID (Note: getAttachmentMapping usually expects Local ID -> Remote ID, 
      // but for inbound we might need to store it differently or just rely on the fact that we check by Remote ID here?
      // Actually, storeAttachmentMapping stores localAttachmentId -> remoteAttachmentId.
      // So we should store uploadedAttachment.id -> attachment.id
      await storeAttachmentMapping(uploadedAttachment.id, attachment.id, context.orgId);
    } else {
      console.error(`${LOG_EMOJI.ERROR} Failed to upload attachment to local issue`);
    }

  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error syncing incoming attachment:`, error);
  } finally {
    await clearSyncFlag(localKey);
    await deleteAttachmentIssueMapping(attachment.id, context.orgId);
  }
}


function buildAttachmentIssueCacheKey(attachmentId, orgId) {
  const prefix = orgId || 'legacy';
  return `${prefix}:incoming-attachment:${attachmentId}`;
}

async function recordAttachmentIssueMappingFromChangelog(items, remoteIssueKey, orgId) {
  if (!Array.isArray(items) || !remoteIssueKey) {
    return;
  }

  const operations = [];
  for (const item of items) {
    if ((item.field || '').toLowerCase() !== 'attachment') {
      continue;
    }
    const attachmentId = item.to;
    if (!attachmentId) {
      continue;
    }
    const key = buildAttachmentIssueCacheKey(attachmentId, orgId);
    operations.push(kvsStore.set(key, { issueKey: remoteIssueKey, expiresAt: Date.now() + ATTACHMENT_ISSUE_CACHE_TTL_MS }));
    console.log(`${LOG_EMOJI.INFO} Cached attachment ${attachmentId} → ${remoteIssueKey}`);
  }

  if (operations.length > 0) {
    await Promise.all(operations);
  }
}

async function getCachedAttachmentIssueKey(attachmentId, orgId) {
  if (!attachmentId) {
    return null;
  }
  const key = buildAttachmentIssueCacheKey(attachmentId, orgId);
  const record = await kvsStore.get(key);
  if (!record) {
    return null;
  }
  if (record.expiresAt && record.expiresAt < Date.now()) {
    await kvsStore.del(key);
    return null;
  }
  return record.issueKey || null;
}

async function waitForAttachmentIssueKey(attachmentId, orgId) {
  for (let attempt = 1; attempt <= ATTACHMENT_ISSUE_CACHE_RETRY_ATTEMPTS; attempt++) {
    const cachedKey = await getCachedAttachmentIssueKey(attachmentId, orgId);
    if (cachedKey) {
      if (attempt === 1) {
        console.log(`${LOG_EMOJI.INFO} Resolved ${attachmentId} → ${cachedKey} from changelog cache`);
      } else {
        const waitedMs = (attempt - 1) * ATTACHMENT_ISSUE_CACHE_RETRY_DELAY_MS;
        console.log(`${LOG_EMOJI.INFO} Resolved ${attachmentId} → ${cachedKey} from changelog cache after waiting ${waitedMs}ms`);
      }
      return cachedKey;
    }

    if (attempt < ATTACHMENT_ISSUE_CACHE_RETRY_ATTEMPTS) {
      console.log(`${LOG_EMOJI.INFO} Waiting for attachment ${attachmentId} cache entry (attempt ${attempt}/${ATTACHMENT_ISSUE_CACHE_RETRY_ATTEMPTS})`);
      await sleep(ATTACHMENT_ISSUE_CACHE_RETRY_DELAY_MS);
    }
  }

  return null;
}

async function deleteAttachmentIssueMapping(attachmentId, orgId) {
  if (!attachmentId) {
    return;
  }
  const key = buildAttachmentIssueCacheKey(attachmentId, orgId);
  await kvsStore.del(key);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shouldSyncIncomingAttachments(syncOptions) {
  if (!syncOptions) {
    return true;
  }
  if (typeof syncOptions.incomingAttachments === 'boolean') {
    return syncOptions.incomingAttachments;
  }
  if (typeof syncOptions.syncAttachments === 'boolean') {
    return syncOptions.syncAttachments;
  }
  return true;
}

function shouldSkipUpdateForAttachmentOnly(payload) {
  const items = payload?.changelog?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return false;
  }

  return items.every(item => {
    const fieldName = item?.field?.toLowerCase?.();
    return fieldName === 'attachment';
  });
}

function isAttachmentEvent(webhookEvent) {
  return webhookEvent === 'attachment_created' || webhookEvent === 'jira:attachment_created' ||
         webhookEvent === 'attachment_deleted' || webhookEvent === 'jira:attachment_deleted';
}
