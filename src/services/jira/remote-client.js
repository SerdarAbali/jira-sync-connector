import { fetch } from '@forge/api';
import { readCommentJson, CommentVerificationDeferred } from './comment-read.js';
import { retryWithBackoff, executeWriteOnce } from '../../utils/retry.js';
import { LOG_EMOJI } from '../../constants.js';
import { buildCanonicalAttachmentUrl, buildAttachmentUploadUrl } from '../../utils/attachment-url.js';

export async function getRemoteIssue(remoteKey, config, fields = []) {
  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
  const url = new URL(`${config.remoteUrl}/rest/api/3/issue/${remoteKey}`);

  if (fields.length > 0) {
    url.searchParams.set('fields', fields.join(','));
  }

  try {
    const response = await retryWithBackoff(async () => {
      return await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Accept': 'application/json'
        }
      });
    }, `Get remote issue ${remoteKey}`);

    if (response.ok) {
      return await response.json();
    }

    console.error(`${LOG_EMOJI.ERROR} Failed to get remote issue ${remoteKey}`);
    return null;
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error getting remote issue ${remoteKey}:`, error);
    return null;
  }
}

/**
 * Read-only remote existence probe. Deliberately does not retry 404/401/403 so
 * the caller receives the real availability class immediately.
 */
export async function probeRemoteIssue(remoteKey, config) {
  if (!config?.remoteUrl || !config?.remoteEmail || !config?.remoteApiToken) {
    return { reachable: false, statusCode: null, reasonCode: 'MISSING_CONFIGURATION' };
  }
  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
  try {
    const response = await fetch(
      `${config.remoteUrl}/rest/api/3/issue/${remoteKey}?fields=key`,
      {
        method: 'GET',
        redirect: 'error',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Accept': 'application/json'
        }
      }
    );
    if (!response) {
      return { reachable: false, statusCode: null, reasonCode: 'EMPTY_RESPONSE' };
    }
    return {
      reachable: response.ok === true,
      statusCode: Number.isInteger(response.status) ? response.status : null,
      reasonCode: response.ok === true ? 'ACTIVE' : 'JIRA_HTTP_ERROR'
    };
  } catch {
    return { reachable: false, statusCode: null, reasonCode: 'NETWORK_ERROR' };
  }
}

export async function getRemoteIssueAttachments(remoteKey, config) {
  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
  
  try {
    const response = await retryWithBackoff(async () => {
      return await fetch(
        `${config.remoteUrl}/rest/api/3/issue/${remoteKey}?fields=attachment`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Accept': 'application/json'
          }
        }
      );
    }, `Get attachments for ${remoteKey}`);

    if (response.ok) {
      const issue = await response.json();
      return issue.fields.attachment || [];
    } else {
      console.error(`Failed to get attachments for ${remoteKey}`);
      return [];
    }
  } catch (error) {
    console.error(`Error getting remote attachments for ${remoteKey}:`, error);
    return [];
  }
}

export async function downloadRemoteAttachment(attachmentId, config) {
  if (!config?.remoteUrl) {
    console.error('Cannot download attachment: remote Jira origin is not configured');
    return null;
  }

  let url;
  try {
    url = buildCanonicalAttachmentUrl({
      jiraOrigin: config.remoteUrl,
      attachmentId
    });
  } catch {
    console.error('Cannot download attachment: invalid attachment reference');
    return null;
  }

  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');

  try {
    const response = await retryWithBackoff(async () => {
      return await fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Accept': '*/*'
        }
      });
    }, `Download attachment ${attachmentId}`);

    if (!response.ok) {
      console.error(`Failed to download attachment ${attachmentId}: ${response.status}`);
      return null;
    }

    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.error(`Error downloading attachment ${attachmentId}:`, error);
    return null;
  }
}

export async function uploadAttachment(remoteKey, filename, fileBuffer, config) {
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
    
    const response = await executeWriteOnce(async () => {
      return await fetch(
        buildAttachmentUploadUrl({ jiraOrigin: config.remoteUrl, issueKey: remoteKey }),
        {
          method: 'POST',
          redirect: 'error',
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
      const uploaded = Array.isArray(result) ? result[0] : result;
      if (uploaded?.id) {
        return uploaded.id;
      }
      console.error('Attachment upload response missing id field');
      return null;
    } else {
      console.error(`Failed to upload attachment`);
      return null;
    }
  } catch (error) {
    console.error('Error uploading attachment: operation_failed');
    return null;
  }
}

export async function getRemoteComment(issueKey, commentId, config, budget) {
  if (!issueKey || !commentId || !config) {
    throw new CommentVerificationDeferred();
  }

  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
  const url = `${config.remoteUrl}/rest/api/3/issue/${issueKey}/comment/${commentId}?expand=properties`;

  return await readCommentJson(() => fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Accept': 'application/json'
        }
      }), budget);
}
