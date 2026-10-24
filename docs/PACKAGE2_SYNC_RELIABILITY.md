# Package 2 synchronization reliability

Baseline: `c00001aecc92b8f81e420c1788dec35876096f3d`.

## Invariants and entry points (defined before correction)

- B03: a genuine status-only change must change the source fingerprint in either
  direction; a connector echo with unchanged synchronized fields and status must
  still be suppressed. Source fingerprints and post-write destination reads use
  the same projection on each side, including status identity. Local issue
  triggers call `syncIssue`; signed remote issue events call the incoming issue
  handlers. Manual, scheduled, initial/reconciliation and recursive issue paths
  share the issue services and latest-accepted ordering. Transition routing,
  mappings, source scope, inbound authorization and lease checks remain mandatory.
- B04: one remote comment identity in one organization cannot submit another blind
  local POST after any prior submission may have reached Jira, even if all later
  receipt writes fail, replay markers expire, recovery runs or the destination
  mapping changes. A permanent create-if-absent claim precedes transport; it has
  no TTL and is never removed automatically. Confirmed destination identities may
  repair receipts/mappings without content writes. Unknown outcomes require
  reconciliation. A definitive parent-specific rejection alone permits the
  existing freshly verified top-level fallback inside the owning invocation.
  Signed comment webhooks and identifier-only F02 recovery use the same inbound
  handler. Outbound realtime, catch-up and recovery retain F06 unchanged.
- F-1: the legacy scheduled backstop must validate enhanced-search pages, follow
  opaque continuation tokens and persist an organization-scoped page/cursor.
  Budget interruption, unreadable results, failed/deferred issue work and storage
  errors must never be reported as complete. Persist a fetched page before
  processing it and advance only after the affected work completes, is known
  already current/unmapped, or is atomically retained as deferred work. Search
  coverage is separate from successful synchronization. Current selection, authorization and Pause are checked
  at execution; changed selection invalidates an old scan. Concurrent/stale scan
  workers cannot overwrite successor progress. The hourly trigger is active;
  manual legacy queue and bulk consumers remain disabled. Recurring reconciliation
  retains its existing separate cursor path and excludes the legacy scanner.

## Platform boundaries

- [Enhanced search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
  uses `nextPageToken` and `isLast`; no total or short-page inference. It is
  eventually consistent, not a transactional snapshot. Repeated full cycles
  remain necessary while issues change during a scan.
- [KVS create policy](https://developer.atlassian.com/platform/forge/storage-reference/kvs-api/)
  supplies `FAIL_IF_EXISTS`; a lost acknowledgement cannot authorize transport.
  Storage and Jira do not share a transaction. A fence without a receipt is
  uncertainty, not evidence that nothing happened.
- [Conditional transactions](https://developer.atlassian.com/platform/forge/storage-reference/entities-transactions/)
  provide ownership predicates for progress updates. Existing issue leases retain
  their migration gate; expiry grants no permission to repeat an uncertain POST.
- [Invocation limits](https://developer.atlassian.com/platform/forge/limits-invocation/)
  bound the 900-second scheduled handler. Processing reserves time for progress
  persistence and stops conservatively; platform hard termination can still occur.

Implementation evidence and real-integration requirements are recorded after
verification below. This work does not activate migrations or close Package 3.

## Implemented behavior

B03 now hashes both status name and instance-local status identifier in the source
and destination projections. The remote update marker is read after the status
transition, so it describes the destination's actual mapped status. The existing
transition implementation and ownership/authorization guards are unchanged. Old
hashes are not rewritten: short-lived echo markers expire normally; an old
latest-accepted hash at an identical timestamp may conservatively require conflict
review instead of being classified as a duplicate.

B04 uses the existing storage wrapper's `createIfNotExists` / `FAIL_IF_EXISTS`
operation. Claim identity is organization + direction + source comment ID; neither
issue-key changes nor destination remapping creates another submission identity.
Claim and positive receipt store bounded identifiers/state only. A receipt is
persisted before normal dedup/mapping bookkeeping. Recovery checks the recorded
source/destination scope and repairs only storage; it never exports content again.
Fresh confidentiality and current inbound scope checks precede both F02
submission markers and the permanent claim. A pre-claim scope denial consumes
neither boundary, so authorized redelivery remains possible. Scope is still
rechecked after claim persistence, and existing submission
checks still enforce Pause and the migration gate. Definitive parent rejection
retains its single verified fallback; unrelated 4xx, 429, 5xx, malformed success
and transport exceptions do not authorize fallback/replay. An unsent operation
blocked after claiming is conservatively fenced too; there is no automatic reset.

F-1 stores `scheduled-scan:<organization>` with exact remaining page keys, opaque
continuation, scope signature and explicit completion state. Oldest-updated issues
are considered first with a key tie-breaker. A changed organization selection,
direction, target or scheduled scope starts a new scan; changed configuration
while executing stops the old scan before its next item. Failed/deferred work
is atomically retained in a bounded queue while the primary search cursor
advances; this never updates an issue success checkpoint. The scheduler stays
update-only and retains the existing exclusion for recurring reconciliation.

Each invocation fetches at most 10 pages of at most 100 issues, with the existing
800-second processing cutoff inside the 900-second scheduled invocation. Search
reads use the existing bounded read helper, with no in-invocation search retry.
One scan is capped at 10,000 pages and keeps 20 recent token identities (each at
most 4,096 characters) for bounded cycle detection. Reaching a cap, invalid token,
invalid saved state or malformed/warning-bearing response leaves the scan
incomplete and requires inspection rather than silently restarting or completing.
An existing organization-scoped entity lease (`scheduled-search-v1` source scope)
serializes scan workers. Progress writes carry the owner predicate in the same
transaction. Issue writes inherit that lease context as well as their issue lease;
a stale worker cannot authorize writes or overwrite successor progress. Pending
link retries keep their existing source guards and now also honor the remaining
scheduler deadline. Stats expose `incomplete` and per-organization `scans` results,
including `scanComplete`, `deferredCount` and the bounded `deferredIssues` list.

The per-organization progress record retains at most 100 unique deferred keys.
Up to five pre-existing deferred issues are reconsidered per invocation, with no
attempt limit, expiry, dead-letter deletion or reliance on reappearing in search.
The queue survives scan completion and configuration/relative-window changes.
Current authorization, Pause and the existing shared write safeguards still apply
to every reconsideration. Only a confirmed successful/already-current or otherwise
explicitly resolved result removes an item. A deferred item encountered by primary
search advances only the page cursor through the existing owned transaction: its
queue position stays unchanged, and the encounter is not counted as a retry.
Only the dedicated deferred window rotates and attempts queued identities. Repeated
complete search pages therefore preserve retry progression through issues
1–5, 6–10, 11–15, 16–20, then repeat for a 20-issue queue.

Primary scanning and deferred reconsideration alternate priority across scheduled
executions. The next priority is persisted before slow work, and each retry moves
to the queue's tail in an owned transaction before execution. Thus a failing issue
that consumes a run's budget or exceeds its lease cannot monopolize either lane
or remain forever ahead of other unresolved work. Both phases retain the same
800-second cutoff and ownership checks. A bounded retry batch is not an N-attempt
abandonment scheme: deferred keys remain eligible on later invocations indefinitely.

Moving an item from the page into the deferred queue and advancing search coverage
is one conditional transaction. Failed persistence leaves the original page item
intact. If all 100 queue slots are occupied, a new unresolved item remains at its
saved page position and the scan reports `deferred-capacity`; successful later
reconsideration frees a slot. This explicit capacity backpressure can require
inspection if many issues remain unresolved, but never silently drops work or
reports a complete synchronization. Completed search coverage with any deferred
work still reports `complete: false`.

## Regression and verification evidence

Before production changes, the three affected suites ran **43 tests: 19 failed,
24 passed**. Four failures reproduced status/marker defects, four reproduced
inbound receipt/concurrency/repair defects and eleven reproduced incomplete
scheduled pagination. Two unchanged-status echo controls already passed. Additional
negative controls were added during implementation for SDK claim serialization,
stale ownership, storage acknowledgement loss, scope changes and invalid records.

Final deterministic verification (including final guarantee corrections):

| Check | Result |
| --- | --- |
| Full Jest | 61 suites / 1,135 tests passed; no snapshots |
| Package 1 guarantee suites (unchanged) | 2 suites / 134 tests passed |
| Affected issue/comment and new protocol/pagination suites | 4 suites / 81 tests passed |
| ESLint, secret scan, working-tree neutrality scan | Passed |
| CI configuration regression checks | Passed in full Jest; workflow unchanged |
| Admin build and existing UI regressions | Passed; browser-metadata age warnings only |
| Offline Forge validation | Passed; zero warnings/errors/required approvals |
| Working-tree diff checks | Passed; index empty |

Commands: `npm test -- --runInBand`, `npm run test:guarantees`, and
`npm test -- --runInBand --runTestsByPath tests/batch4-sync-path.test.js tests/batch9-comment-safety.test.js tests/package2-inbound-submission.test.js tests/package2-scheduled-pagination.test.js`;
`npm run lint`, `npm run check:secrets`, `npm run check:neutrality`,
`npm run check:forge:offline`, `npm run build` in `static/admin-page`, and
`git diff --check`.

The new SDK-boundary tests use the real storage wrapper and installed SDK
serializer; the local transport enforces documented create-if-absent behavior.
Scheduled tests use the existing manifest-derived transaction boundary and
explicitly bind basic storage. Existing scheduler fixtures were changed only to
supply documented `isLast` metadata and a basic-storage transaction fixture. No
source-scope, confidentiality, Pause, lease or claim guard was removed from
production. The two existing full-state echo assertions now include status.


## Final guarantee corrections

Two focused regressions failed against the reviewed Package 2 tree: a permanently
deferred head blocked the next eligible issue across runs, and scope revocation
during the pre-submission pause check consumed a permanent claim/F02 boundary
without a POST. Both now pass. Strengthening the starvation regression so every
failed attempt consumes 801 seconds also failed before alternating priority and
now passes: the later issue is still processed on the next primary-priority run.

Additional tests verify queue rotation without abandonment, reconsideration after
leaving a relative search window or changing scan scope, bounded capacity and
recovery, failed durable transfer, Pause, organization isolation and lease expiry
during retry. The pre-claim test restores authorization and proves redelivery
submits exactly once; existing revocation-during-claim, concurrent POST and
uncertain-receipt controls continue to pass. A claim already acquired before a
later revocation remains conservatively fenced; the immediate pre-POST scope
check was retained, not removed to obtain a green test.

This correction pass changes only `scheduled-scan.js`, the `postLocalComment`
pre-claim checks in `incoming-sync.js`, their two existing test files and this
report relative to the reviewed working tree. B03 implementation and tests are
unchanged. Offline validation reused the previously verified, unchanged admin
build; UI source was not changed in this pass. Targeted correction suites pass
48 tests; the broader four affected
suites pass 79 tests. Full verification includes all 1,133 tests and all 134
unchanged Package 1 guarantee tests.

## Repeated-page deferred-order correction (F-1)

A production-function regression seeded 20 deferred failures and returned the same
complete page on every execution. Before correction, 39 subsequent executions
retried only issues 1–10; issues 11–20 received no retry. The focused regression
failed on those missing retry identities. Primary processing was removing and
re-appending known deferred keys, undoing the dedicated retry window's rotation.

The correction advances the primary cursor for an already-deferred identity
without changing the deferred array or adding that encounter to retry accounting.
The existing ownership-checked `save` transaction remains the only persistence
path; bounds, retry window, priority alternation and write safeguards are unchanged.

After correction, the same regression verifies all 39 retry windows in exact
five-issue cyclic order. Eight more executions with the identical page selectively
recover issues 12 and 19: they leave the queue, all 18 failed identities remain
durable, search coverage continues, and deferred work never counts as a successful
synchronization. Queue size remains bounded. A separate race control changes lease
ownership immediately before the known-deferred cursor write and proves the entire
write is rejected: original page and queue stay intact and successor ownership
survives. Existing 100-key capacity/backpressure and recovery controls also pass.

Verification: 34 scheduled-pagination tests; 81 tests across the four focused
Package 2 suites; full Jest 1,135 tests / 61 suites; all 134 Package 1 guarantee
tests; ESLint, secret/neutrality scans, offline Forge validation and diff checks
passed. Offline validation uses the previously verified unchanged admin build.
B03 and B04 source and tests are byte-for-byte unchanged during this pass. Only
`scheduled-scan.js`, its existing pagination test file and this scheduled-scan
report changed relative to the submitted working tree. All live-integration limits
below still apply; no deployment or migration activation was performed.

## Exact changed files

| File | Change |
| --- | --- |
| `docs/PACKAGE2_SYNC_RELIABILITY.md` | Invariants, entry points, contracts and evidence |
| `src/services/sync/field-normalization.js` | Status identity in fingerprints |
| `src/services/sync/destination-state.js` | Include destination status |
| `src/services/sync/issue-sync.js` | Include source status; marker after transition |
| `src/services/sync/incoming-sync.js` | Include remote status; durable inbound comment path |
| `src/services/sync/inbound-comment-submission.js` | Permanent claim and positive receipt protocol |
| `src/services/scheduled/scheduled-sync.js` | Resume scanner; explicit incomplete results and deadline |
| `src/services/scheduled/scheduled-scan.js` | Validated bounded pages and owned progress |
| `tests/batch4-sync-path.test.js` | Status and echo regressions; matching marker assertions |
| `tests/batch9-comment-safety.test.js` | Receipt, redelivery, concurrency and guard regressions |
| `tests/package2-inbound-submission.test.js` | SDK-boundary claim/receipt controls |
| `tests/package2-scheduled-pagination.test.js` | Pagination, budgets, configuration, persistence and ownership |
| `tests/pilot-scheduled-safety.test.js` | Enhanced-search and transaction fixture |
| `tests/v2-1-rc3-cleanup.test.js` | Enhanced-search and transaction fixture |

## Remaining integration requirements and boundaries

- Tests simulate transport/storage; live Jira status mapping, webhook timing,
  permissions, SDK rejection shapes and conditional transaction behavior still
  require controlled integration validation and authenticated Forge lint.
- Enhanced search is eventually consistent. Pagination is not a stable snapshot;
  relative `recent` scope also moves with time. Validate token reuse across the
  hourly interval and concurrent issue updates. An unusable token deliberately leaves search progress incomplete for inspection.
  Unavailable/denied items remain visible and are reconsidered independently of
  search coverage; a saturated deferred queue applies explicit backpressure.
- Budget checks reserve time but cannot guarantee an in-flight external operation
  finishes before platform termination. Durable comment fences survive such
  termination. A persisted claim without a positive receipt requires manual
  reconciliation; expiry is never permission to POST again. Historical uncertain
  writes made before this protocol cannot acquire submission evidence retroactively.
- Local verification reused installed dependencies under Node 26.9.0; CI/runtime
  remain configured for Node 22. Temporary dependency links are removed after use.
- No UI source, dependency/lockfile, manifest/entity declaration, F06 outbound
  protocol, F07 activation gate, CI/release configuration or Package 3 code changed.
  No deployment, migration activation or live Jira/Forge data change was performed.

All Package 2 changes remain unstaged and uncommitted on
`fix/v2.1.1-sync-reliability` for independent review.
