# Two-Way Sync Architecture & Handshake Protocol

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
    *   JQL: `project = "REMOTE_PROJ"` (This satisfies the "select what to expose" requirement).
    *   Events: Issue Created, Updated, Deleted.

### Scenario B: Remote Side has "Sync App" (Symmetric)
1.  **Local Admin**: Generates "Connection Invitation" (JSON blob).
2.  **Remote Admin**: Pastes Invitation into their App.
3.  **Remote App**: Validates and asks Remote Admin to select "Allowed Projects" for this connection.
4.  **Remote App**: Configures itself to push changes to Local App's Webhook.

*For MVP, we will focus on Scenario A (Universal Compatibility), as it doesn't require the remote side to install our app, but still gives them full control via standard Jira Webhook filters.*

## 4. Loop Prevention (Failsafe)
To prevent infinite loops (A→B→A→B...), we will implement a "Echo Detection" mechanism.

1.  **Outgoing (Local → Remote)**:
    *   App sets `syncing:ISSUE-123` flag in KVS before pushing.
    *   App pushes update to Remote.
    *   Remote Jira fires Webhook back to Local (Echo).
    *   App clears `syncing:ISSUE-123` flag.

2.  **Incoming (Remote → Local)**:
    *   Webtrigger receives webhook.
    *   **CHECK 1**: Is `syncing:ISSUE-123` flag set?
        *   YES: It's an echo of our own change. **IGNORE**.
        *   NO: It's a genuine remote change. **PROCESS**.
    *   **ACTION**:
        *   Set `syncing:ISSUE-123` flag (to prevent Local Trigger from firing back).
        *   Update Local Issue.
        *   Clear `syncing:ISSUE-123` flag.

## 5. Implementation Plan

### Phase 1: Configuration & UI
- [ ] Update `addOrganization` / `updateOrganization` resolvers to support `syncDirection`.
- [ ] Generate `incomingSecret` for new/existing orgs.
- [ ] Add UI in Admin Panel to show "Incoming Webhook URL" (only if Two-Way is enabled).

### Phase 2: Incoming Webhook (Webtrigger)
- [ ] Create `src/webtriggers/incoming-webhook.js`.
- [ ] Implement Secret validation.
- [ ] Implement Loop Prevention check (`isSyncing`).

### Phase 3: Reverse Sync Logic
- [ ] Implement `handleRemoteEvent` in `src/services/sync/incoming-sync.js`.
- [ ] Implement `createLocalIssue` and `updateLocalIssue` in `local-client.js`.
- [ ] Implement `reverseMapping` (Remote Fields → Local Fields).

### Phase 4: Testing
- [ ] Unit tests for Loop Prevention logic.
- [ ] System test for bidirectional flow.
