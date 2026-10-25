# Staging E2E

Current authenticated acquisition: see [browser readiness](STAGING-BROWSER-READINESS.md).
The owned browser adapter supersedes older statements below that acquisition is
unimplemented. Caller documents remain unverified; all operational safety checks
continue to apply.

`staging:e2e` is the opt-in, write-gated end-to-end suite for a local and
remote Jira Cloud staging pair. It verifies that the deployed connector really
synchronizes issues, field updates, status transitions and public comments in
both directions, and that no duplicate counterparts appear.

The suite has three modes. Two of them cannot mutate Jira at all.

| Mode | Command | Jira traffic | Mutations |
| --- | --- | --- | --- |
| Plan | `npm run staging:e2e:plan` | none | none |
| Dry run | `npm run staging:e2e:dry-run` or `npm run staging:e2e` | read-only `GET` | none |
| Write | `npm run staging:e2e -- --write` | read-only + mutations | bounded |

Write mode is never implied by an npm script. It requires the `--write`
argument **and** the exact `STAGING_E2E_WRITE_MODE` confirmation value; without
both, the run is recorded as `blocked`, no Jira client is created, and no
request is sent.

**Write mode is currently unreachable by design.** The confirmation authorizes
a disposable-test execution, but it is not technical evidence. Connector facts
cannot be verified from outside the connector yet: the authenticated readiness
adapter is not implemented, so `readForgeAdminReadiness()` always rejects with
`AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE` and `runE2E` blocks every write run
with `readiness-unverified` even when the readiness bundle is complete and well
formed (see
[Readiness: claims versus verification](#readiness-claims-versus-verification)).

## Safety boundary

- Hosts are restricted to `STAGING_ALLOWED_HOSTS`; both sites must be distinct
  `atlassian.net` origins.
- Mutations are restricted to the configured staging project allow-list
  (`STAGING_LOCAL_PROJECTS` / `STAGING_REMOTE_PROJECTS`). A create, update,
  transition or delete outside that list is refused before the request.
- Every run has a fixed mutation budget, and every propagation check has a
  polling deadline (`STAGING_E2E_SYNC_TIMEOUT_MS` with
  `STAGING_E2E_MAX_POLLS` as the hard stop); polling never sleeps past the
  deadline.
- The runner only creates issues it owns, prefixes every marker with the run ID,
  and deletes each run-owned fixture during cleanup unless
  `STAGING_E2E_CLEANUP=false`.
- Cleanup never sends `deleteSubtasks`. A run-owned parent is deleted only when
  every subtask it has is itself a run-owned fixture; otherwise the parent is
  retained and the unowned or unreadable children are reported.
- API tokens, encoded Basic credentials and email addresses are redacted from
  errors, terminal output, `--json` output and reports. A report that still
  contains a configured credential after redaction is refused before it is
  written.
- Incomplete pagination is never treated as complete. Search results that end on
  a repeated token, a stalled continuation or the page cap, and comment pages
  that stop before the reported `total`, produce `UNKNOWN` assertions instead of
  a uniqueness or destination pass.
- `NODE_DEBUG=http,https` is rejected, exactly as in the preflight: Node would
  otherwise print the Basic authorization header to stderr.

## Prerequisites

The read-only dry run (`npm run staging:e2e:dry-run`) passes when all of the
following hold. Any missing item produces `BLOCKED` (exit code `3`) instead of a
simulated success.

1. A passing read-only preflight: `npm run staging:preflight`.
2. An environment file with the staging sites, accounts and project
   inventories, readable only by the current user (`chmod 600`).
3. A readiness bundle that declares the connector `appId`, environment, local
   installation, pause state, F07 state, project mapping, comment flag and, for
   bidirectional synchronization, a signed webhook with a receipt. See
   [Readiness: claims versus verification](#readiness-claims-versus-verification).
4. Both staging accounts grant `BROWSE_PROJECTS`, `CREATE_ISSUES`,
   `EDIT_ISSUES`, `ADD_COMMENTS`, `TRANSITION_ISSUES` and `DELETE_ISSUES` on
   the selected projects. For a push-only mapping the remote account needs only
   `BROWSE_PROJECTS` and `DELETE_ISSUES`. This is the part the runner verifies
   itself, with read-only Jira REST calls.
5. A fresh bundle: `generatedAt` must be within
   `STAGING_E2E_EVIDENCE_MAX_AGE_MS` (default 15 minutes).

A write run additionally requires verified connector readiness, which is not
available in this repository yet. See below.

## Readiness: claims versus verification

An exported readiness bundle is a **claim**. Jira REST can establish account
identity, accessible projects and permissions, but it cannot observe:

- whether the Forge app is installed on the site;
- whether the connector is paused;
- the F07 issue-lease migration phase and the legacy-lease drain window;
- the connector's project mappings and comment feature flag;
- whether a signed webhook was delivered and when.

Jira REST cannot observe those facts, Forge storage has no external inspection
endpoint, and this runner does not read connector storage. The connector exposes
them only through the authenticated Forge admin resolver `getConnectorReadiness`
(`ADMIN_READ`, Jira administrator required), which only a signed-in admin browser
session can invoke.

**That acquisition path is disabled and fails closed.** The staging runner calls
`readForgeAdminReadiness()` from
`scripts/staging/lib/forge-admin-readiness.js`. The function takes no arguments —
no browser page, no `evaluate`/`invoke` callback, no facts object — and always
rejects with `AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE`, because no
authenticated Forge admin browser adapter is implemented. A caller-supplied
object could fabricate every fact the runner needs, so the path is not accepted at
all instead of being validated more strictly. See
[F07 administration and readiness](F07-ADMIN-READINESS.md).

Consequently:

- Without an authenticated response, `validateReadiness` returns `unknown` for
  every claim-derived fact and adds `readiness-unverified` plus one
  `<fact>-unverified` reason per fact.
- A dry run still performs its read-only Jira checks and reports the unverified
  connector facts separately; it never certifies synchronization.
- A write run is blocked before any Jira client is created.
- A claim that is internally inconsistent or unsafe still blocks outright:
  a different `appId`, a mismatched environment, `pause.paused: true`, a
  missing or ambiguous mapping, no local installation, or a bidirectional
  mapping without a configured webhook.
- An operator confirmation (`STAGING_E2E_WRITE_MODE`) authorizes disposable-test
  execution only. It never substitutes for technical readiness evidence, and no
  flag, environment variable or file can promote a claim to verified.

Every readiness input the runner receives — a `readiness` object, a readiness
document, or a legacy `connectorVerification` — is treated as an operator claim.
`validateReadiness` reports `READINESS_BASIS.CLAIMS`, adds
`readiness-verification-unsupported` and `readiness-unverified`, downgrades each
claim-derived check to `unknown`, and blocks write mode before a Jira client is
created. The adapter failure itself is recorded as
`authenticated-connector-adapter-unavailable`. No CLI flag, environment variable,
file or run option supplies readiness facts, and the CLI never constructs a
browser page, so production readiness is unavailable and write mode is blocked.

`normalizeReadinessResponse()` and `bindReadinessResponse()` remain exported as
pure validation building blocks for the future adapter. They validate the
response shape and confidentiality (no credential material) and bind the expected
app ARI/UUID, installation id, environment id, environment type and site host.
Binding is validation, not authentication: calling it with your own object
authenticates nothing, and a bound payload on its own still yields `unknown`,
`unverified-claims` and no verification object.

Future adapter contract (documented, not implemented):
`createForgeAdminBrowserAdapter({ browser, siteHost, adminUrl })` returning
`{ readConnectorReadiness() }`, whose raw payload must be passed through
`bindReadinessResponse()`. The adapter owns the signed-in browser session and
invokes `window.__syncConnectorReadinessInvoke()` exactly once. Until it exists,
every write run stays `BLOCKED`.

Any facts that do arrive are still validated by the same readiness rules: a
paused connector, an inactive or invalid F07 state, a missing or ambiguous
mapping, a malformed comment-sync preference, or a missing/stale signed-webhook
receipt (including a receipt older than the latest signing-key rotation) keeps
write mode blocked. Readiness is `ADMIN_READ` only; no E2E path can call the F07
activation resolver.


## Connector topology

The connector runs on the local Jira site only. It reaches the remote site over
the Jira REST API with its own stored credentials.

- A Forge installation is required on the **local** site for write readiness.
- A Forge installation on the **remote** site is **not** required and its
  absence is never a blocker.
- Remote readiness is verified separately: an authenticated Jira REST
  connection (identity, project access, permissions) plus signed-webhook
  readiness for bidirectional synchronization.

## Configuration

The E2E runner reuses the preflight configuration and adds its own `STAGING_E2E_*`
keys. `--env-file` overrides discovery; `STAGING_*` values in the process
environment override the file.

Base variables (`STAGING_*`) are documented in
[`docs/STAGING_PREFLIGHT.md`](./STAGING_PREFLIGHT.md). The E2E-specific values
are:

| Variable | Default | Purpose |
| --- | --- | --- |
| `STAGING_E2E_EVIDENCE_FILE` | none | Relative path inside `artifacts/` to the readiness bundle. Required. |
| `STAGING_E2E_ENVIRONMENT` | `staging` | Forge environment under test; must match the readiness claim and would be bound by the future authenticated adapter. |
| `STAGING_E2E_FORGE_INSTALLATION_ID` | none | Expected Forge installation id, bound by the future authenticated adapter. Without that adapter readiness stays a claim. |
| `STAGING_E2E_FORGE_ENVIRONMENT_ID` | none | Expected Forge environment id, bound by the future authenticated adapter. Without that adapter readiness stays a claim. |
| `STAGING_E2E_LOCAL_PROJECT` | none | Selects the local side of the project pair when the bundle maps several. |
| `STAGING_E2E_REMOTE_PROJECT` | none | Selects the remote side; must be set together with the local selector. |
| `STAGING_E2E_ISSUE_TYPE` | `Task` | Issue type created in both projects; must be creatable there. |
| `STAGING_E2E_WRITE_MODE` | unset | `I_UNDERSTAND_DISPOSABLE_STAGING` is the only accepted confirmation. |
| `STAGING_E2E_PERMISSIONS` | `CREATE_ISSUES,EDIT_ISSUES,ADD_COMMENTS,CREATE_ATTACHMENTS,LINK_ISSUES,TRANSITION_ISSUES` | Permission list validated at configuration time. A write run verifies its own fixed set: `BROWSE_PROJECTS`, `CREATE_ISSUES`, `EDIT_ISSUES`, `ADD_COMMENTS`, `TRANSITION_ISSUES`, `DELETE_ISSUES`. |
| `STAGING_E2E_EVIDENCE_MAX_AGE_MS` | `900000` | Freshness window for the bundle and the webhook receipt. |
| `STAGING_E2E_SYNC_TIMEOUT_MS` | `180000` | Deadline for one propagation check. |
| `STAGING_E2E_POLL_INTERVAL_MS` | `2000` | Initial poll interval. |
| `STAGING_E2E_POLL_MAX_INTERVAL_MS` | `15000` | Backoff ceiling. |
| `STAGING_E2E_MAX_POLLS` | `60` | Maximum polls per propagation check. |
| `STAGING_E2E_DUPLICATE_SETTLE_MS` | `5000` | Quiet period used by the duplicate-counterpart check. |
| `STAGING_E2E_CLEANUP` | `true` | Deletes run-owned fixtures at the end of a run. |
| `STAGING_E2E_REPORT_DIR` | `artifacts/staging-e2e` | Relative path under `artifacts/` for reports. |

### Readiness bundle

```json
{
  "kind": "jira-sync-connector-readiness",
  "schemaVersion": "1.0",
  "generatedAt": "2026-10-24T12:00:00.000Z",
  "source": "connector-admin",
  "capturedBy": "operator",
  "connector": {
    "appId": "ari:cloud:ecosystem::app/<app-id-from-manifest.yml>",
    "installationStatus": "installed",
    "installedSites": ["localstaging.atlassian.net"],
    "environment": "staging"
  },
  "pause": { "paused": false },
  "f07": {
    "version": 1,
    "phase": "entity-active",
    "legacyDisabled": true,
    "disabledAt": 1761307200000,
    "activatedAt": 1761308400000
  },
  "organizations": [
    {
      "orgId": "org-staging",
      "syncDirection": "bidirectional",
      "features": { "syncComments": true },
      "projectMappings": [{ "localProjectKey": "STG", "remoteProjectKey": "RSTG" }]
    }
  ],
  "webhook": {
    "configured": true,
    "lastReceipt": { "receivedAt": "2026-10-24T11:59:30.000Z" }
  }
}
```

The bundle must be a regular file (no symlinks) inside `artifacts/`, at most
256 KiB, and must not contain token-, secret- or authorization-shaped keys or
values. Every connector field in it is treated as an unverified claim; only the
local site's installation matters, and a remote entry is optional.

## Commands

```bash
# Preview the proposed scenarios. No Jira request, no report of a run.
npm run staging:e2e:plan

# Read-only verification of readiness, identity, access, permissions and the
# issue type, with every scenario skipped. This is also the default mode.
npm run staging:e2e:dry-run
npm run staging:e2e

# Machine-readable output, or no persisted artifacts
npm run staging:e2e -- --json
npm run staging:e2e -- --no-report

# Use a specific environment file
npm run staging:e2e -- --env-file .env.staging.local

# Mutating run: requires the flag AND the confirmation value.
STAGING_E2E_WRITE_MODE=I_UNDERSTAND_DISPOSABLE_STAGING \
  npm run staging:e2e -- --write
```

`npm run staging:e2e` alone can never write: the script carries no `--write`
argument, and the runner additionally demands the confirmation value from the
environment file or process environment. Setting `STAGING_E2E_WRITE_MODE`
without `--write` still produces a dry run; setting `--write` without the exact
value produces a `blocked` report with no Jira request. `--plan` and `--write`
cannot be combined. Even with the exact value, write mode stays blocked: the
authenticated readiness adapter is not implemented, so readiness is reported as
`unverified-claims` and the run is blocked before a Jira client is created.

Run the offline regression suite for the runner and the CLI:

```bash
npm run test:staging:e2e
```

## Output

A terminal summary is always printed:

```text
Staging E2E PASS (dry run)
Run: staging-e2e-20261024t120000z-1a2b3c
Sites: local localstaging.atlassian.net/STG -> remote remotestaging.atlassian.net/RSTG (bidirectional)
Connector readiness: unknown, unverified-claims
  readiness: Connector installation, pause state, F07 migration, project mapping and signed-webhook delivery are unverified operator claims.
Scenarios:
  [SKIP] local-issue-created-and-synced
  ...
Mutations: 0 of 60 budget used
```

Plan mode prints `Staging E2E plan PASS|BLOCKED|INTERRUPTED`, the blocking
configuration issues, and the proposed scenario list with `[PLAN]` markers. A
plan cannot pass while connector readiness is only claimed, because a write run
could not pass either.

An interrupted run prints `INTERRUPTED` with the same partial evidence and exits
with code `2`; it never prints `PASS`.

Reports are written with mode `0600` inside a directory with mode `0700`:

| File | Contents |
| --- | --- |
| `<run-id>.json` | The validated run report (`kind: "jira-sync-staging-e2e"`). |
| `latest-e2e.json` | Mirror of the most recent run report. |
| `<run-id>-plan.json` | The plan preview (`kind: "jira-sync-staging-e2e-plan"`). |
| `latest-plan.json` | Mirror of the most recent plan. |

Plan reports are stored separately so a plan can never be read as evidence that
a scenario passed. `artifacts/` is ignored by Git and must be treated as private
local output.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Pass. For a dry run this means read-only prerequisites passed; it does not certify synchronization or connector readiness. |
| `1` | A required scenario assertion failed, a duplicate check could not be completed, or a run-owned fixture could not be removed. |
| `2` | The run could not start, an argument was invalid, the report could not be written or validated, or the run was interrupted. The report and the terminal output both say `INTERRUPTED`. |
| `3` | Blocked. Credentials, project mapping, local installation evidence, F07 state, the readiness bundle, verified connector readiness or another mandatory prerequisite is missing. |

## Bounded execution and interruption

- Requests time out after `STAGING_REQUEST_TIMEOUT_MS`; retries are bounded by
  `STAGING_MAX_RETRIES` and `STAGING_RETRY_MAX_WAIT_MS`.
- Each propagation check stops after `STAGING_E2E_SYNC_TIMEOUT_MS` or
  `STAGING_E2E_MAX_POLLS`, whichever comes first.
- A mutation budget stops the run before it exceeds the configured ceiling.
- Pagination is bounded per endpoint: search reads at most 10 token pages,
  comments at most 20 offset pages and create metadata at most 5 pages. Hitting
  a cap with more data advertised yields an INCOMPLETE result, never a pass.
- `SIGINT`/`SIGTERM` is carried into the runner as an abort predicate (a
  standard `AbortSignal` is honoured too). The
  runner checks it before every scenario write (create, update, transition,
  comment, reverse create) and before each duplicate search, and aborts a poll
  that is waiting for synchronization. Once interrupted:
  - no further scenario write is started, including a transport retry: the
    cancellation predicate is re-checked before every mutation attempt, so a
    rate-limited (`429`) write is not retried after the signal. A request that
    was already sent may still complete; interruption never claims to have
    reversed it;
  - evidence of completed or uncertain operations is kept (assertions, fixtures,
    mutation log, partial scenario results);
  - only bounded, run-owned cleanup runs — no search, no create, no cascade;
  - the report summary status becomes `interrupted` with exit code `2`, and an
    interrupted fixture that could not be removed is listed as remaining work;
  - an interrupted run never reports `PASS` and never exits `0`.

## Evidence and remaining work

- Every fixture the run creates is listed in the report with its cleanup status:
  `deleted`, `already-absent`, `retained`, `retained-unowned-children`,
  `retained-uncertain` or `failed`.
- `retained-unowned-children` lists the child keys that prevented deletion, so
  an operator can resolve them deliberately instead of the suite deleting
  another user's work.
- The run report records the readiness basis (only `unverified-claims` is
  reachable today; `authenticated-connector` requires the future adapter), the
  reason codes behind a blocked or unknown verdict, and the mutation log.

## Scope limits

The suite verifies synchronization behavior for one issue type in one mapped
staging project pair, using disposable issues that it deletes afterwards. It
does not certify development/staging operational isolation, Marketplace
compliance, attachment or issue-link synchronization, SLA behavior, or
production readiness. It performs no deploy, install, migration or webhook
configuration; those remain separate, explicitly approved operations.
