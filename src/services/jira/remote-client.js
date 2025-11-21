import { fetch } from '@forge/api';
import { retryWithBackoff } from '../../utils/retry.js';
import { LOG_EMOJI } from '../../constants.js';

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
      const result = await response.json();
      console.log(`${LOG_EMOJI.SUCCESS} Uploaded attachment: ${filename}`);
      return result[0]?.id || null; // Return the remote attachment ID
    } else {
      const errorText = await response.text();
      console.error(`❌ Failed to upload attachment ${filename}:`, errorText);
      return null;
    }
  } catch (error) {
    console.error(`Error uploading attachment ${filename}:`, error);
    return null;
  }
}
