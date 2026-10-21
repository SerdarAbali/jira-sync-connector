export function safeHttpCategory(status) {
  const code = Number(status);
  if (code === 400 || code === 409 || code === 422) return 'validation_failed';
  if (code === 401 || code === 403) return 'forbidden';
  if (code === 429) return 'rate_limited';
  if (Number.isFinite(code) && code >= 500) return 'temporary_failure';
  return 'remote_write_failed';
}

export function formatHttpFailure(status) {
  const code = Number(status);
  const category = safeHttpCategory(code);
  return Number.isFinite(code) && code > 0 ? `${category} (HTTP ${code})` : category;
}

export function createSafeHttpError(status) {
  const code = Number(status);
  const category = safeHttpCategory(code);
  const error = new Error(formatHttpFailure(code));
  error.code = category;
  if (Number.isFinite(code) && code > 0) error.statusCode = code;
  return error;
}
