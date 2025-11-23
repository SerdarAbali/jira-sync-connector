import api, { route } from '@forge/api';

export async function getFullIssue(issueKey) {
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

export async function getFullComment(issueKey, commentId) {
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

export async function getOrgName() {
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
