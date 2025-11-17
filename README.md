# Jira Sync Connector

Production-ready Atlassian Forge app for real-time one-way synchronization between two Jira Cloud organizations.

## ✨ Features

### Core Sync Capabilities
- ✅ **Real-time sync** - Issues sync instantly via webhooks
- ✅ **Issue creation & updates** - Summary, description, priority, labels
- ✅ **Status synchronization** - Configurable status mappings
- ✅ **Epic/Parent relationships** - Preserves hierarchy across orgs
- ✅ **Comment sync** - With author attribution: `[Comment from orgname - User: Name]`
- ✅ **Custom field mapping** - Map custom fields between organizations
- ✅ **User mapping** - Map assignee & reporter between organizations
- ✅ **Infinite loop prevention** - Safe bidirectional architecture

### Admin Interface
- 🎛️ **Collapsible UI sections** - Clean, organized configuration
- 🔄 **Live data loading** - Fetch users, fields, statuses from both orgs
- 📋 **Visual mapping management** - Add/delete mappings with real names
- 💾 **Persistent storage** - All configurations saved in Forge storage

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
npm install --legacy-peer-deps
```

2. **Login to Forge**
```bash
forge login
```

3. **Deploy to Jira**
```bash
forge deploy
forge install
```

4. **Configure the app**
   - Go to **Jira Settings → Apps → Manage your apps**
   - Find "Sync Connector" and click **Configure**
   - Fill in remote Jira details (URL, email, API token, project key)
   - Click **Load Remote Data** and **Load Local Data**
   - Configure mappings for users, fields, and statuses
   - Save each mapping section

## 📖 Usage

### Basic Workflow
1. Create or update an issue in **Source Org (serdarjiraone)**
2. App syncs to **Target Org (serdarjiratwo)** automatically
3. Updates, comments, status changes sync in real-time

### User Mapping
Map users between organizations to preserve assignee/reporter:
- **Remote User** → **Local User**
- Unmapped users default to unassigned

### Field Mapping
Sync custom fields by mapping field IDs:
- **Remote Field** → **Local Field**
- Only mapped fields sync

### Status Mapping
Map status IDs when workflow names differ:
- **Remote Status** → **Local Status**
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

**Backend (`src/index.js`)**
- `syncIssue()` - Main sync function (create/update)
- `syncComment()` - Comment sync with author info
- `createRemoteIssue()` - Create with parent/epic support
- `updateRemoteIssue()` - Update with user mapping
- `transitionRemoteIssue()` - Status sync with mapping
- Resolvers for admin UI (getConfig, getUserMappings, etc.)

**Frontend (`static/admin-page/src/App.jsx`)**
- Configuration form (remote Jira credentials)
- User mapping UI (load, add, delete, save)
- Field mapping UI (load, add, delete, save)
- Status mapping UI (load, add, delete, save)

**Triggers (`manifest.yml`)**
- `avi:jira:created:issue` - New issue webhook
- `avi:jira:updated:issue` - Issue update webhook
- `avi:jira:commented:issue` - Comment webhook

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
   - Remote Jira URL: `https://yourorg.atlassian.net`
   - Admin Email: Your email
   - API Token: Generated token
   - Project Key: Target project (e.g., `SCRUM`)

### Mapping Strategy
- **Load data first** - Click both "Load Remote Data" and "Load Local Data"
- **Auto-selection** - First items auto-selected for quick mapping
- **Save required** - Must click "Save" buttons to persist mappings

## 🚦 Current Status

**Phase 1: Complete ✅**
- One-way sync (Org A → Org B)
- Full CRUD operations
- Comment sync with author
- User/Field/Status mapping UI
- Epic/Parent preservation

**Phase 2: Future 🔮**
- Bidirectional sync (same app, both orgs)
- Attachment synchronization
- Selective project syncing
- Retroactive sync for existing issues
- Reaction/engagement sync

## 🐛 Troubleshooting

### Issues not syncing?
1. Check `forge logs` for errors
2. Verify remote credentials in admin UI
3. Ensure user/field/status mappings saved
4. Confirm project key is correct

### Assignee not syncing?
1. Load remote/local data in admin UI
2. Add user mapping: Remote User → Local User
3. Click **Save User Mappings**
4. Create new issue to test

### Slow sync (5-10 minutes)?
- **Normal**: Forge cold starts take time
- **Peak times**: Jira webhook delays under load
- **Solution**: Sync usually completes in 1-3 seconds once triggered

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

- **GitHub Issues**: https://github.com/SerdarAbali/jira-sync-connector/issues
- **Forge Docs**: https://developer.atlassian.com/platform/forge/

---

**Built with ❤️ using Atlassian Forge**
