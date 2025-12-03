import { storage } from '@forge/api';

const MAX_STORAGE_SIZE = 250000; // 250KB limit per key in Forge
const DEFAULT_SYNC_OPTIONS = {
  syncComments: true,
  syncAttachments: true,
  syncLinks: true,
  syncSprints: false,
  recreateDeletedIssues: false
};
const DEFAULT_USER_MAPPING_CONFIG = { autoMapUsers: true, fallbackUser: 'unassigned' };

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
      syncLinks: true,
      syncSprints: false,
      recreateDeletedIssues: false
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

  resolver.define('exportOrgSettings', async ({ payload }) => {
    try {
      const orgId = payload?.orgId;
      if (!orgId) {
        return { success: false, error: 'orgId is required' };
      }

      const orgs = await storage.get('organizations') || [];
      const organization = orgs.find(o => o.id === orgId);
      if (!organization) {
        return { success: false, error: 'Organization not found' };
      }

      const [syncOptions, userMappings, fieldMappings, statusMappings, userMappingConfig, scheduledSyncConfig] = await Promise.all([
        storage.get(`syncOptions:${orgId}`),
        storage.get(`userMappings:${orgId}`),
        storage.get(`fieldMappings:${orgId}`),
        storage.get(`statusMappings:${orgId}`),
        storage.get('userMappingConfig'),
        storage.get('scheduledSyncConfig')
      ]);

      const exportBundle = {
        version: 1,
        exportedAt: new Date().toISOString(),
        org: organization,
        syncOptions: syncOptions || DEFAULT_SYNC_OPTIONS,
        userMappings: userMappings || {},
        userMappingConfig: userMappingConfig || DEFAULT_USER_MAPPING_CONFIG,
        fieldMappings: fieldMappings || {},
        statusMappings: statusMappings || {},
        scheduledSyncConfig: scheduledSyncConfig || null
      };

      return { success: true, data: exportBundle };
    } catch (error) {
      console.error('Error exporting org settings:', error);
      return { success: false, error: error.message };
    }
  });

  resolver.define('importOrgSettings', async ({ payload }) => {
    try {
      const orgId = payload?.orgId;
      let importData = payload?.data;
      const sections = payload?.sections || {};

      if (!orgId) {
        return { success: false, error: 'orgId is required' };
      }
      if (!importData) {
        return { success: false, error: 'No import data provided' };
      }

      if (typeof importData === 'string') {
        importData = JSON.parse(importData);
      }

      const orgs = await storage.get('organizations') || [];
      const orgIndex = orgs.findIndex(o => o.id === orgId);
      if (orgIndex === -1) {
        return { success: false, error: 'Organization not found' };
      }

      const sectionFlags = {
        orgDetails: sections.orgDetails !== undefined ? sections.orgDetails : true,
        syncOptions: sections.syncOptions !== undefined ? sections.syncOptions : true,
        userMappings: sections.userMappings !== undefined ? sections.userMappings : true,
        fieldMappings: sections.fieldMappings !== undefined ? sections.fieldMappings : true,
        statusMappings: sections.statusMappings !== undefined ? sections.statusMappings : true,
        scheduledSync: sections.scheduledSync !== undefined ? sections.scheduledSync : false
      };

      const applied = [];

      if (sectionFlags.orgDetails && importData.org) {
        orgs[orgIndex] = {
          ...orgs[orgIndex],
          name: importData.org.name ?? orgs[orgIndex].name,
          remoteUrl: importData.org.remoteUrl ?? orgs[orgIndex].remoteUrl,
          remoteEmail: importData.org.remoteEmail ?? orgs[orgIndex].remoteEmail,
          remoteApiToken: importData.org.remoteApiToken ?? orgs[orgIndex].remoteApiToken,
          remoteProjectKey: importData.org.remoteProjectKey ?? orgs[orgIndex].remoteProjectKey,
          allowedProjects: importData.org.allowedProjects ?? orgs[orgIndex].allowedProjects,
          updatedAt: new Date().toISOString()
        };

        await validateStorageSize('organizations', orgs);
        await storage.set('organizations', orgs);
        applied.push('orgDetails');
      }

      if (sectionFlags.syncOptions && importData.syncOptions) {
        await storage.set(`syncOptions:${orgId}`, importData.syncOptions);
        applied.push('syncOptions');
      }

      if (sectionFlags.userMappings && importData.userMappings) {
        const key = `userMappings:${orgId}`;
        await validateStorageSize(key, importData.userMappings);
        await storage.set(key, importData.userMappings);
        if (importData.userMappingConfig) {
          await storage.set('userMappingConfig', importData.userMappingConfig);
        }
        applied.push('userMappings');
      }

      if (sectionFlags.fieldMappings && importData.fieldMappings) {
        const key = `fieldMappings:${orgId}`;
        await validateStorageSize(key, importData.fieldMappings);
        await storage.set(key, importData.fieldMappings);
        applied.push('fieldMappings');
      }

      if (sectionFlags.statusMappings && importData.statusMappings) {
        const key = `statusMappings:${orgId}`;
        await validateStorageSize(key, importData.statusMappings);
        await storage.set(key, importData.statusMappings);
        applied.push('statusMappings');
      }

      if (sectionFlags.scheduledSync && importData.scheduledSyncConfig) {
        await storage.set('scheduledSyncConfig', importData.scheduledSyncConfig);
        applied.push('scheduledSync');
      }

      if (applied.length === 0) {
        return { success: false, error: 'No matching sections to import' };
      }

      return {
        success: true,
        message: `Imported sections: ${applied.join(', ')}`
      };
    } catch (error) {
      console.error('Error importing org settings:', error);
      return { success: false, error: error.message };
    }
  });

  // Debug: Check what's in production storage
  resolver.define('checkStorage', async () => {
    try {
      // Check for organizations (new format)
      const organizations = await storage.get('organizations');

      // Check for legacy syncConfig (old format)
      const syncConfig = await storage.get('syncConfig');

      // Check for legacy mappings (not namespaced)
      const userMappings = await storage.get('userMappings');
      const fieldMappings = await storage.get('fieldMappings');
      const statusMappings = await storage.get('statusMappings');
      const syncOptions = await storage.get('syncOptions');

      // Check scheduled sync config
      const scheduledSyncConfig = await storage.get('scheduledSyncConfig');

      return {
        organizations: organizations || null,
        syncConfig: syncConfig || null,
        userMappings: userMappings || null,
        fieldMappings: fieldMappings || null,
        statusMappings: statusMappings || null,
        syncOptions: syncOptions || null,
        scheduledSyncConfig: scheduledSyncConfig || null,
        summary: {
          hasOrganizations: !!organizations && organizations.length > 0,
          hasLegacyConfig: !!syncConfig,
          hasLegacyMappings: !!(userMappings || fieldMappings || statusMappings),
          organizationCount: organizations ? organizations.length : 0
        }
      };
    } catch (error) {
      console.error('Error checking storage:', error);
      return {
        error: error.message,
        stack: error.stack
      };
    }
  });

  // Migrate legacy configuration to new organization format
  resolver.define('migrateLegacyConfig', async () => {
    try {
      const syncConfig = await storage.get('syncConfig');

      if (!syncConfig) {
        return { success: false, message: 'No legacy configuration found to migrate' };
      }

      // Check if organizations already exist
      const existingOrgs = await storage.get('organizations') || [];

      // Check if this legacy config is already migrated
      const alreadyMigrated = existingOrgs.some(org =>
        org.remoteUrl === syncConfig.remoteUrl &&
        org.remoteProjectKey === syncConfig.remoteProjectKey
      );

      if (alreadyMigrated) {
        return { success: false, message: 'This configuration has already been migrated' };
      }

      // Create a new organization from legacy config
      const newOrg = {
        id: `org-${Date.now()}`,
        name: `Legacy Organization (${syncConfig.remoteProjectKey})`,
        remoteUrl: syncConfig.remoteUrl,
        remoteEmail: syncConfig.remoteEmail,
        remoteApiToken: syncConfig.remoteApiToken,
        remoteProjectKey: syncConfig.remoteProjectKey,
        allowedProjects: syncConfig.allowedProjects || [],
        createdAt: new Date().toISOString(),
        migratedFrom: 'legacy-syncConfig'
      };

      existingOrgs.push(newOrg);
      await storage.set('organizations', existingOrgs);

      // Copy legacy mappings to new org-namespaced format
      const userMappings = await storage.get('userMappings');
      const fieldMappings = await storage.get('fieldMappings');
      const statusMappings = await storage.get('statusMappings');
      const syncOptions = await storage.get('syncOptions');

      if (userMappings) {
        await storage.set(`userMappings:${newOrg.id}`, userMappings);
      }
      if (fieldMappings) {
        await storage.set(`fieldMappings:${newOrg.id}`, fieldMappings);
      }
      if (statusMappings) {
        await storage.set(`statusMappings:${newOrg.id}`, statusMappings);
      }
      if (syncOptions) {
        await storage.set(`syncOptions:${newOrg.id}`, syncOptions);
      }

      return {
        success: true,
        message: 'Legacy configuration migrated successfully',
        organization: newOrg,
        note: 'Legacy storage keys preserved for backward compatibility. Issue mappings will be handled automatically during sync.'
      };
    } catch (error) {
      console.error('Error migrating legacy config:', error);
      return {
        success: false,
        error: error.message,
        stack: error.stack
      };
    }
  });
}
