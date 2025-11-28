# Jira Sync Connector

Atlassian Forge application for one-way synchronization between two Jira Cloud organizations.


### Major Refactoring - Modular Architecture
The codebase has been refactored from a monolithic 2,266-line file into 26 focused modules following Atlassian Forge best practices.

**Benefits:**
- Better maintainability - Each module has a single, clear responsibility
- Faster cold starts - Smaller modules load faster in Forge's serverless environment
- Easier debugging - Clear module boundaries make issues easier to trace
- Team collaboration - Multiple developers can work on different modules without conflicts
- Testability - Each module can be tested independently

**New Structure:**
```
src/
├── index.js (6 lines) - Minimal entry point
├── constants.js - Shared constants
├── utils/ (4 modules)
│   ├── adf.js - ADF conversion utilities
│   ├── mapping.js - User/field mapping helpers
│   ├── retry.js - Retry with backoff logic
│   └── validation.js - Project validation
├── services/
│   ├── storage/ (3 modules) - Mappings, flags, stats
│   ├── jira/ (2 modules) - Local & remote Jira clients
│   ├── sync/ (6 modules) - Sync orchestration
│   └── scheduled/ (1 module) - Scheduled sync logic
├── resolvers/ (6 modules) - API resolvers by category
└── triggers/ (4 modules) - Webhook handlers
```

### Critical Bug Fixes
- Fixed: Issues being incorrectly skipped - Removed faulty bidirectional sync check that was blocking legitimate one-way syncs
- Fixed: Key collision issues - Same issue keys (e.g., SCRUM-83) in both orgs no longer cause false skip conditions
- Fixed: Status/assignee changes not syncing - All field updates now sync correctly

## Features

### Core Sync Capabilities
- Dual sync strategy - Real-time webhooks + hourly scheduled bulk sync
- Issue creation & updates - Summary, description, priority, labels, due date
- Status synchronization - Configurable status mappings with transitions
- Epic/Parent relationships - Preserves hierarchy across orgs
- Comment sync - With author attribution: `[Comment from OrgName - User: Name]`
- Attachment sync - Binary file transfer with 10MB limit and duplicate prevention
- Issue Links - Syncs all link types (blocks, relates to, duplicates, etc.) with pending retry
- Components - Component sync with clearing support
- Fix Versions - Version sync with clearing support
- Affects Versions - Affected version sync with clearing support
- Time Tracking - Original estimate and remaining estimate sync
- Custom field mapping - Map custom fields (including sprints) between organizations
- User mapping - Map assignee & reporter between organizations
- Project filtering - Selectively sync specific projects/spaces via admin UI
- Infinite loop prevention - Safe one-way architecture with proper sync detection

### Admin Interface
- Collapsible UI sections - Clean, organized configuration
- Live data loading - Fetch users, fields, statuses, projects from both orgs
- Visual mapping management - Add/delete mappings with real names
- Project filter selector - Multi-select checkboxes to choose which projects to sync
- Import/export org settings - Download JSON snapshot or import to clone configs across sites
- Issue export/import - Run JQL to download issues and upload the same file later to recreate or update them
- Manual sync controls - Force sync specific issues + clear error history
- Sync health dashboard - Real-time webhook stats + scheduled bulk sync stats
- Persistent storage - All configurations saved in Forge storage

## Installation

### Prerequisites
- Node.js 20.x or 22.x
- Forge CLI: `npm install -g @forge/cli`
- Two Jira Cloud instances with admin access

### Setup

1. Clone the repository
```bash
git clone https://github.com/SerdarAbali/jira-sync-connector.git
cd jira-sync-connector
```

2. Install dependencies
```bash
npm install --legacy-peer-deps
```

3. Login to Forge
```bash
forge login
```

4. Deploy to Jira
```bash
forge deploy
forge install
```

5. Configure the app
   - Navigate to Jira Settings → Apps → Manage your apps
   - Locate "Sync Connector" and click Configure
   - Enter remote Jira details (URL, email, API token, project key)
   - Click "Load Remote Data" and "Load Local Data"
   - Configure mappings for users, fields, and statuses
   - Save each mapping section

## Usage

### Dual Sync Strategy
The application uses two complementary sync mechanisms:

**Real-time Webhook Syncs**
- Triggers instantly when issues are created, updated, or commented
- Provides immediate synchronization (typically 1-3 seconds)
- Tracks: issues created, issues updated, comments synced, errors

**Scheduled Bulk Syncs (Hourly)**
- Runs every hour to catch any missed syncs
- Checks all issues in allowed projects for sync requirements
- Ensures eventual consistency and catches webhook failures
- Tracks: issues checked, created, updated, skipped, errors

**Rationale**
- Webhooks provide instant sync for active work
- Scheduled sync catches edge cases (missed webhooks, network issues, etc.)
- Combined approach ensures no issue is missed

### Basic Workflow
1. Create or update an issue in Source Org
2. Webhook triggers immediate sync to Target Org (1-3 seconds)
3. Updates, comments, attachments, links sync in real-time
4. Hourly scheduled sync validates all issues are in sync

### User Mapping
Map users between organizations to preserve assignee/reporter:
- Remote User → Local User
- Unmapped users default to unassigned

### Field Mapping
Sync custom fields by mapping field IDs:
- Remote Field → Local Field
- Sprint fields automatically extract sprint IDs
- Only mapped fields sync

### Status Mapping
Map status IDs when workflow names differ:
- Remote Status → Local Status
- Falls back to name matching if unmapped

### Project Filtering
Control which projects sync:
1. Open admin UI → "Project Filter" section
2. Click "Load Projects" to fetch available projects
3. Check/uncheck projects you want to sync
4. Click "Save Project Filter"
5. Behavior:
   - Projects selected: Only selected projects sync
   - No selection: All projects sync (backward compatible)
   - Applies to webhooks, comments, and scheduled syncs

### Import / Export Settings
Clone configurations between environments or take backups:
1. Open the Configuration tab and locate "Import / Export Settings"
2. Click **Export Settings** to download a JSON snapshot for the selected organization
3. To restore, click **Import Settings**, choose the JSON file, then select which sections to overwrite
4. Confirm the modal to apply (connection details, sync options, and mappings update based on the sections chosen)
5. Scheduled sync config is optional because it applies globally across all organizations

### Sync Health Dashboard
Monitor sync activity and troubleshoot issues:

**Real-time Webhook Syncs Section**
- Last activity timestamp
- Total syncs count
- Issues created, updated, and comments synced
- Recent errors with timestamps (top 5 shown)

**Scheduled Bulk Syncs Section**
- Last run timestamp and time elapsed
- Issues checked, created, updated, and skipped
- Success rate calculation
- Recent errors (top 5 shown)

**Access:**
1. Open admin UI → "Sync Health & Statistics" section
2. Click "Refresh Stats" to load latest data
3. Review metrics and errors to troubleshoot issues

### Manual Sync Controls

**Sync Specific Issue**
- Enter any issue key (e.g., "PROJ-123") to force immediate sync
- Useful for testing, debugging, or recovering from errors
- Bypasses normal sync conditions and forces create/update
- Shows success/error message with sync result
- Press Enter or click "Sync Now" button

**Clear Error History**
- "Clear Webhook Errors" - Resets webhook error tracking
- "Clear Scheduled Errors" - Resets scheduled sync error tracking
- Does not retry failed syncs, only clears the error log

**Access:**
1. Open admin UI → "Manual Sync Controls" section
2. Enter issue key and click "Sync Now" for on-demand sync
3. Click error clear buttons to reset error history

### Issue Export
Create portable snapshots of existing issues for migration or backup:
1. Open the Sync Activity tab and locate the "Issue Export" card
2. Enter any JQL filter (e.g., `project = ABC AND updated >= -30d`) and set a max result count (up to 250)
3. Choose whether to include comments, attachment metadata, links, and changelog history
4. Click **Export Issues** – a JSON file downloads with the filtered issues plus stored remote mappings
5. Use the JSON to audit what was exported or as the source file for the import workflow below

**Notes**
- If your JQL uses `currentUser()`, the resolver automatically substitutes the Jira accountId of the admin running the export so the query returns the same issues you see in Jira.
- The downloaded JSON now contains both `query` (what you typed) and `effectiveQuery` (what the backend executed) to make troubleshooting easier.

Attachments are exported as metadata (IDs, filenames, download URLs) to avoid oversized payloads.

### Issue Import
Recreate or update issues in a target organization using a previously exported JSON file:
1. Select the destination organization in the header dropdown
2. In the Sync Activity tab, click **Import Issues** and pick the JSON exported earlier
3. Review the number of detected issues and choose options (refresh from source Jira, force recreate, skip existing)
4. Confirm the import; the app re-fetches each issue (unless you opt out) and creates or updates the remote copy
5. The summary banner reports how many issues were created, updated, or skipped

Keep the source Jira issues available so attachments and media can be downloaded during import. If you disable the "refresh from source" option, the import relies solely on the snapshot stored in the JSON file.

## Architecture

### Modular File Structure (New!)
```
SyncApp/
├── src/
│   ├── index.js (6 lines)           # Entry point - exports triggers & resolvers
│   ├── constants.js                 # Shared constants & emojis
│   │
│   ├── utils/                       # Utility functions (4 modules)
│   │   ├── adf.js                  # ADF ↔ text conversion
│   │   ├── mapping.js              # User/field mapping helpers
│   │   ├── retry.js                # Retry with exponential backoff
│   │   └── validation.js           # Project validation
│   │
│   ├── services/                    # Core business logic
│   │   ├── storage/                # Storage abstractions (3 modules)
│   │   │   ├── mappings.js         # Issue/attachment/link mappings
│   │   │   ├── flags.js            # Sync flags & pending links
│   │   │   └── stats.js            # Statistics tracking
│   │   │
│   │   ├── jira/                   # Jira API clients (2 modules)
│   │   │   ├── local-client.js     # Local Jira API wrapper
│   │   │   └── remote-client.js    # Remote Jira API wrapper
│   │   │
│   │   ├── sync/                   # Sync operations (6 modules)
│   │   │   ├── sync-result.js      # SyncResult tracking class
│   │   │   ├── issue-sync.js       # Main issue sync orchestration
│   │   │   ├── comment-sync.js     # Comment sync logic
│   │   │   ├── attachment-sync.js  # Attachment operations
│   │   │   ├── link-sync.js        # Link operations
│   │   │   └── transition-sync.js  # Status transitions
│   │   │
│   │   └── scheduled/              # Scheduled operations (1 module)
│   │       └── scheduled-sync.js   # Hourly bulk sync + pending link retry
│   │
│   ├── resolvers/                   # API resolvers (6 modules)
│   │   ├── index.js                # Resolver aggregator
│   │   ├── config.js               # Configuration resolvers
│   │   ├── sync.js                 # Sync operation resolvers
│   │   ├── data.js                 # Data fetching resolvers
│   │   ├── stats.js                # Statistics resolvers
│   │   └── audit.js                # Audit log resolvers
│   │
│   └── triggers/                    # Webhook handlers (4 modules)
│       ├── issue.js                # Issue create/update trigger
│       ├── comment.js              # Comment trigger
│       ├── link.js                 # Link creation trigger
│       └── scheduled.js            # Scheduled sync trigger
│
├── static/admin-page/
│   ├── src/
│   │   └── App.jsx                 # React admin UI
│   └── package.json
│
├── manifest.yml                     # Forge app configuration
└── package.json
```

### Key Components

**Sync Orchestration (`services/sync/issue-sync.js`)**
- `syncIssue()` - Main webhook handler (create/update detection)
- `createRemoteIssue()` - Create with full field mapping
- `updateRemoteIssue()` - Update with field clearing support
- Uses modular services for attachments, links, transitions

**Storage Services (`services/storage/`)**
- `mappings.js` - Issue, attachment, and link mappings
- `flags.js` - Sync flags, pending links with TTL
- `stats.js` - Webhook and scheduled sync statistics

**Sync Services (`services/sync/`)**
- `attachment-sync.js` - Binary file operations
- `link-sync.js` - Issue link operations with pending retry
- `transition-sync.js` - Status transitions with mapping
- `comment-sync.js` - Comment sync with author attribution
- `sync-result.js` - Comprehensive sync result tracking

**Utilities (`utils/`)**
- `retry.js` - Exponential backoff with rate limit detection
- `adf.js` - ADF format conversion and media ID replacement
- `mapping.js` - User and field mapping helpers
- `validation.js` - Project filtering validation

**Frontend (static/admin-page/src/App.jsx)**
- Configuration form (remote Jira credentials)
- Manual sync controls (force sync issue, clear errors)
- Sync health dashboard (webhook stats + scheduled sync stats)
- Project filter UI (load, select, save)
- User mapping UI (load, add, delete, save)
- Field mapping UI (load, add, delete, save)
- Status mapping UI (load, add, delete, save)

**Triggers (manifest.yml)**
- `avi:jira:created:issue` - New issue webhook (real-time)
- `avi:jira:updated:issue` - Issue update webhook (real-time)
- `avi:jira:commented:issue` - Comment webhook (real-time)
- `scheduledTrigger` - Hourly bulk sync (runs every hour)

### Synced Fields

**Standard Fields:**
- Summary, Description, Priority
- Labels, Due Date
- Assignee, Reporter (with user mapping)
- Status (with status mapping)
- Parent/Epic relationships
- Components
- Fix Versions
- Affects Versions
- Time Tracking (Original Estimate, Remaining Estimate)

**Relational Data:**
- Comments (with author attribution)
- Attachments (binary files, 10MB limit)
- Issue Links (all types: blocks, relates, duplicates, etc.)

**Custom Fields:**
- Any custom field via field mapping
- Sprint fields (with automatic ID extraction)

## Forge Compliance & Production Optimizations

This app is built with Forge best practices and production-ready optimizations:

### Storage Management
- Index-based queries - Uses `pending-links-index` array instead of unsupported `startsWith()` queries
- Automatic cleanup - Audit logs limited to 50 entries to stay within Forge's 5MB storage limit
- Error tracking - Last 50 errors tracked per sync type (webhook/scheduled)
- Pending link limits - Auto-removes pending links after 10 failed retry attempts

### Rate Limiting & Performance
- Exponential backoff retry - 3 attempts with delays: 1s, 2s, 4s
- Rate limit detection - Detects HTTP 429 and waits 60s before retry
- Batch processing ready - Constants defined for future batch processing (10 issues per batch, 5s delay)
- Scheduled sync delays - 500ms between issues to avoid overwhelming API

### Timeout Prevention
- Sync flag TTL - 5-second TTL prevents deadlocks from failed operations
- Concurrent sync prevention - Issues marked as "syncing" prevent duplicate operations
- Recent creation window - 3-second window prevents duplicate create operations
- Mapping stored immediately - Critical fix prevents race conditions in parallel syncs

### Webhook Reliability
- Duplicate prevention - Checks existing mappings before creating issues
- One-way sync optimized - Removed faulty bidirectional checks that blocked legitimate syncs
- Project filtering - Only processes allowed projects to reduce noise
- Changelog logging - Logs all field changes for debugging

### Scheduled Sync Reliability
- Hourly execution - Catches missed webhooks and ensures eventual consistency
- Retry pending links - Automatically retries links when both issues are synced
- JQL-based queries - Efficient queries using allowed projects filter
- Stats tracking - Comprehensive stats for monitoring sync health

### Storage Schema
```javascript
// Configuration
syncConfig                    // Remote Jira credentials + project key
userMappings                  // Remote user ID → Local user ID
fieldMappings                 // Remote field ID → Local field ID
statusMappings                // Remote status ID → Local status ID
syncOptions                   // Feature toggles (comments, attachments, links, sprints)
scheduledSyncConfig           // Scheduled sync settings (enabled, interval, scope)

// Issue Mappings (Bidirectional)
local-to-remote:{issueKey}    // SCRUM-81 → SCRUM-79
remote-to-local:{remoteKey}   // SCRUM-79 → SCRUM-81

// Attachment Mappings
attachment-mapping:{localId}  // 10001 → 20002

// Link Mappings
link-mapping:{localLinkId}    // 30001 → 'synced'
pending-links:{issueKey}      // Array of pending links for retry
pending-links-index           // Array of issue keys with pending links

// Sync State (TTL: 5-10s)
syncing:{issueKey}            // 'true' (TTL: 5s)
created-timestamp:{issueKey}  // Unix timestamp (TTL: 10s)

// Statistics & Audit
webhookSyncStats              // Real-time webhook sync stats
scheduledSyncStats            // Scheduled sync stats
auditLog                      // Last 50 audit entries
```

### Why This Modular Architecture?
1. Clear separation of concerns - Each module does one thing well
2. Easier to test - Isolated modules can be unit tested
3. Better performance - Smaller files = faster cold starts in Forge
4. Maintainable - Easy to find and fix issues
5. Scalable - Easy to add new features without breaking existing code
6. Team-friendly - Multiple developers can work independently

## Development

### Build React UI
```bash
cd static/admin-page
npm run build
cd ../..
```

### Deploy changes
```bash
forge deploy
```

### View logs
```bash
forge logs --tail
```

### Tunnel for local development
```bash
forge tunnel
```

## Configuration

### Remote Jira Setup
1. Generate API token: https://id.atlassian.com/manage-profile/security/api-tokens
2. Enter in admin UI:
   - Remote Jira URL: `https://yourorg.atlassian.net`
   - Admin Email: Your email
   - API Token: Generated token
   - Project Key: Target project (e.g., SCRUM)

### Mapping Strategy
1. Load data first - Click both "Load Remote Data" and "Load Local Data"
2. Auto-selection - First items auto-selected for quick mapping
3. Save required - Must click "Save" buttons to persist mappings

## Current Status

### Phase 1: Complete
- One-way sync (Org A → Org B)
- Full CRUD operations
- Comment sync with author
- Attachment sync (binary files, 10MB limit)
- Issue Links (all types)
- Components, Fix Versions, Affects Versions
- Time Tracking
- User/Field/Status mapping UI
- Epic/Parent preservation
- Custom field support (including sprints)

### Phase 2: Complete
- Issue Links synchronization
- Duplicate link prevention
- Bidirectional link support (inward/outward)
- Selective project syncing (project filter UI)

### Phase 3: Control & Filtering Complete
- Selective project syncing - Multi-select UI to choose which projects sync
- Sync options toggles - Enable/disable comments, attachments, links, sprints

### Phase 4: Reliability & Observability Complete
- Dual sync strategy - Real-time webhooks + hourly scheduled bulk sync
- Sync health dashboard - Real-time webhook stats + scheduled sync stats with error tracking
- Error tracking - Top 50 errors tracked with timestamps for webhooks
- Error handling & retry logic - Exponential backoff (3 attempts: 1s, 2s, 4s)
- Rate limiting protection - Detects HTTP 429 and waits 60s before retry
- Manual sync controls - Force sync specific issues + clear error history
- Audit log - Last 50 audit entries with timestamps

### Phase 5: Code Quality & Architecture Complete
- Modular refactoring - 26 focused modules replacing 2,266-line monolith
- Forge best practices - Following official Atlassian patterns
- Bug fixes - Fixed one-way sync issues causing skips
- Performance optimizations - Smaller modules = faster cold starts

### Phase 6: Bidirectional Sync (Future)
- Install on both orgs - Same app deployed to both Jira instances
- Loop detection mechanism - Prevent infinite sync loops
- Conflict resolution - Last-write-wins vs manual merge strategies

## Troubleshooting

### Issues not syncing?
- Check Sync Health Dashboard - Open admin UI → "Sync Health & Statistics" → "Refresh Stats"
  - Review webhook stats for real-time sync activity
  - Review scheduled sync stats for bulk sync results
  - Check "Recent Errors" sections for specific error messages
- Check `forge logs --tail` for detailed errors
- Verify remote credentials in admin UI
- Ensure user/field/status mappings saved
- Confirm project key is correct
- Check project filter - Verify project is in allowed list

### Understanding the dashboard?
- Webhook stats show zeros - No issues created/updated yet since deployment
- Scheduled stats show zeros - First hourly sync hasn't run yet (wait up to 1 hour)
- High "Issues Skipped" count - Normal; issues already in sync are skipped
- Recent errors listed - View full details with `forge logs --tail`

### Need to force sync an issue?
- Open admin UI → "Manual Sync Controls" section
- Enter the issue key (e.g., "PROJ-123")
- Click "Sync Now" to force immediate sync
- Check the success/error message returned

### Only certain projects syncing?
- Open admin UI → "Project Filter" section
- Review "Currently Selected Projects" list
- If projects are selected, only those will sync
- To sync all projects: uncheck all and save (backward compatible)

### Attachments not syncing?
- Check file size (10MB limit)
- Verify download/upload permissions
- Check logs for specific errors
- Ensure storage mappings are working
- Verify "Sync Attachments" is enabled in Sync Options

### Issue links not syncing?
- Ensure linked issues exist in both orgs
- Verify both issues have been synced first
- Check link type exists in target org
- Review logs for skipped links
- Pending links auto-retry every hour
- Verify "Sync Links" is enabled in Sync Options

### Assignee not syncing?
- Load remote/local data in admin UI
- Add user mapping: Remote User → Local User
- Click "Save User Mappings"
- Create new issue to test

### Slow sync (5-10 minutes)?
- Normal: Forge cold starts can take time
- Peak times: Jira webhook delays under load
- Sync usually completes in 1-3 seconds once triggered
- Check Sync Health Dashboard for timing metrics

### Comments delayed?
- Comment syncs instantly to API
- Jira UI may cache and delay display
- Hard refresh (Ctrl+Shift+R) to force update
- Verify "Sync Comments" is enabled in Sync Options

### Module Import Errors?
- All imports use `.js` extensions (ES modules)
- Check file paths are relative (e.g., `../utils/retry.js`)
- Verify all exports are named exports
- Run `forge deploy` to validate

## License

MIT License - See LICENSE file

## Support

- GitHub Issues: https://github.com/SerdarAbali/jira-sync-connector/issues
- Forge Documentation: https://developer.atlassian.com/platform/forge/

---

Atlassian Forge Application