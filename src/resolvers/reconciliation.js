import { validateOrgId } from '../utils/validation.js';
import { isValidIssueKey } from '../services/storage/mappings.js';
import {
  acknowledgeRecurringReconciliationAttention,
  getRecurringReconciliationStatus,
  listRecurringReconciliationAttention,
  resolveRecurringReconciliationAttention,
  saveRecurringReconciliationSettings
} from '../services/sync/source-reconciliation.js';

function requiredOrgId(value) {
  return validateOrgId(value);
}

function requiredIssueKey(value) {
  if (!isValidIssueKey(value)) {
    throw new Error('localKey is invalid');
  }
  return value;
}

function actorAccountId(request) {
  const value = request?.context?.accountId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeFailure(code, error) {
  return {
    success: false,
    code: error?.code || code
  };
}

export function defineReconciliationResolvers(resolver) {
  resolver.define('getRecurringReconciliationStatus', async ({ payload }) => {
    try {
      return await getRecurringReconciliationStatus({
        orgId: requiredOrgId(payload?.orgId)
      });
    } catch (error) {
      return safeFailure('RECONCILIATION_STATUS_FAILED', error);
    }
  });

  resolver.define('saveRecurringReconciliationSettings', async ({ payload }) => {
    try {
      return await saveRecurringReconciliationSettings({
        orgId: requiredOrgId(payload?.orgId),
        settings: payload?.settings
      });
    } catch (error) {
      return safeFailure('RECONCILIATION_SAVE_SETTINGS_FAILED', error);
    }
  });

  resolver.define('getRecurringReconciliationAttention', async ({ payload }) => {
    try {
      return await listRecurringReconciliationAttention({
        orgId: requiredOrgId(payload?.orgId)
      });
    } catch (error) {
      return safeFailure('RECONCILIATION_ATTENTION_LIST_FAILED', error);
    }
  });

  resolver.define('acknowledgeRecurringReconciliationAttention', async (request) => {
    try {
      return await acknowledgeRecurringReconciliationAttention({
        orgId: requiredOrgId(request?.payload?.orgId),
        localKey: requiredIssueKey(request?.payload?.localKey),
        actorAccountId: actorAccountId(request)
      });
    } catch (error) {
      return safeFailure('RECONCILIATION_ACKNOWLEDGE_FAILED', error);
    }
  });

  resolver.define('resolveRecurringReconciliationAttention', async (request) => {
    try {
      return await resolveRecurringReconciliationAttention({
        orgId: requiredOrgId(request?.payload?.orgId),
        localKey: requiredIssueKey(request?.payload?.localKey),
        actorAccountId: actorAccountId(request)
      });
    } catch (error) {
      return safeFailure('RECONCILIATION_RESOLVE_FAILED', error);
    }
  });
}
