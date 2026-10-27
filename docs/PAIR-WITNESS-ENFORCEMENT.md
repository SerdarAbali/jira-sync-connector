# Pairing-witness enforcement (v2.2.1)

This document describes the create-path protection added in SyncApp v2.2.1. It
builds on the witness schema and migration described in
[PAIR-WITNESS.md](./PAIR-WITNESS.md).

## What changed

- Every issue create — outbound and inbound — reads the **source issue's own**
  `sync-connector-pair` property before the create claim.
- When a valid witness names a counterpart, the counterpart and its witness are
  read by **stable Jira issue id**. Two matching witnesses block the create.
- After a successful create and mapping/ledger persistence, both issues receive
  the witness through the existing schema, deterministic pair id and canonical
  digest, followed by a read-back on each side.
- Initial-backfill previews consult the same evidence, so a witnessed pair is a
  conflict rather than an eligible "new" issue.
- Bulk-sync summary matches and deleted-counterpart 404s no longer create
  mappings or replacements. Only the existing recovery workflow may replace a
  deleted counterpart.
- A new administrator action, `adoptWitnessedPair`, restores one missing Forge
  mapping from two verified witnesses.

No property schema, property key, migration permit, synchronization
authorization, pause semantics or issue-create ledger format changed.

## Create guard

`src/services/sync/pair-witness-guard.js` is read-only. It performs no Jira
write, mapping write, ledger write or search. It runs inside the existing
per-issue lease, after the pause and outbound-scope checks and before
`beginIssueCreateOperation`.

Order:

1. Legacy (`null`) organization scope is reported as not applicable.
2. Existing mapping (same scope and suffix as the create) blocks.
3. A `succeeded` or `unknown` create-ledger row blocks.
4. The Forge installation identity is read from context (no `/serverInfo` call).
5. The source issue's stable id is used, or resolved with one GET.
6. The source witness is read with the installation, app, organization, local
   site, remote site and issue id as expectations.
7. A matching witness triggers a counterpart identity read and a second witness
   read. The pair id must equal
   `uuidv5(installationId, orgId, localIssueId, remoteIssueId)`.

| Evidence | Result |
| --- | --- |
| property 404, no mapping, no in-doubt ledger | allow (first-time create) |
| two matching, active witnesses | block `PAIR_WITNESS_PAIR_PROVEN` (duplicate) |
| matching witness, counterpart 404 | block `PAIR_WITNESS_COUNTERPART_MISSING` |
| one-sided witness | block `PAIR_WITNESS_COUNTERPART_WITNESS_ABSENT` |
| counterpart witness disagrees | block `PAIR_WITNESS_COUNTERPART_WITNESS_CONFLICT` |
| malformed, future schema, foreign installation/org/site, issue mismatch | block |
| ended witness | block unless replacing exactly that counterpart |
| pending-create witness | block |
| 401/403 | block `PAIR_WITNESS_INACCESSIBLE` |
| 429/5xx/network | block `PAIR_WITNESS_UNVERIFIABLE` |
| explicit replacement, witness names the deleted counterpart, counterpart 404 | allow |

An absent witness is **not** proof that a counterpart never existed. It only
preserves the pre-existing trust model: no mapping and no in-doubt ledger.

Guard refusals are recorded as sanitized synchronization decisions
(`duplicate`, `conflict`, `skipped_locked`, `ambiguous_write`) and audited for
conflicts. No global Jira search is performed.

## Maintenance-permit boundary

Witness establishment is an ordinary Jira write. At `guarded-api`, a
permit-shaped request with **no permit record at all** falls through to the
unchanged chain: lease migration, emergency pause, synchronization
authorization and current-issue leases. It therefore cannot write while paused
or unauthorized.

A permit record that exists but is expired, malformed, foreign, payload-
mismatched or not approved is refused outright and never downgraded to an
ordinary write. Maintenance migration still requires the pause to be confirmed
on, so a missing permit while paused is blocked by the pause gate; it cannot
authorize a maintenance operation. No other method, path or body shape is
treated as a maintenance permit.


`src/services/sync/pair-witness-establishment.js` runs only after:

- the create POST succeeded,
- the issue-create ledger was resolved to `succeeded`,
- the mapping (or replacement mapping) was written.

Order is local property → read-back → remote property → read-back. A failed local
side stops the remote write. Existing contradictory evidence is never
overwritten. The only exception is an explicitly authorized replacement of the
exact previous pair recorded by the witness.

Outcomes:

| Outcome | Meaning |
| --- | --- |
| `witness-established` | both sides written and verified |
| `witness-already-present` | both sides already carried the same pair identity |
| `witness-partial` | one side established, the other failed or deferred |
| `witness-read-back-failed` | a write landed but the read-back did not match |
| `witness-conflict` | existing evidence describes another pair |
| `witness-deferred` | rate limited or permit deferred; no retry loop |
| `witness-blocked` | pause or synchronization authorization blocked the write |
| `witness-unavailable` | identity or issue verification unavailable |
| `witness-skipped-mapping-failure` | issue created, ledger succeeded, mapping failed |
| `witness-skipped-ledger-failure` | issue created, ledger could not be finalized |

A witness failure never repeats the create POST and never changes the mapping or
ledger outcome. The last state is stored per pair at
`pair-witness-state:<orgId>:<localKey>:<remoteKey>` with only outcome, reason,
side statuses, pair id, target key and timestamp. It contains no issue content or
credentials. An audit entry `pair-witness-establishment` is appended when
possible.

If mapping or ledger persistence fails after the issue exists, no witness is
written. The created issue stays an explicit recovery item rather than being
legitimized by Jira-side evidence.

## Initial backfill

`previewInitialSync` classifies each otherwise-eligible issue against the same
guard. A witnessed pair becomes `mappingConflicts` with reason
`WITNESS_CONFIRMS_EXISTING_PAIR`; an unreadable witness blocks the candidate with
`WITNESS_UNVERIFIABLE`. A genuine new issue (property 404, no mapping, no
in-doubt ledger) stays eligible.

Because the preview checksum covers classification, new witness evidence changes
the checksum and requires a fresh administrator approval. In-flight jobs still
pass through the create guard, which blocks any witnessed pair as reconciliation
instead of creating it.

## Deleted-counterpart replacement

A missing counterpart is never permission to create another one. Replacement
remains limited to the existing workflow (`probeDeletedCounterpart` →
`replaceDeletedCounterpart`), which requires a confirmed-deleted status record
and, for inbound replacement, bidirectional sync. The guard permits the create
only when the replacement context names exactly the counterpart recorded in the
witness.


## Explicit witnessed-pair adoption

When mappings and ledger are lost but both witnesses survive, normal creation is
blocked (correctly) and the pair needs an explicit repair.

Inputs:

- `orgId` (`org-<n>`, not legacy)
- `localKey`, `remoteKey`
- the deterministic `pairId` shown by the read-only witness preview
- the exact phrase:
  `ADOPT <orgId> <localKey> <remoteKey> <pairId>`

Preconditions:

- emergency pause is confirmed **on**, so no event can create concurrently;
- both issues exist, are accessible and still have the supplied keys;
- both witnesses classify as `matching` and describe the same pair identity;
- the pair id derives from the installation, organization and both stable ids;
- no conflicting mapping exists.

The action writes exactly one Forge mapping (`storeMapping`) and an audit entry
`adopt-pair-witness`. It performs no Jira write, no ledger write and no search.
A repeated adoption of an identical mapping is an idempotent no-op.

Resolver policy: `adoptWitnessedPair` = `ADMIN_WRITE`.

Recovery → Witnesses includes a compact adoption panel. It verifies one
explicitly supplied pair, shows both witnesses, the pair id, mapping and pause
state, the exact confirmation phrase and any conflict. It never invokes the
adoption resolver on mount, and changing the organization or either issue key
invalidates the previous verification and approval. `previewWitnessedPairAdoption`
is `ADMIN_READ`; adoption still enforces every server-side check.

Recommended recovery procedure:

1. Pause synchronization.
2. Open the read-only witness preview and find the pair and its `pairId`.
3. Verify both issue keys and the pair id out of band.
4. Invoke `adoptWitnessedPair` with the exact phrase.
5. Confirm the mapping exists and re-run the witness preview.
6. Resume synchronization only after the normal authorization checks.

## Known limits

- **Historical pairs without a witness are not protected.** Only pairs that
  carry `sync-connector-pair` on both sides are enforced. A witness-absent create
  can still duplicate an unwitnessed historical pair if mappings and ledger were
  also lost.
- Legacy (`null`) organization scope is not protected because the witness schema
  requires `org-<n>`.
- A one-sided witness blocks creates but cannot prove the pair; adoption requires
  both sides.
- A 404 on an issue is not proof of deletion, because Jira can answer 404 for
  issues the app cannot see. A witnessed counterpart that answers 404 is blocked
  and requires the recovery workflow.
- Witness properties are editable by anyone with `Edit issues`; they are
  evidence, not authority. The deterministic pair id and installation binding
  make accidental acceptance unlikely, not impossible.
- Witness establishment can fail after a successful create (pause, permission,
  rate limit). The mapping and ledger remain authoritative; attention is
  recorded, and no retry loop is started.
- Bulk sync remains disabled. Its legacy summary-matching and 404-recreate
  branches are hardened but unreachable from the production handler.
- No automatic remapping, no broad search and no automatic recovery exist.

## Operational cost

Per create with no witness: one local property GET (plus one issue GET only when
the caller has no stable id). With a matching witness: two issue reads and two
property reads. Establishment adds up to two property PUTs and two read-backs.
App-originated local reads count against the hourly points quota; remote reads use
the organization's API token.

