# Integration recovery snapshot

Read-only export of the connector's own recovery metadata for one organization.
It exists so an administrator holds a copy of the mapping and create-ledger
state outside Forge storage.

## Scope

| Included | Excluded |
| --- | --- |
| Issue-pair mappings (`mapping-meta:<orgId>:*`) | API tokens and webhook signing secrets |
| Issue-create ledger records (`issue-create-op:<orgId>:*`) | Comments, descriptions, attachment content, attachment mappings |
| Organization routing identity (id, name, remote host, project, allowed projects, direction) | Remote API user email address, JQL filter |
| Forge app, environment, installation, site and cloud identity | Installation-level Forge configuration, deleted-counterpart/repair/ended records |

The file is **not** a complete Forge installation backup and cannot rebuild the
app on its own. It contains exactly the two record sets needed to check whether
mappings and create attempts were lost.

## Preconditions

- The caller must be a Jira administrator; the resolver is classified
  `ADMIN_READ` and is denied by default without that permission.
- Exactly one organization must be selected. There is no "all organizations"
  export.
- The emergency pause must be in force. The export never changes the pause
  state; a missing or unreadable pause record is treated as active and refused.

## Format

NDJSON, UTF-8, one JSON object per line, in this order:

1. `header` — `format`, `formatVersion`, `exportedAt`, `identity`,
   `organization`, `pause`, per-section `count`, `pagesScanned` and `checksum`,
   plus `omissions` and `limitations`.
2. `0..n` `record` lines — `section` is `pairs` or `ledger`. Pair records carry
   `localKey`, `remoteKey`, `createdAt`, `updatedAt`. Ledger records carry
   `direction`, `sourceKey`, `operationSuffix`, `state`, `attempt`, `targetKey`,
   `operationId` and the lifecycle timestamps. Ledger `attemptToken` values are
   never exported.
3. `counts` — `pairs`, `ledger`, `total` and `skipped.ledgerRetryClaims`.
   Transient retry-claim markers are counted here and not exported as records.
4. `footer` — repeats the checksum, counts and per-section checksums, and
   restates the notice and limitations.

Object keys are emitted in sorted order, and records are sorted by identity, so
identical inputs produce identical bytes.

## Checksum

`checksum` is `sha256:<hex>` over the header line, every record line and the
counts line, all newline-terminated. The footer is excluded because it contains
the checksum.

```bash
# Compare with the footer "checksum" value (ignore the "sha256:" prefix).
head -n -1 pilot-org-org-1-recovery-snapshot-2026-02-03.ndjson | shasum -a 256
```

The checksum detects accidental corruption and edit-after-download tampering. It
is not a signature: it does not authenticate who produced the file.

## Completeness and consistency boundary

The export walks each prefix with bounded cursor pages (100 keys per page) until
the cursor is exhausted, then repeats the whole scan. The two scans must agree on
record count, on the digest of their serialized records and on the number of
skipped retry claims; otherwise the export fails. The pause record must be
unchanged before and after the export.

Any of the following aborts the export with no file produced: unreadable page,
cursor that returns an empty page, a repeated page, a duplicated key, an
uninterpretable record or key shape, an unstable second scan, a changed pause
record, a missing identity, or an exceeded page/record/byte budget.

This proves completeness for the two exported prefixes while the pause holds. It
does not prove that storage was read at a single instant: Forge storage offers no
multi-key read transaction, so a writer outside the pause could still interleave.

## Limits

- One organization per export; no cross-organization file.
- 100 keys per page, at most 400 pages, 8000 records per section and 3 MB of
  content. Exceeding a budget fails the export instead of truncating it.
- No restore, adoption or integrity-state behaviour is implemented in this phase.

## Directional mapping consistency

Only the `mapping-meta:<orgId>:*` index is exported. The directed lookups
`<orgId>:local-to-remote:*` and `<orgId>:remote-to-local:*` are written in the
same write as the index record by `storeMapping()` and `replaceIssueMapping()`,
and a restore derives them from the exported pairs, so they are not duplicated in
the file.

The one case this does not cover: `ensureMappingPair()` repairs a missing
direction key without writing an index record. A pair that was left half-written
and then touched only by that repair path exists in the lookup records but not in
the index, so it is absent from the export. The export neither detects nor
repairs that divergence; it is out of scope for this read-only phase.
