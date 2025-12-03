import { fetch } from '@forge/api';
import { LOG_EMOJI, HTTP_STATUS } from '../../constants.js';
import { retryWithBackoff } from '../../utils/retry.js';
import { reverseMapping } from '../../utils/mapping.js';

export async function transitionRemoteIssue(remoteKey, statusName, config, statusMappings, syncResult = null) {
  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
  const reversedStatusMap = reverseMapping(statusMappings);

  console.log(`${LOG_EMOJI.STATUS} Attempting to transition ${remoteKey} to status: ${statusName}`);
  
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
      console.error(`❌ Failed to fetch transitions for ${remoteKey}: ${transitionsResponse.status}`);
      return false;
    }
    
    const transitions = await transitionsResponse.json();
    console.log(`Available transitions for ${remoteKey}:`, transitions.transitions.map(t => `${t.name} (${t.to.name})`).join(', '));
    
    let transition = transitions.transitions.find(t => 
      t.to.name.toLowerCase() === statusName.toLowerCase()
    );
    
    if (!transition && reversedStatusMap[statusName]) {
      const mappedStatusId = reversedStatusMap[statusName];
      console.log(`Trying mapped status ID: ${mappedStatusId}`);
      transition = transitions.transitions.find(t => t.to.id === mappedStatusId);
    }

    if (!transition) {
      const errorMsg = `No transition found to status: ${statusName}. Available: ${transitions.transitions.map(t => t.to.name).join(', ')}`;
      console.error(`${LOG_EMOJI.ERROR} ${errorMsg}`);
      if (syncResult) syncResult.addTransitionFailure(statusName, errorMsg);
      return false;
    }

    console.log(`Using transition: ${transition.name} → ${transition.to.name}`);

    const transitionResponse = await retryWithBackoff(async () => {
      return await fetch(
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
    }, `Transition ${remoteKey} to ${statusName}`);

    if (transitionResponse.ok || transitionResponse.status === HTTP_STATUS.NO_CONTENT) {
      console.log(`${LOG_EMOJI.SUCCESS} Transitioned ${remoteKey} to ${transition.to.name}`);
      if (syncResult) syncResult.addTransitionSuccess(transition.to.name);
      return true;
    } else {
      const errorText = await transitionResponse.text();
      console.error(`${LOG_EMOJI.ERROR} Transition failed: ${errorText}`);
      if (syncResult) syncResult.addTransitionFailure(statusName, errorText);
      return false;
    }
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error transitioning issue:`, error);
    if (syncResult) syncResult.addTransitionFailure(statusName, error.message);
    return false;
  }
}
