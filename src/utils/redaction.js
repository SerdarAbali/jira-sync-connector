const SAFE_SECRET_METADATA_KEYS = new Set([
  'hasRemoteApiToken',
  'webhookConfigured',
  'webhookSecretLastRotatedAt',
  'webhookUrlConfigured'
]);

const SECRET_KEY_PATTERN = /(token|secret|password|credential|authorization|cookie|session|api[-_]?key|private[-_]?key)/i;
const CONTENT_KEY_PATTERN = /^(summary|description|comment|body|text|content|fields?|payload|event|changelog|attachment|filename|displayname|emailaddress|email|accountid|reporter|assignee|organizations?|orgs|mappings?|fieldmappings|usermappings|statusmappings|issuetypemappings|projectmappings|response|renderedbody|stack|details|errors)$/i;
const SAFE_AUDIT_KEYS = new Set([
  'action', 'sourceIssue', 'targetIssue', 'orgId', 'success',
  'timestamp', 'remoteKey', 'issueKey', 'commentId', 'reason', 'decision',
  'status', 'errorCount'
]);
const SAFE_ERROR_DETAIL_KEYS = new Set([
  'reason', 'statusCode', 'operation', 'remoteKey', 'decision', 'errorCount'
]);
const SAFE_REASON_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const SAFE_CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_:.-]{1,120}$/;
const MAX_LOG_ARRAY_ITEMS = 20;
const MAX_LOG_OBJECT_KEYS = 50;
const MAX_LOG_DEPTH = 6;

export function isSecretFieldName(key) {
  if (typeof key !== 'string') return false;
  if (SAFE_SECRET_METADATA_KEYS.has(key)) return false;
  return SECRET_KEY_PATTERN.test(key);
}

export function isSensitiveLogKey(key) {
  if (isSecretFieldName(key)) return true;
  return typeof key === 'string' && CONTENT_KEY_PATTERN.test(key);
}

export function sanitizeCredentialUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    const sensitiveQuery = Array.from(url.searchParams.keys())
      .some(key => isSecretFieldName(key));
    const webhookPath = /(webtrigger|atlassian-dev)/i.test(url.hostname)
      && url.pathname.split('/').filter(Boolean).length >= 2;
    if (url.username || url.password || sensitiveQuery || webhookPath) {
      return `${url.origin}/[REDACTED]`;
    }
    return value;
  } catch {
    return value;
  }
}

export function sanitizeLogText(value, maxLength = 240) {
  if (value === null || value === undefined) return '';
  let text = String(value).replace(/\r\n?/g, '\n');
  text = text.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [REDACTED]');
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
  text = text.replace(/([?&](?:token|secret|password|credential|api[_-]?key|auth)=)[^&\s]+/gi, '$1[REDACTED]');
  text = text.replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1[REDACTED]@');
  text = text.replace(/https:\/\/[^\s]*(?:webtrigger|atlassian-dev)[^\s]*/gi, '[REDACTED_URL]');
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

export function safeErrorSummary(value, maxLength = 160) {
  const text = sanitizeLogText(value, maxLength);
  return text.includes('{') || text.includes('[') ? 'operation_failed' : text;
}

export function safeErrorForLog(error) {
  if (!error || typeof error !== 'object') return { name: 'Error' };
  const safe = { name: sanitizeLogText(error.name || 'Error', 80) };
  if (typeof error.code === 'string' || typeof error.code === 'number') {
    safe.code = sanitizeLogText(error.code, 80);
  }
  if (typeof error.statusCode === 'number') safe.statusCode = error.statusCode;
  return safe;
}

export function redactForLog(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) return safeErrorForLog(value);
  if (typeof value === 'string') return sanitizeLogText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return sanitizeLogText(value);
  if (depth >= MAX_LOG_DEPTH) return '[TRUNCATED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, MAX_LOG_ARRAY_ITEMS).map(entry => redactForLog(entry, depth + 1, seen));
  }

  const result = {};
  for (const key of Object.keys(value).slice(0, MAX_LOG_OBJECT_KEYS)) {
    if (isSensitiveLogKey(key)) continue;
    result[key] = redactForLog(value[key], depth + 1, seen);
  }
  return result;
}

/**
 * Deep-clone a plain data value while omitting credential-bearing fields.
 * Never mutates the input.
 */
export function redactSecrets(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeCredentialUrl(value);
  if (typeof value !== 'object') return value;
  if (depth >= MAX_LOG_DEPTH) return '[TRUNCATED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map(entry => redactSecrets(entry, depth + 1, seen));
  }

  const redacted = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretFieldName(key)) continue;
    redacted[key] = redactSecrets(entry, depth + 1, seen);
  }
  return redacted;
}

export function stripCredentialFields(value) {
  return redactSecrets(value);
}

export function sanitizeReasonCode(value) {
  return typeof value === 'string' && SAFE_REASON_PATTERN.test(value) ? value : null;
}

function sanitizeAuditIdentifier(value) {
  if (typeof value !== 'string') return null;
  const text = sanitizeLogText(value, 120);
  return SAFE_IDENTIFIER_PATTERN.test(text) ? text : null;
}

export function sanitizeAuditEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {};
  const safe = {};
  for (const key of Object.keys(entry)) {
    if (!SAFE_AUDIT_KEYS.has(key)) continue;
    const value = entry[key];
    if (key === 'success') {
      safe.success = value === true;
    } else if (key === 'errorCount') {
      safe.errorCount = Number.isFinite(Number(value)) ? Number(value) : 0;
    } else if (key === 'timestamp') {
      const timestamp = sanitizeLogText(value, 64);
      if (timestamp) safe.timestamp = timestamp;
    } else if (key === 'reason') {
      const reason = sanitizeReasonCode(value);
      if (reason) safe.reason = reason;
    } else if (key === 'action' || key === 'decision' || key === 'status') {
      const code = sanitizeLogText(value, 64);
      if (SAFE_CODE_PATTERN.test(code)) safe[key] = code;
    } else if (key === 'orgId' || key === 'sourceIssue' || key === 'targetIssue' || key === 'remoteKey' || key === 'issueKey' || key === 'commentId') {
      const identifier = sanitizeAuditIdentifier(value);
      if (identifier) safe[key] = identifier;
    }
  }
  const errorCount = Array.isArray(entry.errors) ? entry.errors.length : Number(entry.errorCount) || 0;
  safe.errorCount = errorCount;
  safe.errors = errorCount > 0 ? ['operation_failed'] : [];
  return safe;
}

export function sanitizeErrorEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {};
  const safe = {
    timestamp: sanitizeLogText(entry.timestamp || new Date().toISOString(), 64),
    error: safeErrorSummary(entry.error || 'operation_failed', 160),
    orgId: sanitizeLogText(entry.orgId || 'unknown', 120),
    issueKey: sanitizeLogText(entry.issueKey || 'unknown', 120),
    operation: sanitizeLogText(entry.operation || 'unknown', 80)
  };
  if (safe.error.includes('{') || safe.error.includes('[')) safe.error = 'operation_failed';
  if (entry.details && typeof entry.details === 'object' && !Array.isArray(entry.details)) {
    const details = {};
    for (const key of Object.keys(entry.details)) {
      if (!SAFE_ERROR_DETAIL_KEYS.has(key)) continue;
      const value = entry.details[key];
      if (key === 'statusCode' && Number.isFinite(Number(value))) {
        details[key] = Number(value);
      } else if (key === 'reason') {
        const reason = sanitizeReasonCode(value);
        if (reason) details[key] = reason;
      } else if (typeof value === 'string' || typeof value === 'number') {
        details[key] = sanitizeLogText(value, 120);
      }
    }
    if (Object.keys(details).length > 0) safe.details = details;
  }
  return safe;
}

export function boundHistory(value, maxEntries) {
  if (!Array.isArray(value)) return [];
  return Number.isInteger(maxEntries) && maxEntries >= 0 ? value.slice(0, maxEntries) : value;
}
