# F07 administration and readiness

For the separate local initializer and the exact disposable-staging policy
exception, see [fresh initialization](F07-FRESH-INITIALIZATION.md).
It does not enable the legacy activation operation described below.

Status: implemented locally on the staging E2E branch. Nothing in this change is
deployed, F07 remains inactive in the staging installation, Pause and webhooks
are untouched, no Jira mutation was made and no release, tag or push followed.
The activation operation fails closed by design: it reports `BLOCKED` because
Forge exposes no supported evidence that legacy writers have been retired.

## Part A — read-only readiness

`getConnectorReadiness` is an `ADMIN_READ` resolver in
`src/resolvers/readiness.js`. The existing authorization wrapper requires a
signed-in Jira administrator (`ADMINISTER`) and audits nothing for reads. The
implementation is `src/services/readiness/connector-readiness.js`.

It returns installation-scoped facts only:

- **Identity** from the supported Forge SDK (`getAppContext`): the AppAri
  object (`appAri.appId` is the application UUID, `toString()` is the complete
  `ari:cloud:ecosystem::app/<uuid>`), app version, environment id and type,
  installation id, installation context cloud IDs and the invocation module key.
  Both canonical forms are returned and must agree.
- **Site** from the read-only Jira Cloud REST v3 `/rest/api/3/serverInfo`
  endpoint (`baseUrl`). No URL-provisioning or webtrigger URL operation is
  called.
- **Pause** from the existing authoritative `pilotPause` record, read fresh.
  A missing record means active; a malformed record fails closed as paused; an
  unreadable store is reported unknown, never active.
- **F07 migration status** from `issueLeaseMigration:v1`, including `valid`,
  `active`, `phase` and explicit reason codes (`migration-missing`,
  `migration-drain-incomplete`, `migration-activated-in-future`, ...). Only the
  five documented control fields are returned.
- **Organizations, project mapping and direction** from the existing
  organization, `projectMappings:<orgId>` and `allowedProjects`/`remoteProjectKey`
  records. Invalid directions or project keys are never promoted.
- **Comment synchronization** from `syncOptions:<orgId>`, with the admin
  default when the preference is absent. A stored value that is not a boolean
  makes readiness `READINESS_CONFIGURATION_INVALID` instead of enabling or
  disabling synchronization silently.
- **Signed webhook status and receipts** from secret presence (boolean only),
  rotation metadata and the authenticated receipt record. For bidirectional
  organizations the aggregate requires every organization to have a secret,
  uses the oldest receipt so one fresh delivery cannot mask a stale one, and
  rejects a receipt recorded before the latest signing-key rotation (the same
  freshness rule as the setup validator). Malformed rotation metadata fails
  closed.

Credentials are read only to prove presence. API tokens, signing secrets,
Authorization headers and raw storage records never enter the result; tests
assert both the serialized output and every key name.

Failure behaviour: unavailable Forge identity, unreadable pause, unreadable
migration state and unreadable configuration storage are reported as
`success: false` or `unknown`; none of them can produce a verified status.

## Part B — guarded F07 activation

`activateIssueLeaseMigration` is an `ADMIN_WRITE` resolver in
`src/resolvers/lease-migration.js`; the decision logic is
`src/services/sync/lease-migration-activation.js`. The authorization wrapper
requires Jira `ADMINISTER`, records an audit entry for the attempt and returns
`FORBIDDEN` otherwise.

Every attempt is evaluated in this order and stops at the first failure:

1. **Strict input surface.** Only `confirmation` (exact value
   `ACTIVATE_ISSUE_LEASES`) and an optional `retirement` timestamp are accepted.
   Any other field (`state`, `verified`, `source`, `legacyDisabled`, ...) is
   rejected as `UNSUPPORTED_ACTIVATION_INPUT`, so a caller cannot assert
   readiness or migration state.
2. **Identity binding** from `getAppContext`; activation cannot proceed when
   app, environment or installation identity is missing.
3. **Authoritative Pause** must be actively paused before any storage work, and
   is read again after the entity probe. A lost or unreadable Pause blocks.
4. **Migration state** must be absent or an explicit inactive phase
   (`legacy`, `pending`, `draining`, `inactive`). Already active, malformed or
   unrecognized state is rejected; activation is never a re-activation path.
   Absent state is the documented pre-activation state; a missing, malformed or
   ambiguous *retirement* record is never inferred from elapsed time.
5. **Drain window.** When a retirement timestamp is supplied, it must be a safe
   integer, not future-dated, and at least `1_140_000` ms (19 minutes) old.
   The timestamp is used only for this arithmetic and is never treated as proof.
6. **Custom Entity protocol probe.** Against real Forge storage, the operation
   conditionally creates a short-lived `issue-lease` probe row, proves that a
   duplicate conditional create is rejected, reads the row back, conditionally
   deletes it and proves it is gone. Any unexpected error, an unenforced
   condition or a read-back mismatch yields `ENTITY_PROTOCOL_UNVERIFIED`.
   Only the probe key is touched; mappings, leases, ledgers and the migration
   key are untouched, and the probe is cleaned up on every path.
7. **Re-validation.** Pause and migration state are read again after the probe
   to detect a concurrent change.
8. **Legacy writer retirement.** The operation returns `BLOCKED` with
   `LEGACY_RETIREMENT_UNVERIFIED`, `activation.performed: false` and
   `activation.wroteMigrationState: false`. No migration record is written.

Why the final step cannot pass: F07 requires verified retirement of every
legacy writer (old major versions, queue consumers, scheduled handlers, external
callers) and a 19-minute drain after it. Supported Forge interfaces do not
prove that a previous deployment or consumer can no longer run, and this change
does not invent a proof mechanism such as an operator-supplied boolean, a
deployment timestamp, a signed file or a claimed `source`. Until a supported
platform/operator evidence channel exists, activation remains blocked by design.

Rollback and data preservation: because the operation writes nothing, existing
mappings, leases, operation ledgers and uncertainty records are preserved, and
there is no partial activation state to reconcile.

## Part C — runner integration

`src/resolvers/readiness.js` serves `getConnectorReadiness` through the existing
authenticated Forge admin resolver used by the Custom UI admin page, and
`static/admin-page/src/App.jsx` exposes the read-only automation handle
`window.__syncConnectorReadinessInvoke()`. The separate fresh initializer is
available through `window.__syncConnectorInitializeFreshIssueLeases(confirmation)`
and still requires the server's explicit confirmation, ADMIN_WRITE authorization
and exact staging identity. Neither handle runs automatically. The legacy
activation resolver is not exposed to the page or to automation.

`scripts/staging/lib/forge-admin-readiness.js`:

- **Acquisition is disabled and fails closed.** `readForgeAdminReadiness()`
  takes no arguments and always rejects with
  `AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE`. There is no `page`,
  `evaluate`, `invoke` or facts argument: a caller-supplied object with
  `url()`/`evaluate()` members can fabricate every fact the runner asks for, so
  the acquisition path was removed instead of being validated more strictly.
  The runner and the CLI never invoke a caller-supplied callback.
- `normalizeReadinessResponse()` and `bindReadinessResponse()` remain exported as
  pure validation building blocks. `bindReadinessResponse(raw, expected)`
  validates the response contract (version, shape, timestamps, no credential
  material: `READINESS_RESPONSE_INVALID`,
  `READINESS_RESPONSE_CONTAINS_SECRETS`) and binds the expected app ARI/UUID,
  installation id, environment id, environment type and site host. Missing or
  mismatched identity fails with `READINESS_BINDING_REQUIRED`,
  `READINESS_APP_MISMATCH`, `READINESS_INSTALLATION_MISMATCH`,
  `READINESS_ENVIRONMENT_ID_MISMATCH` or `READINESS_ENVIRONMENT_MISMATCH`.
  Binding is validation, not authentication: calling it yourself with your own
  object proves nothing.
- The supported SDK contract is normalized: `appAri.appId` is the application
  UUID and `toString()` is the complete `ari:cloud:ecosystem::app/<uuid>`. A
  bare UUID is promoted to the canonical ARI and the two forms must agree.
- `scripts/staging/lib/e2e-evidence.js` treats every readiness input as an
  operator claim (`READINESS_BASIS.CLAIMS`): a `readiness` object, a readiness
  document and a legacy verification object are reported as
  `readiness-verification-unsupported` plus `readiness-unverified`, each
  claim-derived check is downgraded to `unknown`, and write mode is blocked
  before a request is made. An adapter failure is recorded as
  `authenticated-connector-adapter-unavailable`; an identity mismatch or any
  other failure stays `blocked`/`unknown` as before.

Expected identity comes from `STAGING_E2E_FORGE_INSTALLATION_ID` and
`STAGING_E2E_FORGE_ENVIRONMENT_ID`; the app ARI is fixed by the manifest and the
site host by the local staging configuration. No CLI flag, environment variable,
file or run option supplies readiness facts, so production readiness remains
unavailable and BLOCKED. That is the required fail-closed state.

### Future authenticated adapter (documented, not implemented)

```
scripts/staging/lib/forge-admin-browser-adapter.js   # does not exist yet
  createForgeAdminBrowserAdapter({ browser, siteHost, adminUrl })
    -> { readConnectorReadiness(): Promise<unknown> }
  bindReadinessResponse(await adapter.readConnectorReadiness(), expectedIdentity)
```

The adapter owns the signed-in browser session, restricts navigation to
`siteHost` and invokes `window.__syncConnectorReadinessInvoke()` exactly once
(see `READINESS_EXPRESSION`). Only a raw payload produced by that adapter, bound
to the expected identity, may ever be promoted to `verified`; until it exists
`readForgeAdminReadiness()` keeps rejecting and the staging E2E write gate stays
BLOCKED.

### Corrected review defects

1. Caller-created readiness cannot bypass verification: the public sealing
   function, the `page`/`evaluate`/`invoke` entry points and every caller-supplied
   readiness argument are removed, and `readForgeAdminReadiness()` always rejects
   with `AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE` until a real authenticated
   browser adapter exists.
2. Installation and environment identity are bound (app UUID/ARI, installation
   id, environment id, environment type). Evidence replayed from another or a
   previous installation is BLOCKED.
3. `appAri.appId` is treated as the UUID from the real SDK contract and the
   complete ARI is derived and validated; the genuine app passes and another
   app fails.
4. A signed-webhook receipt older than the latest signing-key rotation does not
   certify webhook readiness.
5. Malformed stored `syncOptions.syncComments` fails closed instead of becoming
   enabled synchronization.


## Operational prerequisites

- The connector must be installed on the local staging Jira site and the
  administrator must be signed in; readiness resolves the site from
  `serverInfo`.
- Custom Entity schema deployment and both indexes must be ACTIVE before the
  entity protocol probe can pass.
- Legacy F07 migration requires the 19-minute drain after verified legacy writer
  retirement. No supported evidence source is available in this change, so
  activation stays `BLOCKED`.
- The E2E write gate additionally requires staging configuration
  (`STAGING_E2E_*`, including the expected Forge installation and environment
  ids), connector readiness verified by an authenticated admin browser adapter,
  and the disposable-test confirmation. No such adapter is implemented in this
  repository: `readForgeAdminReadiness()` always rejects with
  `AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE`, so every write run stays
  `BLOCKED` before a Jira client is created.

### Installation-history evidence for the new staging installation

For installation `974910c5-2861-4d40-a7eb-37802842d0a0` only, the operator has
waived historical provenance as an initialization prerequisite because the sites
are disposable test environments. The exact restriction and administrator action
are documented in [fresh initialization](F07-FRESH-INITIALIZATION.md). This is
an engineering policy exception, not newly obtained Atlassian history. The
historical-evidence requirements below continue to govern legacy migration;
they do not block this installation's separate policy-bound initializer.

The staging installation is `974910c5-2861-4d40-a7eb-37802842d0a0`. It was
installed with the guarded candidate and has never been configured for
synchronization. That statement alone is not activation evidence.

The minimum authoritative evidence is an Atlassian-supported installation and
deployment history for that installation id covering every installed app
version, function deployment and event consumer, showing that no pre-guard
legacy writer was ever installed or invoked. If any legacy-capable version was
installed, the history must also establish when its writers were retired, so the
19-minute drain can be measured. Operator-authored booleans, timestamps, signed
files or `source` claims are not acceptable substitutes.

## Legacy migration next step

Establish a supported, auditable source of legacy-writer retirement evidence
(for example an Atlassian-confirmed deployment/consumer retirement record) and
feed it into the guarded activation precondition without accepting self-asserted
payload fields. Until that exists, do not deploy an activation bypass: keep Pause
authoritative and leave F07 inactive.

## Local verification

Run offline, in this environment on Node v26.9.0 (the source keeps Node 22
compatible syntax and APIs):

| Check | Result |
| --- | --- |
| Full Jest (`jest --runInBand --silent`) | 69 suites, 1439 tests passed |
| Focused F07 admin suites | 3 suites, 44 tests passed |
| Staging E2E suites (runner, CLI, readiness channel) | 3 suites, 145 tests passed |
| `npm run lint` | Passed |
| `npm run check:secrets` | Passed |
| `npm run check:neutrality` | Passed |
| `npm run check:forge:offline` | Passed (0 warnings) |
| `node --check` on changed sources and tests | Passed |
| `git diff --check` | Passed |

These are deterministic local checks. They do not establish live Forge
behavior, authenticated lint, deployment/index readiness or live Jira
authorization.
