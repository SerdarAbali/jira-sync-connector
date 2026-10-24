# F04 signed Jira administrative webhooks

This build makes a coordinated switch. The Forge webtrigger stays in place;
only `/signed/<orgId>` accepts external deliveries. No legacy cutoff, dual-auth
window, previous-key acceptance, or migration state machine exists.

## Verified signing contract (24 October 2026)

Atlassian's [secure admin webhook documentation](https://developer.atlassian.com/cloud/jira/platform/webhooks/#secure-admin-webhooks)
describes a configured Secret field for manually registered Jira System
Webhooks, `X-Hub-Signature` in `method=signature` form, UTF-8 payload handling,
and SHA-256 examples/test vectors. It notes algorithms could change in future.
This build deliberately supports only `sha256=` followed by 64 hex characters.

[Forge webtrigger requests](https://developer.atlassian.com/platform/forge/runtime-reference/web-trigger/)
expose `body` as a string, header values as arrays, and appended segments as
`userPath`. Forge does not authenticate these requests. We encode that original
string as UTF-8 without parsing or reserializing it before verification.
The docs do not promise arbitrary byte-for-byte transport preservation or how
all upstream duplicate-header variants survive serialization. Genuine Jira
Unicode deliveries and duplicate-header ingress behavior need staging proof.
We reject duplicate names, multiple values and comma-joined signatures that
reach the handler; we cannot detect a duplicate discarded upstream.

[Forge secret storage](https://developer.atlassian.com/platform/forge/storage-reference/kvs-api-secret/)
provides encrypted `setSecret`/`getSecret`, inaccessible to normal queries,
installation isolation, `storage:app`, and last-write-wins behavior. This uses
the existing KVS wrapper and dependencies. Organization isolation adds an
organization-specific key inside the installation.

## Authentication and lifecycle

The handler requires POST, JSON content type, and a nonempty string body no
larger than 1 MiB. It validates the path, selects one organization and loads
only `secret:<orgId>:webhookSigningSecret`. A complete signature is decoded to a
32-byte digest and checked with Node `timingSafeEqual`. Only then is JSON parsed
and the existing event allowlist and bidirectional-direction gate applied.
Authentication failures, including secret-storage failures, return generic 401.
Body/type/size/method errors retain generic 400/413/415/405 responses. There is
no bearer fallback, even when a signature fails.

The existing ADMIN_WRITE resolver policy protects generation/rotation. New
organizations and direction changes do not silently create unretrievable keys.
An administrator explicitly generates 32 cryptographic random bytes (base64url,
256 bits). The resolver stores the key in Forge secrets and returns it once.
Reads and exports never return it. The URL is displayed separately and remains
retrievable. If URL generation fails after rotation, the UI still displays the
secret; retrieve the URL separately. If the one-time response is lost, rotate
again during the planned window. No readback endpoint exists.

Rotation first clears signed receipt proof, then replaces the sole signing key;
previous signatures immediately fail. A proof-reset failure aborts before key
replacement. Safe rotation metadata is best effort; a metadata error cannot
hide the successfully generated one-time secret. Signed receipts use a separate
namespace, so old bearer receipts cannot satisfy signed setup. Serialize
operator actions: KVS is last-write-wins, and concurrent administrators rotating
the same organization could overwrite each other's key. If the result is
uncertain, keep delivery disabled and perform one controlled rotation and test.
Never put keys into tickets, logs, screenshots, exports or source control.

Legacy incoming credentials may remain stored for emergency planning. Imports
and legacy configuration migration can only populate the old namespace; they
cannot authorize deliveries or provision signing keys. Signing keys are removed
when the organization is deleted. Existing API-token handling is unchanged.

## Internal recovery

The hourly heartbeat passes validated persisted organization, direction,
issue/comment/parent identifiers and ancestry constraints to server-only
`recoverIncomingComment`. It never invokes the HTTP route, reads a webhook key,
or fabricates a signature. Shared processing retains scope checks, Pause,
comment confidentiality and ancestry checks, submission fences, issue ownership,
routing, replay guards and operation ledgers. Internal recovery never writes an
authenticated network receipt. The F07 migration gate remains inactive; this
change neither activates it nor grants permission to bypass it.

## Operator runbook — requires a separately scheduled change

These are instructions only. Implementation and tests do not deploy code,
change Jira registration, rotate live keys or modify Forge/Jira data.

1. **Before the window:** inventory every bidirectional organization and its
   existing remote Jira System Webhook, JQL and supported events. Export safe
   configuration, record mapping/ledger health, inspect pending/ambiguous work,
   and retain the baseline and a reviewed signed-capable rollback artifact.
   Protect any backup of the old bearer URL as a credential. Confirm Jira admin
   and Forge installation access, remote API credentials, scope, Pause state,
   and the F07 migration gate. Preserve the gate; do not enable writes merely
   to complete a webhook test. Rehearse this process in staging.
2. **Prepare without editing registration:** schedule a delivery interruption
   and record its start. Disable the existing remote webhook during the window
   if needed. Installing a reviewed signed-only build immediately rejects old
   URLs, so secret preparation in production belongs inside this window. Use
   Create/Rotate Webhook Secret for each organization and retain each one-time
   key in an approved secret manager. Record the separate callback URL. Do not
   change the existing Jira URL until its matching key is ready. The previous
   build cannot prepare the new namespace through its old rotation UI. Global
   Pause can protect writes, but it acknowledges and discards inbound events;
   it is not a delivery buffer.
3. **Switch the existing registration:** in remote Jira Administration → System
   → WebHooks, edit the existing webhook. Set its URL to the displayed
   `<existing-forge-webtrigger-url>/signed/<orgId>` and Secret to that
   organization's one-time key in the same save. Keep Exclude body unchecked;
   retain the approved JQL and supported events. Re-enable delivery when ready.
   Do not register a second competing webhook or put a key in the URL/query.
4. **Verify genuine delivery:** cause a harmless, authorized event in an allowed
   staging/test project. Verify a fresh signed receipt in guided setup and the
   expected processing/ledger outcome subject to Pause and migration gates.
   Exercise Unicode/whitespace content and at least one public comment. Verify
   confidential comments remain blocked and old URLs fail. A generated local
   signature is a regression test, not proof of Jira-to-Forge transport.
5. **Mismatch/failure:** stop delivery or retain Pause while investigating.
   Confirm organization/path, correct Secret field, body inclusion, event/JQL,
   storage availability, and current deployed version. Never log request bodies,
   signatures or keys. A 401 does not distinguish authentication causes. If a
   key was lost or entered incorrectly, perform one planned rotation and update
   the Jira Secret field together; old-key acceptance is unavailable. Retry a
   genuine event and verify a fresh receipt. Mark the interruption end only
   after successful verification.
6. **Missed work:** inventory affected issue/comment/attachment identifiers and
   compare supported mapping, audit and operation-ledger views. Persisted F02
   verification work continues through its heartbeat after scope/Pause allows.
   For other missing inbound events, use only an available authorized Jira
   redelivery mechanism or an explicitly approved supported reconciliation for
   the required direction. Do not assume webhook history offers replay. The
   existing recurring source reconciliation is local-to-remote, not inbound
   backfill. If no supported mechanism covers missing remote work, retain a
   manual reconciliation inventory and obtain a separate recovery decision.
   Do not fabricate HTTP payloads, reset operation ledgers, replay ambiguous
   submissions, or treat resume as backfill.

## Rollback

Prefer correcting registration/configuration or restoring a reviewed
signed-capable artifact that uses the same signing-secret namespace and enforces
HMAC. Preserve mapping/operation storage and secret keys. Verify fresh signed
delivery after repair; do not restore old receipt proof as validation.

Returning to the old bearer-URL build may reopen bearer-token exposure. It is a
separately approved, security-reducing emergency rollback, never an automatic or
preferred action. The existence of retained legacy secrets is not permission to
use them. Document the risk and approval, protect any bearer URL, and plan a
prompt return to signed enforcement. This change executes none of these steps.
