# F06 — Durable outbound comment submission safety

Review date: 23 October 2026. Repository: `SerdarAbali/jira-sync-connector`.
Baseline and current HEAD: `a129a7203c66889cb0f48cd5e6cdd1cb8f2271fc`.
Branch: `fix/f06-comment-submission`.
Worktree: `/Users/serdar/Documents/Projects/jira-sync-project/f06-comment-submission`.
Implementation is deliberately uncommitted for independent Cline review.

Two independent reviews have rejected earlier revisions of this implementation.
The first rejection was the consumed-claim liveness defect (fixed by the phase
record); the second corrected two defects the next review reproduced: an
undeclared `comment-submission` Forge custom entity, and an F02 `write_started`
marker that stranded a provably unsent deferred comment. Both are documented in
[Correction pass 2](#correction-pass-2--two-reproduced-acceptance-failures); the
third reproduces and closes the ordering defect inside that second correction —
an ARMED phase that was published before F02's boundary was released — in
[Correction pass 3](#correction-pass-3--the-phase-and-the-f02-boundary-are-one-transition).
The duplicate-prevention and ambiguous-write protections of the accepted
protocol are unchanged by either correction.

## Root cause and affected production paths

`syncComment` checked comment mappings before creating an outbound Jira comment. Two deliveries could both read no mapping and POST independently. `syncAllComments` had the same gap, permitting realtime/catch-up races. Its prefix/partial-text comparisons were not reliable comment identities and have been removed. Existing connector echo detection is retained.

F02's `markDeferredCommentSubmission` returns without creating a fence when no deferred verification record exists. It therefore protected some recovery cases, but did not provide universal ownership for ordinary outbound comments. `executeWriteOnce` limits one invocation's transport attempts; it cannot prevent another delivery from posting again. Missing/malformed success IDs and mapping-save failures left those later deliveries without evidence of the earlier POST.

A later review found the opposite failure in the same protocol. Because the claim was permanent and carried no phase, a Pause or F07 lease failure raised after the claim but before the Jira request consumed the operation: every later delivery saw a fence and never submitted, so a comment could be lost with no destination write at all and no accurate reason code. The phase record and token-fenced re-arm described below close that liveness gap without allowing a second POST for anything that may have reached Jira.

Production entry points inspected:

- `src/triggers/comment.js:5` calls `syncComment` for realtime events.
- `src/services/sync/issue-sync.js:1007` and `:1370`, and `src/triggers/bulk-sync.js:407`, call `syncAllComments` for issue synchronization/catch-up.
- `src/triggers/initial-sync-recovery.js:47` dispatches outbound F02 recovery to `syncComment`.
- `src/services/storage/mappings.js:475` stores both comment mapping directions and metadata, using a transaction with individual-write fallback.
- Existing issue-create/attachment operation ledgers and F07 lease ownership, migration, context, and transport guards were inspected. Their expiry/retry mechanisms are not reused to authorize comment reposts.

## Submission protocol and guarantees

`comment-submission.js` derives a bounded SHA-256 key from organization, direction, source comment ID, and destination issue key. Source issue key is recorded for investigation, but is excluded from identity so source issue renames do not create a new fence. Organization normalizes null/legacy consistently across callers.

The existing `createIfNotExists` wrapper submits `kvs.set(key, value, { keyPolicy: 'FAIL_IF_EXISTS' })`. Only the invocation receiving an acknowledged successful creation may invoke the POST callback. No lock TTL, expiry takeover, or fence deletion exists; the only permitted state change is the token-fenced re-arm described below, which never deletes a record. Unknown storage errors fail closed; an acknowledgement lost after storage committed leaves the fence intact. Conditional conflict can only repair mappings from a confirmed destination receipt or return reconciliation required.

Basic KVS keys support only create-if-absent, so a claim alone cannot express the difference between "claimed, no request handed to the transport" and "a request may have started". `comment-submission.js` therefore keeps a permanent phase record per operation in the `comment-submission` custom entity. Both records survive; the claim is never deleted and only the phase may change, through `kvs.transact().set(key, value, { entityName, conditions })` with an owner token.

The entity is declared in `manifest.yml` under `app.storage.entities` with the
ten attributes the phase record writes (`orgId`, `direction`, `issueKey`,
`commentId`, `remoteKey`, `state`, `token`, `reason`, `createdAt`, `updatedAt`).
`token` and `state` are the attributes the transaction predicates filter on, and
no custom index is declared: every access is a keyed read or a conditional
transaction, which the automatic `by-key` index covers, so the manifest change
introduces no deploy-time indexing step
(`docs/F07-ISSUE-LEASE-DECISION.md:83` documents the same decision for
`issue-lease`).

| Phase | Meaning |
| --- | --- |
| `pre_submission` (ARMED) | The owner holds the claim and has proved that no request reached the Jira transport |
| `submission_may_have_started` (FENCED) | A request may have reached Jira; only a confirmed destination receipt may authorize mapping repair |

Fencing the phase is an atomic conditional update on `token` + `state`, so concurrent invocations cannot both proceed to the claim write; the loser only reads the receipt or returns reconciliation required. A failure raised by the guarded preflight/transport guards (Pause state, Pause read, F07 ownership, F07 migration) while the phase is FENCED and **before** the transport was reached re-arms that same phase from FENCED back to ARMED. A later authorized delivery then submits exactly once instead of losing the operation. Re-arm requires the owner token, the FENCED state, and the `beforeSend` hook of `guarded-api.js` never having run; the hook is invoked after all guards pass and immediately before the SDK request, so `transportStarted` is the only proof of "no attempt". Anything that may have reached Jira stays FENCED, and a fenced phase blocks redelivery even if the claim record were lost.

| Durable state | Allowed action |
| --- | --- |
| No claim and no phase; source checks or preflight failed | Safe to rerun all checks and attempt a new atomic claim; no submission began through this protocol |
| Phase `pre_submission` (ARMED) | Re-armable ownership: the owner proved no request reached the transport, so a later authorized delivery may still submit once |
| `submission_may_have_started`, no receipt | No automatic POST; inspect only. Under six minutes inspection reports `SUBMISSION_IN_PROGRESS`; after that, `INTERRUPTED_SUBMISSION` |
| Receipt `destination_confirmed` with validated string ID | Repair mapping storage using that exact ID; never POST again |
| Receipt `not_submitted` | A pre-transport rejection that was not re-armable (transport may have started, or the code is outside the allowlist); retain fence and require attention, with no automatic retry |
| Receipt `rejected` | Definitive HTTP 4xx rejection excluding 429; retain fence and require attention |
| Receipt `ambiguous` | Reconciliation/administrator attention only; never automatically repost |

The phase marks the earliest point at which submission may start, and re-arming is allowed only from proof that the transport was not reached in that invocation. There is no expiry-based takeover, no claim deletion, and no automatic reset of a FENCED phase into a new submission. A crash while FENCED, an ambiguous transport outcome, or a rejection still sacrifices automatic delivery for safety. Failures before any fence was committed remain resumable. This policy uses the transactional entity condition already available for F07 leases rather than an unsupported basic-KVS compare-and-swap.

The winning worker writes an immutable result receipt before saving mappings. If mapping persistence fails or partially succeeds, the receipt retains the exact destination identity. A ready subsequent delivery can repair mappings without another create. If receipt persistence itself fails, the original fence remains sufficient to prohibit another POST, but the identity may require administrator investigation.

Preflight uses the same F07 migration/Pause/ownership checks as the transport. The guarded Jira transport repeats those checks immediately before the actual SDK request. F07 migration defaults remain unchanged and blocked. F02 final fresh source/ancestor verification, known ancestry, throttling deadlines, deferred recovery markers, mapped-comment skips, and connector echo detection remain in place. F03/F05/F07/F08 production logic is otherwise unchanged.

Scope of guarantee: at most one automatic POST callback for a given permanent operation key within a single Forge installation/environment, assuming conditional KVS creation works as documented and records are retained. No claim is made that KVS, mapping writes, and remote Jira form one distributed transaction. No exactly-once delivery claim is made.

## Changed files and references

- `manifest.yml:148`: declares the `comment-submission` custom entity with the ten phase-record attributes (`manifest.yml:155` is the entity name), no custom index, and no change to the `issue-lease` declaration.
- `src/services/sync/comment-submission.js:17`: permanent phase entity (`pre_submission` / `submission_may_have_started`).
- `src/services/sync/comment-submission.js:22`: exported pre-transport guard allowlist shared with `comment-sync.js`.
- `src/services/sync/comment-submission.js:28`: scope validation/key derivation.
- `src/services/sync/comment-submission.js:100`: atomic conditional phase transition.
- `src/services/sync/comment-submission.js:116`: reads F02's boundary and returns the release plan; an unreadable boundary keeps the phase fenced.
- `src/services/sync/comment-submission.js:136`: token-fenced re-arm of a phase that provably never reached the transport, publishing the phase and the F02 release in one transaction (returning `ARMED`, `OWNERSHIP_LOST`, or `UNAVAILABLE`).
- `src/services/sync/comment-submission.js:150`: in-progress versus interrupted reason for a fenced operation without a receipt.
- `src/services/sync/comment-submission.js:188`: shared permanent claim, phase transition, receipt, mapping repair, and the combined re-arm/release in the pre-transport catch.
- `src/services/sync/comment-submission.js:309`: exact-scope read-only inspection, including the phase.
- `src/services/sync/comment-submission.js:322`: bounded, cursor-paginated inspection (default 25, maximum 100 records per call).
- `src/services/sync/comment-sync.js:25`: catch-up organization normalization and removal of text identity heuristics.
- `src/services/sync/comment-sync.js:109`: catch-up creation uses the shared protocol.
- `src/services/sync/comment-sync.js:323`: pre-transport guard codes become `COMMENT_RETRY` instead of the generic failure/attention path.
- `src/services/sync/comment-verification-recovery.js:147`: plans the release of `write_started` plus the `comment-verification-submission:` marker and stages both into the caller's transaction, so they commit with F06's phase change.
- `src/services/sync/comment-verification-recovery.js:199`: a duplicate that only observed a young fence keeps the F02 attempt pending instead of archiving it as an interrupted submission.
- `src/services/jira/guarded-api.js:27`: exports the existing submission guard for preflight and accepts a `beforeSend` hook that runs after all guards pass, immediately before the SDK transport.
- `tests/helpers/forge-manifest.js:1`: manifest reader for `app.storage.entities`, strict about syntax and untyped attributes.
- `tests/helpers/forge-lease-runtime.js:1`: Forge boundary now derived from the manifest (entity and attribute declarations, typed values, conditional filters) and able to model Key-Value Store transactions.
- `tests/f06-custom-entity-manifest.test.js:1`: declaration regression (entity, exact attribute set, no index, schema limits, production references).
- `tests/f06-comment-submission.test.js:1`: new production-path/SDK-boundary regression suite, including the F02 coordination scenarios and the undeclared-entity case.
- `tests/f02-comment-confidentiality.test.js:16`: storage test fixture adds persistent atomic creation for the new production dependency.
- `tests/batch7-pilot-pause.test.js:353`: expects no remote GET after removal of the text-deduplication read; POST prohibition is retained.
- This report contains the operational policy, verification evidence, and limitations.

## Red-to-green evidence

The first usable baseline run executed the initial 13 new F06 tests against the unchanged production implementation: **8 failed, 5 passed**. Failures were behavioral: concurrent realtime events and realtime/catch-up races issued **two** POSTs; timeout, missing ID, malformed JSON, malformed ID, and mapping failure all permitted **two** POSTs after redelivery. The final failure demonstrated that ordinary outbound processing never issued a permanent conditional claim.

The same initial tests passed after implementation. Nineteen further fault-injection and inspection cases were then added, resulting in **32 passing F06 tests**. Those additional boundary cases were not represented as baseline red failures.

### Liveness fix (claim consumed by a pre-transport failure)

A later review found that the single-claim protocol permanently consumed the operation when a Pause or F07 lease failure happened after the claim but before Jira was contacted. The scenarios below were added as failing tests first:

| Test | Baseline (claim consumed) | Final |
| --- | --- | --- |
| Lease loss after the claim is fenced but before submission delivers once, later | Operation stranded; later authorized delivery posts 0 times | Re-armed; exactly 1 POST |
| Pause activated after the claim is fenced but before submission delivers once, later | Operation stranded | Re-armed; exactly 1 POST |
| A replaced F07 owner does not submit, and a later authorized delivery delivers once | Stranded under the replaced owner's fence | Re-armed; exactly 1 POST |
| A young fence is in progress, so recovery retries instead of escalating | Escalated to attention with `INTERRUPTED_SUBMISSION` | Kept pending with `SUBMISSION_IN_PROGRESS`; 0 POSTs |

The baseline was reproduced by disabling only the fix in an otherwise identical tree (pre-transport failures applied unconditionally, `fencedReason` always returning the fallback, recovery escalating unconditionally): **4 failed, 34 passed of 38**. The final tree passes **38/38**. The remaining 34 tests, including "a phase is never re-armed once the transport may have received the request" and "an old fence still escalates to attention", pass in both trees and pin the safety half of the protocol.

Suite-wide verification on the final tree: `npx jest` → **54 suites, 847 tests passed**; `npm run lint`, `npm run check:secrets`, and `npm run check:forge:offline` are clean.

Tests exercise the actual `syncComment`, `syncAllComments`, F02 recovery, guarded transport, storage wrapper, and installed `@forge/kvs` 2.0.6 serializer/error handling. A local HTTP-edge model enforces atomic FAIL_IF_EXISTS rejection and models Jira responses. The partial-mapping case uses the actual mapping implementation, including its transaction failure/fallback. Tests do not merely mock the submission helper to agree with a new caller. Process crashes are represented by their durable storage boundaries, not by live process killing. No live Jira or Forge data was used.

## Correction pass 2 — two reproduced acceptance failures

### Defect 1 — undeclared Forge custom entity

`src/services/sync/comment-submission.js:16` used the `comment-submission`
custom entity while `manifest.yml` declared only `issue-lease`. Production
reads and every conditional transaction target that entity, so the reviewed
build depended on a declaration the deployment did not carry. Tests could not
see it because `tests/helpers/forge-lease-runtime.js` carried a hard-coded
allowlist (`['issue-lease', 'comment-submission']`): the local model accepted
exactly the name production used.

Correction:

- `manifest.yml` declares `comment-submission` with the ten attributes written
  by `operationRecord` and no custom index (see
  [Submission protocol and guarantees](#submission-protocol-and-guarantees)).
  Names, types, and counts stay inside the documented Forge limits (entity name
  `[_a-z0-9:.-]{3,60}`; attribute names `[_A-Za-z][_0-9A-Za-z]*`, at most 30
  characters; types `string|integer|float|boolean|any`; at most 50 attributes
  and 7 indexes per entity).
- `tests/helpers/forge-manifest.js` reads `app.storage.entities` and throws on
  syntax or an untyped attribute it does not understand, instead of silently
  parsing nothing.
- `tests/helpers/forge-lease-runtime.js` derives allowed entity names *and*
  attributes from that manifest. An entity read or transaction that names an
  undeclared entity, writes an undeclared attribute, writes a value of the
  wrong declared type, or filters on an undeclared attribute throws at the
  boundary. Key-Value Store (entity-less) transaction operations are modelled
  only when a suite links its basic store, so an entity-less operation cannot
  become a silent basic write, and `issue-lease` receives the same treatment.
- `tests/f06-custom-entity-manifest.test.js` pins the declaration: the entity
  exists, its declared attributes equal the phase-record shape exactly, no
  custom index is declared, both declared entities satisfy the Forge schema
  limits, and every custom entity referenced from `src/**` is declared (the scan
  resolves module constants such as `OPERATION_ENTITY`, not only literals).
- `tests/f06-comment-submission.test.js`: "an undeclared custom entity is
  rejected instead of silently working" renames the declaration in the
  boundary's manifest view. The entity read rejects, `syncComment` reports
  `COMMENT_RECONCILIATION_REQUIRED`, and **0 POSTs** occur.

Red-to-green, baseline = current tree with the declaration removed:
`tests/f06-custom-entity-manifest.test.js` → **4 failed, 2 passed of 6**
(entity not declared; attribute list; index list; the schema-limit `test.each`
collapsed to the single remaining entity). The behavioural side collapses as
well: with the manifest-driven boundary, "concurrent realtime deliveries create
once" produces **0 POSTs** instead of 1, because production cannot submit at all
against the reviewed manifest. Final tree: **7/7** manifest tests, **52/52**
F06 tests.

`npm run check:forge:offline` (which parses `manifest.yml` with the pinned
`@forge/manifest`) reports **0 errors, 0 approvals, 0 warnings**, and the check
is sensitive to this declaration: renaming `createdAt` to `created-at` in the
same tree fails with
`app storage entities property attributes should NOT have additional property 'created-at'`.
F07's `issueLeaseMigration:v1` record, its `entity-active` fixtures, and the
`issue-lease` declaration were not modified, and no migration was activated.

### Defect 2 — F02 `write_started` strands a provably unsent deferred comment

Reproduction (each step is now a regression test in
`tests/f06-comment-submission.test.js`):

1. An F02 deferred verification record exists and is due.
2. `markDeferredCommentSubmission` writes `state: 'write_started'` on that
   record and a `comment-verification-submission:` marker before the guarded
   transport runs (`src/services/sync/comment-sync.js:293`).
3. F06 has already fenced its claim (`submission_may_have_started`).
4. A Pause, a temporary Pause-state read failure, F07 lease loss, or a replaced
   F07 owner blocks the request inside the guards, i.e. before `beforeSend` ran.
5. F06 re-arms its phase to `pre_submission` (the accepted liveness fix).
6. Authorization is restored.
7. Recovery still sees `write_started` and the marker, so
   `assertCommentVerificationReady` throws `COMMENT_RECONCILIATION_REQUIRED`,
   `recoverCommentVerifications` archives the record as
   `comment-verification-attention:` with `interrupted-submission`, and the
   comment is lost even though nothing reached Jira.

Root cause: the two durable state machines were never coordinated. F06's proof
("no request reached the transport") only re-armed F06's own phase; F02's marker
is permanent by design, so the proof never reached it.

Correction — a coordinated release, with no new state machine and no new
migration:

- `comment-verification-recovery.js` exports
  `prepareDeferredSubmissionRelease(identifiers)`. It applies only to
  `direction: 'local-to-remote'` (the only direction F06 fences), returns
  `confirmed: false` without changing anything when a manual attention record
  exists, and plans a rewrite that drops `state: 'write_started'` while
  preserving scope, ancestry, parent ID, `createdAt`, `attempts`, and the
  throttle `notBefore`. It records `submissionReleasedAt` for auditability.
- The record rewrite and the deletion of the
  `comment-verification-submission:` marker are **staged into the caller's
  transaction** rather than committed on their own, so a partial commit cannot
  leave one half released, and — see correction pass 3 — the re-armed phase can
  never become visible before the boundary is gone.
- `comment-submission.js` calls the release **only** from its pre-transport
  catch and **only inside** the transaction that returns the phase from FENCED
  to ARMED (`rearm`). Every POST requires the FENCED phase, so a confirmed ARMED
  phase proves that no request for this scope reached Jira. No other code path
  can reach the release.
- The phase transition, the verification-record rewrite, and the marker deletion
  are one transaction carrying `token` + `state` predicates, so they commit or
  roll back together and a stale invocation releases nothing. The marker is
  never removed unconditionally: it is removed for one identity tuple only while
  the phase is provably its own, never after a receipt exists, never for inbound
  copies, and never when an attention record exists.
- `comment-sync.js` now reports every pre-transport guard code as
  `COMMENT_RETRY` (`PAUSE_STATE_UNAVAILABLE`, `LEASE_NOT_OWNED`,
  `LEASE_OWNERSHIP_UNAVAILABLE`, `LEASE_MIGRATION_REQUIRED`, in addition to
  `PILOT_PAUSED`) instead of the generic failure path. Without it, a *temporary*
  Pause-state read failure still escalated to attention after a successful
  release, because recovery treats any other
  `COMMENT_RECONCILIATION_REQUIRED` as ambiguous. The allowlist is exported from
  `comment-submission.js` as `PRE_SUBMISSION_CODES` and reused, so the set that
  authorizes a re-arm and the set that authorizes a retry outcome cannot drift.

Deliberately unchanged:

- Anything that may have reached Jira stays fenced: the release is unreachable
  once `beforeSend` ran, so an ambiguous transport outcome keeps both
  `write_started` and the marker and recovery escalates.
- Missing destination IDs, malformed success bodies, and mapping-storage
  failures keep their permanent fencing; the release runs before the request,
  never after it.
- F02 heartbeat recovery still processes at most three due records per run with
  five attempts and a 24-hour limit. A released record keeps its attempt count
  and throttle deadline, so a release cannot reset the retry budget.
- F03 scope authorization, F05 Pause checks, and F07 ownership/migration guards
  are untouched; a retry re-executes `syncComment` from the confidentiality
  verification stage and cannot skip them.
- The claim key remains permanent and is never deleted.

Partial failures and concurrency:

- A failed transaction is caught in `comment-submission.js` and reported as
  `CLAIM_REARM_UNAVAILABLE` (or `MARKER_RELEASE_UNAVAILABLE` when the boundary is
  unreadable or occupied by an attention record). Nothing is written, the phase
  stays FENCED with `write_started` intact, recovery escalates, and no POST
  occurs: fail-closed, liveness sacrificed, never duplication.
- There is no longer a window between the phase transition and the release: one
  transaction publishes both. A crash before it commits leaves the operation
  FENCED with `write_started` (escalated, no POST); a crash after it commits
  leaves exactly the retryable state a normal Pause leaves, which recovery
  completes. Both are safe because no request was ever sent.
- Concurrent recovery and redelivery stay serialized by the phase: a delivery
  must win the token-and-state predicate to reach the submit callback (the only
  place that writes `write_started`), so two workers cannot both hold it. A
  delivery that finds a young fence, or whose re-arm predicate was rejected,
  reports `SUBMISSION_IN_PROGRESS` and recovery keeps the record pending.

Red-to-green, baseline = tree at the time of pass 2 with the release call and the
`PRE_SUBMISSION_CODES` retry mapping removed (declaration intact): **6 failed,
41 passed of 47** F06 tests. The failures are exactly the new scenarios, and the
probe "a Pause after the claim does not strand a deferred comment" fails as
`Expected length: 1 / Received length: 0` — the comment is permanently stranded
after authorization returns. Final tree after pass 3: **52/52**. Two tests pass
in both trees because they pin fail-closed behavior: "a failed phase-and-boundary
transaction leaves both stores fenced" and "an ambiguous outcome keeps the
deferred marker and never replays".

## Correction pass 3 — the phase and the F02 boundary are one transition

Defect (reproduced by the Codex review): the pass-2 correction published F06's
retryable phase and F02's released boundary in two commits, phase first. Two
deliveries can then interleave as follows:

1. B passes its F02 readiness check (`assertCommentVerificationReady` in
   `comment-sync.js`) while the record is still retryable, and is suspended
   before it reaches the F06 fence.
2. A fences the claim, writes `write_started` + the marker, and the guarded
   transport refuses the POST (Pause or lost F07 ownership).
3. A re-arms: the phase becomes `pre_submission` and is now consumable by B.
4. B reads the ARMED phase, transitions it to FENCED, and calls
   `markDeferredCommentSubmission`, which still sees A's `write_started` — so it
   throws `COMMENT_RECONCILIATION_REQUIRED`. B writes a `not_submitted` receipt
   with `PRE_SUBMISSION_GUARD_BLOCKED`, recovery archives the record with
   `interrupted-submission`, and the comment is fenced permanently **without any
   Jira POST**.
5. A finishes the release, which can no longer help: the phase is FENCED forever.

Root cause: the ARMED phase is a consumable capability, and the pass-2 correction
treated it as if it could be published before the state it depends on. Two stores
were updated in sequence for one logical transition.

Correction — one logical transition, one transaction (no new storage, no new
record type, no new state):

- `prepareDeferredSubmissionRelease(identifiers)` reads the boundary and returns
  a **plan**: `{ status, confirmed, stage(transaction) }`. It writes nothing.
  `confirmed: false` (an attention record exists, or the direction is not an
  outbound copy) means the caller must keep the phase fenced.
- `rearm(key, record, release)` builds one `kvs.transact()` request that sets the
  claim to `pre_submission` under its `token` + `state` predicates, then stages
  the verification-record rewrite and the marker deletion into the same request.
  Forge commits entity and Key-Value Store operations of one transaction
  atomically, so either the phase and the boundary both change, or neither does.
  There is no longer an instant at which the phase is ARMED while a stale marker
  exists, and a crash cannot split the transition.
- Ownership is enforced by the predicate, not by a second read: a stale
  invocation's transaction is rejected as a whole, so it releases **no** marker
  and leaves the successor's operation untouched. `rearm` now reports
  `ARMED` / `OWNERSHIP_LOST` / `UNAVAILABLE`; the pre-transport catch maps a
  rejected predicate to `SUBMISSION_IN_PROGRESS` (recovery keeps the record
  pending, no escalation) and a storage failure to `CLAIM_REARM_UNAVAILABLE`
  (fail-closed escalation). The claim-storage-failure path keeps its previous
  behaviour.
- A boundary that cannot be read or must not be released is reported as
  `MARKER_RELEASE_UNAVAILABLE` and the phase stays FENCED: publishing ARMED
  without the release would be exactly the defect above.

Invariants preserved: token/state ownership checks, atomic submission claims,
`write_started` is never cleared once the transport may have started, no new
storage architecture, F02 ancestry/confidentiality, F05 Pause, F07 leases, and
ambiguous-write fencing. The claim key is still permanent and never deleted.

Red-to-green evidence (new tests in `tests/f06-comment-submission.test.js`):

- `a concurrent delivery never observes an armed phase with an old marker`
  suspends B in `getFullComment`, resumes it from a test hook the instant the
  `pre_submission` transaction commits, and asserts one POST. On the pass-2
  ordering it fails with `Expected length: 1 / Received length: 0` — Codex's
  defect reproduced deterministically, no timing dependence.
- `a stale invocation publishes nothing once the phase is no longer its own`
  steals the phase after A wrote its boundary: the outcome is
  `SUBMISSION_IN_PROGRESS`, zero POSTs, the successor's phase and the marker are
  untouched, and recovery keeps `lastOutcome: SUBMISSION_IN_PROGRESS` instead of
  archiving. On the pass-2 ordering the whole release happened and the outcome
  was `CLAIM_REARM_UNAVAILABLE` (escalation), so the test fails there.
- `the phase and the boundary commit in one transaction with an ownership
  predicate` asserts the single `/api/v1/transaction` request that carries the
  entity `set`, the verification-record `set`, the marker `delete`, and the
  token/state conditions — it fails if anyone re-splits the writes.
- `overlapping Pause failures still submit once after authorization returns`
  pins eventual single submission when both interleaved deliveries are refused.
- `a failed phase-and-boundary transaction leaves both stores fenced` and
  `a manual attention record keeps the deferred boundary out of reach` pin the
  fail-closed edges (FENCED phase, marker intact, `write_started` archived, no
  POST).


## Required scenarios

All scenarios below pass in the F06 suite; inherited confidentiality/scope behavior is also covered by the existing regression suites.

| Required scenario | Evidence/result |
| --- | --- |
| Two concurrent outbound events | Exactly one POST |
| Realtime races catch-up | Exactly one POST |
| Destination accepts POST but response times out | One POST across repeated delivery; ambiguous receipt |
| Success missing/malformed ID or JSON | One POST; `INVALID_SUCCESS_RESPONSE` |
| Mapping persistence fails after accepted POST | One POST; confirmed ID retained and mapping repair succeeds |
| Partial real mapping persistence | Both directions repaired with no second POST |
| Crash/failure before any claim commits | No POST; subsequent invocation can claim and submit |
| Pause or F07 failure after the claim, before the transport | Phase re-armed; no POST in that invocation, exactly one POST for a later authorized delivery |
| Crash immediately before POST after a durable claim | Stored permanent fence blocks all redelivery/catch-up POSTs |
| Crash after submission may have started | Same permanent fence; no expiry-based retry |
| Claim acknowledgement lost after storage commit | No worker submits; permanent attention state survives |
| Receipt persistence fails after POST | One POST; fence alone prevents repost |
| Worker resumes after lease expiry | Preflight or transport rejects; only a proven-zero-attempt phase is re-armed |
| F07 owner replaced during claim acknowledgement | Transport ownership check rejects; no POST, and the abandoned phase is re-armed for the authorized owner |
| Deferred F02 recovery races ordinary processing | Shared claim permits at most one POST; a duplicate that observed a young fence stays pending rather than escalating |
| F02 deferred comment, Pause after the claim, Resume | F02 record released to pending and marker removed; exactly one POST afterwards (heartbeat recovery and ordinary redelivery) |
| F02 deferred comment, lease loss after the claim, restored ownership | Released on proof of no attempt; exactly one POST under restored ownership |
| Replacement F07 lease owner during a deferred submission | Stale worker: 0 POSTs, marker released; new authorized delivery: 1 POST |
| Temporary Pause-state read failure (`PAUSE_STATE_UNAVAILABLE`) | Released and kept pending; eventual single POST, no attention record |
| Concurrent recovery and redelivery of a released deferred comment | Exactly one POST across three concurrent callers |
| Delivery suspended between the F02 readiness check and the F06 fence while another worker re-arms | Exactly one POST; the resumed delivery never observes an armed phase with a stale marker (fails on the two-commit ordering) |
| Stale invocation whose phase predicate no longer matches | Nothing published: `SUBMISSION_IN_PROGRESS`, successor's phase and marker untouched, 0 POSTs, no attention record |
| Failed or rejected phase-and-boundary transaction | Fail-closed: FENCED phase retained, marker retained, attention record, 0 POSTs on redelivery |
| Storage failure while releasing the F02 marker | Fail-closed: marker retained, attention record, 0 POSTs on redelivery |
| Ambiguous transport outcome with a deferred record | Marker and phase retained permanently; attention record; no replay |
| Restricted ancestor after a re-arm | 0 POSTs; no attention record |
| Undeclared custom entity | Boundary rejects the entity read/transaction; 0 POSTs; reconciliation required |
| Already mapped comment receives update | Existing skip behavior retained; no create POST |
| Distinct comments and organizations | Four independent scoped operations produce four POSTs |
| Pause before submission / after claiming | No POST in either window; a Pause detected before the claim leaves no claim or phase, and one detected after the claim re-arms the phase for exactly one later authorized POST |
| Missing F07 migration activation | No POST; no activation performed |
| Restricted parent/reply ancestry | No destination POST; full F02 suite remains green |
| HTTP 400/403 versus 429/500/503 | Definitive rejection distinguished from ambiguity; none blindly reposts |
| Same text on distinct comment identities | Does not suppress the distinct source comment |
| Attention pagination/exact lookup | Bounded, read-only, cursor-capable; no destination writes |

## Reconciliation and administrator handling

No automatic reconciliation POST is provided. `COMMENT_RECONCILIATION_REQUIRED` is returned with a bounded reason code. Realtime processing also records existing webhook telemetry for that outcome. The permanent fence is the durable fallback even if subsequent status/telemetry persistence fails.

For operational inspection, use the internal read-only `inspectCommentSubmission(scope)` helper for an exact organization/source/destination, or page through `inspectCommentSubmissions({ limit: 25, cursor })`. Each page performs one query and at most 100 result reads. The six-minute age label is a review threshold, never lease expiry or permission to repost. These are internal operational helpers, not new unauthenticated resolvers or an admin UI.

- `destination_confirmed`: the stored exact ID supports mapping repair; ordinary redelivery performs it after existing guards/checks permit processing. F02 write-started/attention records can conservatively block that automatic repair; the receipt remains available for review.
- `INVALID_SUCCESS_RESPONSE`, `AMBIGUOUS_TRANSPORT`, `AMBIGUOUS_HTTP_RESPONSE`, or `INTERRUPTED_SUBMISSION`: inspect destination history and reliable source-to-destination evidence. Comment text, prefixes, authors, or timestamps alone are not accepted as identity proof. If identity cannot be established, keep the operation blocked. `SUBMISSION_IN_PROGRESS` means the fence is younger than six minutes: re-inspect rather than escalating while the owning delivery may still finish.
- `PRE_SUBMISSION_GUARD_BLOCKED` or `DESTINATION_REJECTED`: resolve the cause, but do not delete the fence to induce an automatic repost. A Pause or F07 ownership failure that provably happened before the transport was reached is re-armed automatically, so it does not produce this receipt; the receipt means the proof was unavailable. This implementation deliberately supplies no automatic retry/reset for a FENCED phase.
- `MAPPING_STORAGE_UNAVAILABLE`: the confirmed receipt survives and a later permitted delivery may repair mappings. `RECEIPT_STORAGE_UNAVAILABLE` and `RESULT_STORAGE_UNAVAILABLE` require inspection of the permanent fence/receipt without another POST.
- `CLAIM_STORAGE_UNAVAILABLE`: no optimistic POST occurred in that invocation. Inspect storage; a committed claim may exist despite an unacknowledged write. Redelivery may only proceed if conditional creation actually succeeds.

Any future administrator mutation to bind an independently verified destination ID must use an authorized, separately reviewed maintenance path. This change adds inspection and safe automatic repair from recorded receipts; it does not add a new manual reset/bind endpoint. No maintenance action was performed during this task.

Records contain only organization/direction, comment/issue identifiers, bounded state/reason/status values, a random 32-byte fencing token, and timestamps. They contain no comment bodies/snippets, authors, email addresses, URLs, or credentials. The token is an opaque ownership nonce, never a credential, and it is stripped from inspection output.

## Official Atlassian references

Reviewed against official documentation, 23 October 2026:

1. [Forge KVS set options](https://developer.atlassian.com/platform/forge/storage-reference/kvs-api/): FAIL_IF_EXISTS prevents overwriting an existing key. The existing wrapper uses this supported option, with no TTL.
2. [Forge KVS atomicity and partitioning](https://developer.atlassian.com/platform/forge/storage-reference/kvs/): individual-key writes are atomic; data belongs to an installation/environment. This protocol does not coordinate independent installations.
3. [KVS transactions](https://developer.atlassian.com/platform/forge/storage-reference/kvs-transactions/): all-or-nothing batches of basic `set`/`delete` operations. F02's marker release uses one such transaction for its record rewrite plus marker deletion; storage batches still do not include external Jira writes, and basic KVS transactions are not treated as arbitrary conditional compare-and-swap.
4. [Custom Entity Store transactions](https://developer.atlassian.com/platform/forge/storage-reference/entities-transactions/): documents the conditional operations used by the existing F07 leases and by the F06 phase record (`token` + `state` conditions on a single entity key). F06 adds no migration and activates none.
5. [Jira Cloud issue comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/): Add comment returns a Comment on successful creation, with an ID; comment access depends on project/security/visibility permissions. The documented create operation supplies no cross-site transaction or general exactly-once guarantee.
6. [Comment properties](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comment-properties/): structured properties exist, but this implementation does not assume uniqueness or atomic coordination with Forge, and does not infer identity from text.
7. [Defining custom entities](https://developer.atlassian.com/platform/forge/storage-reference/entities-manifest/): `app.storage.entities` syntax, allowed attribute types (`string`, `integer`, `float`, `boolean`, `any`), naming/length limits, the automatic `by-key` index, and the deploy-time custom indexing step. The `comment-submission` declaration was checked against these rules and uses no custom index, so no indexing step is introduced.

## Genuine limitations

- A FENCED operation can still strand when the pre-transport proof is unavailable: a crash while FENCED, a Pause or lease failure raised after the transport hook fired, a non-allowlisted error code, or a lost claim acknowledgement. This is intentional at-most-once safety; automatic eventual delivery is not guaranteed for those cases.
- Re-arm depends on the process observing its own failure. If the invocation dies between fencing and recording the failure, the phase stays FENCED and the operation requires inspection even though no request was sent.
- The F02 release is part of the re-arm transaction, so it has no window of its own: if that transaction commits, both halves are released; if the process dies first, both stay fenced and recovery escalates with no POST. What F02 cannot repair on its own is a record left behind by an older build that already split the two commits (or by an invocation that died before this correction existed); those require the reconciliation path, because the F02 identifiers do not include the destination issue key needed to locate the F06 phase.
- An unreadable F02 record, an existing attention record, or a transaction that is rejected or fails makes the re-arm a no-op that keeps the phase FENCED. The comment then requires manual reconciliation even though nothing was sent; automatic liveness is deliberately not traded for a weaker proof.
- Records must remain durable. Deleting fences, reinstalling with lost storage, or running unrelated installations can bypass the installation-local guarantee. They have no TTL; retention/storage growth requires operational planning.
- Identity assumes stable organization-to-site configuration and destination issue key for an operation. Changing configuration, routing, or renaming a destination while an unmapped ambiguous operation exists requires review of its original recorded scope before enabling writes under a new scope. This patch does not introduce globally immutable Jira destination IDs.
- Existing confidentiality/Pause/lease checks and the Jira request are separate calls. No cross-site atomicity is invented for changes occurring after the final check, nor can a local lease revoke a request already sent to Jira.
- A mapping may already exist after partial persistence; existing mapped-comment behavior can skip repair on later delivery. Durable receipts permit investigation; no new broad mapping-repair scheduler is introduced.
- Old comments already created without mappings/fences before this patch are not retrospectively matched by text. Review legacy ambiguous copies before rollout; they cannot be reliably deduplicated without trusted identity evidence.
- Attention inspection is internal tooling; no new administrator UI/reset endpoint is included. SDK-boundary tests model documented behavior and do not replace live platform validation. Authenticated Forge lint/deployment remains a future release gate; neither was run.
- UI build emitted existing outdated Browserslist/Baseline dataset warnings; dependency versions were not changed.

## Final validation and Git status

Validation of the corrected tree (correction pass 3 included):

- F06 behaviour: **52/52 passed**, including the concurrency interleaving, ownership-loss, and single-transaction regressions added by pass 3.
- F06 custom-entity manifest regression: **7/7 passed**.
- F02: **170/170 passed**, including source-client confidentiality, inherited restrictions, known ancestry, catch-up, deferred recovery, and actual recovery heartbeat dispatch.
- F03: **58/58 passed**.
- F05: **18/18 passed** across retry-budget/Pause and write-recovery suites.
- F07: **32/32 passed**.
- F08: **8/8 passed**.
- Existing Batch 9 comment-safety suite: **7/7 passed**.
- Full Jest run: **55 suites, 868 tests passed; zero failures or skipped tests**.
- ESLint (`npm run lint`): passed, no warnings/errors.
- Repository secret scan (`npm run check:secrets`): passed for tracked files, and repeated with the new untracked files staged as intent-to-add so the repository scanner covered them; the index was restored afterwards.
- Offline Forge check (`npm run check:forge:offline`): **0 errors, 0 approvals, 0 warnings**, and verified to reject an invalid entity attribute in the same tree.
- Whitespace: `git diff --check` clean.

Remaining authenticated/live Forge validation (not run, no credentials used):

1. `npm run check:forge` (`forge lint`) authenticated against the app.
2. A deploy that creates the `comment-submission` entity and confirms the
   `storage:app` scope covers it. No custom index is declared, so
   `forge storage entities indexes list -e <environment>` is expected to report
   only the automatic `by-key` index; the entity must be ACTIVE before relying on
   the phase record in a real tenant.
3. A live same-tenant check that (a) a conditional transaction on `token` +
   `state` succeeds, (b) a non-matching condition is rejected with the error
   code `isKeyConflictError` recognises, and (c) a Key-Value Store transaction
   containing `set` + `delete` commits atomically and is reported as an
   `Unexpected entity`-free request by the running platform.
4. A live Pause/lease-loss cycle on a test comment to confirm the release path
   end to end (exactly one destination comment).

Final changes (all unstaged/uncommitted):

```text
 M docs/SECURITY.md
 M manifest.yml
 M src/services/jira/guarded-api.js
 M src/services/sync/comment-sync.js
 M src/services/sync/comment-verification-recovery.js
 M tests/batch7-pilot-pause.test.js
 M tests/f02-comment-confidentiality.test.js
 M tests/helpers/forge-lease-runtime.js
?? docs/reviews/F06-comment-submission.md
?? src/services/sync/comment-submission.js
?? tests/f06-comment-submission.test.js
?? tests/f06-custom-entity-manifest.test.js
?? tests/helpers/forge-manifest.js
```

Dependency directories and UI build/cache artifacts are ignored local verification aids. Dependencies are linked read-only for use from the existing installation; no dependency versions/lockfiles were changed. Existing worktrees and original duplicate files were left untouched. `main`, `v2.1.0`, and prior F02/F03/F05/F07/F08 history were not changed. No commit, push, merge, release, deployment, migration activation, or live Jira/Forge data modification occurred.
