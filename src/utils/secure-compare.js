import { timingSafeEqual } from 'crypto';

/**
 * Constant-time comparison for webhook secrets. Length mismatch is rejected
 * before timingSafeEqual because the Node API requires equal-length buffers.
 */
export function secureCompare(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') {
    return false;
  }
  if (candidate.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(candidate, 'utf8'), Buffer.from(expected, 'utf8'));
}
