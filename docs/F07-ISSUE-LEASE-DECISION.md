# F07 — Issue lease ownership and stale-worker safety

Implemented locally on `fix/f07-issue-lease`, based on exact F05 commit
`acee192e260d880b4c466c811375e2524d6ab1a5`, after approval of Custom Entity
conditional transactions. Worktree: `/Users/serdar/Documents/Projects/jira-sync-project/f07-issue-lease`.
Changes remain uncommitted for independent Cline review. No deployment, storage
migration, activation, live Jira request, commit, push, merge, release or tag was performed.

## Red-to-green evidence

Before implementation, the two F07 regression tests failed against F05:

- Delaying A's release read while TTL cleanup removes A and B acquires causes
  A's delete to remove B. Expected successor token; received `undefined`.
- Suspending the actual outbound update after acquisition, advancing to 121
  seconds, allowing cleanup and B's acquisition, then resuming A produces one
  PUT where zero is required. A 121-second worker is possible inside the
  manifest's 900-second scheduled/consumer handlers.

Original targeted result: **45 passed, 2 failed**. Both regression names and
scenarios are retained. Their storage seams now exercise the entity protocol:
release is delayed before its conditional commit, and expiry takeover leaves
A's entity physically present instead of simulating TTL removal. Both pass.

The new suite also covers concurrent creation/takeover, renewal, delayed renewal,
release versus renewal, stale tokens, failed-release crash recovery, delayed
ownership responses, retries, inherited/closed scopes, inbound expiry takeover,
and nested local description/comment, remote link/attachment/transition writes.
Positive nested-client tests verify that valid leases actually reach transport.

## Implementation

- `issue-lease.js`: unique 256-bit random tokens; conditional initial creation
  (`leaseToken` absent), takeover (observed token and expiry unchanged and expired),
  renewal (owned, unexpired, observed expiry unchanged), and release (token
  matches). No basic KVS release or renewal and no unsafe compatibility fallback.
- Expiry is a numeric application deadline. Native TTL is not used. Expired
  entities can be replaced atomically even if cleanup never removes them.
  Release failures retain the entity until application-level takeover.
- Keep the existing organization/issue-pair scope and direction contention;
  SHA-256 encodes that scope into an entity-safe, fixed-length key.
- `issue-lease-context.js`: async-local ownership scopes wrap outbound and inbound
  create/update bodies. Recursive child operations inherit all parent leases;
  completion closes the scope for any descendant async work. No renewal timer
  or detached background task is introduced.
- `guarded-api.js`: existing mutation callers use a submission facade over the
  unchanged Forge transports. It checks migration readiness, authoritative pause,
  and all inherited lease tokens/expiry immediately before each mutating call.
  That includes retries and nested helpers without bypassing F02 comment checks,
  F03 scope checks or F05 pause/retry budgets. GET/HEAD and the exact read-only
  POST `/rest/api/3/search/jql` endpoint stay available during migration.
- An owned lease with under 60 seconds remaining is conditionally renewed before
  submission. Expired workers cannot renew. Delayed ownership/renewal responses
  are checked against local deadlines; a renewal response arriving after its
  original deadline invalidates that worker even if storage committed it.
- Standalone comment/link/attachment handlers retain their existing protections;
  when called inside an issue lifecycle they inherit its ownership. The facade
  does not invent issue ownership for unrelated standalone events.
- Lease/migration failures are nonretryable. Single-write and idempotent-write
  helpers preserve those safety errors. Existing create-operation, attachment,
  comment-recovery and ambiguous-outcome ledgers are retained.

## Verified platform contract

The installed `@forge/kvs` is **2.0.6** (lockfile unchanged). Its declarations and
request builders support `transact().set(key, value, { entityName, conditions })`,
`delete(key, { entityName, conditions })`, and `check(key, { entityName, conditions })`.
Tests use these actual SDK builders and serialization through a local
`__forge_fetch__` model that atomically evaluates conditions before applying
transactions. They do not mock the production lease helper or fabricate an SDK
conditional-delete method. Existing suites explicitly model an activated
installation; migration tests remove/corrupt that fixture.

Official references checked:

- [Custom Entity transactions](https://developer.atlassian.com/platform/forge/storage-reference/entities-transactions/)
  document atomic conditional set/delete/check. [Entity filters](https://developer.atlassian.com/platform/forge/storage-reference/entities-api-query/)
  include `notExists`, equality and ordered comparisons for the declared types.
- [Entity definitions](https://developer.atlassian.com/platform/forge/storage-reference/entities-manifest/)
  define `app.storage.entities`. The manifest adds `issue-lease` with string
  `leaseToken` and float `expiresAt`; [entity value limits](https://developer.atlassian.com/platform/forge/storage-reference/entities-api/)
  make integer unsuitable for epoch milliseconds (signed 32-bit). The existing
  `storage:app` scope suffices. No custom index is needed for keyed transactions.
- [Basic KVS semantics](https://developer.atlassian.com/platform/forge/storage-reference/kvs-api/)
  document asynchronous TTL deletion, potentially up to 48 hours, and ordinary
  last-write-wins deletion without an ownership predicate.
- [Invocation limits](https://developer.atlassian.com/platform/forge/limits-invocation/)
  permit 900-second eligible handlers and 180-second outbound requests in
  long-running functions. [Native Node runtime](https://developer.atlassian.com/platform/forge/function-reference/nodejs-runtime/)
  supports built-in Node modules, including the async context mechanism used here.

## Migration runbook — separate approval required; not executed

The separate [disposable-staging initializer](F07-FRESH-INITIALIZATION.md) is
restricted to one installation by explicit engineering policy. It does not
change the version-1 migration or retirement/drain requirements below.

This is an offline implementation and plan. The activation gate is intentionally
**closed by default**. Deploying this candidate alone does not activate leases
or permit Jira mutations. There is no automatic migration or activation writer.

A marker cannot teach old code to respect entity leases. Do not run old and new
lease mechanisms concurrently or treat a deployment timestamp/empty lease query
as proof that legacy workers stopped. In particular, native Node can resume
unawaited work later; elapsed wall time alone is insufficient evidence of retirement.

For each installation/environment, obtain separate approval for these operational
steps and irreversible schema deployment:

1. Pause writes using the existing F05 pause, verify it authoritatively, and keep
   it paused throughout cutover. Stop/drain incoming delivery and queues as needed.
   Do not delete old leases or operation ledgers to force progress.
2. Retire every version/entry point capable of running legacy writers, including
   old installation major versions, scheduled/consumer work, webhook URLs, and
   external callers. Establish that no legacy code can receive a new invocation
   or resume old work. Confirm runtime/queue retirement with Atlassian/operator
   evidence if the platform cannot demonstrate it locally. If this cannot be
   established, **do not activate**. Record this verified retirement time as
   `disabledAt`; pause by itself is not retirement evidence.
3. Deploy the reviewed schema/code while paused, wait for required entity/index
   readiness, and verify authenticated Forge lint. Entity/attribute deployment
   has platform deletion restrictions; this is a separate approval boundary.
   Leave migration state missing or set to a non-active phase during this work.
4. After verified legacy retirement, allow at least **1,140,000 ms (19 minutes)**:
   900-second handler ceiling + 180-second outstanding-request allowance +
   60-second margin. Resolve any evidence of remaining old work before proceeding.
   This is a conservative drain allowance, not a claim of atomic Jira fencing
   or proof that unawaited legacy work is gone.
5. Validate the entity protocol on an approved test installation: missing-row
   conditional creation, concurrent takeover, renewal/release conflicts, SDK
   error shapes, invocation async-context propagation, and ownership loss before
   real submission. Complete the live requirements below before activation.
6. With a separately approved administrative storage write, record the per-tenant
   basic KVS control key `issueLeaseMigration:v1` in this shape:

   ```json
   {
     "version": 1,
     "phase": "entity-active",
     "legacyDisabled": true,
     "disabledAt": 0,
     "activatedAt": 1140000
   }
   ```

   These numbers only illustrate the minimum interval. Use actual verified epoch
   millisecond times. `activatedAt` must be at least `disabledAt + 1140000` and
   no later than now. The boolean attests completed retirement, not merely
   intent. Missing, malformed, future-dated, insufficiently drained, or unreadable
   state blocks acquisition and Jira mutations. State is read without caching
   on acquisition/renewal and each mutating submission.
7. Review retained create/ambiguous-write ledgers and operational readiness, then
   obtain approval to resume the existing pause. There is no copying or deleting
   of basic KVS leases in this plan. New entity claims start after the drain;
   leftover legacy entries cannot authorize new code. Optional later cleanup is
   a separate storage change requiring approval.

Rollback: remain paused, put migration state in a non-active phase, retire entity
writers and drain them before considering legacy code. Do not resume an older
version while entity writers can still run. Do not remove schema attributes or
clear operation ledgers as a rollback shortcut. If either side's retirement is
uncertain, stay paused and leave activation blocked.

## Residual risks and live-tenant requirements

- Forge storage conditions do **not** fence Jira atomically. A token may change
  after validation; an already submitted request may complete after expiry or
  successor acquisition. No exactly-once or atomic Jira fencing claim is made.
- Long reads/uploads can outlast the 120-second application lease. The next write
  is blocked; there is no timer renewal during an outstanding request. Normal
  repeated submissions renew while ownership remains valid. Existing operation
  ledgers govern ambiguous/in-flight effects and recovery.
- A create ledger may already mark submission intent before the transport guard
  rejects a write. Existing conservative reconciliation behavior is preserved;
  no ledger is cleared just because a guard reports failure.
- Application deadlines use invocation clocks. Live verification must check
  clock behavior and delay margins; the SDK predicates compare against the
  timestamp supplied by the caller, not a server-side clock expression.
- Unknown Forge transaction errors fail closed, including unrecognized condition
  failure codes. Local model rejection codes do not establish live API error
  shapes. Verify those shapes and missing-row `notExists` behavior on an approved
  tenant; no fallback to unconditional mutation is provided.
- Authenticate Forge lint, deploy/index readiness, test same-tenant competing
  invocations, async-context inheritance, real 429 waits and timeouts, and paused
  cutover/rollback before approving rollout. None was performed in this task.
- More storage checks per submission increase latency and storage usage. Closed
  and crashed claims recover by conditional takeover; abandoned entity rows have
  no native TTL and remain stored until a later takeover/release.

## Local verification

Initial baseline: targeted **45 passed, 2 failed**; full Jest **766 passed, 2 failed**.
Final verification:

| Check | Result |
| --- | --- |
| Targeted F07 + F02/F03/F05 Jest | 326 tests passed, 7 suites |
| `npm test -- --runInBand --silent` | 801 tests passed, 52 suites |
| `npm run lint` | Passed |
| `npm run check:secrets` | Passed |
| Additional secret/path scan of all 7 new files | Passed, zero findings |
| `npm run check:forge:offline` | Passed, zero warnings |
| `git diff --check` | Passed |

The targeted command names `tests/f07-issue-lease.test.js`, both
`tests/batch4-*` lease/sync-path suites, `tests/f02-comment-confidentiality.test.js`,
`tests/f03-inbound-scope.test.js`, `tests/f05-retry-budget-pause.test.js`, and
`tests/f05-write-recovery.test.js`, with `--runInBand --silent`.
The secret scanner's exported `scanFile`/`isForbiddenPath` functions were also
applied to every regular file from `git ls-files --others --exclude-standard`,
so new untracked source/test/report files were included without staging them.

Dependencies were reused via worktree-local symlinks to existing installed
`node_modules` directories; generated UI assets/cache are ignored. No dependencies
or lockfiles were changed. The original remediation checkout, its duplicate files,
and Cline's F08 worktree were not edited.
