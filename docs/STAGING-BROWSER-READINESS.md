# Authenticated staging browser readiness

## Acceptance

- The adapter owns a private local browser session; it accepts no browser, page,
  callback, endpoint, profile path or readiness facts from the caller.
- Navigate to the exact installed staging admin page, wait for its real Custom
  UI iframe to finish navigating, then invoke only the deployed read-only
  `window.__syncConnectorReadinessInvoke()` handle.
- Bind the app, environment, installation and site to the fixed staging target
  and recheck them against the run configuration. Fail closed on any mismatch,
  unavailable login, missing iframe, missing handle or unsuccessful invocation.
- Only immutable facts issued in-process by browser acquisition establish
  authentication. Normalization, binding, JSON files and copied objects cannot
  authenticate facts. No public sealing function exists.
- Preserve write confirmation, host/project restrictions, Jira permissions,
  Pause, version-1 retirement/drain, version-2 initialization and webhook checks.

## Running

On this local macOS host, install repository development dependencies and run:

```sh
npm run staging:e2e:dry-run -- --env-file .env.staging
```

The adapter starts or reuses only its dedicated private browser profile. If login
is needed, sign in as the Jira administrator for serdarjiraone.atlassian.net in
that window. The existing regular browser profile is not read or copied. The
automation window stays open after the command disconnects, including failures.
An initial login may wait up to ten minutes; missing invocation capability fails
closed. The current executable is the installed browser on this macOS host;
other hosts without that executable fail closed.

The fixed target is app 362d8e6b-b68c-4403-8020-d32ddcc02716, STAGING environment
2e8c0cb5-881a-4345-b9ba-e887f790d316, installation
974910c5-2861-4d40-a7eb-37802842d0a0, site serdarjiraone.atlassian.net. The iframe
must use HTTPS on the platform CDN with the same app/environment and admin-ui
resource path. Both iframe and top-level URL are rechecked after invocation.

## Session privacy and trust

Browser cookies remain in a fixed owner-only temporary profile outside the
repository. The independent browser exposes its automation transport only on a
random loopback port; the endpoint is read only from that private profile and is
never accepted as input or logged. This trusts the local operating-system user,
installed browser, pinned browser library and repository code. It is not designed
to resist malicious code already running as the same user.

The adapter exports no cookies, authentication snapshots, screenshots, headers,
session endpoints or tokens into reports or Git. Reports contain normalized
connector facts and sanitized failure codes. Browser windows remain open until
the operator closes them. No browser or Forge deployment is required by the
adapter itself.

## Validation and limits

Focused regressions exercise browser ownership, frame-navigation races,
authentication failures, identity mismatches, immutable acquisition identity,
copy/JSON/page forgery rejection and F07 validation. Offline browser transport
models do not prove live authentication. The read-only command was also run
against the actual installed staging iframe; it authenticated the exact target,
observed Pause false, F07 absent and no mappings, and correctly remained BLOCKED
with zero attempted mutations.

The session and frame operations use the documented
[browser connection contract](https://playwright.dev/docs/api/class-browsertype)
and [frame APIs](https://playwright.dev/docs/frames).
