import { storage } from '@forge/api';
import { getApiUsageStats, resetApiUsageStats } from '../services/storage/stats.js';

export function defineStatsResolvers(resolver) {
  resolver.define('getScheduledSyncStats', async () => {
    const stats = await storage.get('scheduledSyncStats');
    if (stats) {
      stats.events = Array.isArray(stats.events) ? stats.events : [];
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
    const stats = await storage.get('webhookSyncStats');
    return stats || {
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
      const stats = await storage.get('webhookSyncStats');
      if (stats) {
        stats.errors = [];
        await storage.set('webhookSyncStats', stats);
      }
      return { success: true, message: 'Webhook errors cleared' };
    } catch (error) {
      console.error('Error clearing webhook errors:', error);
      return { success: false, error: error.message };
    }
  });

  resolver.define('clearScheduledErrors', async () => {
    try {
      const stats = await storage.get('scheduledSyncStats');
      if (stats) {
        stats.errors = [];
        await storage.set('scheduledSyncStats', stats);
      }
      return { success: true, message: 'Scheduled sync errors cleared' };
    } catch (error) {
      console.error('Error clearing scheduled errors:', error);
      return { success: false, error: error.message };
    }
  });
}
