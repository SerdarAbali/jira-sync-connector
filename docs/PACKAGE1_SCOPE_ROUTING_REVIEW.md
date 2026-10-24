# v2.1.1 Package 1 — outbound selection completion review

Date: 2026-10-24 (Europe/Helsinki).
Worktree: `/Users/serdar/Documents/Projects/jira-sync-project/v2.1.1-scope-routing`.
Branch: `fix/v2.1.1-scope-routing`.
Base/HEAD: `03c9fea8b18bbdde25c8aa0079021d37db7aac17`.

All changes remain unstaged and uncommitted for independent review. No commit,
push, merge, release, deployment, live data change or migration activation was
performed. Packages 2 and 3 were not started. The production F07 migration gate,
manifest, inbound scope policy, dependencies and UI source remain unchanged.

## Guarantee and production inventory

[The outbound source-selection invariant](PACKAGE1_OUTBOUND_SELECTION_GUARANTEE.md)
was written before F2 production changes. Every new outbound mutation must verify
current source eligibility under current stored project authorization and optional
JQL. Excluded/unverifiable sources cannot authorize a new export, successful
synchronization result or advancement of the denied operation's checkpoint.
Pending, queued and recovered work has the same obligation at execution time.

Project authorization is mandatory and separate from JQL selection. A mapping is
historical identity, not continuing authority. Existing destination content and
unknown-outcome evidence remain intact after selection changes. Read-only repair
of a confirmed historical write is allowed without repeating it. Inbound writes
use their separate project/direction policy; local source JQL is not inbound
permission. The guarantee is fresh fail-closed verification, not an atomic
transaction spanning local reads, search, configuration and destination writes.

The invariant document enumerates webhook, manual resolver, initial/recurring
consumer, scheduled, attachment-continuation and recovery entry points. All
identified reachable outbound writers are covered: issues and exported hierarchy
references, comments/replies and parent snippets, attachment upload/explicit
deletion, normal/pending links and link deletion, transitions and remote
counterpart notices. Both link endpoints must be eligible because a link exposes
their association/type/direction and deletion mutates that shared relationship.
The existing product contract supplies no mapping-based selection exemption.

Remote notices have no cleanup exemption. The documentation says a survivor may
receive a notice, so a deleted/unreadable local source blocks its remote write
without conflicting with that conditional contract. Recovery may finish its
mapping/status action while an old remote notice remains. No automatic destructive
cleanup is introduced. Stale project-only manual-update documentation was corrected
to the explicitly adopted guarantee.

The [original F2 investigation](PACKAGE1_F2_JQL_PROPAGATION_INVESTIGATION.md) is
retained as pre-implementation evidence and clearly marked historical.

## Production behavior changes

- `outbound-scope.js` remains the single JQL implementation. Shared multi-source
  verification detects configuration drift across endpoint checks. Destination
  writers resolve current reverse mappings and verify the forward pair before
  checking local sources; destination keys alone grant no selection authority.
- Comments verify source scope before consuming a new durable fence and again
  inside the guarded send callback. Pause/lease checks run again after asynchronous
  scope reads. A late rejection rearms only the owned, provably unsent fence and
  atomically releases the deferred submission marker. Already uncertain writes
  remain fenced; confirmed receipt repair does not repeat an export. Catch-up
  failures propagate; realtime/recovery callers report retry without false success.
- Attachments check each outbound source before a new upload claim and after
  metadata/download, before the submission marker. Deletion checks before claim
  and again before its marker. Unsent scope denials remain definitive and do not
  become unknown uploads/deletes. Queue continuations use the same engine.
- Link creation, newly mapped pending links, scheduled/admin pending retries and
  link deletion verify both sources immediately before a new remote write.
  Scope rejection retains pending evidence without exhausting write-failure
  attempts or removing mappings. Observed historical links may repair storage;
  uncertain pending POSTs retain reconciliation-only behavior.
- Status transitions and remote notice addition/removal verify their local source
  at the write boundary. A deleted/unreadable source or missing/conflicting
  mapping blocks the remote notice. Status records remain available locally.
- Issue field POST/PUT boundaries recheck the issue and exported parent/Epic
  sources together. Creates recheck after claim and before the submission marker;
  denial is recorded as definitive with no submission started. Remote description
  follow-ups retain their source checks. Recursive routing/hierarchy fixes remain.
- Manual/import/scheduled callers no longer count a null/failed update as applied.
  Successful-sync timestamps are written only after the selected follow-up path
  completes. Scope errors propagate to initial/recurring workers, which fail
  without advancing the affected item's cursor/attempted-key checkpoint. Earlier
  valid destination writes keep their mappings, receipts and echo evidence.

## Accepted F1 correction

The shared retry safety-code set still contains `OUTBOUND_SCOPE_BLOCKED` and
`OUTBOUND_SCOPE_UNVERIFIABLE`. Single-shot and idempotent wrappers and outer retry
layers retain original code/reason/message and perform no automatic resubmission.
The unverifiable error keeps its caller-visible retryable flag for deferral.
Existing Pause, bounded 429, lease and ambiguous-outcome behavior is preserved.

Six F1 regressions remain: four real scope-checker/write-wrapper cases and two
production update cases. They verify zero Jira mutations, unchanged successful
sync timestamps and original rejection reporting. Removing only the classification
addition reproduced all six failures during the earlier F1 follow-up. The accepted
full baseline was 957 tests across 57 suites.

## Red-to-green evidence

Before editing F2 production code, `tests/package1-outbound-guarantee.test.js`
invoked production functions with modelled platform storage/transport. Initial
run: **58 failed, 35 passed, 93 total**. Failures reproduced excluded/error/
incomplete selection writing comments/replies, attachments/continuations/deletions,
normal/pending/deleted links, transitions and notices; configuration drift;
concurrent excluded comment delivery; resumed attachment work; and pending-link
evidence preservation. Eligible cases supplied positive transport controls.

Two additional mapped-parent boundary regressions were run before their fix:
**2 failed, 107 skipped**. They reproduced parent eligibility being revoked after
payload preparation but before issue POST/PUT. They now pass with combined source
verification. This extends the earlier recursive-parent/Epic coverage.

Final guarantee suite: **113 tests passed**. Additional cases exercise actual
initial and recurring queue consumers, an actual recovery heartbeat, source
selection changes after approval or during execution, no checkpoint advancement
on denied work, preservation of a prior valid create/field PUT, JQL added after a
caller's snapshot, both link endpoints, mapping conflicts, concurrent eligible
comments, late unsent fence rearming, Pause during scope reads and historical
read-only receipt repair. The JQL parser/search tests separately cover malformed
JSON, HTTP/network failures, warning/incomplete responses, pagination cycles and
bounded exhaustion, project moves, organization isolation and configuration drift.
No production source-selection, Pause, lease, fence or retry guard is mocked away.

Existing security fixtures were updated only to seed current organization/source
reads and both mapping directions required by the real guards. They still exercise
actual submission/transaction logic. The F07 valid-lease control includes the
additional source GETs; the lost-lease controls still prove zero mutation transport.

Earlier Package 1 evidence remains applicable: 13 original routing/initial-sync
failures and an enhanced-search-without-total failure were reproduced before the
initial fix. This follow-up preserves that issue routing/JQL/hierarchy work.

## Verification

| Check | Result |
| --- | --- |
| Guarantee Jest | 1 suite / 113 tests passed |
| Targeted security/synchronization Jest | 11 suites / 573 tests passed |
| Full Jest | 58 suites / 1070 tests passed; no snapshots |
| ESLint (`npm run lint`) | Passed |
| Secret scan (`npm run check:secrets`) | Passed |
| Local admin resource build | Passed; no UI source/dependency changes |
| Offline Forge validation | Passed; no errors, warnings or required approvals |
| Tracked and untracked diff checks | Passed |

Targeted command: `jest --runInBand tests/package1-outbound-guarantee.test.js tests/package1-outbound-scope.test.js tests/f02-comment-confidentiality.test.js tests/f03-inbound-scope.test.js tests/f05-retry-budget-pause.test.js tests/f06-comment-submission.test.js tests/f07-issue-lease.test.js tests/f08-manual-project-routing.test.js tests/attachment-sync.test.js tests/recurring-reconciliation.test.js tests/safe-initial-sync.test.js`.

Dependencies were reused from the existing local installation through temporary
symlinks, removed after verification. Generated build/cache files are ignored.
Parcel required filesystem access for its LMDB cache. Build warnings concern
existing outdated browser metadata; no dependency upgrade was made.

## Official platform contracts inspected

- [Enhanced issue search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
  and [search/reconcile](https://developer.atlassian.com/cloud/jira/platform/search-and-reconcile/):
  the shared key-constrained POST uses `issues`, `isLast`, cursor pagination and
  numeric `reconcileIssues` where available. No deprecated total-based fallback
  or new search retry was added. Search can be eventually consistent; reconcile
  improves consistency for specified IDs, not a cross-service transaction.
- [Issue links](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-links/):
  create identifies inward/outward issues and type; deletion affects that shared
  relation and permissions involve both endpoints. Requiring both local sources
  is this application's selection policy, not a claim that Jira evaluates JQL
  for link operations.
- [Custom Entity Store transactions](https://developer.atlassian.com/platform/forge/storage-reference/entities-transactions/):
  conditional operations commit/rollback together. Existing comment phase/marker
  release and lease transaction predicates were retained; no entity or migration
  was added.
- [Platform limits](https://developer.atlassian.com/platform/forge/platform-quotas-and-limits/):
  selection reads retain existing per-read/scope time bounds and pagination caps.
  More checks increase invocation/API usage; no new sleeps or write retry policy
  was introduced. Whole-invocation performance remains a controlled test gate.

The initial Package 1 create/edit and legacy Epic Link payload corrections remain;
no additional hierarchy API migration or new endpoint contract is introduced.

## Explicit limits and remaining integration requirements

No identified reachable production outbound writer is intentionally exempt from
current source selection. Disabled legacy bulk/manual-scheduled code and the
uncalled legacy upload helper are inventoried, not verified as active paths.
Inbound content and inbound post-create attachment recovery retain F03 policy and
are not described as local-JQL-protected paths. Local bookkeeping/review comments
are not outbound exports.

Offline tests cannot establish live search consistency, service permissions,
platform conditional-rejection codes, trigger delivery/retry behavior or end-to-end
latency. Before release, controlled integration validation must exercise:

- Real JQL changes and issue moves, including hierarchy references, link endpoints,
  both link directions and source reads/search during concurrent edits.
- Webhook, manual, scheduled, continuation and recovery paths with actual Jira
  permissions, public/restricted/reply comment policy and attachment limits.
- Pause/lease takeover during added asynchronous scope reads; unsent-fence release,
  receipt loss, SDK/storage failure and unknown upload/create/link outcomes.
- Initial/recurring job interruption and scope-change recovery with unchanged
  denied checkpoints and retained evidence of earlier valid partial writes.
- Deep hierarchy and comment/attachment batches under real invocation budgets,
  rate limits and search pagination/consistency. Legacy Epic editability still
  requires live metadata validation.

Authenticated Forge lint/install/runtime checks remain release gates. F07 migration
activation and deployment are outside this package and were not performed. Source
verification cannot prevent a change occurring after the final check and before
remote submission; the report makes no atomic-revocation or live-validation claim.

## Final Git status

**32 modified tracked files, 6 new untracked files, 0 staged files,
0 new commits.** HEAD remains the base above. Temporary dependency symlinks were
removed; generated build/cache output is ignored.

Modified tracked files:

- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/CONFIGURATION.md`
- `docs/OPERATIONS.md`
- `docs/SECURITY.md`
- `src/resolvers/data.js`
- `src/resolvers/sync.js`
- `src/services/scheduled/scheduled-sync.js`
- `src/services/sync/attachment-sync.js`
- `src/services/sync/comment-submission.js`
- `src/services/sync/comment-sync.js`
- `src/services/sync/counterpart-probe.js`
- `src/services/sync/initial-sync.js`
- `src/services/sync/issue-sync.js`
- `src/services/sync/link-sync.js`
- `src/services/sync/source-reconciliation.js`
- `src/services/sync/transition-sync.js`
- `src/triggers/link-deleted.js`
- `src/utils/retry.js`
- `tests/batch4-sync-path.test.js`
- `tests/batch8-issue-create-safety.test.js`
- `tests/batch8-pilot-blockers.test.js`
- `tests/batch9-link-sync.test.js`
- `tests/batch9-pending-link-retry.test.js`
- `tests/cross-reference-sync-safety.test.js`
- `tests/f05-retry-budget-pause.test.js`
- `tests/f06-comment-submission.test.js`
- `tests/f07-issue-lease.test.js`
- `tests/f08-manual-project-routing.test.js`
- `tests/issue-link-event-hotfix.test.js`
- `tests/pilot-write-retry-safety.test.js`
- `tests/safe-initial-sync.test.js`

New untracked files:

- `docs/PACKAGE1_F2_JQL_PROPAGATION_INVESTIGATION.md`
- `docs/PACKAGE1_OUTBOUND_SELECTION_GUARANTEE.md`
- `docs/PACKAGE1_SCOPE_ROUTING_REVIEW.md`
- `src/services/sync/outbound-scope.js`
- `tests/package1-outbound-guarantee.test.js`
- `tests/package1-outbound-scope.test.js`
