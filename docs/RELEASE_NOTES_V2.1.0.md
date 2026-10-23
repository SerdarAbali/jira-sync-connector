# SyncApp v2.1.0

Released 2026-10-23.

## Highlights

- Guided, step-by-step connector setup
- Secure bidirectional Jira Cloud synchronization
- Safe, resumable initial synchronization and historical backfill
- Secure bidirectional attachment synchronization
- Recurring missed-sync reconciliation with administrator attention records
- Global Synchronization Pause and Resume
- Deleted-counterpart detection, notices, remapping, and controlled replacement

## Synchronization

- Added per-organization `push` and `bidirectional` operation.
- Added an authenticated remote webhook path for inbound issue, comment, link, and attachment events.
- Preserved configurable user, field, status, issue-type, and project mappings in both directions.
- Added pending-link retention and maintenance.
- Added strict project allow-list enforcement with an optional JQL filter.
- Added safe handling for read-only or rejected target fields.

## Initial synchronization

- Added a read-only initial-sync preview with eligible, mapped, blocked, and conflicting classifications.
- Added explicit approval bound to preview and configuration checksums.
- Added resumable, bounded queue processing with parent ordering.
- Added an issue-create ledger and per-issue lease to prevent duplicate creates.
- Added pause, resume, cancellation, and recovery for persisted jobs.
- Added controlled reconciliation for ambiguous create outcomes.

## Attachments

- Restored secure bidirectional attachment synchronization.
- Added attachment operation ledgers for uploads and deletions.
- Added Jira-limit and connector-limit enforcement, filename and media-type validation, and duplicate prevention.
- Added opt-in deletion propagation, off by default, scoped to explicitly mapped attachments.
- Added attachment reconciliation for ambiguous writes.

## Recovery and controls

- Added opt-in recurring local-to-remote source reconciliation.
- Added stable attention records with resolve-after-health-check and notification acknowledgement.
- Added marker-tagged local review comments that never synchronize to the remote site.
- Added global Synchronization Write Control for all connector Jira writes.
- Added deleted-counterpart notices that preserve user content.
- Added verified remapping, end-synchronization records, and controlled replacement.
- Added explicit automatic-replacement opt-in, off by default; the legacy recreate-deleted setting does not enable it.
- Jira issue deletion is not propagated.

## Security and reliability

- Added backend Jira-administrator authorization with default-deny resolver policies.
- Stored remote credentials write-only in Forge secret storage.
- Added timing-safe webhook credential validation in the callback path.
- Added duplicate, echo, and loop prevention.
- Added persistent issue and attachment operation ledgers.
- Ambiguous writes require reconciliation and are not automatically replayed.
- Added secret-safe logging, audit redaction, and bounded error summaries.
- Added lease and operation boundaries for concurrent workers.

## Administration

- Added the guided setup wizard and communication preflight.
- Improved Sync Activity diagnostics, statistics, and history.
- Added recurring-reconciliation status and attention controls.
- Added Deleted Counterpart Recovery controls.
- Consolidated legacy scheduling while retaining compatibility.
- Retained background maintenance controls for manual sync and pending links.

## Validation

- 518 automated tests passed.
- 0 production dependency vulnerabilities.
- ESLint passed.
- The offline Forge lint rule set passed without Atlassian credentials.
- Authenticated `forge lint` passed as the local release gate.
- Secret and repository hygiene scan passed.
- Admin UI production build passed.
- `git diff --check` passed.

## Known limitations

- Recurring source reconciliation scans the configured local source scope only; it does not scan remote Jira projects.
- Jira issue deletion propagation is intentionally unsupported.
- Automatic replacement after confirmed deletion is off by default.
- Attachment deletion propagation is off by default.
- Workflows are not cloned; unavailable target transitions are reported.
- Controlled deployment currently supports standard `atlassian.net` Jira origins.
- Bidirectional operation requires a remote Jira System Webhook and administrator authorization.
- CI runs the offline Forge lint rule set without Atlassian credentials; the full authenticated `forge lint` remains a local release gate.
