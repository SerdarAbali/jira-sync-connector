# Two-Way Sync Flow & Behavior Guide

This document details the visual flow and behavior of the Two-Way Sync system between **Org A (Local/Hub)** and **Org B (Remote/Spoke)**.

## 1. High-Level Architecture

The system uses a **Hub-and-Spoke** model. Org A (where the app is installed) acts as the central hub. Org B is a passive participant that uses standard Jira Webhooks to communicate back to Org A.

```mermaid
graph TD
    subgraph Org A [Org A: Local Hub]
        App[Forge App]
        DB[(Storage)]
        LocalJira[Jira Instance]
    end

    subgraph Org B [Org B: Remote Spoke]
        RemoteJira[Jira Instance]
        Webhook[System Webhook]
    end

    %% Outgoing Flow
    LocalJira -- "Event (Issue Created/Updated)" --> App
    App -- "1. Check Filter & Map" --> DB
    App -- "2. REST API (PUT/POST)" --> RemoteJira

    %% Incoming Flow
    RemoteJira -- "3. Webhook (JSON)" --> App
    App -- "4. Validate Secret & Loop Check" --> DB
    App -- "5. REST API (PUT/POST)" --> LocalJira

    %% Loop Prevention
    Webhook -. "JQL Filter (Exclude Sync User)" .-> RemoteJira
```

---

## 2. Setup & Handshake Process

Before sync can occur, a secure connection must be established.

### Step 1: Org A Configuration
1.  **Admin A** installs the app.
2.  **Admin A** creates an Organization entry for Org B.
3.  **Admin A** sets "Sync Direction" to **Two-Way (Bidirectional)**.
4.  **App** generates a unique `Incoming Webhook URL` and `Secret`.

### Step 2: Org B Configuration (Manual Handshake)
1.  **Admin A** shares the `Incoming Webhook URL` and `JQL Filter` with **Admin B**.
2.  **Admin B** creates a **System Webhook** in Org B's Jira settings.
    *   **URL**: `<Incoming Webhook URL>?secret=<Secret>`
    *   **JQL**: `project = "SHARED" AND creator != "sync_user" AND updatedBy != "sync_user"`
    *   **Events**: Issue Created, Updated, Deleted.
3.  **Admin B** creates an **API Token** and shares it with **Admin A**.
4.  **Admin A** enters the API Token into the App configuration.

---

## 3. Sync Lifecycle: Outgoing (Org A → Org B)

When a user in Org A updates an issue, the app pushes changes to Org B.

```mermaid
sequenceDiagram
    participant UserA as User (Org A)
    participant App as Forge App
    participant Store as Storage (KVS)
    participant Remote as Org B (Jira)

    UserA->>App: Update Issue (Summary/Desc/Status)
    App->>Store: Check "Is Syncing?" Flag
    alt Flag is Set (Loop Detected)
        App-->>UserA: Stop (Ignore Echo)
    else Flag is Clear
        App->>Store: Set "Syncing" Flag (TTL 60s)
        App->>Remote: PUT /rest/api/3/issue/{remoteKey}
        Remote-->>App: 204 Success
        App->>Store: Clear "Syncing" Flag
    end
```

### Entity Support (Outgoing)

| Entity | Behavior | Notes |
| :--- | :--- | :--- |
| **Fields** | Syncs Summary, Description, Priority, Assignee. | Assignee requires email mapping. |
| **Status** | Syncs Transitions. | Requires matching transition names (e.g., "Done" → "Done"). |
| **Comments** | Syncs all comments. | Adds header: `[Comment from Org A - User: Serdar]` |
| **Attachments** | Syncs all attachments. | Replaces media IDs in description to fix broken images. |
| **Links** | Syncs "Blocks", "Relates to", etc. | Queues links if the target issue doesn't exist yet. |
| **Subtasks** | Syncs Parent/Child relationship. | Recursively syncs parent if missing (up to depth 1). |
| **Epics** | Syncs Epic Link. | Recursively syncs Epic if missing. |

---

## 4. Sync Lifecycle: Incoming (Org B → Org A)

When a user in Org B updates an issue, Org B sends a webhook to Org A.

```mermaid
sequenceDiagram
    participant UserB as User (Org B)
    participant Webhook as System Webhook
    participant App as Forge App (Webtrigger)
    participant Local as Org A (Jira)

    UserB->>Webhook: Update Issue
    Webhook->>Webhook: Check JQL Filter
    alt User is Sync App
        Webhook-->>Webhook: Stop (Loop Prevention)
    else User is Human
        Webhook->>App: POST /webtrigger (JSON)
        App->>App: Validate Secret
        App->>App: Check "Is Syncing?" Flag
        alt Flag is Set
            App-->>Webhook: 200 OK (Ignore Echo)
        else Flag is Clear
            App->>Local: PUT /rest/api/3/issue/{localKey}
            Local-->>App: 204 Success
        end
    end
```

### Entity Support (Incoming - Current Coverage)

| Entity | Behavior | Notes |
| :--- | :--- | :--- |
| **Fields** | Mirrors summary, description, priority, labels, due date, components, fix versions, versions, and time tracking. | Uses the same field mapping config as outbound sync; skips rank metadata automatically. |
| **Status** | Synced via `transitionLocalIssue`. | Reverse status mappings (ID or name based) drive the transition that is closest to the remote status. |
| **Assignee / Reporter** | Synced when user mappings exist. | Falls back to logging a warning and leaves the field untouched if no mapping exists. |
| **Hierarchy** | Parent/Epic relationships carried over. | If the parent already exists locally it is linked; otherwise the child remains standalone until the parent syncs. |
| **Comments** | Synced with author attribution and deduplication. | Skips app-authored comments and replays using `[Comment from OrgName - User: ...]` headers. |
| **Attachments** | Synced (Remote → Local) | Uses attachment service locks and deduplication. |
| **Links** | Synced (Remote → Local) | Supports blocks, relates to, duplicates, etc. |
| **Creation** | Supported | Creating an issue in Org B creates it in Org A (target project defined in org config). |
| **Deletion** | Supported | Deleting an issue in Org B deletes it in Org A. |

---

## 5. Loop Prevention Strategy

The system uses a **Defense-in-Depth** approach to prevent infinite sync loops.

### Layer 1: Source Filtering (The Firewall)
*   **Mechanism**: The JQL Filter in Org B's Webhook configuration.
*   **Rule**: `... AND updatedBy != "sync_user_account_id"`
*   **Effect**: Org B **never** sends a webhook for a change that Org A just made. This stops the loop before it starts.

### Layer 2: Internal Flags (The Safety Net)
*   **Mechanism**: `isSyncing` flag in Forge Storage.
*   **Rule**: Before writing to Jira, the app sets a flag `syncing:ISSUE-123`.
*   **Effect**: If Layer 1 fails and a webhook comes back, the app sees the flag and ignores the request.

### Layer 3: Comment Deduplication & App-Author Guard
* **Mechanism**: Incoming comment IDs are stored under `incoming-comment:{orgId}:{commentId}` and rejected on repeat.
* **Rule**: Any comment authored by the SyncApp (accountType `app`) is ignored to prevent round-trips.
* **Effect**: Human-authored comments mirror once per issue, even if Jira retries the webhook.

---

## 6. Conflict Resolution

*   **Strategy**: "Last Write Wins"
*   **Logic**: The system assumes that the most recent event (whether from Org A or Org B) represents the current truth.
*   **Latency**: Webhooks typically arrive within 1-3 seconds. Race conditions are rare but possible; the `isSyncing` flag helps mitigate them by locking the issue during active sync operations.

---

## 7. Roadmap to Full Two-Way Parity

### Recently Shipped
- Remote payload retrieval per webhook to ensure complete field snapshots
- Reverse user/field/status mapping inside `buildCreatePayload`/`buildUpdatePayload`
- Parent/epic mirroring and inbound status transitions via `transitionLocalIssue`
- Incoming comment ingestion with deduplication keys and SyncApp-author filtering

### Next Steps
1. **Inbound Attachments & Links** – Reuse the outbound attachment/link services in reverse, including lock keys and pending link queues.
2. **Inbound Feature Toggles & Diagnostics** – Surface dedicated `incoming*` toggles in Sync Options plus webhook health indicators in the Diagnostics panel.
3. **Conflict Messaging** – Extend stats/audit resolvers to highlight when Org A overrides Org B (and vice versa) for easier troubleshooting.

Achieving these items brings Org A and Org B to near-parity while keeping the existing loop-prevention safeguards intact.
