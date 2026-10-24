# Package 1 F2 — pre-implementation outbound JQL propagation investigation

Historical findings below describe the state before F2 enforcement. The subsequent
implementation and verification are recorded in [the Package 1 report](PACKAGE1_SCOPE_ROUTING_REVIEW.md),
under [the outbound selection guarantee](PACKAGE1_OUTBOUND_SELECTION_GUARANTEE.md).
Line numbers and open-gap statements below are historical evidence, not claims
about the completed implementation.

Date: 2026-10-24 (Europe/Helsinki). Read-only production-code investigation;
no F2 implementation, live Jira request, deployment, or migration activation.
Line references describe the current uncommitted Package 1 worktree.

## Decision and documented contract

**F2 must be addressed before declaring Package 1's outbound source-selection
guarantees complete.** The issue create/update boundaries are protected, but
independent content writers do not consistently reevaluate JQL. Existing mappings
are historical relationships, not continuing source-selection authorization.
This is a confidentiality and correctness gap regardless of which files Package 1
originally changed. Acceptance for a development commit is not acceptance of a
complete source-selection guarantee or a release decision.

The repository describes an optional organization JQL as a restriction in addition
to approved local projects: README.md:129–131; docs/CONFIGURATION.md:34–44;
docs/SECURITY.md:41–53 and :96–103. docs/ARCHITECTURE.md:49 and :210 even say that
trigger handlers/every path apply it. These describe continuing outbound source
selection, with no documented mapping-based exemption for comments, replies,
attachments, or relationships. Therefore those exports must respect JQL too.
The existing docs/OPERATIONS.md:226 statement that mapped manual updates only
use project scope is stale for the Package 1 issue update implementation; it is
not a general exemption for independent content writes.

JQL is not a standalone security boundary and is not an inbound destination
permission. F03's inbound project policy and remote-side webhook JQL remain
separate. The above broad README/architecture statements are not evidence that
all paths are protected. They need correction or qualification before release;
the Package 1 handoff now explicitly limits its claims.

## Reachable production paths and explicit code evidence

Manifest trigger/consumer registrations and src/index.js exports establish the
following reachability. All remote mutations still require existing Pause,
migration, and applicable lease guards; those guards do not evaluate selection
(services/jira/guarded-api.js:8–24). This report does not claim these gates are
bypassed. Paths below are conditional on their normal configuration and mappings.

### Comments and replies

1. `avi:jira:commented:issue` → index.runComment → triggers/comment.js:3–5 →
   services/sync/comment-sync.js:144 `syncComment` → :290 `submitOutboundComment`
   → :294 `executeWriteOnce` → remote POST `/issue/{remoteKey}/comment`.
   `syncComment` fetches the issue (:172), checks options (:254), approved project
   (:261–265), and mapping (:267). The project helper in utils/validation.js:127
   only compares `allowedProjects`; it never evaluates JQL.
2. Hourly index.runInitialSyncRecovery → triggers/initial-sync-recovery.js:39–47
   → `recoverCommentVerifications` → the same `syncComment(event, record.orgId)`.
   Retained identifiers do not cause a new JQL check on recovery.
3. Issue webhook/manual/initial/reconciliation/scheduled issue processing →
   issue-sync.js create :955 or update :1321 → comment-sync.js:25
   `syncAllComments` → :109 `submitOutboundComment` → :113 `executeWriteOnce`
   → the same remote comment POST. These calls inherit an earlier issue scope
   check (:557/:813 or :1202); the comment service has no independent JQL check.
   An issue/configuration change during comment iteration can outlive that check.

Both comment entry points verify current comment visibility and ancestor
confidentiality, exclude connector-generated content, and re-read before sending.
Replies use the same path and embed verified parent author/snippet context
(comment-sync.js:345–399), not a separate protected writer. Those comment-specific
checks do not check issue JQL. `submitOutboundComment` (:188–260) enforces
submission claims, fencing, and transport outcomes; it has no source-selection
check either. No outbound comment edit/delete writer was found in the production
mutation inventory; these paths copy missing comments/replies.

### Attachments (upload, continuation, deletion)

1. `avi:jira:created:attachment` → index.runAttachment → triggers/attachment.js:27
   → :67 `syncAttachments` → attachment-sync.js:541 → common sync engine
   (:447–538) → per-file upload (:289–443) → :389 `uploadAttachmentContent`
   → attachment-client.js:393–407 remote POST `/issue/{remoteKey}/attachments`.
   The trigger checks a freshly read project's allow-list (:47–55); the engine
   checks the passed issue/project against passed config (:479–487). Neither
   evaluates JQL or calls `assertOutboundScope`.
2. The same engine is called by issue-sync.js:924/:1292 after an earlier issue
   check. Remaining IDs are queued by attachment-sync.js:217–243/:508.
   Manifest attachment-sync-consumer → index.runAttachmentSyncQueue →
   attachment-sync.js:825–890 loads current org/options and local issue, then
   calls `syncAttachments`. This independent continuation again checks project
   and mapping, not JQL. An earlier eligible parent invocation does not authorize
   later queued uploads after JQL eligibility/configuration changes.
3. `avi:jira:deleted:attachment` → the same trigger :79
   `propagateAttachmentDeletion` → attachment-sync.js:594–670 →
   attachment-client.js:456–472 remote DELETE `/attachment/{mappedId}`.
   This requires attachment sync and deletion propagation enabled, the mapped
   issue pair and direction-scoped attachment mapping, and write guards. The
   trigger checks project; the outbound deletion engine itself has no project
   or JQL recheck. Inbound branches do call `assertInboundScope`, which does not
   supply outbound selection.

Canonical metadata/content reads, size/type/filename validation and operation
ledgers remain useful independent controls. They do not establish JQL eligibility.
The post-create attachment recovery in post-create-attachments.js is expressly
`remote-to-local` (:10), so it is not an independent outbound JQL bypass.

### Issue links (creation, pending work, deletion)

1. `avi:jira:created:issuelink` → index.runLinkCreated → triggers/link.js:5–75
   resolves both endpoints and calls `syncIssue` on target then source. Selected
   source create/update → issue-sync.js:940/:1312 → link-sync.js:117
   `syncIssueLinks` → :230–240 remote POST `/issueLink`.
   It checks link mapping and the linked issue's remote mapping (:145/:176),
   but never current JQL/project selection for that linked local endpoint. Thus
   even a currently selected root can export its relationship to a previously
   mapped, now excluded endpoint. A rejected target `syncIssue` does not erase
   its old mapping or prevent the later selected source path.
2. Successful issue creation → issue-sync.js:899
   `processPendingLinksForNewlySyncedIssue` (:238–288) → :265
   `createLinkOnRemote` → link-sync.js:69–104 remote POST `/issueLink`.
   It filters org and looks up the pending source mapping, without reevaluating
   that source's current selection. The newly created endpoint was checked;
   the other endpoint was not.
3. Hourly index.runScheduledSync → triggers/scheduled.js → scheduled-sync.js:371
   `performScheduledSync` → :650 `retryAllPendingLinks` (:64–320) → :235 remote
   POST `/issueLink`. Also the admin `retryPendingLinks` resolver in
   resolvers/sync.js:126–158 directly calls the same retry service.
   `retryAllPendingLinks` iterates the persisted pending index and both mappings;
   it does not fetch either current local issue or evaluate JQL. The scheduled
   search (:518–550) limits the main issue loop, not this pending index. Zero
   search matches still permit pending-link processing after the loop, provided
   legacy scheduled configuration is enabled/valid and recurring reconciliation
   has not superseded that org's legacy run (skip gate :360–369).
4. The main scheduled update also directly calls `syncIssueLinks(..., true)`
   (:615), after an issue update. It inherits an earlier root selection but
   supplies no new endpoint selection check.
5. `avi:jira:deleted:issuelink` → index.runLinkDeleted →
   triggers/link-deleted.js:5–119 → remote DELETE `/issueLink/{matchingLink.id}`.
   It reads both local keys, gets both remote mappings and matches the remote
   relation, then checks Pause. It checks neither local project allow-list nor
   configured JQL. The guarded transport adds no selection check.

### Other outbound mutations and exclusions

- Remote issue fields and post-create remote descriptions: issue-sync.js:846
  create POST is preceded by scope verification :813 (before the operation
  claim/submission marker); :998/:1063/:1551 PUT callbacks recheck scope at
  :999/:1064/:1552. Recursive parent/Epic checks are :207/:691/:1443. These are
  the Package 1 protections; F1 corrects only their retry error classification.
- Status: issue-sync.js:902/:1661 → transition-sync.js:10 → :76 remote transition
  POST. Only issue create/update production callers were found. They inherit
  prior selection checks, but the transition's own reads and submission do not
  reevaluate selection. Selection may change between field/create and status
  submission. Status can itself change JQL membership.
- Counterpart notices: local deletion → triggers/issue-deleted.js:67 →
  counterpart-probe.js:145 `setCounterpartNotice` → :72 `updateRemoteDescription`
  → :98 remote description PUT. Recovery admin remap/end/dismiss/replace actions
  (resolvers/recovery.js:58–113 → counterpart-recovery.js:104/:400/:452/:495)
  clear survivor notices through counterpart-probe.js:163 and the same PUT.
  Neither remote notice writer evaluates JQL or project selection. Added notices
  contain issue keys/deletion status (utils/adf.js:367); cleared notices preserve
  the rest of the remote description. This is an independent metadata mutation,
  not a new copy of local description text. A deleted local source cannot be
  revalidated using a fresh issue/JQL query; an explicit policy is needed.
- Remote issue replacement uses counterpart-recovery.js:184 `createIssueForOrg`,
  so it goes through the protected create boundary, including content follow-ups
  with the caveats above. Hard counterpart issue deletion is disabled; the local
  issue-deleted trigger records status/notices and optional replacement instead.
- Local cross-reference description writes are local bookkeeping, not exports.
  Inbound local field/status/comment/link/attachment writes are outside outbound
  JQL and retain F03's policy. No independent outbound worklog, watcher, vote,
  label or other content writer was found: fields flow through issue-sync.js.
- Legacy bulk missing-data calls in triggers/bulk-sync.js:380–407 are not reachable
  from production: exported `run` returns `BULK_SYNC_CONSUMER_DISABLED` at :17–24.
  The manual scheduled queue is likewise disabled in triggers/manual-scheduled-sync.js.
  The legacy remote-client.js:145 upload helper has no src caller; production
  attachments use attachment-client.js through the engine. These are not counted
  as current independent propagation paths.

## Reproduction and practical impact

The above is explicit code evidence, not a claim of a live exploit. No F2 test or
production code was changed. For a transport-mocked reproduction (no live site):

1. Seed a migrated, unpaused connector, org with `allowedProjects: ['LOCAL']`,
   `jqlFilter: 'labels = selected'`, credentials, enabled relevant sync options,
   and existing LOCAL-1 → REMOTE-1 mapping. Remove the selected label locally;
   a key-constrained search would return `{ issues: [], isLast: true }`.
2. Deliver a comment event with an unmapped public/unrestricted comment and valid
   authoritative ancestor/project reads. `syncComment` reaches the remote
   comment POST without querying search. A reply also exports its approved parent
   snippet. The scope read that would exclude the issue is never performed.
3. Deliver a valid created attachment event (with a numeric issue ID), canonical
   attachment metadata/content, size/settings and fresh operation ledger.
   `syncAttachments` reaches remote upload; a valid continuation queue body does
   the same. With deletion propagation enabled and an active attachment mapping,
   a deleted event reaches remote DELETE despite the same JQL nonmembership.
4. Seed mapped LOCAL-2 → REMOTE-2 outside JQL and a local link from selected
   LOCAL-1. Source issue sync can POST the remote relationship even though target
   issue sync rejects LOCAL-2. Seed the same relation as pending and use the admin
   retry resolver (or eligible hourly legacy run): neither endpoint needs to
   match the main search. Deliver a link-deleted event: it can DELETE that
   relation without any project/JQL evaluation.
5. For inherited-check gaps, change org JQL or issue eligibility after the issue
   entry scope check, before a child comment/upload/link/transition submission.
   Those writers do not recheck. Field PUT may subsequently fail closed even
   though content has already been exported (:1292–1321 precede :1552).

Public/unrestricted comments are not necessarily approved for this remote org;
JQL may encode a customer, label, classification, or business subset within an
approved project. Comment text, authors and reply context or full attachment bytes
can cross that intended boundary. Previously exported remote issues need only
retain a mapping. New issue creation is not required. Links expose relationship
type/direction and endpoint association; deletion can wrongly remove relationships
or attachments outside current scope. Status drift can trigger unintended remote
workflow behavior. Notices reveal deletion/key metadata or change remote content
without current selection. Tightening configuration or issue selection does not
remove already exported data. Existing confidentiality, mapping and write guards
reduce other risks but do not cure this gap.

## Smallest safe enforcement boundary (proposal only)

Reuse `assertOutboundScope` at semantic outbound service submission boundaries,
where org and local source keys are known. A webhook-only fix misses recovery,
queue and direct callers; a generic URL/method check in guarded-api lacks the
local-source and link-endpoint identity and would also conflate inbound policy.

- Comments: centralize selection in `submitOutboundComment` before durable fence/
  claim consumption and before send (including late rechecks). Cover both single
  comment and batch/recovery paths. Integrate scope denials into pre-submission
  handling only where no transport started; preserve fences/unknown outcomes for
  any earlier possibly applied write. Scope and comment visibility/ancestry are
  separate checks; neither replaces the other.
- Attachments: check outbound source before claim/download and recheck immediately
  before upload/delete submission markers. Cover the shared engine and deletion
  function so queue continuations inherit the same policy. Extend pre-submission
  error handling deliberately; do not mark an unsent rejection unknown or rearm
  an earlier uncertain upload/delete.
- Links: use one shared semantic create/delete boundary with org and **both local
  endpoint keys**, requiring current approved project/JQL eligibility of each.
  Route normal, newly mapped pending, scheduled/admin retry and deletion through
  it. Retain pending unknown-outcome reconciliation; selection denial must never
  authorize replay. Relationship removal outside selection requires an explicit
  cleanup policy if desired, not an implicit mapping exemption.
- Transitions: pass the local source identity to the existing transition service
  and verify current scope before the status POST. Recheck after intervening reads.
- Notices: decide and document whether deletion notices and removal of connector
  boilerplate are narrowly authorized lifecycle cleanup exceptions. Default to
  deferral when a deleted source cannot be verified; do not silently waive JQL.
  If cleanup is explicitly exempted, constrain it to connector-owned metadata
  with separate authority and make that exception clear in source-selection docs.

This is a small set of service boundaries, not a transport-wide refactor. Future
implementation needs regressions for excluded/malformed/unavailable/drifting JQL,
both link endpoints, queue and recovery entry points, and unchanged Pause/lease/
unknown-outcome behavior. Current verification cannot prove these missing
protections. **F2 remains open; Package 1 guarantees are partial until these gaps
are enforced or explicitly narrowed by an approved, documented product contract.**
