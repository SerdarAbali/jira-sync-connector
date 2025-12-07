# Two-Way Sync Architecture & Handshake Protocol

# Disclaimer
Always check official Forge docs for compliancy https://developer.atlassian.com/platform/forge/

## 1. Overview
To support bidirectional synchronization while maintaining security and granular control, we will implement a "Handshake Protocol" and an optional "Two-Way" configuration mode.

## 2. Configuration Updates
The Organization configuration object will be extended:

```javascript
{
  id: "org-123",
  name: "Partner Org",
  // ... existing fields ...
  
  // NEW FIELDS
  syncDirection: "push" | "bidirectional", // Default: "push"
  
  // Incoming Webhook Security (for Two-Way)
  incomingSecret: "generated-uuid-secret", 
  incomingWebhookUrl: "https://.../webtrigger/...",
  
  // Handshake Status
  handshakeStatus: "none" | "pending" | "active",
  remoteHandshakeToken: "..." // Token provided by remote admin
}
```

## 3. The Handshake Protocol (Manual Exchange)
Since we cannot assume the app is installed on the remote side (or that we have admin access to it), the handshake relies on the admins exchanging a secure token/URL.

### Scenario A: Remote Side is "Just Jira" (No App)
1.  **Local Admin**: Enables "Two-Way Sync".
2.  **App**: Generates `incomingWebhookUrl` + `incomingSecret`.
3.  **Local Admin**: Copies this URL.
4.  **Remote Admin**: Manually creates a System Webhook in Remote Jira.
    *   URL: `<incomingWebhookUrl>?secret=<incomingSecret>`
    *   JQL: `project = "REMOTE_PROJ" AND creator != "sync_user_account_id" AND updatedBy != "sync_user_account_id"`
        *   *Note: This JQL filter is the PRIMARY loop prevention mechanism. It ensures the webhook never fires for changes made by the sync app itself.*
    *   Events: Issue Created, Updated, Deleted.

### Scenario B: Remote Side has "Sync App" (Symmetric)
1.  **Local Admin**: Generates "Connection Invitation" (JSON blob).
2.  **Remote Admin**: Pastes Invitation into their App.
3.  **Remote App**: Validates and asks Remote Admin to select "Allowed Projects" for this connection.
4.  **Remote App**: Configures itself to push changes to Local App's Webhook.

*For MVP, we will focus on Scenario A (Universal Compatibility), as it doesn't require the remote side to install our app, but still gives them full control via standard Jira Webhook filters.*

## 4. Loop Prevention & Reliability

### Primary Defense: Source Filtering (JQL)
The most robust way to prevent loops is to stop the echo at the source. The Remote Admin MUST configure the webhook JQL to exclude the user account that the Sync App uses to authenticate.
*   **JQL**: `... AND updatedBy != "557058:..."`
*   This prevents the Remote Jira from ever sending a webhook for a change that *we* just made.

### Secondary Defense: Echo Detection (Internal Flag)
As a failsafe for race conditions or misconfiguration:
1.  **Outgoing (Local → Remote)**:
    *   App sets `syncing:ISSUE-123` flag in KVS (TTL: 60s).
    *   App pushes update to Remote.
    *   (If JQL fails) Remote Jira fires Webhook back to Local.
    *   App clears `syncing:ISSUE-123` flag.

2.  **Incoming (Remote → Local)**:
    *   Webtrigger receives webhook.
    *   **CHECK 1**: Is `syncing:ISSUE-123` flag set?
        *   YES: It's an echo. **IGNORE**.
        *   NO: It's a genuine remote change. **PROCESS**.

### Idempotency (Deduplication)
Jira may send the same webhook multiple times.
*   **Mechanism**: Store `processed-webhook:{webhookEventId}` in KVS with 5-minute TTL.
*   **Check**: If ID exists, return `200 OK` immediately and skip processing.

### Conflict Resolution
*   **Policy**: "Last Write Wins" based on webhook arrival time.
*   Since webhooks are real-time, we assume the latest event represents the current truth.

## 5. Implementation Plan

### Phase 1: Configuration & UI
- [x] Update `addOrganization` / `updateOrganization` resolvers to support `syncDirection`.
- [x] Generate `incomingSecret` for new/existing orgs.
- [x] Add UI in Admin Panel to show "Incoming Webhook URL" (only if Two-Way is enabled).

### Phase 2: Incoming Webhook (Webtrigger)
- [x] Create `src/webtriggers/incoming-webhook.js`.
- [x] Implement Secret validation.
- [x] Implement Idempotency check (`webhookEventId`).
- [x] Implement Loop Prevention check (`isSyncing`).

### Phase 3: Reverse Sync Logic
- [x] Implement `handleRemoteEvent` in `src/services/sync/incoming-sync.js`.
- [x] Implement `createLocalIssue` and `updateLocalIssue` in `local-client.js`.
- [x] Implement `reverseMapping` (Remote Fields → Local Fields).
- [x] Implement Two-Way Attachment Sync.
- [x] Implement Two-Way Link Sync.
- [ ] **Note**: Ensure `remoteToLocalMappings` are respected if strict reversal isn't possible.

### Phase 4: Testing
- [ ] Unit tests for Loop Prevention logic.
- [ ] System test for bidirectional flow.
