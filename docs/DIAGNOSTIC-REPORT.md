# Diagnostic Report Export

The Diagnostics page can generate a customer-shareable JSON report from evidence
that SyncApp already retains. Generation is explicit: no report is created on page
load, and the server resolver performs only storage reads. It makes no Jira
request, starts no synchronization or recovery action, and writes no report file
to Forge storage.

## Schema

```text
schema:        syncapp.diagnostic-report
schemaVersion: 1
generatedAt:   ISO-8601 timestamp
```

The report is scoped to exactly one explicitly selected organization. It contains
`diagnosticStatus` (`ok`, `warning` or `error`) and a sorted list of stable
`statusCodes` such as `PAUSE_ACTIVE`, `SYNC_AUTHORIZATION_MISSING`,
`DIAGNOSTIC_TELEMETRY_NOT_RECORDED` or `DIAGNOSTIC_MAPPINGS_TRUNCATED`.

## Included evidence

- Installation application version, environment type, hashed installation
  identity and cloud-context count.
- Organization name/id, synchronization direction, remote hostname, remote project
  key, allowed project keys, JQL presence/length/digest, credential and webhook
  presence.
- Stored Synchronization options and scheduled-job configuration.
- Project, user, field, status and issue-type mapping counts.
- Current Emergency Pause state and Sync Authorization status.
- Bounded mapping-count scans, including repair-record count.
- Issue-create ledger counts by state and direction, with the latest retained
  update timestamp.
- Per-organization webhook activity and installation-wide scheduled-job activity.
- Bounded webhook and scheduled error samples using stable codes, operations,
  timestamps, status codes and reason codes only.
- Recorded API call/rate-limit totals, selected-organization counts, categorized
  endpoint counts and bounded hourly history. No success percentage or remaining
  quota is calculated.
- Pairing-witness plan state counts and recovery-attention state/reason counts.
- Bounded, relevant maintenance audit samples.

Every section has `available: true` or an explicit `available: false` with a code.
Missing records are not converted into zeroes, success rates or invented history.

## Sanitization boundary

The report is assembled field-by-field; raw stored records are never spread into
the output. It excludes:

- API tokens, webhook signing secrets, Authorization headers and arbitrary secret
  fields.
- Email addresses, account IDs, authenticated-user identities and actor IDs.
- Jira issue keys, issue IDs, summaries, descriptions, comments, attachment
  content, raw webhook payloads, snapshots and full issue records.
- Raw JQL. Only presence, length and a SHA-256 digest are included.
- Raw mapping targets, ledger source/target keys, pair IDs and permit IDs.
- Forge quota estimates and success percentages that were not recorded.

Names, hostnames, project keys and operational codes are retained because they are
needed for support correlation. Sanitization reduces secrets and content exposure
but does not make the report non-sensitive. Review the preview before external
sharing and use only the approved customer-support channel.

## Bounds

- At most 10 error samples, 10 maintenance-audit samples and 6 hourly rate-limit
  history points.
- At most 20 allowed project keys.
- Mapping scans are capped at 1,000 records per prefix; ledger scans at 500.
- The serialized report is capped at 64 KiB. If optional samples must be dropped,
  `truncated` is set and `DIAGNOSTIC_REPORT_TRUNCATED` is reported.

## Limitations

The report is retained-evidence, not a complete synchronization ledger. It does
not evaluate Jira visibility, propagate edits/deletes, predict future activity or
certify that existing destination content is safe. Missing telemetry remains
explicitly unavailable.
