# Security

## Security model

SyncApp runs as an Atlassian Forge app on Atlassian-hosted infrastructure. It calls the local Jira site with `@forge/api` as the app and calls each remote Jira site directly with the administrator-supplied email and API token. There is no vendor-operated middleware.

The security model assumes:

- the local Jira site administrator controls app installation and configuration
- the remote API token belongs to a dedicated, least-privilege Jira account
- remote Jira System Webhooks are restricted to the intended projects
- Forge Storage is the system of record for mappings, secrets, and operation state

## Authorization

Every admin resolver is default-deny unless it appears in the explicit resolver policy table.

- `ADMIN_READ` and `ADMIN_WRITE` operations require the invoking Jira user to have global **Administer Jira** permission.
- Permission is checked with `/rest/api/3/mypermissions?permissions=ADMINISTER` as the invoking user, not as the app.
- A missing, malformed, or failed permission response denies access.
- Write and destructive operations are audited.
- Unknown resolver names are denied by the resolver wrapper rather than falling through to an unprotected handler.

A Jira administrator authorization failure is not a transient sync error and must not be bypassed by exposing a resolver.

## Credentials

Remote API tokens and incoming webhook secrets are stored with Forge secret storage under organization-scoped keys.

- Tokens are never returned to the browser.
- Configuration responses expose only a boolean such as `hasRemoteApiToken`.
- An absent or empty token on update keeps the existing secret.
- Token replacement is explicit.
- Tokens are omitted from logs, audit records, exports, and error summaries.
- Incoming webhook credentials are compared with a timing-safe comparison.
- Webhook credentials are accepted only in the opaque path, never in query parameters.
- Rotating the webhook secret invalidates the previous callback URL immediately.

Do not store credentials in issue fields, comments, repository files, test fixtures, screenshots, or support attachments. If a token is exposed, replace it at Atlassian and in SyncApp, then rotate the webhook secret.

## Project and JQL enforcement

Synchronization scope is not advisory:

- At least one allowed local project is required.
- An empty allow-list blocks synchronization instead of allowing all projects.
- The optional JQL filter is combined with the project restriction.
- Outbound, inbound, scheduled, initial-sync, reconciliation, attachment, and manual paths apply the applicable scope checks.
- Bidirectional webhooks must also be restricted in remote Jira to the intended projects.
- Initial sync validates the remote target project and local scope before preview.
- A project mapping cannot silently move an issue outside the validated target scope.

A JQL filter is not a security boundary by itself. The project allow-list, remote webhook JQL, and remote account permissions are separate layers.

## Operation ledgers and idempotency

Jira writes are not blindly retried.

### Issue creates

- An issue-create operation is claimed before submission.
- A write-start marker records that the request may have reached Jira.
- A definitive rejection can be retried after correcting the cause.
- An ambiguous outcome becomes reconciliation-only.
- A successful create is resolved to the created issue key and mapping.
- Operation-specific suffixes allow controlled replacement without colliding with an earlier create.

### Attachments

- Attachment uploads and deletions have separate operation records.
- A write-start marker makes an unconfirmed attempt reconciliation-only.
- A successful upload records the destination attachment ID.
- Delete propagation requires an explicit opt-in and an explicit mapping.
- Attachment locks prevent concurrent duplicate uploads.

### Links and comments

- Pending links are retained until both issues are mapped.
- Comment mappings and content markers prevent duplicate copying.
- App-authored and connector-generated comments are skipped.

### Comment confidentiality

Source readability does not authorize disclosure to another Jira site. The connector
never maps groups or roles between sites. An authoritative REST comment must match
the requested ID and have no `visibility` field. Explicit group/role restrictions,
malformed metadata, and conflicting or internal JSM signals reject the whole comment.
For Software and Business comments without public/internal flags, freshly verified
issue/project `projectTypeKey` establishes the applicable ordinary Jira semantics.
JSM comments require explicit public evidence; unknown project types fail closed.
Project context is cached only within one verification operation (or catch-up batch),
never across tenants or invocations. No new JSM permissions are introduced.

Every known ancestor must independently pass the same policy, up to eight comments
including the reply. Restricted or malformed ancestors, cycles, unparseable parent
properties, and deeper threads block the entire reply. No parent author, snippet,
identifier, or relationship is copied from a rejected thread. Temporary ancestor
read failures defer the entire reply. Both directions and historical catch-up use
this shared policy; webhook bodies never substitute for authoritative REST content.
Absent ancestry is distinct from explicit null, zero, false, empty objects, invalid
identifiers, and conflicting aliases/properties: the latter all reject the thread.
Jira documents inherited child visibility. The connector's legacy `parentCommentId`,
`jsdParentId`, nested parent objects, and custom parent/thread property encodings
are conservative hints, not claimed official Jira contracts. Conflicting hints
cannot grant copying. Their actual tenant response shapes, and whether each REST
endpoint reliably exposes ancestry, require live validation; omission is not proof
that every Jira endpoint exposes all thread relationships. Search-embedded comment
objects are never used as final authority.

Immediately before submission, both event directions and catch-up read the source
comment and every known ancestor again through dedicated REST reads. Parent and ancestor relationships discovered during initial verification remain
mandatory constraints even if final responses omit them; conflicting current
relationships fail closed. Final checks
use a fresh project-context cache and never reuse comment-list bodies, authors, or
visibility as final authority. Submitted content is built from this last verified
response. The inbound parent-rejection fallback also rechecks before its second
POST, using the same final-phase deadline.

#### Deferred verification and invocation limits

Verification reads (including JSON decoding) each have a four-second wait bound,
within a shared ten-second budget per verification phase for source comment, project
context, and ancestors. Initial and final phases together can wait up to twenty
seconds; any inbound parent fallback shares the final phase's remaining budget.
They never sleep or retry inline. HTTP 429 respects numeric or date `Retry-After`
through durable `notBefore` scheduling, with a minimum delay of one minute.
Every deferral, including the one-minute minimum, has an immutable
`comment-verification-deadline:` record;
normal delivery, recovery, and the submission guard use their maximum together
with pending `notBefore`. Concurrent read/modify/write updates cannot erase that
longer barrier. No per-comment verification reads or destination writes proceed through this gate
while it is throttled. Deadline records are retained; a saturated 100-record deadline
scan fails closed and ultimately requires manual attention rather than guessing
that an unseen deadline has expired. HTTP
401/403/404, 5xx, network errors, and unreadable responses also defer conservatively.
The read deadline bounds waiting, not network cancellation or the whole handler:
existing storage, issue reads, catch-up listing, and destination writes keep their
existing behavior. Ancestor reads may consume the budget and defer long threads.

Identifier-only `comment-verification:` records retain direction, organization,
issue/comment IDs, optional parent ID, attempt count, and scheduling timestamps.
No comment bodies, authors, credentials, or restriction names enter these records.
Incoming deferral releases the replay claim and returns 202 with
`COMMENT_VERIFICATION_DEFERRED`; it never marks verification successful. Persistence
failure returns 503. Recovery does not depend on Jira retrying that HTTP response.

The existing hourly heartbeat processes at most three due records from a bounded
100-record scan per run, with five attempts and a 24-hour age limit. This bounds
work rather than promising delivery latency; a large backlog requires operator
review. Each attempt reads current source visibility again, retaining ordinary
mapping, loop suppression, global pause, and destination operation safeguards.
While globally paused, new incoming events follow the existing acknowledge/discard
policy. Previously persisted recovery work remains pending; pause is never a
terminal outcome. Deferred attempts remain subject to the five-attempt/24-hour
bounds and may require manual attention after prolonged pause or outage.

Recovery deletes a pending record only for an explicit `COMMENT_SYNCED`,
`COMMENT_ALREADY_MAPPED`, `COMMENT_REJECTED`, `COMMENT_IGNORED_CONNECTOR`, or
organization-removed `CANCELLED` outcome, after persisting a `terminal` record.
An interrupted deletion resumes from this terminal state without submitting again.
HTTP 200 alone, undefined returns, in-flight duplicates, source issues currently
syncing, missing issue reads/mappings, disabled options, and pauses do not establish
completion. They retain the durable attempt, with a bounded `lastOutcome` code.
Terminal persistence failure leaves pending work and does not increment successful
recovery counts. Exhaustion/expiry archives a reason-coded attention record before
removing pending state; archive failure keeps pending state.

Recovery worker leases and pre-submission guards use separate storage prefixes.
Before a recovered destination write, an atomic submission guard and durable
`write_started` state prevent an ambiguous write or crash from causing blind replay.
Exhausted verification and interrupted submissions move to
`comment-verification-attention:` for manual inspection. These records have no
automatic deletion or replay. A pre-write crash can conservatively require manual
review even when no destination comment was created. Operators must reconcile
source, destination, mapping, and operation records before explicitly approving
any further synchronization.

Fixtures in `tests/fixtures/comment-rest-responses.json` are sanitized, schema-derived
representative responses, not captured tenant responses. Tests run production
source clients and policy together with mocked HTTP transport and storage. Live
tenant acceptance, Forge timing measurements, and real Jira throttling remain
rollout checks; no live data was accessed for this corrective pass.

#### Rollout condition: earlier copies and later restrictions (F02-R5)

This fix controls copying at verification time. It does not retract earlier copies,
propagate later visibility changes, or detect confidential text manually quoted by
users. A restriction can change between verification and submission; cross-site
copying is not an atomic Jira transaction. Enabling this fix alone cannot certify
existing destination comments as safe.

Before a sensitive pilot, an administrator should:

1. Pause writes and inventory synchronized issue pairs in both sites. Locate copied
   comments using `[Comment from ...]` headers and app authorship, then correlate
   source/destination comment IDs using organization-scoped comment mappings and
   `comment-meta:` / `comment-meta-local:` records. Legacy records may lack the
   organization prefix. Headers are discovery hints, not proof of complete coverage;
   edited copies or missing mappings require manual review of destination threads.
2. Check current source comment visibility and JSM internal/public state with an
   authorized account, including all ancestors. Review destination bodies, quoted
   parent snippets, authors, and links even when the child itself appears public.
   A source comment unavailable to the reviewer must remain unresolved.
3. Have the responsible administrator explicitly approve manual remediation on
   destination copies and exposed reply context, including edits or removal where
   appropriate. Preserve required audit evidence and review mapping/operation state
   before resuming; do not blindly clear retry guards or recreate copies.
4. Repeat this review after later source restrictions. Already copied content stays
   visible under destination permissions until manually remediated. Ongoing
   visibility-change detection and automatic restriction/removal propagation require
   a separately designed, explicitly approved feature.

This procedure documents manual remediation only. F02 performs no automatic
cleanup, source modification, or destination deletion.

Official references:
- [Jira comment visibility, inheritance, and REST responses](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/)
- [Comment properties are custom data, not a universal ancestry schema](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comment-properties/)
- [Jira project types](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/)
- [JSM public and internal request comments](https://developer.atlassian.com/cloud/jira/service-desk/rest/api-group-request/#api-rest-servicedeskapi-request-issueidorkey-comment-commentid-get)
- [Cloud JSON import examples for JSM comment properties](https://support.atlassian.com/jira-cloud-administration/docs/import-data-from-json/)

## Leases and concurrency

Per-issue and per-organization leases prevent concurrent workers from acting on the same state.

## Ambiguous writes

An ambiguous write is a request where SyncApp cannot prove whether Jira accepted it. Typical causes are a timeout, connection reset, or unreadable response after submission.

The required response is:

1. Do not automatically retry.
2. Pause synchronization if another write could duplicate the result.
3. Inspect both Jira sites and the operation record.
4. Reconcile the operation using the verified target key or attachment ID.
5. Resume only after the mapping and ledger agree.

Automatic replay is intentionally not implemented.

## Webhook authentication

The Forge web-trigger is the only inbound network endpoint.

- `POST` and `application/json` are required.
- Credentials in query parameters are rejected.
- The path must contain exactly an organization ID and opaque credential.
- The organization is selected by ID before the stored secret is compared.
- The secret comparison is timing-safe.
- Non-bidirectional organizations are rejected.
- The payload event must be recognized.
- The body is limited to 1 MiB.
- Receipt proof stores only non-sensitive metadata.
- While global pause is active, the event is acknowledged and discarded, not queued.
- Authentication failures return a generic response that does not disclose which check failed.

## Global write pause

The global **Synchronization Write Control** is checked immediately before Jira writes. It covers issue, comment, attachment, link, transition, initial-sync, and recovery writes in both directions.

Reads, exports, diagnostics, and configuration remain available while paused. Pausing does not alter mappings, secrets, or issue content. Resume does not replay discarded webhook events or start a backfill.

The pause record is stored in Forge Storage. A rollback to a version that does not understand the record can defeat the pause; see [Operations](OPERATIONS.md#rollback-considerations).

## Logging and audit redaction

Logs and audit entries are designed to be operationally useful without containing secrets or user content.

- Secret-named fields are removed by recursive redaction.
- Credential-bearing URLs are sanitized.
- Error summaries are bounded and stripped of structured payloads.
- Audit records allow only known safe keys and reason codes.
- Issue bodies and comment text are not written to audit records.
- Tokens, incoming secrets, and complete callback URLs are not logged.
- Server-side emoji prefixes are for log parsing, not user-facing output.

Redaction is a defense-in-depth control, not permission to log sensitive data. Report suspected leakage immediately and rotate affected credentials.

## Forge scopes

The manifest currently uses classic Forge scopes, including:

- `storage:app`
- `read:jira-work`
- `write:jira-work`
- `read:jira-user`
- `read:comment:jira`
- `write:comment:jira`
- `write:issue-link:jira`
- `read:issue-meta:jira`
- `read:project:jira`

The app also declares external fetch access for `*.atlassian.net`.

These are the scopes required by the implemented Jira REST calls. The manifest reflects classic scopes rather than a claim of granular-scope migration, Marketplace approval, or Runs on Atlassian eligibility. Any scope expansion requires review, a new deployment, and administrator reauthorization where Jira requires it.

## Reporting a vulnerability

Do not open a public issue containing a token, callback credential, customer issue content, or site URL. Report the minimum reproducible details privately to the repository owner and rotate any credential that may have been exposed.


- An initial-sync processing lease is longer than the maximum processing window and ownership is rechecked before each item and checkpoint.
- An expired lease can cause recovery to re-enqueue a job, but the ledger still prevents duplicate creates.
- Recurring reconciliation allows one active job per organization.
- A stale worker cannot treat lease expiration as ownership.
- Lease storage errors fail safely rather than proceeding without protection.
