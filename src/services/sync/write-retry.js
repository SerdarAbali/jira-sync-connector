import {
  HTTP_STATUS,
  LOG_EMOJI,
  RATE_LIMIT_RETRY_FALLBACK_MS,
  RETRY_MIN_WAIT_MS,
  WRITE_RETRY_MAX_ATTEMPTS
} from '../../constants.js';
import {
  createRetryBudget,
  isNonRetryableError,
  parseRetryAfterMs,
  RateLimitDeferredError,
  sleep
} from '../../utils/retry.js';
import { trackApiCall } from '../storage/stats.js';
import { assertPilotWritesAllowed } from './pilot-pause.js';

/**
 * Shared retry wrapper for *idempotent* Jira writes (field/description PUTs).
 *
 * Rules, in order of precedence:
 *   1. The authoritative emergency-pause state is re-read immediately before
 *      every submission, including the retry. An unreadable pause state fails
 *      closed (PAUSE_STATE_UNAVAILABLE) and nothing is submitted.
 *   2. Only a definitive HTTP 429 is retried. A finished 429 means Jira did not
 *      apply the request, so re-sending cannot duplicate it. Network errors,
 *      timeouts and 5xx responses are ambiguous and are never retried
 *      automatically (AMBIGUOUS_WRITE_OUTCOME).
 *   3. The wait is Jira's Retry-After (never shorter). If that deadline does
 *      not fit inside the caller's remaining budget, or the attempt budget is
 *      exhausted, the call throws RateLimitDeferredError carrying the bounded
 *      retryAfterMs instead of sleeping through the invocation limit.
 *
 * Non-idempotent creations (POST) must keep using executeWriteOnce; this helper
 * must not be used for them.
 */
export async function executeWriteWithRetry(fn, operation = 'write', options = {}) {
  const {
    endpoint = null,
    orgId = null,
    pauseOperation = operation,
    budget = createRetryBudget(),
    maxAttempts = WRITE_RETRY_MAX_ATTEMPTS,
    assertWriteAllowed = null,
    onRetry = null
  } = options;

  const verifyWritesAllowed = typeof assertWriteAllowed === 'function'
    ? assertWriteAllowed
    : () => assertPilotWritesAllowed(pauseOperation);

  const attempts = Math.max(1, Number(maxAttempts) || 1);

  for (let attempt = 0; attempt < attempts; attempt++) {
    // Re-verified on every attempt: a pause activated during the rate-limit
    // wait must stop this write before it reaches Jira.
    await gateWrite(verifyWritesAllowed, operation);

    let result;
    try {
      result = await fn();
    } catch (error) {
      if (isNonRetryableError(error)) throw error;
      await trackApiCall(endpoint || operation, false, false, orgId);
      throw ambiguousWriteOutcome(operation, error);
    }

    if (result && result.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
      await trackApiCall(endpoint || operation, false, true, orgId);
      const retryAfterMs = parseRetryAfterMs(result.headers);
      const delay = Math.max(retryAfterMs === null ? RATE_LIMIT_RETRY_FALLBACK_MS : retryAfterMs, RETRY_MIN_WAIT_MS);

      if (attempt === attempts - 1 || delay > budget.remainingMs()) {
        console.warn(`${LOG_EMOJI.WARNING} ${operation} deferred by Jira rate limiting; no retry submitted in this invocation`);
        throw new RateLimitDeferredError(operation, retryAfterMs === null ? delay : retryAfterMs, {
          budgetMs: budget.budgetMs
        });
      }

      console.warn(`${LOG_EMOJI.WARNING} ${operation} was rate limited; retrying after ${delay}ms (Retry-After honored)`);
      if (onRetry) await onRetry(attempt, delay, { message: 'Rate limited', statusCode: HTTP_STATUS.TOO_MANY_REQUESTS });
      await sleep(delay);
      continue;
    }

    const isSuccess = Boolean(result && (result.ok || result.status === 200 || result.status === 201 || result.status === 204));
    await trackApiCall(endpoint || operation, isSuccess, false, orgId);

    if (result && Number(result.status) >= 500) {
      console.error(`${LOG_EMOJI.WARNING} Ambiguous write outcome for ${operation}: HTTP ${result.status}; not retrying`);
    }

    return result;
  }

  throw new RateLimitDeferredError(operation, 0, { budgetMs: budget.budgetMs });
}

async function gateWrite(assertWriteAllowed, operation) {
  try {
    await assertWriteAllowed();
  } catch (error) {
    if (error?.code === 'PILOT_PAUSED') throw error;
    const unavailable = new Error(`Write authorization could not be verified for ${operation}; no submission attempted`);
    unavailable.name = 'PauseStateUnavailableError';
    unavailable.code = 'PAUSE_STATE_UNAVAILABLE';
    unavailable.operation = operation;
    unavailable.causeCode = error?.code;
    throw unavailable;
  }
}

function ambiguousWriteOutcome(operation, cause) {
  console.error(`${LOG_EMOJI.WARNING} Ambiguous write outcome for ${operation}; not retrying`);
  const ambiguous = new Error(`Ambiguous write outcome for ${operation}; not retried`);
  ambiguous.code = 'AMBIGUOUS_WRITE_OUTCOME';
  ambiguous.operation = operation;
  ambiguous.causeCode = cause?.code;
  ambiguous.causeStatus = cause?.status || cause?.statusCode;
  return ambiguous;
}
