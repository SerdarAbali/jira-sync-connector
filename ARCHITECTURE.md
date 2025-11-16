# Jira Sync Connector - Architecture Documentation

## Table of Contents
1. [System Overview](#system-overview)
2. [High-Level Architecture](#high-level-architecture)
3. [Component Design](#component-design)
4. [Data Flow](#data-flow)
5. [Security Architecture](#security-architecture)
6. [Scalability Considerations](#scalability-considerations)
7. [Technology Stack](#technology-stack)
8. [Design Decisions](#design-decisions)

---

## System Overview

The Jira Sync Connector is a serverless application built on Atlassian's Forge platform that enables real-time, bidirectional synchronization of issues between two or more Jira Cloud organizations. The system operates entirely within Atlassian's infrastructure, eliminating the need for external hosting or complex infrastructure management.

### Key Characteristics

- **Serverless**: Runs on Atlassian's Forge platform with automatic scaling
- **Event-Driven**: Responds to Jira events in real-time
- **Secure**: Leverages Forge's built-in security and OAuth mechanisms
- **Resilient**: Includes retry logic and error handling
- **Stateful**: Maintains sync state in Forge storage

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Jira Organization A (Primary)                 │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Jira Cloud Platform                   │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │   │
│  │  │   Issues     │  │   Projects   │  │   Users      │  │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘  │   │
│  │         │                  │                  │          │   │
│  │         └──────────────────┴──────────────────┘          │   │
│  │                          │                                │   │
│  │                    Event Bus                              │   │
│  │                          │                                │   │
│  └──────────────────────────┼────────────────────────────────┘   │
│                             │                                     │
│  ┌──────────────────────────▼────────────────────────────────┐   │
│  │              Forge App (Sync Connector)                   │   │
│  │  ┌────────────────────────────────────────────────────┐  │   │
│  │  │  Event Handlers                                     │  │   │
│  │  │  ├─ issue:created  → syncIssue()                   │  │   │
│  │  │  ├─ issue:updated  → syncIssue()                   │  │   │
│  │  │  └─ comment:created → syncComment()                │  │   │
│  │  └────────────────────────────────────────────────────┘  │   │
│  │                          │                                 │   │
│  │  ┌────────────────────────────────────────────────────┐  │   │
│  │  │  Core Logic Layer                                   │  │   │
│  │  │  ├─ Issue Transformer                              │  │   │
│  │  │  ├─ Loop Detection                                 │  │   │
│  │  │  ├─ Conflict Resolution                            │  │   │
│  │  │  └─ Error Handler                                  │  │   │
│  │  └────────────────────────────────────────────────────┘  │   │
│  │                          │                                 │   │
│  │  ┌────────────────────────────────────────────────────┐  │   │
│  │  │  Storage Layer                                      │  │   │
│  │  │  ├─ Configuration Store                            │  │   │
│  │  │  ├─ Sync State Store                               │  │   │
│  │  │  └─ Mapping Store                                  │  │   │
│  │  └────────────────────────────────────────────────────┘  │   │
│  │                          │                                 │   │
│  │  ┌────────────────────────────────────────────────────┐  │   │
│  │  │  Admin UI Module                                    │  │   │
│  │  │  ├─ Configuration Page                             │  │   │
│  │  │  ├─ Sync Status Dashboard                          │  │   │
│  │  │  └─ Logs Viewer                                    │  │   │
│  │  └────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────┬───────────────────────────────┘   │
└────────────────────────────────┼─────────────────────────────────┘
                                 │
                                 │ HTTPS / REST API
                                 │ (OAuth 2.0 / API Token)
                                 │
┌────────────────────────────────▼─────────────────────────────────┐
│                  Jira Organization B (Secondary)                  │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Jira Cloud Platform                   │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │   │
│  │  │   Issues     │  │   Projects   │  │   Workflows  │  │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────┘
```

---

## Component Design

### 1. Event Handlers Layer

Receives and processes events from Jira's event bus.

#### Issue Created Handler
```javascript
// Triggered when a new issue is created
exports.issueCreatedHandler = async (event) => {
  const issue = event.issue;
  const context = event.context;
  
  // Check if already synced (loop prevention)
  if (await isSyncedIssue(issue.id)) {
    return;
  }
  
  // Sync to remote
  await syncIssue(issue, context);
};
```

**Responsibilities:**
- Validate incoming events
- Check sync eligibility
- Invoke sync logic
- Handle errors gracefully

#### Issue Updated Handler
```javascript
// Triggered when an issue is updated
exports.issueUpdatedHandler = async (event) => {
  const { issue, changelog } = event;
  
  // Determine what changed
  const changes = parseChangelog(changelog);
  
  // Sync only relevant changes
  await syncChanges(issue, changes);
};
```

**Change Detection:**
- Summary updates
- Description updates
- Status transitions
- Field modifications
- Comment additions

### 2. Core Logic Layer

#### Issue Transformer

Converts Jira issues between different project schemas.

```javascript
class IssueTransformer {
  /**
   * Transform source issue to target format
   */
  transform(sourceIssue, targetProjectKey) {
    return {
      fields: {
        project: { key: targetProjectKey },
        summary: sourceIssue.fields.summary,
        description: this.transformDescription(sourceIssue.fields.description),
        issuetype: this.mapIssueType(sourceIssue.fields.issuetype),
        priority: this.mapPriority(sourceIssue.fields.priority),
        labels: this.transformLabels(sourceIssue.fields.labels),
        // Custom fields mapping
        ...this.mapCustomFields(sourceIssue.fields)
      }
    };
  }
  
  /**
   * Map issue types between projects
   */
  mapIssueType(sourceType) {
    const typeMapping = {
      'Story': 'Story',
      'Bug': 'Bug',
      'Task': 'Task',
      'Epic': 'Epic',
      'Subtask': 'Subtask'
    };
    return { name: typeMapping[sourceType.name] || 'Task' };
  }
}
```

**Features:**
- Issue type mapping
- Priority normalization
- Custom field transformation
- Label preservation
- Epic relationship handling

#### Loop Detection Engine

Prevents infinite sync loops between organizations.

```javascript
class LoopDetector {
  /**
   * Check if issue was synced from remote
   */
  async isSyncedIssue(issueId) {
    const properties = await this.getIssueProperties(issueId);
    return properties.hasOwnProperty('syncedFrom');
  }
  
  /**
   * Mark issue as synced
   */
  async markAsSynced(issueId, sourceIssueId, sourceOrg) {
    await this.setIssueProperty(issueId, 'syncedFrom', {
      sourceIssueId,
      sourceOrg,
      syncedAt: Date.now(),
      syncVersion: 1
    });
  }
  
  /**
   * Check if update should be synced
   */
  async shouldSync(issueId, changelog) {
    const syncMetadata = await this.getSyncMetadata(issueId);
    
    // Don't sync if update came from sync process
    if (syncMetadata.lastSyncTimestamp > changelog.timestamp) {
      return false;
    }
    
    return true;
  }
}
```

**Strategy:**
1. Tag synced issues with metadata
2. Track sync timestamps
3. Compare event timestamps
4. Skip sync for synced updates

#### Conflict Resolution

Handles conflicts when both sides are modified.

```javascript
class ConflictResolver {
  /**
   * Resolve conflicts using last-write-wins strategy
   */
  async resolve(localIssue, remoteIssue) {
    const localUpdate = new Date(localIssue.updated);
    const remoteUpdate = new Date(remoteIssue.updated);
    
    if (localUpdate > remoteUpdate) {
      // Local wins
      return {
        action: 'SYNC_TO_REMOTE',
        winner: 'LOCAL',
        data: localIssue
      };
    } else {
      // Remote wins
      return {
        action: 'SYNC_FROM_REMOTE',
        winner: 'REMOTE',
        data: remoteIssue
      };
    }
  }
  
  /**
   * Merge non-conflicting fields
   */
  async merge(localIssue, remoteIssue) {
    const merged = { ...remoteIssue };
    
    // Merge comments from both sides
    merged.comments = this.mergeComments(
      localIssue.comments,
      remoteIssue.comments
    );
    
    // Combine labels
    merged.labels = [...new Set([
      ...localIssue.labels,
      ...remoteIssue.labels
    ])];
    
    return merged;
  }
}
```

**Strategies:**
- Last-write-wins (default)
- Field-level merge
- Manual resolution queue
- Configurable rules

### 3. Storage Layer

#### Configuration Store

Stores sync configuration and credentials.

```javascript
{
  "remoteOrg": {
    "url": "https://target-org.atlassian.net",
    "email": "user@example.com",
    "apiToken": "encrypted_token_here",
    "projectKey": "PROJ"
  },
  "syncRules": {
    "issueTypes": ["Story", "Bug", "Task"],
    "syncComments": true,
    "syncAttachments": false,
    "bidirectional": false
  },
  "fieldMapping": {
    "customfield_10001": "customfield_20001",
    "customfield_10002": "customfield_20002"
  }
}
```

#### Sync State Store

Tracks sync status and relationships.

```javascript
{
  "issueMapping": {
    "PROJ-123": {
      "remoteIssueId": "REMOTE-456",
      "remoteIssueKey": "REMOTE-456",
      "lastSyncedAt": "2025-11-16T10:30:00Z",
      "syncVersion": 3,
      "syncStatus": "SYNCED"
    }
  },
  "syncMetrics": {
    "totalSynced": 150,
    "failedSyncs": 2,
    "lastSyncTime": "2025-11-16T10:30:00Z"
  }
}
```

#### Mapping Store

Maintains entity mappings between organizations.

```javascript
{
  "userMapping": {
    "user1@orgA.com": "user1@orgB.com",
    "user2@orgA.com": "user2@orgB.com"
  },
  "projectMapping": {
    "PROJA": "PROJB"
  },
  "statusMapping": {
    "To Do": "Backlog",
    "In Progress": "In Development",
    "Done": "Completed"
  }
}
```

### 4. Admin UI Module

Built with Forge UI Kit (React-based).

```javascript
// Configuration Page Component
const ConfigPage = () => {
  const [config, setConfig] = useState({});
  const [testing, setTesting] = useState(false);
  
  const testConnection = async () => {
    setTesting(true);
    try {
      const result = await invoke('testConnection', { config });
      if (result.success) {
        showFlag({ title: 'Connection successful!' });
      }
    } catch (error) {
      showFlag({ title: 'Connection failed', appearance: 'error' });
    }
    setTesting(false);
  };
  
  return (
    <Form onSubmit={handleSave}>
      <Field label="Remote Jira URL">
        <Textfield value={config.url} onChange={setUrl} />
      </Field>
      <Field label="Email">
        <Textfield value={config.email} onChange={setEmail} />
      </Field>
      <Field label="API Token">
        <Textfield type="password" value={config.token} />
      </Field>
      <Button appearance="primary" onClick={testConnection}>
        Test Connection
      </Button>
    </Form>
  );
};
```

**Features:**
- Configuration management
- Connection testing
- Sync status dashboard
- Error log viewer
- Manual sync trigger

---

## Data Flow

### Scenario 1: Issue Creation Flow

```
1. User creates issue in Org A
       │
       ▼
2. Jira emits issue:created event
       │
       ▼
3. Forge app receives event
       │
       ▼
4. Loop Detection: Check if synced
       │
       ├─ [Already synced] → Exit
       │
       └─ [Not synced] → Continue
              │
              ▼
5. Load configuration from storage
       │
       ▼
6. Transform issue (IssueTransformer)
       │
       ▼
7. Call Jira REST API (Org B)
   POST /rest/api/3/issue
       │
       ▼
8. Store mapping (Issue PROJ-123 → REMOTE-456)
       │
       ▼
9. Mark issue as synced (add property)
       │
       ▼
10. Log success metrics
```

### Scenario 2: Issue Update Flow

```
1. User updates issue in Org A
       │
       ▼
2. Jira emits issue:updated event with changelog
       │
       ▼
3. Forge app receives event
       │
       ▼
4. Check if should sync
   ├─ Is synced issue? → Check timestamps
   ├─ Is blacklisted field? → Skip
   └─ Should sync? → Continue
       │
       ▼
5. Load issue mapping (PROJ-123 → REMOTE-456)
       │
       ▼
6. Parse changelog
   ├─ Summary changed → Sync
   ├─ Status changed → Map & sync
   ├─ Comment added → Sync comment
   └─ Custom field → Check mapping
       │
       ▼
7. Transform changes
       │
       ▼
8. Call Jira REST API (Org B)
   PUT /rest/api/3/issue/REMOTE-456
       │
       ▼
9. Update sync timestamp
       │
       ▼
10. Log operation
```

### Scenario 3: Comment Sync Flow

```
1. User adds comment in Org A
       │
       ▼
2. Comment created event fired
       │
       ▼
3. Check if parent issue is synced
       │
       ├─ [Not synced] → Exit
       │
       └─ [Synced] → Continue
              │
              ▼
4. Get remote issue ID from mapping
       │
       ▼
5. Transform comment body
   ├─ Add attribution prefix
   ├─ Convert mentions
   └─ Format markdown
       │
       ▼
6. POST comment to remote issue
   /rest/api/3/issue/REMOTE-456/comment
       │
       ▼
7. Store comment mapping
       │
       ▼
8. Mark comment as synced
```

---

## Security Architecture

### Authentication & Authorization

#### 1. Forge App Authentication
```
Forge App (Org A) ←→ Atlassian Platform
         │
         └─ Uses Forge's built-in OAuth
         └─ Scoped permissions
         └─ Automatic token refresh
```

#### 2. Remote Jira Authentication
```
Forge App ←→ Remote Jira (Org B)
     │
     ├─ Basic Auth (Email + API Token)
     ├─ OR OAuth 2.0 (future)
     └─ Credentials stored in Forge secure storage
```

### Permission Model

**Required Forge Scopes:**
```yaml
permissions:
  scopes:
    - read:jira-work        # Read issues, projects
    - write:jira-work       # Create/update issues
    - storage:app           # Store config & state
    - read:jira-user        # User information
  external:
    fetch:
      backend:
        - '*.atlassian.net' # Call external Jira APIs
```

### Data Protection

#### Sensitive Data Handling
```javascript
// API tokens are encrypted at rest
const storeCredentials = async (config) => {
  await storage.setSecret('apiToken', config.apiToken);
  await storage.set('config', {
    url: config.url,
    email: config.email,
    // apiToken NOT stored in plain config
  });
};

// Retrieval requires secure access
const getCredentials = async () => {
  const config = await storage.get('config');
  const apiToken = await storage.getSecret('apiToken');
  return { ...config, apiToken };
};
```

#### Data Minimization
- Only sync configured fields
- Exclude sensitive fields by default
- User-configurable field blacklist
- No logging of credentials

### Security Best Practices

1. **Credential Management**
   - API tokens never logged
   - Stored in Forge secure storage
   - Rotatable without code changes
   - Scoped to minimum permissions

2. **Input Validation**
   - Validate all API responses
   - Sanitize user input
   - Escape special characters
   - Type checking on all data

3. **Error Handling**
   - No sensitive data in error messages
   - Generic errors to users
   - Detailed logs (without credentials)
   - Rate limit handling

4. **Audit Trail**
   - Log all sync operations
   - Track user actions
   - Monitor API usage
   - Alert on anomalies

---

## Scalability Considerations

### Current Limitations

| Resource | Limit | Impact |
|----------|-------|--------|
| Function Runtime | 25 seconds | Must complete sync quickly |
| Storage | 1 GB per app | Limit stored mappings |
| API Rate Limit | 100 req/min | Throttle sync operations |
| Memory | 256 MB | Optimize data structures |

### Scaling Strategies

#### 1. Batch Processing
```javascript
// Instead of syncing immediately
async function queueForSync(issueId) {
  const queue = await storage.get('syncQueue') || [];
  queue.push({ issueId, timestamp: Date.now() });
  await storage.set('syncQueue', queue);
}

// Process in batches
async function processSyncQueue() {
  const queue = await storage.get('syncQueue') || [];
  const batch = queue.splice(0, 10); // Process 10 at a time
  
  for (const item of batch) {
    await syncIssue(item.issueId);
  }
  
  await storage.set('syncQueue', queue);
}
```

#### 2. Caching
```javascript
// Cache project metadata
const projectCache = new Map();

async function getProject(projectKey) {
  if (projectCache.has(projectKey)) {
    return projectCache.get(projectKey);
  }
  
  const project = await api.getProject(projectKey);
  projectCache.set(projectKey, project);
  return project;
}
```

#### 3. Incremental Sync
```javascript
// Only sync changed fields
async function syncChanges(issueKey, changelog) {
  const changedFields = parseChangelog(changelog);
  const updatePayload = {};
  
  for (const field of changedFields) {
    updatePayload[field.name] = field.newValue;
  }
  
  // Partial update instead of full sync
  await api.updateIssue(remoteIssueKey, updatePayload);
}
```

#### 4. Deduplication
```javascript
// Prevent duplicate syncs
const inFlightSyncs = new Set();

async function syncWithDedup(issueKey) {
  if (inFlightSyncs.has(issueKey)) {
    return; // Already syncing
  }
  
  inFlightSyncs.add(issueKey);
  try {
    await syncIssue(issueKey);
  } finally {
    inFlightSyncs.delete(issueKey);
  }
}
```

### Performance Optimization

1. **Minimize API Calls**
   - Batch requests where possible
   - Cache frequently accessed data
   - Use field-specific updates

2. **Optimize Storage Access**
   - Group related data
   - Minimize storage reads/writes
   - Use efficient data structures

3. **Async Processing**
   - Non-blocking operations
   - Promise.all() for parallel tasks
   - Queue non-critical operations

---

## Technology Stack

### Core Platform
- **Atlassian Forge**: Serverless hosting platform
- **Node.js 22.x**: Runtime environment (ARM64)
- **JavaScript/ES6+**: Primary language

### Frontend (Admin UI)
- **Forge UI Kit 2**: React-based UI components
- **@forge/react**: Forge React bridge
- **Atlassian Design System**: UI components

### APIs & Libraries
- **Jira REST API v3**: Issue management
- **Forge Storage API**: Persistent storage
- **Forge Fetch API**: HTTP requests

### Development Tools
- **Forge CLI**: Deployment and tunneling
- **npm**: Package management
- **Git**: Version control
- **ESLint**: Code linting

### Testing
- **Jest**: Unit testing framework
- **Forge Testing Library**: Integration tests
- **Manual QA**: End-to-end testing

---

## Design Decisions

### Decision 1: Forge Platform vs. External Hosting

**Chosen:** Forge Platform

**Rationale:**
- No infrastructure management
- Built-in security and OAuth
- Automatic scaling
- Lower operational costs
- Direct access to Jira events
- Native Jira integration

**Trade-offs:**
- Function runtime limits
- Storage constraints
- Platform-specific APIs
- Less control over infrastructure

### Decision 2: REST API vs. Webhooks

**Chosen:** Forge Events + REST API

**Rationale:**
- More reliable than webhooks
- No need for endpoint management
- Built-in retry mechanism
- Direct event access

**Trade-offs:**
- Limited to Forge-supported events
- Can't subscribe to all event types
- Potential latency

### Decision 3: Unidirectional vs. Bidirectional Sync

**Chosen:** Unidirectional (Phase 1), Bidirectional (Planned)

**Rationale:**
- Simpler loop prevention
- Easier conflict resolution
- Reduced complexity
- Clear data flow

**Future:** Bidirectional with advanced conflict resolution

### Decision 4: Storage Strategy

**Chosen:** Forge Storage API

**Rationale:**
- No external database needed
- Encrypted at rest
- Simple key-value API
- Suitable for configuration

**Trade-offs:**
- 1 GB storage limit
- No complex queries
- Eventually consistent

### Decision 5: Issue Mapping Strategy

**Chosen:** Issue Properties + Storage

**Rationale:**
- Persistent across app updates
- Queryable from either side
- No external dependency
- Survives app reinstall

**Implementation:**
```javascript
// Store mapping in both places
await storage.set(`mapping:${localIssueKey}`, remoteIssueKey);
await api.setIssueProperty(localIssueId, 'syncedTo', {
  remoteKey: remoteIssueKey,
  remoteOrg: 'orgB'
});
```

### Decision 6: Error Handling Strategy

**Chosen:** Graceful Degradation

**Rationale:**
- Don't block user operations
- Log and continue
- Retry transient failures
- Alert on persistent errors

**Implementation:**
```javascript
try {
  await syncIssue(issue);
} catch (error) {
  if (isTransient(error)) {
    await queueForRetry(issue);
  } else {
    await logPermanentFailure(issue, error);
  }
  // Don't throw - allow issue creation to succeed
}
```

---

## Future Architecture Enhancements

### Phase 2: Multi-Organization Support
```
     Org A ←→ Sync Hub ←→ Org B
                 ↕
               Org C
```

### Phase 3: Message Queue
- Implement job queue for reliability
- Handle bursts of updates
- Prioritize sync operations

### Phase 4: Analytics Engine
- Track sync performance
- Identify bottlenecks
- Usage metrics
- Cost optimization

### Phase 5: Advanced Conflict Resolution
- Three-way merge algorithm
- User-defined resolution rules
- Manual conflict queue
- Conflict notification system

---

## Conclusion

This architecture provides a solid foundation for reliable issue synchronization while remaining flexible for future enhancements. The event-driven, serverless design ensures scalability and maintainability, while the modular component structure allows for incremental improvements and feature additions.

Key strengths:
- ✅ Serverless and scalable
- ✅ Secure by design
- ✅ Event-driven architecture
- ✅ Modular and maintainable
- ✅ Well-defined data flows

For questions or suggestions about the architecture, please open an issue or discussion on GitHub.
