import api, { route, fetch, webTrigger } from '@forge/api';
import * as kvsStore from '../services/storage/kvs.js';
import { MAX_STORAGE_SIZE } from '../constants.js';
import { 
  validateOrganizationPayload, 
  validateOrgId, 
  validateMappings, 
  validateObject,
  validateArray,
  validateString
} from '../utils/validation.js';

const DEFAULT_SYNC_OPTIONS = {
  syncComments: true,
  syncAttachments: true,
  syncLinks: true,
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
    const orgs = await kvsStore.get('organizations') || [];
    // Fetch API tokens from secret storage for each org
    const orgsWithTokens = await Promise.all(orgs.map(async (org) => {
      const token = await kvsStore.getSecret(`secret:${org.id}:token`);
      const incomingSecret = await kvsStore.getSecret(`secret:${org.id}:incomingSecret`);
      
      let incomingWebhookUrl = null;
      // Only fetch URL if needed to avoid unnecessary API calls
      if (org.syncDirection === 'bidirectional') {
         try {
           incomingWebhookUrl = await webTrigger.getUrl('incoming-webhook');
         } catch (e) {
           console.error('Failed to get webtrigger url', e);
         }
      }

      return {
        ...org,
        remoteApiToken: token || org.remoteApiToken || '', // Fallback for migration
        incomingSecret: incomingSecret || '',
        incomingWebhookUrl
      };
    }));
    return orgsWithTokens;
  });

  // Add new organization
  resolver.define('addOrganization', async ({ payload }) => {
    try {
      // Validate input
      const validated = validateOrganizationPayload(payload);
      
      const orgs = await kvsStore.get('organizations') || [];
      const orgId = `org-${Date.now()}`;
      
      // Store token separately in secret storage
      if (validated.remoteApiToken) {
        await kvsStore.setSecret(`secret:${orgId}:token`, validated.remoteApiToken);
      }

      // Generate incoming secret if bidirectional
      let incomingSecret = null;
      if (payload.syncDirection === 'bidirectional') {
        incomingSecret = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        await kvsStore.setSecret(`secret:${orgId}:incomingSecret`, incomingSecret);
      }
      
      const newOrg = {
        id: orgId,
        name: validated.name,
        remoteUrl: validated.remoteUrl,
        remoteEmail: validated.remoteEmail,
        // Don't store token in regular storage
        remoteProjectKey: validated.remoteProjectKey,
        allowedProjects: validated.allowedProjects || [],
        jqlFilter: validated.jqlFilter || '',
        syncDirection: payload.syncDirection || 'push',
        createdAt: new Date().toISOString()
      };
      orgs.push(newOrg);
      
      await validateStorageSize('organizations', orgs);
      await kvsStore.set('organizations', orgs);
      
      // Return org with token for UI
      return { success: true, organization: { ...newOrg, remoteApiToken: validated.remoteApiToken } };
    } catch (error) {
      console.error('Error adding organization:', error);
      return { success: false, error: error.message };
    }
  });

  // Update organization
  resolver.define('updateOrganization', async ({ payload }) => {
    try {
      // Validate org ID
      if (!payload.id) {
        return { success: false, error: 'Organization ID is required' };
      }
      validateOrgId(payload.id);
      
      // Validate input
      const validated = validateOrganizationPayload(payload);
      
      const orgs = await kvsStore.get('organizations') || [];
      const index = orgs.findIndex(o => o.id === payload.id);
      if (index === -1) {
        return { success: false, error: 'Organization not found' };
      }
      
      // Update token in secret storage if provided
      if (validated.remoteApiToken) {
        await kvsStore.setSecret(`secret:${payload.id}:token`, validated.remoteApiToken);
      }

      // Handle sync direction change
      const syncDirection = payload.syncDirection || orgs[index].syncDirection || 'push';
      
      // Generate incoming secret if switching to bidirectional and doesn't exist
      if (syncDirection === 'bidirectional') {
        const existingSecret = await kvsStore.getSecret(`secret:${payload.id}:incomingSecret`);
        if (!existingSecret) {
           const newSecret = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
           await kvsStore.setSecret(`secret:${payload.id}:incomingSecret`, newSecret);
        }
      }
      
      orgs[index] = {
        ...orgs[index],
        name: validated.name,
        remoteUrl: validated.remoteUrl,
        remoteEmail: validated.remoteEmail,
        // Don't store token in regular storage
        remoteProjectKey: validated.remoteProjectKey,
        allowedProjects: validated.allowedProjects || [],
        jqlFilter: validated.jqlFilter || '',
        syncDirection: syncDirection,
        updatedAt: new Date().toISOString()
      };
      
      // Remove token from regular storage if it was there before (migration)
      delete orgs[index].remoteApiToken;
      
      await validateStorageSize('organizations', orgs);
      await kvsStore.set('organizations', orgs);
      
      // Return org with token for UI
      return { success: true, organization: { ...orgs[index], remoteApiToken: payload.remoteApiToken } };
    } catch (error) {
      console.error('Error updating organization:', error);
      return { success: false, error: error.message };
    }
  });

  // Delete organization
  resolver.define('deleteOrganization', async ({ payload }) => {
    try {
      // Validate org ID
      if (!payload?.id) {
        return { success: false, error: 'Organization ID is required' };
      }
      validateOrgId(payload.id);
      
      const orgs = await kvsStore.get('organizations') || [];
      const filteredOrgs = orgs.filter(o => o.id !== payload.id);
      await kvsStore.set('organizations', filteredOrgs);
      
      // Clean up the API token from secret storage
      await kvsStore.deleteSecret(`secret:${payload.id}:token`);
      
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
    const config = await kvsStore.get('syncConfig');
    return config || null;
  });

  // Legacy support - save old config (converts to new format)
  resolver.define('saveConfig', async ({ payload }) => {
    await kvsStore.set('syncConfig', payload.config);
    return { success: true };
  });

  // Get user mappings for specific org
  resolver.define('getUserMappings', async ({ payload }) => {
    const orgId = payload?.orgId;
    const key = orgId ? `userMappings:${orgId}` : 'userMappings';
    const mappings = await kvsStore.get(key);
    const config = await kvsStore.get('userMappingConfig');
    return {
      mappings: mappings || {},
      config: config || { autoMapUsers: true, fallbackUser: 'unassigned' }
    };
  });

  // Save user mappings for specific org
  resolver.define('saveUserMappings', async ({ payload }) => {
    try {
      const orgId = payload?.orgId;
      if (orgId) validateOrgId(orgId);
      
      // Validate mappings
      const mappings = validateMappings(payload.mappings || {}, 'mappings');
      const config = validateObject(payload.config || DEFAULT_USER_MAPPING_CONFIG, 'config');
      
      const key = orgId ? `userMappings:${orgId}` : 'userMappings';
      const data = {
        mappings,
        config,
        updatedAt: new Date().toISOString()
      };
      
      await validateStorageSize(key, data);
      await kvsStore.set(key, data.mappings);
      await kvsStore.set('userMappingConfig', config);
      
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
    const mappings = await kvsStore.get(key);
    return mappings || {};
  });

  // Save field mappings for specific org
  resolver.define('saveFieldMappings', async ({ payload }) => {
    try {
      const orgId = payload?.orgId;
      if (orgId) validateOrgId(orgId);
      
      // Validate mappings
      const mappings = validateMappings(payload.mappings || {}, 'mappings');
      
      const key = orgId ? `fieldMappings:${orgId}` : 'fieldMappings';
      
      await validateStorageSize(key, mappings);
      await kvsStore.set(key, mappings);
      
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
    const mappings = await kvsStore.get(key);
    return mappings || {};
  });

  // Save status mappings for specific org
  resolver.define('saveStatusMappings', async ({ payload }) => {
    try {
      const orgId = payload?.orgId;
      if (orgId) validateOrgId(orgId);
      
      // Validate mappings
      const mappings = validateMappings(payload.mappings || {}, 'mappings');
      
      const key = orgId ? `statusMappings:${orgId}` : 'statusMappings';
      
      await validateStorageSize(key, mappings);
      await kvsStore.set(key, mappings);
      
      return { success: true };
    } catch (error) {
      console.error('Error saving status mappings:', error);
      return { success: false, error: error.message };
    }
  });

  // Get issue type mappings for specific org
  resolver.define('getIssueTypeMappings', async ({ payload }) => {
    const orgId = payload?.orgId;
    const key = orgId ? `issueTypeMappings:${orgId}` : 'issueTypeMappings';
    const mappings = await kvsStore.get(key);
    return mappings || {};
  });

  // Save issue type mappings for specific org
  resolver.define('saveIssueTypeMappings', async ({ payload }) => {
    try {
      const orgId = payload?.orgId;
      if (orgId) validateOrgId(orgId);
      
      // Validate mappings
      const mappings = validateMappings(payload.mappings || {}, 'mappings');
      
      const key = orgId ? `issueTypeMappings:${orgId}` : 'issueTypeMappings';
      
      await validateStorageSize(key, mappings);
      await kvsStore.set(key, mappings);
      
      return { success: true };
    } catch (error) {
      console.error('Error saving issue type mappings:', error);
      return { success: false, error: error.message };
    }
  });

  // Get project mappings for specific org (source project key → target project key)
  resolver.define('getProjectMappings', async ({ payload }) => {
    const orgId = payload?.orgId;
    const key = orgId ? `projectMappings:${orgId}` : 'projectMappings';
    const mappings = await kvsStore.get(key);
    return mappings || {};
  });

  // Save project mappings for specific org
  resolver.define('saveProjectMappings', async ({ payload }) => {
    try {
      const orgId = payload?.orgId;
      if (orgId) validateOrgId(orgId);
      
      // Validate mappings (source project key → target project key)
      const mappings = validateMappings(payload.mappings || {}, 'mappings');
      
      const key = orgId ? `projectMappings:${orgId}` : 'projectMappings';
      
      await validateStorageSize(key, mappings);
      await kvsStore.set(key, mappings);
      
      return { success: true, message: 'Project mappings saved' };
    } catch (error) {
      console.error('Error saving project mappings:', error);
      return { success: false, error: error.message };
    }
  });

  resolver.define('getScheduledSyncConfig', async () => {
    const config = await kvsStore.get('scheduledSyncConfig');
    return config || { 
      enabled: false, 
      intervalMinutes: 60,
      lastRun: null,
      syncScope: 'recent'
    };
  });

  resolver.define('saveScheduledSyncConfig', async ({ payload }) => {
    try {
      // Validate config
      const config = validateObject(payload.config, 'config');
      await kvsStore.set('scheduledSyncConfig', config);
      return { success: true };
    } catch (error) {
      console.error('Error saving scheduled sync config:', error);
      return { success: false, error: error.message };
    }
  });

  resolver.define('getSyncOptions', async ({ payload }) => {
    const orgId = payload?.orgId;
    const key = orgId ? `syncOptions:${orgId}` : 'syncOptions';
    const options = await kvsStore.get(key);
    // Default options - syncCrossReference defaults to true for backward compatibility
    const defaults = {
      syncComments: true,
      syncAttachments: true,
      syncLinks: true,
      syncCrossReference: true,
      recreateDeletedIssues: false
    };
    // Merge stored options with defaults to ensure all keys exist
    return options ? { ...defaults, ...options } : defaults;
  });

  resolver.define('saveSyncOptions', async ({ payload }) => {
    try {
      const orgId = payload?.orgId;
      if (orgId) validateOrgId(orgId);
      
      // Validate options
      const options = validateObject(payload.options, 'options');
      
      const key = orgId ? `syncOptions:${orgId}` : 'syncOptions';
      await kvsStore.set(key, options);
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
      validateOrgId(orgId);

      const orgs = await kvsStore.get('organizations') || [];
      const organization = orgs.find(o => o.id === orgId);
      if (!organization) {
        return { success: false, error: 'Organization not found' };
      }

      const [syncOptions, userMappings, fieldMappings, statusMappings, userMappingConfig, scheduledSyncConfig] = await Promise.all([
        kvsStore.get(`syncOptions:${orgId}`),
        kvsStore.get(`userMappings:${orgId}`),
        kvsStore.get(`fieldMappings:${orgId}`),
        kvsStore.get(`statusMappings:${orgId}`),
        kvsStore.get('userMappingConfig'),
        kvsStore.get('scheduledSyncConfig')
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

      const orgs = await kvsStore.get('organizations') || [];
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
        await kvsStore.set('organizations', orgs);
        applied.push('orgDetails');
      }

      if (sectionFlags.syncOptions && importData.syncOptions) {
        await kvsStore.set(`syncOptions:${orgId}`, importData.syncOptions);
        applied.push('syncOptions');
      }

      if (sectionFlags.userMappings && importData.userMappings) {
        const key = `userMappings:${orgId}`;
        await validateStorageSize(key, importData.userMappings);
        await kvsStore.set(key, importData.userMappings);
        if (importData.userMappingConfig) {
          await kvsStore.set('userMappingConfig', importData.userMappingConfig);
        }
        applied.push('userMappings');
      }

      if (sectionFlags.fieldMappings && importData.fieldMappings) {
        const key = `fieldMappings:${orgId}`;
        await validateStorageSize(key, importData.fieldMappings);
        await kvsStore.set(key, importData.fieldMappings);
        applied.push('fieldMappings');
      }

      if (sectionFlags.statusMappings && importData.statusMappings) {
        const key = `statusMappings:${orgId}`;
        await validateStorageSize(key, importData.statusMappings);
        await kvsStore.set(key, importData.statusMappings);
        applied.push('statusMappings');
      }

      if (sectionFlags.scheduledSync && importData.scheduledSyncConfig) {
        await kvsStore.set('scheduledSyncConfig', importData.scheduledSyncConfig);
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
      const organizations = await kvsStore.get('organizations');

      // Check for legacy syncConfig (old format)
      const syncConfig = await kvsStore.get('syncConfig');

      // Check for legacy mappings (not namespaced)
      const userMappings = await kvsStore.get('userMappings');
      const fieldMappings = await kvsStore.get('fieldMappings');
      const statusMappings = await kvsStore.get('statusMappings');
      const syncOptions = await kvsStore.get('syncOptions');

      // Check scheduled sync config
      const scheduledSyncConfig = await kvsStore.get('scheduledSyncConfig');

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
      const syncConfig = await kvsStore.get('syncConfig');

      if (!syncConfig) {
        return { success: false, message: 'No legacy configuration found to migrate' };
      }

      // Check if organizations already exist
      const existingOrgs = await kvsStore.get('organizations') || [];

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
      await kvsStore.set('organizations', existingOrgs);

      // Copy legacy mappings to new org-namespaced format
      const userMappings = await kvsStore.get('userMappings');
      const fieldMappings = await kvsStore.get('fieldMappings');
      const statusMappings = await kvsStore.get('statusMappings');
      const syncOptions = await kvsStore.get('syncOptions');

      if (userMappings) {
        await kvsStore.set(`userMappings:${newOrg.id}`, userMappings);
      }
      if (fieldMappings) {
        await kvsStore.set(`fieldMappings:${newOrg.id}`, fieldMappings);
      }
      if (statusMappings) {
        await kvsStore.set(`statusMappings:${newOrg.id}`, statusMappings);
      }
      if (syncOptions) {
        await kvsStore.set(`syncOptions:${newOrg.id}`, syncOptions);
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

  // Test connection to remote Jira
  resolver.define('testConnection', async ({ payload }) => {
    try {
      const { orgId } = payload;
      
      if (!orgId) {
        return { success: false, error: 'Organization ID is required' };
      }

      const orgs = await kvsStore.get('organizations') || [];
      const org = orgs.find(o => o.id === orgId);
      
      if (!org) {
        return { success: false, error: 'Organization not found' };
      }

      // Get token from secret storage
      const token = await kvsStore.getSecret(`secret:${orgId}:token`);
      const apiToken = token || org.remoteApiToken;

      if (!org.remoteUrl || !org.remoteEmail || !apiToken) {
        return { success: false, error: 'Missing connection details (URL, email, or API token)' };
      }

      const auth = Buffer.from(`${org.remoteEmail}:${apiToken}`).toString('base64');
      const startTime = Date.now();

      const response = await fetch(`${org.remoteUrl}/rest/api/3/myself`, {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json'
        }
      });

      const latency = Date.now() - startTime;

      if (response.ok) {
        const user = await response.json();
        return {
          success: true,
          latency,
          user: {
            displayName: user.displayName,
            emailAddress: user.emailAddress
          },
          message: `Connected as ${user.displayName} (${latency}ms)`
        };
      } else {
        const errorText = await response.text();
        return {
          success: false,
          status: response.status,
          error: response.status === 401 ? 'Invalid credentials' : 
                 response.status === 403 ? 'Access forbidden - check permissions' :
                 `Connection failed: ${response.status}`
        };
      }
    } catch (error) {
      console.error('Test connection error:', error);
      return { success: false, error: error.message };
    }
  });

  // Get last sync time for an organization
  resolver.define('getLastSyncTime', async ({ payload }) => {
    try {
      const { orgId } = payload;
      
      // Get webhook stats (has lastSync per issue)
      const webhookStats = await kvsStore.get('webhookSyncStats');
      const scheduledStats = await kvsStore.get('scheduledSyncStats');
      
      let lastWebhook = webhookStats?.lastSync || null;
      let lastScheduled = scheduledStats?.lastRun || null;
      
      // Return the most recent
      let lastSync = null;
      if (lastWebhook && lastScheduled) {
        lastSync = new Date(lastWebhook) > new Date(lastScheduled) ? lastWebhook : lastScheduled;
      } else {
        lastSync = lastWebhook || lastScheduled;
      }

      return {
        lastSync,
        lastWebhookSync: lastWebhook,
        lastScheduledSync: lastScheduled
      };
    } catch (error) {
      console.error('Error getting last sync time:', error);
      return { lastSync: null };
    }
  });
}
