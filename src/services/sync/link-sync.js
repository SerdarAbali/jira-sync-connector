import { fetch } from '@forge/api';
import { LOG_EMOJI } from '../../constants.js';
import { retryWithBackoff } from '../../utils/retry.js';
import { getLinkMapping, storeLinkMapping, getRemoteKey } from '../storage/mappings.js';
import { storePendingLink, removePendingLink } from '../storage/flags.js';

/**
 * Create a link between two issues on the remote Jira instance
 */
export async function createLinkOnRemote(config, sourceRemoteKey, targetRemoteKey, linkTypeName, direction) {
  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
  
  const linkPayload = {
    type: { name: linkTypeName }
  };

  if (direction === 'outward') {
    linkPayload.inwardIssue = { key: sourceRemoteKey };
    linkPayload.outwardIssue = { key: targetRemoteKey };
    console.log(`${LOG_EMOJI.LINK} Creating link: ${sourceRemoteKey} → ${targetRemoteKey} (${linkTypeName})`);
  } else {
    linkPayload.inwardIssue = { key: targetRemoteKey };
    linkPayload.outwardIssue = { key: sourceRemoteKey };
    console.log(`${LOG_EMOJI.LINK} Creating link: ${targetRemoteKey} → ${sourceRemoteKey} (${linkTypeName})`);
  }

  try {
    const response = await retryWithBackoff(async () => {
      return await fetch(
        `${config.remoteUrl}/rest/api/3/issueLink`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(linkPayload)
        }
      );
    }, `Create link ${linkTypeName} between ${sourceRemoteKey} and ${targetRemoteKey}`);

    if (response.ok || response.status === 201) {
      console.log(`${LOG_EMOJI.SUCCESS} Created issue link (${linkTypeName})`);
      return { success: true };
    } else {
      const errorText = await response.text();
      console.error(`${LOG_EMOJI.ERROR} Failed to create link: ${errorText}`);
      return { success: false, error: errorText };
    }
  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error creating link: ${error.message}`);
    return { success: false, error: error.message };
  }
}

export async function syncIssueLinks(localIssueKey, remoteIssueKey, issue, config, syncResult = null, orgId = null, forceCheck = false) {
  const result = { synced: 0, skipped: 0, failed: 0, pending: 0 };
  
  if (!issue.fields.issuelinks || issue.fields.issuelinks.length === 0) {
    console.log(`No issue links to sync for ${localIssueKey}`);
    return result;
  }

  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');

  console.log(`${LOG_EMOJI.LINK} Found ${issue.fields.issuelinks.length} issue link(s) on ${localIssueKey}`);

  // If forceCheck, get existing links on remote to verify they actually exist
  let remoteLinks = [];
  if (forceCheck) {
    try {
      const remoteIssueResponse = await fetch(
        `${config.remoteUrl}/rest/api/3/issue/${remoteIssueKey}?fields=issuelinks`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json'
          }
        }
      );
      if (remoteIssueResponse.ok) {
        const remoteIssue = await remoteIssueResponse.json();
        remoteLinks = remoteIssue.fields?.issuelinks || [];
        console.log(`${LOG_EMOJI.INFO} Remote issue ${remoteIssueKey} has ${remoteLinks.length} existing link(s)`);
      }
    } catch (e) {
      console.log(`${LOG_EMOJI.WARNING} Could not fetch remote links: ${e.message}`);
    }
  }

  for (const link of issue.fields.issuelinks) {
    try {
      // Check if already synced (org-specific)
      const existingMapping = await getLinkMapping(link.id, orgId);
      
      if (existingMapping && !forceCheck) {
        console.log(`${LOG_EMOJI.SKIP} Link ${link.id} already synced`);
        const linkedKey = link.outwardIssue?.key || link.inwardIssue?.key || 'unknown';
        if (syncResult) syncResult.addLinkSkipped(linkedKey, 'already synced');
        result.skipped++;
        continue;
      }

      const linkTypeName = link.type.name;
      let linkedIssueKey = null;
      let direction = null;

      // Determine linked issue and direction
      if (link.outwardIssue) {
        linkedIssueKey = link.outwardIssue.key;
        direction = 'outward';
      } else if (link.inwardIssue) {
        linkedIssueKey = link.inwardIssue.key;
        direction = 'inward';
      }

      if (!linkedIssueKey) {
        console.log(`${LOG_EMOJI.WARNING} No linked issue found for link ${link.id}`);
        if (syncResult) syncResult.addLinkSkipped('unknown', 'no linked issue found');
        result.skipped++;
        continue;
      }

      // Check if linked issue is synced (org-specific)
      const remoteLinkedKey = await getRemoteKey(linkedIssueKey, orgId);
      if (!remoteLinkedKey) {
        console.log(`${LOG_EMOJI.SKIP} Linked issue ${linkedIssueKey} not synced yet - storing as pending`);
        await storePendingLink(localIssueKey, {
          linkId: link.id,
          linkedIssueKey: linkedIssueKey,
          direction: direction,
          linkTypeName: linkTypeName,
          orgId: orgId
        });
        if (syncResult) syncResult.addLinkSkipped(linkedIssueKey, 'linked issue not synced yet - stored as pending');
        result.pending++;
        continue;
      }

      // If forceCheck, verify the link actually exists on remote
      if (forceCheck && existingMapping) {
        const linkExists = remoteLinks.some(rl => {
          const rlLinkedKey = rl.outwardIssue?.key || rl.inwardIssue?.key;
          return rl.type.name === linkTypeName && rlLinkedKey === remoteLinkedKey;
        });
        
        if (linkExists) {
          console.log(`${LOG_EMOJI.SKIP} Link ${link.id} verified on remote`);
          result.skipped++;
          continue;
        } else {
          console.log(`${LOG_EMOJI.WARNING} Link ${link.id} mapping exists but not found on remote - recreating`);
        }
      }

      // Create the link in remote org
      const linkPayload = {
        type: { name: linkTypeName }
      };

      if (direction === 'outward') {
        linkPayload.inwardIssue = { key: remoteIssueKey };
        linkPayload.outwardIssue = { key: remoteLinkedKey };
        console.log(`${LOG_EMOJI.LINK} Creating link: ${remoteIssueKey} ${link.type.outward} ${remoteLinkedKey}`);
      } else {
        linkPayload.inwardIssue = { key: remoteLinkedKey };
        linkPayload.outwardIssue = { key: remoteIssueKey };
        console.log(`${LOG_EMOJI.LINK} Creating link: ${remoteLinkedKey} ${link.type.outward} ${remoteIssueKey}`);
      }

      const response = await fetch(
        `${config.remoteUrl}/rest/api/3/issueLink`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(linkPayload)
        }
      );

      if (response.ok || response.status === 201) {
        console.log(`${LOG_EMOJI.SUCCESS} Synced issue link: ${linkedIssueKey} (${linkTypeName})`);
        // Store mapping to prevent re-creating (org-specific)
        await storeLinkMapping(link.id, 'synced', orgId);
        // Remove from pending links if it was pending
        await removePendingLink(localIssueKey, link.id);
        if (syncResult) syncResult.addLinkSuccess(linkedIssueKey, linkTypeName);
        result.synced++;
      } else {
        const errorText = await response.text();
        console.error(`${LOG_EMOJI.ERROR} Failed to create link: ${errorText}`);
        if (syncResult) syncResult.addLinkFailure(linkedIssueKey, errorText);
        result.failed++;
      }

    } catch (error) {
      console.error(`${LOG_EMOJI.ERROR} Error syncing link ${link.id}:`, error);
      const linkedKey = link.outwardIssue?.key || link.inwardIssue?.key || 'unknown';
      if (syncResult) syncResult.addLinkFailure(linkedKey, error.message);
      result.failed++;
    }
  }
  
  return result;
}
