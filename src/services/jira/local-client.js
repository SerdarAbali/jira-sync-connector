import api, { route } from '@forge/api';

export async function getFullIssue(issueKey) {
  try {
    const response = await api.asApp().requestJira(
      route`/rest/api/3/issue/${issueKey}?expand=renderedFields,attachment&fields=*all,-comment`
    );
    if (!response.ok) {
      console.error(`Failed to fetch issue ${issueKey}: ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error('Error fetching issue:', error);
    return null;
  }
}

export async function getFullComment(issueKey, commentId) {
  try {
    const response = await api.asApp().requestJira(
      route`/rest/api/3/issue/${issueKey}/comment/${commentId}`
    );
    if (!response.ok) {
      console.error(`Failed to fetch comment ${commentId} for issue ${issueKey}: ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error('Error fetching comment:', error);
    return null;
  }
}

export async function getOrgName() {
  try {
    const response = await api.asApp().requestJira(
      route`/rest/api/3/serverInfo`
    );
    if (!response.ok) {
      console.error(`Failed to fetch server info: ${response.status}`);
      return 'Jira';
    }
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

export async function downloadAttachment(attachmentUrl) {
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

export async function updateLocalIssueDescription(issueKey, description) {
  try {
    const response = await api.asApp().requestJira(
      route`/rest/api/3/issue/${issueKey}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fields: {
            description: description
          }
        })
      }
    );
    
    if (response.ok || response.status === 204) {
      console.log(`✅ Updated local issue ${issueKey} description`);
      return true;
    } else {
      const errorText = await response.text();
      console.error(`❌ Failed to update local issue ${issueKey}: ${errorText}`);
      return false;
    }
  } catch (error) {
    console.error(`Error updating local issue ${issueKey}:`, error);
    return false;
  }
}

export async function uploadAttachment(issueKey, filename, fileBuffer) {
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
    
    const response = await api.asApp().requestJira(
      route`/rest/api/3/issue/${issueKey}/attachments`,
      {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'X-Atlassian-Token': 'no-check'
        },
        body: body
      }
    );
    
    if (!response.ok) {
      console.error(`Failed to upload attachment to local issue ${issueKey}: ${response.status}`);
      return null;
    }
    
    const result = await response.json();
    // Result is an array of uploaded attachments
    return result[0];
  } catch (error) {
    console.error('Error uploading attachment to local issue:', error);
    return null;
  }
}
