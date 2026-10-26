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

