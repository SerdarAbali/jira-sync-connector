# Troubleshooting

Start with **Sync Activity > Diagnostics** and `forge logs`. Logs are redacted and intentionally do not include full issue content, tokens, or callback credentials.

## No issue was created

Check, in order:

1. **Global pause**: is **Synchronization Write Control** paused?
2. **Allowed projects**: is the local project selected for this organization? An empty allow-list blocks all synchronization.
3. **JQL**: does the issue match the optional filter?
4. **Direction**: is the remote in push or bidirectional mode as expected?
5. **Mapping**: does the issue already have a remote mapping? A mapped issue is updated, not created again.
6. **Issue type and project mappings**: is a target issue type and project resolved?
7. **Parent hierarchy**: is a subtask or child blocked by an unmapped or out-of-scope parent?
8. **Counterpart status**: is a deleted or unavailable counterpart blocking writes?
9. **Ledger**: does an existing create operation show `create_outcome_unknown` or an in-progress claim?
10. **Credentials and permissions**: can the remote account create in the target project?

Do not use **Manual Sync** repeatedly to force creation. If the create ledger is ambiguous, retrying can duplicate the issue.

## Mapping conflicts

A mapping conflict means the stored pair is incomplete, reversed, or inconsistent with an existing key.

Symptoms include:

- `mapping_conflict`, `MAPPING_PAIR_INCOMPLETE`, or `MAPPING_REVERSE_CONFLICT`
- an issue appears in the initial-sync conflict list
- an update finds a remote key but no reverse mapping
- remapping rejects an unavailable replacement

Resolution:

1. Identify the local key, remote key, and both mapping directions.
2. Verify both issues exist and belong to the configured scope.
3. Do not delete KVS keys manually.
4. Use **Deleted Counterpart Recovery > Remap** when an existing verified pair should replace the old pair.
5. Re-preview initial sync when a mapping conflict came from bulk setup.
6. If a pair cannot be recovered, use **End synchronization** and retain the ending record.

## Unknown create outcome

`create_outcome_unknown` means SyncApp submitted a create but could not prove whether Jira accepted it.

1. Pause synchronization if another create could duplicate the issue.
2. Search the target project for the expected summary, source reference, and creation time.
3. Inspect the issue-create operation record and the Sync Activity decision.
4. If the issue exists, use **Reconcile issue create** with the verified target key.
5. If it does not exist and the ledger confirms no definite success, correct the cause and use the controlled retry path.
6. Resume after the ledger and mapping agree.

Never resolve an unknown outcome by deleting the operation record or blindly re-running manual sync.

## Attachment reconciliation

Use this when an upload is missing, duplicated, or marked ambiguous.

1. Check the source attachment is readable and within the lower Jira limit.
2. Check `syncAttachments` is enabled.
3. Inspect the attachment operation state and mapping on the destination issue.
4. If the destination attachment exists, reconcile the mapping to its attachment ID.
5. If it does not exist and the operation is definitively failed, correct the filename, type, size, or permissions before retrying.
6. If the operation is ambiguous, do not upload again until the destination is checked.

Attachment deletion propagation is Off by default. Enabling it affects only explicitly mapped attachments; it never deletes the issue.

## Webhook was not received

For bidirectional targets:

1. Confirm the organization is in `bidirectional` mode.
2. Open the organization's webhook panel and confirm the callback URL is configured.
3. Confirm the remote Jira System Webhook points to the complete `<webtrigger>/<orgId>/<credential>` URL.
4. Confirm the remote webhook includes the required events and a JQL scope that includes the test issue.
5. Confirm the remote webhook is enabled and has recent successful deliveries.
6. Check communication preflight for an authenticated receipt.
7. If the secret was rotated, update the remote webhook with the new one-time complete URL.
8. Confirm global pause is off; paused events are acknowledged and discarded.

Do not put the secret in a query parameter. The endpoint rejects it. Do not disable authentication to test delivery.

## Counterpart deleted or unavailable

A 404 from a probe is classified as unavailable unless a verified deletion event confirms deletion.

- **Unavailable** can be temporary. Re-probe after checking remote permissions, connectivity, and issue visibility.
- **Confirmed deleted** can be remapped, replaced, ended, or dismissed.
- Remapping requires both replacement issues to be reachable.
- Replacement is controlled and never automatic unless explicitly enabled.
- Jira issue deletion is not propagated in either direction.

## SYNC attention records

An attention record is open when recurring reconciliation repeatedly fails for a source issue.

1. Read the reason code, attempt count, and last job identifier.
2. Inspect the local and mapped remote issue.
3. Correct the underlying cause, such as a missing transition, invalid mapping, unavailable issue, or permission failure.
4. Select **Resolve after Health Check**. Both mapping directions and both issues must be reachable.
5. Use **Acknowledge Notifications** only to mute notifications; it does not resolve the technical record.

A resolved record reopens as a new episode if the issue fails again. Generated review comments start with the connector marker and are never copied to the remote site.

## Global Pause

If synchronization is unexpectedly blocked:

1. Open **Sync Activity > Synchronization Write Control**.
2. Check the state, `pausedAt`, `pausedBy`, and reason code.
3. Confirm whether an operator paused synchronization during an incident.
4. Do not resume until the condition that required the pause is understood.
5. Resume as a Jira administrator. Resume does not replay missed events or start a backfill.

If pause cannot be cleared, check administrator permission and `forge logs`. Do not redeploy an older version as an emergency stop.

## Forge permission upgrade

After a manifest scope change, Jira may require an administrator to approve the updated app access.

Symptoms include:

- the admin page or resolver returns an authorization or permission error
- remote or local Jira calls fail after an upgrade
- `forge install list` shows the installation but Jira lacks the new scope
- diagnostics report a Jira permission failure while connectivity is healthy

Resolution:

1. Confirm the deployed manifest is the reviewed version.
2. Open the app management page in Jira and review the requested permissions.
3. Approve the upgrade as a Jira administrator.
4. Re-run communication preflight.
5. Retry only after confirming no ambiguous write is pending.

Do not add broad scopes to work around a missing project permission; correct the project role or configuration instead.

## Initial sync will not start

Check:

- at least one allowed project
- a valid target project or project mapping
- a fresh preview
- approval after the latest preview
- matching preview and configuration checksums
- no active job
- global pause is off
- no unresolved mapping conflict or parent-cycle block

If configuration changed after preview, re-preview rather than trying to reuse the old approval.

## Recurring reconciliation does not run

Check:

- the feature is enabled for the organization
- the interval has elapsed
- no active job is running
- the hourly recovery heartbeat has fired
- global pause is off
- the settings read does not fail closed
- the organization is not being handled by a blocking legacy path

The scheduler runs hourly, so a configured interval is a minimum, not an exact execution time.

## Links do not sync

- Both issues must have mappings.
- The link type must exist on the destination.
- The destination issue must be readable.
- Pending links may need **Retry Pending Links**.
- Global pause blocks link writes.

## Field changes do not sync

- Confirm a field mapping exists for a custom field.
- Confirm the field is on the target create or edit screen and is not read-only.
- Review learned field rejections in the mappings panel.
- Check that the target field type is compatible.
- A rejected field is skipped and recorded; it should not abort the entire issue update.

## Slow or duplicate-looking activity

Forge cold starts and queue delivery can add latency. Duplicate-looking webhook events are expected and should be suppressed by ledger, mapping, and hash checks. If duplicate Jira issues exist:

1. Pause writes.
2. Preserve both issue keys and operation records.
3. Verify whether one is a confirmed duplicate with no active mapping.
4. Use remap or end-synchronization controls; do not delete Jira issues through the connector.
5. Resume only after the mapping is unambiguous.


If the wrong issue is being treated as deleted, verify the mapping before taking a destructive recovery action.
