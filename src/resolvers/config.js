import api, { route, fetch, webTrigger } from '@forge/api';
import { randomBytes } from 'crypto';
import * as kvsStore from '../services/storage/kvs.js';
import { MAX_STORAGE_SIZE } from '../constants.js';
import { redactSecrets } from '../utils/redaction.js';
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
const WEBHOOK_SECRET_ENTROPY_BYTES = 32;

function tokenSecretKey(orgId) {
  return `secret:${orgId}:token`;
}

function incomingSecretKey(orgId) {
  return `secret:${orgId}:incomingSecret`;
}

function webhookMetadataKey(orgId) {
  return `webhookSecretMeta:${orgId}`;
}

function generateWebhookSecret() {
  return randomBytes(WEBHOOK_SECRET_ENTROPY_BYTES).toString('base64url');
}

function sanitizeWebhookUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function buildWebhookCallbackUrl(baseUrl, orgId, secret) {
  const safeBase = sanitizeWebhookUrl(baseUrl);
  if (!safeBase || !orgId || !secret) return null;
  return `${safeBase.replace(/\/$/, '')}/${orgId}/${secret}`;
}

function toSafeOrganization(org, { hasToken, webhookConfigured, webhookMetadata, webhookUrl } = {}) {
  return {
    id: org.id,
    name: org.name,
    remoteUrl: org.remoteUrl,
    remoteEmail: org.remoteEmail,
    remoteProjectKey: org.remoteProjectKey,
    allowedProjects: org.allowedProjects || [],
    jqlFilter: org.jqlFilter || '',
    syncDirection: org.syncDirection || 'push',
    createdAt: org.createdAt || null,
    updatedAt: org.updatedAt || null,
    hasRemoteApiToken: !!hasToken,
    webhookConfigured: !!webhookConfigured,
    webhookSecretLastRotatedAt: webhookMetadata?.rotatedAt || null,
    webhookUrlConfigured: !!webhookUrl,
    incomingWebhookUrl: sanitizeWebhookUrl(webhookUrl)
  };
}

async function recordWebhookRotation(orgId, accountId) {
  try {
    await kvsStore.set(webhookMetadataKey(orgId), {
      rotatedAt: new Date().toISOString(),
      rotatedByAccountId: accountId || null
    });
  } catch {
    // Metadata is non-credential and must not prevent a successful rotation
    // from revealing the one-time secret to the administrator.
    console.warn('Webhook rotation metadata could not be stored');
  }
}

/**
 * Move any plaintext credentials found on organization records into secret
 * storage before removing them. Returns true when normal storage needs
 * rewriting. If setSecret fails, the plaintext field is left in place and the
 * migration aborts so the only usable credential is not deleted.
 */
async function migratePlaintextOrganizationTokens(orgs) {
  let changed = false;
  for (const org of orgs) {
    const plaintext = typeof org.remoteApiToken === 'string' ? org.remoteApiToken.trim() : '';
    const plaintextIncoming = typeof org.incomingSecret === 'string' ? org.incomingSecret.trim() : '';

    if (plaintext) {
      const existingSecret = await kvsStore.getSecret(tokenSecretKey(org.id));
      if (!existingSecret) {
        await kvsStore.setSecret(tokenSecretKey(org.id), plaintext);
      }
      delete org.remoteApiToken;
      changed = true;
    }

    if (plaintextIncoming) {
      const existingIncoming = await kvsStore.getSecret(incomingSecretKey(org.id));
      if (!existingIncoming) {
        await kvsStore.setSecret(incomingSecretKey(org.id), plaintextIncoming);
      }
      delete org.incomingSecret;
      changed = true;
    }
  }
  return changed;
}

// Utility function to validate storage size
async function validateStorageSize(key, data) {
  const size = JSON.stringify(data).length;
  if (size > MAX_STORAGE_SIZE) {
    throw new Error(`Data for key "${key}" exceeds ${MAX_STORAGE_SIZE} bytes (current: ${size} bytes)`);
  }
  return size;
}

export function defineConfigResolvers(resolver) {
  // Get all organizations without returning credential material
  resolver.define('getOrganizations', async () => {
    let orgs = await kvsStore.get('organizations') || [];
    
    // Legacy fallback: if no organizations, check for legacy syncConfig.
    // The legacy token is read from secret storage only.
    if (orgs.length === 0) {
      const legacyConfig = await kvsStore.get('syncConfig');
      if (legacyConfig && legacyConfig.remoteUrl) {
        console.log('📋 Found legacy syncConfig, returning safe organization metadata');
        orgs = [{
          id: 'legacy',
          name: 'Legacy Organization',
          remoteUrl: legacyConfig.remoteUrl,
          remoteEmail: legacyConfig.remoteEmail,
          remoteProjectKey: legacyConfig.remoteProjectKey,
          allowedProjects: legacyConfig.allowedProjects || [],
          jqlFilter: legacyConfig.jqlFilter || '',
          syncDirection: legacyConfig.syncDirection || 'push',
          createdAt: legacyConfig.createdAt || null
        }];
      }
    }

    return await Promise.all(orgs.map(async (org) => {
      const [token, webhookSecret, webhookMetadata] = await Promise.all([
        kvsStore.getSecret(tokenSecretKey(org.id)),
        kvsStore.getSecret(incomingSecretKey(org.id)),
        kvsStore.get(webhookMetadataKey(org.id))
      ]);

      let webhookUrl = null;
      if (org.syncDirection === 'bidirectional') {
        try {
          webhookUrl = await webTrigger.getUrl('incoming-webhook');
        } catch (e) {
          console.error('Failed to get webtrigger url');
        }
      }

      return toSafeOrganization(org, {
        hasToken: !!token,
        webhookConfigured: !!webhookSecret,
        webhookMetadata,
        webhookUrl
      });
    }));
  });

  // Add new organization
  resolver.define('addOrganization', async ({ payload, context }) => {
    try {
      // Validate input
      const validated = validateOrganizationPayload(payload);
      
      const orgs = await kvsStore.get('organizations') || [];
      const orgId = `org-${Date.now()}`;
      
      // Store token separately in secret storage
      if (validated.remoteApiToken) {
        await kvsStore.setSecret(tokenSecretKey(orgId), validated.remoteApiToken);
      }

      // Incoming webhook credentials always live in secret storage.
      const incomingSecret = generateWebhookSecret();
      await kvsStore.setSecret(incomingSecretKey(orgId), incomingSecret);
      await recordWebhookRotation(orgId, context?.accountId);
      
      const newOrg = {
        id: orgId,
        name: validated.name,
        remoteUrl: validated.remoteUrl,
        remoteEmail: validated.remoteEmail,
        // Never store token in regular storage
        remoteProjectKey: validated.remoteProjectKey,
        allowedProjects: validated.allowedProjects || [],
        jqlFilter: validated.jqlFilter || '',
        syncDirection: payload.syncDirection || 'push',
        createdAt: new Date().toISOString()
      };
      orgs.push(newOrg);
      
      await validateStorageSize('organizations', orgs);
      await kvsStore.set('organizations', orgs);
      
      return {
        success: true,
        organization: toSafeOrganization(newOrg, {
          hasToken: !!validated.remoteApiToken,
          webhookConfigured: true
        })
      };
    } catch (error) {
      console.error('Error adding organization');
      return { success: false, error: error.message };
    }
  });

  // Update organization. An absent or empty token means "keep existing".
  resolver.define('updateOrganization', async ({ payload, context }) => {
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
      
      // Update token in secret storage only when explicitly supplied.
      if (validated.remoteApiToken) {
        await kvsStore.setSecret(tokenSecretKey(payload.id), validated.remoteApiToken);
      }

      // Handle sync direction change
      const syncDirection = payload.syncDirection || orgs[index].syncDirection || 'push';
      
      // Generate an incoming secret only if bidirectional and none exists.
      if (syncDirection === 'bidirectional') {
        const existingSecret = await kvsStore.getSecret(incomingSecretKey(payload.id));
        if (!existingSecret) {
          await kvsStore.setSecret(incomingSecretKey(payload.id), generateWebhookSecret());
          await recordWebhookRotation(payload.id, context?.accountId);
        }
      }
      
      orgs[index] = {
        ...orgs[index],
        name: validated.name,
        remoteUrl: validated.remoteUrl,
        remoteEmail: validated.remoteEmail,
        // Never store token in regular storage
        remoteProjectKey: validated.remoteProjectKey,
        allowedProjects: validated.allowedProjects || [],
        jqlFilter: validated.jqlFilter || '',
        syncDirection: syncDirection,
        updatedAt: new Date().toISOString()
      };
      
      // Remove legacy plaintext token if present.
      delete orgs[index].remoteApiToken;
      
      await validateStorageSize('organizations', orgs);
      await kvsStore.set('organizations', orgs);
      
      const hasToken = !!(await kvsStore.getSecret(tokenSecretKey(payload.id)));
      return {
        success: true,
        organization: toSafeOrganization(orgs[index], { hasToken })
      };
    } catch (error) {
      console.error('Error updating organization');
      return { success: false, error: error.message };
    }
  });

  // Explicit, audited token replacement. The token is never returned.
  resolver.define('replaceOrganizationToken', async ({ payload }) => {
    try {
      const orgId = payload?.orgId;
      if (!orgId) {
        return { success: false, error: 'orgId is required' };
      }
      validateOrgId(orgId);

      const remoteApiToken = validateString(payload?.remoteApiToken, 'remoteApiToken', 500);
      if (!remoteApiToken) {
        return { success: false, error: 'A new API token is required' };
      }

      const orgs = await kvsStore.get('organizations') || [];
      if (!orgs.some(org => org.id === orgId)) {
        return { success: false, error: 'Organization not found' };
      }

      await kvsStore.setSecret(tokenSecretKey(orgId), remoteApiToken);
      return { success: true, hasRemoteApiToken: true };
    } catch (error) {
      console.error('Error replacing organization token');
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
      
      // Clean up both credentials and rotation metadata from secret/normal storage
      await Promise.all([
        kvsStore.deleteSecret(tokenSecretKey(payload.id)),
        kvsStore.deleteSecret(incomingSecretKey(payload.id)),
        kvsStore.del(webhookMetadataKey(payload.id))
      ]);
      
      // Clean up org-specific mappings
      // Note: We keep mappings for now to preserve sync history
      // They can be manually cleaned if needed
      
      return { success: true };
    } catch (error) {
      console.error('Error deleting organization:', error);
      return { success: false, error: error.message };
    }
  });

  // Explicit, audited webhook secret rotation. The new secret is returned once
  // so an administrator can configure it in Jira; it is never returned again.
  resolver.define('rotateWebhookSecret', async ({ payload, context }) => {
    try {
      const orgId = payload?.orgId;
      if (!orgId) {
        return { success: false, error: 'orgId is required' };
      }
      validateOrgId(orgId);

      const orgs = await kvsStore.get('organizations') || [];
      const org = orgs.find(candidate => candidate.id === orgId);
      if (!org) {
        return { success: false, error: 'Organization not found' };
      }
      if ((org.syncDirection || 'push') !== 'bidirectional') {
        return { success: false, error: 'Webhook secret rotation requires bidirectional sync' };
      }

      const secret = generateWebhookSecret();
      await kvsStore.setSecret(incomingSecretKey(orgId), secret);
      await recordWebhookRotation(orgId, context?.accountId);

      let callbackUrl = null;
      try {
        callbackUrl = buildWebhookCallbackUrl(await webTrigger.getUrl('incoming-webhook'), orgId, secret);
      } catch {
        callbackUrl = null;
      }

      return {
        success: true,
        code: 'WEBHOOK_SECRET_ROTATED',
        oneTimeDisplay: true,
        secret,
        callbackUrl,
        message: 'Copy this one-time callback URL into Jira System Webhooks now. It cannot be retrieved again.'
      };
    } catch (error) {
      console.error('Error rotating webhook secret');
      return { success: false, error: error.message };
    }
  });

  // Legacy support - get old config without credentials
  resolver.define('getConfig', async () => {
    const config = await kvsStore.get('syncConfig');
    if (!config) return null;
    return {
      ...redactSecrets(config),
      hasRemoteApiToken: !!(await kvsStore.getSecret('secret:legacy:token'))
    };
  });

  // Legacy support - save old config with credentials redirected to secrets
  resolver.define('saveConfig', async ({ payload }) => {
    const config = { ...(payload?.config || {}) };
    const legacyToken = typeof config.remoteApiToken === 'string' ? config.remoteApiToken.trim() : '';
    const legacyIncomingSecret = typeof config.incomingSecret === 'string' ? config.incomingSecret.trim() : '';
    if (legacyToken) {
      await kvsStore.setSecret('secret:legacy:token', legacyToken);
    }
    if (legacyIncomingSecret) {
      await kvsStore.setSecret('secret:legacy:incomingSecret', legacyIncomingSecret);
    }
    await kvsStore.set('syncConfig', redactSecrets(config));
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

      return { success: true, data: redactSecrets(exportBundle) };
    } catch (error) {
      console.error('Error exporting org settings:', error);
      return { success: false, error: error.message };
    }
  });

  resolver.define('importOrgSettings', async ({ payload, context }) => {
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
        const importedToken = typeof importData.org.remoteApiToken === 'string'
          ? importData.org.remoteApiToken.trim()
          : '';
        const importedIncomingSecret = typeof importData.org.incomingSecret === 'string'
          ? importData.org.incomingSecret.trim()
          : '';
        if (importedToken) {
          // Credentials are written to secret storage before normal storage.
          await kvsStore.setSecret(tokenSecretKey(orgId), importedToken);
        }
        if (importedIncomingSecret) {
          await kvsStore.setSecret(incomingSecretKey(orgId), importedIncomingSecret);
          await recordWebhookRotation(orgId, context?.accountId);
        }

        orgs[orgIndex] = {
          ...orgs[orgIndex],
          name: importData.org.name ?? orgs[orgIndex].name,
          remoteUrl: importData.org.remoteUrl ?? orgs[orgIndex].remoteUrl,
          remoteEmail: importData.org.remoteEmail ?? orgs[orgIndex].remoteEmail,
          // Never copy remoteApiToken into normal storage.
          remoteProjectKey: importData.org.remoteProjectKey ?? orgs[orgIndex].remoteProjectKey,
          allowedProjects: importData.org.allowedProjects ?? orgs[orgIndex].allowedProjects,
          updatedAt: new Date().toISOString()
        };
        delete orgs[orgIndex].remoteApiToken;
        delete orgs[orgIndex].incomingSecret;

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
      console.error('Error importing org settings');
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

      return redactSecrets({
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
      });
    } catch (error) {
      console.error('Error checking storage:', error);
      return {
        error: error.message,
        stack: error.stack
      };
    }
  });

  // Migrate legacy configuration to new organization format.
  // The plaintext token is copied to secret storage before any normal-storage
  // deletion. Failures leave the legacy token intact so it can be retried.
  resolver.define('migrateLegacyConfig', async () => {
    try {
      const syncConfig = await kvsStore.get('syncConfig');

      if (!syncConfig) {
        return { success: false, message: 'No legacy configuration found to migrate' };
      }

      const configToken = typeof syncConfig.remoteApiToken === 'string'
        ? syncConfig.remoteApiToken.trim()
        : '';
      const legacyToken = configToken || (await kvsStore.getSecret('secret:legacy:token')) || '';
      const configIncomingSecret = typeof syncConfig.incomingSecret === 'string'
        ? syncConfig.incomingSecret.trim()
        : '';
      const legacyIncomingSecret = configIncomingSecret
        || (await kvsStore.getSecret('secret:legacy:incomingSecret'))
        || '';

      const existingOrgs = await kvsStore.get('organizations') || [];

      // Scrub any plaintext tokens already present on organization records.
      if (await migratePlaintextOrganizationTokens(existingOrgs)) {
        await kvsStore.set('organizations', existingOrgs);
      }

      const alreadyMigrated = existingOrgs.find(org =>
        org.remoteUrl === syncConfig.remoteUrl &&
        org.remoteProjectKey === syncConfig.remoteProjectKey
      );

      if (alreadyMigrated) {
        // Complete an interrupted migration idempotently, then scrub plaintext.
        if (legacyToken && !(await kvsStore.getSecret(tokenSecretKey(alreadyMigrated.id)))) {
          await kvsStore.setSecret(tokenSecretKey(alreadyMigrated.id), legacyToken);
        }
        if (legacyIncomingSecret && !(await kvsStore.getSecret(incomingSecretKey(alreadyMigrated.id)))) {
          await kvsStore.setSecret(incomingSecretKey(alreadyMigrated.id), legacyIncomingSecret);
        }
        const cleaned = redactSecrets(syncConfig);
        if (syncConfig.remoteApiToken !== undefined || syncConfig.incomingSecret !== undefined) {
          await kvsStore.set('syncConfig', cleaned);
        }
        const hasToken = !!(await kvsStore.getSecret(tokenSecretKey(alreadyMigrated.id)));
        return {
          success: true,
          message: 'This configuration was already migrated; legacy plaintext credentials were removed',
          organization: toSafeOrganization(alreadyMigrated, { hasToken })
        };
      }

      // Create a new organization from legacy config without any plaintext token.
      const newOrg = {
        id: `org-${Date.now()}`,
        name: `Legacy Organization (${syncConfig.remoteProjectKey})`,
        remoteUrl: syncConfig.remoteUrl,
        remoteEmail: syncConfig.remoteEmail,
        remoteProjectKey: syncConfig.remoteProjectKey,
        allowedProjects: syncConfig.allowedProjects || [],
        jqlFilter: syncConfig.jqlFilter || '',
        syncDirection: syncConfig.syncDirection || 'push',
        createdAt: new Date().toISOString(),
        migratedFrom: 'legacy-syncConfig'
      };

      // Secret first. If this fails, the legacy config is untouched.
      if (legacyToken) {
        await kvsStore.setSecret(tokenSecretKey(newOrg.id), legacyToken);
      }
      if (legacyIncomingSecret) {
        await kvsStore.setSecret(incomingSecretKey(newOrg.id), legacyIncomingSecret);
      }

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

      // Remove legacy plaintext only after the organization and its secret
      // are safely written.
      await kvsStore.set('syncConfig', redactSecrets(syncConfig));

      return {
        success: true,
        message: 'Legacy configuration migrated successfully',
        organization: toSafeOrganization(newOrg, { hasToken: !!legacyToken }),
        note: 'Legacy storage keys are sanitized. Issue mappings are handled during sync.'
      };
    } catch (error) {
      console.error('Error migrating legacy config');
      return {
        success: false,
        error: 'Legacy migration failed safely; no stored credential was deleted'
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
      const apiToken = token;

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
