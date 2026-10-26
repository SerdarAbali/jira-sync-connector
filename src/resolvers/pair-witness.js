import {
  PAIR_WITNESS_PREVIEW_ERRORS,
  pairWitnessPreviewErrorMessage,
  previewPairWitnessMigration
} from '../services/sync/pair-witness-preview.js';
import {
  PairWitnessMigrationError,
  applyPairWitnessMigration,
  approvePairWitnessMigration,
  buildPairWitnessPlan,
  cancelPairWitnessMigration,
  getPairWitnessMigrationStatus,
  pairWitnessMigrationMessage
} from '../services/sync/pair-witness-migration.js';
import { pairWitnessPermitMessage } from '../services/sync/pair-witness-permit.js';
import logger from '../utils/logger.js';

function failureCode(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('PAIR_WITNESS_')) {
    return error.code;
  }
  return PAIR_WITNESS_PREVIEW_ERRORS.PREVIEW_FAILED;
}

function failureMessage(error) {
  if (error instanceof PairWitnessMigrationError) return pairWitnessMigrationMessage(error.code);
  if (error?.code === 'PAIR_WITNESS_PERMIT_REFUSED') return pairWitnessPermitMessage(error.reason);
  if (typeof error?.message === 'string' && error.message !== '') return error.message;
  return pairWitnessPreviewErrorMessage(failureCode(error));
}

function fixedOrganization(payload) {
  return typeof payload?.orgId === 'string' ? payload.orgId : null;
}

/**
 * Pairing-witness resolvers.
 *
 * The preview is ADMIN_READ and writes nothing. Approval, batch execution and
 * cancellation are ADMIN_WRITE and each one requires the connector to be paused;
 * approval additionally requires the exact plan phrase. No resolver can create an
 * issue, update a field or resume synchronization.
 */
export function definePairWitnessResolvers(resolver) {
  resolver.define('previewPairWitnessMigration', async ({ payload }) => {
    let orgId = null;
    try {
      orgId = fixedOrganization(payload);
      return await previewPairWitnessMigration({
        orgId,
        maxPairs: payload?.maxPairs
      });
    } catch (error) {
      const code = failureCode(error);
      logger.warn('Pairing witness preview failed', { code, orgId });
      return {
        success: false,
        readOnly: true,
        code,
        error: pairWitnessPreviewErrorMessage(code)
      };
    }
  });

  /** Recomputes the plan from live evidence without approving anything. */
  resolver.define('planPairWitnessMigration', async ({ payload }) => {
    let orgId = null;
    try {
      orgId = fixedOrganization(payload);
      return {
        success: true,
        plan: await buildPairWitnessPlan({
          orgId,
          // Omitted means the whole organization; an explicit list (including an
          // empty one, which is refused) is passed through untouched.
          pairs: payload?.pairs
        })
      };
    } catch (error) {
      const code = failureCode(error);
      logger.warn('Pairing witness plan failed', { code, orgId });
      return { success: false, code, error: failureMessage(error) };
    }
  });

  resolver.define('approvePairWitnessMigration', async ({ payload, context }) => {
    let orgId = null;
    try {
      orgId = fixedOrganization(payload);
      const result = await approvePairWitnessMigration({
        orgId,
        confirmation: payload?.confirmation,
        pairs: payload?.pairs,
        accountId: typeof context?.accountId === 'string' ? context.accountId : null
      });
      logger.info('Pairing witness plan approved', { orgId, forges: result.counts.writablePairs });
      return result;
    } catch (error) {
      const code = failureCode(error);
      logger.warn('Pairing witness approval refused', { code, orgId });
      return { success: false, code, error: failureMessage(error) };
    }
  });

  resolver.define('applyPairWitnessMigration', async ({ payload, context }) => {
    let orgId = null;
    try {
      orgId = fixedOrganization(payload);
      return await applyPairWitnessMigration({
        orgId,
        accountId: typeof context?.accountId === 'string' ? context.accountId : null
      });
    } catch (error) {
      const code = failureCode(error);
      logger.warn('Pairing witness batch failed', { code, orgId });
      return { success: false, code, error: failureMessage(error) };
    }
  });

  resolver.define('cancelPairWitnessMigration', async ({ payload }) => {
    let orgId = null;
    try {
      orgId = fixedOrganization(payload);
      return await cancelPairWitnessMigration({ orgId });
    } catch (error) {
      const code = failureCode(error);
      logger.warn('Pairing witness cancellation failed', { code, orgId });
      return { success: false, code, error: failureMessage(error) };
    }
  });

  resolver.define('getPairWitnessMigrationStatus', async ({ payload }) => {
    let orgId = null;
    try {
      orgId = fixedOrganization(payload);
      return await getPairWitnessMigrationStatus({ orgId });
    } catch (error) {
      const code = failureCode(error);
      logger.warn('Pairing witness status failed', { code, orgId });
      return { success: false, code, error: failureMessage(error) };
    }
  });
}
