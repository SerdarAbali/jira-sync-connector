import { fetch } from '@forge/api';
import { retryWithBackoff } from '../../utils/retry.js';
import { LOG_EMOJI } from '../../constants.js';

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

    const errorText = await response.text();
    console.error(`${LOG_EMOJI.ERROR} Failed to get remote issue ${remoteKey}: ${errorText}`);
    return null;
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error getting remote issue ${remoteKey}:`, error);
    return null;
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
      return await response.json();
    } else {
      const errorText = await response.text();
      console.error(`Failed to upload attachment: ${errorText}`);
      return null;
    }
  } catch (error) {
    console.error(`Error uploading attachment ${filename}:`, error);
    return null;
  }
}
