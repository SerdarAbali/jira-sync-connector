'use strict';

const https = require('https');

const { PROJECT_KEY_PATTERN } = require('./config');
const { redactText } = require('./redact');

const USER_AGENT = 'jira-sync-connector-staging-preflight/1.0';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;
const PERMISSION_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const SENSITIVE_DEBUG_NAMESPACES = new Set(['http', 'https']);
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const EXACT_ENDPOINTS = new Map([
  ['/rest/api/3/myself', { kind: 'myself', query: [] }],
  [
    '/rest/api/3/project/search',
    {
      kind: 'project-search',
      query: ['startAt', 'maxResults', 'status', 'orderBy'],
    },
  ],
  [
    '/rest/api/3/mypermissions',
    { kind: 'permissions', query: ['permissions', 'projectKey', 'projectId'] },
  ],
]);
const PROJECT_PREFIX = '/rest/api/3/project/';
const ORDER_BY_VALUES = new Set(['key', 'key desc', 'name', 'name desc']);
const STATUS_VALUES = new Set(['live', 'archived', 'deleted']);

class JiraRequestError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'JiraRequestError';
    this.code = options.code || 'request-failed';
    this.status = options.status || null;
    this.attempts = options.attempts || 0;
    this.endpoint = options.endpoint || null;
    this.retryAfterMs = options.retryAfterMs || null;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

function endpointError(message) {
  return new JiraRequestError(message, {
    code: 'endpoint-not-allowed',
    attempts: 0,
  });
}

function assertSafeNodeDebug(env = process.env) {
  const value = env && env.NODE_DEBUG;
  if (typeof value !== 'string') {
    return;
  }

  const unsafe = value.split(',').some((entry) => {
    const namespace = entry.trim().toLowerCase();
    // Node treats '*' as a wildcard in debug patterns. Reject every pattern
    // containing one rather than reproducing Node's matcher, so wildcard forms
    // such as http*, *ttps and h* cannot enable HTTP or HTTPS diagnostics.
    return (
      namespace.includes('*') || SENSITIVE_DEBUG_NAMESPACES.has(namespace)
    );
  });

  if (unsafe) {
    const error = new Error(
      'Credential-bearing staging requests are refused while NODE_DEBUG contains HTTP or HTTPS namespaces or wildcard patterns. Unset NODE_DEBUG or use only unrelated exact namespaces.'
    );
    error.code = 'unsafe-node-debug';
    throw error;
  }
}

function assertReadOnlyEndpoint(endpoint) {
  if (
    typeof endpoint !== 'string' ||
    !endpoint.startsWith('/rest/api/3/') ||
    endpoint.includes('?') ||
    endpoint.includes('#') ||
    endpoint.includes('%') ||
    endpoint.includes('\\')
  ) {
    throw endpointError(
      'The request endpoint is not permitted by the read-only preflight boundary.'
    );
  }

  if (EXACT_ENDPOINTS.has(endpoint)) {
    return { kind: EXACT_ENDPOINTS.get(endpoint).kind };
  }

  if (endpoint.startsWith(PROJECT_PREFIX)) {
    const key = endpoint.slice(PROJECT_PREFIX.length);
    if (!PROJECT_KEY_PATTERN.test(key)) {
      throw endpointError(
        'The project key in the request endpoint is not valid.'
      );
    }
    return { kind: 'project', key };
  }

  throw endpointError(
    'The request endpoint is not permitted by the read-only preflight boundary.'
  );
}

function appendQuery(url, query, allowedKeys) {
  if (query === undefined || query === null) {
    return;
  }
  if (typeof query !== 'object' || Array.isArray(query)) {
    throw endpointError('Query parameters must be a plain object.');
  }

  Object.entries(query).forEach(([key, value]) => {
    if (!allowedKeys.includes(key)) {
      throw endpointError(`Query parameter "${key}" is not permitted for this endpoint.`);
    }

    if (key === 'startAt') {
      assertInteger(value, 'startAt', 0, 1000000);
      url.searchParams.set(key, String(value));
      return;
    }

    if (key === 'maxResults') {
      assertInteger(value, 'maxResults', 1, 100);
      url.searchParams.set(key, String(value));
      return;
    }

    if (key === 'status') {
      const values = Array.isArray(value) ? value : [value];
      if (values.length === 0 || values.length > STATUS_VALUES.size) {
        throw endpointError('status must contain supported project statuses.');
      }
      values.forEach((entry) => {
        if (typeof entry !== 'string' || !STATUS_VALUES.has(entry)) {
          throw endpointError('status contains an unsupported project status.');
        }
        url.searchParams.append(key, entry);
      });
      return;
    }

    if (key === 'orderBy') {
      if (typeof value !== 'string' || !ORDER_BY_VALUES.has(value)) {
        throw endpointError('orderBy contains an unsupported ordering.');
      }
      url.searchParams.set(key, value);
      return;
    }

    if (key === 'projectKey') {
      if (typeof value !== 'string' || !PROJECT_KEY_PATTERN.test(value)) {
        throw endpointError('projectKey is not a valid Jira project key.');
      }
      url.searchParams.set(key, value);
      return;
    }

    if (key === 'projectId') {
      if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        throw endpointError('projectId must be numeric.');
      }
      url.searchParams.set(key, value);
      return;
    }

    if (key === 'permissions') {
      const values = typeof value === 'string' ? value.split(',') : [];
      if (
        values.length === 0 ||
        values.length > 50 ||
        values.some((entry) => !PERMISSION_KEY_PATTERN.test(entry))
      ) {
        throw endpointError('permissions contains an invalid Jira permission key.');
      }
      url.searchParams.set(key, values.join(','));
    }
  });
}

function parseRetryAfter(headers, nowMs) {
  if (!headers) {
    return null;
  }
  const raw = headers['retry-after'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const seconds = String(value).trim();
  if (/^\d+$/.test(seconds)) {
    return Number(seconds) * 1000;
  }

  const date = Date.parse(seconds);
  if (Number.isNaN(date)) {
    return null;
  }
  return Math.max(0, date - nowMs);
}

function responseDetail(body, secrets) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.errorMessages)) {
    return '';
  }
  const detail = body.errorMessages
    .filter((entry) => typeof entry === 'string')
    .slice(0, 3)
    .join(' | ');
  if (!detail) {
    return '';
  }
  return ` ${redactText(detail, secrets).slice(0, 400)}`;
}

function errorForStatus(status, endpoint, body, secrets, attempts, retryAfterMs) {
  const detail = responseDetail(body, secrets);
  let code = 'unexpected-status';
  let message = `Jira returned HTTP ${status} for GET ${endpoint}.${detail}`;

  if (status === 401) {
    code = 'authentication';
    message = `Jira rejected the configured credentials (HTTP 401) for GET ${endpoint}.${detail}`;
  } else if (status === 403) {
    code = 'forbidden';
    message = `The configured account is not permitted to perform GET ${endpoint} (HTTP 403).${detail}`;
  } else if (status === 404) {
    code = 'not-found';
    message = `The requested Jira resource was not found (HTTP 404) for GET ${endpoint}.${detail}`;
  } else if (status === 429) {
    code = 'rate-limited';
    message = `Jira rate limiting persisted after ${attempts} attempt(s) for GET ${endpoint}.${detail}`;
  } else if (status >= 500) {
    code = 'server';
    message = `Jira returned a server error (HTTP ${status}) for GET ${endpoint} after ${attempts} attempt(s).${detail}`;
  }

  return new JiraRequestError(message, {
    code,
    status,
    attempts,
    endpoint,
    retryAfterMs,
  });
}


function assertInteger(value, name, minimum, maximum) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw endpointError(`${name} is outside the permitted range.`);
  }
}

function createHttpsRequest(options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const maxBodyBytes = options.maxBodyBytes || MAX_RESPONSE_BYTES;

  return function requestJson(urlString, requestOptions = {}) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(urlString);
      } catch (error) {
        reject(new Error('The request URL is invalid.'));
        return;
      }

      if (url.protocol !== 'https:') {
        reject(new Error('Only HTTPS requests are permitted.'));
        return;
      }

      let settled = false;
      function fail(error) {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      }

      const method =
        typeof requestOptions.method === 'string'
          ? requestOptions.method.toUpperCase()
          : 'GET';
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
        fail(new Error('The request method is not supported.'));
        return;
      }

      let payload = null;
      if (requestOptions.body !== undefined && requestOptions.body !== null) {
        payload = JSON.stringify(requestOptions.body);
        if (Buffer.byteLength(payload, 'utf8') > MAX_REQUEST_BYTES) {
          fail(new Error('The Jira request body exceeded the permitted size.'));
          return;
        }
      }

      const request = https.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          method,
          headers: {
            Accept: 'application/json',
            'User-Agent': USER_AGENT,
            ...(payload === null
              ? {}
              : {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(payload, 'utf8'),
                }),
            ...(requestOptions.headers || {}),
          },
          timeout: timeoutMs,
        },
        (response) => {
          const chunks = [];
          let size = 0;

          response.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBodyBytes) {
              fail(new Error('The Jira response exceeded the permitted size.'));
              response.resume();
              request.destroy();
              return;
            }
            chunks.push(chunk);
          });

          response.on('end', () => {
            if (settled) {
              return;
            }
            const text = Buffer.concat(chunks).toString('utf8');
            let body = text;
            if (text) {
              try {
                body = JSON.parse(text);
              } catch (error) {
                body = text;
              }
            } else {
              body = null;
            }
            settled = true;
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body,
            });
          });

          response.on('error', fail);
        }
      );

      request.on('timeout', () => {
        request.destroy(
          Object.assign(new Error('The Jira request timed out.'), {
            code: 'ETIMEDOUT',
          })
        );
      });
      request.on('error', fail);
      request.end(payload === null ? undefined : payload);
    });
  };
}

function isRetryableNetworkError(error) {
  return Boolean(
    error &&
      (RETRYABLE_NETWORK_CODES.has(error.code) ||
        (typeof error.message === 'string' &&
          /timed out|socket hang up|network/i.test(error.message)))
  );
}


class JiraReadOnlyClient {
  constructor(options) {
    assertSafeNodeDebug(process.env);
    if (options.env) {
      assertSafeNodeDebug(options.env);
    }

    const site = options.site || {};
    if (!site.origin || !/^https:\/\//.test(site.origin)) {
      throw new Error('A validated HTTPS Jira site origin is required.');
    }
    if (!options.email || !options.apiToken) {
      throw new Error('Jira credentials are required.');
    }

    this.site = site;
    this.email = options.email;
    this.apiToken = options.apiToken;
    this.secrets = [options.apiToken, options.email];
    this.request =
      options.request || createHttpsRequest({ timeoutMs: options.timeoutMs });
    this.sleep =
      options.sleep ||
      ((milliseconds) =>
        new Promise((resolve) => {
          setTimeout(resolve, milliseconds);
        }));
    this.maxRetries = Number.isInteger(options.maxRetries)
      ? options.maxRetries
      : 2;
    this.retryMaxWaitMs = Number.isInteger(options.retryMaxWaitMs)
      ? options.retryMaxWaitMs
      : 30000;
    this.authorization = `Basic ${Buffer.from(
      `${options.email}:${options.apiToken}`,
      'utf8'
    ).toString('base64')}`;
  }

  async get(endpoint, query) {
    const route = assertReadOnlyEndpoint(endpoint);
    const definition = EXACT_ENDPOINTS.get(endpoint);
    const url = new URL(endpoint, this.site.origin);
    if (url.origin !== this.site.origin) {
      throw endpointError('The request URL escaped the configured Jira origin.');
    }
    appendQuery(url, query, definition ? definition.query : []);
    if (route.kind === 'project' && query !== undefined) {
      throw endpointError('Project endpoints do not accept query parameters.');
    }

    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let response;
      try {
        response = await this.request(url.toString(), {
          headers: { Authorization: this.authorization },
        });
      } catch (error) {
        const retryable = isRetryableNetworkError(error);
        if (retryable && attempt < this.maxRetries) {
          const wait = Math.min(500 * 2 ** attempt, this.retryMaxWaitMs);
          await this.sleep(wait);
          continue;
        }
        throw new JiraRequestError(
          'The Jira request failed before a response was received.',
          {
            code: 'network',
            attempts: attempt + 1,
            endpoint,
            cause: error,
          }
        );
      }

      if (response.status === 200) {
        if (
          response.body === null ||
          response.body === undefined ||
          typeof response.body !== 'object'
        ) {
          throw new JiraRequestError(
            `Jira returned a non-JSON response for GET ${endpoint}.`,
            {
              code: 'invalid-response',
              status: response.status,
              attempts: attempt + 1,
              endpoint,
            }
          );
        }
        return response.body;
      }

      const retryAfterMs = parseRetryAfter(response.headers, Date.now());
      lastError = errorForStatus(
        response.status,
        endpoint,
        response.body,
        this.secrets,
        attempt + 1,
        retryAfterMs
      );

      if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries) {
        const fallback = Math.min(500 * 2 ** attempt, this.retryMaxWaitMs);
        const wait = Math.min(
          retryAfterMs === null ? fallback : retryAfterMs,
          this.retryMaxWaitMs
        );
        await this.sleep(wait);
        continue;
      }

      throw lastError;
    }

    throw (
      lastError ||
      new JiraRequestError('The Jira request failed.', {
        code: 'request-failed',
        endpoint,
      })
    );
  }
}

module.exports = {
  JiraReadOnlyClient,
  JiraRequestError,
  assertReadOnlyEndpoint,
  assertSafeNodeDebug,
  createHttpsRequest,
  parseRetryAfter,
};
