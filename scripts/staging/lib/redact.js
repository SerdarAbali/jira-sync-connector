'use strict';

const { maskEmail } = require('./config');

const CREDENTIAL_HEADER_PATTERN = /\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]{8,}/gi;
const ATLASSIAN_TOKEN_PATTERN = /\bAT(?:ATT|CTT|BB)[A-Za-z0-9_-]{10,}\b/g;

/**
 * Collects every credential value the process must never echo: the configured
 * API tokens and the encoded Basic credentials built from them.
 */
function collectCredentialSecrets(config = {}) {
  const secrets = [];
  ['local', 'remote'].forEach((role) => {
    const site = config[role] || {};
    if (typeof site.apiToken === 'string' && site.apiToken) {
      secrets.push(site.apiToken);
      if (typeof site.email === 'string' && site.email) {
        try {
          secrets.push(Buffer.from(`${site.email}:${site.apiToken}`, 'utf8').toString('base64'));
        } catch (error) {
          // Buffer encoding of strings does not fail; keep the token itself.
        }
      }
    }
  });
  return secrets.filter((secret) => typeof secret === 'string' && secret.length >= 4);
}

function redactText(value, secrets = []) {
  let text = value === undefined || value === null ? '' : String(value);

  const ordered = Array.from(
    new Set(secrets.filter((secret) => typeof secret === 'string' && secret.length >= 4))
  ).sort((left, right) => right.length - left.length);

  ordered.forEach((secret) => {
    text = text.split(secret).join('[REDACTED]');
  });

  text = text
    .replace(CREDENTIAL_HEADER_PATTERN, '$1 [REDACTED]')
    .replace(ATLASSIAN_TOKEN_PATTERN, '[REDACTED]');

  const emails = Array.from(
    new Set((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((email) => email))
  );
  emails.forEach((email) => {
    const masked = maskEmail(email);
    if (masked) {
      text = text.split(email).join(masked);
    }
  });

  return text;
}

/**
 * True when the text still contains a credential value this process knows
 * about. Used to refuse output that cannot be proven free of credential
 * material after redaction.
 */
function containsCredentialMaterial(value, secrets = []) {
  const text = value === undefined || value === null ? '' : String(value);
  if (CREDENTIAL_HEADER_PATTERN.test(text) || ATLASSIAN_TOKEN_PATTERN.test(text)) {
    CREDENTIAL_HEADER_PATTERN.lastIndex = 0;
    ATLASSIAN_TOKEN_PATTERN.lastIndex = 0;
    return true;
  }
  CREDENTIAL_HEADER_PATTERN.lastIndex = 0;
  ATLASSIAN_TOKEN_PATTERN.lastIndex = 0;
  return secrets.some(
    (secret) => typeof secret === 'string' && secret.length >= 4 && text.includes(secret)
  );
}

function redactObject(value, secrets = []) {
  if (typeof value === 'string') {
    return redactText(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactObject(entry, secrets));
  }
  if (value && typeof value === 'object') {
    const output = {};
    Object.entries(value).forEach(([key, entry]) => {
      output[key] = redactObject(entry, secrets);
    });
    return output;
  }
  return value;
}

function safeErrorMessage(error, secrets = []) {
  const message =
    error && typeof error.message === 'string' && error.message
      ? error.message
      : 'Unexpected preflight error.';
  return redactText(message, secrets).slice(0, 1000);
}

module.exports = {
  collectCredentialSecrets,
  containsCredentialMaterial,
  redactObject,
  redactText,
  safeErrorMessage,
};
