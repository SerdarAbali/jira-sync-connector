import api, { route, fetch } from '../jira/guarded-api.js';
import { executeWriteWithRetry } from './write-retry.js';
import { createRetryBudget } from '../../utils/retry.js';
import {
  PAIR_WITNESS_PROPERTY_KEY,
  PAIR_WITNESS_READ_CLASSES,
  PAIR_WITNESS_SIDES,
  PAIR_WITNESS_STATES,
  buildPairWitness,
  pairWitnessPayloadDigest,
  readPairWitness,
  samePairWitness
} from './pair-witness.js';

/**
 * The only module that writes the pairing witness.
 *
 * Every request it makes passes the guarded transport, so the maintenance permit
 * is re-evaluated for each individual PUT against the exact body it sends. The
 * module issues no other verb: no creation, no field update, no delete, and no
 * storage write of any kind.
 *
 * Ordering is fixed and deliberate: local property first, read back, then remote
 * property, read back. A failure on the first side therefore leaves the pair
 * untouched rather than half-written on the site that is harder to reach.
 */

export const PAIR_WITNESS_WRITE_OUTCOMES = Object.freeze({
  APPLIED: 'applied',
  SKIPPED_IDENTICAL: 'skipped-identical',
  CONFLICT: 'conflict',
  PARTIAL: 'partial',
  DEFERRED: 'deferred',
  FAILED: 'failed'
});

function basicAuth(org) {
  return Buffer.from(`${org.remoteEmail}:${org.remoteApiToken}`).toString('base64');
}

function propertyPath(issueId) {
  return `/rest/api/3/issue/${issueId}/properties/${PAIR_WITNESS_PROPERTY_KEY}`;
}

/** Canonical body for one issue of a pair. Byte-stable for the same inputs. */
export function buildWitnessBody(input = {}) {
  return buildPairWitness({
    pairId: input.pairId,
    state: PAIR_WITNESS_STATES.ACTIVE,
    installationId: input.installationId,
    appId: input.appId,
    orgId: input.orgId,
    localSite: input.localSite,
    remoteSite: input.remoteSite,
    localIssueId: input.localIssueId,
    localKey: input.localKey,
    remoteIssueId: input.remoteIssueId,
    remoteKey: input.remoteKey,
    direction: input.direction,
    writtenAt: input.writtenAt
  });
}

export function witnessBodyText(record) {
  return JSON.stringify(record);
}

export function witnessEntry({ record, site }) {
  return {
    site,
    issueId: site === 'local' ? record.localIssueId : record.remoteIssueId,
    pairId: record.pairId,
    payloadDigest: pairWitnessPayloadDigest(record)
  };
}

const defaultDeps = {
  putLocal: (issueId, body) => api.asApp().requestJira(
    route`/rest/api/3/issue/${issueId}/properties/${PAIR_WITNESS_PROPERTY_KEY}`,
    {
      method: 'PUT',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body
    }
  ),
  putRemote: (org, issueId, body) => fetch(`${org.remoteUrl}${propertyPath(issueId)}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Basic ${basicAuth(org)}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body
  }),
  readWitness: readPairWitness,
  budget: () => createRetryBudget(),
  orgId: 'pair-witness-migration'
};

/**
 * Sends one property PUT and classifies the outcome.
 *
 * Only a definitive 429 is retried (by the shared write helper, which honours
 * Retry-After and defers when the wait exceeds the invocation budget). 5xx and
 * transport failures are ambiguous and are returned as such; the caller resolves
 * them by reading the property back rather than by retrying blindly.
 */
export async function putWitnessProperty({ side, issueId, org, body, deps = {} }) {
  const merged = { ...defaultDeps, ...deps };
  let response;
  try {
    response = await executeWriteWithRetry(async () => {
      return side === PAIR_WITNESS_SIDES.REMOTE
        ? merged.putRemote(org, issueId, body)
        : merged.putLocal(issueId, body);
    }, `Pair witness ${side} ${issueId}`, {
      endpoint: 'pair_witness_property',
      orgId: merged.orgId,
      budget: merged.budget(),
      // The maintenance permit is enforced by the transport boundary for this
      // exact request; re-checking the ordinary pause gate here would refuse the
      // very writes the permit exists to allow.
      assertWriteAllowed: async () => {}
    });
  } catch (error) {
    if (error?.code === 'RATE_LIMIT_DEFERRED') {
      return {
        outcome: PAIR_WITNESS_WRITE_OUTCOMES.DEFERRED,
        statusCode: 429,
        retryAfterMs: error.retryAfterMs ?? null
      };
    }
    if (error?.code === 'PAIR_WITNESS_PERMIT_REFUSED') {
      // A missing or expired permit means no authority existed at that moment,
      // not that the pair is conflicted: the property is untouched and the batch
      // can continue after a fresh permit is minted. Every other permit refusal
      // (payload, pair, marker, pause, restore) is terminal for this pair.
      const recoverable = error.reason === 'PAIR_WITNESS_PERMIT_MISSING'
        || error.reason === 'PAIR_WITNESS_PERMIT_EXPIRED';
      return {
        outcome: recoverable
          ? PAIR_WITNESS_WRITE_OUTCOMES.DEFERRED
          : PAIR_WITNESS_WRITE_OUTCOMES.CONFLICT,
        statusCode: null,
        code: error.code,
        reason: error.reason || null
      };
    }
    if (error?.code === 'AMBIGUOUS_WRITE_OUTCOME') {
      return { outcome: PAIR_WITNESS_WRITE_OUTCOMES.APPLIED, ambiguous: true, statusCode: null };
    }
    return {
      outcome: PAIR_WITNESS_WRITE_OUTCOMES.FAILED,
      statusCode: Number.isInteger(Number(error?.statusCode)) ? Number(error.statusCode) : null,
      code: typeof error?.code === 'string' ? error.code : 'PAIR_WITNESS_WRITE_FAILED'
    };
  }

  const status = Number(response?.status);
  if (Number.isFinite(status) && status >= 200 && status < 300) {
    return { outcome: PAIR_WITNESS_WRITE_OUTCOMES.APPLIED, statusCode: status };
  }
  if (status === 429) {
    return { outcome: PAIR_WITNESS_WRITE_OUTCOMES.DEFERRED, statusCode: status };
  }
  if (Number.isFinite(status) && status >= 400 && status < 500) {
    return { outcome: PAIR_WITNESS_WRITE_OUTCOMES.CONFLICT, statusCode: status };
  }
  // 5xx: the write may or may not have landed. Never assume either way.
  return { outcome: PAIR_WITNESS_WRITE_OUTCOMES.APPLIED, ambiguous: true, statusCode: status };
}

/** Reads the witness back and compares it with exactly what was sent. */
export async function verifyWitnessWrite({ side, issueId, org, record, deps = {} }) {
  const merged = { ...defaultDeps, ...deps };
  const read = await merged.readWitness({
    side,
    issueRef: issueId,
    org,
    expected: {
      installationId: record.installationId,
      appId: record.appId,
      orgId: record.orgId,
      localSite: record.localSite,
      remoteSite: record.remoteSite,
      issueId
    }
  });
  if (read.class === PAIR_WITNESS_READ_CLASSES.ABSENT) {
    return { verified: false, absent: true, readClass: read.class, statusCode: read.statusCode };
  }
  if (read.class !== PAIR_WITNESS_READ_CLASSES.MATCHING) {
    return {
      verified: false,
      absent: false,
      readClass: read.class,
      code: read.code,
      statusCode: read.statusCode
    };
  }
  return {
    verified: samePairWitness(read.record, record),
    absent: false,
    readClass: read.class,
    statusCode: read.statusCode
  };
}

