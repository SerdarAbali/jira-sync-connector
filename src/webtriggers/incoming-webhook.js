import {
  processIncomingWebhook,
  WEBHOOK_ORG_ID_PATTERN,
  WEBHOOK_CREDENTIAL_PATTERN,
  WEBHOOK_EVENT_NAME_PATTERN
} from '../services/sync/incoming-sync.js';

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const MAX_USER_PATH_LENGTH = 1024;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/i;

const KNOWN_WEBHOOK_EVENTS = new Set([
  'jira:issue_created',
  'jira:issue_updated',
  'jira:issue_deleted',
  'comment_created',
  'jira:issue_link_created',
  'jira:issue_link_deleted',
  'issuelink_created',
  'issuelink_deleted',
  'attachment_created',
  'jira:attachment_created',
  'attachment_deleted',
  'jira:attachment_deleted'
]);

function jsonResponse(statusCode, body) {
  return {
    body: JSON.stringify(body),
    statusCode,
    headers: { 'Content-Type': ['application/json'] }
  };
}

function unauthorizedResponse() {
  return jsonResponse(401, { error: 'Unauthorized' });
}

function readContentType(request) {
  const headers = request.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return null;
  }

  const matches = Object.entries(headers)
    .filter(([name]) => String(name).toLowerCase() === 'content-type');

  if (matches.length !== 1) {
    return null;
  }

  const rawValue = matches[0][1];
  // Forge documents request header values as string arrays. A plain string is
  // accepted only for local backwards compatibility.
  const values = Array.isArray(rawValue)
    ? rawValue
    : (typeof rawValue === 'string' ? [rawValue] : null);

  if (!values || values.length !== 1 || typeof values[0] !== 'string') {
    return null;
  }

  const value = values[0].trim();
  return value || null;
}

function hasQuerySecret(request) {
  const query = request.queryParameters;
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    return false;
  }
  return Object.keys(query).some(key => key.toLowerCase() === 'secret');
}

/**
 * Native Jira Cloud System Webhooks cannot add custom outgoing headers, so the
 * opaque credential is carried in the Forge web-trigger userPath:
 *
 *   <webtrigger-url>/<orgId>/<webhookCredential>
 *
 * Exactly two non-empty literal segments are accepted. Percent-encoded,
 * slashed, empty, or oversized segments are rejected.
 */
export function parseWebhookUserPath(userPath) {
  if (typeof userPath !== 'string' || !userPath || userPath.length > MAX_USER_PATH_LENGTH) {
    return null;
  }
  if (/[?#%\\]/.test(userPath) || userPath.includes('//')) {
    return null;
  }

  const raw = userPath.startsWith('/') ? userPath.slice(1) : userPath;
  if (!raw || raw.endsWith('/')) {
    return null;
  }

  const segments = raw.split('/');
  if (segments.length !== 2) {
    return null;
  }

  const [orgId, credential] = segments;
  if (!WEBHOOK_ORG_ID_PATTERN.test(orgId) || !WEBHOOK_CREDENTIAL_PATTERN.test(credential)) {
    return null;
  }

  return { orgId, credential };
}

function measureBodyBytes(body) {
  if (typeof body === 'string') {
    return Buffer.byteLength(body, 'utf8');
  }
  if (body && typeof body === 'object') {
    try {
      return Buffer.byteLength(JSON.stringify(body), 'utf8');
    } catch {
      return null;
    }
  }
  return null;
}

export async function run(request) {
  try {
    // POST only
    if (!request || String(request.method || '').toUpperCase() !== 'POST') {
      return jsonResponse(405, { error: 'Request rejected' });
    }

    // Credentials are never accepted in query parameters.
    if (hasQuerySecret(request)) {
      return unauthorizedResponse();
    }

    // Authenticate from the opaque path credential. Missing, malformed, extra,
    // encoded, or oversized paths all produce the same response.
    const pathAuth = parseWebhookUserPath(request.userPath);
    if (!pathAuth) {
      return unauthorizedResponse();
    }

    const contentType = readContentType(request);
    if (!contentType || !JSON_CONTENT_TYPE.test(contentType)) {
      return jsonResponse(415, { error: 'Unsupported content type' });
    }

    // Validate the body size before JSON parsing.
    const bodyBytes = measureBodyBytes(request.body);
    if (bodyBytes === null || bodyBytes === 0) {
      return jsonResponse(400, { error: 'Invalid request' });
    }
    if (bodyBytes > MAX_WEBHOOK_BODY_BYTES) {
      return jsonResponse(413, { error: 'Request too large' });
    }

    let payload;
    try {
      payload = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
    } catch {
      return jsonResponse(400, { error: 'Invalid JSON body' });
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return jsonResponse(400, { error: 'Invalid webhook payload' });
    }
    if (typeof payload.webhookEvent !== 'string'
      || !WEBHOOK_EVENT_NAME_PATTERN.test(payload.webhookEvent)
      || !KNOWN_WEBHOOK_EVENTS.has(payload.webhookEvent)) {
      return jsonResponse(400, { error: 'Unrecognized webhook event' });
    }

    const result = await processIncomingWebhook(payload, pathAuth);
    return jsonResponse(result.status, result.body);
  } catch {
    console.error('Error processing incoming webhook request');
    return jsonResponse(500, { error: 'Request could not be processed' });
  }
}
