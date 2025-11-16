# Development Guide

This guide covers everything you need to know to develop and contribute to the Jira Sync Connector project.

## Table of Contents
1. [Development Environment Setup](#development-environment-setup)
2. [Project Structure](#project-structure)
3. [Development Workflow](#development-workflow)
4. [Testing](#testing)
5. [Debugging](#debugging)
6. [Code Style Guide](#code-style-guide)
7. [Common Development Tasks](#common-development-tasks)

---

## Development Environment Setup

### Prerequisites

**Required Software:**
- Node.js 18.x or higher
- npm 9.x or higher
- Git
- A code editor (VS Code recommended)

**Atlassian Requirements:**
- Atlassian account with admin access
- At least two Jira Cloud instances for testing
- Forge CLI installed globally

### Initial Setup

1. **Install Node.js (macOS)**
   ```bash
   # Using Homebrew
   brew install node@18
   
   # Verify installation
   node --version  # Should show v18.x.x or higher
   npm --version   # Should show v9.x.x or higher
   ```

2. **Install Forge CLI**
   ```bash
   npm install -g @forge/cli
   
   # Verify installation
   forge --version
   ```

3. **Login to Forge**
   ```bash
   forge login
   ```
   This will open your browser to authenticate.

4. **Clone the Repository**
   ```bash
   git clone https://github.com/SerdarAbali/jira-sync-connector.git
   cd jira-sync-connector
   ```

5. **Install Dependencies**
   ```bash
   npm install
   ```

6. **Create Development Environment File**
   ```bash
   # Optional: Create .env for local configuration
   touch .env
   ```
   
   Add to `.env`:
   ```
   # Development settings
   LOG_LEVEL=debug
   ENABLE_VERBOSE_LOGGING=true
   ```

### IDE Setup (VS Code)

**Recommended Extensions:**
```json
{
  "recommendations": [
    "dbaeumer.vscode-eslint",
    "esbenp.prettier-vscode",
    "atlassian.atlascode",
    "ms-vscode.vscode-typescript-next"
  ]
}
```

**VS Code Settings** (`.vscode/settings.json`):
```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "eslint.autoFixOnSave": true,
  "files.exclude": {
    "**/node_modules": true,
    "**/.forge": true
  }
}
```

---

## Project Structure

```
jira-sync-connector/
├── src/
│   ├── index.js              # Main entry point
│   ├── handlers/
│   │   ├── issueHandlers.js  # Issue event handlers
│   │   ├── commentHandlers.js # Comment handlers
│   │   └── configHandlers.js  # Config page handlers
│   ├── services/
│   │   ├── syncService.js     # Core sync logic
│   │   ├── transformService.js # Issue transformation
│   │   ├── apiService.js      # Jira API client
│   │   └── storageService.js  # Storage operations
│   ├── utils/
│   │   ├── loopDetection.js   # Loop prevention
│   │   ├── errorHandler.js    # Error handling
│   │   ├── logger.js          # Logging utilities
│   │   └── validators.js      # Input validation
│   ├── config/
│   │   ├── constants.js       # Application constants
│   │   └── mappings.js        # Field mappings
│   └── ui/
│       ├── ConfigPage.jsx     # Admin config UI
│       ├── StatusDashboard.jsx # Sync status UI
│       └── components/        # Reusable UI components
├── static/
│   ├── assets/               # Images, icons
│   └── styles/              # CSS files
├── tests/
│   ├── unit/                # Unit tests
│   ├── integration/         # Integration tests
│   └── fixtures/            # Test data
├── docs/                    # Additional documentation
├── manifest.yml             # Forge app manifest
├── package.json             # Dependencies
├── .gitignore              # Git ignore rules
├── .eslintrc.json          # ESLint configuration
├── .prettierrc             # Prettier configuration
└── README.md               # Main documentation
```

### Key Files Explained

#### `manifest.yml`
Defines the Forge app structure, permissions, and modules.

```yaml
modules:
  jira:adminPage:
    - key: sync-config
      title: Sync Connector
      function: config-page
      
  trigger:
    - key: issue-created
      function: sync-issue
      events:
        - avi:jira:created:issue
```

#### `src/index.js`
Main entry point that exports all Forge functions.

```javascript
export { issueCreatedHandler } from './handlers/issueHandlers';
export { configPage } from './handlers/configHandlers';
```

#### `package.json`
Project dependencies and scripts.

```json
{
  "scripts": {
    "test": "jest",
    "lint": "eslint src/",
    "format": "prettier --write src/"
  }
}
```

---

## Development Workflow

### 1. Create a Feature Branch

```bash
# Update main branch
git checkout main
git pull origin main

# Create feature branch
git checkout -b feature/your-feature-name
```

### 2. Deploy to Development

```bash
# Deploy your changes
forge deploy --environment development

# Or use tunnel for live development
forge tunnel
```

### 3. Make Changes

Edit files in `src/` directory. If using `forge tunnel`, changes are reflected immediately.

### 4. Test Locally

```bash
# Run unit tests
npm test

# Run specific test file
npm test -- handlers/issueHandlers.test.js

# Run with coverage
npm test -- --coverage
```

### 5. View Logs

```bash
# Tail logs in real-time
forge logs --follow

# Filter by function
forge logs --function sync-issue

# Show errors only
forge logs --level error
```

### 6. Test in Jira

1. Open your Jira test instance
2. Create/update issues to trigger events
3. Check logs for sync activity
4. Verify issues in target organization

### 7. Commit Changes

```bash
# Stage changes
git add .

# Commit with meaningful message
git commit -m "feat: add epic synchronization support"

# Push to your fork
git push origin feature/your-feature-name
```

### 8. Create Pull Request

1. Go to GitHub repository
2. Click "New Pull Request"
3. Select your feature branch
4. Fill in PR template
5. Submit for review

---

## Testing

### Unit Testing

**Test File Structure:**
```
tests/
├── unit/
│   ├── handlers/
│   │   └── issueHandlers.test.js
│   ├── services/
│   │   └── syncService.test.js
│   └── utils/
│       └── loopDetection.test.js
```

**Example Test:**
```javascript
// tests/unit/services/syncService.test.js
import { syncIssue } from '../../../src/services/syncService';

describe('syncService', () => {
  describe('syncIssue', () => {
    it('should sync issue to remote Jira', async () => {
      const mockIssue = {
        key: 'PROJ-123',
        fields: {
          summary: 'Test Issue',
          description: 'Test Description'
        }
      };
      
      const result = await syncIssue(mockIssue);
      
      expect(result.success).toBe(true);
      expect(result.remoteKey).toBeDefined();
    });
    
    it('should handle API errors gracefully', async () => {
      const mockIssue = { key: 'INVALID' };
      
      await expect(syncIssue(mockIssue)).rejects.toThrow();
    });
  });
});
```

**Running Tests:**
```bash
# Run all tests
npm test

# Run in watch mode
npm test -- --watch

# Run specific test suite
npm test -- syncService

# Generate coverage report
npm test -- --coverage
```

### Integration Testing

**Setup Test Jira Instances:**
```javascript
// tests/integration/setup.js
export const setupTestEnvironment = async () => {
  const orgA = await createTestOrganization('OrgA');
  const orgB = await createTestOrganization('OrgB');
  
  return { orgA, orgB };
};
```

**Integration Test Example:**
```javascript
// tests/integration/syncFlow.test.js
describe('End-to-End Sync Flow', () => {
  let orgA, orgB;
  
  beforeAll(async () => {
    ({ orgA, orgB } = await setupTestEnvironment());
  });
  
  it('should sync issue from Org A to Org B', async () => {
    // Create issue in Org A
    const issue = await orgA.createIssue({
      summary: 'Test Issue',
      project: 'PROJ'
    });
    
    // Wait for sync
    await waitForSync(issue.key, 5000);
    
    // Verify in Org B
    const syncedIssue = await orgB.getIssue(issue.syncedKey);
    expect(syncedIssue.summary).toBe('Test Issue');
  });
});
```

### Manual Testing Checklist

**Before Each Release:**
- [ ] Create issue in Org A → Verify appears in Org B
- [ ] Update issue summary → Verify updates in Org B
- [ ] Change issue status → Verify status changes in Org B
- [ ] Add comment → Verify comment appears in Org B
- [ ] Create epic → Verify epic created in Org B
- [ ] Add story to epic → Verify relationship maintained
- [ ] Test with different issue types (Bug, Task, Story)
- [ ] Test loop prevention (update synced issue in Org B)
- [ ] Test configuration UI (save settings)
- [ ] Test error scenarios (invalid credentials, network errors)

---

## Debugging

### Using Forge Tunnel

Forge tunnel allows you to run code locally while connected to Jira events.

```bash
# Start tunnel
forge tunnel

# In another terminal, tail logs
forge logs --follow
```

**Benefits:**
- Instant code changes
- Use local debugger
- Console.log appears in terminal
- Faster development cycle

### Adding Debug Logs

```javascript
// src/utils/logger.js
export const logger = {
  debug: (message, data) => {
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`[DEBUG] ${message}`, data);
    }
  },
  info: (message, data) => {
    console.log(`[INFO] ${message}`, data);
  },
  error: (message, error) => {
    console.error(`[ERROR] ${message}`, error);
  }
};

// Usage in code
import { logger } from './utils/logger';

logger.debug('Syncing issue', { issueKey: 'PROJ-123' });
```

### Using VS Code Debugger

**launch.json:**
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Forge Tunnel",
      "program": "${workspaceFolder}/node_modules/@forge/cli/out/bin/cli.js",
      "args": ["tunnel"],
      "console": "integratedTerminal"
    }
  ]
}
```

### Common Debugging Scenarios

**Issue not syncing:**
```javascript
// Add debug logs
logger.debug('Event received', { event });
logger.debug('Loop check result', { isSynced });
logger.debug('Config loaded', { config });
logger.debug('Transformed issue', { transformedIssue });
logger.debug('API response', { response });
```

**API errors:**
```javascript
try {
  const response = await api.createIssue(issue);
} catch (error) {
  logger.error('API call failed', {
    status: error.status,
    message: error.message,
    body: error.body
  });
  throw error;
}
```

---

## Code Style Guide

### JavaScript Conventions

**Use ES6+ Features:**
```javascript
// ✅ Good
const syncIssue = async (issue) => {
  const { key, fields } = issue;
  return await apiCall(key, fields);
};

// ❌ Avoid
function syncIssue(issue) {
  var key = issue.key;
  var fields = issue.fields;
  return apiCall(key, fields);
}
```

**Prefer const/let over var:**
```javascript
// ✅ Good
const API_URL = 'https://api.atlassian.net';
let retryCount = 0;

// ❌ Avoid
var API_URL = 'https://api.atlassian.net';
var retryCount = 0;
```

**Use template literals:**
```javascript
// ✅ Good
const message = `Syncing issue ${issueKey} to ${targetOrg}`;

// ❌ Avoid
const message = 'Syncing issue ' + issueKey + ' to ' + targetOrg;
```

### Naming Conventions

**Variables and Functions:**
```javascript
// camelCase for variables and functions
const issueKey = 'PROJ-123';
function syncIssue() {}

// PascalCase for classes
class IssueTransformer {}

// UPPER_CASE for constants
const MAX_RETRY_ATTEMPTS = 3;
```

**File Names:**
```
// camelCase for files
issueHandlers.js
syncService.js

// PascalCase for React components
ConfigPage.jsx
StatusDashboard.jsx
```

### Function Documentation

**Use JSDoc comments:**
```javascript
/**
 * Syncs an issue from source to target Jira organization
 * @param {Object} issue - The Jira issue object
 * @param {string} issue.key - Issue key (e.g., 'PROJ-123')
 * @param {Object} issue.fields - Issue fields
 * @param {Object} config - Sync configuration
 * @param {string} config.targetUrl - Target Jira URL
 * @returns {Promise<Object>} The synced issue with remote key
 * @throws {Error} If API call fails or validation fails
 */
async function syncIssue(issue, config) {
  // Implementation
}
```

### Error Handling

**Always handle errors:**
```javascript
// ✅ Good
async function syncIssue(issue) {
  try {
    const result = await apiCall(issue);
    return result;
  } catch (error) {
    logger.error('Sync failed', error);
    throw new SyncError('Failed to sync issue', { cause: error });
  }
}

// ❌ Avoid
async function syncIssue(issue) {
  const result = await apiCall(issue); // Unhandled error
  return result;
}
```

### Async/Await Best Practices

**Use Promise.all() for parallel operations:**
```javascript
// ✅ Good - Parallel
const [issue, comments, attachments] = await Promise.all([
  getIssue(key),
  getComments(key),
  getAttachments(key)
]);

// ❌ Avoid - Sequential
const issue = await getIssue(key);
const comments = await getComments(key);
const attachments = await getAttachments(key);
```

---

## Common Development Tasks

### Adding a New Event Handler

1. **Define the trigger in manifest.yml:**
   ```yaml
   trigger:
     - key: my-new-event
       function: my-handler
       events:
         - avi:jira:updated:issue
   ```

2. **Create the handler:**
   ```javascript
   // src/handlers/myHandler.js
   export const myHandler = async (event, context) => {
     logger.info('Event received', { event });
     // Your logic here
   };
   ```

3. **Export from index.js:**
   ```javascript
   export { myHandler } from './handlers/myHandler';
   ```

4. **Deploy and test:**
   ```bash
   forge deploy
   ```

### Adding a New Configuration Field

1. **Update UI component:**
   ```jsx
   // src/ui/ConfigPage.jsx
   <Field label="New Setting">
     <Textfield value={newSetting} onChange={setNewSetting} />
   </Field>
   ```

2. **Update storage schema:**
   ```javascript
   const saveConfig = async () => {
     await storage.set('config', {
       ...existingConfig,
       newSetting: value
     });
   };
   ```

3. **Use in sync logic:**
   ```javascript
   const config = await storage.get('config');
   if (config.newSetting) {
     // Use the new setting
   }
   ```

### Adding Custom Field Mapping

1. **Define mapping in config:**
   ```javascript
   const fieldMapping = {
     'customfield_10001': 'customfield_20001',
     'customfield_10002': 'customfield_20002'
   };
   ```

2. **Transform in sync logic:**
   ```javascript
   function transformCustomFields(sourceFields, mapping) {
     const transformed = {};
     for (const [sourceField, targetField] of Object.entries(mapping)) {
       if (sourceFields[sourceField]) {
         transformed[targetField] = sourceFields[sourceField];
       }
     }
     return transformed;
   }
   ```

### Updating Dependencies

```bash
# Check for outdated packages
npm outdated

# Update all dependencies
npm update

# Update specific package
npm update @forge/api

# Test after updating
npm test
forge deploy
```

---

## Performance Tips

### Optimize Storage Access

```javascript
// ✅ Good - Single read
const config = await storage.get('config');
const url = config.url;
const token = config.token;

// ❌ Avoid - Multiple reads
const url = await storage.get('config.url');
const token = await storage.get('config.token');
```

### Cache Frequently Used Data

```javascript
let configCache = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getConfig() {
  const now = Date.now();
  if (configCache && (now - cacheTimestamp) < CACHE_TTL) {
    return configCache;
  }
  
  configCache = await storage.get('config');
  cacheTimestamp = now;
  return configCache;
}
```

### Batch API Calls

```javascript
// ✅ Good - Batch update
const updates = issues.map(issue => ({
  update: { summary: [{ set: issue.newSummary }] }
}));
await api.bulkUpdateIssues(updates);

// ❌ Avoid - Individual calls
for (const issue of issues) {
  await api.updateIssue(issue.key, { summary: issue.newSummary });
}
```

---

## Next Steps

- Review [ARCHITECTURE.md](ARCHITECTURE.md) for system design
- Check [API.md](API.md) for API documentation
- See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines
- Read [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common issues

Happy coding! 🚀
