// Script to check what's in production Forge storage
// This will be called via a resolver to inspect storage

import Resolver from '@forge/resolver';
import { storage } from '@forge/api';

const resolver = new Resolver();

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

    // Get all keys to see what else is stored
    const allKeys = await storage.query().where('key', 'startsWith', '').getMany();

    return {
      organizations: organizations || null,
      syncConfig: syncConfig || null,
      userMappings: userMappings || null,
      fieldMappings: fieldMappings || null,
      statusMappings: statusMappings || null,
      syncOptions: syncOptions || null,
      scheduledSyncConfig: scheduledSyncConfig || null,
      allStorageKeys: allKeys.results.map(item => item.key),
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

    // Copy issue mappings to new org-namespaced format
    const allKeys = await storage.query().where('key', 'startsWith', '').getMany();
    let mappingsCopied = 0;

    for (const item of allKeys.results) {
      const key = item.key;

      // Copy local-to-remote and remote-to-local mappings
      if (key.startsWith('local-to-remote:') || key.startsWith('remote-to-local:')) {
        const value = await storage.get(key);
        const newKey = `${newOrg.id}:${key}`;
        await storage.set(newKey, value);
        mappingsCopied++;
      }
    }

    return {
      success: true,
      message: 'Legacy configuration migrated successfully',
      organization: newOrg,
      mappingsCopied: mappingsCopied,
      note: 'Legacy storage keys preserved for backward compatibility'
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

export const handler = resolver.getDefinitions();
