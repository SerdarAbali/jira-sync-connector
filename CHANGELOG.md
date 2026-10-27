# [2.2.0](https://github.com/SerdarAbali/jira-sync-connector/compare/v2.1.0...v2.2.0) (2026-10-27)

### Administration and recovery

- Redesigned the seven-page administration console with responsive navigation, scoped organization controls, and recorded analytics.
- Added read-only recovery snapshots and restore preview, pairing-witness inspection and approved migration tooling, and maintenance-write audit records.
- Preserved administrator confirmations and strengthened installation-wide pause and synchronization-authorization safeguards.
- Expanded regression coverage across administration, authorization, recovery, and synchronization safety.

Full snapshot restoration, automatic witness-based duplicate prevention, and diagnostic-report export are not implemented. Existing dependency audit advisories and synchronization limitations remain documented in [the v2.2.0 release notes](docs/RELEASE_NOTES_V2.2.0.md).

# [2.1.0](https://github.com/SerdarAbali/jira-sync-connector/compare/v2.0.0...v2.1.0) (2026-10-23)

### Features

- Added a guided connector setup wizard with connection, scope, direction, mappings, features, webhook, preflight, initial-sync, and activation steps.
- Added secure bidirectional issue, comment, status, link, and attachment synchronization.
- Added safe, resumable initial synchronization with preview classification, checksum-bound approval, parent ordering, operation ledgers, and leases.
- Added opt-in recurring local-to-remote source reconciliation and stable administrator attention records.
- Added global Synchronization Pause and Resume.
- Added deleted-counterpart notices, verified remapping, controlled replacement, and explicit automatic-replacement opt-in.
- Added strict project allow-list and optional JQL scope enforcement.

### Security and reliability

- Enforced Jira administrator authorization with default-deny resolver policies.
- Stored API tokens and webhook secrets write-only in Forge secret storage.
- Added authenticated, timing-safe webhook processing and duplicate/echo protection.
- Added persistent issue and attachment operation ledgers; ambiguous writes are not automatically replayed.
- Added secret-safe logging and audit redaction.
- Jira issue deletion is not propagated.

### Documentation

- Consolidated installation, configuration, operations, security, troubleshooting, architecture, and release documentation.
- Removed obsolete intermediate design and duplicate operational reports.

See [docs/RELEASE_NOTES_V2.1.0.md](docs/RELEASE_NOTES_V2.1.0.md) for the complete release summary.


# [2.0.0](https://github.com/SerdarAbali/jira-sync-connector/compare/v1.0.0...v2.0.0) (2026-09-19)

### Breaking Changes

* Upgraded the Forge stack: `@forge/api` 6.2.0 → 8.1.0, `@forge/resolver` 1.7.1 → 2.0.0, `@forge/kvs` 1.2.2 → 2.0.6 (default export), `@forge/events` 2.0.12 → 3.0.6; runtime `nodejs20.x` → `nodejs22.x`. `@forge/bridge` intentionally kept at 3.x.

### Bug Fixes

* Fixed an undefined `remoteIssue` reference in inbound attachment handling (would throw at runtime).
* Hardened the project-statuses fetch in mapping data loaders (clear error instead of `statusData.forEach is not a function`).
* Fixed "Load Mapping Data" to use the local project key and added a local-project selector in the Mappings tab (different local/remote project keys now supported).
* Fixed inbound (Org B → Org A) updates failing when a mapped custom field is read-only or not on the local screen (e.g. "Flagged" = `customfield_10021`); the app now strips Jira-rejected fields and retries instead of aborting the entire sync.
* Added a "learned rejection" guard: fields Jira rejects are recorded per organization and flagged with ⚠️ in the Field Mappings UI, so unmappable fields can be cleaned up proactively.
* Field mapping dropdowns and rows now show the Jira field API ID (e.g. `customfield_10021`) alongside the display name.

### Tooling & Process

* Added ESLint config and tests (17 total); renamed `install` script to `forge:install` so `npm install` no longer launches an interactive Forge install; rebuilt the admin UI.
* Added semantic-release + GitHub Actions CI (lint/test) and Release workflows; tagged `v1.0.0` as the pre-upgrade baseline.
* Reconciled the README; removed stale branches and duplicate files; renamed the AI instructions file.
