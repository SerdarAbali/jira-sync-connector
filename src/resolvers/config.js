import { storage } from '@forge/api';

const MAX_STORAGE_SIZE = 250000; // 250KB limit per key in Forge

// Utility function to validate storage size
async function validateStorageSize(key, data) {
  const size = JSON.stringify(data).length;
  if (size > MAX_STORAGE_SIZE) {
    throw new Error(`Data for key "${key}" exceeds ${MAX_STORAGE_SIZE} bytes (current: ${size} bytes)`);
  }
  return size;
}

export function defineConfigResolvers(resolver) {
  // Get all organizations
  resolver.define('getOrganizations', async () => {
    const orgs = await storage.get('organizations');
    return orgs || [];
  });

  // Add new organization
  resolver.define('addOrganization', async ({ payload }) => {
    try {
      const orgs = await storage.get('organizations') || [];
      const newOrg = {
        id: `org-${Date.now()}`,
        name: payload.name,
        remoteUrl: payload.remoteUrl,
        remoteEmail: payload.remoteEmail,
        remoteApiToken: payload.remoteApiToken,
        remoteProjectKey: payload.remoteProjectKey,
        allowedProjects: payload.allowedProjects || [],
        createdAt: new Date().toISOString()
      };
      orgs.push(newOrg);
      
      await validateStorageSize('organizations', orgs);
      await storage.set('organizations', orgs);
      
      return { success: true, organization: newOrg };
    } catch (error) {
      console.error('Error adding organization:', error);
      return { success: false, error: error.message };
    }
  });

  // Update organization
  resolver.define('updateOrganization', async ({ payload }) => {
    try {
      const orgs = await storage.get('organizations') || [];
      const index = orgs.findIndex(o => o.id === payload.id);
      if (index === -1) {
        return { success: false, error: 'Organization not found' };
      }
      orgs[index] = {
        ...orgs[index],
        name: payload.name,
        remoteUrl: payload.remoteUrl,
        remoteEmail: payload.remoteEmail,
        remoteApiToken: payload.remoteApiToken,
        remoteProjectKey: payload.remoteProjectKey,
        allowedProjects: payload.allowedProjects || [],
        updatedAt: new Date().toISOString()
      };
      
      await validateStorageSize('organizations', orgs);
      await storage.set('organizations', orgs);
      
      return { success: true, organization: orgs[index] };
    } catch (error) {
      console.error('Error updating organization:', error);
      return { success: false, error: error.message };
    }
  });

  // Delete organization
  resolver.define('deleteOrganization', async ({ payload }) => {
    try {
      const orgs = await storage.get('organizations') || [];
      const filteredOrgs = orgs.filter(o => o.id !== payload.id);
      await storage.set('organizations', filteredOrgs);
      
      // Clean up org-specific mappings
      const orgId = payload.id;
      // Note: We keep mappings for now to preserve sync history
      // They can be manually cleaned if needed
      
      return { success: true };
    } catch (error) {
      console.error('Error deleting organization:', error);
      return { success: false, error: error.message };
    }
  });

  // Legacy support - get old config
  resolver.define('getConfig', async () => {
    const config = await storage.get('syncConfig');
    return config || null;
  });

  // Legacy support - save old config (converts to new format)
  resolver.define('saveConfig', async ({ payload }) => {
    await storage.set('syncConfig', payload.config);
    return { success: true };
  });

  // Get user mappings for specific org
  resolver.define('getUserMappings', async ({ payload }) => {
    const orgId = payload?.orgId;
    const key = orgId ? `userMappings:${orgId}` : 'userMappings';
    const mappings = await storage.get(key);
    const config = await storage.get('userMappingConfig');
    return {
      mappings: mappings || {},
      config: config || { autoMapUsers: true, fallbackUser: 'unassigned' }
    };
  });

  // Save user mappings for specific org
  resolver.define('saveUserMappings', async ({ payload }) => {
    try {
      const orgId = payload?.orgId;
      const key = orgId ? `userMappings:${orgId}` : 'userMappings';
      const data = {
        mappings: payload.mappings,
        config: payload.config,
        updatedAt: new Date().toISOString()
      };
      
      await validateStorageSize(key, data);
      await storage.set(key, data.mappings);
      await storage.set('userMappingConfig', payload.config);
      
      return { success: true };
    } catch (error) {
      console.error('Error saving user mappings:', error);
      return { success: false, error: error.message };
    }
  });

  // Get field mappings for specific org
  resolver.define('getFieldMappings', async ({ payload }) => {
    const orgId = payload?.orgId;
    const key = orgId ? `fieldMappings:${orgId}` : 'fieldMappings';
    const mappings = await storage.get(key);
    return mappings || {};
  });

  // Save field mappings for specific org
  resolver.define('saveFieldMappings', async ({ payload }) => {
    try {
      const orgId = payload?.orgId;
      const key = orgId ? `fieldMappings:${orgId}` : 'fieldMappings';
      
      await validateStorageSize(key, payload.mappings);
      await storage.set(key, payload.mappings);
      
      return { success: true };
    } catch (error) {
      console.error('Error saving field mappings:', error);
      return { success: false, error: error.message };
    }
  });

  // Get status mappings for specific org
  resolver.define('getStatusMappings', async ({ payload }) => {
    const orgId = payload?.orgId;
    const key = orgId ? `statusMappings:${orgId}` : 'statusMappings';
    const mappings = await storage.get(key);
    return mappings || {};
  });

  // Save status mappings for specific org
  resolver.define('saveStatusMappings', async ({ payload }) => {
    try {
      const orgId = payload?.orgId;
      const key = orgId ? `statusMappings:${orgId}` : 'statusMappings';
      
      await validateStorageSize(key, payload.mappings);
      await storage.set(key, payload.mappings);
      
      return { success: true };
    } catch (error) {
      console.error('Error saving status mappings:', error);
      return { success: false, error: error.message };
    }
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

  resolver.define('getSyncOptions', async ({ payload }) => {
    const orgId = payload?.orgId;
    const key = orgId ? `syncOptions:${orgId}` : 'syncOptions';
    const options = await storage.get(key);
    return options || {
      syncComments: true,
      syncAttachments: true,
      syncLinks: true
    };
  });

  resolver.define('saveSyncOptions', async ({ payload }) => {
    try {
      const orgId = payload?.orgId;
      const key = orgId ? `syncOptions:${orgId}` : 'syncOptions';
      await storage.set(key, payload.options);
      return { success: true, message: 'Sync options saved' };
    } catch (error) {
      console.error('Error saving sync options:', error);
      return { success: false, error: error.message };
    }
  });
}
