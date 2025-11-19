# Jira Sync Connector

Production-ready Atlassian Forge app for real-time one-way synchronization between two Jira Cloud organizations.

## ✨ Features

### Core Sync Capabilities
✅ **Dual sync strategy** - Real-time webhooks + hourly scheduled bulk sync
✅ **Issue creation & updates** - Summary, description, priority, labels, due date
✅ **Status synchronization** - Configurable status mappings with transitions
✅ **Epic/Parent relationships** - Preserves hierarchy across orgs
✅ **Comment sync** - With author attribution: `[Comment from orgname - User: Name]`
✅ **Attachment sync** - Binary file transfer with 10MB limit and duplicate prevention
✅ **Issue Links** - Syncs all link types (blocks, relates to, duplicates, etc.)
✅ **Components** - Component sync with clearing support
✅ **Fix Versions** - Version sync with clearing support
✅ **Affects Versions** - Affected version sync with clearing support
✅ **Time Tracking** - Original estimate and remaining estimate sync
✅ **Custom field mapping** - Map custom fields (including sprints) between organizations
✅ **User mapping** - Map assignee & reporter between organizations
✅ **Project filtering** - Selectively sync specific projects/spaces via admin UI
✅ **Infinite loop prevention** - Safe one-way architecture with sync detection  

### Admin Interface
🎛️ **Collapsible UI sections** - Clean, organized configuration
🔄 **Live data loading** - Fetch users, fields, statuses, projects from both orgs
📋 **Visual mapping management** - Add/delete mappings with real names
🎯 **Project filter selector** - Multi-select checkboxes to choose which projects to sync
📊 **Sync health dashboard** - Real-time webhook stats + scheduled bulk sync stats
💾 **Persistent storage** - All configurations saved in Forge storage  

## 🚀 Installation

### Prerequisites
- Node.js 20.x or 22.x
- Forge CLI: `npm install -g @forge/cli`
- Two Jira Cloud instances with admin access

### Setup

1. **Clone the repository**
```bash
git clone https://github.com/SerdarAbali/jira-sync-connector.git
cd jira-sync-connector
```

2. **Install dependencies**
```bash
npm install --legacy-peer-deps
```

3. **Login to Forge**
```bash
forge login
```

4. **Deploy to Jira**
```bash
forge deploy
forge install
```

5. **Configure the app**
   - Go to Jira Settings → Apps → Manage your apps
   - Find "Sync Connector" and click Configure
   - Fill in remote Jira details (URL, email, API token, project key)
   - Click "Load Remote Data" and "Load Local Data"
   - Configure mappings for users, fields, and statuses
   - Save each mapping section

## 📖 Usage

### Dual Sync Strategy
The app uses two complementary sync mechanisms for maximum reliability:

**Real-time Webhook Syncs**
- Triggers instantly when issues are created, updated, or commented
- Provides immediate synchronization (typically 1-3 seconds)
- Tracks: issues created, issues updated, comments synced, errors

**Scheduled Bulk Syncs (Hourly)**
- Runs every hour to catch any missed syncs
- Checks all issues in allowed projects for sync requirements
- Ensures eventual consistency and catches webhook failures
- Tracks: issues checked, created, updated, skipped, errors

**Why Both?**
- Webhooks provide instant sync for active work
- Scheduled sync catches edge cases (missed webhooks, network issues, etc.)
- Together they ensure no issue is ever missed

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
Control which projects sync to reduce noise and focus on specific spaces:
1. Open admin UI → "Project Filter" section
2. Click "Load Projects" to fetch available projects
3. Check/uncheck projects you want to sync
4. Click "Save Project Filter"
5. **Behavior:**
   - **Projects selected:** Only selected projects sync
   - **No selection:** All projects sync (backward compatible)
   - Applies to webhooks, comments, and scheduled syncs

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

**How to Access:**
1. Open admin UI → "Sync Health & Statistics" section
2. Click "Refresh Stats" to load latest data
3. Review metrics and errors to troubleshoot issues

## 🏗️ Architecture

### File Structure
```
SyncApp/
├── src/
│   └── index.js                 # Backend sync logic + resolvers
├── static/admin-page/
│   ├── src/
│   │   └── App.jsx             # React admin UI
│   └── package.json
├── manifest.yml                 # Forge app configuration
└── package.json
```

### Key Components

**Backend (src/index.js)**
- `syncIssue()` - Main sync function (create/update) with webhook tracking
- `syncComment()` - Comment sync with author info and webhook tracking
- `trackWebhookSync()` - Track real-time sync statistics
- `performScheduledSync()` - Hourly bulk sync for missed issues
- `syncAttachments()` - Binary file download/upload with deduplication
- `syncIssueLinks()` - Link sync with mapping verification
- `createRemoteIssue()` - Create with parent/epic/component/version support
- `updateRemoteIssue()` - Update with user mapping and field clearing
- `transitionRemoteIssue()` - Status sync with mapping
- Resolvers for admin UI (getConfig, getWebhookSyncStats, getScheduledSyncStats, etc.)

**Frontend (static/admin-page/src/App.jsx)**
- Configuration form (remote Jira credentials)
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

## 🔧 Development

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
forge logs
```

### Tunnel for local development
```bash
forge tunnel
```

## 📋 Configuration

### Remote Jira Setup
1. Get API token: https://id.atlassian.com/manage-profile/security/api-tokens
2. Enter in admin UI:
   - **Remote Jira URL:** `https://yourorg.atlassian.net`
   - **Admin Email:** Your email
   - **API Token:** Generated token
   - **Project Key:** Target project (e.g., SCRUM)

### Mapping Strategy
1. **Load data first** - Click both "Load Remote Data" and "Load Local Data"
2. **Auto-selection** - First items auto-selected for quick mapping
3. **Save required** - Must click "Save" buttons to persist mappings

## 🚦 Current Status

### Phase 1: Complete ✅
- ✅ One-way sync (Org A → Org B)
- ✅ Full CRUD operations
- ✅ Comment sync with author
- ✅ Attachment sync (binary files, 10MB limit)
- ✅ Issue Links (all types)
- ✅ Components, Fix Versions, Affects Versions
- ✅ Time Tracking
- ✅ User/Field/Status mapping UI
- ✅ Epic/Parent preservation
- ✅ Custom field support (including sprints)

### Phase 2: Complete ✅
- ✅ Issue Links synchronization
- ✅ Duplicate link prevention
- ✅ Bidirectional link support (inward/outward)
- ✅ Selective project syncing (project filter UI)

### Phase 3: Control & Filtering ✅
- ✅ **Selective project syncing** - Multi-select UI to choose which projects sync
- 🔮 **Selective field syncing** - UI toggles for "Sync comments? Attachments? Links?"

### Phase 4: Reliability & Observability (Partially Complete)
- ✅ **Dual sync strategy** - Real-time webhooks + hourly scheduled bulk sync
- ✅ **Sync health dashboard** - Real-time webhook stats + scheduled sync stats with error tracking
- ✅ **Error tracking** - Top 50 errors tracked with timestamps for webhooks
- 🔮 **Error handling & retry logic** - Automatic retry for failed syncs
- 🔮 **Rate limiting protection** - Throttle requests to avoid API limits
- 🔮 **Audit log** - Detailed sync history with timestamps

### Phase 5: Bidirectional Sync (The Big One)
- 🔮 **Install on both orgs** - Same app deployed to both Jira instances
- 🔮 **Loop detection mechanism** - Prevent infinite sync loops
- 🔮 **Conflict resolution** - Last-write-wins vs manual merge strategies

## 🐛 Troubleshooting

### Issues not syncing?
- **Check Sync Health Dashboard** - Open admin UI → "Sync Health & Statistics" → "Refresh Stats"
  - Review webhook stats for real-time sync activity
  - Review scheduled sync stats for bulk sync results
  - Check "Recent Errors" sections for specific error messages
- Check `forge logs` for detailed errors
- Verify remote credentials in admin UI
- Ensure user/field/status mappings saved
- Confirm project key is correct
- **Check project filter** - Verify project is in allowed list

### Understanding the dashboard?
- **Webhook stats show zeros** - No issues created/updated yet since deployment
- **Scheduled stats show zeros** - First hourly sync hasn't run yet (wait up to 1 hour)
- **High "Issues Skipped" count** - Normal; issues already in sync are skipped
- **Recent errors listed** - Click into logs with `forge logs` for full details

### Only certain projects syncing?
- Open admin UI → "Project Filter" section
- Review "Currently Selected Projects" list
- If projects are selected, only those will sync
- To sync all projects: uncheck all and save (backward compatible)
- Check logs for: `⛔ Project X is NOT in allowed list`

### Attachments not syncing?
- Check file size (10MB limit)
- Verify download/upload permissions
- Check logs for specific errors
- Ensure storage mappings are working

### Issue links not syncing?
- Ensure linked issues exist in both orgs
- Verify both issues have been synced first
- Check link type exists in target org
- Review logs for skipped links

### Assignee not syncing?
- Load remote/local data in admin UI
- Add user mapping: Remote User → Local User
- Click "Save User Mappings"
- Create new issue to test

### Slow sync (5-10 minutes)?
- Normal: Forge cold starts take time
- Peak times: Jira webhook delays under load
- Solution: Sync usually completes in 1-3 seconds once triggered

### Comments delayed?
- Comment syncs instantly to API
- Jira UI may cache and delay display
- Hard refresh (Ctrl+Shift+R) to force update

## 📚 Documentation

See `/docs` folder for detailed documentation:
- `ARCHITECTURE.md` - System design & data flow
- `DEVELOPMENT.md` - Developer guide
- `API.md` - API reference
- `DEPLOYMENT.md` - Deployment strategies
- `TROUBLESHOOTING.md` - Common issues
- `CONTRIBUTING.md` - Contribution guidelines

## 📄 License

MIT License - See LICENSE file

## 🙋 Support

- **GitHub Issues:** https://github.com/SerdarAbali/jira-sync-connector/issues
- **Forge Docs:** https://developer.atlassian.com/platform/forge/

---

Built with ❤️ using Atlassian Forge