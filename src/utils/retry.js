import { MAX_RETRY_ATTEMPTS, RETRY_BASE_DELAY_MS, RATE_LIMIT_RETRY_DELAY_MS, HTTP_STATUS, LOG_EMOJI } from '../constants.js';

// Utility: Retry with exponential backoff
export async function retryWithBackoff(fn, operation = 'operation', maxRetries = MAX_RETRY_ATTEMPTS) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await fn();

      // Check for rate limiting (HTTP 429)
      if (result && result.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
        console.warn(`${LOG_EMOJI.WARNING} Rate limit hit during ${operation}, waiting ${RATE_LIMIT_RETRY_DELAY_MS}ms...`);
        await sleep(RATE_LIMIT_RETRY_DELAY_MS);
        continue; // Don't count this as a regular retry attempt
      }

      return result;
    } catch (error) {
      const isLastAttempt = attempt === maxRetries - 1;

      if (isLastAttempt) {
        console.error(`${LOG_EMOJI.ERROR} ${operation} failed after ${maxRetries} attempts:`, error.message);
        throw error;
      }

      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt); // Exponential backoff: 1s, 2s, 4s
      console.warn(`${LOG_EMOJI.WARNING} ${operation} failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
}

// Utility: Sleep helper
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
