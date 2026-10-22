import * as kvsStore from '../services/storage/kvs.js';
import { getApiUsageStats, resetApiUsageStats, isNormalWebhookSkipEntry } from '../services/storage/stats.js';
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
      // Preserve legacy stored fields while exposing the current counters.
      stats.issuesAlreadyCurrent = Number.isSafeInteger(stats.issuesAlreadyCurrent)
        ? stats.issuesAlreadyCurrent
        : 0;
      stats.issuesFailed = Number.isSafeInteger(stats.issuesFailed)
        ? stats.issuesFailed
        : 0;
      stats.lastSuccessfulJiraWrite = typeof stats.lastSuccessfulJiraWrite === 'string'
        ? stats.lastSuccessfulJiraWrite
        : null;
      return stats;
    }
    return {
      lastRun: null,
      issuesChecked: 0,
      issuesCreated: 0,
      issuesUpdated: 0,
      issuesAlreadyCurrent: 0,
      issuesSkipped: 0,
      issuesFailed: 0,
      issuesRecreated: 0,
      lastSuccessfulJiraWrite: null,
      errors: [],
      events: []
    };
  });

  resolver.define('getWebhookSyncStats', async () => {
    const stats = await kvsStore.get('webhookSyncStats');
    if (stats) {
      const safeStats = { ...stats };
      safeStats.errors = boundHistory(
        Array.isArray(stats.errors)
          ? stats.errors
            .filter(error => !isNormalWebhookSkipEntry(error))
            .map(sanitizeErrorEntry)
          : [],
        MAX_ERROR_ENTRIES
      );
      safeStats.lastSuccessfulJiraWrite = typeof stats.lastSuccessfulJiraWrite === 'string'
        ? stats.lastSuccessfulJiraWrite
        : null;
      return safeStats;
    }
    return {
      totalSyncs: 0,
      issuesCreated: 0,
      issuesUpdated: 0,
      commentsSynced: 0,
      issuesSkipped: 0,
      errors: [],
      lastSync: null,
      lastSuccessfulJiraWrite: null
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
