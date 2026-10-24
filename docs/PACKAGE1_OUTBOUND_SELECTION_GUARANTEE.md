# Outbound source-selection guarantee

## Invariant (specified before implementation)

Every new outbound synchronization mutation must verify the current local source
issue against the organization's current stored source-selection configuration
before submission. A configured JQL filter restricts every outbound operation,
not just issue creation or field updates. Excluded or unverifiable sources must
not authorize a mutation, a successful synchronization result, or advancement of
that operation's successful-sync checkpoint. Delayed/recovered work has the same
obligation at execution time; historical selection and mappings grant no export
authority. API failures, malformed/incomplete search responses, configuration
changes during verification and deleted/unreadable sources fail closed.

Project authorization is a separate mandatory allow-list check. JQL further
restricts the eligible sources inside approved projects; it cannot authorize a
project. No JQL filter means no additional JQL restriction, not unrestricted
project access. The shared source verifier performs both checks using current
organization and issue reads and bounded enhanced search.

Previously synchronized destination content and operation receipts are historical
state. Leaving selection does not delete that content, remove mappings, reset
unknown outcomes or permit replay. Read-only reconciliation of an already
confirmed write may repair storage without exporting content again. Each new
write, including explicit attachment/link deletion or connector notice removal,
needs current eligibility. A valid earlier write is not rolled back if a later
operation is denied; the later operation must not be reported as successful.

Inbound synchronization is governed by its separate project/direction policy and
remote webhook selection. Local organization JQL is not an inbound destination
permission and must not be applied to inbound issue creation or destination
updates. Local connector bookkeeping is not an outbound content export.

## Relationship and notification policy

A remote issue link exports the relation type/direction and association of both
endpoint issues. Link deletion also mutates that shared relation. Both current
local endpoints must therefore be authorized and JQL eligible before either link
creation or deletion, including pending-link recovery. An old remote mapping for
an excluded endpoint is not permission to export its association. The existing
contract requires both mappings, retains pending links and permits retry; it does
not exempt mapped endpoints from source selection. Direction reversal does not
change eligibility requirements. Missing endpoint identity fails closed.

Counterpart notices add source key/deletion metadata; removal is also a new
remote description write. They have no selection exemption. Documentation says
a survivor *may* receive a notice, not that writing one is unconditional. A deleted
or unreadable local source cannot establish current selection, so remote notice
writes are deferred/blocked while status records and administrative recovery stay
available. No lifecycle-cleanup exception or automatic destination cleanup is
introduced. Local notices for inbound events retain the separate inbound policy.

## Production entry points and write boundaries

| Entry point | Production path / exported operation |
| --- | --- |
| Issue created/updated webhook | triggers/issue → syncIssue → issue-sync create/update; recursive hierarchy; field/description POST/PUT and status transitions |
| Link-created webhook | triggers/link → syncIssue for both endpoints → syncIssueLinks |
| Comment/reply webhook | triggers/comment → syncComment → submitOutboundComment → remote comment POST; verified parent context is content too |
| Attachment created/deleted webhook | triggers/attachment → syncAttachments / propagateAttachmentDeletion → remote upload/DELETE |
| Link-deleted webhook | triggers/link-deleted → remote link DELETE with both local endpoint identities |
| Local issue-deleted webhook | triggers/issue-deleted → setCounterpartNotice on remote survivor; optional replacement goes through issue create |
| Manual issue/reconciliation resolvers | resolvers/sync forceSyncIssue; resolvers/data reconciliation → shared issue create/update boundaries |
| Manual pending-link resolver | resolvers/sync retryPendingLinks → retryAllPendingLinks → remote link POST |
| Hourly legacy scheduled sync | triggers/scheduled → performScheduledSync → mapped issue update/content/transition; independent pending-link index → retryAllPendingLinks |
| Approved initial sync | triggers/initial-sync → processInitialSyncJob → shared issue create/update and content services |
| Recurring reconciliation | hourly recovery → runDueReconciliations → initial-sync queue → processReconciliationJob / processReconciliationCandidate → shared issue services |
| Comment recovery heartbeat | triggers/initial-sync-recovery → recoverCommentVerifications → syncComment with retained identifiers |
| Attachment continuation consumer | runAttachmentSyncQueue reloads organization/options/source → shared attachment engine |
| Newly mapped pending links | issue create → processPendingLinksForNewlySyncedIssue → createLinkOnRemote |
| Counterpart recovery resolvers | replace/remap/end/dismiss → clearCounterpartNotice; remote replacement → protected create boundary |

The legacy bulk consumer and manual scheduled queue return disabled results before
work starts. Inbound post-create attachment recovery is remote-to-local. No
production caller of the legacy remote attachment upload helper was found.

Enforcement belongs in shared semantic services where organization and local
source identities are known, immediately before durable submission markers or
transport. Trigger/search-only checks are insufficient. Scope rejection must
preserve F1 error classification, comment fencing and atomic marker release,
attachment operation evidence, pending-link reconciliation, Pause, retry budgets,
lease ownership and the inactive migration gate. Concurrent invocations must not
borrow another invocation's selection or erase its submission evidence.

## Verification limits

Local source reads, enhanced search, configuration storage and destination writes
are separate services. They cannot be made one atomic transaction. Verification
must be fresh at each write boundary, detect configuration drift during the read,
and bound reads; no promise of atomic revocation after the last check is made.
Search consistency, live permissions, invocation budgets and platform behavior
require controlled integration validation before release. Tests use production
functions with mocked platform storage/transport, never live destination data.

The implementation/test completion record belongs in PACKAGE1_SCOPE_ROUTING_REVIEW.md.
