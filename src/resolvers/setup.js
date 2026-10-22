import { handleSetupWizardAction } from '../services/setup/setup-wizard.js';

export function defineSetupResolvers(resolver) {
  resolver.define('setupWizard', async ({ payload, context }) => {
    return await handleSetupWizardAction({
      action: payload?.action,
      orgId: payload?.orgId,
      step: payload?.step,
      data: payload?.data,
      approved: payload?.approved === true,
      accountId: context?.accountId || null
    });
  });
}
