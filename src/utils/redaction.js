const SAFE_SECRET_METADATA_KEYS = new Set([
  'hasRemoteApiToken',
  'webhookConfigured',
  'webhookSecretLastRotatedAt',
  'webhookUrlConfigured'
]);

const SECRET_KEY_PATTERN = /(token|secret|password|credential|authorization)/i;

export function isSecretFieldName(key) {
  if (typeof key !== 'string') return false;
  if (SAFE_SECRET_METADATA_KEYS.has(key)) return false;
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * Deep-clone a plain data value while omitting credential-bearing fields.
 * This is used for resolver responses, configuration exports and legacy
 * storage sanitization. It never mutates the input.
 */
export function redactSecrets(value) {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }

  if (value && typeof value === 'object') {
    const redacted = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isSecretFieldName(key)) continue;
      redacted[key] = redactSecrets(entry);
    }
    return redacted;
  }

  return value;
}

export function stripCredentialFields(value) {
  return redactSecrets(value);
}
