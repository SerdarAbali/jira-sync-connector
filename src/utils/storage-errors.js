/**
 * Detect a KVS conditional-write conflict without treating every storage
 * failure as a duplicate.
 */
export function isKeyConflictError(error) {
  const code = String(error?.code || error?.name || '').toUpperCase();
  if (['KEY_ALREADY_EXISTS', 'KEY_EXISTS', 'ALREADY_EXISTS', 'CONFLICT', 'CONDITIONAL_CHECK_FAILED'].includes(code)) {
    return true;
  }
  const message = String(error?.message || '');
  return /already exists|key .*exists|exists already|fail_if_exists/i.test(message);
}
