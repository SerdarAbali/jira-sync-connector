# Recurring Local-to-Remote Source Reconciliation

## What this feature is

This is an opt-in recurring **local-to-remote source reconciliation** feature. It scans only the local Jira scope already configured for initial sync, creates remote issues that are still unmapped, and updates outdated mapped counterparts through the existing safe update path.

It is **not** a remote Jira scan and it is **not** full bidirectional reconciliation. Existing webhook, scheduled-update and inbound synchronization behavior is unchanged.

## Safety model

- Disabled by default for every existing and new organization.
- Reuses the safe initial-sync preview, classification, parent ordering, mapping checks, issue-create ledger, issue lease, create path and existing safe update path.
- Uses the existing initial-sync queue and the existing hourly initial-sync recovery trigger. No new queue, scheduled trigger, function, manifest module or OAuth scope is added.
- One active reconciliation job per organization. A queued or running job blocks a duplicate scheduled run; a per-organization conditional KVS lease blocks concurrent workers.
- `nextRunAt` is written only after a run completes, fails definitively, or is cancelled. It is never written when a job is enqueued, including when an initial or continuation enqueue fails. Queue enqueue failures and global-pause deferrals leave the organization due for the next hourly heartbeat.
- A global emergency pause defers reconciliation without scheduling a future run. Once writes resume, the next hourly heartbeat can schedule it again.
- A mapped issue is never sent to the create path. A mapped, current issue produces zero Jira writes. A mapped, outdated issue updates its existing counterpart through the safe issue-update path; reconciliation never creates a second counterpart, deletes or merges one.
- Disabling the feature cancels an active run without reversing completed Jira writes.

## Settings

Stored per organization:

| Setting | Default | Meaning |
| --- | --- | --- |
| `recurringReconciliationEnabled` | `false` | Explicit opt-in switch. |
| `reconciliationIntervalMinutes` | `60` | Minimum interval after a terminal run. The existing hourly heartbeat provides the actual resolution. |
| `reconciliationCommentOnReview` | `true` | Add one marker-tagged review comment to the local issue when the failure threshold is reached. |
| `reconciliationFailureThreshold` | `3` | Failed attempts before an unacknowledged attention record contributes to the administrator notification count. |

## Resolve vs Acknowledge

- **Resolve after Health Check** verifies both mapping directions, probes the local issue and the mapped remote issue, and only then marks the stable attention record resolved. A failed probe leaves the record open.
- **Acknowledge Notifications** only mutes administrator notifications. The technical record remains open, `reasonCode` and `attempts` remain visible, and later failures continue to update it without sending additional notifications for that episode.

Attention records are keyed by organization and source issue. Resolving preserves the record and its history. A later failure reopens the same record as a new episode while preserving the prior resolution metadata and an episode counter.

## Review comments

Generated review comments contain a stable marker:

```
Jira Sync Connector recurring reconciliation review required.
```

The marker is filtered in both outbound comment copying and inbound comment processing. The generated comment is never copied to the remote organization. Jira app-authored comments are also skipped as before, so the marker is a second, content-based guard.

## Operational notes

- The feature uses the existing hourly `initial-sync-recovery` scheduled function. There is no guaranteed exact-minute execution.
- If a queued or running job is older than the recovery age, the hourly heartbeat re-enqueues the same job. The lease and job identifier still prevent duplicate Jira creates.
- If preview or candidate processing fails definitively, the job fails and the next run is scheduled from the failure time. If the queue cannot accept an initial or continuation event, the job is marked failed, `nextRunAt` is not advanced, and the organization remains due for the next hourly heartbeat. Completed Jira writes are not reversed.
- The administrator UI exposes enablement, interval, threshold, review-comment behavior, schedule, last job counts and the stable attention list.
