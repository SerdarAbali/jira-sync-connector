import * as kvsStore from './kvs.js';
import { MAX_AUDIT_LOG_ENTRIES, MAX_HOURLY_HISTORY } from '../../constants.js';

// Track API usage and rate limits
export async function trackApiCall(endpoint, success, isRateLimited = false, orgId = null) {
  try {
    const stats = await kvsStore.get('apiUsageStats') || {
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
    const currentMinute = now.toISOString().slice(0, 16); // "2025-12-03T15:30"

    // Reset minute counter if new minute
    if (stats.minuteStarted !== currentMinute) {
      stats.minuteStarted = currentMinute;
      stats.callsThisMinute = 0;
    }
    stats.callsThisMinute = (stats.callsThisMinute || 0) + 1;

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
        if (stats.history.length > MAX_HOURLY_HISTORY) stats.history = stats.history.slice(0, MAX_HOURLY_HISTORY);
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

    await kvsStore.set('apiUsageStats', stats);
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
    const stats = await kvsStore.get('apiUsageStats') || {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      rateLimitHits: 0,
      lastRateLimitHit: null,
      callsThisHour: 0,
      callsThisMinute: 0,
      minuteStarted: null,
      hourStarted: null,
      byEndpoint: {},
      byOrg: {},
      history: []
    };
    
    // Calculate success rate
    stats.successRate = stats.totalCalls > 0 
      ? Math.round((stats.successfulCalls / stats.totalCalls) * 100) 
      : 100;
    
    // Forge Platform Rate Limits (from official Atlassian documentation):
    // - Forge Invocations: 1,200 per minute per app
    // - Network Requests: 100,000 per minute per app per tenant (Jira API calls)
    // - Jira API: Cost-based budget (~10 req/sec sustained = ~36,000/hour for App context)
    // 
    // For Forge apps making Jira API calls, the effective limit is:
    // - Per minute: ~100,000 network requests (generous)
    // - Sustained: ~10 requests/second = 600/minute = 36,000/hour
    //
    // We use the more conservative sustained rate for accurate tracking
    const MINUTE_LIMIT = 100000;  // Forge network requests per minute per tenant
    const HOURLY_SUSTAINED_LIMIT = 36000; // ~10 req/sec sustained over an hour
    
    stats.minuteLimit = MINUTE_LIMIT;
    stats.estimatedHourlyLimit = HOURLY_SUSTAINED_LIMIT;
    stats.estimatedRemainingQuota = Math.max(0, HOURLY_SUSTAINED_LIMIT - stats.callsThisHour);
    stats.quotaUsagePercent = Math.round((stats.callsThisHour / HOURLY_SUSTAINED_LIMIT) * 100);
    
    // Also track minute usage (more relevant for burst detection)
    const now = new Date();
    const currentMinute = now.toISOString().slice(0, 16); // "2025-12-03T15:30"
    if (stats.minuteStarted !== currentMinute) {
      stats.callsThisMinute = 0;
    }
    stats.minuteUsagePercent = Math.round((stats.callsThisMinute / MINUTE_LIMIT) * 100);

    // Add rate limit info summary
    stats.rateLimitInfo = {
      forgeInvocationsPerMin: 1200,
      networkRequestsPerMin: MINUTE_LIMIT,
      sustainedRequestsPerSec: 10,
      sustainedRequestsPerHour: HOURLY_SUSTAINED_LIMIT,
      source: 'Atlassian Forge Platform Quotas'
    };

    return stats;
  } catch (err) {
    console.error('Error getting API usage stats:', err);
    return null;
  }
}

export async function resetApiUsageStats() {
  try {
    await kvsStore.set('apiUsageStats', {
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
    const stats = await kvsStore.get('webhookSyncStats') || {
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

    await kvsStore.set('webhookSyncStats', stats);
  } catch (err) {
    console.error('Error tracking webhook stats:', err);
  }
}

export async function logAuditEntry(entry) {
  try {
    const auditLog = await kvsStore.get('auditLog') || [];
    auditLog.unshift({
      ...entry,
      timestamp: new Date().toISOString()
    });
    // Keep only last MAX_AUDIT_LOG_ENTRIES entries to prevent storage bloat
    if (auditLog.length > MAX_AUDIT_LOG_ENTRIES) {
      auditLog.length = MAX_AUDIT_LOG_ENTRIES;
    }
    await kvsStore.set('auditLog', auditLog);
  } catch (error) {
    console.error('Error logging audit entry:', error);
  }
}
