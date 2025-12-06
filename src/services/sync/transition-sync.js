import api, { fetch, route } from '@forge/api';
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

export async function transitionLocalIssue(localKey, remoteStatus, statusMappings, syncResult = null) {
  if (!remoteStatus) {
    return false;
  }

  const target = resolveLocalStatusTarget(remoteStatus, statusMappings);
  if (!target.name && !target.id) {
    console.log(`${LOG_EMOJI.WARNING} No local status target mapped for remote status: ${remoteStatus.name || remoteStatus.id}`);
    return false;
  }

  console.log(`${LOG_EMOJI.STATUS} Attempting to transition ${localKey} to status: ${target.name || remoteStatus.name}`);

  try {
    const transitionsResponse = await api.asApp().requestJira(
      route`/rest/api/3/issue/${localKey}/transitions`,
      { method: 'GET' }
    );

    if (!transitionsResponse.ok) {
      const err = await transitionsResponse.text();
      console.error(`${LOG_EMOJI.ERROR} Failed to fetch local transitions for ${localKey}: ${err}`);
      return false;
    }

    const transitions = await transitionsResponse.json();
    let transition = null;

    if (target.id) {
      transition = transitions.transitions.find(t => t.to.id === target.id);
    }

    if (!transition && target.name) {
      transition = transitions.transitions.find(t => t.to.name.toLowerCase() === target.name.toLowerCase());
    }

    if (!transition && remoteStatus.name) {
      transition = transitions.transitions.find(t => t.to.name.toLowerCase() === remoteStatus.name.toLowerCase());
    }

    if (!transition) {
      console.error(`${LOG_EMOJI.ERROR} No local transition found for ${localKey} to ${target.name || remoteStatus.name}`);
      if (syncResult) syncResult.addTransitionFailure(target.name || remoteStatus.name, 'No transition available');
      return false;
    }

    const payload = {
      transition: { id: transition.id }
    };

    const response = await api.asApp().requestJira(
      route`/rest/api/3/issue/${localKey}/transitions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );

    if (response.ok || response.status === HTTP_STATUS.NO_CONTENT) {
      console.log(`${LOG_EMOJI.SUCCESS} Transitioned ${localKey} to ${transition.to.name}`);
      if (syncResult) syncResult.addTransitionSuccess(transition.to.name);
      return true;
    }

    const err = await response.text();
    console.error(`${LOG_EMOJI.ERROR} Failed to transition ${localKey}: ${err}`);
    if (syncResult) syncResult.addTransitionFailure(transition.to.name, err);
    return false;
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error transitioning local issue ${localKey}:`, error);
    if (syncResult) syncResult.addTransitionFailure(target.name || remoteStatus.name, error.message);
    return false;
  }
}

function resolveLocalStatusTarget(remoteStatus, statusMappings) {
  if (!remoteStatus) {
    return { name: null, id: null };
  }

  const directMatch = statusMappings?.[remoteStatus.id];
  if (directMatch) {
    return {
      id: directMatch.localId || null,
      name: directMatch.localName || null
    };
  }

  if (statusMappings) {
    const fallback = Object.values(statusMappings).find(mapping => mapping.remoteName === remoteStatus.name);
    if (fallback) {
      return {
        id: fallback.localId || null,
        name: fallback.localName || null
      };
    }
  }

  return { name: remoteStatus.name || null, id: null };
}
