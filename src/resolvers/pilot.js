import {
  getPilotStatus,
  pausePilot,
  resumePilot
} from '../services/sync/pilot-pause.js';

export function definePilotResolvers(resolver) {
  resolver.define('getPilotStatus', async () => {
    return { success: true, ...(await getPilotStatus()) };
  });

  resolver.define('pausePilot', async ({ payload, context }) => {
    try {
      await pausePilot(payload?.reasonCode, context?.accountId);
      return { success: true, ...(await getPilotStatus()) };
    } catch (error) {
      return {
        success: false,
        error: error?.code === 'INVALID_PAUSE_REASON'
          ? 'Invalid pause reason code'
          : 'Unable to pause Jira writes'
      };
    }
  });

  resolver.define('resumePilot', async ({ context }) => {
    try {
      await resumePilot(context?.accountId);
      return { success: true, ...(await getPilotStatus()) };
    } catch {
      return { success: false, error: 'Unable to resume Jira writes' };
    }
  });
}
