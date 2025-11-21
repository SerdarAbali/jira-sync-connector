import { storage } from '@forge/api';

export function defineStatsResolvers(resolver) {
  resolver.define('getScheduledSyncStats', async () => {
    const stats = await storage.get('scheduledSyncStats');
    return stats || {
      lastRun: null,
      issuesChecked: 0,
      issuesCreated: 0,
      issuesUpdated: 0,
      issuesSkipped: 0,
      errors: []
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
