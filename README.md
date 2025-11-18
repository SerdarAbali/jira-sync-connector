# Jira Sync Connector

Production-ready Atlassian Forge app for real-time one-way synchronization between two Jira Cloud organizations.

## ✨ Features

### Core Sync Capabilities
✅ **Real-time sync** - Issues sync instantly via webhooks  
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
✅ **Infinite loop prevention** - Safe one-way architecture with sync detection  

### Admin Interface
🎛️ **Collapsible UI sections** - Clean, organized configuration  
🔄 **Live data loading** - Fetch users, fields, statuses from both orgs  
📋 **Visual mapping management** - Add/delete mappings with real names  
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

### Basic Workflow
1. Create or update an issue in Source Org (serdarjiraone)
2. App syncs to Target Org (serdarjiratwo) automatically
3. Updates, comments, attachments, links sync in real-time

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
- `syncIssue()` - Main sync function (create/update)
- `syncComment()` - Comment sync with author info
- `syncAttachments()` - Binary file download/upload with deduplication
- `syncIssueLinks()` - Link sync with mapping verification
- `createRemoteIssue()` - Create with parent/epic/component/version support
- `updateRemoteIssue()` - Update with user mapping and field clearing
- `transitionRemoteIssue()` - Status sync with mapping
- Resolvers for admin UI (getConfig, getUserMappings, etc.)

**Frontend (static/admin-page/src/App.jsx)**
- Configuration form (remote Jira credentials)
- User mapping UI (load, add, delete, save)
- Field mapping UI (load, add, delete, save)
- Status mapping UI (load, add, delete, save)

**Triggers (manifest.yml)**
- `avi:jira:created:issue` - New issue webhook
- `avi:jira:updated:issue` - Issue update webhook
- `avi:jira:commented:issue` - Comment webhook

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

### Phase 3: Future 🔮
- 🔮 Selective field syncing (UI toggles)
- 🔮 Partial project sync (JQL filters)
- 🔮 Retroactive sync for existing issues

### Phase 4: Future 🔮
- 🔮 Error handling & retry logic
- 🔮 Rate limiting protection
- 🔮 Sync health dashboard
- 🔮 Audit log

### Phase 5: Future 🔮
- 🔮 Bidirectional sync (same app, both orgs)
- 🔮 Conflict resolution
- 🔮 Loop detection

## 🐛 Troubleshooting

### Issues not syncing?
- Check `forge logs` for errors
- Verify remote credentials in admin UI
- Ensure user/field/status mappings saved
- Confirm project key is correct

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