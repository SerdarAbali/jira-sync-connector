# Vendor pilot runbook

Concise operating procedure for the first attended pilot between one customer
Jira site and one vendor Jira site. Baseline: commit `cfb1615`, staging version
3.10.0, 79 suites / 1,612 tests passing, source and staging write control paused.
The Go / No-Go checklist and the write-state model come first. Sections 1 to 8
are the reference detail and run in order for a single controlled sitting; the
admin page map at the end is a lookup table.

Only controls that exist in the deployed admin page are named here, using their
on-screen labels. Anything marked **verify** depends on the customer's own Jira
configuration, permissions or workflow and cannot be established by this
document, by the connector, or by a passing staging run.

Related: [Configuration](CONFIGURATION.md), [Operations](OPERATIONS.md),
[Troubleshooting](TROUBLESHOOTING.md), [Security](SECURITY.md), and the
[outbound selection guarantee](PACKAGE1_OUTBOUND_SELECTION_GUARANTEE.md).

## Go / No-Go checklist

Work top to bottom at the go/no-go review. Every box must be ticked with its
evidence recorded in the pilot log; an unticked box is a No-Go decision, not a
follow-up task. Each item names the reference section that holds the detail.

- [ ] **Project scope agreed** — one vendor organization only, pilot projects
  alone in **Project Filter**, and a target project that resolves for every
  in-scope source project (sections 1 and 2).
- [ ] **Existing counterpart inventory complete** — `Already mapped` reviewed in
  **Preview Scope**, and a source-vs-vendor comparison done for issues that
  predate the pilot. Pre-existing vendor issues are never adopted (section 1).
- [ ] **JQL restrictions agreed** — filter narrow, under 500 characters, no
  relative dates, and bound to the approved preview by checksum (section 2).
- [ ] **Comment policy agreed in writing** — `Sync Comments` left off for the
  start of the pilot, or an explicit acceptance that the vendor audience may read
  ordinary unrestricted source comments; no restricted threads in scope
  (section 3).
- [ ] **Field ownership accepted** — the vendor owner knows source-side values
  overwrite vendor edits, components and versions must exist at the vendor by
  name, and status changes require transitions the vendor workflow already
  exposes (section 4).
- [ ] **Deletion settings left off** — attachments, attachment deletion
  propagation, automatic counterpart replacement and the legacy
  `Recreate Deleted Issues` all unchecked; nothing is deleted automatically
  (section 2).
- [ ] **Recovery access confirmed** — a named operator can reach **Recovery** →
  **Ambiguous Issue Create Recovery**, **Diagnostics** and
  **Synchronization Write Control** during the pilot window, not only after it
  (sections 5 and 7).
- [ ] **Attended first synchronization scheduled** — named operator, fixed
  window, previewed scope, and a recorded decision on whether writes stay
  **ACTIVE** afterwards (section 5).

## Write states during the pilot

Three states, and only one of them synchronizes.

- **PAUSED** — connector writes are blocked. Issue, comment, link, attachment and
  transition writes in both directions are refused immediately, while reads,
  configuration, diagnostics and exports stay available. Inbound events that
  arrive while paused are acknowledged and discarded, so **replay is not
  guaranteed**: there is no backlog, no catch-up queue and no "sync the gap"
  action. The state stores `Paused At`, `Paused By` and the reason code. A paused
  connector is not synchronizing; time spent paused is not recovered by resuming.
- **ACTIVE** — normal pilot operation. Writes flow in the configured direction,
  which is what makes the pilot a synchronization rather than a one-off copy. It
  requires an operator watching **Persistent Job Progress** during the attended
  window and the daily read-only coverage check in section 6 afterwards.
- **Emergency pause** — the same PAUSED mechanism used for containment. It stops
  further writes and nothing else: it does not roll back, retract, delete or
  repair anything already written at the vendor, and it does not restore what was
  skipped while paused. Rollback and cleanup are separate, explicitly approved
  manual Jira operations (section 5).

Never describe a connector left in PAUSED as a live, continuous or "always on"
integration. While it is paused, new and changed issues are not synchronized and
the vendor has a frozen snapshot of whatever was written during ACTIVE windows.

## 1. Preflight

Complete every row before creating the organization. Record the date, operator
and evidence for each row in the pilot log.

| Check | Where | Pass condition |
| --- | --- | --- |
| Source administrator | Any admin page action | The operator holds global *Administer Jira*. Every resolver re-checks `ADMINISTER` as the invoking user and fails closed with `Jira administrator permission required`. |
| App scopes approved | Forge install/upgrade prompt | Installation approved with `read:jira-work`, `write:jira-work`, `read:jira-user`, `read:comment:jira`, `write:comment:jira`, `write:issue-link:jira`, `read:issue-meta:jira`, `read:project:jira`, `storage:app`. Outbound `fetch` is limited to `*.atlassian.net`. |
| Remote credentials | Organization header → **Test** | **Test** calls only `/rest/api/3/myself`. Success proves the URL, email and token authenticate — it proves nothing about project permissions. |
| Remote project permissions (**verify**) | Vendor Jira project administration | The token account can browse, create, edit, comment, attach, link and transition in the target project(s). The connector does not grant these. |
| Target project resolves | Organization header → **Edit**, **Configuration** → **Connection Settings**, **Mappings** → **Project Mappings** | `Target Project Key`, or a per-project mapping, resolves to the vendor project. The same routing decides which project a later recovery reconciliation will accept. |
| Issue types mapped | **Mappings** → **Issue Type Mappings** | Every in-scope source issue type has a target type. A missing mapping blocks the create instead of guessing. |
| Fields mapped | **Mappings** → **Field Mappings**, rejected-field list | Only mapped custom fields copy; system fields use built-in paths. Decide whether to clear or accept learned rejections before the first write. |
| Statuses mapped | **Mappings** → **Status Mappings** | Every target status is reachable through a transition the vendor workflow exposes. A missing transition is reported as a failure; workflows are never modified. |
| Users mapped | **Mappings** → **User Mappings** | Assignee and reporter mappings exist, or the field is intentionally left `unassigned`. Unmapped users never become arbitrary vendor accounts. |
| No existing counterparts | **Sync Activity** → **Initial Sync Backfill** → **Preview Scope**, plus a vendor-side Jira search | **Preview Scope** reports `Already mapped` only for pairs this connector recorded. For issues that already exist at the vendor from an earlier manual process, compare a source JQL export against the vendor project (summary, source reference, created window). The connector does not adopt pre-existing pairs. |

Snapshot the agreed configuration with **Configuration** → **Import / Export
Settings** → **Export Settings**. The export is secret-redacted; keep the file
with the pilot record, not in the repository.

## 2. Safe organization configuration

1. **One vendor, one organization.** Add exactly one organization for the
   vendor site. Mappings, ledgers, leases and recovery state are
   organization-scoped.
2. **Direction:** in the organization **Edit** dialog, select **One-Way (Push
   Only)**. Push mode never processes vendor events, so no system webhook or
   signing secret is needed.
3. **Project Filter:** in **Configuration** → **Project Filter**, select only the
   pilot projects and click **Save Project Filter**. An organization with no
   allowed project is blocked rather than treated as all projects.
4. **JQL Filter (optional):** in the **Edit** dialog, narrow to the pilot issues.
   Stay under 500 characters and avoid relative dates. The filter is
   re-evaluated at execution time for creates, updates, comments, links,
   attachments and transitions, and it is checksum-bound for an approved initial
   sync.
5. **Sync Options:** leave `Synchronize attachments`,
   `Propagate attachment deletions`, `Automatically recreate a confirmed
   deleted counterpart` and the legacy `Recreate Deleted Issues` unchecked.
   Decide `Sync Comments` (section 3), `Sync Issue Links` (both endpoints must
   be selected; links wait until both issues are mapped) and
   `Add Cross-Reference in Description` (writes a connector-owned marker into
   vendor descriptions). Click **Save Sync Options**.
6. **No historical backfill.** Do not approve or start an initial sync during
   configuration. Leave **Recurring Source Reconciliation** disabled
   (`Enable recurring local-to-remote source reconciliation` unchecked): it is
   the only background path that creates vendor issues for unmapped in-scope
   sources without an operator action. The legacy scheduled sync is update-only
   for already-mapped pairs and stays skipped unless its stored configuration is
   explicitly enabled; it cannot backfill.
7. **No automatic replacement.** Replacement is opt-in only and is not enabled
   for the pilot. **End Sync** never deletes a Jira issue.
8. **No attachment deletion propagation.** Off by default and left off; vendor
   attachments created by the pilot remain unless a Jira administrator removes
   them manually.
9. Save the organization with **Save Changes** in the **Edit** dialog, then
   re-read **Configuration** and confirm direction, target project, project count
   and sync options match the signed-off plan before any write.

## 3. Comment confidentiality

Confidentiality is enforced per comment, not per issue. A source comment that a
reviewer can read is not automatically safe to disclose to another Jira site.

- The connector never maps groups or roles between sites. Any explicit
  `visibility` restriction, malformed metadata or conflicting internal signal
  rejects the whole comment rather than copying a filtered version.
- Every known ancestor must independently pass the same policy, up to eight
  comments including the reply. Restricted or unparseable threads are rejected
  whole, and nothing about a rejected thread is copied.
- JSM comments require explicit public evidence; unknown project types fail
  closed.
- Copied comments carry a `[Comment from <site> - User: <name>]:` header and are
  visible under normal vendor project permissions.
- Verification happens immediately before submission but is not atomic. A
  restriction added between verification and submission can still be copied,
  and later restrictions are neither detected nor propagated. Earlier copies are
  never retracted, edited or deleted automatically; remediation is manual and
  requires administrator approval.

Pilot starting configuration — comments OFF:

1. **Configuration** → **Sync Options** → clear `Sync Comments` → **Save Sync
   Options**. The default is On, so this must be an explicit change.
2. Confirm the setting persisted by reloading the Configuration tab before the
   first synchronization.
3. Treat every existing vendor comment as already disclosed. Turning comments
   off prevents new copies only.
4. Re-enable only after written acceptance that the vendor audience may read
   ordinary, unrestricted source comments. Comments off does not reduce field,
   link or attachment synchronization.
5. Never put tokens, credentials, internal URLs or customer data into issue
   comments; copies are ordinary Jira content and cannot be redacted afterwards.

## 4. Source-owned fields

The source issue is authoritative for the fields the connector writes. On the
next source-side change those values are re-applied to the mapped vendor issue.

| Field group | Behavior | Pilot implication |
| --- | --- | --- |
| Summary, description, priority, labels, due date, estimates | Pushed on create and update. | Vendor-side edits are overwritten at the next source update. Agree this before the pilot. |
| Components, fix versions, affects versions | Pushed by name; an empty source value clears the vendor value. | Create the same component and version names in the vendor project first; a missing target name fails the write. |
| Mapped custom fields | Only mapped fields copy. | Read-only or rejected vendor fields appear as learned rejections; clean them up instead of expecting a retry. |
| Assignee, reporter | Translated through user mappings only. | Unmapped users are skipped or `unassigned`; no vendor account is created, invited or matched automatically. |
| Status | Source status maps to a vendor status through an existing workflow transition. | Vendor-side status changes are overwritten when the source status changes. A missing transition fails the operation and is not worked around. |
| Cross-reference | A connector-owned marker in the description. | Do not delete it manually; it is part of the mapping evidence on the vendor side. |
| Links, comments, attachments | Written only when the matching option is on and scope allows. | Their visibility, authorship and deletion rules follow sections 2 and 3, not vendor editing. |

Vendor-only fields and vendor-only workflows are not read in push mode and are
not modified. Nothing in the connector clones screens, fields, statuses or
workflows.

## 5. Attended first synchronization

1. **Check the write control.** **Sync Activity** → **Synchronization Write
   Control** shows `Write Status`, `Paused At`, `Paused By` and `Reason Code`.
   Keep writes paused while configuring; reads, configuration, diagnostics and
   exports stay available.
2. **Freeze the configuration.** Confirm sections 2 to 4 are saved and recorded
   in the pilot log. Any later change to scope, credentials, target project,
   mappings or options invalidates an approved preview.
3. **Open a short attended window.** Click **Resume Synchronization** and confirm;
   resume does not replay, backfill or start anything by itself.
4. **Start one entry point immediately**, attended:
   - **Initial Sync Backfill** (**Sync Activity**): **Preview Scope**, review the
     classification lists, tick `I approve this exact previewed scope…`, then
     **Start Approved Initial Sync**. The job is bound to the preview checksum
     and runs in bounded batches with a per-issue lease and create ledger.
     **Preview Scope** is disabled while a job is running or paused, and
     **Start Approved Initial Sync** is hidden when nothing is eligible.
   - **Manual Sync** (**Sync Activity** → **Background Maintenance**):
     `Sync Now` on one key. This force-creates when the issue is unmapped and
     force-updates when it is mapped, so use it only for a key whose create
     ledger is clean (section 7).
5. **Watch progress.** Persistent Job Progress shows processed/total, last
   confirmed key, and created, already mapped, skipped, conflicts,
   reconciliation required, failed and cancelled counters. At the first failure
   or conflict, use **Pause** on the panel and **Pause Synchronization**
   globally instead of continuing the batch.
6. **Verify by hand.** Open two or three created vendor issues: exact key,
   summary, description, components/versions, assignee, cross-reference marker
   and comment visibility (if comments were enabled). Compare with the source.
7. **Close the window.** Click **Pause Synchronization** at the end of the
   attended window, unless the pilot plan records that writes stay **ACTIVE**
   (see *Write states during the pilot*), and record the start, resume and pause
   times.


### Pause and rollback

- **Pause:** **Synchronization Write Control** → **Pause Synchronization** →
  confirm **Pause Synchronization** in the dialog. The fixed reason code
  `emergency_stop` and the acting account are stored. Issue, comment,
  attachment, link and transition writes in both directions are blocked
  immediately; reads remain available. Inbound events that arrive while paused
  are acknowledged and discarded, not queued for replay.
- **Pause the backfill separately:** on the **Initial Sync Backfill** panel,
  **Pause** preserves the cursor, **Resume** continues it, and **Cancel** stops
  new work without reversing completed Jira writes. A backfill job paused by the
  global control stays paused until it is resumed on its own panel.
- **Resume:** **Resume Synchronization**. It does not queue, replay, backfill,
  recreate or bulk sync anything, and it does not start an initial sync.
- **Rollback is not the emergency stop.** Do not deploy an older version while
  write blocking is required: older builds do not read the pause record and can
  resume writes with the pause still stored. Keep the pause-capable version
  deployed for the whole incident.
- **Undoing vendor content** is a separate, explicitly approved manual Jira
  operation. No recovery action deletes an issue, and **End Sync** only removes
  the mapping pair and keeps an ending record.

## 6. Daily read-only coverage check

Run this once per business day; it takes a few minutes and writes nothing.

1. Open **Sync Activity** and confirm the selected organization, direction and
   `Write Status` are the expected ones.
2. In **Initial Sync Backfill**, click **Preview Scope**. The preview is
   read-only, lists issue keys only, and is disabled while a job is running or
   paused — run the check when the panel is idle.
3. Record the date, counts, eligible keys and preview checksum. The preview covers
   the whole configured scope, so keep the JQL narrow enough that the list is
   readable:
   - `Eligible` — in-scope issues with no connector mapping. Once real-time
     synchronization is healthy this should stay at or near zero; a persistent or
     growing list means creates are not happening.
   - `Already mapped` — pairs the connector recorded. It must keep pace with
     in-scope issue creation.
   - `Blocked by validation` — read the key list and correct issue-type, field,
     parent, status or scope causes before they accumulate.
   - `Mapping conflicts` — a stop condition (section 8).
4. Also read the **Persistent Job Progress** counters when a job record exists
   (`Reconciliation required`, `Failed`, `Conflicts`) and compare them with the
   previous day.
5. Do **not** tick the approval checkbox and do **not** click **Start Approved
   Initial Sync** during a coverage check.
6. Spot-check two mapped keys with **Diagnostics** → **Check Mapping** and
   **Verify Sync**. Both are read-only.

### Manual recovery for missed creates

1. Work through [Troubleshooting](TROUBLESHOOTING.md) "No issue was created" in
   order: global pause, project allow-list, JQL, direction, existing mapping,
   issue-type/project mapping, parent hierarchy, counterpart status, ledger,
   credentials and permissions.
2. Look up the create ledger before retrying (section 7). `No create operation
   recorded` with an unmapped source means no create was attempted.
3. Fix the configuration cause, then recover the smallest unit possible: one
   `Sync Now` key at a time, or a newly previewed and approved initial sync for
   the remaining eligible set. Re-preview after every configuration change.
4. Never use repeated **Manual Sync** calls to resolve an ambiguous outcome, and
   never delete ledger or mapping records to make an issue look unmapped.

## 7. Ambiguous issue create recovery

Use this when a create was submitted without a confirmed outcome: a
`create_outcome_unknown` initial-sync outcome, a non-zero `Reconciliation
required` counter, or an in-scope source issue with no mapping after a create
attempt.

1. **Pause first** if another create for the same source could duplicate the
   issue (**Synchronization Write Control** → **Pause Synchronization**).
2. Open **Recovery** → **Ambiguous Issue Create Recovery** (it sits above
   **Deleted Counterpart Recovery**).
3. Set **Direction** to `Local → remote (local issue was created remotely)`
   for a push organization.
4. Enter the **Source issue key** and click **Look up create ledger**. The lookup
   reads the persisted ledger and changes nothing.
5. Read every field before acting:
   - **Operation state** — displayed as `Outcome unknown`, `Succeeded`,
     `Pending` or `Rejected`.
   - **Create submission marker** — `Present` or `Absent`. `Absent` is **not**
     proof that no request was sent: recording an unknown outcome clears the
     submission timestamp.
   - **Recorded destination key** — a claim by the ledger, not verification.
   - **Source mapping** — `Mapped to <key>` or `Not mapped`.
   - **Reconciliation applicable** and the reason text.
6. **Find the candidate issue in the vendor project directly** (project, summary,
   source reference, created window). Open the issue itself; do not trust a
   search snippet.
7. **Verify the destination key explicitly:**
   - the exact key of the issue you opened, copied from that issue;
   - it belongs to the project this source project routes to (`Target Project
     Key` or **Project Mappings**);
   - its summary, description, reporter and creation time match the source;
   - no second vendor issue is an equally plausible match — if two candidates
     exist, stop and escalate;
   - it is not already paired with a different source issue.
8. If **Reconciliation applicable** is `Yes`: enter the key in **Destination
   issue key (must be entered or confirmed explicitly)**, tick `I verified this
   destination issue directly in Jira and understand that reconciliation only
   repairs the mapping.`, click **Reconcile mapping for this create**, then
   confirm **Repair the create mapping?**.
   The server re-checks the destination (readable, in the resolved target
   project) and both mapping directions before writing; `MAPPING_CONFLICT`,
   `TARGET_PROJECT_MISMATCH`, `TARGET_ISSUE_NOT_FOUND` or
   `CREATE_TARGET_MISMATCH` leave everything unchanged.
   Reconciliation only repairs the mapping. It never creates, updates or deletes
   a Jira issue and never retries the create.
9. If **Reconciliation applicable** is `No`, follow the reason text:
   - `CREATE_IN_PROGRESS` — wait; a stale attempt becomes an unknown outcome.
   - `CREATE_SUCCEEDED_MAPPING_MISSING` — confirm the recorded key, then repair
     the mapping as in step 8.
   - `CREATE_ALREADY_RECONCILED` — nothing to do.
   - `CREATE_RETRY_ALLOWED` — the create was rejected; retry the
     synchronization instead of reconciling.
   - `CREATE_OPERATION_NOT_FOUND` — the pair predates the ledger; do not
     reconcile and do not edit storage. Escalate before adopting or ending it.
   - `CREATE_STATE_INVALID` — stop and report the key.
10. If the issue does not exist, do not reconcile and do not invent a key. Fix
    the cause and retry only when the ledger shows a rejected create
    (`CREATE_RETRY_ALLOWED`), then look the ledger up again.
11. After repair, run **Diagnostics** → **Check Mapping** on the source key,
    confirm both directions, resume synchronization, and record the time,
    operator, source key and verified destination key in the pilot log.

Never reconcile a guessed key, retype a key without reopening the issue, retry an
unknown outcome with **Manual Sync**, or clear ledger and mapping records to get
past a stop.

## 8. Stop conditions and unsupported behavior

Pause synchronization and escalate to the pilot owner when any of these occurs:

- any ambiguous create, a second create attempt for the same source issue, or a
  `Reconciliation required` count above zero;
- **Reconciliation is not available** for a state you cannot explain, a ledger
  lookup error, or a conflict/mismatch returned by reconciliation;
- `Mapping conflicts` in a preview, a reversed or incomplete pair, or an issue
  reported as mapped to the wrong key;
- a vendor issue created for an out-of-scope source, a duplicate vendor issue, or
  a write to the wrong project;
- any restricted or internal comment appears at the vendor, or a comment is
  copied after a restriction was added — treat it as disclosed until proven
  otherwise;
- attachment counts change unexpectedly, in either direction;
- **Test** fails, the vendor account loses create/edit/comment/transition
  permission, or Jira returns repeated 401/403/429/5xx;
- `Write Status` cannot be confirmed, the admin page shows an error while
  reading, or a resolver returns `Jira administrator permission required`.

Intentionally unsupported during the pilot — do not expect these, and do not work
around them with storage edits:

- two-way synchronization or any processing of vendor events while direction is
  **One-Way (Push Only)**;
- creating, matching, inviting or deactivating vendor users; mapping groups or
  roles between sites;
- creating issue types, fields, statuses, screens or workflows at the vendor, or
  transitions the vendor workflow does not expose;
- deleting or merging issues in either site, on any recovery path;
- automatic counterpart replacement (`Automatically recreate a confirmed deleted
  counterpart` stays off; the legacy `Recreate Deleted Issues` does not enable
  it);
- automatic backfill on resume, replay of events discarded while paused, and
  exact-minute scheduling guarantees;
- adopting issues that already exist at the vendor without a connector mapping
  (no key, summary or attachment matching);
- attachment deletion propagation and attachment malware scanning;
- retracting, editing or restricting comments already copied to the vendor;
- attachments above the lower Jira or connector size limit;
- manual edits to ledger, mapping, lease or pause records — there is no supported
  UI for that, and `CREATE_OPERATION_NOT_FOUND` pairs cannot be repaired through
  the recovery panel.

## Admin page map

| Task | Path in the deployed admin page |
| --- | --- |
| Pause or resume all writes | **Sync Activity** → **Synchronization Write Control** → **Pause Synchronization** / **Resume Synchronization** |
| Test vendor credentials | Organization header → **Test** |
| Edit scope and options | Organization header → **Edit** (**Target Project Key**, **JQL Filter**, **Direction**); **Configuration** → **Sync Options**, **Project Filter** |
| Edit mappings | **Mappings** → **User Mappings**, **Field Mappings**, **Status Mappings**, **Issue Type Mappings**, **Project Mappings** |
| Read-only coverage preview | **Sync Activity** → **Initial Sync Backfill** → **Preview Scope** |
| Approve and run a backfill | **Sync Activity** → **Initial Sync Backfill** → approval checkbox → **Start Approved Initial Sync**, then **Pause** / **Resume** / **Cancel** |
| One-key repair of a missed create | **Sync Activity** → **Background Maintenance** → **Manual Sync** → **Sync Now** |
| Ambiguous create ledger | **Recovery** → **Ambiguous Issue Create Recovery** |
| Deleted or unavailable counterpart | **Recovery** → **Deleted Counterpart Recovery** (Probe, Recreate Counterpart, Remap, End Sync, Mark Resolved) |
| Mapping and sync verification | **Diagnostics** → **Check Mapping**, **Verify Sync** |
| Configuration snapshot | **Configuration** → **Import / Export Settings** → **Export Settings** |

