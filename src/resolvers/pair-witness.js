import {
  PAIR_WITNESS_PREVIEW_ERRORS,
  pairWitnessPreviewErrorMessage,
  previewPairWitnessMigration
} from '../services/sync/pair-witness-preview.js';
import logger from '../utils/logger.js';

function failureCode(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('PAIR_WITNESS_')) {
    return error.code;
  }
  return PAIR_WITNESS_PREVIEW_ERRORS.PREVIEW_FAILED;
}

/**
 * Read-only pairing-witness migration preview.
 *
 * The authorization wrapper enforces ADMIN_READ and the Jira administrator
 * permission before this runs. The preview writes no issue property, creates no
 * issue and changes no mapping, ledger row or pause state; every Jira request it
 * makes is a GET. No approval or apply resolver exists yet.
 */
export function definePairWitnessResolvers(resolver) {
  resolver.define('previewPairWitnessMigration', async ({ payload }) => {
    let orgId = null;
    try {
      orgId = typeof payload?.orgId === 'string' ? payload.orgId : null;
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
}
