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
