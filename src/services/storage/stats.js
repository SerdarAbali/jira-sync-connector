import { storage } from '@forge/api';
import { MAX_AUDIT_LOG_ENTRIES } from '../../constants.js';

// Track API usage and rate limits
export async function trackApiCall(endpoint, success, isRateLimited = false, orgId = null) {
  try {
    const stats = await storage.get('apiUsageStats') || {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      rateLimitHits: 0,
      lastRateLimitHit: null,
      callsThisHour: 0,
      hourStarted: null,
      byEndpoint: {},
      byOrg: {},
      history: [] // Last 24 data points (hourly)
    };

    const now = new Date();
    const currentHour = now.toISOString().slice(0, 13); // "2025-12-03T15"

    // Reset hourly counter if new hour
    if (stats.hourStarted !== currentHour) {
      // Save previous hour to history before resetting
      if (stats.hourStarted && stats.callsThisHour > 0) {
        stats.history.unshift({
          hour: stats.hourStarted,
          calls: stats.callsThisHour,
          rateLimits: stats.rateLimitHitsThisHour || 0
        });
        // Keep only last 24 hours
        if (stats.history.length > 24) stats.history = stats.history.slice(0, 24);
      }
      stats.hourStarted = currentHour;
      stats.callsThisHour = 0;
      stats.rateLimitHitsThisHour = 0;
    }

    stats.totalCalls++;
    stats.callsThisHour++;

    if (success) {
      stats.successfulCalls++;
    } else {
      stats.failedCalls++;
    }

    if (isRateLimited) {
      stats.rateLimitHits++;
      stats.rateLimitHitsThisHour = (stats.rateLimitHitsThisHour || 0) + 1;
      stats.lastRateLimitHit = now.toISOString();
    }

    // Track by endpoint type
    const endpointType = categorizeEndpoint(endpoint);
    if (!stats.byEndpoint[endpointType]) {
      stats.byEndpoint[endpointType] = { calls: 0, rateLimits: 0 };
    }
    stats.byEndpoint[endpointType].calls++;
    if (isRateLimited) stats.byEndpoint[endpointType].rateLimits++;

    // Track by org
    if (orgId) {
      if (!stats.byOrg[orgId]) {
        stats.byOrg[orgId] = { calls: 0, rateLimits: 0 };
      }
      stats.byOrg[orgId].calls++;
      if (isRateLimited) stats.byOrg[orgId].rateLimits++;
    }

    stats.lastUpdated = now.toISOString();

    await storage.set('apiUsageStats', stats);
  } catch (err) {
    console.error('Error tracking API usage:', err);
  }
}

function categorizeEndpoint(endpoint) {
  if (!endpoint) return 'other';
  if (endpoint.includes('/issue/') && endpoint.includes('/comment')) return 'comments';
  if (endpoint.includes('/issue/') && endpoint.includes('/attachments')) return 'attachments';
  if (endpoint.includes('/issueLink')) return 'links';
  if (endpoint.includes('/issue/')) return 'issues';
  if (endpoint.includes('/search')) return 'search';
  if (endpoint.includes('/project')) return 'projects';
  if (endpoint.includes('/user')) return 'users';
  if (endpoint.includes('/field')) return 'fields';
  if (endpoint.includes('/status')) return 'statuses';
  return 'other';
}

export async function getApiUsageStats() {
  try {
    const stats = await storage.get('apiUsageStats') || {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      rateLimitHits: 0,
      lastRateLimitHit: null,
      callsThisHour: 0,
      hourStarted: null,
      byEndpoint: {},
      byOrg: {},
      history: []
    };
    
    // Calculate success rate
    stats.successRate = stats.totalCalls > 0 
      ? Math.round((stats.successfulCalls / stats.totalCalls) * 100) 
      : 100;
    
    // Estimate remaining quota (Jira Cloud typically allows ~100 requests/second burst, ~10k/hour sustained)
    // This is an estimate - actual limits vary by plan
    const estimatedHourlyLimit = 10000;
    stats.estimatedRemainingQuota = Math.max(0, estimatedHourlyLimit - stats.callsThisHour);
    stats.estimatedHourlyLimit = estimatedHourlyLimit;
    stats.quotaUsagePercent = Math.round((stats.callsThisHour / estimatedHourlyLimit) * 100);

    return stats;
  } catch (err) {
    console.error('Error getting API usage stats:', err);
    return null;
  }
}

export async function resetApiUsageStats() {
  try {
    await storage.set('apiUsageStats', {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      rateLimitHits: 0,
      lastRateLimitHit: null,
      callsThisHour: 0,
      hourStarted: null,
      byEndpoint: {},
      byOrg: {},
      history: []
    });
    return { success: true };
  } catch (err) {
    console.error('Error resetting API usage stats:', err);
    return { success: false, error: err.message };
  }
}

export async function trackWebhookSync(type, success, error = null, orgId = null, issueKey = null, details = null) {
  try {
    const stats = await storage.get('webhookSyncStats') || {
      totalSyncs: 0,
      issuesCreated: 0,
      issuesUpdated: 0,
      commentsSynced: 0,
      issuesSkipped: 0,
      errors: [],
      lastSync: null,
      byOrg: {} // Track stats per org
    };

    stats.totalSyncs++;
    stats.lastSync = new Date().toISOString();

    // Track per-org stats if orgId provided
    if (orgId) {
      if (!stats.byOrg[orgId]) {
        stats.byOrg[orgId] = {
          totalSyncs: 0,
          issuesCreated: 0,
          issuesUpdated: 0,
          commentsSynced: 0,
          issuesSkipped: 0,
          lastSync: null
        };
      }
      stats.byOrg[orgId].totalSyncs++;
      stats.byOrg[orgId].lastSync = new Date().toISOString();
      
      if (success) {
        if (type === 'create') stats.byOrg[orgId].issuesCreated++;
        else if (type === 'update') stats.byOrg[orgId].issuesUpdated++;
        else if (type === 'comment') stats.byOrg[orgId].commentsSynced++;
      } else {
        stats.byOrg[orgId].issuesSkipped++;
      }
    }

    // Track global stats
    if (success) {
      if (type === 'create') stats.issuesCreated++;
      else if (type === 'update') stats.issuesUpdated++;
      else if (type === 'comment') stats.commentsSynced++;
    } else {
      stats.issuesSkipped++;
      if (error) {
        // Enhanced error tracking with detailed context
        const errorEntry = { 
          timestamp: new Date().toISOString(), 
          error: typeof error === 'string' ? error : error.message || String(error),
          orgId: orgId || 'unknown',
          issueKey: issueKey || 'unknown',
          operation: type || 'unknown'
        };

        // Add additional details if provided
        if (details) {
          errorEntry.details = details;
        }

        // Keep only last 50 errors
        stats.errors.unshift(errorEntry);
        if (stats.errors.length > 50) stats.errors = stats.errors.slice(0, 50);
      }
    }

    await storage.set('webhookSyncStats', stats);
  } catch (err) {
    console.error('Error tracking webhook stats:', err);
  }
}

export async function logAuditEntry(entry) {
  try {
    const auditLog = await storage.get('auditLog') || [];
    auditLog.unshift({
      ...entry,
      timestamp: new Date().toISOString()
    });
    // Keep only last MAX_AUDIT_LOG_ENTRIES entries to prevent storage bloat
    if (auditLog.length > MAX_AUDIT_LOG_ENTRIES) {
      auditLog.length = MAX_AUDIT_LOG_ENTRIES;
    }
    await storage.set('auditLog', auditLog);
  } catch (error) {
    console.error('Error logging audit entry:', error);
  }
}
