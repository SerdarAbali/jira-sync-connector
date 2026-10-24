'use strict';

/**
 * Minimal, explicitly bounded Jira write client for the staging E2E runner.
 *
 * Safety properties:
 * - every endpoint is matched against a fixed method + pattern table;
 * - every issue and project touched must belong to the configured staging
 *   project allow-list;
 * - POST requests are never retried automatically (only 429 is retried, which
 *   Jira rejects before processing);
 * - once cancellation is observed no new mutation attempt starts, including a
 *   transport retry after a Retry-After sleep;
 * - a run-wide mutation budget stops runaway writes.
 */

const { JiraRequestError, createHttpsRequest, parseRetryAfter } = require('./http');

const PROJECT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,62}-\d{1,10}$/;
const MAX_ERROR_DETAIL = 300;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

// Bounded continuation. Jira documents `GET /rest/api/3/search/jql` as a
// token-paginated endpoint and `GET /rest/api/3/issue/{key}/comment` as an
// offset-paginated endpoint that reports startAt/maxResults/total.
const SEARCH_PAGE_SIZE = 50;
const SEARCH_MAX_PAGES = 10;
const COMMENT_PAGE_SIZE = 100;
const COMMENT_MAX_PAGES = 20;
const META_PAGE_SIZE = 50;
const META_MAX_PAGES = 5;

const INCOMPLETE_REASONS = {
  TOKEN_REPEATED: 'pagination-token-repeated',
  STALLED: 'pagination-stalled',
  CAP: 'pagination-cap-reached',
  INCONSISTENT: 'pagination-metadata-inconsistent',
  EMPTY_PAGE: 'pagination-empty-page',
  DUPLICATE_ENTRY: 'pagination-duplicate-entry',
};

function incompleteResult(items, reason, detail) {
  return { ...items, complete: false, reason, detail: detail || null };
}

const ROUTES = [
  { method: 'GET', pattern: /^\/rest\/api\/3\/myself$/, query: [], scope: 'none' },
  {
    method: 'GET',
    pattern: /^\/rest\/api\/3\/mypermissions$/,
    query: ['permissions', 'projectKey'],
    scope: 'project-query',
  },
  {
    method: 'GET',
    pattern: /^\/rest\/api\/3\/project\/([A-Za-z][A-Za-z0-9_]{0,63})$/,
    query: [],
    scope: 'project',
  },
  {
    method: 'GET',
    pattern: /^\/rest\/api\/3\/project\/([A-Za-z][A-Za-z0-9_]{0,63})\/statuses$/,
    query: [],
    scope: 'project',
  },
  {
    method: 'GET',
    pattern: /^\/rest\/api\/3\/issue\/createmeta\/([A-Za-z][A-Za-z0-9_]{0,63})\/issuetypes$/,
    query: ['startAt', 'maxResults'],
    scope: 'project',
  },
  {
    method: 'GET',
    pattern: /^\/rest\/api\/3\/issue\/createmeta\/([A-Za-z][A-Za-z0-9_]{0,63})\/issuetypes\/(\d{1,20})$/,
    query: ['startAt', 'maxResults'],
    scope: 'project',
  },
  {
    method: 'GET',
    pattern: /^\/rest\/api\/3\/search\/jql$/,
    query: ['jql', 'fields', 'maxResults', 'nextPageToken'],
    scope: 'query',
  },
  {
    method: 'GET',
    pattern: /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]{0,62}-\d{1,10})$/,
    query: ['fields'],
    scope: 'issue',
  },
  {
    method: 'GET',
    pattern: /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]{0,62}-\d{1,10})\/comment$/,
    query: ['startAt', 'maxResults'],
    scope: 'issue',
  },
  {
    method: 'GET',
    pattern: /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]{0,62}-\d{1,10})\/transitions$/,
    query: ['expand'],
    scope: 'issue',
  },
  { method: 'POST', pattern: /^\/rest\/api\/3\/issue$/, query: [], scope: 'create' },
  {
    method: 'PUT',
    pattern: /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]{0,62}-\d{1,10})$/,
    query: ['notifyUsers'],
    scope: 'issue',
  },
  {
    method: 'POST',
    pattern: /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]{0,62}-\d{1,10})\/transitions$/,
    query: ['notifyUsers'],
    scope: 'issue',
  },
  {
    method: 'POST',
    pattern: /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]{0,62}-\d{1,10})\/comment$/,
    query: [],
    scope: 'issue',
  },
  {
    method: 'DELETE',
    pattern: /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]{0,62}-\d{1,10})$/,
    // deleteSubtasks is deliberately not an allowed parameter: fixture cleanup
    // must never cascade to children the run does not own.
    query: [],
    scope: 'issue',
  },
];

function endpointError(message) {
  return new JiraRequestError(message, { code: 'endpoint-not-allowed', attempts: 0 });
}

function assertIssueKey(key) {
  if (typeof key !== 'string' || !ISSUE_KEY_PATTERN.test(key)) {
    throw endpointError('The issue key is not a valid Jira issue key.');
  }
  return key;
}

function assertProjectKey(key) {
  if (typeof key !== 'string' || !PROJECT_KEY_PATTERN.test(key)) {
    throw endpointError('The project key is not a valid Jira project key.');
  }
  return key;
}

function projectKeyOfIssue(issueKey) {
  return issueKey.slice(0, issueKey.lastIndexOf('-')).toUpperCase();
}

function appendE2EQuery(url, query, allowedKeys) {
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
    if (value === undefined || value === null) {
      return;
    }
    if (key === 'startAt' || key === 'maxResults') {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw endpointError(`Query parameter "${key}" must be a non-negative integer.`);
      }
      url.searchParams.set(key, String(value));
      return;
    }
    if (key === 'notifyUsers' || key === 'deleteSubtasks') {
      if (typeof value !== 'boolean') {
        throw endpointError(`Query parameter "${key}" must be a boolean.`);
      }
      url.searchParams.set(key, String(value));
      return;
    }
    if (typeof value !== 'string' || value.length > 4000 || value.includes('\0')) {
      throw endpointError(`Query parameter "${key}" must be a bounded string.`);
    }
    url.searchParams.set(key, value);
  });
}

function textToAdf(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('ADF text content is required.');
  }
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: text.slice(0, 8000) }],
      },
    ],
  };
}

function adfToText(node) {
  if (!node || typeof node !== 'object') {
    return '';
  }
  if (node.type === 'text' && typeof node.text === 'string') {
    return node.text;
  }
  if (Array.isArray(node.content)) {
    return node.content.map((child) => adfToText(child)).join('');
  }
  return '';
}

function escapeJqlString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function delayFor(attempt, initialDelayMs, maxDelayMs) {
  const base = Math.max(Number(initialDelayMs) || 250, 1);
  const cap = Math.max(Number(maxDelayMs) || base, base);
  return Math.min(base * Math.pow(1.8, Math.max(0, attempt - 1)), cap);
}

async function pollUntil(options) {
  const describe = options.describe || 'the expected state';
  const timeoutMs = Number(options.timeoutMs) || 1000;
  const maxAttempts = Number.isSafeInteger(options.maxAttempts) ? options.maxAttempts : 60;
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const isAborted = typeof options.isAborted === 'function' ? options.isAborted : () => false;
  const startedAt = now();
  let attempts = 0;
  let lastValue = null;

  for (;;) {
    attempts += 1;
    lastValue = await options.check();
    if (options.isDone(lastValue)) {
      return {
        ok: true,
        attempts,
        elapsedMs: now() - startedAt,
        value: lastValue,
        timedOut: false,
        aborted: false,
      };
    }

    if (isAborted()) {
      return {
        ok: false,
        attempts,
        elapsedMs: now() - startedAt,
        value: lastValue,
        timedOut: false,
        aborted: true,
        describe,
      };
    }

    if (attempts >= maxAttempts) {
      return {
        ok: false,
        attempts,
        elapsedMs: now() - startedAt,
        value: lastValue,
        timedOut: true,
        aborted: false,
        describe,
      };
    }

    const delay = delayFor(
      attempts,
      options.initialDelayMs,
      options.maxDelayMs
    );
    if (now() - startedAt + delay > timeoutMs) {
      return {
        ok: false,
        attempts,
        elapsedMs: now() - startedAt,
        value: lastValue,
        timedOut: true,
        aborted: false,
        describe,
      };
    }
    await sleep(delay);
  }
}

function routeFor(method, endpoint) {
  const route = ROUTES.find(
    (entry) => entry.method === method && entry.pattern.test(endpoint)
  );
  if (!route) {
    throw endpointError(
      `The ${method} endpoint is not permitted by the staging E2E boundary.`
    );
  }
  return route;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorDetail(body) {
  if (!isPlainObject(body)) {
    return '';
  }
  const messages = Array.isArray(body.errorMessages)
    ? body.errorMessages.filter((entry) => typeof entry === 'string')
    : [];
  const fieldErrors = isPlainObject(body.errors)
    ? Object.entries(body.errors)
        .filter(([, value]) => typeof value === 'string')
        .map(([key, value]) => `${key}: ${value}`)
    : [];
  return [...messages, ...fieldErrors].join('; ').slice(0, MAX_ERROR_DETAIL);
}

class JiraWriteClient {
  constructor(options = {}) {
    const site = options.site || {};
    if (!site.origin || !/^https:\/\//.test(site.origin)) {
      throw new Error('A validated HTTPS Jira site origin is required.');
    }
    if (!options.email || !options.apiToken) {
      throw new Error('Jira credentials are required.');
    }

    this.label = options.label || site.role || 'staging';
    this.site = site;
    this.origin = site.origin;
    this.allowedProjects = new Set(
      (options.allowedProjectKeys || []).map((key) => String(key).toUpperCase())
    );
    this.maxMutations = Number.isSafeInteger(options.maxMutations)
      ? options.maxMutations
      : 60;
    this.mutations = 0;
    this.requests = 0;
    this.mutationLog = [];
    this.now = options.now || (() => Date.now());
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : 2;
    this.retryMaxWaitMs = Number.isInteger(options.retryMaxWaitMs)
      ? options.retryMaxWaitMs
      : 30000;
    this.request = options.request || createHttpsRequest({ timeoutMs: options.timeoutMs });
    // Cancellation predicate. It is consulted before every mutating attempt, so
    // an operator signal stops transport retries as well as new scenario writes.
    this.isInterrupted =
      typeof options.isInterrupted === 'function' ? options.isInterrupted : () => false;
    this.authorization = `Basic ${Buffer.from(
      `${options.email}:${options.apiToken}`,
      'utf8'
    ).toString('base64')}`;
  }

  remainingMutations() {
    return Math.max(0, this.maxMutations - this.mutations);
  }

  /**
   * Cancellation gate for the mutation transport.
   *
   * A cancelled run must not start a NEW Jira mutation attempt, and a transport
   * retry (for example the 429 retry allowed for POST) is a new attempt. The
   * gate is therefore checked before the first attempt and again before every
   * retry, never after the request has been sent: a request that already left
   * the process may still complete and is never described as reversed.
   *
   * `allowInterrupted` marks the one permitted exception: the bounded,
   * run-owned cleanup of fixtures the interrupted run created itself.
   */
  _assertNotInterrupted(endpoint, options = {}) {
    if (options.allowInterrupted === true) {
      return;
    }
    if (this.isInterrupted() !== true) {
      return;
    }
    const error = new JiraRequestError(
      'The run was interrupted; no further Jira request was started.',
      { code: 'run-interrupted', endpoint, attempts: 0 }
    );
    error.interrupted = true;
    throw error;
  }

  assertProjectAllowed(projectKey) {
    const normalized = typeof projectKey === 'string' ? projectKey.toUpperCase() : '';
    if (!PROJECT_KEY_PATTERN.test(normalized)) {
      throw endpointError('The project key is not a valid Jira project key.');
    }
    if (!this.allowedProjects.has(normalized)) {
      throw new JiraRequestError(
        `Project ${normalized} is outside the configured staging allow-list.`,
        { code: 'project-not-allowed', attempts: 0 }
      );
    }
  }

  assertIssueAllowed(issueKey) {
    assertIssueKey(issueKey);
    this.assertProjectAllowed(projectKeyOfIssue(issueKey));
  }

  _assertCreateBody(body) {
    if (!isPlainObject(body) || !isPlainObject(body.fields)) {
      throw endpointError('A create request must contain a fields object.');
    }
    const allowed = ['project', 'issuetype', 'summary', 'description', 'labels'];
    Object.keys(body.fields).forEach((key) => {
      if (!allowed.includes(key)) {
        throw endpointError(`Create field "${key}" is not permitted by the E2E boundary.`);
      }
    });
    this.assertProjectAllowed(body.fields.project?.key);
    if (!body.fields.issuetype || !/^\d{1,20}$/.test(String(body.fields.issuetype.id || ''))) {
      throw endpointError('A create request must reference a numeric issue type ID.');
    }
    if (
      typeof body.fields.summary !== 'string' ||
      !body.fields.summary.trim() ||
      body.fields.summary.length > 255
    ) {
      throw endpointError('A create request must include a bounded summary.');
    }
    if (body.fields.description !== undefined && !isPlainObject(body.fields.description)) {
      throw endpointError('A create request description must be an Atlassian document.');
    }
  }

  _assertUpdateBody(body) {
    if (!isPlainObject(body) || !isPlainObject(body.fields)) {
      throw endpointError('An update request must contain a fields object.');
    }
    const allowed = ['description', 'summary'];
    Object.keys(body.fields).forEach((key) => {
      if (!allowed.includes(key)) {
        throw endpointError(`Update field "${key}" is not permitted by the E2E boundary.`);
      }
    });
    if (Object.keys(body.fields).length === 0) {
      throw endpointError('An update request must change at least one field.');
    }
  }


  async _dispatch(method, endpoint, options = {}) {
    const route = routeFor(method, endpoint);
    const url = new URL(endpoint, this.origin);
    if (url.origin !== this.origin) {
      throw endpointError('The request URL escaped the configured Jira origin.');
    }
    appendE2EQuery(url, options.query, route.query);

    const match = route.pattern.exec(endpoint);
    if (route.scope === 'issue') {
      this.assertIssueAllowed(match[1]);
    } else if (route.scope === 'project') {
      this.assertProjectAllowed(match[1]);
    } else if (route.scope === 'project-query') {
      this.assertProjectAllowed(options.query && options.query.projectKey);
    } else if (route.scope === 'create') {
      this._assertCreateBody(options.body);
    }

    if (method === 'PUT') {
      this._assertUpdateBody(options.body);
    }

    const mutating = method !== 'GET';
    if (mutating) {
      // Before the budget is charged and before the first attempt is sent: a
      // cancelled run starts no new mutation, not even a retry.
      this._assertNotInterrupted(endpoint, options);
      if (this.mutations >= this.maxMutations && options.force !== true) {
        throw new JiraRequestError(
          'The run mutation budget was exhausted; no further writes were sent.',
          { code: 'mutation-budget-exhausted', attempts: 0 }
        );
      }
      this.mutations += 1;
      this.mutationLog.push({ method, endpoint, at: new Date(this.now()).toISOString() });
    }

    const accept = options.accept || (method === 'GET' ? [200] : [200, 204]);
    const allowAbsent = options.allowAbsent === true;
    let lastResponse = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (mutating) {
        // Re-checked for every attempt, so a signal that arrives during the
        // Retry-After sleep stops the retry instead of sending it.
        this._assertNotInterrupted(endpoint, options);
      }
      this.requests += 1;
      let response;
      try {
        response = await this.request(url.toString(), {
          method,
          headers: { Authorization: this.authorization },
          body: options.body,
        });
      } catch (error) {
        const retryableNetwork = method !== 'POST';
        if (!retryableNetwork || attempt >= this.maxRetries) {
          const failure = new JiraRequestError(
            `The ${this.label} Jira request failed before a response was received.`,
            {
              code: 'network-error',
              endpoint,
              attempts: attempt + 1,
              cause: error,
            }
          );
          if (method === 'POST') {
            failure.outcomeUnknown = true;
          }
          throw failure;
        }
        await this.sleep(delayFor(attempt + 1, 500, this.retryMaxWaitMs));
        continue;
      }

      if (accept.includes(response.status)) {
        return response.body === undefined ? null : response.body;
      }

      if (allowAbsent && response.status === 404) {
        return { absent: true };
      }

      const retryableStatus =
        RETRYABLE_STATUS.has(response.status) &&
        (method !== 'POST' || response.status === 429) &&
        attempt < this.maxRetries;

      if (retryableStatus) {
        const retryAfter = parseRetryAfter(response.headers, this.now());
        const delay = Number.isFinite(retryAfter)
          ? Math.min(retryAfter, this.retryMaxWaitMs)
          : delayFor(attempt + 1, 500, this.retryMaxWaitMs);
        lastResponse = response;
        await this.sleep(delay);
        continue;
      }

      const detail = errorDetail(response.body);
      const failure = new JiraRequestError(
        `The ${this.label} Jira request returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        {
          code: 'unexpected-status',
          status: response.status,
          endpoint,
          attempts: attempt + 1,
          retryAfterMs: parseRetryAfter(response.headers, this.now()),
        }
      );
      failure.responseBody = response.body;
      if (method === 'POST' && response.status >= 500) {
        failure.outcomeUnknown = true;
      }
      throw failure;
    }

    throw new JiraRequestError(
      `The ${this.label} Jira request did not succeed after ${this.maxRetries + 1} attempts.`,
      {
        code: 'retry-exhausted',
        status: lastResponse ? lastResponse.status : null,
        endpoint,
        attempts: this.maxRetries + 1,
      }
    );
  }


  getMyself() {
    return this._dispatch('GET', '/rest/api/3/myself');
  }

  getProject(projectKey) {
    const key = assertProjectKey(projectKey);
    return this._dispatch('GET', `/rest/api/3/project/${encodeURIComponent(key)}`);
  }

  getProjectStatuses(projectKey) {
    const key = assertProjectKey(projectKey);
    return this._dispatch('GET', `/rest/api/3/project/${encodeURIComponent(key)}/statuses`);
  }

  async getCreateMetaIssueTypes(projectKey) {
    const key = assertProjectKey(projectKey);
    const issueTypes = [];
    const seen = new Set();
    for (let page = 0; page < META_MAX_PAGES; page += 1) {
      const body = await this._dispatch(
        'GET',
        `/rest/api/3/issue/createmeta/${encodeURIComponent(key)}/issuetypes`,
        { query: { startAt: page * META_PAGE_SIZE, maxResults: META_PAGE_SIZE } }
      );
      if (!Array.isArray(body?.issueTypes)) {
        return incompleteResult(
          { issueTypes },
          INCOMPLETE_REASONS.INCONSISTENT,
          'The create-metadata page did not contain an issueTypes array.'
        );
      }
      for (const entry of body.issueTypes) {
        const id = entry && entry.id !== undefined ? String(entry.id) : '';
        if (!id) {
          return incompleteResult(
            { issueTypes },
            INCOMPLETE_REASONS.INCONSISTENT,
            'A create-metadata issue type had no id.'
          );
        }
        if (seen.has(id)) {
          return incompleteResult(
            { issueTypes },
            INCOMPLETE_REASONS.DUPLICATE_ENTRY,
            'A create-metadata issue type was returned on more than one page.'
          );
        }
        seen.add(id);
        issueTypes.push(entry);
      }
      if (body.isLast !== false) {
        return { issueTypes, complete: true, reason: null, detail: null };
      }
      if (body.issueTypes.length === 0) {
        return incompleteResult(
          { issueTypes },
          INCOMPLETE_REASONS.EMPTY_PAGE,
          'Create metadata advertised another page but returned no issue types.'
        );
      }
    }
    return incompleteResult(
      { issueTypes },
      INCOMPLETE_REASONS.CAP,
      `Create metadata exceeded the ${META_MAX_PAGES}-page limit.`
    );
  }

  getIssue(
    issueKey,
    fields = ['summary', 'status', 'issuetype', 'description', 'created', 'updated', 'project']
  ) {
    const key = assertIssueKey(issueKey);
    return this._dispatch('GET', `/rest/api/3/issue/${encodeURIComponent(key)}`, {
      query: { fields: fields.join(',') },
    });
  }

  /**
   * Token-paginated search per `GET /rest/api/3/search/jql`. A bounded number
   * of pages is read; an advertised continuation without a token, a repeated
   * token, a repeated issue key or the page cap all return an INCOMPLETE result
   * so callers never treat a partial read as proof of absence or uniqueness.
   */
  async searchIssues(jql) {
    const issues = [];
    const seenKeys = new Set();
    const seenTokens = new Set();
    let nextPageToken = null;

    for (let page = 0; page < SEARCH_MAX_PAGES; page += 1) {
      const query = {
        jql,
        fields: 'summary,project,status,issuetype,description,created,updated',
        maxResults: SEARCH_PAGE_SIZE,
      };
      if (nextPageToken) {
        query.nextPageToken = nextPageToken;
      }
      const body = await this._dispatch('GET', '/rest/api/3/search/jql', { query });
      if (!Array.isArray(body?.issues)) {
        return incompleteResult(
          { issues },
          INCOMPLETE_REASONS.INCONSISTENT,
          'The search page did not contain an issues array.'
        );
      }
      for (const issue of body.issues) {
        const key = typeof issue?.key === 'string' ? issue.key : '';
        if (!key) {
          return incompleteResult(
            { issues },
            INCOMPLETE_REASONS.INCONSISTENT,
            'A search result had no issue key.'
          );
        }
        if (seenKeys.has(key)) {
          return incompleteResult(
            { issues },
            INCOMPLETE_REASONS.DUPLICATE_ENTRY,
            'A search result was returned on more than one page.'
          );
        }
        seenKeys.add(key);
        issues.push(issue);
      }

      const token =
        typeof body.nextPageToken === 'string' && body.nextPageToken
          ? body.nextPageToken
          : null;
      if (body.isLast === true) {
        return { issues, complete: true, reason: null, detail: null };
      }
      if (!token) {
        if (body.isLast === false) {
          return incompleteResult(
            { issues },
            INCOMPLETE_REASONS.STALLED,
            'Search advertised another page but returned no continuation token.'
          );
        }
        return { issues, complete: true, reason: null, detail: null };
      }
      if (seenTokens.has(token)) {
        return incompleteResult(
          { issues },
          INCOMPLETE_REASONS.TOKEN_REPEATED,
          'Search returned the same continuation token twice.'
        );
      }
      seenTokens.add(token);
      nextPageToken = token;
    }

    return incompleteResult(
      { issues },
      INCOMPLETE_REASONS.CAP,
      `Search exceeded the ${SEARCH_MAX_PAGES}-page limit.`
    );
  }

  /**
   * Offset-paginated comments per `GET /rest/api/3/issue/{key}/comment`. The
   * returned startAt/maxResults/total metadata drives continuation, and an
   * empty page before `total`, a changing total or the page cap is INCOMPLETE.
   */
  async getComments(issueKey) {
    const key = assertIssueKey(issueKey);
    const comments = [];
    const seenIds = new Set();
    let startAt = 0;
    let total = null;

    for (let page = 0; page < COMMENT_MAX_PAGES; page += 1) {
      const body = await this._dispatch(
        'GET',
        `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
        { query: { startAt, maxResults: COMMENT_PAGE_SIZE } }
      );
      if (!Array.isArray(body?.comments)) {
        return incompleteResult(
          { comments, total },
          INCOMPLETE_REASONS.INCONSISTENT,
          'The comment page did not contain a comments array.'
        );
      }
      const pageStart = Number.isSafeInteger(body.startAt) ? body.startAt : startAt;
      const pageTotal = Number.isSafeInteger(body.total) ? body.total : null;
      if (pageStart !== startAt || pageTotal === null) {
        return incompleteResult(
          { comments, total },
          INCOMPLETE_REASONS.INCONSISTENT,
          'The comment page reported a different startAt or no total.'
        );
      }
      if (total === null) {
        total = pageTotal;
      } else if (total !== pageTotal) {
        return incompleteResult(
          { comments, total },
          INCOMPLETE_REASONS.INCONSISTENT,
          'The comment total changed between pages.'
        );
      }
      if (Number.isSafeInteger(body.maxResults) && body.comments.length > body.maxResults) {
        return incompleteResult(
          { comments, total },
          INCOMPLETE_REASONS.INCONSISTENT,
          'The comment page exceeded the reported maxResults.'
        );
      }
      for (const comment of body.comments) {
        const id = typeof comment?.id === 'string' ? comment.id : '';
        if (!id) {
          return incompleteResult(
            { comments, total },
            INCOMPLETE_REASONS.INCONSISTENT,
            'A comment had no id.'
          );
        }
        if (seenIds.has(id)) {
          return incompleteResult(
            { comments, total },
            INCOMPLETE_REASONS.DUPLICATE_ENTRY,
            'A comment was returned on more than one page.'
          );
        }
        seenIds.add(id);
        comments.push(comment);
      }

      const nextStart = pageStart + body.comments.length;
      if (nextStart >= total) {
        return { comments, total, complete: true, reason: null, detail: null };
      }
      if (body.comments.length === 0) {
        return incompleteResult(
          { comments, total },
          INCOMPLETE_REASONS.EMPTY_PAGE,
          `The comment page was empty before the reported total of ${total}.`
        );
      }
      startAt = nextStart;
    }

    return incompleteResult(
      { comments, total },
      INCOMPLETE_REASONS.CAP,
      `Comments exceeded the ${COMMENT_MAX_PAGES}-page limit.`
    );
  }

  /**
   * Reads the subtasks of one issue. `known` is false when Jira did not return a
   * subtasks array, so cleanup can refuse to delete an issue whose children
   * cannot be enumerated.
   */
  async getIssueSubtasks(issueKey) {
    const key = assertIssueKey(issueKey);
    const body = await this._dispatch('GET', `/rest/api/3/issue/${encodeURIComponent(key)}`, {
      query: { fields: 'subtasks' },
    });
    const entries = Array.isArray(body?.fields?.subtasks) ? body.fields.subtasks : null;
    return {
      known: entries !== null,
      subtasks: (entries || [])
        .filter((entry) => typeof entry?.key === 'string')
        .map((entry) => ({
          key: entry.key,
          summary: typeof entry.fields?.summary === 'string' ? entry.fields.summary : null,
        })),
    };
  }

  async getTransitions(issueKey) {
    const key = assertIssueKey(issueKey);
    const body = await this._dispatch(
      'GET',
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
      { query: { expand: 'transitions.fields' } }
    );
    return Array.isArray(body?.transitions) ? body.transitions : [];
  }

  createIssue({ projectKey, issueTypeId, summary, description }) {
    const key = assertProjectKey(projectKey);
    const body = {
      fields: {
        project: { key },
        issuetype: { id: String(issueTypeId) },
        summary,
        description,
      },
    };
    return this._dispatch('POST', '/rest/api/3/issue', { body, accept: [201, 200] });
  }

  updateIssueDescription(issueKey, description) {
    const key = assertIssueKey(issueKey);
    return this._dispatch('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}`, {
      body: { fields: { description } },
      query: { notifyUsers: false },
      accept: [204, 200],
    });
  }

  addComment(issueKey, description) {
    const key = assertIssueKey(issueKey);
    return this._dispatch('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      body: { body: description },
      accept: [201, 200],
    });
  }

  transitionIssue(issueKey, transitionId) {
    const key = assertIssueKey(issueKey);
    if (!/^\d{1,20}$/.test(String(transitionId))) {
      throw endpointError('The transition ID must be numeric.');
    }
    return this._dispatch(
      'POST',
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
      {
        body: { transition: { id: String(transitionId) } },
        query: { notifyUsers: false },
        accept: [204, 200],
      }
    );
  }

  /**
   * Deletes one issue without cascading to its subtasks. Jira rejects the
   * request when the issue still has children, which is the safe outcome: a
   * generic fixture cleanup must never remove work it does not own.
   */
  async deleteIssue(issueKey, options = {}) {
    const key = assertIssueKey(issueKey);
    const result = await this._dispatch('DELETE', `/rest/api/3/issue/${encodeURIComponent(key)}`, {
      accept: [204, 200],
      allowAbsent: true,
      force: options.force === true,
      // Cleanup is a separate, bounded, run-owned operation: it is the only
      // mutation that may still run after an interruption.
      allowInterrupted: options.allowInterrupted === true,
    });
    return result && result.absent === true ? { absent: true } : { absent: false };
  }

  async getPermissions(projectKey, permissions) {
    const key = assertProjectKey(projectKey);
    const body = await this._dispatch('GET', '/rest/api/3/mypermissions', {
      query: { projectKey: key, permissions: permissions.join(',') },
    });
    return isPlainObject(body?.permissions) ? body.permissions : {};
  }
}


function summarizeIssue(issue) {
  const fields = isPlainObject(issue?.fields) ? issue.fields : {};
  return {
    key: typeof issue?.key === 'string' ? issue.key : null,
    id: typeof issue?.id === 'string' ? issue.id : null,
    projectKey: typeof fields.project?.key === 'string' ? fields.project.key : null,
    summary: typeof fields.summary === 'string' ? fields.summary : null,
    descriptionText: adfToText(fields.description).trim(),
    statusName: typeof fields.status?.name === 'string' ? fields.status.name : null,
    statusId: typeof fields.status?.id === 'string' ? fields.status.id : null,
    issueTypeId: fields.issuetype?.id !== undefined ? String(fields.issuetype.id) : null,
    issueTypeName: typeof fields.issuetype?.name === 'string' ? fields.issuetype.name : null,
    created: typeof fields.created === 'string' ? fields.created : null,
    updated: typeof fields.updated === 'string' ? fields.updated : null,
  };
}

function buildMarkerJql(projectKey, marker) {
  const key = assertProjectKey(projectKey);
  if (typeof marker !== 'string' || !/^[A-Za-z0-9-]{6,120}$/.test(marker)) {
    throw new Error('The run marker must be an alphanumeric-dash token.');
  }
  return `project = "${key}" AND summary ~ "${escapeJqlString(marker)}" ORDER BY created ASC`;
}

/**
 * Search results can lag behind writes, and JQL text search is tokenized, so a
 * match is only accepted when the summary literally contains the marker.
 */
function matchingIssues(issues, marker) {
  return (Array.isArray(issues) ? issues : [])
    .filter((issue) => typeof issue?.fields?.summary === 'string')
    .filter((issue) => issue.fields.summary.includes(marker))
    .map((issue) => summarizeIssue(issue));
}

module.exports = {
  JiraWriteClient,
  ROUTES,
  adfToText,
  assertIssueKey,
  assertProjectKey,
  buildMarkerJql,
  delayFor,
  escapeJqlString,
  matchingIssues,
  pollUntil,
  projectKeyOfIssue,
  summarizeIssue,
  textToAdf,
};
