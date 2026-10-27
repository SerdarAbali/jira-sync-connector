# Jira Sync Connector v2.2.0

Released 2026-10-27.

## Highlights

- Redesigned administration into seven sections: Overview, Organizations, Analytics, Activity, Diagnostics, Recovery, and About & Security, with horizontal navigation, a compact organization selector, and responsive layouts.
- Consolidated organization configuration, connections, mappings, and Guided Setup while preserving validation, confirmations, disabled states, and administrator permissions. Organization switching clears pending forms, approvals, and previews.
- Improved operational summaries and Analytics with recorded synchronization counters, hourly API activity, and rate-limit observations. Missing history and actual remaining Atlassian capacity are explicitly unavailable.
- Added read-only recovery snapshot export and restore preview, plus pairing-witness inspection and separately approved, bounded witness migration tooling.
- Added maintenance-write audit records, bounded audit retention, and clearer installation-wide Emergency Pause and Sync Authorization controls. Opening a dashboard page does not start a write operation.
- Expanded regression coverage for administration, source selection, authorization, recovery, and synchronization safety.

## Scope and limitations

- Pairing-witness inspection and migration do not implement automatic witness-based duplicate prevention.
- Snapshot restore preview does not implement full snapshot restoration. Diagnostic-report export is not implemented.
- Existing synchronization reliability and concurrency limitations remain documented in the [engineering safety framework](https://github.com/SerdarAbali/jira-sync-connector/blob/v2.2.0/docs/ENGINEERING_SAFETY.md); this release does not certify all synchronization paths or activate maintenance or synchronization authorization.
- Existing dependency audit advisories remain; dependencies are unchanged. See validation below.
- Application version 2.2.0 is separate from Forge environment deployment versions. This GitHub release does not deploy to any Forge environment.

## Validation

- 94 Jest suites / 2,025 tests passed under Node 22.
- ESLint, secret scan, repository neutrality, offline Forge validation, and authenticated Forge lint passed.
- Admin production build and release whitespace checks passed.
- Root production dependency audit failed its gate with one high advisory (`undici`) and one moderate advisory (`fast-uri`). The admin production audit passed its high-severity threshold but reports one moderate advisory (`yaml`). These pre-existing findings are not fixed by this release.
- The preceding dashboard baseline was verified in STAGING 3.23.0. No Forge deployment or Jira/Forge data operation is part of this release.
