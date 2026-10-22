import { isValidIssueKey } from '../services/storage/mappings.js';
import { validateOrgId } from '../utils/validation.js';
import {
  listDeletedCounterparts,
  probeDeletedCounterpart,
  remapDeletedCounterpart,
  replaceCounterpart,
  endCounterpartSync,
  dismissDeletedCounterpart
} from '../services/sync/counterpart-recovery.js';

function normalizeOrgId(value) {
  if (value === 'legacy') return null;
  return validateOrgId(value);
}

function requiredIssueKey(value, fieldName) {
  if (!isValidIssueKey(value)) {
    throw new Error(`${fieldName} is invalid`);
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

export function defineRecoveryResolvers(resolver) {
  resolver.define('getDeletedCounterparts', async ({ payload }) => {
    try {
      const orgId = normalizeOrgId(payload?.orgId);
      const items = await listDeletedCounterparts(orgId);
      return { success: true, items };
    } catch (error) {
      return safeFailure('COUNTERPART_LIST_FAILED', error);
    }
  });

  resolver.define('probeDeletedCounterpart', async ({ payload }) => {
    try {
      const orgId = normalizeOrgId(payload?.orgId);
      const localKey = requiredIssueKey(payload?.localKey, 'localKey');
      const remoteKey = requiredIssueKey(payload?.remoteKey, 'remoteKey');
      return await probeDeletedCounterpart({ orgId, localKey, remoteKey });
    } catch (error) {
      return safeFailure('COUNTERPART_PROBE_FAILED', error);
    }
  });

  resolver.define('remapDeletedCounterpart', async (request) => {
    try {
      const { payload } = request;
      const orgId = normalizeOrgId(payload?.orgId);
      const localKey = requiredIssueKey(payload?.localKey, 'localKey');
      const remoteKey = requiredIssueKey(payload?.remoteKey, 'remoteKey');
      const newLocalKey = requiredIssueKey(payload?.newLocalKey, 'newLocalKey');
      const newRemoteKey = requiredIssueKey(payload?.newRemoteKey, 'newRemoteKey');
      return await remapDeletedCounterpart({
        orgId,
        localKey,
        remoteKey,
        newLocalKey,
        newRemoteKey,
        actorAccountId: actorAccountId(request)
      });
    } catch (error) {
      return safeFailure('COUNTERPART_REMAP_FAILED', error);
    }
  });

  resolver.define('replaceDeletedCounterpart', async ({ payload }) => {
    try {
      const orgId = normalizeOrgId(payload?.orgId);
      const localKey = requiredIssueKey(payload?.localKey, 'localKey');
      const remoteKey = requiredIssueKey(payload?.remoteKey, 'remoteKey');
      return await replaceCounterpart({ orgId, localKey, remoteKey, automatic: false });
    } catch (error) {
      return safeFailure('COUNTERPART_REPLACEMENT_FAILED', error);
    }
  });

  resolver.define('endDeletedCounterpartSync', async (request) => {
    try {
      const { payload } = request;
      const orgId = normalizeOrgId(payload?.orgId);
      const localKey = requiredIssueKey(payload?.localKey, 'localKey');
      const remoteKey = requiredIssueKey(payload?.remoteKey, 'remoteKey');
      return await endCounterpartSync({
        orgId,
        localKey,
        remoteKey,
        actorAccountId: actorAccountId(request)
      });
    } catch (error) {
      return safeFailure('COUNTERPART_END_FAILED', error);
    }
  });

  resolver.define('dismissDeletedCounterpart', async (request) => {
    try {
      const { payload } = request;
      const orgId = normalizeOrgId(payload?.orgId);
      const localKey = requiredIssueKey(payload?.localKey, 'localKey');
      const remoteKey = requiredIssueKey(payload?.remoteKey, 'remoteKey');
      return await dismissDeletedCounterpart({
        orgId,
        localKey,
        remoteKey,
        actorAccountId: actorAccountId(request)
      });
    } catch (error) {
      return safeFailure('COUNTERPART_DISMISS_FAILED', error);
    }
  });
}
