# Installation

## Prerequisites

- Node.js 22.x. Forge CLI 14.x supports Node.js 22 and 24; use 22 to match the app runtime.
- Atlassian Forge CLI 14.x.
- A local Jira Cloud site with permission to install Forge apps and administer Jira.
- A remote Jira Cloud site and an administrator API token.
- Network access from Forge to `*.atlassian.net`, as declared in `manifest.yml`.

The repository is private in `package.json`; this is an application source repository, not an npm package.

## Build from source

From the repository root:

```bash
node --version
npm ci
npm test -- --runInBand
npm run lint
npm audit --omit=dev
npm run check:secrets
npm run check:forge:offline
cd static/admin-page
npm ci
npm run build
cd ../..
```

The admin UI build is required before deploying. Do not commit `static/admin-page/build` output.

## Authenticate the Forge CLI

```bash
forge login
forge whoami
```

For headless automation, provide `FORGE_EMAIL` and `FORGE_API_TOKEN` from a secure secret store. Do not commit credentials, callback URLs containing secrets, or local environment files.

`npm run check:forge` runs the full `forge lint`, which requires an authenticated session. `npm run check:forge:offline` runs the same Forge lint package's client-side rules without a login; CI uses that deterministic check and does not receive Atlassian credentials. A non-interactive runner must set the CLI analytics preference once:

```bash
forge settings set usage-analytics false
```

This removes the analytics prompt; it does not replace authentication.

## Deploy and install

Deploy to the development environment:

```bash
forge deploy --environment development
```

Install on the local Jira site:

```bash
forge install --site https://your-site.atlassian.net --product jira --environment development
```

For a production environment, use the environment approved by the site administrator:

```bash
forge deploy --environment production
forge install --site https://your-site.atlassian.net --product jira --environment production
```

The app is installed only on the local site. Do not install it on remote sites unless a separate local installation is intentionally being created.

## First-time setup

1. Open **Jira Settings > Apps > Sync Connector**.
2. Start the guided setup wizard.
3. Add the remote connection details:
   - display name
   - remote Jira URL, normally `https://<site>.atlassian.net`
   - remote administrator email
   - remote API token, which is stored write-only
   - target remote project key
4. Select at least one allowed local project.
5. Optionally add a JQL filter. The filter is combined with the project allow-list.
6. Select **Push** or **Bidirectional**.
7. Load and save user, field, status, issue-type, and project mappings.
8. Choose comments, links, attachments, and replacement behavior.
9. Complete communication preflight.
10. Preview the initial synchronization, review classifications, and approve it only after the counts and reason codes are understood.
11. Activate the organization and monitor **Sync Activity**.

## Bidirectional remote webhook

A bidirectional target requires a Jira System Webhook on the remote Jira site:

- URL: the complete callback URL shown by SyncApp, in the form
  `<forge-webtrigger-url>/<orgId>/<credential>`
- Events: issue created, issue updated, issue deleted, comment created,
  issue-link created, issue-link deleted, attachment created, attachment deleted
- JQL: restrict the webhook to the remote projects that should send events

Native Jira System Webhooks do not support custom authentication headers, so the opaque credential is carried in the Forge web-trigger path. Query-string secrets are rejected. Use **Rotate Webhook Secret** to obtain a new complete callback URL; the previous URL stops working immediately.

Configure only the events supported by the version shown in `manifest.yml`. The guided wizard's communication preflight reports authenticated webhook receipt.

## Upgrade an existing installation

A Forge deployment upgrades the existing installation in place. Forge Storage, mappings, secrets, and organization configuration are retained.

Before upgrading:

1. Review the release notes and manifest scope changes.
2. Run all repository validation gates.
3. Deploy to the development environment first.
4. Confirm the installed version becomes **Up-to-date**.
5. Check `forge logs` and the Sync Activity diagnostics.
6. Promote only after the development installation passes.

A permission expansion may require a Jira administrator to approve the updated app access. If the admin page is unavailable after an upgrade, review the Forge installation status and Jira app authorization before changing stored configuration.

## Rollback

Do not roll back an application version while the connector's global pause is the only active write control. Older versions may not understand newer pause or safety records. Follow [Operations](OPERATIONS.md#rollback-considerations) instead of rolling back during an active incident.

## Verification

After installation or upgrade:

- the displayed header version matches `package.json`
- the organization loads without a credential error
- the allowed-project list is non-empty
- communication preflight succeeds for each bidirectional target
- a controlled test issue can be previewed and synchronized
- Sync Activity shows current webhook and scheduled-path diagnostics
- no token, callback credential, or secret appears in logs or exported settings
