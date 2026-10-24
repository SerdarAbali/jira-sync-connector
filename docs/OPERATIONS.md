# Operations

This guide covers routine operation and recovery for SyncApp v2.1.0. It assumes the app is installed on the local Jira Cloud site and the remote organizations have already been configured.

## Global pause and resume

**Synchronization Write Control** is a global emergency stop for connector Jira writes. It is enforced immediately before Jira writes in both directions and covers issue, comment, attachment, link, transition, and backfill operations.

### Pause

1. Confirm the operator has Jira administrator permission. Resolver authorization is enforced before the operation runs.
2. Open **Sync Activity > Synchronization Write Control** and select **Pause Synchronization**.
3. Provide a short safe reason code matching `^[A-Za-z0-9_]{1,64}$`, for example `emergency_stop`.
4. The backend records `paused`, `pausedAt`, `pausedBy`, and the reason code.
5. Reads, configuration, diagnostics, health checks, and exports remain available.

Pausing does not delete or modify issues, mappings, secrets, organization configuration, or other stored data. Inbound webhook events are acknowledged and discarded while paused; they are not queued for replay.

### Resume

1. Confirm the incident or maintenance window has ended.
2. Select **Resume Synchronization** as a Jira administrator.
3. The connector returns to active operation and clears the pause fields. The last resume time and account ID may be retained for inspection.
4. Resume does not queue, replay, backfill, recreate, bulk sync, or otherwise trigger synchronization.

An explicitly approved initial-sync job that was paused by the global control remains paused until the initial-sync control is resumed separately.

## Initial synchronization and backfill

Initial synchronization is the controlled local-to-remote backfill.

- **Preview first.** The preview is read-only and classifies issues as eligible, already mapped, blocked, or conflicting.
- **Review classifications.** Do not approve a job with unexplained conflicts or blocked issues.
- **Approval is bound.** The job carries the preview checksum and configuration checksum. Changing scope, credentials, mappings, features, or target configuration can invalidate approval.
- **Bounded processing.** Jobs run through the initial-sync queue in batches of 25, with at most five items per invocation.
- **Duplicate protection.** The issue-create ledger and per-issue lease prevent a retry from blindly issuing a second create.
- **Parent ordering.** Parents must be eligible or mapped before dependent children are processed.
- **Recovery.** The hourly initial-sync recovery trigger can re-enqueue a persisted running job. It cannot reset the cursor, create issues directly, or start a new backfill.

Use **Pause**, **Resume**, or **Cancel** on the initial-sync panel. Cancelling does not reverse completed Jira writes. Re-run a new preview before starting again after a failed job or configuration change.

### Initial-sync outcomes

- `already_mapped`: an existing pair is retained; no create occurs.
- `already_current`: the remote issue is up to date.
- `updated`: the mapped remote issue was updated through the safe update path.
- `blocked`: required configuration, parent, issue type, or scope is missing.
- `mapping_conflict`: the stored mapping is incomplete, reversed, or inconsistent.
- `create_outcome_unknown`: Jira may have received the create. Do not retry blindly; inspect and reconcile.

## Recurring local-to-remote reconciliation

Recurring reconciliation is an optional **local-to-remote source reconciliation** path. It is **Off by default** and is not full bidirectional reconciliation.

When enabled:

- the existing hourly recovery heartbeat evaluates whether a run is due
- unmapped local issues can be created remotely through the same safe create path
- mapped current issues produce zero writes
- updates outdated mapped counterparts through the safe update path
- a mapped issue is never sent to the create path
- `nextRunAt` is never written when a job is enqueued; it advances only after a terminal run
- one active job per organization is allowed
- a per-organization lease prevents concurrent workers
- a queued or running job blocks a duplicate scheduled run
- disabling the feature cancels the active run without reversing completed writes

It never scans remote Jira and is not full bidirectional reconciliation. It also does not guarantee exact execution at the configured interval.

For an organization using recurring reconciliation, the legacy scheduled sync skips that organization. A settings read failure fails closed rather than silently falling back to legacy writes.

### Reconciliation failures

The job can fail definitively or defer:

- A definitive failure schedules the next run from the failure time.
- A queue enqueue failure marks the job failed and leaves `nextRunAt` unadvanced so the next hourly heartbeat can try again.
- A global pause defers scheduling until writes resume.
- An expired lease can cause the job to be re-enqueued, but the ledger and lease still prevent duplicate creates.

## Issues Requiring Attention

Recurring reconciliation maintains one stable attention record per organization and source issue.

The record can contain:

- source and remote issue keys
- reason code and attempt count
- first and last observation timestamps
- open or resolved state
- acknowledgement metadata
- resolution metadata
- review-comment metadata
- reopen count and prior episode history

**Resolve after Health Check** verifies both mapping directions, probes the local issue, probes the mapped remote issue, and resolves only when both are reachable. A missing mapping, unreachable issue, or failed probe leaves the record open.

**Acknowledge Notifications** only mutes further administrator notifications for the current episode. The record remains open and visible. Later failures update it without sending repeated notifications until a new episode begins.

Do not delete attention records manually. Resolving preserves history instead of deleting it.


## SYNC identifiers, mappings, and review comments

A synchronized pair consists of a local issue key, a remote issue key, and both directions of the stored mapping. A key such as `SYNC-123` is an ordinary remote project issue key, not an internal connector identifier. Internal records are stored under organization-scoped Forge Storage keys.

Generated review comments start with:

```text
Jira Sync Connector recurring reconciliation review required.
```

The marker prevents the comment from being copied to the remote site and provides a second guard in comment-copy paths. The comment tells the reader to review the attention record in **Sync Connector > Sync Activity**. It is generated only when the configured failure threshold is reached and review comments are enabled.

Mapping checks:

- both `local-to-remote` and `remote-to-local` entries should exist
- the reverse entry should point back to the same local key
- a partial or reversed pair is a mapping conflict, not a create candidate
- do not "fix" a conflict by deleting storage keys; use the admin recovery actions or re-preview

## Deleted counterpart recovery

SyncApp does not propagate Jira issue deletion. A confirmed deletion or temporary unavailability becomes a counterpart status that blocks unsafe writes and is shown in **Deleted Counterpart Recovery**.

A confirmed-deleted survivor may receive a connector-owned warning notice in its description. Remote notice addition/removal requires a currently verifiable, selected local source and an intact mapping pair. If the local issue was deleted, is excluded or cannot be read, the remote description remains unchanged; status records and administrative recovery remain available. A recovery action can complete its mapping/status changes while an old notice remains because its separate Jira write was not authorized. The notice is marker-tagged, preserves existing user content, and is never copied to the counterpart. A temporary 404 is classified as unavailable, not confirmed deleted, unless a verified deletion event establishes the state.

Available actions:

- **Probe** verifies current reachability without writing.
- **Remap** verifies both replacement issues before replacing either mapping direction.
- **Replace** recreates a confirmed-deleted counterpart through the controlled create path.
- **End synchronization** removes the active mapping pair and retains an ending record. No Jira issue is deleted.
- **Dismiss** clears an unavailable/recoverable classification without pretending the underlying issue is synchronized. A confirmed deletion must be remapped or ended; it cannot be dismissed.

Automatic replacement is **Off by default**. The legacy `recreateDeletedIssues` option does not enable it. Replacement is allowed for a deleted remote counterpart in push or bidirectional mode; replacement of a deleted local counterpart is limited to bidirectional mode. Every replacement uses the issue-create ledger and an operation-specific suffix so a retry cannot create a second replacement.

No recovery action deletes a Jira issue. If the surviving issue should be removed, a Jira administrator must do that separately in Jira.

## Attachment reconciliation

Attachment operations have their own ledger, separate from issue creation.

- Uploads record a write-start marker before the Jira request.
- A successful upload records the destination attachment ID and mapping.
- A definitive rejection can be retried after correcting the cause.
- An ambiguous upload is reconciliation-only and is not automatically replayed.
- Deletion propagation is off by default.
- When enabled, deletion affects only the explicitly mapped counterpart attachment.
- Attachment locks and mapping records prevent duplicate uploads.

To reconcile an ambiguous upload:

1. Pause synchronization if duplicate writes are possible.
2. Inspect the source and destination issues and the attachment operation state.
3. Confirm whether the destination attachment exists and whether its mapping is recorded.
4. Use **Reconcile attachment** with the verified destination attachment.
5. Resume only after the ledger and mapping agree.

Do not delete the operation record to "unstick" an upload. That removes the evidence needed to avoid duplication.

## Manual synchronization

**Manual Sync** re-runs the safe synchronization path for one issue key. It is a destructive-policy resolver and is audited.

Use it when:

- an event was missed and no initial-sync or reconciliation job is appropriate

## Pending-link maintenance

When a linked issue has no mapping yet, the link is stored as pending rather than guessed or dropped. The hourly maintenance path and the **Retry Pending Links** action can retry it. Each new link write requires both current local endpoints to satisfy project authorization and JQL selection. Excluded/unverifiable pending links retain their retry evidence without consuming write-failure attempts. A previously confirmed remote link can repair storage without another Jira write.

Before retrying:

- confirm both issues are mapped
- confirm the link type exists in the destination
- confirm the destination issue is readable
- confirm global pause is off

A pending link that repeatedly fails usually indicates a missing mapping or an unsupported link type, not a transient network error.

## Legacy scheduled-sync compatibility

The hourly scheduled-sync function remains for upgraded and legacy configurations. It is a fallback recovery path, not the primary real-time mechanism.

- It skips organizations that have recurring reconciliation enabled.
- It requires an allowed-project selection.
- It is not a replacement for the initial-sync preview or the issue-create ledger.
- It is subject to global pause and authorization controls.
- Manual triggering of the legacy scheduler is intentionally disabled.

Real-time Jira events remain the normal path. The scheduled and recovery paths exist to catch missed work without bypassing safety controls.

## Staging readiness preflight

Before a staging validation run, execute the read-only preflight described in
[Staging preflight](STAGING_PREFLIGHT.md). It checks both staging sites, verifies
staging project access and explicit project classification, and writes a private
report. Development/staging operational isolation remains `unknown`; the check
cannot establish that development configuration, callbacks, or pending work are
absent. It never writes to Jira and never certifies operational isolation,
Forge, or F07 state. A passing preflight is evidence of API-visible readiness,
not end-to-end synchronization approval.

## Monitoring

Use **Sync Activity** and **Diagnostics** to review:

- webhook totals and last successful Jira write
- skipped, blocked, ambiguous, and loop-prevented decisions
- legacy scheduled totals and next heartbeat estimate
- API usage and rate limiting
- mapping conflicts and learned field rejections
- attention records and recurring-job status
- authenticated webhook receipts for setup preflight

Use `forge logs` for server-side diagnostics. Logs are redacted; they intentionally do not contain complete issue bodies, tokens, or webhook credentials. Do not add sensitive values to issue comments for debugging.

## Rollback considerations

> **WARNING: Do not roll back while emergency write blocking is required.**
> Older connector versions do not read or enforce the `pilotPause` key. Deploying an older version removes pause enforcement and can allow Jira writes to resume immediately even though the stored pause record still exists.

1. Keep the pause-capable version deployed for the entire active incident.
2. Do not use an application rollback as an emergency stop. Pause the current version instead.
3. Roll back only after the incident is understood and resolved, or after Jira writes have been blocked through another verified method that does not depend on the connector pause record.
4. Before rollback, verify the alternative blocking method is active and that resuming writes is intentional.
5. A later rollback to a pause-capable version reads the existing pause record.
6. Organization configuration, credentials, and mappings are not changed by deploying or rolling back.

For a documentation-only release, no Forge redeployment is required when the deployed application code and version are unchanged. For any code or manifest change, deploy the exact reviewed commit and upgrade the existing installation in place.

- a mapping is healthy but one issue is stale
- an operator has verified that a retry is safe

Do not use manual sync to resolve an unknown create outcome or a mapping conflict. Those require inspection first. Manual sync still respects global pause, project scope, direction, mappings, and counterpart status. Both create and mapped-update paths apply the current configured JQL filter. Independent content writers do so too; a mapping does not exempt an issue from selection. Scope rejection is reported as a failed/deferred operation, not an ambiguous write. Initial/recurring workers stop before advancing the denied item's checkpoint. If earlier steps already succeeded, their destination data and durable records remain; use an explicit authorized manual/reconciliation flow for missing work once selection permits it. See [the outbound selection guarantee](PACKAGE1_OUTBOUND_SELECTION_GUARANTEE.md).

## Signed webhook cutover and rollback

Follow the [F04 coordinated switch runbook](F04-SIGNED-WEBHOOKS.md). Prefer configuration repair or a signed-capable rollback build. Returning to a bearer-URL build reduces security and requires separate emergency approval. Paused or missed inbound deliveries are not automatically replayed.
