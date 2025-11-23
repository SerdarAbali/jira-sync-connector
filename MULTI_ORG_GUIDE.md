# Multi-Organization Sync - Migration Guide

## Overview
Your Jira Sync Connector now supports syncing from **one source organization (Org A)** to **multiple target organizations (Org B, C, D, etc.)**.

## What Changed?

### 1. **Organization Management**
- You can now add, edit, and delete multiple target organizations
- Each organization has its own configuration (URL, credentials, project key)
- Organizations are stored with unique IDs (e.g., `org-1732377000000`)

### 2. **Per-Organization Settings**
Each target organization now has independent:
- ✅ User mappings (source user → target user)
- ✅ Field mappings (custom fields)
- ✅ Status mappings (workflow statuses)
- ✅ Project filters (which projects sync to this org)
- ✅ Sync options (comments, attachments, links, sprints)

### 3. **Storage Schema**
Mappings are now namespaced by organization ID:
```
Old: local-to-remote:ISSUE-1
New: org-123:local-to-remote:ISSUE-1

Old: userMappings
New: userMappings:org-123
```

### 4. **Sync Behavior**
- When an issue is created/updated, it syncs to **ALL** configured organizations
- Each organization respects its own project filters and sync options
- Comments and attachments sync to all organizations independently

## How to Use

### Step 1: Add Organizations
1. Go to Jira Settings → Apps → Manage Apps → Sync Connector Configuration
2. Click **"➕ Add Organization"**
3. Fill in:
   - **Organization Name**: e.g., "Production Org", "Staging Org"
   - **Remote Jira URL**: https://yourorg.atlassian.net
   - **Remote Admin Email**: admin@example.com
   - **Remote API Token**: (from https://id.atlassian.com/manage-profile/security/api-tokens)
   - **Remote Project Key**: e.g., PROJ
4. Click **"Add Organization"**

### Step 2: Configure Each Organization
Select an organization from the dropdown, then configure:

#### **Project Filter Tab**
- Click "Load Projects" to see all local projects
- Check which projects should sync to this organization
- Click "Save Project Filter"
- If no projects are selected, ALL projects will sync

#### **Mappings Tab**
- **User Mappings**: Map users between organizations
  - Load remote and local data
  - Select users and click "Add Mapping"
  - Save when done
  
- **Field Mappings**: Map custom fields
  - Same process as user mappings
  
- **Status Mappings**: Map workflow statuses
  - Same process as user mappings

#### **Sync Controls Tab**
- **Sync Options**: Enable/disable sync features per organization
  - ☑️ Sync Comments
  - ☑️ Sync Attachments
  - ☑️ Sync Issue Links
  - ☑️ Sync Sprints
  
- **Manual Sync**: Force sync a specific issue to ALL organizations

#### **Health & Stats Tab**
- View sync statistics across all organizations
- Refresh to see latest sync activity

## Legacy Support

If you had existing configuration, it's automatically detected as a "Legacy Organization" and continues working without changes. However, we recommend migrating:

1. Add new organizations using the "Add Organization" button
2. Copy over your user/field/status mappings
3. Delete the legacy configuration (stored in old format)

## Example Setup

### Scenario: Sync from Development Org to Production + Staging

**Development Org (Source)**
- This is where your app is installed (Org A)
- All issues created here will sync to configured targets

**Production Org (Target 1)**
```
Name: Production Org
URL: https://prod.atlassian.net
Project Key: PROD
Allowed Projects: CORE, API, WEB
Sync Options: All enabled
```

**Staging Org (Target 2)**
```
Name: Staging Org
URL: https://staging.atlassian.net
Project Key: STAGE
Allowed Projects: CORE, API (excluding WEB)
Sync Options: Comments disabled
```

**Result**: 
- Issues in CORE and API projects sync to both Production and Staging
- Issues in WEB project only sync to Production
- Comments sync to Production but not Staging
- Each org has its own user/field/status mappings

## Storage Keys Reference

### Organizations
```
organizations: [
  {
    id: "org-1732377000000",
    name: "Production Org",
    remoteUrl: "https://prod.atlassian.net",
    remoteEmail: "admin@example.com",
    remoteApiToken: "***",
    remoteProjectKey: "PROD",
    allowedProjects: ["CORE", "API"],
    createdAt: "2024-11-23T10:00:00.000Z"
  }
]
```

### Per-Organization Mappings
```
userMappings:org-123
fieldMappings:org-123
statusMappings:org-123
syncOptions:org-123
```

### Issue Mappings
```
org-123:local-to-remote:ISSUE-1 → PROD-456
org-123:remote-to-local:PROD-456 → ISSUE-1
```

## Testing

1. **Add a test organization** with minimal configuration
2. **Create a test issue** in your source org
3. **Check logs** with `forge logs --tail`
4. **Verify sync** in the target organization
5. **Check stats** in the Health & Stats tab

## Troubleshooting

### Issue not syncing to specific org
- Check if the project is in the org's allowed projects list
- Verify org credentials are correct
- Check sync options are enabled
- Review logs for specific error messages

### Mappings not working
- Ensure you've saved mappings after adding them
- Check you're viewing the correct organization in the dropdown
- Load remote/local data before adding mappings

### Performance concerns
- Syncing to multiple orgs happens sequentially
- Each org adds ~1-3 seconds to sync time
- Consider project filters to reduce unnecessary syncs

## Deploy Changes

```bash
cd /Users/serdar/Documents/Projects/jira-sync-project/SyncApp
forge deploy
```

The app will automatically handle legacy configurations and new multi-org setup side-by-side.

---

**Questions?** Check `forge logs --tail` for detailed sync information across all organizations.
