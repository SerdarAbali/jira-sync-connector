import { getRemoteKey, getOrganizationsWithTokens } from '../services/storage/mappings.js';
import { logAuditEntry } from '../services/storage/stats.js';
import {
  COUNTERPART_DELETED_SIDES,
  COUNTERPART_STATUS_VALUES,
  recordCounterpartStatus
} from '../services/sync/counterpart-status.js';
import { setCounterpartNotice } from '../services/sync/counterpart-probe.js';
import { maybeAutoReplaceAfterDeletion } from '../services/sync/counterpart-recovery.js';

// Deletion propagation is intentionally disabled for corporate pilot safety.
// Local and remote deletions must never hard-delete the counterpart issue.
// Mappings are deliberately preserved so a future reconciliation workflow can
// decide what to do without data loss.
const DELETION_DISABLED_REASON = 'Deletion propagation disabled for corporate pilot safety';

export async function run(event) {
  console.log(`🗑️ Issue deleted trigger fired`);

  try {
    const issueId = event.issue?.id;
    const issueKey = event.issue?.key;

    if (!issueKey) {
      // Do not substitute a numeric issue ID into a key-based mapping lookup.
      console.warn(`⚠️ Deletion event has no issue key (id=${issueId || 'unknown'}); mapping lookup skipped. No remote delete will be performed.`);
      return;
    }

    console.log(`🗑️ Deletion observed for issue: ${issueKey}. No remote delete will be performed.`);

    const organizations = await getOrganizationsWithTokens();

    if (organizations.length === 0) {
      console.log(`⚠️ No organizations configured`);
      return;
    }

    for (const org of organizations) {
      const orgId = org.id === 'legacy' ? null : org.id;
      const remoteKey = await getRemoteKey(issueKey, orgId);

      if (!remoteKey) {
        continue;
      }

      console.warn(`${DELETION_DISABLED_REASON}: org=${orgId || 'legacy'} local=${issueKey} remote=${remoteKey}`);
      const statusRecord = await recordCounterpartStatus({
        orgId,
        localKey: issueKey,
        remoteKey,
        status: COUNTERPART_STATUS_VALUES.CONFIRMED_DELETED,
        deletedSide: COUNTERPART_DELETED_SIDES.LOCAL,
        source: 'issue_deleted_event',
        reasonCode: 'LOCAL_ISSUE_DELETED'
      });
      await logAuditEntry({
        action: 'delete-blocked',
        sourceIssue: issueKey,
        targetIssue: remoteKey,
        orgId,
        orgName: org.name,
        success: false,
        errors: [DELETION_DISABLED_REASON]
      });
      if (statusRecord.success) {
        await setCounterpartNotice({
          side: 'remote',
          key: remoteKey,
          org,
          localKey: issueKey,
          remoteKey,
          status: COUNTERPART_STATUS_VALUES.CONFIRMED_DELETED
        });
        await maybeAutoReplaceAfterDeletion({
          orgId,
          org,
          localKey: issueKey,
          remoteKey,
          deletedSide: COUNTERPART_DELETED_SIDES.LOCAL
        });
      }
      // Keep the mapping: no cleanup on deletion in this batch.
    }
  } catch (error) {
    console.error(`Error processing issue deletion:`, error);
  }
}
