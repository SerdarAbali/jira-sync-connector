# Controlled Recovery Restore

This document describes the controlled restore workflow built on a version 2
recovery snapshot. It is a Forge-storage repair, **not** a synchronization path.

## What it does

A restore can write only:

- a missing issue-pair mapping (`mapping-meta`, both directed lookups); and
- a `succeeded` issue-create ledger row that names that exact pair and target.

It never creates, updates or deletes a Jira issue, never searches Jira, never
changes the emergency pause, never resumes synchronization and never restores
synchronization authorization. It reads both issue identities and both
`sync-connector-pair` witnesses before including a pair.

## Preconditions

1. Emergency pause is explicitly ON. A missing or unreadable pause record is
   refused.
2. The selected organization is configured, has a usable remote site and token,
   and owns the snapshot.
3. The snapshot is a version 2 file from the same app, site, environment and
   installation, with unchanged remote-host and remote-project routing.
4. The snapshot is **recoverable** by the read-only preview: complete directional
   evidence, no contradictory evidence, no version 1 file, no cross-installation
   file.

## Workflow

### 1. Read-only recovery preview

`previewRecoveryRestore` reuses `previewRestoreSnapshot` for checksum, schema,
identity, routing, pause and evidence classification, then reads both issues and
both witnesses for each bounded candidate.

For every candidate pair it reports one witness state:

| State | Meaning | Plan eligibility |
| --- | --- | --- |
| `confirmed` | Both issues exist, both witnesses parse, both name this exact pair and installation. | Eligible. |
| `absent` | Both issues exist and both witness properties are absent. | Eligible only through the explicit snapshot plan, which the administrator must approve. Historical pre-witness pairs fall here. |
| `blocked` | Any missing/inaccessible issue, partial witness, malformed/foreign witness, or contradictory pair identity. | Excluded with a reason; never approximated. |

A live mapping conflict, a live ended/repair/deleted-counterpart record, or a
contradictory live create-ledger row excludes the pair. Snapshot evidence from
the file is also a blocker, so an old file cannot revive a relationship that was
later ended.

### 2. Bounded plan

`planRecoveryRestore` stores a pending plan (one KVS value, at most 200 pairs).
The plan digest covers:

- purpose/version, organization and installation identity;
- the snapshot checksum and format version;
- explicit selection mode and selected pair identities;
- every pair's local/remote key, witness state, and every attached ledger
  identity/target.

The plan content is immutable under the digest. A different selection, changed
witness class or changed ledger target cannot reuse the same approval.

If more than 200 pairs are restorable, restore this plan, then preview the same
file again. Pairs already restored are classified as present and the next
missing slice is selected. The planner scans the complete ordered missing list
to fill its 200 eligible slots; a full window of witness- or ledger-excluded
pairs cannot hide a later restorable pair. This is how a large snapshot is
restored without pretending one plan can be approved atomically.

### 3. Explicit approval

`approveRecoveryRestore` requires:

- pause still ON;
- a non-expired plan whose digest still matches;
- the exact phrase `RESTORE <orgId> <digest>`;
- a fresh revalidation of every item (mapping, blockers, both witnesses and
  ledger rows).

Any change rejects the whole approval with `RECOVERY_RESTORE_APPROVAL_STALE`.
On success, before any mapping write, synchronization authorization is moved to
`restore-in-progress`. That state blocks every Jira write independently of the
pause. Approval itself writes no Jira issue, mapping or ledger row.

### 4. Bounded, resumable batches

`applyRecoveryRestore` runs at most 10 items by default (maximum 50), under a
single-flight lock. Immediately before each item it re-reads:

- both mapping directions and the metadata index;
- ended, repair and counterpart-status blockers;
- both issue identities and both witnesses;
- the planned ledger rows and the base ledger slots for both directions.

A mapping is written with the normal `storeMapping` helper, which writes both
directions and the metadata index and detects conflicts. A succeeded ledger row
is created with `FAIL_IF_EXISTS`; an existing row is accepted only when it is
already a succeeded row with the same target, otherwise the item is a conflict.
Progress is persisted after every item. An interrupted invocation can be resumed
without re-writing completed items.

A transient ledger-write failure leaves the mapping in place and the item
`partial`; the next batch retries only the missing ledger. A conflict is terminal
for that item and leaves the plan `needs-attention`.

### 5. Completion

When no pending/partial items remain:

- the pause is **not** changed;
- synchronization authorization is moved from `restore-in-progress` to
  `blocked`;
- an administrator must explicitly re-authorize synchronization;
- the plan and the sanitized `recovery-restore` audit entries remain as the
  durable record.

If the authorization transition fails, it remains `restore-in-progress`, which
is fail-closed: no Jira write can occur until a later explicit authorization.

## Scope boundaries

- Only missing mappings and `succeeded` ledger rows are restored.
- `pending`, `unknown` and `failed_definitive` ledger rows are left untouched for
  the existing issue-create recovery workflow. Restoring an `unknown` row without
  its original attempt token would make it impossible to reconcile safely.
- Evidence sections are consulted as blockers and are not recreated. Restoring an
  ended/repair/counterpart record over newer state would be a separate operation.
- A mapping that is already present, incomplete or conflicting is never
  overwritten. Incomplete directional pairs require the normal repair path.
- The snapshot checksum detects corruption and edit-after-download tampering; it
  is not a signature and does not authenticate the file. Approval is an explicit
  administrative decision bound to the digest.
- Forge storage has no multi-key transaction. Pause, per-item revalidation and
  persisted progress bound the window; they do not make a batch atomic.

