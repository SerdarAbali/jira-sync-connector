# Installation-specific F07 initialization

## Acceptance criteria

- Only the specified staging app, environment, installation and local site may
  initialize, through an audited ADMIN_WRITE resolver requiring Jira ADMINISTER.
- Read current identity, Pause and F07 state using the existing readiness service.
  Require readable Pause set to true and an absent marker before and after the
  existing conditional entity protocol probe. Never resume Pause.
- Historical provenance is waived by explicit engineering policy only for this
  exact disposable staging installation. This is not historical platform proof.
  No request field may alter the policy, identity restriction or stored state.
- Create the existing control key once with FAIL_IF_EXISTS; never overwrite or
  delete a competing marker. Validate readback through the production F07 reader.
  Unknown write outcomes remain unknown and must not trigger an unconditional
  retry, cleanup or automatic rollback.
- A version-2 fresh marker binds the exact installation and disposable-staging policy;
  it uses actual initialization time and no legacy retirement timestamps.
  Version-1 validation and the legacy activation operation remain unchanged.
- Regress identity, authorization, Pause, existing state, probe failure,
  concurrency, storage uncertainty, readback failure and legacy compatibility.

## Staging-only policy

The operator explicitly waived historical installation provenance for these
entirely disposable testing sites. Server-side policy disposable-staging-v1
applies only to app 362d8e6b-b68c-4403-8020-d32ddcc02716, STAGING environment
2e8c0cb5-881a-4345-b9ba-e887f790d316, installation
974910c5-2861-4d40-a7eb-37802842d0a0, site serdarjiraone.atlassian.net.
It is not evidence that historical versions or storage recovery were inspected.
Production, development and every other installation are excluded. There is no
payload override, environment switch or accepted historical-evidence assertion.

## Platform contracts

[KVS set](https://developer.atlassian.com/platform/forge/storage-reference/kvs-api/)
scopes keys to the app installation and supports keyPolicy FAIL_IF_EXISTS.
[Custom Entity transactions](https://developer.atlassian.com/platform/forge/storage-reference/entities-transactions/)
provide conditional atomic storage operations, not atomic Jira fencing.

## Remaining live actions

After a separately authorized deployment, sign in as a Jira administrator and
open the STG connector admin page on serdarjiraone.atlassian.net. Read readiness
and bind its app/environment/installation/site to the identifiers above. If
Pause is not active, explicitly use the existing Pause control and verify it;
the initializer does not change Pause.

In the browser console with the connector Custom UI iframe selected, invoke:

```js
await window.__syncConnectorInitializeFreshIssueLeases('INITIALIZE_FRESH_ISSUE_LEASES')
```

Expect status INITIALIZED, activation.performed true and paused true. Read
window.__syncConnectorReadinessInvoke() afterward and confirm f07Status.valid
and paused are true. Any unknown write outcome requires a read-only inspection;
never blindly repeat, overwrite or delete the marker. Resume remains a separate
explicit administrator action and is outside this initialization procedure.
No public endpoint is introduced. No live operation was executed in this change.
