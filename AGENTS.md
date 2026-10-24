# Engineering requirements

Use [the engineering safety invariants and acceptance process](docs/ENGINEERING_SAFETY.md)
for scoped changes. Official Atlassian Jira Cloud and Forge contracts govern
integration behavior; cite the relevant endpoint, storage and SDK contract.

- For a verified defect, reproduce it and add a failing regression against
  production code before correcting it. For a requirement, define acceptance
  criteria first. Cover relevant alternate entry points, failures, retries,
  delayed work and concurrent behavior.
- Do not replace failed verification with invented mock assumptions. Investigate
  the contract, retain failure evidence and report unavailable verification.
- Independently verify security-sensitive changes: trace production callers and
  transport/storage boundaries, challenge the assumptions and exercise negative
  controls beyond the implementation's own happy path. Record evidence and limits.
- Preserve supported behavior and existing safety controls. Distinguish a
  demonstrated release blocker from a documented limitation; track unrelated
  findings separately and stop when the defined acceptance criteria pass.
- Run deterministic CI checks and report results. Local checks do not establish
  live Jira/Forge behavior or Marketplace compliance.
- No automatic deployments, migrations, destructive Git operations, changes to
  main, tags or release configuration. Keep migration activation separately gated.
- Keep source and documentation tool-neutral: no vendor or product branding for
  development tools, authorship attribution, transcripts or internal instruction
  discussions. Permitted filenames do not exempt their contents. Dependency
  metadata and generated assets are outside the text gate; do not use them to
  store authored prose. Run `npm run check:neutrality` before review and
  `npm run check:neutrality -- --staged` before committing.
