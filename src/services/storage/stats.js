import { storage } from '@forge/api';
import { MAX_AUDIT_LOG_ENTRIES } from '../../constants.js';

export async function trackWebhookSync(type, success, error = null, orgId = null) {
  try {
    const stats = await storage.get('webhookSyncStats') || {
      totalSyncs: 0,
      issuesCreated: 0,
      issuesUpdated: 0,
      commentsSynced: 0,
      issuesSkipped: 0,
      errors: [],
      lastSync: null,
      byOrg: {} // Track stats per org
    };

    stats.totalSyncs++;
    stats.lastSync = new Date().toISOString();

    // Track per-org stats if orgId provided
    if (orgId) {
      if (!stats.byOrg[orgId]) {
        stats.byOrg[orgId] = {
          totalSyncs: 0,
          issuesCreated: 0,
          issuesUpdated: 0,
          commentsSynced: 0,
          issuesSkipped: 0,
          lastSync: null
        };
      }
      stats.byOrg[orgId].totalSyncs++;
      stats.byOrg[orgId].lastSync = new Date().toISOString();
      
      if (success) {
        if (type === 'create') stats.byOrg[orgId].issuesCreated++;
        else if (type === 'update') stats.byOrg[orgId].issuesUpdated++;
        else if (type === 'comment') stats.byOrg[orgId].commentsSynced++;
      } else {
        stats.byOrg[orgId].issuesSkipped++;
      }
    }

    // Track global stats
    if (success) {
      if (type === 'create') stats.issuesCreated++;
      else if (type === 'update') stats.issuesUpdated++;
      else if (type === 'comment') stats.commentsSynced++;
    } else {
      stats.issuesSkipped++;
      if (error) {
        // Keep only last 50 errors
        stats.errors.unshift({ 
          timestamp: new Date().toISOString(), 
          error,
          orgId: orgId || 'unknown'
        });
        if (stats.errors.length > 50) stats.errors = stats.errors.slice(0, 50);
      }
    }

    await storage.set('webhookSyncStats', stats);
  } catch (err) {
    console.error('Error tracking webhook stats:', err);
  }
}

export async function logAuditEntry(entry) {
  try {
    const auditLog = await storage.get('auditLog') || [];
    auditLog.unshift({
      ...entry,
      timestamp: new Date().toISOString()
    });
    // Keep only last MAX_AUDIT_LOG_ENTRIES entries to prevent storage bloat
    if (auditLog.length > MAX_AUDIT_LOG_ENTRIES) {
      auditLog.length = MAX_AUDIT_LOG_ENTRIES;
    }
    await storage.set('auditLog', auditLog);
  } catch (error) {
    console.error('Error logging audit entry:', error);
  }
}
