import { runScheduledScan, scheduledScopeSignature } from './scheduled-scan.js';
import { fetch } from '../jira/guarded-api.js';
import * as kvsStore from '../storage/kvs.js';
import { LOG_EMOJI, SCHEDULED_SYNC_DELAY_MS, MAX_PENDING_LINK_ATTEMPTS, MAX_ERROR_ENTRIES } from '../../constants.js';
import { safeErrorSummary, boundHistory } from '../../utils/redaction.js';
import { formatHttpFailure } from '../../utils/http-error.js';
import { assertPilotWritesAllowed } from '../sync/pilot-pause.js';
import { sleep, executeWriteOnce } from '../../utils/retry.js';
import { getRemoteKey, getLocalKey, storeLinkMapping, getOrganizationsWithTokens, getLastSyncedLocalUpdated } from '../storage/mappings.js';
import { removePendingLink, getPendingLinks, listPendingLinkIssueKeys, recordPendingLinkAttempt } from '../storage/flags.js';
import { getFullIssue } from '../jira/local-client.js';
import { updateRemoteIssue } from '../sync/issue-sync.js';
import { syncIssueLinks, remoteLinkMatches, fetchRemoteIssueLinks } from '../sync/link-sync.js';
import { getReconciliationSettings } from '../sync/reconciliation-settings.js';
import { assertOutboundRemoteScope, isOutboundScopeError } from '../sync/outbound-scope.js';

async function checkIfIssueNeedsSync(issueKey, issue, config, mappings, syncOptions = {}, orgId = null) {
  // Check if issue was created by remote sync
  const createdByRemote = await getLocalKey(issueKey);
  if (createdByRemote) {
    return { needsSync: false, reason: 'created-by-remote' };
  }

  // Check if issue has an organization-scoped remote mapping. Do not fall back
  // to a global/legacy mapping here: in a multi-org setup that could update the
  // wrong tenant. Scheduled sync is update-only for corporate pilot safety.
  const remoteKey = await getRemoteKey(issueKey, orgId);

  if (!remoteKey) {
    return { needsSync: false, reason: 'no-org-mapping-create-disabled' };
  }

  // Check if we already synced this version
  const lastSyncedUpdated = await getLastSyncedLocalUpdated(issueKey, orgId);
  if (lastSyncedUpdated && issue.fields.updated === lastSyncedUpdated) {
     // Skip if timestamps match exactly
     return { needsSync: false, reason: 'already-synced' };
  }

  // A valid mapping exists: update only. Deleted-issue recreation is disabled
  // for corporate pilot safety and is not attempted here.
  return { needsSync: true, action: 'update', remoteKey };
}

const MAX_SCHEDULED_EVENTS = 25;

function recordEvent(stats, event) {
  if (!stats || !stats.events) {
    return;
  }
  stats.events.unshift({
    timestamp: new Date().toISOString(),
    ...event
  });
  if (stats.events.length > MAX_SCHEDULED_EVENTS) {
    stats.events = stats.events.slice(0, MAX_SCHEDULED_EVENTS);
  }
}

function recordScheduledError(stats, message) {
  if (!stats) return;
  stats.errors.push(safeErrorSummary(message));
  stats.errors = boundHistory(stats.errors, MAX_ERROR_ENTRIES);
}

export async function retryAllPendingLinks(config, mappings, stats, deadline = Infinity) {
  console.log(`🔄 Starting pending link retry...`);

  let totalRetried = 0;
  let totalSuccess = 0;
  let totalFailed = 0;
  let totalStillPending = 0;

  try {
    const pendingLinksIndex = await listPendingLinkIssueKeys();

    if (pendingLinksIndex.length === 0) {
      console.log(`No pending links to retry`);
      return { retried: 0, success: 0, failed: 0, stillPending: 0 };
    }

    console.log(`📋 Found ${pendingLinksIndex.length} issue(s) with pending links`);

    // Get orgId for this config. Legacy organizations use the null scope.
    const orgId = config.id && config.id !== 'legacy' ? config.id : null;

    // Process each issue's pending links
    for (const localIssueKey of pendingLinksIndex) {
      if (Date.now() >= deadline) break;
      const pendingLinks = await getPendingLinks(localIssueKey);

      if (!pendingLinks || pendingLinks.length === 0) {
        continue;
      }

      // Filter pending links for this org only
      const orgPendingLinks = pendingLinks.filter(pl => pl.orgId === orgId || (!pl.orgId && !orgId));

      if (orgPendingLinks.length === 0) {
        continue;
      }

      const remoteIssueKey = await getRemoteKey(localIssueKey, orgId);

      if (!remoteIssueKey) {
        console.log(`⏭️ Skipping ${localIssueKey} - not synced to remote yet (org: ${orgId || 'organization'})`);
        continue;
      }

      console.log(`🔗 Retrying ${orgPendingLinks.length} pending link(s) for ${localIssueKey} (org: ${orgId || 'organization'})`);

      // Read the remote links once per source issue. This lets a retry
      // recognize a link created by an earlier attempt whose response was
      // lost, instead of blindly issuing a duplicate POST.
      const remoteLinkLookup = await fetchRemoteIssueLinks(config, remoteIssueKey);

      const auth = Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');

      for (const pendingLink of orgPendingLinks) {
        if (Date.now() >= deadline) break;
        totalRetried++;

        const remoteLinkedKey = await getRemoteKey(pendingLink.linkedIssueKey, orgId);

        const recordFailure = async (updates, reason, message) => {
          const updated = await recordPendingLinkAttempt(localIssueKey, pendingLink.linkId, updates);
          totalFailed++;
          const dropped = !updated || updated.attempts >= MAX_PENDING_LINK_ATTEMPTS;
          if (dropped) {
            await removePendingLink(localIssueKey, pendingLink.linkId);
            if (stats) {
              recordEvent(stats, {
                type: 'link-dropped',
                issueKey: localIssueKey,
                linkedIssueKey: pendingLink.linkedIssueKey,
                reason: 'max-attempts'
              });
            }
          } else {
            totalStillPending++;
          }
          if (stats) {
            recordEvent(stats, {
              type: 'link-error',
              issueKey: localIssueKey,
              linkedIssueKey: pendingLink.linkedIssueKey,
              reason,
              message
            });
          }
          return dropped;
        };

        if (!remoteLinkedKey) {
          console.log(`⏭️ ${pendingLink.linkedIssueKey} still not synced - keeping as pending`);
          const updated = await recordPendingLinkAttempt(localIssueKey, pendingLink.linkId, {});
          if (updated && updated.attempts >= MAX_PENDING_LINK_ATTEMPTS) {
            console.log(`❌ Removing ${pendingLink.linkedIssueKey} from pending - max attempts reached`);
            await removePendingLink(localIssueKey, pendingLink.linkId);
            totalFailed++;
            if (stats) {
              recordEvent(stats, {
                type: 'link-dropped',
                issueKey: localIssueKey,
                linkedIssueKey: pendingLink.linkedIssueKey,
                reason: 'max-attempts'
              });
            }
          } else {
            totalStillPending++;
            if (stats) {
              recordEvent(stats, {
                type: 'link-pending',
                issueKey: localIssueKey,
                linkedIssueKey: pendingLink.linkedIssueKey,
                direction: pendingLink.direction
              });
            }
          }
          continue;
        }

        // The remote link may already exist because an earlier attempt
        // succeeded but its response/mapping was lost.
        const linkAlreadyExists = remoteLinkLookup.ok && remoteLinkLookup.links.some(link =>
          remoteLinkMatches(link, remoteLinkedKey, pendingLink.linkTypeName, pendingLink.direction)
        );

        if (linkAlreadyExists) {
          console.log(`${LOG_EMOJI.SKIP} Pending link already exists remotely: ${pendingLink.linkedIssueKey}`);
          await storeLinkMapping(pendingLink.linkId, 'synced', orgId);
          await removePendingLink(localIssueKey, pendingLink.linkId);
          totalSuccess++;
          if (stats) {
            recordEvent(stats, {
              type: 'link-synced',
              issueKey: localIssueKey,
              linkedIssueKey: pendingLink.linkedIssueKey,
              direction: pendingLink.direction,
              reason: 'verified-existing'
            });
          }
          continue;
        }

        // Once an attempt is ambiguous, do not issue another non-idempotent
        // POST until the link has been reconciled (or the entry is dropped at
        // the attempt limit). A successful remote read above already recovers
        // the common "write succeeded, response lost" case.
        if (pendingLink.reconciliationRequired) {
          console.warn(`${LOG_EMOJI.WARNING} Pending link requires reconciliation; not repeating ambiguous POST`);
          await recordFailure(
            { reconciliationRequired: true },
            'reconciliation-required',
            'ambiguous write outcome requires reconciliation'
          );
          continue;
        }

        // Linked issue is now synced - try to create the link
        console.log(`✅ ${pendingLink.linkedIssueKey} is now synced - creating link`);

        try {
          const linkPayload = {
            type: { name: pendingLink.linkTypeName }
          };

          if (pendingLink.direction === 'outward') {
            linkPayload.inwardIssue = { key: remoteIssueKey };
            linkPayload.outwardIssue = { key: remoteLinkedKey };
            console.log(`${LOG_EMOJI.LINK} Creating link: ${remoteIssueKey} → ${remoteLinkedKey}`);
          } else {
            linkPayload.inwardIssue = { key: remoteLinkedKey };
            linkPayload.outwardIssue = { key: remoteIssueKey };
            console.log(`${LOG_EMOJI.LINK} Creating link: ${remoteLinkedKey} → ${remoteIssueKey}`);
          }

          await assertPilotWritesAllowed('link_create_remote');
          await assertOutboundRemoteScope({ orgId, remoteKeys: [remoteIssueKey, remoteLinkedKey] });
          const response = await executeWriteOnce(
            async () => fetch(
              `${config.remoteUrl}/rest/api/3/issueLink`,
              {
                method: 'POST',
                headers: {
                  'Authorization': `Basic ${auth}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify(linkPayload)
              }
            ),
            `Create pending link ${pendingLink.linkTypeName} for ${localIssueKey}`
          );

          if (response.ok || response.status === 201) {
            console.log(`${LOG_EMOJI.SUCCESS} Successfully synced pending link: ${pendingLink.linkedIssueKey}`);
            await storeLinkMapping(pendingLink.linkId, 'synced', orgId);
            await removePendingLink(localIssueKey, pendingLink.linkId);
            totalSuccess++;
            if (stats) {
              recordEvent(stats, {
                type: 'link-synced',
                issueKey: localIssueKey,
                linkedIssueKey: pendingLink.linkedIssueKey,
                direction: pendingLink.direction
              });
            }
          } else {
            const safeFailure = formatHttpFailure(response.status);
            console.error(`${LOG_EMOJI.ERROR} Failed to create pending link`);
            const status = Number(response.status);
            const ambiguous = !Number.isFinite(status)
              || status >= 500
              || status === 408
              || status === 425
              || status === 429;
            await recordFailure(
              ambiguous
                ? { reconciliationRequired: true, lastFailure: safeFailure }
                : { lastFailure: safeFailure },
              ambiguous ? 'ambiguous-write-outcome' : 'link-write-rejected',
              safeFailure
            );
          }
        } catch (error) {
          console.error(`${LOG_EMOJI.ERROR} Error creating pending link:`, error);

          if (error?.code === 'PILOT_PAUSED' || isOutboundScopeError(error)) {
            totalStillPending++;
            if (stats) {
              recordEvent(stats, {
                type: 'link-pending',
                issueKey: localIssueKey,
                linkedIssueKey: pendingLink.linkedIssueKey,
                direction: pendingLink.direction,
                reason: isOutboundScopeError(error) ? error.code : 'pilot-paused'
              });
            }
          } else if (error?.code === 'AMBIGUOUS_WRITE_OUTCOME' || error?.code === 'RATE_LIMITED_WRITE_OUTCOME') {
            await recordFailure(
              { reconciliationRequired: true, lastFailure: 'ambiguous-write-outcome' },
              'ambiguous-write-outcome',
              'ambiguous write outcome requires reconciliation'
            );
          } else {
            await recordFailure(
              { lastFailure: 'transient-retry-failure' },
              'transient-retry-failure',
              'pending link retry failed'
            );
          }
        }

        // Small delay to avoid rate limiting
        await sleep(100);
      }
    }

    console.log(`✅ Pending link retry complete: ${totalSuccess} success, ${totalFailed} failed, ${totalStillPending} still pending`);
    return { retried: totalRetried, success: totalSuccess, failed: totalFailed, stillPending: totalStillPending };

  } catch (error) {
    console.error(`${LOG_EMOJI.ERROR} Error in retryAllPendingLinks:`, error);
    return { retried: totalRetried, success: totalSuccess, failed: totalFailed, stillPending: totalStillPending };
  }
}

function createEmptyScheduledStats(reason) {
  return {
    lastRun: new Date().toISOString(),
    issuesChecked: 0,
    issuesCreated: 0,
    issuesUpdated: 0,
    issuesAlreadyCurrent: 0,
    issuesSkipped: 0,
    issuesFailed: 0,
    issuesRecreated: 0,
    lastSuccessfulJiraWrite: null,
    errors: [],
    events: [],
    disabled: true,
    reason
  };
}

function getScheduledConfigIssue(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return 'missing-or-malformed-config';
  }
  if (config.enabled !== true) {
    return config.enabled === false ? 'disabled' : 'invalid-enabled-flag';
  }
  if (!['recent', 'all'].includes(config.syncScope)) {
    return 'invalid-sync-scope';
  }
  return null;
}

/**
 * Recurring reconciliation is the primary background sync path. When an
 * organization has opted in, the legacy scheduled-sync path must not also write
 * for that organization. Settings read failures fail closed rather than
 * assuming the legacy path is safe.
 */
async function getLegacyScheduledSkipReason(orgId) {
  try {
    const settings = await getReconciliationSettings(orgId);
    return settings.recurringReconciliationEnabled
      ? 'recurring-reconciliation-enabled'
      : null;
  } catch {
    return 'reconciliation-settings-unavailable';
  }
}

export async function performScheduledSync() {
  const startTime = Date.now();
  const TIMEOUT_THRESHOLD_MS = 800 * 1000; // 13 minutes 20 seconds (leaving buffer before 900s limit)
  
  console.log(`⏰ Scheduled sync starting...`);

  const scheduledConfig = await kvsStore.get('scheduledSyncConfig');
  const configIssue = getScheduledConfigIssue(scheduledConfig);

  if (configIssue) {
    // Fail closed: never create a default enabled configuration, and never
    // write to Jira when the scheduled-sync configuration is missing or bad.
    console.warn(`⏭️ Scheduled sync skipped: ${configIssue}`);
    return createEmptyScheduledStats(configIssue);
  }
  
  // Get organizations with their API tokens from secure storage
  const organizations = await getOrganizationsWithTokens();
  const configs = organizations.filter(org => org.remoteUrl && org.remoteProjectKey);
  if (configs.length > 0) {
    console.log(`📋 Found ${configs.length} configured organization(s)`);
  }

  if (configs.length === 0) {
    console.log(`⏭️ No organizations configured for sync`);
    return;
  }
  
  const stats = {
    lastRun: new Date().toISOString(),
    issuesChecked: 0,
    issuesCreated: 0,
    issuesUpdated: 0,
    issuesAlreadyCurrent: 0,
    issuesSkipped: 0,
    issuesFailed: 0,
    issuesRecreated: 0,
    lastSuccessfulJiraWrite: null,
    errors: [],
    events: [],
    incomplete: false,
    scans: {}
  };

  try {
    // Process each organization
    for (const org of configs) {
      // Check for timeout before starting org
      if (Date.now() - startTime > TIMEOUT_THRESHOLD_MS) {
        console.warn(`⚠️ Scheduled sync approaching timeout. Stopping early.`);
        stats.incomplete = true;
        recordScheduledError(stats, 'Sync stopped early due to timeout risk');
        break;
      }

      const orgId = org.id || 'legacy';
      const orgName = org.name || 'Legacy';
      console.log(`\n🏢 Processing organization: ${orgName}`);
      const legacySkipReason = await getLegacyScheduledSkipReason(orgId);
      if (legacySkipReason) {
        console.log(`⏭️ Skipping legacy scheduled sync for ${orgName}: ${legacySkipReason}`);
        stats.issuesSkipped++;
        recordEvent(stats, {
          type: 'skip',
          orgName,
          reason: legacySkipReason
        });
        continue;
      }


      
      const allowedProjects = Array.isArray(org.allowedProjects)
        ? org.allowedProjects.filter(Boolean)
        : [];

      if (allowedProjects.length === 0) {
        console.log(`⛔ Skipping ${orgName} - no project filters selected`);
        stats.issuesSkipped++;
        recordEvent(stats, {
          type: 'skip',
          orgName,
          message: 'No project filters selected'
        });
        continue;
      }

      try {
        // Build config object compatible with sync functions
        const config = {
          id: org.id || null,
          remoteUrl: org.remoteUrl,
          remoteEmail: org.remoteEmail,
          remoteApiToken: org.remoteApiToken,
        remoteProjectKey: org.remoteProjectKey,
        allowedProjects,
        jqlFilter: org.jqlFilter || ''
      };

      // Fetch org-specific mappings and sync options
      const [
        orgUserMappings, 
        orgFieldMappings, 
        orgStatusMappings, 
        orgSyncOptions,
        legacyUserMappings,
        legacyFieldMappings,
        legacyStatusMappings,
        legacySyncOptions
      ] = await Promise.all([
        kvsStore.get(`userMappings:${orgId}`),
        kvsStore.get(`fieldMappings:${orgId}`),
        kvsStore.get(`statusMappings:${orgId}`),
        kvsStore.get(`syncOptions:${orgId}`),
        kvsStore.get('userMappings'),
        kvsStore.get('fieldMappings'),
        kvsStore.get('statusMappings'),
        kvsStore.get('syncOptions')
      ]);
      
      // Use org-specific mappings if available, fallback to legacy
      const mappings = {
        userMappings: orgUserMappings || legacyUserMappings || {},
        fieldMappings: orgFieldMappings || legacyFieldMappings || {},
        statusMappings: orgStatusMappings || legacyStatusMappings || {}
      };

      const effectiveSyncOptions = orgSyncOptions || legacySyncOptions || {
        syncComments: true,
        syncAttachments: false,
        syncLinks: true,
        recreateDeletedIssues: false,
        propagateAttachmentDeletions: false
      };
      
      // Always force check links during scheduled sync to catch missing links
      effectiveSyncOptions.forceCheckLinks = true;
      effectiveSyncOptions.forceCheckAttachments = true;

      // Scheduled creation and recreation are intentionally disabled for
      // corporate pilot safety. Scheduled sync may only update issues that
      // already have a valid mapping. No summary matching or missing-issue
      // creation scan is performed.

      // Build project filter for JQL
      let projectFilter;
      if (config.allowedProjects && Array.isArray(config.allowedProjects) && config.allowedProjects.length > 0) {
        if (config.allowedProjects.length === 1) {
          projectFilter = `project = ${config.allowedProjects[0]}`;
        } else {
          projectFilter = `project IN (${config.allowedProjects.join(', ')})`;
        }
      } else {
        projectFilter = `project = ${config.remoteProjectKey}`;
      }

      // Combine project filter with org's custom JQL filter if set
      let baseFilter = projectFilter;
      if (config.jqlFilter && config.jqlFilter.trim()) {
        baseFilter = `${projectFilter} AND (${config.jqlFilter})`;
      }

      const jql = scheduledConfig.syncScope === 'recent'
        ? `${baseFilter} AND updated >= -24h ORDER BY updated ASC, key ASC`
        : `${baseFilter} ORDER BY updated ASC, key ASC`;
      
      console.log('🔍 Querying mapped issues');
      
      const signature = scheduledScopeSignature(org, scheduledConfig);
      const scan = await runScheduledScan({ orgId, signature, jql,
        deadline: startTime + TIMEOUT_THRESHOLD_MS,
        isCurrent: async () => {
          const current = (await getOrganizationsWithTokens()).find(candidate => (candidate.id || 'legacy') === orgId);
          return current && scheduledScopeSignature(current, await kvsStore.get('scheduledSyncConfig')) === signature
            && !await getLegacyScheduledSkipReason(orgId);
        },
        onIssue: async issueKey => {
          stats.issuesChecked++;

          try {
            const issue = await getFullIssue(issueKey);
            if (!issue) {
              console.log(`⏭️ Could not fetch ${issueKey}`);
              stats.issuesSkipped++;
              return false;
            }

            const syncCheck = await checkIfIssueNeedsSync(issueKey, issue, config, mappings, effectiveSyncOptions, orgId);

            if (!syncCheck.needsSync) {
              console.log(`⏭️ ${issueKey} - ${syncCheck.reason}`);
              if (syncCheck.reason === 'already-synced') {
                stats.issuesAlreadyCurrent++;
              } else {
                stats.issuesSkipped++;
              }
              return true;
            }

            if (syncCheck.action === 'update') {
              console.log(`🔄 Scheduled UPDATE: ${issueKey} → ${syncCheck.remoteKey}`);
              const syncDetails = await updateRemoteIssue(issueKey, syncCheck.remoteKey, issue, config, mappings, null, effectiveSyncOptions);
              if (!syncDetails || syncDetails.skipped) {
                if (syncDetails?.status === 'ALREADY_CURRENT') {
                  stats.issuesAlreadyCurrent++;
                } else {
                  stats.issuesSkipped++;
                }
                recordEvent(stats, {
                  type: 'skip',
                  issueKey,
                  remoteKey: syncCheck.remoteKey,
                  orgName,
                  reason: syncDetails?.status || 'update-skipped'
                });
                return syncDetails?.status === 'ALREADY_CURRENT';
              }

              // Force verification of links for the mapped issue during the
              // scheduled update path.
              if (effectiveSyncOptions.syncLinks !== false) {
                const linkResult = await syncIssueLinks(issueKey, syncCheck.remoteKey, issue, config, null, orgId, true);
                if (linkResult && linkResult.synced > 0) {
                  console.log(`🔗 Force-synced ${linkResult.synced} link(s) for ${issueKey}`);
                  if (syncDetails) syncDetails.links = linkResult.synced;
                }
              }

              stats.issuesUpdated++;
              stats.lastSuccessfulJiraWrite = new Date().toISOString();
              recordEvent(stats, {
                type: 'update',
                issueKey,
                remoteKey: syncCheck.remoteKey,
                orgName,
                details: syncDetails || { fields: true }
              });
            }

            await sleep(SCHEDULED_SYNC_DELAY_MS);

          } catch (error) {
            console.error(`Error syncing ${issueKey}:`, error);
            stats.issuesFailed++;
            recordScheduledError(stats, `${issueKey}: ${error.message}`);
            recordEvent(stats, {
              type: 'error',
              issueKey,
              message: error.message,
              orgName
            });
            return false;
          }
          return true;
        }
      });
      stats.scans[orgId] = scan;
      if (!scan.complete) stats.incomplete = true;

      // Retry pending links for this org
      try {
        const pendingLinkResults = !['SYNC_ALREADY_IN_PROGRESS', 'LEASE_STORAGE_ERROR'].includes(scan.reason)
          && Date.now() < startTime + TIMEOUT_THRESHOLD_MS
          ? await retryAllPendingLinks(config, mappings, stats, startTime + TIMEOUT_THRESHOLD_MS)
          : { success: 0, stillPending: 0 };
        console.log(`🔗 Pending links for ${orgName}: ${pendingLinkResults.success} synced, ${pendingLinkResults.stillPending} still pending`);
      } catch (error) {
        console.error(`Error retrying pending links for ${orgName}:`, error);
      }
      
    } catch (error) {
      console.error(`Error processing org ${orgName}:`, error);
      stats.incomplete = true;
      stats.scans[orgId] = { complete: false, reason: 'scan-failed' };
      stats.issuesFailed++;
      recordScheduledError(stats, `${orgName}: ${error.message}`);
      recordEvent(stats, {
        type: 'error',
        message: error.message,
        orgName
      });
    }
  }

  // Save stats
  await kvsStore.set('scheduledSyncStats', stats);

  console.log(`\n✅ Scheduled sync complete:`, stats);
  return stats;
  } catch (error) {
    stats.incomplete = true;
    console.error('Fatal error in scheduled sync:', error);
    return stats;
  }
}
