# Troubleshooting Guide

This guide helps you diagnose and fix common issues with the Jira Sync Connector.

## Table of Contents
1. [Installation Issues](#installation-issues)
2. [Configuration Problems](#configuration-problems)
3. [Sync Issues](#sync-issues)
4. [Performance Problems](#performance-problems)
5. [API Errors](#api-errors)
6. [Storage Issues](#storage-issues)
7. [Debugging Tools](#debugging-tools)

---

## Installation Issues

### Issue: App Not Showing in Jira Apps Menu

**Symptoms:**
- App installed successfully via CLI
- Cannot find "Sync Connector" in Jira settings

**Diagnosis:**
```bash
# Check installation status
forge install --list

# Expected output:
# ✓ Installed on: your-site.atlassian.net
# Environment: production
# Status: Active
```

**Solutions:**

1. **Refresh Browser Cache:**
   ```
   - Hard refresh: Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows)
   - Clear browser cache completely
   - Try incognito/private window
   ```

2. **Verify Permissions:**
   ```yaml
   # Check manifest.yml has admin page module
   modules:
     jira:adminPage:
       - key: sync-config
         title: Sync Connector
   ```

3. **Reinstall the App:**
   ```bash
   forge uninstall --site your-site.atlassian.net
   forge install --site your-site.atlassian.net
   ```

4. **Check User Permissions:**
   - You need Jira Administrator permissions
   - Go to Settings → User Management → Check your role

---

### Issue: Forge CLI Not Working

**Symptoms:**
- `forge: command not found`
- CLI commands fail

**Solutions:**

1. **Reinstall Forge CLI:**
   ```bash
   npm uninstall -g @forge/cli
   npm install -g @forge/cli
   forge --version
   ```

2. **Check Node.js Version:**
   ```bash
   node --version  # Should be v18 or higher
   
   # Update if needed (macOS):
   brew upgrade node
   ```

3. **Check PATH:**
   ```bash
   echo $PATH
   # Should include npm global bin directory
   
   # Add to PATH if needed (~/.zshrc or ~/.bashrc):
   export PATH="$PATH:$(npm bin -g)"
   ```

4. **Permission Issues:**
   ```bash
   # Fix npm permissions (macOS/Linux)
   sudo chown -R $(whoami) ~/.npm
   sudo chown -R $(whoami) /usr/local/lib/node_modules
   ```

---

### Issue: Deployment Fails

**Symptoms:**
```
Error: Deployment failed
Error: Function validation error
```

**Diagnosis:**
```bash
# Check for errors
forge lint

# View detailed error
forge deploy --verbose
```

**Common Causes & Solutions:**

1. **Syntax Errors in manifest.yml:**
   ```bash
   # Validate YAML
   forge lint
   
   # Common issues:
   # - Wrong indentation
   # - Missing quotes
   # - Invalid module keys
   ```

2. **Missing Function Exports:**
   ```javascript
   // src/index.js must export all functions referenced in manifest
   export { issueCreatedHandler } from './handlers/issueHandlers';
   export { configPage } from './handlers/configHandlers';
   ```

3. **Dependencies Not Installed:**
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   forge deploy
   ```

4. **Size Limit Exceeded:**
   ```bash
   # Check app size
   du -sh .
   
   # If too large, add to .gitignore:
   # node_modules/
   # .DS_Store
   # *.log
   ```

---

## Configuration Problems

### Issue: "Configuration Not Found" Error

**Symptoms:**
- Sync not working
- Logs show "Configuration not found"

**Diagnosis:**
```bash
# Check if config exists
forge storage:get config --environment production

# Expected: Configuration object with URL, email, etc.
# Actual: null or undefined
```

**Solutions:**

1. **Reconfigure via UI:**
   - Go to Jira → Settings → Apps → Sync Connector
   - Enter all configuration details
   - Click "Save Configuration"

2. **Manually Set Configuration:**
   ```bash
   forge tunnel
   
   # In another terminal:
   curl -X POST http://localhost:3000/configure \
     -H "Content-Type: application/json" \
     -d '{
       "remoteUrl": "https://target.atlassian.net",
       "email": "user@example.com",
       "apiToken": "your-token",
       "projectKey": "PROJ"
     }'
   ```

3. **Check Storage Permissions:**
   ```yaml
   # manifest.yml must have:
   permissions:
     scopes:
       - storage:app
   ```

---

### Issue: "Invalid API Token" Error

**Symptoms:**
```
Error: Authentication failed
API returned 401 Unauthorized
```

**Diagnosis:**
```bash
# Test API token manually
curl -u "email@example.com:API_TOKEN" \
  https://your-site.atlassian.net/rest/api/3/myself
```

**Solutions:**

1. **Generate New API Token:**
   - Go to https://id.atlassian.com/manage-profile/security/api-tokens
   - Click "Create API token"
   - Copy the new token
   - Update configuration in app

2. **Verify Email Address:**
   - Must match exactly with Atlassian account
   - Check for typos
   - Use the email shown in Atlassian profile

3. **Check Token Permissions:**
   - Token must have access to target Jira site
   - User must have "Browse Projects" and "Create Issues" permissions

4. **Update Stored Token:**
   ```bash
   forge storage:setSecret apiToken --environment production
   # Paste new token when prompted
   ```

---

### Issue: Cannot Connect to Remote Jira

**Symptoms:**
```
Error: Connection test failed
Error: ENOTFOUND target-site.atlassian.net
```

**Diagnosis:**
```bash
# Test connectivity
ping target-site.atlassian.net

# Test API access
curl https://target-site.atlassian.net/rest/api/3/myself
```

**Solutions:**

1. **Verify URL Format:**
   ```
   ✓ Correct: https://your-site.atlassian.net
   ✗ Wrong: https://your-site.atlassian.net/
   ✗ Wrong: your-site.atlassian.net
   ✗ Wrong: https://your-site.jira.com
   ```

2. **Check External Fetch Permissions:**
   ```yaml
   # manifest.yml
   permissions:
     external:
       fetch:
         backend:
           - '*.atlassian.net'
   ```

3. **Verify Site is Accessible:**
   - Open URL in browser
   - Ensure site is not restricted/private
   - Check no IP restrictions

4. **Check Network Settings:**
   - Verify no firewall blocking
   - Check proxy settings if applicable

---

## Sync Issues

### Issue: Issues Not Syncing

**Symptoms:**
- Create issue in Org A
- Issue doesn't appear in Org B
- No errors in logs

**Diagnosis:**
```bash
# Check logs
forge logs --environment production --follow

# Create test issue and watch logs

# Check if events are firing
forge logs --environment production | grep "issue:created"
```

**Solutions:**

1. **Verify Trigger is Registered:**
   ```yaml
   # manifest.yml
   trigger:
     - key: issue-created
       function: sync-issue
       events:
         - avi:jira:created:issue
   ```

2. **Check Loop Detection:**
   ```bash
   # Issue might be marked as "already synced"
   # Check issue properties
   GET /rest/api/3/issue/PROJ-123/properties
   ```

3. **Verify Project Key:**
   - Ensure target project exists
   - Check project key is correct
   - Verify permissions on target project

4. **Check Function Execution:**
   ```javascript
   // Add logging at start of sync function
   export const syncIssue = async (event) => {
     console.log('Sync function called', { event });
     // ... rest of function
   };
   ```

5. **Inspect Event Payload:**
   ```bash
   # Log full event to see what's received
   forge logs --environment production --format json > events.log
   ```

---

### Issue: Sync Works But is Slow

**Symptoms:**
- Issues eventually sync
- Takes 30+ seconds
- Performance degraded

**Diagnosis:**
```bash
# Check function execution time
forge logs --environment production | grep "execution time"

# Monitor API response times
forge logs --environment production | grep "API call"
```

**Solutions:**

1. **Optimize API Calls:**
   ```javascript
   // Bad: Multiple sequential calls
   const issue = await getIssue(key);
   const comments = await getComments(key);
   const attachments = await getAttachments(key);
   
   // Good: Parallel calls
   const [issue, comments, attachments] = await Promise.all([
     getIssue(key),
     getComments(key),
     getAttachments(key)
   ]);
   ```

2. **Reduce Payload Size:**
   ```javascript
   // Only fetch needed fields
   const fields = 'summary,description,issuetype,priority';
   const issue = await getIssue(key, { fields });
   ```

3. **Implement Caching:**
   ```javascript
   // Cache configuration
   let configCache = null;
   let cacheTime = 0;
   
   async function getConfig() {
     if (configCache && Date.now() - cacheTime < 60000) {
       return configCache;
     }
     configCache = await storage.get('config');
     cacheTime = Date.now();
     return configCache;
   }
   ```

4. **Check Network Latency:**
   ```bash
   # Test API response time
   time curl https://target-site.atlassian.net/rest/api/3/myself
   ```

---

### Issue: Sync Creates Duplicate Issues

**Symptoms:**
- Multiple copies of same issue in target
- Sync runs multiple times

**Diagnosis:**
```bash
# Check for duplicate events
forge logs | grep "issue:created" | grep "PROJ-123"

# Check issue properties
GET /rest/api/3/issue/PROJ-123/properties/syncedFrom
```

**Solutions:**

1. **Implement Deduplication:**
   ```javascript
   const inProgress = new Set();
   
   async function syncIssue(issue) {
     if (inProgress.has(issue.key)) {
       console.log('Sync already in progress');
       return;
     }
     
     inProgress.add(issue.key);
     try {
       await performSync(issue);
     } finally {
       inProgress.delete(issue.key);
     }
   }
   ```

2. **Check Loop Detection:**
   ```javascript
   // Verify loop detection is working
   const isSynced = await storage.get(`synced:${issue.key}`);
   if (isSynced) {
     console.log('Already synced, skipping');
     return;
   }
   ```

3. **Add Idempotency Key:**
   ```javascript
   // Add unique identifier to prevent duplicates
   const syncId = `${issue.key}-${Date.now()}`;
   await storage.set(`sync:${syncId}`, { status: 'in-progress' });
   ```

---

### Issue: Comments Not Syncing

**Symptoms:**
- Issues sync fine
- Comments don't appear

**Diagnosis:**
```bash
# Check comment event handler
forge logs | grep "comment:created"

# Verify comment trigger exists
cat manifest.yml | grep comment
```

**Solutions:**

1. **Add Comment Trigger:**
   ```yaml
   # manifest.yml
   trigger:
     - key: comment-created
       function: sync-comment
       events:
         - avi:jira:created:comment
   ```

2. **Check Parent Issue Mapping:**
   ```javascript
   // Ensure parent issue is synced first
   const mapping = await storage.get(`mapping:${parentIssueKey}`);
   if (!mapping) {
     console.error('Parent issue not synced yet');
     return;
   }
   ```

3. **Verify Comment Format:**
   ```javascript
   // Jira API expects Atlassian Document Format (ADF)
   const commentBody = {
     type: 'doc',
     version: 1,
     content: [{
       type: 'paragraph',
       content: [{
         type: 'text',
         text: comment.body
       }]
     }]
   };
   ```

---

## Performance Problems

### Issue: High Memory Usage

**Symptoms:**
```
Error: Function exceeded memory limit
Memory usage: 250MB / 256MB
```

**Solutions:**

1. **Reduce Payload Size:**
   ```javascript
   // Don't load entire issue if not needed
   const issue = await api.getIssue(key, {
     fields: 'summary,description' // Only what you need
   });
   ```

2. **Stream Large Data:**
   ```javascript
   // Instead of loading all at once
   const allIssues = await getAllIssues(); // Bad
   
   // Process in batches
   for await (const batch of getIssuesInBatches(100)) {
     await processBatch(batch);
   }
   ```

3. **Clear Variables:**
   ```javascript
   let largeObject = await fetchLargeData();
   await processData(largeObject);
   largeObject = null; // Allow garbage collection
   ```

---

### Issue: Function Timeout

**Symptoms:**
```
Error: Function execution exceeded 25 seconds
```

**Solutions:**

1. **Optimize Long Operations:**
   ```javascript
   // Break into smaller operations
   async function syncLargeIssue(issue) {
     // Sync core fields first
     await syncCoreFields(issue);
     
     // Queue comments for later
     await queueCommentsForSync(issue);
   }
   ```

2. **Use Async Queue:**
   ```javascript
   // Don't wait for all operations
   async function quickSync(issue) {
     // Start sync but don't wait
     syncToRemote(issue).catch(console.error);
     return { status: 'queued' };
   }
   ```

3. **Implement Pagination:**
   ```javascript
   // Process in chunks
   async function syncComments(issueKey) {
     let startAt = 0;
     const maxResults = 50;
     
     while (true) {
       const comments = await getComments(issueKey, startAt, maxResults);
       await syncCommentBatch(comments);
       
       if (comments.length < maxResults) break;
       startAt += maxResults;
     }
   }
   ```

---

## API Errors

### Issue: 429 Rate Limit Error

**Symptoms:**
```
Error: 429 Too Many Requests
Retry-After: 60
```

**Solutions:**

1. **Implement Rate Limiting:**
   ```javascript
   const RateLimiter = {
     requests: 0,
     resetTime: Date.now() + 60000,
     
     async checkLimit() {
       if (Date.now() > this.resetTime) {
         this.requests = 0;
         this.resetTime = Date.now() + 60000;
       }
       
       if (this.requests >= 90) { // 90% of limit
         const wait = this.resetTime - Date.now();
         await sleep(wait);
         this.checkLimit();
       }
       
       this.requests++;
     }
   };
   ```

2. **Add Retry Logic:**
   ```javascript
   async function apiCallWithRetry(fn, maxRetries = 3) {
     for (let i = 0; i < maxRetries; i++) {
       try {
         return await fn();
       } catch (error) {
         if (error.status === 429) {
           const retryAfter = error.headers['retry-after'] || 60;
           await sleep(retryAfter * 1000);
           continue;
         }
         throw error;
       }
     }
   }
   ```

3. **Batch Requests:**
   ```javascript
   // Instead of individual requests
   for (const issue of issues) {
     await updateIssue(issue); // Bad
   }
   
   // Use batch API
   await bulkUpdateIssues(issues); // Good
   ```

---

### Issue: 403 Forbidden Error

**Symptoms:**
```
Error: 403 Forbidden
message: "User does not have permission"
```

**Solutions:**

1. **Check User Permissions in Target Jira:**
   - Browse Projects
   - Create Issues
   - Edit Issues
   - Add Comments

2. **Verify API Token Scope:**
   - Token must belong to user with correct permissions
   - Generate new token from correct account

3. **Check Project Permissions:**
   ```bash
   # Test permissions
   curl -u "email:token" \
     https://site.atlassian.net/rest/api/3/project/PROJ/role
   ```

---

### Issue: 400 Bad Request Error

**Symptoms:**
```
Error: 400 Bad Request
message: "Field 'issuetype' is required"
```

**Diagnosis:**
```bash
# Log the request body
console.log('Request payload:', JSON.stringify(payload, null, 2));
```

**Solutions:**

1. **Validate Required Fields:**
   ```javascript
   const requiredFields = ['project', 'summary', 'issuetype'];
   for (const field of requiredFields) {
     if (!payload.fields[field]) {
       throw new Error(`Missing required field: ${field}`);
     }
   }
   ```

2. **Check Field Format:**
   ```javascript
   // Wrong
   issuetype: 'Story'
   
   // Correct
   issuetype: { name: 'Story' }
   ```

3. **Validate Custom Fields:**
   ```javascript
   // Get field configuration
   const editMeta = await api.getIssueEditMeta(issueKey);
   console.log('Available fields:', editMeta.fields);
   ```

---

## Storage Issues

### Issue: "Storage Quota Exceeded"

**Symptoms:**
```
Error: Storage quota exceeded
Used: 1.02 GB / 1 GB
```

**Solutions:**

1. **Clean Old Mappings:**
   ```javascript
   async function cleanOldMappings() {
     const keys = await storage.query()
       .where('type', 'mapping')
       .where('lastAccessed', '<', Date.now() - 90 * 24 * 60 * 60 * 1000)
       .getKeys();
     
     for (const key of keys) {
       await storage.delete(key);
     }
   }
   ```

2. **Use More Efficient Storage:**
   ```javascript
   // Instead of storing full issues
   await storage.set(`issue:${key}`, fullIssue); // Bad - large
   
   // Store only mapping
   await storage.set(`mapping:${key}`, {  // Good - small
     remoteKey: 'REMOTE-456',
     syncedAt: Date.now()
   });
   ```

3. **Implement Data Archival:**
   ```javascript
   // Move old data to external storage or delete
   async function archiveOldData() {
     const oldMappings = await getOldMappings(90); // 90 days
     // Export to file or delete
   }
   ```

---

## Debugging Tools

### Forge Logs

**View Logs:**
```bash
# Real-time logs
forge logs --follow

# Last 100 entries
forge logs --limit 100

# Filter by level
forge logs --level error

# Filter by function
forge logs --function sync-issue

# Export to file
forge logs --limit 1000 > debug.log
```

### Custom Logging

**Add Debug Logs:**
```javascript
// src/utils/logger.js
export const logger = {
  debug: (msg, data) => console.log(`[DEBUG] ${msg}`, JSON.stringify(data, null, 2)),
  info: (msg, data) => console.log(`[INFO] ${msg}`, data),
  error: (msg, err) => console.error(`[ERROR] ${msg}`, err),
  
  // Performance logging
  time: (label) => console.time(label),
  timeEnd: (label) => console.timeEnd(label)
};

// Usage
logger.time('sync-issue');
await syncIssue(issue);
logger.timeEnd('sync-issue'); // Outputs: sync-issue: 2.5s
```

### Storage Inspector

**Inspect Storage:**
```bash
# View all storage keys
forge storage:list --environment production

# Get specific value
forge storage:get config --environment production

# Set value
forge storage:set testKey testValue --environment production

# Delete value
forge storage:delete testKey --environment production
```

### Network Debugging

**Debug API Calls:**
```javascript
async function debugFetch(url, options) {
  console.log('=== API Call ===');
  console.log('URL:', url);
  console.log('Method:', options.method);
  console.log('Headers:', options.headers);
  console.log('Body:', options.body);
  
  const start = Date.now();
  const response = await fetch(url, options);
  const duration = Date.now() - start;
  
  console.log('=== Response ===');
  console.log('Status:', response.status);
  console.log('Duration:', duration + 'ms');
  console.log('Body:', await response.text());
  
  return response;
}
```

---

## Getting Help

If you're still experiencing issues:

1. **Check Documentation:**
   - [README.md](README.md)
   - [ARCHITECTURE.md](ARCHITECTURE.md)
   - [API.md](API.md)

2. **Search Existing Issues:**
   - [GitHub Issues](https://github.com/SerdarAbali/jira-sync-connector/issues)

3. **Create New Issue:**
   - Include error messages
   - Attach relevant logs
   - Describe steps to reproduce

4. **Community Support:**
   - [Atlassian Developer Community](https://community.developer.atlassian.com/)
   - [Forge Discord](https://discord.gg/forge)

5. **Contact Support:**
   - For Forge platform issues: [Atlassian Support](https://support.atlassian.com/)
