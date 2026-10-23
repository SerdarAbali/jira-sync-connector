import { assertInboundScope, isInboundScopeError } from './inbound-scope.js';
import api, { fetch, route } from '../jira/guarded-api.js';
import { LOG_EMOJI, HTTP_STATUS } from '../../constants.js';
import { executeWriteOnce } from '../../utils/retry.js';
import { reverseMapping } from '../../utils/mapping.js';
import { formatHttpFailure } from '../../utils/http-error.js';
import { safeErrorSummary } from '../../utils/redaction.js';
import { assertPilotWritesAllowed } from './pilot-pause.js';

export async function transitionRemoteIssue(remoteKey, statusName, config, statusMappings, syncResult = null) {
  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
  const reversedStatusMap = reverseMapping(statusMappings);

  console.log('Checking remote status transition');
  
  try {
    // First, check current status to avoid unnecessary transitions
    const issueResponse = await fetch(
      `${config.remoteUrl}/rest/api/3/issue/${remoteKey}?fields=status`,
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    if (issueResponse.ok) {
      const issueData = await issueResponse.json();
      const currentStatus = issueData.fields?.status?.name;
      if (currentStatus && currentStatus.toLowerCase() === statusName.toLowerCase()) {
        console.log(`${LOG_EMOJI.SKIP} ${remoteKey} already in target status, skipping transition`);
        return true; // Already in target status, consider it a success
      }
      console.log(`${LOG_EMOJI.STATUS} ${remoteKey} status transition required`);
    }

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
    console.log(`Available transitions for ${remoteKey}: ${transitions.transitions.length}`);
    
    let transition = transitions.transitions.find(t => 
      t.to.name.toLowerCase() === statusName.toLowerCase()
    );
    
    if (!transition && reversedStatusMap[statusName]) {
      const mappedStatusId = reversedStatusMap[statusName];
      console.log(`Trying mapped status ID: ${mappedStatusId}`);
      transition = transitions.transitions.find(t => t.to.id === mappedStatusId);
    }

    if (!transition) {
      const errorMsg = 'No transition found for target status';
      console.error(`${LOG_EMOJI.ERROR} ${errorMsg}`);
      if (syncResult) syncResult.addTransitionFailure(statusName, errorMsg);
      return false;
    }

    console.log('Using mapped transition');
    await assertPilotWritesAllowed('transition_remote');

    const transitionResponse = await executeWriteOnce(async () => {
      return await fetch(
        `${config.remoteUrl}/rest/api/3/issue/${remoteKey}/transitions?notifyUsers=false`,
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
      console.log(`${LOG_EMOJI.SUCCESS} Transitioned ${remoteKey}`);
      if (syncResult) syncResult.addTransitionSuccess(transition.to.name);
      return true;
    } else {
      console.error(`${LOG_EMOJI.ERROR} Transition failed`);
      if (syncResult) syncResult.addTransitionFailure(statusName, formatHttpFailure(transitionResponse.status));
      return false;
    }
  } catch (error) {
    const safeFailure = safeErrorSummary(error.message);
    console.error(`${LOG_EMOJI.ERROR} Error transitioning issue: ${safeFailure}`);
    if (syncResult) syncResult.addTransitionFailure(statusName, safeFailure);
    return false;
  }
}

export async function transitionLocalIssue(localKey, remoteStatus, statusMappings, syncResult = null, scope = {}) {
  if (!remoteStatus) {
    return false;
  }

  const target = resolveLocalStatusTarget(remoteStatus, statusMappings);
  if (!target.name && !target.id) {
    console.log(`${LOG_EMOJI.WARNING} No local status target mapped`);
    return false;
  }

  const targetStatusName = target.name || remoteStatus.name;
  console.log('Checking local status transition');

  try {
    // First, check current status to avoid unnecessary transitions
    const issueResponse = await api.asApp().requestJira(
      route`/rest/api/3/issue/${localKey}?fields=status`,
      { method: 'GET' }
    );
    
    if (issueResponse.ok) {
      const issueData = await issueResponse.json();
      const currentStatus = issueData.fields?.status?.name;
      const currentStatusId = issueData.fields?.status?.id;
      
      // Check if already in target status (by name or id)
      const alreadyInTargetByName = currentStatus && targetStatusName && 
        currentStatus.toLowerCase() === targetStatusName.toLowerCase();
      const alreadyInTargetById = target.id && currentStatusId === target.id;
      
      if (alreadyInTargetByName || alreadyInTargetById) {
        console.log(`${LOG_EMOJI.SKIP} ${localKey} already in target status, skipping transition`);
        return true; // Already in target status, consider it a success
      }
      console.log(`${LOG_EMOJI.STATUS} ${localKey} status transition required`);
    }

    const transitionsResponse = await api.asApp().requestJira(
      route`/rest/api/3/issue/${localKey}/transitions`,
      { method: 'GET' }
    );

    if (!transitionsResponse.ok) {
      console.error(`${LOG_EMOJI.ERROR} Failed to fetch local transitions for ${localKey}`);
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
      console.error(`${LOG_EMOJI.ERROR} No local transition found for ${localKey}`);
      if (syncResult) syncResult.addTransitionFailure(target.name || remoteStatus.name, 'No transition available');
      return false;
    }

    const payload = {
      transition: { id: transition.id }
    };

    await assertPilotWritesAllowed('transition_local');
    await assertInboundScope({ orgId: scope.orgId, issueKeys: [localKey] });
    const response = await api.asApp().requestJira(
      route`/rest/api/3/issue/${localKey}/transitions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );

    if (response.ok || response.status === HTTP_STATUS.NO_CONTENT) {
      console.log(`${LOG_EMOJI.SUCCESS} Transitioned ${localKey}`);
      if (syncResult) syncResult.addTransitionSuccess(transition.to.name);
      return true;
    }

    console.error(`${LOG_EMOJI.ERROR} Failed to transition ${localKey}`);
    if (syncResult) syncResult.addTransitionFailure(transition.to.name, formatHttpFailure(response.status));
    return false;
  } catch (error) {
    if (isInboundScopeError(error)) throw error;
    const safeFailure = safeErrorSummary(error.message);
    console.error(`${LOG_EMOJI.ERROR} Error transitioning local issue ${localKey}: ${safeFailure}`);
    if (syncResult) syncResult.addTransitionFailure(target.name || remoteStatus.name, safeFailure);
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
