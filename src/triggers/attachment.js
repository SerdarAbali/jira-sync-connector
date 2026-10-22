import api, { route } from '@forge/api';
import { getOrganizationsWithTokens, getRemoteKey } from '../services/storage/mappings.js';
import * as kvsStore from '../services/storage/kvs.js';
import { syncAttachments, propagateAttachmentDeletion } from '../services/sync/attachment-sync.js';
import { isValidAttachmentId } from '../utils/attachment-url.js';

async function loadLocalIssueForAttachment(issueId) {
  const normalized = issueId === undefined || issueId === null ? '' : String(issueId);
  if (!/^[0-9]{1,32}$/.test(normalized)) return null;
  try {
    const response = await api.asApp().requestJira(
      route`/rest/api/3/issue/${normalized}?fields=project,attachment`
    );
    if (!response.ok) return null;
    const issue = await response.json();
    return issue?.key ? issue : null;
  } catch {
    return null;
  }
}

/**
 * Local attachment events are intentionally isolated from the issue-update
 * path. The event contributes only an attachment ID and issue ID; all metadata
 * and content are reloaded through canonical Jira endpoints.
 */
export async function run(event) {
  const eventType = event?.eventType;
  const attachmentId = event?.attachment?.id;
  if (!isValidAttachmentId(attachmentId)) {
    return { success: false, code: 'INVALID_ATTACHMENT_ID' };
  }
  if (eventType !== 'avi:jira:created:attachment'
      && eventType !== 'avi:jira:deleted:attachment') {
    return { success: false, code: 'ATTACHMENT_EVENT_UNSUPPORTED' };
  }

  const issue = await loadLocalIssueForAttachment(event?.attachment?.issueId);
  if (!issue) {
    return { success: false, code: 'ATTACHMENT_ISSUE_UNRESOLVED' };
  }

  const projectKey = issue?.fields?.project?.key;
  const organizations = await getOrganizationsWithTokens();
  let processed = 0;

  for (const org of organizations) {
    const allowedProjects = Array.isArray(org.allowedProjects)
      ? org.allowedProjects.filter(Boolean)
      : [];
    if (!projectKey || !allowedProjects.includes(projectKey)) {
      continue;
    }

    const orgId = org.id === 'legacy' ? null : org.id;
    const remoteKey = await getRemoteKey(issue.key, orgId);
    if (!remoteKey) {
      continue;
    }

    const syncOptions = await kvsStore.get(
      orgId ? `syncOptions:${orgId}` : 'syncOptions'
    ) || {};

    try {
      if (eventType === 'avi:jira:created:attachment') {
        await syncAttachments(
          issue.key,
          remoteKey,
          issue,
          org,
          null,
          orgId,
          true,
          { syncOptions, attachmentIds: [String(attachmentId)] }
        );
        processed++;
      } else {
        const result = await propagateAttachmentDeletion({
          direction: 'local-to-remote',
          sourceAttachmentId: String(attachmentId),
          localKey: issue.key,
          remoteKey,
          config: org,
          orgId,
          syncOptions
        });
        if (result.status === 'ATTACHMENT_DELETE_COMPLETE'
            || result.status === 'ATTACHMENT_DELETE_ALREADY_COMPLETE') {
          processed++;
        }
      }
    } catch {
      console.warn('Attachment trigger operation deferred');
    }
  }

  return { success: true, processed };
}
