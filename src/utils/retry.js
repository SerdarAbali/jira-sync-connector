import {
  MAX_RETRY_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  RATE_LIMIT_RETRY_FALLBACK_MS,
  RETRY_SAFE_BUDGET_MS,
  RETRY_MIN_WAIT_MS,
  MAX_RETRY_AFTER_MS,
  HTTP_STATUS,
  LOG_EMOJI
} from '../constants.js';
import { trackApiCall } from '../services/storage/stats.js';

const MAX_DELAY = 30000; // 30 seconds max delay for non-rate-limit backoff
const BACKOFF_MULTIPLIER = 2;

// Outcomes that already encode an administrative or safety decision. Sleeping
// and retrying cannot help: a paused connector must stay stopped, and a
// deferred or ambiguous write must be resolved by recovery or an administrator.
const NON_RETRYABLE_CODES = new Set([
  'LEASE_NOT_OWNED',
  'LEASE_OWNERSHIP_UNAVAILABLE',
  'LEASE_MIGRATION_REQUIRED',
  'PILOT_PAUSED',
  'PAUSE_STATE_UNAVAILABLE',
  'RATE_LIMIT_DEFERRED',
  'RATE_LIMITED_WRITE_OUTCOME',
  'AMBIGUOUS_WRITE_OUTCOME',
  'COMMENT_VERIFICATION_DEFERRED',
  'COMMENT_RECONCILIATION_REQUIRED'
]);

export function isNonRetryableError(error) {
  return Boolean(error && NON_RETRYABLE_CODES.has(error.code));
}

/**
 * Raised when Jira asked for a wait that cannot be honored safely inside the
 * caller's remaining invocation budget. The bounded deadline is preserved so
 * callers and durable recovery can resume no earlier than Jira requires.
 */
export class RateLimitDeferredError extends Error {
  constructor(operation = 'operation', retryAfterMs = null, options = {}) {
    super(`Rate limited during ${operation}; retry deferred`);
    this.name = 'RateLimitDeferredError';
    this.code = 'RATE_LIMIT_DEFERRED';
    this.operation = operation;
    this.status = HTTP_STATUS.TOO_MANY_REQUESTS;
    this.statusCode = HTTP_STATUS.TOO_MANY_REQUESTS;
    this.retryAfterMs = boundRetryAfterMs(retryAfterMs);
    this.budgetMs = options.budgetMs ?? null;
    this.deferred = true;
  }
}

export function boundRetryAfterMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.min(Math.round(ms), MAX_RETRY_AFTER_MS);
}

/**
 * Jira sends Retry-After either as delta-seconds or as an HTTP-date. Returns
 * null when the header is absent or unusable so callers can pick a fallback.
 */
export function parseRetryAfterMs(headers, now = Date.now()) {
  if (!headers) return null;
  const raw = typeof headers.get === 'function'
    ? headers.get('retry-after')
    : (headers['retry-after'] ?? headers['Retry-After']);
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return boundRetryAfterMs(Number(value) * 1000);
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return boundRetryAfterMs(Math.max(0, at - now));
}

/**
 * One budget for every wait performed by a retry helper (and, when passed
 * explicitly, by nested helpers). `remainingMs()` shrinks as waits are taken.
 */
export function createRetryBudget(options = {}) {
  const { budgetMs = RETRY_SAFE_BUDGET_MS, now = () => Date.now() } = options;
  const bounded = Number.isFinite(budgetMs) && budgetMs >= 0 ? budgetMs : RETRY_SAFE_BUDGET_MS;
  return {
    budgetMs: bounded,
    deadline: now() + bounded,
    remainingMs() {
      return Math.max(0, this.deadline - now());
    }
  };
}

function isRateLimitError(error) {
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  return error?.statusCode === 429
    || error?.status === 429
    || error?.code === 429
    || message.includes('rate limit');
}

function isClientError(error) {
  return error?.statusCode >= 400 && error.statusCode < 500;
}

/**
 * Retry a request with exponential backoff.
 *
 * Rate limits are handled separately from other failures: the delay is taken
 * from Jira's Retry-After header (never shorter), and if that deadline does not
 * fit inside the remaining budget the call throws RateLimitDeferredError
 * instead of sleeping until the invocation is killed.
 *
 * `beforeAttempt` runs immediately before every submission (including the
 * first), which is where the write path re-verifies the emergency pause.
 */
export async function retryWithBackoff(fn, operation = 'operation', maxRetries = MAX_RETRY_ATTEMPTS, options = {}) {
  const {
    initialDelay = RETRY_BASE_DELAY_MS,
    maxDelay = MAX_DELAY,
    backoffMultiplier = BACKOFF_MULTIPLIER,
    onRetry = null,
    endpoint = null,
    orgId = null,
    budget = createRetryBudget(),
    beforeAttempt = null,
    retryOnError = true
  } = options;

  const attempts = Math.max(1, Number(maxRetries) || 1);
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (beforeAttempt) await beforeAttempt(attempt);

    let result;
    try {
      result = await fn();
    } catch (error) {
      lastError = error;
      const isRateLimit = isRateLimitError(error);

      // Track the failed call
      await trackApiCall(endpoint || operation, false, isRateLimit, orgId);

      if (!retryOnError || isNonRetryableError(error)) {
        console.error(`${LOG_EMOJI.ERROR} ${operation} aborted (${error?.code || 'error'}): not retryable`);
        throw error;
      }

      // Don't retry on client errors (4xx except 429)
      if (isClientError(error) && !isRateLimit) {
        console.error(`${LOG_EMOJI.ERROR} Non-retryable error (${error.statusCode}) during ${operation}:`, error.message);
        throw error;
      }

      if (attempt === attempts - 1) {
        console.error(`${LOG_EMOJI.ERROR} ${operation} failed after ${attempts} attempts:`, error.message);
        throw error;
      }

      // Calculate delay with exponential backoff
      const baseDelay = isRateLimit ? RATE_LIMIT_RETRY_FALLBACK_MS : initialDelay;
      const delay = Math.min(baseDelay * Math.pow(backoffMultiplier, attempt), maxDelay);

      if (delay > budget.remainingMs()) {
        if (isRateLimit) throw new RateLimitDeferredError(operation, delay, { budgetMs: budget.budgetMs });
        console.warn(`${LOG_EMOJI.WARNING} ${operation} aborted: a ${delay}ms wait exceeds the remaining ${budget.remainingMs()}ms retry budget`);
        throw error;
      }

      console.warn(`${LOG_EMOJI.WARNING} ${operation} failed (attempt ${attempt + 1}/${attempts}), retrying in ${delay}ms... Error: ${error.message}`);

      if (onRetry) {
        await onRetry(attempt, delay, error);
      }

      await sleep(delay);
      continue;
    }

    // Check for rate limiting (HTTP 429)
    if (result && result.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
      const retryAfterMs = parseRetryAfterMs(result.headers);
      const delay = Math.max(retryAfterMs === null ? RATE_LIMIT_RETRY_FALLBACK_MS : retryAfterMs, RETRY_MIN_WAIT_MS);

      // Track rate limit hit
      await trackApiCall(endpoint || operation, false, true, orgId);

      if (onRetry) {
        await onRetry(attempt, delay, { message: 'Rate limited', statusCode: HTTP_STATUS.TOO_MANY_REQUESTS });
      }

      if (attempt === attempts - 1 || delay > budget.remainingMs()) {
        // Never wait past the last attempt or past the invocation budget.
        throw new RateLimitDeferredError(operation, retryAfterMs === null ? delay : retryAfterMs, {
          budgetMs: budget.budgetMs
        });
      }

      console.warn(`${LOG_EMOJI.WARNING} Rate limit hit during ${operation}, waiting ${delay}ms (Retry-After honored)...`);
      await sleep(delay);
      continue; // Don't count this as a regular retry attempt
    }

    // Track successful API call
    const isSuccess = result && (result.ok || result.status === 200 || result.status === 201 || result.status === 204);
    await trackApiCall(endpoint || operation, isSuccess, false, orgId);

    return result;
  }

  throw lastError || new RateLimitDeferredError(operation, 0, { budgetMs: budget.budgetMs });
}

// Explicit policy for non-idempotent Jira writes.
//
// This helper does NOT provide exactly-once semantics. It invokes fn() at most
// once for every outcome, including network exceptions, timeouts, HTTP 5xx,
// and HTTP 429. Ambiguous write outcomes are marked so callers can report them
// without guessing whether Jira applied the request.
export async function executeWriteOnce(fn, operation = 'write', options = {}) {
  const { endpoint = null, orgId = null } = options;

  const trackAmbiguous = async (error) => {
    await trackApiCall(endpoint || operation, false, false, orgId);
    const status = error?.status || error?.statusCode || 'unknown';
    const code = error?.code || 'unknown';
    console.error(`${LOG_EMOJI.WARNING} Ambiguous write outcome for ${operation}; not retrying (code=${code}, status=${status})`);
    const ambiguous = new Error(`Ambiguous write outcome for ${operation}; not retried`);
    ambiguous.code = 'AMBIGUOUS_WRITE_OUTCOME';
    ambiguous.operation = operation;
    ambiguous.causeCode = error?.code;
    ambiguous.causeStatus = error?.status || error?.statusCode;
    return ambiguous;
  };

  let result;
  try {
    result = await fn();
  } catch (error) {
    if (isNonRetryableError(error)) throw error;
    throw await trackAmbiguous(error);
  }

  // Do not retry 429 here. The caller must report the rate-limited outcome
  // without assuming the request was not processed. Jira's deadline is kept in
  // bounded, machine-readable form so durable recovery can honour it.
  if (result && result.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
    await trackApiCall(endpoint || operation, false, true, orgId);
    console.warn(`${LOG_EMOJI.WARNING} Rate-limited write outcome for ${operation}; not retrying`);
    const rateLimited = new Error(`Rate-limited write outcome for ${operation}; not retried`);
    rateLimited.code = 'RATE_LIMITED_WRITE_OUTCOME';
    rateLimited.status = HTTP_STATUS.TOO_MANY_REQUESTS;
    rateLimited.statusCode = HTTP_STATUS.TOO_MANY_REQUESTS;
    rateLimited.operation = operation;
    rateLimited.retryAfterMs = parseRetryAfterMs(result.headers);
    rateLimited.deferred = true;
    throw rateLimited;
  }

  const isSuccess = result && (result.ok || result.status === 200 || result.status === 201 || result.status === 204);
  await trackApiCall(endpoint || operation, isSuccess, false, orgId);

  if (result && result.status >= 500) {
    console.error(`${LOG_EMOJI.WARNING} Ambiguous write outcome for ${operation}: HTTP ${result.status}; not retrying`);
  }

  return result;
}

// Utility: Sleep helper
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
