# Optional Sprint Synchronization

Sprint synchronization is an explicit, mapping-based administration workflow. It
is **Off by default** for every new and existing organization and is stored in the
organization's existing `syncOptions:${orgId}` record as `syncSprints`.

## What the option enables

When `Sync Sprints` is On, an administrator can:

1. verify one explicit local sprint id against one explicit remote sprint id;
2. preview which already-mapped counterpart issues are missing from either sprint;
3. approve the exact digest-bound preview; and
4. apply the preview, which **only adds** issues to those two sprints.

It does not:

- create a sprint, board, or sprint mapping automatically;
- infer a mapping from sprint names, dates, board names, or matching issue lists;
- remove an issue from a sprint or backlog;
- synchronize an issue if its local/remote pair is not already mapped;
- write while the connector is paused or synchronization authorization is absent;
- run on page load or change settings automatically.

## Explicit mapping

The mapping record is `sprintMappings:${orgId}` and contains numeric local and
remote sprint ids, verified metadata and a display-only name/state snapshot. The
pair is selected by the two ids only. Saving requires the exact phrase:

```
MAP SPRINT <orgId> <localSprintId> <remoteSprintId>
```

Both sprint identities are read from Jira before the mapping is stored. Missing,
inaccessible, ambiguous or duplicate mappings are refused. A closed sprint can be
mapped, but preview/apply reports it as blocked and writes nothing.

## Preview

Preview requires the option, pause, a verified exact mapping, and readable sprint
membership. It reads both sprint issue lists and builds only additions for pairs
whose Forge issue mapping already exists.

- `push`: local mapped issues are added to the remote sprint.
- `bidirectional`: the reverse additions are also proposed for remote mapped
  issues missing from the local sprint.
- Local project scope (`allowedProjects`) is enforced. Sprint names are display
  only and are never matching input.
- Preview is read-only and returns a digest and exact phrase:

```
SYNC SPRINT <orgId> <digest>
```

## Apply

Apply re-runs the preview and rejects a stale digest. It requires the exact
phrase, pause, and active synchronization authorization. It submits only the
bounded addition list (at most 50 issues per preview) through the guarded Jira
transport. It never creates a sprint and never removes membership.

Because ordinary Jira POSTs are deliberately blocked while Pause is ON, Apply
mints a short-lived sprint maintenance permit (120 seconds) only after the
preview, phrase, Pause and authorization checks pass. The guarded transport
permits exactly the approved POST path, sprint id, side/host and issue list, one
use per entry. The permit is revoked after the batch. No general Pause bypass is
introduced.

If a remote addition succeeds and a subsequent local addition fails, the result is
reported as partial; a fresh preview is required before retrying. No rollback is
attempted because rollback would itself be another sprint membership write.

## Limits and constraints

- Verified mappings are bounded to 100 per organization.
- Each sprint membership read is bounded to 500 issues / 10 pages.
- Each apply performs at most 50 local and 50 remote additions.
- The existing manifest already carries broad `read:jira-work` and
  `write:jira-work`; no manifest/scope change is required by this implementation.
  If a real installation returns a permission failure, apply fails closed and a
  scope review is required before any manifest change.
- The feature is local-only until separately reviewed and deployed. No live
  staging settings or Jira memberships were changed during implementation.
