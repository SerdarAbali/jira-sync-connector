import * as kvsStore from '../services/storage/kvs.js';
import { sanitizeAuditEntry, safeErrorForLog } from '../utils/redaction.js';

export function defineAuditResolvers(resolver) {
  resolver.define('getAuditLog', async () => {
    const log = await kvsStore.get('auditLog');
    return Array.isArray(log) ? log.map(sanitizeAuditEntry) : [];
  });

  resolver.define('clearAuditLog', async () => {
    try {
      await kvsStore.set('auditLog', []);
      return { success: true, message: 'Audit log cleared' };
    } catch (error) {
      console.error('Error clearing audit log:', safeErrorForLog(error));
      return { success: false, error: 'Unable to clear audit log' };
    }
  });
}
