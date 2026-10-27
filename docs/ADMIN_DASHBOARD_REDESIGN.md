# Administration dashboard redesign

Baseline: branch `test/v2.1.1-staging-e2e`, commit `ffff026`.

## Acceptance and boundaries

The frontend must provide seven primary pages, explicit organization selection,
installation scope labels, every existing workflow, unchanged resolver payloads
and confirmation semantics, isolated organization sessions, and no mutation on
navigation. Analytics must use existing recorded data and distinguish missing
values from zero. Narrow iframe layouts must remain usable.

Changes are restricted to `static/admin-page/src`, UI regression tests and this
review document. No synchronization service, resolver, storage implementation,
permission policy, manifest, deployment configuration or dependency was changed.
No live operation or deployment is part of verification.

## Implemented hierarchy

- `App`: navigation and keyed organization-session lifetime.
- `hooks/useAdminController`: existing UI state, loaders, validation and handlers.
- `dashboard/DashboardShell`: shared header, organization selector, primary
  navigation and installation write-state strip.
- `dashboard/OrganizationsPage`: Connection, Scope & direction, Mappings,
  Sync options, Synchronization, Guided Setup and Configuration transfer.
- `dashboard/OrganizationSynchronization`: existing initial-sync and recurring
  reconciliation components, plus legacy-scheduler status.
- `dashboard/DataViews`: Overview, Analytics, compact metrics and dense tables.
- `dashboard/ActivityPage`: retained errors, scheduled events and witness audit.
- `dashboard/RecoveryPage`: Write controls, Snapshots, Pairing witnesses,
  Ambiguous creates, Deleted counterparts, Targeted repair and Data transfer.
- `dashboard/SettingsPage` (About & Security): preserved security, architecture, capabilities,
  roadmap and contact information.
- `dashboard/AdminDialogs`: existing organization and import confirmations.
- Extracted workflow components: `ConfigurationPanel`, `MappingsPanel`,
  `SyncOperations`, `IssueExportImportSection`, `OrgModal`, `ImportSettingsModal`
  and `IssueImportModal`.
- Existing specialized setup, diagnostics and recovery components remain in use.
- `dashboard/presentation`, `dashboard/metrics`, `dashboard/navigation` and
  `dashboard/dashboard.css`: shared presentation, honest metric handling,
  navigation definitions and responsive rules.
- `index.jsx`: production entry; importing `App` no longer mounts a second root.

## Full parity checklist

All entries below are implemented locally. Existing backend behavior is reused;
local verification does not certify live Jira or Forge operation.

| Inventory function | Location and preserved boundary | Status |
| --- | --- | --- |
| Explicit organization choice and persistence | Shared selector; validated stored ID; no list-order fallback; unavailable browser storage tolerated | Preserved |
| Loading, forbidden, failure, empty and unselected states | Shell and Organizations; failed loads are unavailable, not empty installations | Preserved |
| Add organization | Header; original required connection inputs; empty allowed-project scope; opens setup for explicitly created organization | Preserved |
| Edit organization and token replacement | Organizations; optional password replacement; existing tokens never redisplayed; original separate calls and ordering | Preserved |
| Organization deletion | Organizations; named confirmation, configuration-loss warning and mapping/history retention; clears selection | Preserved |
| Connection test | Organizations; explicit action, loading, success and refusal feedback | Preserved |
| Connection and inbound setup details | Organizations / Connection; configured indicators and direction-specific fields | Preserved |
| Signing-secret rotation | Connection and Guided Setup; original confirmations, invalidation warnings, one-time handoff and dismissal | Preserved |
| Allowed source projects | Scope & direction; lazy project loading, explicit selection/save, meaningful empty scope | Preserved |
| JQL and direction | Existing edit dialog and setup steps; partial project saves do not overwrite JQL | Preserved |
| Sync options | Sync options; comments, links, description cross-reference and separate recreation controls | Preserved |
| Attachment controls | Sync options; default off, independent deletion propagation, positive MB validation and blank Jira-limit behavior | Preserved |
| Settings JSON export/import | Configuration transfer; original sections/defaults, overwrite warning and explicit confirmation | Preserved |
| Legacy global schedule import | Configuration transfer; global label and unchecked default | Preserved |
| Mapping reference data | Mappings; local allowed-project context, explicit load/reload and original local/remote reads | Preserved |
| User mappings | Mappings; original getter/save payload, fallback configuration, add/delete drafts and explicit save | Preserved |
| Field mappings and rejected-field warnings | Mappings; original identifiers and warning marks; no new clear-rejection action | Preserved |
| Status and issue-type mappings | Mappings; original getters/saves, add/delete, names/IDs and string/object compatibility | Preserved |
| Auto-match | Mappings; existing non-overwriting merge and explicit save behavior | Preserved |
| Project mappings | Mappings; uppercase inputs, add/delete/save and default destination explanation | Preserved |
| Nine-step Guided Setup | Guided Setup; connection, scope, direction, mappings, features, webhook, preflight, initial sync and review | Preserved |
| Setup persistence and validation | Guided Setup; load/start/save/complete/validate-existing actions remain available | Preserved |
| Read-only preflight approval | Guided Setup; existing explicit approval; no claim of end-to-end synchronization | Preserved |
| Backfill deferral and setup approval | Guided Setup; original acknowledgements, step locking, revalidation and final approval | Preserved |
| Initial preview and start | Synchronization; exact preview approval and both checksums; zero-work behavior and blocked/conflicting classifications | Preserved |
| Initial job progress and controls | Synchronization; original status/polling, pause/resume/cancel states and completed-write caveat | Preserved |
| Recurring reconciliation settings | Synchronization; opt-in, supported intervals, thresholds, separate review-comment option and editable-only payload | Preserved |
| Recurring progress and attention | Synchronization; original status/polling, Resolve health check versus Acknowledge notification semantics | Preserved |
| Legacy scheduler fallback | Synchronization; existing status read and mutual-exclusion explanations; no manual trigger restored | Preserved |
| Emergency pause/resume | Recovery / Write controls; installation-wide, original dialogs, fixed reason and no-replay explanation | Preserved |
| Sync Authorization | Recovery / Write controls; installation coverage, exact server phrase and blocked/authorized states | Preserved |
| Webhook metrics | Overview and Analytics; installation totals and supported organization breakdowns; attempts distinct from successful writes | Preserved |
| Retained webhook errors and clearing | Activity; safe details, timestamps and scope; clearing remains explicitly installation-wide | Preserved |
| API statistics and recorded history | Analytics; real counters, endpoint/org breakdowns and timestamped buckets; no estimated quota presented as actual capacity | Preserved |
| Scheduled statistics | Analytics and Activity; existing counters, timestamps, retained events and errors | Preserved |
| Manual sync | Recovery / Targeted repair; selected organization, trimmed key, Enter submission and original confirmation difference | Preserved |
| Pending-link retry | Targeted repair; all-organizations label and original call/feedback | Preserved |
| Issue export | Data transfer; Easy Select/custom JQL, eight quick filters, project/status/assignee/day inputs, 250 limit and original include options | Preserved |
| Issue import | Data transfer; unique-key parsing, source-refresh/snapshot paths, skip-existing, target summary, warnings and result counts | Preserved |
| Disabled force recreation on import | Data transfer; no mapping deletion or replacement creation introduced | Preserved |
| Recovery snapshot export | Snapshots; confirmed pause required, server download bytes, identity/counts/coverage and partial-backup caveat | Preserved |
| Restore comparison | Snapshots; pause and 3 MB budget, identity/routing/checksum and pair/ledger classifications; no apply endpoint | Preserved |
| Pair-witness read-only preview | Pairing witnesses; original classifications, samples and projected operation counts | Preserved |
| Witness migration lifecycle | Pairing witnesses; selected pairs by default, explicit whole-organization mode, exact phrase, permit/expiry/batches/cancel | Preserved |
| Maintenance write audit | Activity, linked from Pairing witnesses; existing filtered safe projection, refresh, empty/error/unavailable states | Preserved |
| Ambiguous create recovery | Ambiguous creates; org/direction/source lookup, explicit target, verification checkbox and mapping-only confirmation | Preserved |
| Deleted counterpart recovery | Deleted counterparts; probe/remap/replace/end/dismiss, original status eligibility and confirmations | Preserved |
| Health and issue diagnostics | Diagnostics; existing health/mapping/verification reads and confirmed force-sync action | Preserved |
| Security and information | About & Security; original security/architecture, capabilities, roadmap and contact content | Preserved |
| Readiness/fresh-initialization bridge handles | Existing authenticated browser boundary retained; initialization still requires explicit confirmation; no automatic invocation | Preserved |
| Dormant scan/bulk handlers | Retained in controller; no rendered entry point or backend-only action added | Preserved |
| Feedback and error containment | Existing durations/persistent dismissal and ErrorBoundary retained; specialized feedback contract corrected | Preserved |

No currently available workflow was intentionally removed. Unsupported Forge
consumption/costs, actual remaining Jira quota, latency history, full outcome
trends and unbounded operation history remain unavailable; no instrumentation or
fake vendor access was introduced. Date controls filter only actual retained
hour/error timestamps. Cumulative counters have scope controls only.

## Safety and narrowly scoped frontend corrections

Organization changes replace the entire session, including open dialogs,
configuration drafts, issue keys, selected witness pairs, preview files/results,
verification checkboxes and typed approval phrases. Late responses update only
the discarded session. A two-stage token save does not continue into its second
mutation after session invalidation. No extra browser persistence was added.

`setupWizard` uses an ADMIN_WRITE policy even for `action: load`, and the existing
backend wrapper audits that invocation. Loading saved setup progress is therefore
an explicit **Load Guided Setup** action. Mounting or navigating to the page calls
no setup resolver. Subsequent setup validation and all approvals retain their
original semantics. The backend audit policy was not changed.

Regressions reproduced reversed message/severity arguments in witness/audit
feedback, and an audit reload caused by a changing notification callback. The
shared callback is now stable and the affected callers use the existing
message-first contract. Failure fixtures proved the old behavior before fixes.

A failed statistics refresh now invalidates failed sources independently instead
of preserving old values as current. Unknown write state does not render pause or
resume controls. Failed organization-list reads are not shown as empty successful
configuration, and diagnostics requires a successfully resolved organization.

Narrow render checks found and corrected fixed-width diagnostic actions,
connection detail columns, organization action rows and the create-recovery
direction input. Collapsible configuration/transfer headers also support keyboard
activation. Diagnostic comparison wording describes only the checked fields.

## Verification

- Full Jest: **94 suites passed; 2,025 tests passed**.
- New dashboard integration regressions cover all navigation without writes,
  explicit setup loading, no selection, stale async data, approval/dialog/draft
  invalidation, current-organization repair payloads, missing statistics, honest
  rates/history, forbidden organization loading and stable failure feedback.
- Existing source assertions now follow extracted production files; confirmation,
  policy, preview, permit, scope and disabled-action assertions remain intact.
- Required gates: root lint, secret scan, neutrality, offline Forge validation,
  admin production build and diff whitespace check.
- Supplementary frontend syntax/undefined-reference validation covers JS and JSX.
- No manifest, backend source, root dependency or deployment file changed.
- Original literal App resolver inventory has no missing call names after extraction.
- Both pre-existing duplicate files retain their original SHA-1 checksums:
  `54bb23fe7d2d1f5228a2bb9a1eedd18884636f7a` and
  `8e6c68800e3066670002495544312c66fed31bd8`.
- Recovery backup directories were not modified or used for build outputs.

The actual React components and stylesheet were built and rendered in an isolated
local preview using illustrative fixture responses and a bridge that rejects
mutation actions. Screenshots and the render report are local generated artifacts
under `artifacts/admin-redesign/`. They are not live Jira data and are not evidence
of Forge iframe integration or backend operation. No fixture bridge is included
in the production source/build. Desktop, 768 px, 390 px and 320 px checks cover
primary pages, secondary sections and organization dialogs. The final render pass
completed 86 checks with no runtime errors or document-level horizontal overflow.
Dense tables retain horizontal scrolling within their own containers.

## Platform contract and remaining limits

The existing string resolver names and payload-based promise contract are retained
as documented by [Forge bridge invoke](https://developer.atlassian.com/platform/forge/apis-reference/ui-api-bridge/invoke/).
The page remains the existing [Custom UI resource](https://developer.atlassian.com/platform/forge/extend-ui-with-custom-options/),
with no new module or manifest configuration. Recorded request counts do not
establish remaining capacity under [Jira rate limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/).

No live visual deployment, Jira permission verification, recovery operation or
synchronization test was performed. Authenticated Forge lint and deployment remain
separate release steps. Build warnings about browser-data freshness and bundle
size are recorded; dependencies were not upgraded as part of this redesign.

## Check results and dependency findings

| Check | Result |
| --- | --- |
| Full Jest | 94 suites / 2,025 tests passed |
| Root ESLint | Passed |
| Supplemental frontend JS/JSX syntax and undefined references | Passed; base unused-variable rule omitted because it does not recognize JSX references |
| Secrets / repository hygiene | Passed |
| Neutrality | Passed |
| Diff whitespace | Passed |
| Offline Forge validation | Passed, zero warnings; initial sandbox schema fetch failed, unrestricted retry succeeded |
| Admin production build | Passed; approximately 1.05 MB JS and 54 KB CSS |
| Root production dependency audit | Failed: existing high `undici` and moderate `fast-uri` advisories |
| UI production dependency audit at high threshold | Passed; existing moderate `yaml` advisory remains |
| Actual component rendering | 86 checks, no runtime errors or document overflow; illustrative fixtures only |

Dependency manifests and lockfiles are unchanged, so these advisories were not
introduced by the redesign. Dependency remediation requires a separately scoped
update and validation; no automatic audit fix was run. Browser-data freshness and
JS bundle-size warnings remain informational build output.

## Files changed

```text
docs/ADMIN_DASHBOARD_REDESIGN.md
static/admin-page/src/App.jsx
static/admin-page/src/components/ConfigurationPanel.jsx
static/admin-page/src/components/DeletedCounterpartRecovery.jsx
static/admin-page/src/components/Diagnostics.jsx
static/admin-page/src/components/GuidedSetupWizard.jsx
static/admin-page/src/components/ImportSettingsModal.jsx
static/admin-page/src/components/InitialSyncPanel.jsx
static/admin-page/src/components/IssueCreateRecovery.jsx
static/admin-page/src/components/IssueExportImportSection.jsx
static/admin-page/src/components/IssueImportModal.jsx
static/admin-page/src/components/MappingsPanel.jsx
static/admin-page/src/components/OrgModal.jsx
static/admin-page/src/components/PairWitnessMigration.jsx
static/admin-page/src/components/RecoverySnapshot.jsx
static/admin-page/src/components/RecurringReconciliation.jsx
static/admin-page/src/components/SyncAuthorization.jsx
static/admin-page/src/components/SyncOperations.jsx
static/admin-page/src/components/WitnessAuditLog.jsx
static/admin-page/src/dashboard/ActivityPage.jsx
static/admin-page/src/dashboard/AdminDialogs.jsx
static/admin-page/src/dashboard/DashboardShell.jsx
static/admin-page/src/dashboard/DataViews.jsx
static/admin-page/src/dashboard/OrganizationSynchronization.jsx
static/admin-page/src/dashboard/OrganizationsPage.jsx
static/admin-page/src/dashboard/RecoveryPage.jsx
static/admin-page/src/dashboard/SettingsPage.jsx
static/admin-page/src/dashboard/dashboard.css
static/admin-page/src/dashboard/metrics.js
static/admin-page/src/dashboard/navigation.js
static/admin-page/src/dashboard/presentation.js
static/admin-page/src/dashboard/version.js
static/admin-page/src/hooks/useAdminController.js
static/admin-page/src/index.html
static/admin-page/src/index.jsx
tests/admin-org-selection.test.js
tests/batch3-frontend-scope.test.js
tests/batch7-pilot-controls-ui.test.js
tests/batch8-pilot-blockers.test.js
tests/counterpart-recovery.test.js
tests/dashboard-redesign.test.js
tests/guided-setup-ui.test.js
tests/issue-create-recovery-ui.test.js
tests/pair-witness-ui.test.js
tests/recovery-snapshot-ui.test.js
tests/recurring-reconciliation-ui.test.js
tests/sync-authorization-ui.test.js
tests/v2-1-rc2-final-corrections.test.js
tests/v2-1-rc3-runtime.test.js
tests/witness-audit-log.test.js
```

## Final visual polish and correctness pass

The approved seven-page layout is retained. The acceptance criteria for this pass
are a first-row Overview KPI strip using existing recorded counters, denser summary
panels, prominent known pause/error states, readable recorded-hour charts, qualified
platform wording, explicitly sourced version labels and preservation of every row
in the feature-parity checklist above. No backend or telemetry changes are needed.

### Visual refinements

- Overview places attempts, created issues, updated issues and synchronized comments
  immediately below the heading. The existing organization-versus-installation
  scope label and missing-data behavior are retained. Counters are not health scores.
- Organization and installation-safety panels use tighter spacing and align to their
  content rather than stretching into equally tall empty cards. The known pause
  state is repeated visibly in the safety panel, while independent authorization,
  setup/job approvals and maintenance-permit distinctions remain explicit.
- Retained errors receive a restrained red edge and title. A confirmed emergency
  pause gives the shared installation strip an amber background on all pages.
  An inactive pause is still not presented as evidence of authorization or health.
- The existing API hourly chart includes UTC dates, hour labels, a peak-call scale,
  legend and mouse/keyboard details. Bar height represents recorded calls; amber
  marks an hour containing recorded rate-limit hits. Zero-call buckets have a baseline
  marker. Missing hours remain unknown. The source table remains available.
- Shared typography, summary-list alignment, compact table scrolling, visible focus
  treatment and responsive navigation are retained across all seven pages.

### Security and compliance wording

The architecture diagram remains, with a logical-service label and accessible
title/description. Its outline is explicitly not a private-network, residency or
compliance boundary. The former zero-egress, network-confinement, inherited-compliance
and never-exposed-secret claims were removed. The replacement explains:

- The app uses Forge functions/storage and contacts configured Jira sites. The local
  manifest allows backend requests to `*.atlassian.net`; authorized downloads also
  transfer files to the administrator's browser. No manifest change was made.
- Platform operation and encryption at rest do not remove app/administrator
  responsibility for authorization, dependencies, data handling and configuration.
- API tokens use the Forge secret store. Stored API tokens are not redisplayed,
  while credential entry and explicit administrator-only one-time signing-secret
  handoffs occur in the browser. Existing secret workflows are unchanged.
- Residency depends on storage capability, installation location and platform
  policies. Remote Jira data and downloaded files require separate consideration.
- The backend has no separately configured app-hosted service in this source
  configuration; that is an architectural description, not an absolute security
  guarantee for every deployment or dependency.

References checked for this wording: [Forge shared responsibility](https://developer.atlassian.com/platform/forge/shared-responsibility-model/),
[egress permissions](https://developer.atlassian.com/platform/forge/runtime-egress-permissions/),
[security](https://developer.atlassian.com/platform/forge/security/) and
[data residency](https://developer.atlassian.com/platform/forge/data-residency/).
Capability wording also removes the obsolete fixed 10 MB attachment claim and
clarifies that recurring source reconciliation is opt-in, rather than a backup.
Capabilities, roadmap, contact details and official documentation links remain.

### Version provenance

The root `package.json` and root lockfile identify the application as `2.2.0` for the v2.2.0 release.
The prior header duplicated that value as `ADMIN_UI_VERSION = 'v2.1.0'`. The UI
package's `1.0.0` identifies its build package and is not displayed as the product
version. `dashboard/version.js` now derives the application label from the root
package; the existing exported `ADMIN_UI_VERSION` remains compatible with tests.
The header explicitly says **Application v2.2.0** and About & Security repeats that value in the release build. The previously deployed STAGING 3.23.0 bundle was built from application version 2.1.0; publishing this release does not deploy the new version.

The user-reported staging identifier `3.22.0` is not present in the local source or
saved deployment evidence examined. Its exact deployment provenance and current
installed value were not independently verified under the local-only boundary.
It was not copied into the product label. [Forge deployment versions](https://developer.atlassian.com/platform/forge/versions/)
are maintained separately per environment. About & Security therefore labels the deployment
version as **Not reported by this UI**; no backend lookup or new resolver was added.

### Verification and files for this pass

Four regression tests were added and first observed failing against the pre-polish
interface: KPI ordering/scope/missing data, accessible hourly labels/details, qualified
Settings wording with preserved diagram/support, and package-derived version labels.
All existing safety tests remain. The full suite passes **94 suites / 2,025 tests**.
Root lint, supplementary frontend JS/JSX syntax checks, secrets, neutrality, offline
Forge validation and the admin production build pass. Browser-data freshness and
bundle-size warnings remain informational; no dependencies were upgraded.

The previous dependency audit findings remain unchanged and separately scoped:
root high `undici`, moderate `fast-uri`, and UI moderate `yaml`. This polish pass
does not resolve those advisories or certify a production release.

The actual components are rendered in the isolated fixture-only preview, with all
write actions rejected and no Jira/Forge connection. Updated screenshots and the
render report are in `artifacts/admin-polish/`. The final pass completed 86
browser checks with no runtime errors or document overflow; the keyboard chart
tooltip was visibly verified. All seven pages were checked at desktop, tablet and
narrow widths, with additional organization/recovery section and dialog checks. The root package version is copied
into the isolated preview at an adjusted local import path; production imports the
actual root package. Fixture responses never enter the production bundle.

Files modified in this focused pass:

```text
static/admin-page/src/App.jsx
static/admin-page/src/dashboard/DashboardShell.jsx
static/admin-page/src/dashboard/DataViews.jsx
static/admin-page/src/dashboard/SettingsPage.jsx
static/admin-page/src/dashboard/dashboard.css
static/admin-page/src/dashboard/version.js (new)
tests/dashboard-redesign.test.js
docs/ADMIN_DASHBOARD_REDESIGN.md
```

The original feature-parity checklist was rechecked: no workflow, confirmation,
resolver contract, disabled state or scope-isolation behavior was changed by this
pass. Navigation tests still restrict mounted calls to existing read-policy
resolvers. Stored approvals, form drafts and previews still belong to keyed
organization sessions. Both original duplicate-file checksums are unchanged; no
backup directory was modified. No commit, push, deployment, live mutation, recovery
operation or authorization action was performed. Stop at local visual review.

## Informational navigation correction

The top-level label and page heading are now **About & Security**. The underlying
`settings` navigation identifier and `SettingsPage` component name are retained
as internal implementation identifiers to avoid unrelated churn. All informational
content, the architecture diagram and links are unchanged. Editable organization
configuration remains under Organizations, and installation-wide safety and
operational controls remain under Recovery. No preferences, placeholder settings
or backend functionality was introduced.

Desktop navigation can wrap at intermediate iframe widths; the existing narrow
Page selector displays the longer label. Navigation regressions cover both labels,
the page heading, informational-only content and the unchanged locations of real
settings and write controls. Verification results for this correction follow.

Navigation-correction results: focused UI tests passed (3 suites / 46 tests);
full Jest passed (94 suites / 2,025 tests). Root lint, secrets, neutrality, offline
Forge validation (zero warnings), admin production build and diff whitespace
checks passed. The actual fixture-rendered interface was checked at 1440, 900,
768, 700, 640, 621, 620, 390 and 320 px: the label and heading match, the narrow
selector is correct, and there are no browser runtime errors or document overflow.
Screenshots and results are under `artifacts/admin-navigation/`.

Files changed for this correction: `static/admin-page/src/dashboard/navigation.js`,
`static/admin-page/src/App.jsx`, `static/admin-page/src/dashboard/dashboard.css`,
`tests/dashboard-redesign.test.js`, `tests/v2-1-rc3-runtime.test.js`,
`tests/guided-setup-ui.test.js` and this document. No informational page content,
links, resolver, backend, dependency, manifest or safety workflow was changed.
No commit, push, deployment or live mutation was performed.

## SyncApp v2.2.0 branding correction

The customer-facing product name is SyncApp. The Forge admin-page module title,
Jira sidebar and page heading, embedded header, document title, About & Security,
and current release documentation use that name. The application version remains
2.2.0, derived from the root package. Forge deployment versions remain separate.

New generated review comments and protected-counterpart notices use SyncApp.
Legacy text markers remain recognized for existing Jira content, including
comment-copy exclusion and preservation of user descriptions. No stored content
is rewritten. The Forge app ID, module key, installation identities, storage and
resolver identifiers, repository names and authorization phrases stay unchanged.

Acceptance requires full regression and quality checks, inspection of the built
bundle, and independent live STAGING and DEV verification of both Jira chrome
and all seven dashboard pages. The published v2.2.0 tag currently targets
146aa50046438297fba3fe2b5edfeefd25a7a551; moving it requires explicit release
approval. A build or deployment alone does not establish live acceptance.

The title property supplies both the Jira administration heading and sidebar
entry: [Jira admin page](https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-admin-page/).
The only manifest change is that display title; scopes, external permissions,
storage schema, module keys and app identity are unchanged. Under
[Forge versioning](https://developer.atlassian.com/platform/forge/versions/),
changes that do not require a major version apply as minor updates. A required
installation upgrade or permission change remains a separate approval gate.

Branding validation: 95 Jest suites / 2,028 tests pass, including three focused
branding and legacy-marker compatibility regressions. ESLint, secret scanning,
neutrality, offline Forge validation, authenticated STAGING and DEV Forge lint,
and the admin production build pass. The built HTML and JavaScript are checked
for SyncApp, the root application version, and absence of retired UI branding.
Existing dependency advisories remain unchanged. Live rollout and release-tag
approval are recorded separately from these local results.
