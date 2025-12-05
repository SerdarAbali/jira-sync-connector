import * as kvsStore from '../services/storage/kvs.js';

export function defineAuditResolvers(resolver) {
  resolver.define('getAuditLog', async () => {
    const log = await kvsStore.get('auditLog');
    return log || [];
  });

  resolver.define('clearAuditLog', async () => {
    try {
      await kvsStore.set('auditLog', []);
      return { success: true, message: 'Audit log cleared' };
    } catch (error) {
      console.error('Error clearing audit log:', error);
      return { success: false, error: error.message };
    }
  });
}
