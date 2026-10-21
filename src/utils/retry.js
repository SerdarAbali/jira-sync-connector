import { MAX_RETRY_ATTEMPTS, RETRY_BASE_DELAY_MS, RATE_LIMIT_RETRY_DELAY_MS, HTTP_STATUS, LOG_EMOJI } from '../constants.js';
import { trackApiCall } from '../services/storage/stats.js';

const MAX_DELAY = 30000; // 30 seconds max delay
const BACKOFF_MULTIPLIER = 2;

// Utility: Retry with exponential backoff
export async function retryWithBackoff(fn, operation = 'operation', maxRetries = MAX_RETRY_ATTEMPTS, options = {}) {
  const {
    initialDelay = RETRY_BASE_DELAY_MS,
    maxDelay = MAX_DELAY,
    backoffMultiplier = BACKOFF_MULTIPLIER,
    onRetry = null,
    endpoint = null,
    orgId = null
  } = options;

  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await fn();

      // Check for rate limiting (HTTP 429)
      if (result && result.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
        const delay = RATE_LIMIT_RETRY_DELAY_MS;
        console.warn(`${LOG_EMOJI.WARNING} Rate limit hit during ${operation}, waiting ${delay}ms...`);
        
        // Track rate limit hit
        await trackApiCall(endpoint || operation, false, true, orgId);
        
        if (onRetry) {
          await onRetry(attempt, delay, { message: 'Rate limited', statusCode: 429 });
        }
        
        await sleep(delay);
        continue; // Don't count this as a regular retry attempt
      }

      // Track successful API call
      const isSuccess = result && (result.ok || result.status === 200 || result.status === 201 || result.status === 204);
      await trackApiCall(endpoint || operation, isSuccess, false, orgId);

      return result;
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === maxRetries - 1;

      // Check if it's a rate limit error (429)
      const isRateLimit = error.statusCode === 429 || 
                         error.status === 429 ||
                         error.message?.toLowerCase().includes('rate limit');

      // Track the failed call
      await trackApiCall(endpoint || operation, false, isRateLimit, orgId);

      // Don't retry on client errors (4xx except 429)
      if (error.statusCode >= 400 && error.statusCode < 500 && !isRateLimit) {
        console.error(`${LOG_EMOJI.ERROR} Non-retryable error (${error.statusCode}) during ${operation}:`, error.message);
        throw error;
      }

      if (isLastAttempt) {
        console.error(`${LOG_EMOJI.ERROR} ${operation} failed after ${maxRetries} attempts:`, error.message);
        throw error;
      }

      // Calculate delay with exponential backoff
      const baseDelay = isRateLimit ? RATE_LIMIT_RETRY_DELAY_MS : initialDelay;
      const delay = Math.min(
        baseDelay * Math.pow(backoffMultiplier, attempt),
        maxDelay
      );
      
      console.warn(`${LOG_EMOJI.WARNING} ${operation} failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms... Error: ${error.message}`);
      
      if (onRetry) {
        await onRetry(attempt, delay, error);
      }
      
      await sleep(delay);
    }
  }

  throw lastError;
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
    throw await trackAmbiguous(error);
  }

  // Do not retry 429 here. The caller must report the rate-limited outcome
  // without assuming the request was not processed.
  if (result && result.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
    await trackApiCall(endpoint || operation, false, true, orgId);
    console.warn(`${LOG_EMOJI.WARNING} Rate-limited write outcome for ${operation}; not retrying`);
    const rateLimited = new Error(`Rate-limited write outcome for ${operation}; not retried`);
    rateLimited.code = 'RATE_LIMITED_WRITE_OUTCOME';
    rateLimited.status = HTTP_STATUS.TOO_MANY_REQUESTS;
    rateLimited.operation = operation;
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
