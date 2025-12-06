# Jira Sync Connector

Atlassian Forge application for resilient org-to-org synchronization on Atlassian Forge. The app still treats Org A as the hub, but now mirrors the key updates, status changes, parents, and comments that originate in Org B back into Org A.

## Overview

This application syncs issues from a source Jira organization to a target organization. It supports real-time webhook-based sync and scheduled hourly sync for reliability.

## Features

### Sync Capabilities

**Outbound (Org A → Org B)**
- Issue creation and updates (summary, description, priority, labels, due date)
- Status synchronization with configurable mappings
- Epic/Parent relationships and subtasks
- Comments with author attribution
- Attachments (10MB limit per file)
- Issue links (blocks, relates to, duplicates, etc.)
- Components, Fix Versions, Affects Versions
- Time tracking (original and remaining estimates)
- Custom field mapping including sprints
- User mapping for assignee and reporter

**Inbound (Org B → Org A, current coverage)**
- Issue creation into the configured local project and deletions that mirror remote removals
- Field mirroring for summary, description, priority, labels, due date, components, fix/affects versions, and time tracking
- Assignee and reporter mapping using the existing user map (logs when unmapped)
- Parent/Epic mapping so subtasks follow their hierarchy once the parent exists locally
- Status transitions applied via reverse mappings to keep boards aligned
- Comments recreated in Org A with the original author attribution, skip-if-duplicate protection, and loop prevention for SyncApp-authored confirmations
- Upcoming: inbound attachments, links, and sprint/custom field expansion (see roadmap below)

### Reliability Features
- Real-time webhook sync (1-3 seconds)
- Hourly scheduled sync as backup (10-minute timeout)
- Automatic retry for pending issue links
- Recreate deleted issues option (scans target org and recreates any issues that were deleted)
- Attachment duplicate prevention (3-layer locking mechanism)
- Exponential backoff with rate limit (429) handling
- Parent/Epic sync depth limiting (max 5 levels)

### Admin Interface
- Multi-organization support
- Project filtering (select which projects to sync)
- User, field, and status mappings
- Issue export (JQL-based, up to 250 issues)
- Issue import (recreate from exported JSON)
- Sync activity dashboard with statistics
- API usage and rate limiting dashboard
- Manual sync controls

## Installation

### Prerequisites
- Node.js 20.x or 22.x
- Forge CLI: npm install -g @forge/cli
- Two Jira Cloud instances with admin access

### Setup

1. Clone the repository
   git clone https://github.com/SerdarAbali/jira-sync-connector.git
   cd jira-sync-connector/SyncApp

2. Install dependencies
   npm install --legacy-peer-deps

3. Login to Forge
   forge login

4. Deploy and install
   forge deploy
   forge install

5. Configure
   - Navigate to Jira Settings > Apps > Manage your apps
   - Find "Sync Connector" and click Configure
   - Add organization (URL, email, API token, project key)
   - Load remote and local data
   - Configure user, field, and status mappings
   - Save settings

## Configuration

### Organization Setup
Each organization requires:
- Remote Jira URL (e.g., https://target-org.atlassian.net)
- Admin email address
- API token (generate at https://id.atlassian.com/manage-profile/security/api-tokens)
- Target project key

### Sync Options
- Sync Comments: Include comments with author attribution
- Sync Attachments: Transfer file attachments
- Sync Links: Sync issue relationships
- Recreate Deleted Issues: Automatically recreate issues that were deleted in target org

### Mappings

User Mapping: Maps users between organizations for assignee/reporter fields. Unmapped users result in unassigned issues.

Field Mapping: Maps custom field IDs between organizations. Only mapped fields are synced.

Status Mapping: Maps status IDs when workflow names differ. Falls back to name matching if unmapped.

### Project Filtering
Control which projects sync:
1. Open Configuration tab
2. Click "Load Projects"
3. Select projects to sync
4. Save

If no projects are selected, all projects sync (backward compatible).

## Usage

### Sync Activity Tab

Statistics: Displays counts for issues synced, created, updated, recreated, and any errors.

Hourly Sync Timeline: Shows last run time and next scheduled run.

Quick Actions:
- Manual Sync: Force sync a specific issue by key
- Retry Pending Links: Retry any issue links waiting for both issues to exist
- Scan Deleted (when enabled): Scan all synced issues and recreate any that were deleted in target org

Issue Export/Import:
- Export: Run JQL query to download issues as JSON
- Import: Upload previously exported JSON to recreate issues

### Configuration Tab

Allowed Projects: Select which local projects can sync to this organization.

Sync Options: Toggle features (comments, attachments, links, sprints, recreate deleted).

Import/Export Settings: Backup or restore organization configuration.

### Mappings Tab

Configure user, field, and status mappings between source and target organizations.

## Architecture

SyncApp/
  src/
    index.js                    Entry point (pure exports)
    constants.js                Shared constants
    utils/                      Utility functions (adf, retry, validation)
    services/
      storage/
        kvs.js                  @forge/kvs wrapper
        mappings.js             Issue mapping storage
        flags.js                Sync flags & pending links
        stats.js                API usage & audit tracking
      jira/
        local-client.js         Source Jira (@forge/api)
        remote-client.js        Target Jira (fetch + Basic Auth)
      sync/                     Sync operations
      scheduled/                Scheduled sync
    resolvers/                  Admin UI API handlers
    triggers/                   Webhook handlers
  static/admin-page/            React + Atlaskit admin UI
  manifest.yml                  Forge configuration

### Triggers
- avi:jira:created:issue: New issue webhook
- avi:jira:updated:issue: Issue update webhook
- avi:jira:commented:issue: Comment webhook
- avi:jira-issue-link:created: Link created webhook
- avi:jira-issue-link:deleted: Link deleted webhook
- avi:jira:deleted:issue: Issue deleted webhook
- scheduledTrigger: Hourly sync (600s timeout)

### Storage (@forge/kvs)
Uses `@forge/kvs` with transactions for atomic operations.

**Configuration:**
- organizations: Array of org configurations
- syncOptions:{orgId}: Feature toggles per org
- userMappings:{orgId}, fieldMappings:{orgId}, statusMappings:{orgId}: Mappings per org
- secret:{orgId}:token: API tokens (secure storage)

**Issue Mappings:**
- {orgId}:local-to-remote:{issueKey}: Local → Remote key mapping
- {orgId}:remote-to-local:{remoteKey}: Remote → Local key mapping
- mapping-meta:{orgId}:{localKey}: Queryable mapping metadata

**Sync State:**
- syncing:{issueKey}: Sync-in-progress flag (TTL-based)
- pending-links:{issueKey}: Pending link queue
- pending-link-idx:{issueKey}: Queryable pending link index
- attachment-lock:{orgId}:{attachmentId}: Attachment upload locks

**Statistics:**
- scheduledSyncStats, webhookSyncStats, apiUsageStats, auditLog

## Development

Build UI:
   cd static/admin-page
   npm run build
   cd ../..

Deploy:
   forge deploy

View logs:
   forge logs

Local development:
   forge tunnel

## Troubleshooting

Issues not syncing:
- Check logs with forge logs
- Verify remote credentials in admin UI
- Ensure mappings are saved
- Check project is in allowed list

Attachments failing:
- Verify file is under 10MB
- Check download/upload permissions
- Ensure Sync Attachments is enabled

Links not syncing:
- Both linked issues must be synced first
- Pending links retry hourly
- Ensure Sync Links is enabled

Deleted issues not recreating:
- Enable Recreate Deleted Issues in Sync Options
- Click Scan & Recreate Now in Quick Actions
- Or wait for next hourly sync

Slow initial sync:
- Forge cold starts can take several seconds
- Subsequent syncs are faster (1-3 seconds)

## Two-Way Sync Status

- ✅ Incoming webhook/webtrigger pipeline with secret validation
- ✅ Reverse field/user/status mapping, parent mirroring, and local transitions
- ✅ Comment ingestion with deduplication, SyncApp loop guards, and per-comment tracking
- 🔄 Next: inbound attachments and links (reuse attachment/link services in reverse)
- 🔄 Next: inbound feature toggles in sync options plus diagnostics surfacing for webhook health
- 🔄 Next: Sprint/custom field transformations to close the parity gap

## Roadmap

Features under consideration for future releases:

### High Priority
- **Bi-directional Sync** - Two-way sync with conflict resolution
- **Field Transformation Rules** - Transform values during sync (e.g., "High" → "Critical")
- **JQL-based Sync Filters** - Sync only issues matching specific criteria

### Medium Priority
- **Bulk Initial Sync Wizard** - One-click sync all issues matching criteria
- **Worklog/Time Tracking Sync** - Full worklog entries, not just estimates
- **Component/Version Auto-Create** - Create missing components/versions in target
- **Sync Pause/Resume** - Temporarily pause without losing configuration
- **Email Notifications** - Alerts on sync failures or daily summaries

### Future Enhancements
- **Conflict Detection** - Alert when both sides changed, manual resolution
- **Audit Log UI** - Full history of who synced what and when
- **Watchers Sync** - Sync issue watchers between orgs
- **Label Mapping** - Rename labels during sync

## License

MIT License - See LICENSE file

## Support

- GitHub Issues: https://github.com/SerdarAbali/jira-sync-connector/issues
- Forge Documentation: https://developer.atlassian.com/platform/forge/
