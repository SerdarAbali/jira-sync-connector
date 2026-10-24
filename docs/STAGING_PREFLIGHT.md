# Staging preflight

`staging:preflight` is a read-only readiness check for a local and remote Jira
Cloud staging pair. It verifies project classification and Jira visibility that
can be observed over the Jira REST API and records evidence. It does not install
Forge, run migrations, create issues, certify development/staging operational
isolation, or certify a staging environment.

## Safety boundary

The runner has no Jira write path. It can request only these endpoints and
accepts only the documented HTTP `200` response:

- `GET /rest/api/3/myself`
- `GET /rest/api/3/project/search`
- `GET /rest/api/3/mypermissions`
- `GET /rest/api/3/project/{projectKey}`

Any other success status, including `201`, `202`, and `204`, fails the request
without treating its body as a successful result. Send, transition, delete, and
other mutating endpoints are rejected before a request is made. Pagination must
be complete. A page cap, missing total, stalled offset, conflicting project
identity, or unreadable page fails the check instead of producing a partial
inventory.

Credential-bearing execution is refused when `NODE_DEBUG` enables the native
`http` or `https` transport namespaces, because Node can write the Basic
authorization header to stderr. Remove those namespaces from `NODE_DEBUG` before
running the preflight.

## Configuration

Create `.env.staging` in the repository root and restrict it to the current
user. The runner checks `.env.staging.local` first, then `.env.staging`.
`--env-file` overrides that discovery, and `STAGING_*` variables in the process
environment override values from the file. The environment file must have mode
`600`. If its resolved location is inside a Git repository, that location must
also be ignored by Git; tracked or unignored credential files are rejected.

```bash
chmod 600 .env.staging
```

Required variables:

| Variable | Purpose |
| --- | --- |
| `STAGING_ALLOWED_HOSTS` | Comma-separated, exact Jira Cloud hostnames permitted for this run. |
| `STAGING_LOCAL_URL` | Local staging origin, `https://<site>.atlassian.net`. |
| `STAGING_LOCAL_EMAIL` | Atlassian account email for the local staging site. |
| `STAGING_LOCAL_API_TOKEN` | API token for the local staging account. |
| `STAGING_LOCAL_PROJECTS` | Staging project keys on the local site. |
| `STAGING_LOCAL_NON_STAGING_PROJECTS` | Explicit inventory of every other accessible local project. Set it to an empty value only when the account can access no other project. |
| `STAGING_REMOTE_URL` | Remote staging origin, `https://<site>.atlassian.net`. |
| `STAGING_REMOTE_EMAIL` | Atlassian account email for the remote staging site. |
| `STAGING_REMOTE_API_TOKEN` | API token for the remote staging account. |
| `STAGING_REMOTE_PROJECTS` | Staging project keys on the remote site. |
| `STAGING_REMOTE_NON_STAGING_PROJECTS` | Explicit inventory of every other accessible remote project. |

Optional variables:

| Variable | Default | Bounds |
| --- | --- | --- |
| `STAGING_REQUEST_TIMEOUT_MS` | `15000` | 1000-60000 |
| `STAGING_MAX_RETRIES` | `2` | 0-5 |
| `STAGING_RETRY_MAX_WAIT_MS` | `30000` | 0-60000 |
| `STAGING_PROJECT_PAGE_SIZE` | `50` | 1-100 |
| `STAGING_MAX_PROJECT_PAGES` | `40` | 1-100 |
| `STAGING_REPORT_DIR` | `artifacts/staging-preflight` | Relative path under `artifacts/` |

The allow-list accepts bare hostnames only. It rejects wildcards, schemes,
ports, paths, credentials, and non-`atlassian.net` hosts. The local and remote
sites must be distinct.

`STAGING_REPORT_DIR` is constrained to the canonical `artifacts/` subtree.
Absolute paths, parent traversal, a symlinked `artifacts/` directory that
resolves outside the working tree, and nested symlinks that escape that subtree
are rejected. An existing report directory with group or other permissions is
refused; correct it with `chmod 700 <directory>`. The runner never widens
`.gitignore` to accommodate another report location.

The process environment is read only for `STAGING_*` keys. Do not put tokens in
command-line flags, shell history, repository files, or issue comments. The
runner redacts API tokens, authorization headers, and email addresses from
errors and reports.

## Run the preflight

```bash
npm run staging:preflight
```

Useful variants:

```bash
# Machine-readable output for a CI artifact
npm run staging:preflight -- --json

# Check without creating files
npm run staging:preflight -- --no-report

# Use a file other than .env.staging
npm run staging:preflight -- --env-file .env.staging.local
```

The default command writes a private report and prints a terminal summary.
Reports are written with mode `0600` inside a directory with mode `0700`.
`latest.json` always mirrors the most recent run.

Render a persisted report later:

```bash
npm run staging:report
npm run staging:report -- --input artifacts/staging-preflight/<run-id>.json
npm run staging:report -- --json
```

Exit codes are shared by both commands:

| Code | Meaning |
| --- | --- |
| `0` | Every verifiable check passed. Operational isolation, Forge, and F07 are still unknown and certification is withheld. |
| `1` | At least one verifiable check failed. Review the report and next actions. |
| `2` | The command could not run, the report failed validation, or the output path was unsafe. |

## Checks

The report contains these checks:

- **Configuration**: required values, URL shape, host allow-list, project
  inventory syntax, report directory, and numeric bounds.
- **Host allow-list**: both sites are distinct and explicitly allowed.
- **Authentication**: `/myself` succeeds for both accounts and both accounts are
  active. Credential failures fail closed.
- **Accessible projects**: the complete paginated inventory is read for both
  sites, or the check fails.
- **Staging projects**: every configured staging key resolves through
  `/project/{key}` and matches the requested key.
- **Permissions**: `BROWSE_PROJECTS` is verified on every staging project.
- **Project classification and visibility**: every accessible project is
  explicitly classified as staging or non-staging, every configured non-staging
  project is accessible, staging project IDs are verified, and no project ID or
  key appears in both inventories. The report includes SHA-256 evidence digests.
  A successful classification remains `unknown` for operational isolation in
  the report. It does not show whether development is synchronizing the same
  projects, whether development configuration is deployed, which callbacks or
  pending work exist, or what the development account can access.

Forge staging installation, F07 migration state, and development/staging
operational isolation are reported as `unknown`. The read-only Jira APIs do not
expose those facts, and environment claims such as `STAGING_FORGE_INSTALLED` or
`STAGING_F07_MIGRATION_STATE` are ignored. Consequently, every report keeps
`isolation.verified: false`, never marks the classification check as `pass`, and
keeps `certification: "withheld"` even when all verifiable checks pass.

## Reports

Reports are JSON with `kind: "jira-sync-staging-preflight"` and schema version
`1.0`. They include:

- run ID and generation time
- masked site identities and project inventories
- per-check status and evidence
- classification digests, `isolation.verified: false`, and an explicit
  `operationalIsolation.status: "unknown"` reason
- Forge and F07 `unknown` status
- summary status, exit code, and `certification: "withheld"`
- concrete next actions for failures

Persisted reports are validated before rendering. Missing or duplicate checks,
unknown check identifiers, invalid statuses, inconsistent summary counts or
failed-check lists, malformed evidence, contradictory exit codes, a claimed
`isolation.verified: true`, a passing isolation check, or any certification
other than `withheld` cause exit code `2`; they are never rendered as a pass.

Reports can contain staging hostnames, account IDs, and masked emails. Treat
`artifacts/` as private local output. It is ignored by Git and must not be
attached to a public issue without review.

## Scope limits

This command does not prove development/staging operational isolation, live
synchronization behavior, Forge installation, webhook delivery, migration
completion, Marketplace compliance, or end-to-end write safety. Project
classification is not evidence that development configuration, callbacks, and
pending work are absent. A separate, explicitly gated write runner is required
before any E2E mutation; it is not part of this preflight.
