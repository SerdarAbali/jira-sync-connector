import * as kvsStore from '../services/storage/kvs.js';
import { getApiUsageStats, resetApiUsageStats } from '../services/storage/stats.js';
import { MAX_ERROR_ENTRIES } from '../constants.js';
import { sanitizeErrorEntry, safeErrorSummary, boundHistory, safeErrorForLog } from '../utils/redaction.js';

export function defineStatsResolvers(resolver) {
  resolver.define('getScheduledSyncStats', async () => {
    const stats = await kvsStore.get('scheduledSyncStats');
    if (stats) {
      stats.events = Array.isArray(stats.events) ? stats.events : [];
      stats.errors = boundHistory(
        Array.isArray(stats.errors) ? stats.errors.map(error => safeErrorSummary(error)) : [],
        MAX_ERROR_ENTRIES
      );
      return stats;
    }
    return {
      lastRun: null,
      issuesChecked: 0,
      issuesCreated: 0,
      issuesUpdated: 0,
      issuesSkipped: 0,
      errors: [],
      events: []
    };
  });

  resolver.define('getWebhookSyncStats', async () => {
    const stats = await kvsStore.get('webhookSyncStats');
    if (stats) {
      const safeStats = { ...stats };
      safeStats.errors = boundHistory(
        Array.isArray(stats.errors) ? stats.errors.map(sanitizeErrorEntry) : [],
        MAX_ERROR_ENTRIES
      );
      return safeStats;
    }
    return {
      totalSyncs: 0,
      issuesCreated: 0,
      issuesUpdated: 0,
      commentsSynced: 0,
      issuesSkipped: 0,
      errors: [],
      lastSync: null
    };
  });

  resolver.define('getApiUsageStats', async () => {
    return await getApiUsageStats();
  });

  resolver.define('resetApiUsageStats', async () => {
    return await resetApiUsageStats();
  });

  resolver.define('clearWebhookErrors', async () => {
    try {
      const stats = await kvsStore.get('webhookSyncStats');
      if (stats) {
        stats.errors = [];
        await kvsStore.set('webhookSyncStats', stats);
      }
      return { success: true, message: 'Webhook errors cleared' };
    } catch (error) {
      console.error('Error clearing webhook errors:', safeErrorForLog(error));
      return { success: false, error: 'Unable to clear webhook errors' };
    }
  });

  resolver.define('clearScheduledErrors', async () => {
    try {
      const stats = await kvsStore.get('scheduledSyncStats');
      if (stats) {
        stats.errors = [];
        await kvsStore.set('scheduledSyncStats', stats);
      }
      return { success: true, message: 'Scheduled sync errors cleared' };
    } catch (error) {
      console.error('Error clearing scheduled errors:', safeErrorForLog(error));
      return { success: false, error: 'Unable to clear scheduled errors' };
    }
  });
}
