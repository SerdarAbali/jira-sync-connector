# Corporate Pilot Recovery Guide

## Pause

1. Confirm the caller has Jira administrator permission. The existing resolver
   authorization check is enforced before the operation runs.
2. Call the `pausePilot` resolver with a short safe reason code matching
   `^[A-Za-z0-9_]{1,64}$` (for example `emergency_stop`).
3. The backend writes `paused`, `pausedAt`, `pausedBy` (Jira account ID), and the
   reason code to the `pilotPause` key.
4. The centralized guard checks this state immediately before Jira writes. All
   issue, comment, attachment, link, and transition writes are blocked in both
   directions.

Pausing does not delete or modify issues, mappings, secrets, organization
configuration, or other stored data.

## Inspect

- `getPilotStatus` is read-only and admin-only. It returns:
  - `active` or `paused`
  - `pausedAt`
  - `pausedBy`
  - `reasonCode`
  - each organization's existing `syncDirection` (`push` or `bidirectional`)
- Reads, configuration access, health checks, diagnostics, and exports remain
  available while paused.
- Per-organization direction and scope rules are unchanged. `push` remains
  local-to-remote only; `bidirectional` retains inbound processing when active.

## Roll back the application version

> **WARNING: Do not roll back while emergency write blocking is required.**
> Older connector versions do not read or enforce the `pilotPause` key. Deploying
> an older version removes pause enforcement and can allow Jira writes to resume
> immediately, even though the stored pause record still exists.

1. Keep the pause-capable version deployed for the entire active incident.
2. Do not use an application rollback as an emergency stop. Pause the current
   version instead.
3. Roll back only after the incident is understood and resolved, or after Jira
   writes have been blocked through another verified method that does not depend
   on the connector's `pilotPause` record.
4. Before rollback, verify that the alternative blocking method is active and
   that resuming writes is intentional.
5. A later rollback to a pause-capable version reads the existing `pilotPause`
   record. Organization configuration, credentials, and mappings are not changed
   by deploying or rolling back the pause feature.

## Resume

1. Confirm the incident or maintenance window has ended.
2. Call the `resumePilot` resolver as a Jira administrator.
3. The connector returns to the active state and the `pausedAt`, `pausedBy`, and reason
   fields are cleared. The last resume time and account ID may be retained for
   operational inspection.
4. Resume does not queue, replay, backfill, recreate, bulk sync, or otherwise
   trigger synchronization. Events received while paused are acknowledged and
   discarded by the inbound webhook endpoint.

## No backfill or recreation

Pause and resume are state changes only. They never call Jira, never enqueue a
queue message, never create or update issues, and never recreate deleted issues
or links. Existing safety controls remain in force: deletion, bulk sync,
recreation, and the destructive system test remain disabled.
