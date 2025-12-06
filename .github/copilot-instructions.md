# Copilot Instructions for Jira Sync Connector

> **Forge Reference**: For Forge platform APIs, up to date information, manifest options, and storage limits, see https://developer.atlassian.com/platform/forge/

## Project Overview
Atlassian Forge app for one-way issue sync between two Jira Cloud orgs. Real-time webhooks (1-3s) + hourly scheduled backup sync. Multi-org support with per-org mappings stored in Forge Storage.

## Forge Platform Limits (Verified)
| Limit | Value |
|-------|-------|
| Value size | 240 KiB per key |
| Key length | 500 characters |
| Function timeout | 25s (triggers), 55s (web triggers), 900s (async events/scheduled with `timeoutSeconds`) |
| Memory | 1024 MB per invocation |
| Transactions | `@forge/kvs` only, max 25 ops, set/delete only |
| Query API | `beginsWith` filter on keys only, max 100 results |

## Architecture

### Entry Point & Module Structure
- `src/index.js` - Pure exports mapping to `manifest.yml` function handlers
- `src/triggers/` - Webhook handlers (issue, comment, link events)
- `src/resolvers/` - Admin UI API (`@forge/resolver` pattern)
- `src/services/sync/` - Core sync logic (issue, comment, attachment, link, transition)
- `src/services/storage/` - Forge Storage wrappers using `@forge/kvs` (mappings, flags, stats, kvs)
- `src/services/jira/` - API clients (local=`@forge/api`, remote=fetch with Basic Auth)

### Storage Layer (`@forge/kvs`)
All storage operations go through `src/services/storage/kvs.js` wrapper:
```javascript
import * as kvsStore from './kvs.js';

// Basic operations
await kvsStore.get(key);        // Returns null on KEY_NOT_FOUND
await kvsStore.set(key, value);
await kvsStore.del(key);

// Secrets
await kvsStore.getSecret(key);
await kvsStore.setSecret(key, value);

// Query by key prefix (replaces index arrays)
const results = await kvsStore.queryByPrefix('mapping-meta:org-123:', 1000);

// Transactions (atomic, max 25 ops)
await kvsStore.transaction()
  .set('key1', 'value1')
  .set('key2', 'value2')
  .delete('key3')
  .execute();
```

### Data Flow
1. Trigger fires → `triggers/*.js` validates & delegates to `services/sync/`
2. Sync services use `local-client.js` (source Jira via `@forge/api`) and `remote-client.js` (target via `fetch` + Basic Auth)
3. Issue key mappings stored as `{orgId}:local-to-remote:{key}` / `{orgId}:remote-to-local:{key}`
4. Pending links queued in `pending-links:{issueKey}` until both issues exist

### Key Patterns

**Multi-org storage namespacing:**
```javascript
// All per-org data uses orgId prefix
const key = orgId ? `${orgId}:local-to-remote:${localKey}` : `local-to-remote:${localKey}`;
```

**Sync flag to prevent loops:**
```javascript
await markSyncing(issueKey);  // TTL-based flag in storage
try { /* sync */ } finally { await clearSyncFlag(issueKey); }
```

**Retry with exponential backoff:**
```javascript
await retryWithBackoff(async () => fetch(...), 'operation name', MAX_RETRY_ATTEMPTS);
```

**ADF (Atlassian Document Format):** Use `src/utils/adf.js` for text↔ADF conversion, media ID replacement.

## Development Commands

```bash
npm install --legacy-peer-deps  # Required due to @forge/api peer deps
forge deploy                     # Deploy to Forge
forge logs                       # View recent logs
forge logs -s 5m                 # View logs from last 5 minutes
cd static/admin-page && npm run build  # Rebuild React admin UI
```

## Legacy Migration Support

The codebase supports both multi-org and legacy single-org configurations. When `org.id === 'legacy'`, the code falls back to non-namespaced storage keys:

```javascript
// Multi-org (current)
storage.get(`userMappings:${org.id}`)
storage.get(`${orgId}:local-to-remote:${localKey}`)

// Legacy fallback
storage.get('userMappings')
storage.get(`local-to-remote:${localKey}`)
```

Key migration points in `resolvers/sync.js` and `services/scheduled/scheduled-sync.js` check for legacy config when no organizations exist. When adding new per-org features, always include the legacy fallback pattern.

## Rate Limiting & 429 Handling

The app uses exponential backoff with special handling for Jira's rate limits:

```javascript
// From utils/retry.js
if (result.status === 429) {
  await sleep(RATE_LIMIT_RETRY_DELAY_MS);  // 60 seconds
  continue;  // Don't count as retry attempt
}
// Regular errors use exponential backoff: 1s → 2s → 4s (capped at 30s)
```

Tunable constants in `constants.js`:
- `RATE_LIMIT_RETRY_DELAY_MS` (60000) - Wait time after 429
- `RETRY_BASE_DELAY_MS` (1000) - Initial backoff delay
- `MAX_RETRY_ATTEMPTS` (3) - Retries before failing
- `BATCH_SIZE` (10) / `BATCH_DELAY_MS` (5000) - Scheduled sync pacing

## Code Conventions

### Storage Keys
All storage uses `@forge/kvs` via wrapper. Key patterns:
- `organizations` - Array of org configs
- `syncOptions:{orgId}` - Feature toggles
- `userMappings:{orgId}`, `fieldMappings:{orgId}`, `statusMappings:{orgId}`
- `mapping-meta:{orgId}:{localKey}` - Issue mapping metadata (queryable by prefix)
- `pending-link-idx:{issueKey}` - Pending link index entries (queryable)
- API tokens stored as secrets: `secret:{orgId}:token`

### Logging
Use emojis from `constants.js::LOG_EMOJI` for consistent log parsing:
```javascript
console.log(`${LOG_EMOJI.SUCCESS} Created ${remoteKey}`);  // ✅
console.log(`${LOG_EMOJI.ERROR} Failed: ${error.message}`);  // ❌
```

### Error Handling
- `retryWithBackoff()` handles transient errors, rate limits (429), with exponential backoff
- Non-retryable 4xx errors thrown immediately
- Always return `{ success: boolean, error?: string }` from resolvers
- **Always check `response.ok` before calling `.json()`** on API responses

### Admin UI
- React + Atlaskit components in `static/admin-page/src/`
- Communicates via `@forge/bridge::invoke('resolverName', payload)`
- Protected resolvers listed in `resolvers/index.js::protectedResolvers`
- `App.jsx` is intentionally monolithic (~2500 lines); extract components to `components/` when reusing UI patterns

## Testing & Debugging

1. Deploy with `forge deploy` and test against real Jira instances
2. Check `forge logs` for emoji-prefixed entries
3. Manual sync: Admin UI → Sync Activity → Quick Actions → Manual Sync
4. Retry pending links: resolvers expose `retryPendingLinks` action

## Common Modification Points

| Task | Files |
|------|-------|
| Add new synced field | `services/sync/issue-sync.js` (buildUpdatePayload) |
| New webhook event | `manifest.yml` + new `triggers/*.js` |
| Storage schema change | `services/storage/mappings.js`, `services/storage/kvs.js` |
| Admin UI feature | `static/admin-page/src/App.jsx` + resolver in `resolvers/*.js` |
| Rate limit tuning | `constants.js` (RETRY_*, BATCH_*) |

## Documentation & UI Guidelines

- **No Hype Language**: Avoid marketing fluff like "First in the world", "Best", "Revolutionary". Use objective, technical language (e.g., "Zero Data Egress", "Native Forge Architecture").
- **No Emojis in UI**: Do not use emojis in the Admin UI or user-facing documentation. Keep the interface professional and clean. (Note: Emojis in server-side logs are permitted for parsing).
- **Professional Tone**: Use "This app" or passive voice instead of "We".
