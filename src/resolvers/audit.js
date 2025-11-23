import { storage } from '@forge/api';

export function defineAuditResolvers(resolver) {
  resolver.define('getAuditLog', async () => {
    const log = await storage.get('auditLog');
    return log || [];
  });

  resolver.define('clearAuditLog', async () => {
    try {
      await storage.set('auditLog', []);
      return { success: true, message: 'Audit log cleared' };
    } catch (error) {
      console.error('Error clearing audit log:', error);
      return { success: false, error: error.message };
    }
  });
}
