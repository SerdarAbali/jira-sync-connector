# Architecture

## Runtime shape

SyncApp is a Forge app with a React and Atlaskit Custom UI admin page. The app runtime is `nodejs22.x`. The local Jira site is the hub; remote Jira Cloud sites are reached directly over REST.

```text
Local Jira Cloud                         Remote Jira Cloud
     |                                        ^
     | Forge product events                   | REST writes
     v                                        |
+--------------------------------------+      |
| Forge app                            |------+
|  triggers / queues / scheduler       |
|  sync services / resolvers           |
|  Forge KVS and secret storage        |
|  Custom UI (admin page)              |
+--------------------------------------+
     ^
     | authenticated web-trigger
     | (bidirectional remote events)
```

No vendor-operated service sits between the Jira sites.

## Local entry points

`src/index.js` exports handlers referenced by `manifest.yml`:

- Jira product event triggers
- queue consumers
- scheduled triggers
- the incoming web-trigger
- the admin resolver

### Real-time Jira events

The local site's product events are the primary synchronization path:

- issue created
- issue updated
- issue commented
- issue-link created
- issue-link deleted
- issue deleted
- attachment created
- attachment deleted

The trigger handlers validate and normalize the event, resolve the issue and organization, detect loops and call shared services. Outbound services enforce current project authorization and JQL source selection at each new write boundary, including delayed/recovered content; entry-point checks alone do not grant continuing authority. Applicable leases, submission ledgers and Pause remain independent guards. The attachment trigger ignores self-authored events.

Real-time delivery is not treated as exactly-once. Duplicate events are expected and are suppressed by hashes, mappings, operation records, and idempotent service paths.

### Bidirectional webhook

For a bidirectional target, remote Jira sends events to the Forge web-trigger:

```text
POST <forge-webtrigger-url>/<orgId>/<opaque-credential>
```

The endpoint validates method, content type, size, path shape, organization, secret, event name, and direction. It then records a non-sensitive receipt and calls the incoming sync service. The remote webhook JQL is a remote-side filtering layer, not the only loop control.

### Queue consumers

Forge queues isolate longer-running or rate-limited work:

- `initial-sync-queue`: bounded initial-sync batches
- `attachment-sync-queue`: attachment uploads and deletions
- `manual-sync-queue`: manual issue synchronization
- `bulk-sync-queue`: retained bulk path

Queue messages use identifiers and operation records. A consumer re-reads authoritative state rather than trusting the payload as complete.

### Scheduled triggers

There are two hourly triggers:

- `scheduled-sync-function`: legacy scheduled compatibility
- `initial-sync-recover-fn`: initial-sync recovery followed by due recurring reconciliation

The recovery trigger re-enqueues persisted running jobs; it does not start a new backfill. The same heartbeat evaluates opt-in recurring reconciliation. Scheduling resolution is hourly, not exact-minute.

## Synchronization paths

The application deliberately separates four kinds of work.

### 1. Real-time event synchronization

Real-time events handle the normal case. They are fast, scoped, and idempotent. They do not perform an initial backfill.

### 2. Initial synchronization and backfill

Initial sync is an explicitly previewed and approved local-to-remote job:

1. resolve organization and scope
2. validate target and mappings
3. build a preview with classifications
4. bind approval to preview and configuration checksums
5. page candidates and persist batches
6. process bounded batches through the queue
7. create or safely update through the shared service
8. persist cursor, counts, and terminal state
9. recover or fail safely after interruption

The create ledger is the final duplicate guard. The processing lease prevents concurrent ownership. Parent ordering prevents children from racing ahead of unresolved parents. Remote Jira is never the scan source.

### 3. Recurring local-to-remote reconciliation

Recurring reconciliation reuses the initial-sync preview and create/update services on a schedule. It is not a separate write implementation.

- one active job per organization
- a per-organization lease
- due time advanced only at a terminal outcome
- no duplicate create when a mapping exists
- no remote scan
- fail-closed when settings cannot be read

This path is for missed local-to-remote work, not full two-way convergence.

### 4. Pending-link maintenance

A link to an unmapped issue is stored in a pending-link index. The hourly maintenance path or **Retry Pending Links** resolves it after both issues have mappings. Pending links are not treated as failures and are not guessed.

### Legacy scheduled synchronization

The legacy scheduled-sync path remains for compatibility and recovery. It skips organizations using recurring reconciliation and requires a project allow-list. It is intentionally not the primary synchronization mechanism and is not a substitute for the initial-sync safety model.

## Core services

```text
services/
  jira/
    local-client.js          @forge/api local Jira access
    remote-client.js         remote Jira REST with Basic Auth
    attachment-client.js     metadata, content, limits, upload/delete

  setup/
    setup-wizard.js          step validation, preflight, progress

  sync/
    issue-sync.js            create/update, scope, cross-reference
    incoming-sync.js         remote events, webhook processing
    comment-sync.js          comment copy and deduplication
    link-sync.js             link copy and pending queue
    transition-sync.js       status transitions
    attachment-sync.js       secure attachment transfer
    issue-create-operation.js
    attachment-operation.js
    issue-lease.js
    initial-sync.js
    source-reconciliation.js
    reconciliation-attention.js
    counterpart-status.js
    counterpart-probe.js
    counterpart-recovery.js
    pilot-pause.js
    sync-state.js
    sync-result.js
    sync-observability.js

  storage/
    kvs.js                   Forge KVS wrapper and transactions
    mappings.js              issue/comment/attachment mappings
    flags.js                 short-lived sync flags, pending links
    stats.js                 statistics and audit records
    webhook-receipt.js       setup preflight receipt proof
    rejected-fields.js       learned field rejections
```

Resolvers are thin policy-checked adapters over these services. Triggers and consumers must not contain duplicate business logic.

## Forge Storage model

Forge KVS is the system of record. Keys are organization-scoped; legacy single-organization keys are supported where the organization ID is `legacy`.

Representative key families:

- `organizations`: organization configuration without tokens
- `secret:{orgId}:token`: remote API token
- `secret:{orgId}:incomingSecret`: webhook credential
- `userMappings:{orgId}`, `fieldMappings:{orgId}`, `statusMappings:{orgId}`
- `issueTypeMappings:{orgId}`, `projectMappings:{orgId}`
- `{orgId}:local-to-remote:{localKey}` and reverse mapping
- `mapping-meta:{orgId}:{localKey}`: queryable mapping metadata
- `issue-create-operation:*`: create claims and outcomes
- `attachment-operation:*`: upload and deletion ledgers
- `initialSyncJob:*`, `initialSyncBatch:*`, `initialSyncLock:*`
- `reconciliationSettings:*`, `reconciliation-attention:*`
- `counterpart-status:*`
- `pending-links:*`, `pending-link-idx:*`
- `pilotPause`: global write control
- `webhookSecretMeta:*`, `webhookReceipt:*`
- statistics and audit records

KVS values have size and query limits. Large or unbounded data must be paged or summarized, not accumulated in one key. Transactions are limited to set and delete operations and should remain small.

## Leases, ledgers, and idempotency

Three mechanisms work together:

1. **Mapping**: the durable relationship between local and remote issue keys.
2. **Lease**: short-lived ownership of concurrent work.
3. **Ledger**: durable evidence that a write was claimed, started, succeeded, failed definitively, or is ambiguous.

A mapping alone cannot prevent two workers from creating the same issue. A lease alone cannot survive an ambiguous timeout. A ledger alone cannot prevent ordinary concurrent updates. The services combine them.

## Security boundaries

- Admin resolvers check Jira administrator permission as the user.
- New outbound writes recheck current project authorization and JQL source selection at shared semantic boundaries. Link endpoints and exported parent/Epic references are checked together. Inbound writes retain their separate project/direction policy; local source JQL is not inbound destination permission. See [the outbound selection guarantee](PACKAGE1_OUTBOUND_SELECTION_GUARANTEE.md).
- Remote tokens and webhook secrets are stored as secrets and redacted.
- Inbound webhook authentication is timing-safe and path-based.
- Global pause is checked immediately before writes.
- Ambiguous writes require reconciliation, not automatic replay.

See [Security](SECURITY.md) for details.

## Custom UI

`static/admin-page` is a React and Atlaskit Custom UI built into `static/admin-page/build`. It communicates through `@forge/bridge` `invoke` calls to protected resolvers.

The UI is responsible for presentation and explicit operator confirmation. It is not a security boundary; the backend repeats authorization, scope, pause, and idempotency checks.

Main panels include:

- organization configuration and guided setup
- mappings and feature options
- initial-sync preview and job controls
- recurring reconciliation and attention records
- deleted counterpart recovery
- Synchronization Write Control
- Sync Activity, diagnostics, and statistics

## Compatibility and deprecations

- Jira Search uses `POST /rest/api/3/search/jql`; the removed `GET /rest/api/3/search` is not used.
- Remote calls are scoped to `*.atlassian.net`.
- The app runtime is `nodejs22.x`.
- Forge CLI is a development dependency; its login requirement is not a runtime dependency.
- `recreateDeletedIssues` is a legacy option and does not enable automatic counterpart replacement.
