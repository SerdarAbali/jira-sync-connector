import { storage } from '@forge/api';

export function defineConfigResolvers(resolver) {
  resolver.define('getConfig', async () => {
    const config = await storage.get('syncConfig');
    return config || null;
  });

  resolver.define('saveConfig', async ({ payload }) => {
    await storage.set('syncConfig', payload.config);
    return { success: true };
  });

  resolver.define('getUserMappings', async () => {
    const mappings = await storage.get('userMappings');
    const config = await storage.get('userMappingConfig');
    return {
      mappings: mappings || {},
      config: config || { autoMapUsers: true, fallbackUser: 'unassigned' }
    };
  });

  resolver.define('saveUserMappings', async ({ payload }) => {
    await storage.set('userMappings', payload.mappings);
    await storage.set('userMappingConfig', payload.config);
    return { success: true };
  });

  resolver.define('getFieldMappings', async () => {
    const mappings = await storage.get('fieldMappings');
    return mappings || {};
  });

  resolver.define('saveFieldMappings', async ({ payload }) => {
    await storage.set('fieldMappings', payload.mappings);
    return { success: true };
  });

  resolver.define('getStatusMappings', async () => {
    const mappings = await storage.get('statusMappings');
    return mappings || {};
  });

  resolver.define('saveStatusMappings', async ({ payload }) => {
    await storage.set('statusMappings', payload.mappings);
    return { success: true };
  });

  resolver.define('getScheduledSyncConfig', async () => {
    const config = await storage.get('scheduledSyncConfig');
    return config || { 
      enabled: false, 
      intervalMinutes: 60,
      lastRun: null,
      syncScope: 'recent'
    };
  });

  resolver.define('saveScheduledSyncConfig', async ({ payload }) => {
    await storage.set('scheduledSyncConfig', payload.config);
    return { success: true };
  });

  resolver.define('getSyncOptions', async () => {
    const options = await storage.get('syncOptions');
    return options || {
      syncComments: true,
      syncAttachments: true,
      syncLinks: true
    };
  });

  resolver.define('saveSyncOptions', async ({ payload }) => {
    try {
      await storage.set('syncOptions', payload.options);
      return { success: true, message: 'Sync options saved' };
    } catch (error) {
      console.error('Error saving sync options:', error);
      return { success: false, error: error.message };
    }
  });
}
