'use strict';

const { maskEmail } = require('./config');

const BEARER_PATTERN = /\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]{8,}/gi;
const ATLASSIAN_TOKEN_PATTERN = /\bATATT[A-Za-z0-9_-]{10,}\b/g;

function redactText(value, secrets = []) {
  let text = value === undefined || value === null ? '' : String(value);

  const ordered = Array.from(
    new Set(secrets.filter((secret) => typeof secret === 'string' && secret.length >= 4))
  ).sort((left, right) => right.length - left.length);

  ordered.forEach((secret) => {
    text = text.split(secret).join('[REDACTED]');
  });

  text = text
    .replace(BEARER_PATTERN, '$1 [REDACTED]')
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
  redactObject,
  redactText,
  safeErrorMessage,
};
