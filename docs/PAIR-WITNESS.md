# Pairing witness (Jira issue property)

Read-only foundation for a Jira-side record that identifies a synchronized issue
pair independently of Forge storage. Phase 1 ships the schema, the read path and
an inspection preview. **No property is ever written in this build.**

Related: [Integration recovery snapshot](./RECOVERY-SNAPSHOT.md) covers the
Forge-side backup; this document covers the Jira-side evidence that survives
losing it.

## Why a Jira property

Forge mappings, directed lookups, the create ledger and last-synced markers all
live in Forge storage. If that record space is lost while the installation stays
authorized, a previously synchronized issue looks unmapped and can be created a
second time. A property on the issue itself is the only evidence that lives where
the issue lives.

| Property | Value |
| --- | --- |
| Key | `sync-connector-pair` (19 bytes; limit 255) |
| Scope | one property per issue, on both issues of a pair |
| Size | ~550 bytes (limit 32 768) |
| Permission | `Browse projects` + `Edit issues`; scope `write:jira-work` (already granted) |

## Schema, version 1

```json
{
  "v": 1,
  "pairId": "3f6c1a8e-9b21-4f0d-9d4e-6a1b2c3d4e5f",
  "state": "active",
  "installationId": "<forge installation id>",
  "appId": "ari:cloud:ecosystem::app/<uuid>",
  "orgId": "org-1",
  "localSite": "<cloud id or site host>",
  "remoteSite": "remote.atlassian.net",
  "localIssueId": "10001",
  "localKey": "OPS-14",
  "remoteIssueId": "20881",
  "remoteKey": "SUP-77",
  "direction": "local-to-remote",
  "writtenAt": "2026-10-26T09:41:12.004Z",
  "digest": "sha256:…"
}
```

- `state` is `pending-create`, `active` or `ended`. There is no fourth value.
- Stability: `localIssueId`/`remoteIssueId` are Jira's numeric ids and are the
  identity. Keys change when an issue moves project, so they are display only and
  are never compared for identity.
- `digest` is `sha256` over the canonical (key-sorted) field tuple without the
  digest itself. A record whose digest does not match is reported as malformed
  rather than trusted field by field.
- A value with `v` greater than 1 is reported as `schema-newer` and is never
  coerced. Unknown states, missing fields, non-numeric ids and foreign
  identifiers are conflicts.
- The key is deliberately **not** versioned. The version lives inside the value
  so a future schema change does not orphan existing properties.

## Read classification

`readPairWitness` issues one
`GET /rest/api/3/issue/{idOrKey}/properties/sync-connector-pair` through
`guarded-api`, so the pause, lease-migration and synchronization-authorization
gates still apply. Reads use the stable id when it is known.

| Answer | Class | Consequence |
| --- | --- | --- |
| 404 | `absent` | the only class that leaves a future create possible |
| 401 / 403 | `inaccessible` | permissions or app access rules; **never** absence |
| 429 | `unverifiable` | rate limited |
| 5xx, network error | `unverifiable` | no answer |
| 200, unreadable body or no `value` | `malformed` | conflict |
| 200, `v` > 1 | `schema-newer` | conflict |
| 200, foreign `installationId`/`appId` | `foreign-installation` | conflict |
| 200, foreign `orgId` | `foreign-organization` | conflict |
| 200, different site | `site-mismatch` | conflict |
| 200, names another issue | `issue-mismatch` | conflict |
| 200, different `pairId` | `different-pair` | conflict |
| 200, `ended` | `ended` | historical pair |
| 200, `pending-create` | `pending-create` | unfinished create |
| 200, matches expectation | `matching` | the pair is proven |

Issue existence reads follow the same discipline: 404 is missing, 403 is
inaccessible, everything else is unverifiable.

## Migration preview (this phase)

`previewPairWitnessMigration` (`ADMIN_READ`) inspects one organization:

1. requires the emergency pause and a readable installation identity;
2. pages `mapping-meta:<orgId>:` up to a bounded pair count;
3. reads both directed lookups, the create ledger row for each direction, the
   ended-mapping record and the repair marker;
4. verifies both issues exist, then reads the witness on both, by stable id;
5. classifies each pair, detects two local issues claiming one remote issue, and
   reports counts, findings, duplicates and an API-cost estimate.

Precedence, first match wins: `mapping-mismatch`, `create-in-doubt`,
`duplicate-destination`, `pair-ended`, `repair-required`, `counterpart-missing`,
`counterpart-inaccessible`, `unverified`, `witness-conflict`,
`witness-inaccessible`, `witness-unverifiable`, `witness-ended`,
`witness-pending-create`, `partially-witnessed`, `already-witnessed`,
`ready-to-witness`.

A pair that storage already refuses is **not** sent to Jira: the preview does not
spend quota confirming a decision it has already made.

The scan is bounded. When it stops at the requested limit the result is reported
as `truncated`, never as complete.

## Corrected design statements

These replace earlier working assumptions and are binding for later phases.

1. **Historical witnesses are never deleted because synchronization ended.** An
   unmapped or ended pair transitions its witness to `state: "ended"`. Deleting
   the property would destroy the only record that the pair ever existed, which is
   exactly the evidence a recovery needs. This also applies to deletion
   propagation.
2. **Description markers are supplementary, never guaranteed.** The
   `🔗 A-1 ↔ B-2` line (future form `… · pair:<uuid>`) is useful because it can
   travel inside the create payload at zero extra requests, but
   `adfPreservesOriginalContent` may skip it, users may edit it, and ADF rendering
   may change it. No decision may depend on it: a missing description marker
   proves nothing, and a present one can only block.
3. **Ambiguous creates remain blocked by the existing ledger.**
   `issue-create-op` stays the authority for a create whose outcome is unknown.
   The witness neither replaces it nor resolves it, and this preview never
   resolves one. A `pending` or `unknown` ledger row is reported as
   `create-in-doubt` and stops classification.
4. **No circular dependency between migration authorization and witness
   coverage.** Requiring "every pair must already be witnessed" before a migration
   may be authorized can never be satisfied on a legacy installation, and
   requiring a completed authorization before any witness may be written would
   deadlock the same way. The migration is authorized by an explicit administrator
   decision over a bounded, digest-addressed plan; witness coverage is an
   *outcome*, reported before and after, never a precondition.
5. **A future migration permit is narrow.** If a later phase needs to write
   properties while the connector is paused, the permit must be restricted to
   `PUT /rest/api/3/issue/{key}/properties/sync-connector-pair` for the exact keys
   in the approved plan, and it may bypass **only** the pause check. Lease
   migration, synchronization authorization and every other safety gate stay in
   force. It must never be a general write allowance.

## Cost and permissions

| Operation | Jira requests |
| --- | --- |
| Preview, per pair | 2 existence reads + 2 property reads = 4 |
| Preview, per storage-refused pair | 0 |
| Preview, per run | 1 installation-identity read (`serverInfo`) |
| Preview, page of mappings | 1 storage page |
| Property write (future) | 1 per issue |

App-originated requests count against the hourly points quota (65 000 points/hour
in the shared pool; an issue object is 1 point). The remote site is called with an
API token, whose traffic the points quota does not cover. Per-issue write limits
apply to any future write; the preview makes none.

## Authorization: exact organization-set equality

Synchronization authorization now compares the authorized set with the configured
set for **exact equality**, not containment, and stores a canonical
`organizationSetDigest` for that set.

| Change | Result |
| --- | --- |
| an organization is added | `SYNC_AUTHORIZATION_ORGANIZATIONS_UNVERIFIED` |
| an organization is removed | `SYNC_AUTHORIZATION_ORGANIZATION_SET_CHANGED` |
| the set is reordered | no change |
| the digest disagrees with the stored set | `SYNC_AUTHORIZATION_ORGANIZATION_SET_CHANGED` |
| a pre-digest record | still compared by exact set |

Removing an organization used to leave the record valid, so a later re-add
silently restored coverage — including over mappings lost in between. Both
directions now invalidate, and re-authorization needs the phrase for the exact
current set.

## Limits of this phase

- No property is written, no approval or apply resolver exists, and no create-path
  guard is installed. The preview cannot improve resilience on its own.
- Only `org-<n>` organizations are supported; the legacy single-organization
  storage namespace is not previewed.
- A witness is user-editable by anyone with `Edit issues` and is therefore
  evidence, not authority.
- Project app access rules can make properties unreadable; those pairs are
  reported as inaccessible and will block a future write.
- Description-based evidence is not read here at all.


## Controlled migration (implemented, not yet run)

The migration writes the witness for existing pairs while the connector stays
paused and synchronization authorization stays blocked. It never resumes,
never creates an issue, never updates a field or description, and never writes a
mapping or create-ledger record.

### The one authorized request

```
PUT /rest/api/3/issue/{stableIssueId}/properties/sync-connector-pair
```

`assertJiraSubmissionAllowed` evaluates the maintenance permit **before** the
ordinary chain. A request that is not exactly this shape is not permit-shaped: it
falls through to the unchanged chain and is still refused by the pause and the
authorization gate. A request that *is* permit-shaped but fails any condition is
refused outright — never downgraded to "the pause would have blocked it anyway".

Every condition is independent and enforced server-side:

| Condition | Where |
| --- | --- |
| method is `PUT` | boundary predicate |
| path is exactly the property path with a numeric stable id | boundary predicate |
| site is `local` (relative call) or an approved remote host | boundary predicate |
| issue id is in the permit's approved set for that site | permit record |
| permit exists, parses, is unexpired, belongs to this installation and app | permit record |
| plan exists, matches the permit digest, is approved/running, unexpired | plan record |
| body is a valid witness whose `pairId` and payload digest match the entry | permit entry |
| the witness `orgId` equals the permit organization | payload |
| the emergency pause is explicitly ON | `getPilotPause()` — a missing record is *not* ON |
| no restore is in progress | authorization record |
| no earlier write marker exists for this issue | `witnessWritten:*` |

### Permit and plan records

| Record | Key | TTL | Purpose |
| --- | --- | --- | --- |
| Plan | `pairWitnessPlan:{orgId}` | 24 h | Immutable item list, digest, per-item state, approval metadata |
| Permit | `pairWitnessPermit` | 10 min | One installation, one org, one batch, one payload per approved issue |
| Write marker | `witnessWritten:{orgId}:{site}:{issueId}` | 30 d | Proves one write per issue, so a second permit cannot repeat it |
| Batch lock | `pairWitnessBatchLock` | 2 min | Single-flight ownership via atomic create-if-absent |

The permit is a single global key, so only one organization can migrate at a time.
That is stronger isolation than a per-organization key: an Org A permit cannot
name an Org B issue, and approving Org B while an Org A permit is live is refused.

### Pair identity

`pairId = uuidv5(namespace, installationId:orgId:localIssueId:remoteIssueId)`.
It is derived, never randomly generated, so a retry, a new process, an expired
permit or a lost plan all produce the same identifier for the same pair. A
different organization or issue always produces a different identifier.

### Batch algorithm

1. acquire the batch lock (atomic, TTL-bounded)
2. read the plan, verify its digest still describes its items, verify it has not expired
3. take up to 10 pairs still `pending` / `partial` / `deferred`
4. mint a fresh permit for exactly those sides and payloads
5. per pair: revalidate both directions, the ledger, ended/repair records and both
   issue ids; read both witnesses; refuse to touch a conflict, an ended witness or
   anything unverifiable
6. write **local** property, read it back and compare
7. write **remote** property, read it back and compare
8. only after both verifications: write the per-issue markers and persist progress
9. revoke the permit (one batch, one permit) and release the lock

### Failure handling

| Outcome | Classification | Behaviour |

### Concurrency: one writer per batch

A lock with only a fixed TTL would let a slow batch outlive its own lock and run
alongside a new invocation. Ownership is therefore re-asserted **immediately
before every property PUT**, not once per batch:

| Check | Effect |
| --- | --- |
| lock record missing, unreadable, or a different token | `PAIR_WITNESS_BATCH_LOCK_LOST`, the batch stops before the next PUT |
| stored `expiresAt` already passed | same refusal, even if the token still matches |
| less than half the TTL left | the lock is extended for the same token before the write |

On loss the invocation stops and the remaining pairs stay `pending`: no write is
attempted, no progress is fabricated, and the newly owning invocation simply
continues. Releasing a lock that a different token now holds is refused, so an
old invocation cannot delete its successor's claim.

The only residual overlap is the few milliseconds between the ownership check and
the transport call. Both writers would send the same canonical payload for the
same pair (the pair id is derived, not random), so the property converges; the
loser's read-back sees the winner's `writtenAt` and reports the pair for review
rather than overwriting anything.

### Recovery: interruption leaves repeatable evidence

| Interrupted after | Re-run behaviour |
| --- | --- |
| local PUT, before progress is stored | local witness already matches → skipped, only the remote side is written |
| both PUTs, before markers | both match → `verified`, zero writes; markers are only a write-time guard, not a prerequisite for verification |
| marker stored, plan progress stale | pair verifies from the properties themselves; a marker never blocks verifying an already-correct pair |
| permit expired after the first property | the refusal is `PERMIT_EXPIRED`, which is *recoverable*: the pair is `deferred`, the local witness stays, the next run mints a fresh permit and writes only the missing side |
| a terminal permit refusal (payload, pair, marker, pause, restore) | the pair is `conflict` and the plan reports `needs-attention`; a refused write is never retried blindly |

A permit refusal is non-retryable by design: retrying the same body cannot
succeed, and the reason must reach the caller so it can distinguish "no authority
right now" (defer) from "this payload will never be allowed" (conflict).

| --- | --- | --- |
| 2xx | applied | read back before any progress is recorded |
| 4xx | definitive | pair marked `conflict`, no retry |
| 429 | not applied | `Retry-After` honoured inside the budget; otherwise deferred |
| 5xx / timeout | ambiguous | read back: identical → verified, absent → one retry with the same pair id, different → conflict |
| local fails | nothing written remotely | pair `conflict` (or `partial` when evidence exists) |
| remote fails after local | local witness kept | pair `partial`, reported, never deleted |

A plan with no remaining work reports `completed` when everything verified and
`needs-attention` when a conflict remains. Expiry stops writes but never discards
the plan, the markers or the recorded states; continuation revalidates the stored
plan before minting any new permit.

### Selecting exact pairs

A migration can be restricted to specific pairs. The selection is a list of exact
`{ localKey, remoteKey }` entries and is enforced on the server, never by the UI:

| Input | Result |
| --- | --- |
| selection omitted | whole organization, as before; unsafe pairs are listed and skipped |
| selection supplied, non-empty | only those pairs; anything unsafe refuses the **whole** plan |
| selection supplied but empty | refused (`PAIR_WITNESS_SELECTION_EMPTY`) — never read as "all pairs" |
| unknown pair | refused (`…_SELECTION_PAIR_UNKNOWN`), including a pair from another organization |
| wrong remote key for a mapped local issue | refused (`…_SELECTION_PAIR_MISMATCH`) |
| the same pair, or the same local issue, twice | refused (`…_SELECTION_DUPLICATE`) |
| selected pair is ended, conflicting, inaccessible or in doubt | refused (`…_SELECTION_PAIR_INELIGIBLE`) with the reason |

The selection is normalized into canonical order (local key, then remote key) and
the digest covers the selection mode, the exact selected pairs, the item count and
every item's identity. Approval rebuilds the plan with the same selection, so:

- a one-pair plan and a whole-organization plan can never share a digest or a phrase;
- a phrase built for one selection cannot approve another (adding a pair changes
  the count and the digest);
- the permit issued at approval contains only the selected issues and their exact
  approved payloads, so no other issue can be written under it.

### Scope choice in the admin panel

The panel makes the scope an explicit decision rather than a side effect of an
empty box:

| Scope | Behaviour |
| --- | --- |
| **Selected pairs** (default) | Requires at least one valid `LOCAL-KEY REMOTE-KEY` entry. A blank or malformed entry keeps **Build plan** disabled; there is no fallback to the organization. |
| **Entire organization** | Must be chosen deliberately, shows a warning that every eligible pair (two writes each) will be included, and sends no selection at all. |

The plan panel then shows the digest, every planned pair with both stable issue
ids and its pair UUID, the action per pair and any excluded pairs, so what will be
written is visible before the phrase is typed. Approval is bound to the same
scope: switching scope or editing the selection changes the rebuilt plan and the
phrase no longer matches.



### Administration

| Resolver | Policy | Effect |
| --- | --- | --- |
| `planPairWitnessMigration` | ADMIN_READ | recomputes the plan, writes nothing |
| `getPairWitnessMigrationStatus` | ADMIN_READ | reads plan, states and permit |
| `approvePairWitnessMigration` | ADMIN_WRITE | exact phrase `APPROVE WITNESS <orgId> <digest[0..12]> <pairs>`; writes plan + first permit; zero Jira writes |
| `applyPairWitnessMigration` | ADMIN_WRITE | one bounded batch of property PUTs |
| `cancelPairWitnessMigration` | ADMIN_WRITE | revokes the permit and deletes the plan; zero Jira requests, zero property deletions |

### What this phase still does not do

- It does not run itself: approval and every batch are explicit administrator
  actions, and the connector stays paused throughout.
- It writes only `state: "active"`. Witnesses for pairs that end later are
  transitioned by the sync paths (Phase 3); nothing here deletes one.
- Ended, conflicting, duplicated, unverifiable and in-doubt pairs are excluded
  from the plan with their reason and are never approximated.

