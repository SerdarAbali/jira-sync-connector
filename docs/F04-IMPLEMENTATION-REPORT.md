# F04 implementation and verification report

Date: 24 October 2026 (Europe/Helsinki).
Repository: SerdarAbali/jira-sync-connector.
Worktree: `/Users/serdar/Documents/Projects/jira-sync-project/f04-signed-webhooks`.
Branch: `fix/f04-signed-webhooks`.
HEAD/base: `5c9fccb00d3f055d5e40f91eb42434c98625993e`.
All implementation changes are uncommitted and unstaged for independent DeepSeek review.

## Root cause and exact change

Authentication previously depended on a bearer credential embedded in each
callback path. Constant-time comparison and org selection already hardened that
mechanism, but URL credentials remain liable to exposure wherever URLs are
recorded. This change replaces external bearer authentication with documented
Jira administrative-webhook HMAC verification, retaining the Forge endpoint and
existing synchronization processing.

The credential-free route is `/signed/<orgId>`. SHA-256 over the exact UTF-8
body string is checked before JSON parsing, using Node `timingSafeEqual` on
32-byte digests. Complete syntax/length validation prevents malformed hex,
algorithm substitution, duplicate/multiple/coalesced headers and trailing-newline
acceptance. Missing/wrong keys, unknown orgs and auth-storage failures yield the
same generic 401 response. No failed signature can fall back to bearer auth.
POST/content-type/body-size/recognized-event checks, direction checks and global
Pause remain enforced. Object-body substitutions fail at the HTTP boundary.

Signing keys use a separate Forge secret key:
`secret:<orgId>:webhookSigningSecret`. Stored or imported legacy credentials and
old callback URLs never provision signing keys or authorize deliveries. Imports
can retain legacy secrets for separately approved rollback planning only.

## Contract and uncertainty

See [the verified contract and full operator runbook](F04-SIGNED-WEBHOOKS.md).
Official sources were read before editing:

- https://developer.atlassian.com/cloud/jira/platform/webhooks/#secure-admin-webhooks
- https://developer.atlassian.com/platform/forge/runtime-reference/web-trigger/
- https://developer.atlassian.com/platform/forge/storage-reference/kvs-api-secret/

The implementation accepts only the documented SHA-256 example algorithm and
`sha256=<64 hex characters>`. Atlassian explicitly allows future algorithm
changes, which this build will reject until reviewed. Forge documents a string
body and array-valued headers, without an arbitrary byte-preservation or
upstream duplicate-header normalization guarantee. Real Jira-to-Forge delivery
must be checked in staging. The official HMAC vector passes locally.

## Regression-first evidence

Before implementation, the new F04 suite ran with **7 failures and 11 passes
(18 tests)**: valid signed bodies, string-only body enforcement, auth-storage
failure handling and the new signing-key/URL lifecycle exposed the expected
baseline gaps. After implementation all 18 passed. The expanded final F04
suite contains **39 passing tests**, using production HTTP handlers and mocked
Forge/Jira boundaries, rather than only an HMAC helper.

Existing safety tests now generate real HMAC signatures in a test helper and
exercise production synchronization processing. One obsolete direct-service
worklog fixture was changed to an allowlisted issue-deletion event; unsupported
HTTP events remain rejected. No safety assertion was removed to bypass a
production failure.

## Recovery and safety preservation

`recoverIncomingComment` is a server-only function, not a webtrigger or resolver.
The heartbeat validates persisted org/direction/issue/comment/parent identifiers
and dispatches into the shared private processing function. Ancestry constraints
continue to flow through recovery. The successful two-direction production
heartbeat regression explicitly removes access to both webhook credential
namespaces and asserts neither is read. It still completes both comments once.
Internal recovery cannot create an external receipt.

F02 ancestry confidentiality, F03 current scope checks, F05 retry/Pause policy,
F06 comment submission fences, F07 ownership and migration checks, and F08 manual
routing pass their existing suites. The F07 migration gate code and manifest are
unchanged; no activation record is written.

## Secret lifecycle and setup

ADMIN_WRITE authorization remains attached to `rotateWebhookSecret` through the
existing production authorization wrapper. Generation uses 32 cryptographically
random bytes per call. Keys live only in Forge secrets and are returned once to
the requesting administrator; normal reads, exports, audits and failures omit
them. No silent generation occurs on organization creation or direction change.

The existing UI components display the secret separately from the retrievable
callback URL, clear local secret state on org change/dismiss, and explain the
coordinated save. Rotation replaces the single accepted key immediately, clears
old signed receipt proof first, and records safe metadata best effort. A proof
reset failure aborts before replacement. URL lookup failure still leaves the
one-time secret visible. Lost responses require another controlled rotation.
Legacy bearer receipts use an older namespace and cannot validate signed setup.

No previous-key window exists. KVS rotation remains last-write-wins; operators
must serialize rotation and verify a genuine delivery after saving Jira settings.

## Cutover and rollback

The [runbook](F04-SIGNED-WEBHOOKS.md) covers configuration backup and checks,
secret preparation while live registration remains untouched, the planned
interruption caused by installing signed-only code, saving the existing Jira URL
and Secret together, genuine delivery verification, mismatch handling, missed
work inventory, and supported authorized recovery only.

Preferred rollback is registration repair or a reviewed signed-capable artifact
that preserves HMAC enforcement. Returning to the old bearer-URL build reduces
security and requires separate emergency approval. Paused/missed inbound events
are not automatically replayed. Existing source reconciliation is outbound;
unsupported missing inbound work requires a separate recovery decision.

No deployment, cutover, live credential rotation, Jira/Forge mutation, commit,
push, merge or release was performed.

## Verification

| Command | Actual result |
| --- | --- |
| `npm test -- --runInBand tests/f04-signed-webhooks.test.js` | 1 suite, 39 tests passed |
| Targeted 9-suite command below | 9 suites, 367 tests passed |
| `npm test -- --runInBand 'tests/f0[2-8].*test.js'` | 9 suites, 384 tests passed |
| `npm test -- --runInBand tests/f02-comment-confidentiality.test.js` after strengthening credential-free heartbeat assertion | 1 suite, 170 tests passed |
| `npm test -- --runInBand` | 56 suites, 907 tests passed |
| `npm run lint` | Passed; ESLint over `src/` |
| `npm run check:secrets` | Passed, including untracked non-ignored files |
| `npm run check:forge:offline` | Passed; 0 warnings |
| `npm run build --prefix static/admin-page` | Passed; Parcel and cache bust completed |
| `git diff --check` | Passed |

Exact targeted command:

```sh
npm test -- --runInBand tests/f04-signed-webhooks.test.js tests/batch3-credentials-webhook.test.js tests/batch2-authorization.test.js tests/f02-comment-confidentiality.test.js tests/f03-inbound-scope.test.js tests/f05-write-recovery.test.js tests/batch4-sync-path.test.js tests/batch7-pilot-pause.test.js tests/batch9-comment-safety.test.js
```

The first UI build was blocked by sandboxed native LMDB access. The permitted
local retry succeeded. Parcel reported existing stale Browserslist/baseline data
warnings; no dependencies or lockfiles were changed. Offline Forge validation
initially lacked the UI build resource; it passed after building. Installed
baseline dependencies were reused through temporary links, removed after final
verification. Use the existing lockfiles to install dependencies when rerunning
checks in this worktree. Build artifacts remain ignored.

The scanner now enumerates tracked plus untracked non-ignored files; matches are
reported only by category/path. Test secrets are synthetic. No confidential
request content, signatures or signing keys are introduced into logs/exports.

## Remaining staging/Forge checks

- Genuine manually registered Jira System Webhook with Secret, especially
  Unicode/whitespace/escaped JSON through Forge's serialized string boundary.
- Upstream duplicate-header handling and delivered header casing/array shape.
- Admin UI generation/rotation and one-time display with actual Forge storage,
  signed receipt, failed configuration and signed-capable rollback rehearsal.
- Authenticated `npm run check:forge` is a release gate not executed here.
- Deployment, cutover and F07 migration activation remain outside this task.

## Files changed

- `README.md`
- `docs/CONFIGURATION.md`
- `docs/F04-IMPLEMENTATION-REPORT.md`
- `docs/F04-SIGNED-WEBHOOKS.md`
- `docs/INSTALLATION.md`
- `docs/OPERATIONS.md`
- `docs/SECURITY.md`
- `scripts/check-secrets.js`
- `src/resolvers/config.js`
- `src/services/setup/setup-wizard.js`
- `src/services/storage/webhook-receipt.js`
- `src/services/sync/incoming-sync.js`
- `src/triggers/initial-sync-recovery.js`
- `src/webtriggers/incoming-webhook.js`
- `static/admin-page/src/App.jsx`
- `static/admin-page/src/components/GuidedSetupWizard.jsx`
- `tests/batch3-credentials-webhook.test.js`
- `tests/batch3-frontend-scope.test.js`
- `tests/batch4-mappings-webhooks.test.js`
- `tests/batch4-sync-path.test.js`
- `tests/batch7-pilot-pause.test.js`
- `tests/batch8-pilot-blockers.test.js`
- `tests/batch9-comment-safety.test.js`
- `tests/f02-comment-confidentiality.test.js`
- `tests/f03-inbound-scope.test.js`
- `tests/f04-signed-webhooks.test.js`
- `tests/guided-setup-ui.test.js`
- `tests/guided-setup-wizard.test.js`
- `tests/helpers/signed-webhook.js`
- `tests/inbound-link-deletion-hotfix.test.js`
- `tests/pilot-deletion-safety.test.js`

## Final Git status

HEAD remains the exact requested baseline on `fix/f04-signed-webhooks`; no commit
was created. All listed changes are unstaged. The two new documentation files
and two new test/helper files are untracked. Temporary dependency links were
removed. There are no staged changes. Original `SyncApp` retains its 94 untracked
duplicate entries and has zero tracked changes. Existing branches/tags and
F02/F03/F05/F06/F07/F08 commits were not changed.
