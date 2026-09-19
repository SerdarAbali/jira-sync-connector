# [2.0.0](https://github.com/SerdarAbali/jira-sync-connector/compare/v1.0.0...v2.0.0) (2026-09-19)

### Breaking Changes

* Upgraded the Forge stack: `@forge/api` 6.2.0 → 8.1.0, `@forge/resolver` 1.7.1 → 2.0.0, `@forge/kvs` 1.2.2 → 2.0.6 (default export), `@forge/events` 2.0.12 → 3.0.6; runtime `nodejs20.x` → `nodejs22.x`. `@forge/bridge` intentionally kept at 3.x.

### Bug Fixes

* Fixed an undefined `remoteIssue` reference in inbound attachment handling (would throw at runtime).
* Hardened the project-statuses fetch in mapping data loaders (clear error instead of `statusData.forEach is not a function`).
* Fixed "Load Mapping Data" to use the local project key and added a local-project selector in the Mappings tab (different local/remote project keys now supported).

### Tooling & Process

* Added ESLint config and tests (17 total); renamed `install` script to `forge:install` so `npm install` no longer launches an interactive Forge install; rebuilt the admin UI.
* Added semantic-release + GitHub Actions CI (lint/test) and Release workflows; tagged `v1.0.0` as the pre-upgrade baseline.
* Reconciled the README; removed stale branches and duplicate files; renamed the AI instructions file.
