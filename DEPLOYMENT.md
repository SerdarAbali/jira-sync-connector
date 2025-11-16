# Deployment Guide

This guide covers deploying the Jira Sync Connector to different environments.

## Table of Contents
1. [Pre-Deployment Checklist](#pre-deployment-checklist)
2. [Environment Setup](#environment-setup)
3. [Deployment Process](#deployment-process)
4. [Post-Deployment Verification](#post-deployment-verification)
5. [Rollback Procedures](#rollback-procedures)
6. [Production Best Practices](#production-best-practices)

---

## Pre-Deployment Checklist

### Code Quality
- [ ] All tests passing (`npm test`)
- [ ] Code reviewed and approved
- [ ] Linting passed (`npm run lint`)
- [ ] No console.log statements in production code
- [ ] Documentation updated

### Configuration
- [ ] Environment-specific settings configured
- [ ] API credentials prepared
- [ ] Storage limits checked
- [ ] Rate limits understood

### Testing
- [ ] Unit tests passed
- [ ] Integration tests passed
- [ ] Manual testing completed
- [ ] Performance testing done
- [ ] Security review completed

### Dependencies
- [ ] All dependencies up to date
- [ ] No known security vulnerabilities
- [ ] Package lock file committed

---

## Environment Setup

### Development Environment

**Purpose:** Local development and testing

**Setup:**
```bash
# Deploy to development
forge deploy --environment development

# Install on test Jira site
forge install --site https://your-test-site.atlassian.net

# View logs
forge logs --environment development
```

**Configuration:**
- Test credentials
- Sample data
- Verbose logging enabled
- Debug mode active

---

### Staging Environment

**Purpose:** Pre-production testing

**Setup:**
```bash
# Create staging environment
forge environments:create staging

# Deploy to staging
forge deploy --environment staging

# Install on staging Jira site
forge install --environment staging --site https://staging.atlassian.net
```

**Configuration:**
- Production-like credentials
- Real (but non-critical) data
- Standard logging
- Performance monitoring

---

### Production Environment

**Purpose:** Live production use

**Setup:**
```bash
# Deploy to production
forge deploy --environment production

# Install on production Jira site
forge install --environment production --site https://your-company.atlassian.net
```

**Configuration:**
- Production credentials
- Live data
- Error-only logging
- Full monitoring and alerts

---

## Deployment Process

### Step 1: Prepare for Deployment

**Check Current Version:**
```bash
# View current deployment
forge deploy --list

# Check app info
forge info
```

**Tag Release:**
```bash
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

**Update Version:**
```json
// package.json
{
  "version": "1.0.0"
}
```

---

### Step 2: Build and Test

```bash
# Install dependencies
npm ci

# Run tests
npm test

# Run linter
npm run lint

# Build (if applicable)
npm run build
```

---

### Step 3: Deploy to Forge

**First-Time Deployment:**
```bash
# Register the app
forge register

# Deploy
forge deploy

# This creates the app in Forge
```

**Subsequent Deployments:**
```bash
# Deploy to development first
forge deploy --environment development

# Test thoroughly

# Deploy to staging
forge deploy --environment staging

# More testing

# Deploy to production
forge deploy --environment production
```

---

### Step 4: Install/Update on Jira

**New Installation:**
```bash
forge install --environment production
```

Select the Jira site when prompted.

**Update Existing Installation:**
```bash
# Installations auto-update within 5 minutes
# Or force update:
forge install --upgrade --environment production
```

---

### Step 5: Configure the App

1. **Access Configuration Page:**
   - Go to Jira → Settings (⚙️)
   - Navigate to Apps → Manage Apps
   - Find "Sync Connector" in sidebar

2. **Enter Configuration:**
   ```
   Remote Jira URL: https://target-org.atlassian.net
   Email: sync-user@company.com
   API Token: [paste token]
   Project Key: PROJ
   ```

3. **Test Connection:**
   - Click "Test Connection" button
   - Verify success message

4. **Save Configuration:**
   - Click "Save"
   - Verify settings persisted

---

### Step 6: Verify Deployment

**Check App Status:**
```bash
# View deployment info
forge info

# Check installed apps
forge install --list

# View recent logs
forge logs --environment production --limit 50
```

**Test Basic Functionality:**
1. Create a test issue in source Jira
2. Verify it appears in target Jira
3. Update the issue
4. Verify updates sync
5. Delete test issues

---

## Post-Deployment Verification

### Smoke Tests

**Test 1: Issue Creation**
```javascript
// Create issue in Org A
const issue = await api.createIssue({
  project: 'PROJ',
  summary: 'Deployment Test Issue',
  issuetype: 'Task'
});

// Wait 30 seconds
await sleep(30000);

// Verify in Org B
const syncedIssue = await apiB.searchIssues(
  `summary ~ "Deployment Test Issue"`
);

assert(syncedIssue.total > 0, 'Issue not synced');
```

**Test 2: Issue Update**
```javascript
// Update issue in Org A
await api.updateIssue(issue.key, {
  summary: 'Updated Test Issue'
});

// Wait 30 seconds
await sleep(30000);

// Verify in Org B
const updated = await apiB.getIssue(syncedIssue.key);
assert(updated.summary === 'Updated Test Issue', 'Update not synced');
```

**Test 3: Comment Sync**
```javascript
// Add comment in Org A
await api.addComment(issue.key, 'Test comment');

// Wait 30 seconds
await sleep(30000);

// Verify in Org B
const comments = await apiB.getComments(syncedIssue.key);
assert(comments.total > 0, 'Comment not synced');
```

---

### Monitoring Setup

**Set Up Log Monitoring:**
```bash
# Tail production logs
forge logs --environment production --follow

# Filter for errors
forge logs --environment production --level error
```

**Monitor Key Metrics:**
- Sync success rate
- Sync latency
- API error rate
- Storage usage

---

### Health Checks

**Daily Checks:**
- [ ] Review error logs
- [ ] Check sync metrics
- [ ] Verify no stuck syncs
- [ ] Monitor API rate limits

**Weekly Checks:**
- [ ] Review storage usage
- [ ] Check performance metrics
- [ ] Verify all configs intact
- [ ] Test full sync flow

**Monthly Checks:**
- [ ] Review and rotate API tokens
- [ ] Update dependencies
- [ ] Performance optimization review
- [ ] Documentation updates

---

## Rollback Procedures

### When to Rollback

Rollback immediately if:
- Critical bugs in production
- Data corruption detected
- Performance severely degraded
- Security vulnerability discovered

### Rollback Steps

**Option 1: Reinstall Previous Version**

```bash
# List available versions
forge deploy --list

# Reinstall specific version
forge install --environment production --version v1.0.0
```

**Option 2: Revert Code and Redeploy**

```bash
# Find commit hash of last good version
git log --oneline

# Revert to that commit
git revert <commit-hash>

# Deploy reverted version
forge deploy --environment production
```

**Option 3: Uninstall App**

```bash
# Complete removal (last resort)
forge uninstall --environment production

# Clean up data
forge storage --environment production --clear
```

---

### Post-Rollback Actions

1. **Notify Users:**
   - Send notification about rollback
   - Explain what happened
   - Provide timeline for fix

2. **Investigate Issue:**
   - Review logs for root cause
   - Document the issue
   - Create bug ticket

3. **Fix and Test:**
   - Fix the issue
   - Test thoroughly
   - Prepare for redeployment

4. **Redeploy:**
   - Follow standard deployment process
   - Monitor closely
   - Verify fix works

---

## Production Best Practices

### Deployment Timing

**Best Times to Deploy:**
- Off-peak hours (e.g., 2-4 AM local time)
- Weekends (if lower usage)
- During scheduled maintenance windows

**Avoid Deploying:**
- During business-critical periods
- Right before major deadlines
- During holidays or on-call gaps

---

### Blue-Green Deployment

For zero-downtime deployments:

```bash
# Deploy to staging (green)
forge deploy --environment staging

# Test thoroughly

# Switch production to staging
forge environments:promote staging production

# Old production becomes new staging
```

---

### Gradual Rollout

Deploy to a subset of users first:

```bash
# Deploy to small test group
forge install --environment production --site test-site-1

# Monitor for 24 hours

# Expand to more sites
forge install --environment production --site test-site-2
forge install --environment production --site test-site-3

# Finally deploy to all sites
forge install --environment production --upgrade-all
```

---

### Configuration Management

**Environment Variables:**
```javascript
// Use different configs per environment
const getConfig = () => {
  const env = process.env.FORGE_ENV;
  
  switch (env) {
    case 'production':
      return {
        logLevel: 'error',
        retryAttempts: 3,
        timeout: 25000
      };
    case 'staging':
      return {
        logLevel: 'info',
        retryAttempts: 2,
        timeout: 20000
      };
    default:
      return {
        logLevel: 'debug',
        retryAttempts: 1,
        timeout: 10000
      };
  }
};
```

---

### Secrets Management

**Rotating API Tokens:**

```bash
# 1. Generate new API token in Jira

# 2. Update in Forge storage
forge storage:set apiToken --secret --environment production

# 3. Verify new token works

# 4. Revoke old token in Jira
```

**Token Rotation Schedule:**
- Rotate every 90 days
- Rotate immediately if compromised
- Use different tokens per environment

---

### Monitoring and Alerts

**Set Up Alerts:**

```javascript
// Alert on high error rate
if (errorRate > 0.05) { // 5% error rate
  sendAlert('High error rate detected', {
    rate: errorRate,
    environment: 'production',
    timestamp: Date.now()
  });
}

// Alert on sync delays
if (syncDelay > 60000) { // 1 minute
  sendAlert('Sync delay detected', {
    delay: syncDelay,
    issueKey: issue.key
  });
}
```

**Monitoring Dashboard:**
- Sync success rate (target: >99%)
- Average sync time (target: <5 seconds)
- API error rate (target: <1%)
- Storage usage (alert at 80%)

---

### Backup Strategy

**Data Backup:**
```bash
# Export all storage data
forge storage:export --environment production > backup.json

# Store securely
```

**Configuration Backup:**
```bash
# Export configuration
forge config:export --environment production > config-backup.json
```

**Restore from Backup:**
```bash
# Import storage data
forge storage:import --environment production < backup.json

# Import configuration
forge config:import --environment production < config-backup.json
```

---

### Documentation

**Maintain Deployment Log:**

```markdown
## Deployment Log

### v1.2.0 - 2025-11-16
- Deployed by: Serdar
- Environment: Production
- Jira Sites: 5 sites
- Issues: None
- Rollback: Not needed
- Notes: Smooth deployment, all tests passed

### v1.1.0 - 2025-11-10
- Deployed by: Serdar
- Environment: Production
- Jira Sites: 3 sites
- Issues: Minor logging issue
- Rollback: No
- Notes: Fixed in v1.1.1 hotfix
```

---

### Security Considerations

**Pre-Deployment Security Checks:**
- [ ] No hardcoded credentials
- [ ] No console.log of sensitive data
- [ ] Input validation on all endpoints
- [ ] Rate limiting implemented
- [ ] HTTPS only for API calls

**Post-Deployment Security:**
- Monitor for unusual API activity
- Review access logs
- Check for unauthorized access attempts
- Verify all credentials are encrypted

---

### Performance Optimization

**Before Deploying:**
```bash
# Run performance tests
npm run test:performance

# Check bundle size
npm run analyze

# Optimize if needed
npm run optimize
```

**Production Tuning:**
```javascript
// Optimize for production
const prodConfig = {
  caching: true,
  batchSize: 10,
  concurrentRequests: 5,
  timeout: 25000
};
```

---

## Troubleshooting Deployments

### Common Issues

**Issue: Deployment Fails**
```bash
Error: Deployment failed: Function validation error
```

**Solution:**
```bash
# Check manifest syntax
forge lint

# Verify function exports
cat src/index.js | grep export

# Try clean deployment
rm -rf node_modules
npm install
forge deploy
```

---

**Issue: App Not Appearing in Jira**
```bash
# Verify installation
forge install --list

# Reinstall if needed
forge uninstall
forge install
```

---

**Issue: Configuration Not Saving**
```bash
# Check storage permissions in manifest.yml
permissions:
  scopes:
    - storage:app

# Verify storage access
forge storage:get config --environment production
```

---

## Emergency Procedures

### Critical Bug in Production

1. **Immediate Response:**
   ```bash
   # Disable the app
   forge uninstall --environment production --force
   ```

2. **Investigate:**
   ```bash
   # Pull logs
   forge logs --environment production --limit 1000 > incident.log
   ```

3. **Fix and Deploy:**
   ```bash
   # Fix the issue
   # Test thoroughly
   # Deploy hotfix
   forge deploy --environment production
   ```

---

### Data Corruption

1. **Stop Syncing:**
   - Disable app or block triggers

2. **Assess Damage:**
   - Identify affected issues
   - Document extent of corruption

3. **Restore:**
   - Restore from backup if available
   - Manual cleanup if needed

4. **Prevent Recurrence:**
   - Fix root cause
   - Add validation
   - Enhance testing

---

## Deployment Checklist

### Pre-Deployment
- [ ] Code reviewed and approved
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Version bumped
- [ ] Release notes prepared
- [ ] Backup taken

### During Deployment
- [ ] Deploy to staging first
- [ ] Test in staging
- [ ] Deploy to production
- [ ] Verify installation
- [ ] Run smoke tests
- [ ] Monitor logs

### Post-Deployment
- [ ] Verify functionality
- [ ] Monitor for errors
- [ ] Update status page
- [ ] Notify stakeholders
- [ ] Document deployment
- [ ] Plan for next release

---

## Additional Resources

- [Forge Deployment Docs](https://developer.atlassian.com/platform/forge/deploying/)
- [Forge Environments](https://developer.atlassian.com/platform/forge/environments/)
- [Troubleshooting Guide](TROUBLESHOOTING.md)
- [Architecture Documentation](ARCHITECTURE.md)

For deployment support, contact the team or open an issue on GitHub.
