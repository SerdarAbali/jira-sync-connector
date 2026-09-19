# [2.0.0](https://github.com/SerdarAbali/jira-sync-connector/compare/v1.0.0...v2.0.0) (2026-09-19)


* feat!: upgrade to Forge stack v2 (api 8, resolver 2, kvs 2, events 3, nodejs22) ([9a41679](https://github.com/SerdarAbali/jira-sync-connector/commit/9a416797cbb69fe4f18513f88b02bb628024185c))


### BREAKING CHANGES

* coordinated major upgrade of @forge/* packages and Forge runtime nodejs20.x -> nodejs22.x. Bumps @forge/api to 8.1.0, @forge/resolver to 2.0.0, @forge/kvs to 2.0.6, @forge/events to 3.0.6. Fixes kvs default import, drops unused authorize import, fixes undefined remoteIssue reference in inbound attachment handling. Adds semantic-release config, GitHub Actions CI, ESLint config, and new tests.
