import { fetch } from '@forge/api';
import { LOG_EMOJI } from '../../constants.js';
import { formatHttpFailure } from '../../utils/http-error.js';
import { safeErrorSummary } from '../../utils/redaction.js';
import { executeWriteOnce } from '../../utils/retry.js';
import { getLinkMapping, storeLinkMapping, getRemoteKey } from '../storage/mappings.js';
import { storePendingLink, removePendingLink } from '../storage/flags.js';
import { assertPilotWritesAllowed } from './pilot-pause.js';

function buildRemoteLinkLookupUrl(config, remoteIssueKey) {
  return `${config.remoteUrl}/rest/api/3/issue/${remoteIssueKey}?fields=issuelinks`;
}

function remoteAuthHeader(config) {
  const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
  return `Basic ${auth}`;
}

/**
 * Fetch the links currently present on the remote issue. A failed read is
 * reported explicitly so callers can avoid treating "unknown" as "absent".
 */
export async function fetchRemoteIssueLinks(config, remoteIssueKey) {
  try {
    const response = await fetch(
      buildRemoteLinkLookupUrl(config, remoteIssueKey),
      {
        method: 'GET',
        headers: {
          'Authorization': remoteAuthHeader(config),
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      return { ok: false, status: response.status, links: [] };
    }

    const remoteIssue = await response.json();
    return { ok: true, links: remoteIssue.fields?.issuelinks || [] };
  } catch (error) {
    return { ok: false, error: safeErrorSummary(error.message), links: [] };
  }
}

/**
 * Match a remote link to the link that would be created for a local link.
 * Direction is part of the identity: an opposite-direction link must not be
 * mistaken for an existing copy of the desired link.
 */
export function remoteLinkMatches(remoteLink, remoteLinkedKey, linkTypeName, direction) {
  if (!remoteLink || remoteLink.type?.name !== linkTypeName) {
    return false;
  }

  const counterpart = direction === 'outward'
    ? remoteLink.outwardIssue
    : direction === 'inward'
      ? remoteLink.inwardIssue
      : null;

  return counterpart?.key === remoteLinkedKey;
}

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

  await assertPilotWritesAllowed('link_create_remote');

  try {
    const response = await executeWriteOnce(async () => {
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
      console.error(`${LOG_EMOJI.ERROR} Failed to create link`);
      return { success: false, error: formatHttpFailure(response.status) };
    }
  } catch (error) {
    const safeFailure = safeErrorSummary(error.message);
    console.error(`${LOG_EMOJI.ERROR} Error creating link: ${safeFailure}`);
    return { success: false, error: safeFailure };
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

  // If forceCheck, get existing links on remote to verify they actually exist.
  // This runs even when no local mapping exists: the pending-link path may
  // have created the remote link before its mapping was recorded.
  let remoteLinkLookup = { ok: false, links: [] };
  if (forceCheck) {
    remoteLinkLookup = await fetchRemoteIssueLinks(config, remoteIssueKey);
    if (remoteLinkLookup.ok) {
      console.log(`${LOG_EMOJI.INFO} Remote issue ${remoteIssueKey} has ${remoteLinkLookup.links.length} existing link(s)`);
    } else {
      console.log(`${LOG_EMOJI.WARNING} Could not fetch remote links${remoteLinkLookup.status ? ` (HTTP ${remoteLinkLookup.status})` : ''}`);
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

      // If forceCheck, verify the link actually exists on remote. Do this for
      // mapped and unmapped links: an earlier pending-link write may have
      // succeeded without persisting its mapping.
      if (forceCheck) {
        const linkExists = remoteLinkLookup.ok && remoteLinkLookup.links.some(rl =>
          remoteLinkMatches(rl, remoteLinkedKey, linkTypeName, direction)
        );

        if (linkExists) {
          console.log(`${LOG_EMOJI.SKIP} Link ${link.id} verified on remote`);
          if (!existingMapping) {
            await storeLinkMapping(link.id, 'synced', orgId);
          }
          await removePendingLink(localIssueKey, link.id);
          result.skipped++;
          continue;
        }

        if (existingMapping) {
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

      await assertPilotWritesAllowed('link_create_remote');
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
        console.error(`${LOG_EMOJI.ERROR} Failed to create link`);
        if (syncResult) syncResult.addLinkFailure(linkedIssueKey, formatHttpFailure(response.status));
        result.failed++;
      }

    } catch (error) {
      console.error(`${LOG_EMOJI.ERROR} Error syncing link ${link.id}:`, error);
      const linkedKey = link.outwardIssue?.key || link.inwardIssue?.key || 'unknown';
      if (syncResult) syncResult.addLinkFailure(linkedKey, safeErrorSummary(error.message));
      result.failed++;
    }
  }
  
  return result;
}
