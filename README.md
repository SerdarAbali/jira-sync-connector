# SyncApp: Jira Cloud-to-Jira Cloud Synchronization

SyncApp is an Atlassian Forge application that synchronizes issues between Jira Cloud sites. It is installed in one Jira Cloud site and connects directly to one or more remote Jira Cloud sites over Atlassian REST APIs and authenticated webhooks. No vendor-operated middleware or external application server is required.

The installed site is the local source (hub). Each configured remote Jira site is a target. A target can operate in **push** mode, which is local-to-remote only, or **bidirectional** mode, which also accepts supported changes from that remote site.

## At a glance

| Area | Supported behavior |
| --- | --- |
| Topology | One local Jira Cloud site to one or more remote Jira Cloud sites |
| Real-time sync | Jira events handled by Forge triggers |
| Direction | Per-remote `push` or `bidirectional` |
| Initial sync | Previewed, approved, resumable local-to-remote backfill |
| Recurring recovery | Opt-in recurring local-to-remote reconciliation |
| Scope | Required project allow-list plus optional JQL |
| Credentials | Remote API token stored write-only in Forge Storage |
| Middleware | None; Jira REST is called directly by the Forge app |

## What SyncApp synchronizes

### Issue creation and fields

SyncApp creates and updates counterpart issues. The standard fields include:

- summary and description
- priority, labels, and due date
- components, fix versions, and affects versions
- original and remaining time estimates
- parent and subtask relationships where the hierarchy can be resolved
- mapped custom fields
- assignee and reporter when a user mapping exists

Descriptions retain Jira Document (ADF) content. Connector-owned cross-reference and counterpart-notice panels are managed separately and are never copied back to the other site as user content.

### Comments

Human-authored comments can be mirrored with author attribution and duplicate protection. Connector-generated comments and app-authored comments are skipped so they do not loop or overwrite user content. Comment synchronization is on by default and can be disabled per remote organization.

### Status mappings and transitions

Status changes are applied with the target issue's available transitions. Administrators can map local and remote statuses by identifier or name. A transition is attempted only when the target workflow exposes a matching destination; unsupported workflow differences are reported rather than simulated.

### Issue links

Supported Jira issue links, such as blocks, relates to, and duplicates, can be synchronized in either direction. If a linked issue has not yet been mapped, the link is retained as a pending link and retried by the background maintenance path.

### Secure attachments

Attachment synchronization is opt-in. It uses Jira attachment identifiers rather than trusting webhook-supplied URLs, checks the lower of the two Jira attachment limits and any configured connector limit, and stores operation records before writes. Upload and deletion attempts are tracked so an ambiguous write is not blindly repeated.

Attachment deletion propagation is **Off by default**. When enabled, only an explicitly mapped counterpart attachment is deleted; a Jira issue is never deleted.

### Safe initial synchronization and backfill

Initial synchronization is a controlled local-to-remote backfill:

1. SyncApp builds a read-only preview of the configured local project and JQL scope.
2. The preview classifies issues as eligible, already mapped, blocked, or conflicting.
3. The administrator reviews counts and reason codes and explicitly approves the job.
4. The preview and configuration are checksum-bound to the job.
5. Work proceeds in bounded batches through the existing Forge queue, with an issue-create ledger, leases, parent ordering, and restart recovery.
6. The job can be paused, resumed, or cancelled. Completed Jira writes are not reversed.

An issue with an existing mapping is never sent through the create path. The backfill does not scan or create issues in remote Jira.

### Guided setup

The admin page includes a guided setup wizard covering:

- remote Jira connection
- source project scope
- push or bidirectional direction
- user, field, status, issue-type, and project mappings
- feature options
- remote webhook configuration
- communication preflight
- initial synchronization
- review and activation

An existing organization can still be configured through the individual settings panels.


### Recurring local-to-remote reconciliation

Recurring source reconciliation is opt-in and **Off by default**. When enabled, it periodically re-evaluates the already configured **local** project scope:

- unmapped local issues are eligible for creation through the safe create path
- mapped issues that are already current produce no writes
- outdated mapped issues are updated through the safe update path
- a mapped issue is never sent to the create path, so reconciliation cannot create a second counterpart

This feature does not scan remote Jira and is not full bidirectional reconciliation. It uses the existing hourly recovery heartbeat, so exact-minute execution is not guaranteed.

### SYNC attention records and issue comments

Recurring reconciliation maintains a stable attention record for each organization and source issue. A record can include the source and remote keys, reason code, attempt count, timestamps, notification acknowledgement, resolution metadata, and review-comment metadata.

- **Resolve after Health Check** confirms both mapping directions and probes both issues before resolving the record. A failed probe leaves it open.
- **Acknowledge Notifications** only mutes further administrator notifications. The technical record remains open and visible.
- A resolved record reopens as a new episode if the issue fails again.

When configured, SyncApp adds one marker-tagged review comment to the local issue after the failure threshold is reached. The marker text starts with `Jira Sync Connector recurring reconciliation review required.` The comment is never copied to the remote site.

`SYNC-123`-style keys are ordinary issue keys in a target project. They are not connector database identifiers. The connector mapping and attention record reference those Jira keys but are stored separately in Forge Storage.

### Global Synchronization Write Control

The **Synchronization Write Control** in the admin page provides a global emergency pause. While paused, all connector Jira writes are blocked in both directions, including issue, comment, attachment, link, and transition writes. Reads, configuration, diagnostics, and exports remain available.

Pause does not delete or modify issues, mappings, secrets, or organization configuration. Inbound webhook events received while paused are acknowledged and discarded; resume does not replay them or start a backfill. Use the separate initial-sync controls to resume an explicitly approved paused job.

### Deleted-counterpart notices, remapping, and controlled replacement

SyncApp treats a counterpart deletion as a mapping and safety event. It does **not** propagate a Jira issue deletion to the other site.

When a deletion or unavailability is detected, SyncApp can:

- record the counterpart state and reason
- add a connector-owned warning notice to the surviving issue's description
- preserve existing user content
- expose the pair in **Deleted Counterpart Recovery**
- remap the pair only after both replacement issues are verified reachable
- end synchronization while retaining an audit record
- replace a confirmed-deleted counterpart only through an explicit administrator action or the explicit automatic-replacement opt-in

Automatic replacement after confirmed deletion is **Off by default**. The legacy `recreateDeletedIssues` setting does not enable it.

### Strict project and optional JQL scope

A remote organization must have at least one allowed local project. If no project is selected, synchronization is blocked rather than falling back to all projects. An optional JQL filter is applied **in addition to** the project allow-list, and both are enforced for outbound, inbound, scheduled, initial-sync, reconciliation, attachment, and manual paths as applicable.

## What SyncApp does not do

SyncApp does not:

- scan remote Jira projects on a recurring schedule
- clone workflows or workflow schemes
- propagate Jira issue deletion to the other site
- automatically replay an ambiguous Jira write
- provide arbitrary non-Atlassian integrations
- represent Marketplace approval or Runs on Atlassian eligibility

Deleting an issue in either Jira site is intentionally not mirrored as a Jira issue deletion.


## Requirements

- Node.js 22.x for Forge CLI and repository tooling
- Atlassian Forge CLI 14.x
- A Jira Cloud site where the app is installed
- Jira administrator permission on the local site
- A remote Jira Cloud site, remote administrator email, and API token with the required Jira permissions
- A Jira System Webhook on each bidirectional remote site

The Forge manifest requests classic Jira scopes and `storage:app`; see [Security](docs/SECURITY.md) for the authorization model.

## Install and configure

```bash
npm ci
npm test -- --runInBand
cd static/admin-page && npm ci && npm run build && cd ../..
forge login
forge deploy
forge install
```

Then open **Jira Settings > Apps > Sync Connector** and use the guided setup wizard. Detailed instructions are in [Installation](docs/INSTALLATION.md) and [Configuration](docs/CONFIGURATION.md).

## Operate and troubleshoot

- [Operations](docs/OPERATIONS.md): pause/resume, backfill, recurring reconciliation, attention records, deleted counterparts, attachments, manual sync, pending links, rollback
- [Troubleshooting](docs/TROUBLESHOOTING.md): missing issues, mapping conflicts, unknown create outcomes, webhook problems, permission upgrades
- [Architecture](docs/ARCHITECTURE.md): triggers, queues, storage, ledgers, leases, Custom UI
- [Release notes for v2.1.0](docs/RELEASE_NOTES_V2.1.0.md)

## Repository layout

```text
src/
  index.js                 Forge handler exports
  resolvers/               Admin UI resolvers and authorization policy
  services/jira/           Local and remote Jira clients
  services/setup/          Guided setup validation and progress
  services/storage/        Forge KVS wrappers, mappings, ledgers, stats
  services/sync/           Issue, comment, link, attachment, backfill,
                           reconciliation, pause, and recovery services
  services/scheduled/      Legacy scheduled compatibility path
  triggers/                Jira event, queue, and scheduled handlers
  webtriggers/             Authenticated remote webhook endpoint
static/admin-page/         React and Atlaskit Custom UI
manifest.yml               Forge modules, runtime, and scopes
docs/                      Current product and operations documentation
```

## Development

```bash
npm ci
npm test -- --runInBand
npm run lint
npm audit --omit=dev
npm run check:secrets
npm run check:forge:offline
npm run check:forge
cd static/admin-page && npm ci && npm run build
```

`npm run check:forge:offline` runs the Forge lint rule set without a login and is the deterministic CI check. `npm run check:forge` is the authenticated local release gate and is not run in CI, where Atlassian credentials are intentionally not available.

## Version

The authoritative package version is `package.json` (`2.1.0`). The admin header displays `v2.1.0`.

## License and support

MIT License; see [LICENSE](LICENSE). Report defects at <https://github.com/SerdarAbali/jira-sync-connector/issues>.

Signed Jira System Webhooks use a credential-free `/signed/<orgId>` callback and a separately configured HMAC-SHA256 secret. Existing installations require the [F04 coordinated switch runbook](docs/F04-SIGNED-WEBHOOKS.md); this build rejects legacy bearer callback URLs.
