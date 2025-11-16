# API Documentation

This document describes the internal API structure and external API interactions of the Jira Sync Connector.

## Table of Contents
1. [Internal API](#internal-api)
2. [Jira REST API Usage](#jira-rest-api-usage)
3. [Storage API](#storage-api)
4. [Forge Platform APIs](#forge-platform-apis)
5. [Error Codes](#error-codes)

---

## Internal API

### Sync Service API

#### `syncIssue(issue, config)`

Synchronizes an issue from source to target Jira organization.

**Parameters:**
```javascript
{
  issue: {
    id: string,           // Issue ID
    key: string,          // Issue key (e.g., 'PROJ-123')
    fields: {
      summary: string,
      description: string,
      issuetype: Object,
      priority: Object,
      status: Object,
      // ... other fields
    }
  },
  config: {
    remoteUrl: string,    // Target Jira URL
    email: string,        // API user email
    apiToken: string,     // API token
    projectKey: string    // Target project key
  }
}
```

**Returns:**
```javascript
Promise<{
  success: boolean,
  remoteIssueKey: string,
  remoteIssueId: string,
  syncTimestamp: number
}>
```

**Example:**
```javascript
const result = await syncIssue(issue, config);
console.log(`Synced to: ${result.remoteIssueKey}`);
```

**Throws:**
- `ValidationError` - Invalid issue or config
- `APIError` - Remote API call failed
- `StorageError` - Failed to save sync state

---

#### `syncComment(issueKey, comment, config)`

Synchronizes a comment to the remote issue.

**Parameters:**
```javascript
{
  issueKey: string,      // Source issue key
  comment: {
    id: string,
    body: string,
    author: {
      displayName: string,
      emailAddress: string
    },
    created: string
  },
  config: Object         // Sync configuration
}
```

**Returns:**
```javascript
Promise<{
  success: boolean,
  remoteCommentId: string
}>
```

---

#### `updateIssueStatus(issueKey, newStatus, config)`

Updates the status of a synced issue.

**Parameters:**
```javascript
{
  issueKey: string,      // Source issue key
  newStatus: {
    id: string,
    name: string
  },
  config: Object
}
```

**Returns:**
```javascript
Promise<{
  success: boolean,
  transitionId: string
}>
```

---

### Transformation Service API

#### `transformIssue(sourceIssue, targetProjectKey, fieldMapping)`

Transforms an issue from source format to target format.

**Parameters:**
```javascript
{
  sourceIssue: Object,   // Source Jira issue
  targetProjectKey: string,
  fieldMapping: {
    [sourceField]: targetField  // Custom field mappings
  }
}
```

**Returns:**
```javascript
{
  fields: {
    project: { key: string },
    summary: string,
    description: string,
    issuetype: { name: string },
    priority: { name: string },
    // ... mapped fields
  }
}
```

**Example:**
```javascript
const transformed = transformIssue(issue, 'TARGET', {
  'customfield_10001': 'customfield_20001'
});
```

---

#### `mapIssueType(sourceType, mapping)`

Maps issue type from source to target.

**Parameters:**
```javascript
{
  sourceType: {
    id: string,
    name: string
  },
  mapping: {
    [sourceName]: targetName
  }
}
```

**Returns:**
```javascript
{
  name: string  // Mapped issue type name
}
```

**Default Mappings:**
```javascript
{
  'Story': 'Story',
  'Bug': 'Bug',
  'Task': 'Task',
  'Epic': 'Epic',
  'Subtask': 'Sub-task'
}
```

---

### Loop Detection API

#### `isSyncedIssue(issueId)`

Checks if an issue was created by the sync process.

**Parameters:**
```javascript
{
  issueId: string  // Issue ID to check
}
```

**Returns:**
```javascript
Promise<boolean>  // true if issue is synced
```

---

#### `markAsSynced(issueId, metadata)`

Marks an issue as synced with metadata.

**Parameters:**
```javascript
{
  issueId: string,
  metadata: {
    sourceIssueKey: string,
    sourceOrg: string,
    syncedAt: number,
    syncVersion: number
  }
}
```

**Returns:**
```javascript
Promise<void>
```

---

#### `getSyncMetadata(issueId)`

Retrieves sync metadata for an issue.

**Parameters:**
```javascript
{
  issueId: string
}
```

**Returns:**
```javascript
Promise<{
  sourceIssueKey: string,
  sourceOrg: string,
  syncedAt: number,
  syncVersion: number
}>
```

---

### Storage Service API

#### `getConfig()`

Retrieves the sync configuration.

**Returns:**
```javascript
Promise<{
  remoteUrl: string,
  email: string,
  apiToken: string,  // Encrypted
  projectKey: string,
  syncRules: {
    issueTypes: string[],
    syncComments: boolean,
    syncAttachments: boolean
  },
  fieldMapping: Object
}>
```

---

#### `saveConfig(config)`

Saves the sync configuration.

**Parameters:**
```javascript
{
  remoteUrl: string,
  email: string,
  apiToken: string,
  projectKey: string,
  syncRules: Object,
  fieldMapping: Object
}
```

**Returns:**
```javascript
Promise<void>
```

---

#### `getIssueMapping(sourceKey)`

Gets the remote issue key for a source issue.

**Parameters:**
```javascript
{
  sourceKey: string  // Source issue key
}
```

**Returns:**
```javascript
Promise<{
  remoteKey: string,
  remoteId: string,
  lastSynced: number
}>
```

---

#### `saveIssueMapping(sourceKey, remoteKey, metadata)`

Saves the mapping between source and remote issues.

**Parameters:**
```javascript
{
  sourceKey: string,
  remoteKey: string,
  metadata: {
    remoteId: string,
    syncedAt: number,
    syncVersion: number
  }
}
```

---

## Jira REST API Usage

The app uses Jira Cloud REST API v3 for external communication.

### Authentication

```javascript
// Basic Auth with API Token
const authHeader = Buffer.from(
  `${email}:${apiToken}`
).toString('base64');

const headers = {
  'Authorization': `Basic ${authHeader}`,
  'Content-Type': 'application/json'
};
```

### Endpoints Used

#### Create Issue
```
POST /rest/api/3/issue
```

**Request Body:**
```json
{
  "fields": {
    "project": { "key": "PROJ" },
    "summary": "Issue summary",
    "description": {
      "type": "doc",
      "version": 1,
      "content": [...]
    },
    "issuetype": { "name": "Story" },
    "priority": { "name": "Medium" }
  }
}
```

**Response:**
```json
{
  "id": "10001",
  "key": "PROJ-123",
  "self": "https://your-domain.atlassian.net/rest/api/3/issue/10001"
}
```

---

#### Update Issue
```
PUT /rest/api/3/issue/{issueIdOrKey}
```

**Request Body:**
```json
{
  "fields": {
    "summary": "Updated summary",
    "description": {
      "type": "doc",
      "version": 1,
      "content": [...]
    }
  }
}
```

---

#### Get Issue
```
GET /rest/api/3/issue/{issueIdOrKey}?expand=changelog
```

**Response:**
```json
{
  "id": "10001",
  "key": "PROJ-123",
  "fields": {
    "summary": "Issue summary",
    "status": { "name": "In Progress" },
    "priority": { "name": "High" },
    ...
  },
  "changelog": {
    "histories": [...]
  }
}
```

---

#### Add Comment
```
POST /rest/api/3/issue/{issueIdOrKey}/comment
```

**Request Body:**
```json
{
  "body": {
    "type": "doc",
    "version": 1,
    "content": [{
      "type": "paragraph",
      "content": [{
        "type": "text",
        "text": "Comment text"
      }]
    }]
  }
}
```

---

#### Transition Issue
```
POST /rest/api/3/issue/{issueIdOrKey}/transitions
```

**Request Body:**
```json
{
  "transition": {
    "id": "31"
  },
  "fields": {}
}
```

---

#### Get Transitions
```
GET /rest/api/3/issue/{issueIdOrKey}/transitions
```

**Response:**
```json
{
  "transitions": [
    {
      "id": "31",
      "name": "In Progress",
      "to": {
        "id": "3",
        "name": "In Progress"
      }
    }
  ]
}
```

---

#### Set Issue Property
```
PUT /rest/api/3/issue/{issueIdOrKey}/properties/{propertyKey}
```

**Request Body:**
```json
{
  "syncedFrom": {
    "sourceKey": "PROJ-123",
    "sourceOrg": "orgA",
    "timestamp": 1700000000000
  }
}
```

---

#### Get Issue Property
```
GET /rest/api/3/issue/{issueIdOrKey}/properties/{propertyKey}
```

**Response:**
```json
{
  "key": "syncedFrom",
  "value": {
    "sourceKey": "PROJ-123",
    "sourceOrg": "orgA",
    "timestamp": 1700000000000
  }
}
```

---

### Rate Limiting

Jira Cloud API has rate limits:
- **Standard**: 100 requests per minute per user
- **Burst**: Can spike to 1000 requests in short bursts

**Handling Rate Limits:**
```javascript
async function apiCall(url, options, retries = 3) {
  try {
    const response = await fetch(url, options);
    
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      await sleep(retryAfter * 1000);
      return apiCall(url, options, retries - 1);
    }
    
    return response;
  } catch (error) {
    if (retries > 0) {
      await sleep(1000);
      return apiCall(url, options, retries - 1);
    }
    throw error;
  }
}
```

---

## Storage API

Forge provides a key-value storage API.

### Basic Operations

#### Set Value
```javascript
import { storage } from '@forge/api';

await storage.set('key', value);
```

#### Get Value
```javascript
const value = await storage.get('key');
```

#### Delete Value
```javascript
await storage.delete('key');
```

#### Set Secret (Encrypted)
```javascript
await storage.setSecret('apiToken', token);
```

#### Get Secret
```javascript
const token = await storage.getSecret('apiToken');
```

### Storage Schema

```javascript
// Configuration
'config': {
  remoteUrl: string,
  email: string,
  projectKey: string,
  syncRules: Object
}

// API Token (encrypted)
'apiToken': string

// Issue Mappings
'mapping:{sourceKey}': {
  remoteKey: string,
  remoteId: string,
  lastSynced: number
}

// Sync Metrics
'metrics': {
  totalSynced: number,
  failedSyncs: number,
  lastSyncTime: string
}

// Field Mappings
'fieldMapping': {
  [sourceField]: targetField
}
```

---

## Forge Platform APIs

### Product API (Jira)

```javascript
import api, { route } from '@forge/api';

// Get current issue
const response = await api.asUser().requestJira(
  route`/rest/api/3/issue/${issueKey}`
);

// Create issue
const response = await api.asApp().requestJira(
  route`/rest/api/3/issue`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(issueData)
  }
);
```

### Events

```javascript
// Issue Created Event
{
  issue: {
    id: string,
    key: string,
    fields: Object
  },
  user: {
    accountId: string,
    displayName: string
  },
  changelog: {
    items: Array
  }
}

// Issue Updated Event
{
  issue: Object,
  changelog: {
    id: string,
    items: [{
      field: string,
      fromString: string,
      toString: string
    }]
  }
}
```

---

## Error Codes

### Application Error Codes

| Code | Error | Description |
|------|-------|-------------|
| `SYNC_001` | Configuration Missing | Sync configuration not found |
| `SYNC_002` | Invalid Configuration | Configuration validation failed |
| `SYNC_003` | Loop Detected | Sync loop prevention triggered |
| `SYNC_004` | Mapping Not Found | Issue mapping not found |
| `SYNC_005` | Transform Failed | Issue transformation failed |

### API Error Codes

| Code | Status | Description |
|------|--------|-------------|
| `API_001` | 401 | Authentication failed |
| `API_002` | 403 | Permission denied |
| `API_003` | 404 | Resource not found |
| `API_004` | 429 | Rate limit exceeded |
| `API_005` | 500 | Server error |

### Storage Error Codes

| Code | Error | Description |
|------|-------|-------------|
| `STORAGE_001` | Read Failed | Failed to read from storage |
| `STORAGE_002` | Write Failed | Failed to write to storage |
| `STORAGE_003` | Storage Full | Storage quota exceeded |

### Error Response Format

```javascript
{
  error: {
    code: string,       // Error code
    message: string,    // Human-readable message
    details: Object,    // Additional error details
    timestamp: number   // Error timestamp
  }
}
```

---

## Webhooks (Future)

**Planned for Phase 2:**

### Webhook Registration
```javascript
POST /webhooks/register
```

**Request:**
```json
{
  "url": "https://your-endpoint.com/webhook",
  "events": ["issue.created", "issue.updated"],
  "secret": "your-webhook-secret"
}
```

### Webhook Payload
```json
{
  "eventType": "issue.created",
  "issue": {
    "key": "PROJ-123",
    "fields": { ... }
  },
  "timestamp": "2025-11-16T10:30:00Z",
  "signature": "hmac-sha256-signature"
}
```

---

## API Best Practices

### Error Handling

Always wrap API calls in try-catch:
```javascript
try {
  const result = await apiCall();
} catch (error) {
  logger.error('API call failed', { error });
  // Handle error appropriately
}
```

### Retry Logic

Implement exponential backoff:
```javascript
async function retryWithBackoff(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await sleep(Math.pow(2, i) * 1000);
    }
  }
}
```

### Rate Limiting

Respect rate limits:
```javascript
const rateLimiter = {
  requests: 0,
  resetTime: Date.now(),
  
  async checkLimit() {
    if (Date.now() > this.resetTime) {
      this.requests = 0;
      this.resetTime = Date.now() + 60000; // Reset every minute
    }
    
    if (this.requests >= 90) { // Leave buffer
      await sleep(this.resetTime - Date.now());
      this.checkLimit();
    }
    
    this.requests++;
  }
};
```

---

## Version History

- **v1.0.0** - Initial API structure
- **v1.1.0** - Added loop detection
- **v1.2.0** - Enhanced error handling
- **v2.0.0** (Planned) - Bidirectional sync

For detailed API changes, see [CHANGELOG.md](CHANGELOG.md).
