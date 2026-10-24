import {
  processIncomingWebhook,
  WEBHOOK_ORG_ID_PATTERN,
  KNOWN_WEBHOOK_EVENTS
} from '../services/sync/incoming-sync.js';

export { KNOWN_WEBHOOK_EVENTS };

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const MAX_USER_PATH_LENGTH = 1024;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/i;


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

export function parseWebhookUserPath(userPath) {
  if (typeof userPath !== 'string' || !userPath || userPath.length > MAX_USER_PATH_LENGTH) {
    return null;
  }
  if (/[?#%\\\r\n]/.test(userPath) || userPath.includes('//')) {
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

  const [mode, orgId] = segments;
  if (mode !== 'signed' || !WEBHOOK_ORG_ID_PATTERN.test(orgId)) {
    return null;
  }

  return { orgId };
}

function measureBodyBytes(body) {
  if (typeof body === 'string') {
    return Buffer.byteLength(body, 'utf8');
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

    // Resolve the organization from the credential-free signed path. Missing, malformed, extra,
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

    const signatureHeaders = Object.entries(request.headers)
      .filter(([name]) => name.toLowerCase() === 'x-hub-signature');
    const values = signatureHeaders.length === 1 ? signatureHeaders[0][1] : null;
    if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string') {
      return unauthorizedResponse();
    }
    const result = await processIncomingWebhook(request.body, { ...pathAuth, signature: values[0] });
    return jsonResponse(result.status, result.body);
  } catch {
    console.error('Error processing incoming webhook request');
    return jsonResponse(500, { error: 'Request could not be processed' });
  }
}
