/** @jest-environment node */
'use strict';

/**
 * Regression coverage for the opt-in staging E2E runner.
 *
 * Every test here is offline: the HTTP transport is replaced with an in-memory
 * fake Jira, so no request ever leaves the process and no real issue is mutated.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  E2E_WRITE_CONFIRMATION,
  MAX_MUTATIONS_PER_RUN,
  buildE2EPlan,
  parseE2EArguments,
} = require('../scripts/staging/lib/e2e-config');
const {
  JiraWriteClient,
  adfToText,
  pollUntil,
  textToAdf,
} = require('../scripts/staging/lib/e2e-api');
const { EXPECTED_APP_ID, validateReadiness } = require('../scripts/staging/lib/e2e-evidence');
const {
  AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE,
  bindReadinessResponse,
} = require('../scripts/staging/lib/forge-admin-readiness');
const { runE2E, cleanupFixtures } = require('../scripts/staging/lib/e2e-runner');
const {
  E2E_LATEST_REPORT_NAME,
  E2E_REPORT_KIND,
  formatE2ETerminalReport,
  validateReport,
  writeE2EReport,
} = require('../scripts/staging/lib/e2e-report');

const LOCAL_HOST = 'localstaging.atlassian.net';
const REMOTE_HOST = 'remotestaging.atlassian.net';
const FIXED_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const RECENT_MS = 30 * 1000;
const APP_UUID = EXPECTED_APP_ID.slice('ari:cloud:ecosystem::app/'.length);
const INSTALLATION_ID = '974910c5-2861-4d40-a7eb-37802842d0a0';
const ENVIRONMENT_ID = 'c2d7a8e4-2f1b-4a6e-9d3d-0f7e7a0b1234';

function siteConfig(role, projects) {
  const host = role === 'local' ? LOCAL_HOST : REMOTE_HOST;
  return {
    role,
    host,
    origin: `https://${host}`,
    email: `bot-${role}@example.test`,
    apiToken: `token-${role}-placeholder`,
    stagingProjects: projects,
    nonStagingProjects: [],
  };
}

function runnerConfig(overrides = {}) {
  return {
    local: siteConfig('local', ['STG']),
    remote: siteConfig('remote', ['RSTG']),
    maxRetries: 0,
    retryMaxWaitMs: 0,
    requestTimeoutMs: 5000,
    ...overrides,
  };
}

function runnerSettings(overrides = {}) {
  return {
    mode: 'dry-run',
    environment: 'staging',
    forgeInstallationId: INSTALLATION_ID,
    forgeEnvironmentId: ENVIRONMENT_ID,
    issueType: 'Task',
    selectors: null,
    evidenceMaxAgeMs: 15 * 60 * 1000,
    syncTimeoutMs: 2000,
    pollIntervalMs: 10,
    pollMaxIntervalMs: 40,
    maxPolls: 8,
    duplicateSettleMs: 0,
    cleanup: true,
    requiredPermissions: [
      'BROWSE_PROJECTS',
      'CREATE_ISSUES',
      'EDIT_ISSUES',
      'ADD_COMMENTS',
      'TRANSITION_ISSUES',
      'DELETE_ISSUES',
    ],
    maxMutations: MAX_MUTATIONS_PER_RUN,
    ...overrides,
  };
}

function readinessDocument(mutate) {
  const document = {
    kind: 'jira-sync-connector-readiness',
    schemaVersion: '1.0',
    generatedAt: new Date(FIXED_NOW - RECENT_MS).toISOString(),
    source: 'jest-fixture',
    capturedBy: 'jest',
    connector: {
      appId: EXPECTED_APP_ID,
      installationStatus: 'installed',
      installedSites: [LOCAL_HOST, REMOTE_HOST],
      environment: 'staging',
    },
    pause: { paused: false },
    f07: {
      version: 1,
      phase: 'entity-active',
      legacyDisabled: true,
      disabledAt: FIXED_NOW - 5_000_000,
      activatedAt: FIXED_NOW - 1_000_000,
    },
    organizations: [
      {
        orgId: 'org-staging',
        syncDirection: 'bidirectional',
        features: { syncComments: true },
        projectMappings: [{ localProjectKey: 'STG', remoteProjectKey: 'RSTG' }],
      },
    ],
    webhook: {
      configured: true,
      lastReceipt: { receivedAt: new Date(FIXED_NOW - RECENT_MS).toISOString() },
    },
  };
  if (typeof mutate === 'function') {
    mutate(document);
  }
  return document;
}

/**
 * The production readiness gate is fail-closed: `readForgeAdminReadiness()`
 * always rejects and `validateReadiness()` always downgrades to operator claims,
 * so a write-enabled run cannot execute at all today. The write-execution tests
 * below still have to exercise the executor, so they simulate the *future*
 * authenticated browser adapter at the module boundary:
 *
 *  - the adapter resolver returns a payload the test bound to the expected app,
 *    installation, environment and site (`bindReadinessResponse`);
 *  - the readiness evaluator records that simulated adapter as verification.
 *
 * The runner and CLI call sites are unchanged, and no run option re-opens access
 * to caller-supplied readiness. Every test that does not opt in exercises the
 * real fail-closed behavior.
 */
const mockReadinessAdapter = { mode: 'unavailable', code: null, facts: null };

jest.mock('../scripts/staging/lib/forge-admin-readiness', () => {
  const actual = jest.requireActual('../scripts/staging/lib/forge-admin-readiness');
  return {
    ...actual,
    readForgeAdminReadiness: jest.fn(async () => {
      if (mockReadinessAdapter.mode === 'verified') {
        return mockReadinessAdapter.facts;
      }
      const error = new Error('Simulated authenticated readiness adapter state.');
      error.code = mockReadinessAdapter.mode === 'failure'
        ? mockReadinessAdapter.code
        : actual.AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE;
      throw error;
    }),
  };
});

jest.mock('../scripts/staging/lib/e2e-evidence', () => {
  const actual = jest.requireActual('../scripts/staging/lib/e2e-evidence');
  return {
    ...actual,
    validateReadiness: (options = {}) => {
      const evaluated = actual.validateReadiness(options);
      if (mockReadinessAdapter.mode !== 'verified') {
        return evaluated;
      }
      return {
        ...evaluated,
        status: 'verified',
        reasons: evaluated.reasons.filter((entry) => entry.severity !== 'block'),
        summary: {
          ...evaluated.summary,
          readinessBasis: actual.READINESS_BASIS.VERIFIED,
          verification: { adapter: 'simulated-authenticated-browser' },
          attestation: {
            ...evaluated.summary.attestation,
            verified: true,
            note: 'Simulated adapter verification: write-path tests only.',
          },
        },
      };
    },
  };
});

beforeEach(() => {
  mockReadinessAdapter.mode = 'unavailable';
  mockReadinessAdapter.code = null;
  mockReadinessAdapter.facts = null;
});

/**
 * Raw payload a real authenticated adapter would return. Tests mutate a copy and
 * bind it to the expected identity, so the simulated adapter cannot skip the
 * binding contract the future implementation has to satisfy.
 */
function readinessFacts(mutate) {
  const facts = {
    success: true,
    version: 1,
    source: 'authenticated-connector',
    capturedAt: new Date(FIXED_NOW - RECENT_MS).toISOString(),
    appAri: EXPECTED_APP_ID,
    appId: APP_UUID,
    appVersion: '3.0.0',
    environment: 'staging',
    environmentId: ENVIRONMENT_ID,
    installationId: INSTALLATION_ID,
    installedSites: [LOCAL_HOST],
    paused: false,
    f07: {
      version: 1,
      phase: 'entity-active',
      legacyDisabled: true,
      disabledAt: FIXED_NOW - 5_000_000,
      activatedAt: FIXED_NOW - 1_000_000,
    },
    mappings: [
      {
        orgId: 'org-staging',
        syncDirection: 'bidirectional',
        syncComments: true,
        localProjectKey: 'STG',
        remoteProjectKey: 'RSTG',
      },
    ],
    webhook: {
      configured: true,
      lastReceiptAt: new Date(FIXED_NOW - RECENT_MS).toISOString(),
      lastRotatedAt: new Date(FIXED_NOW - RECENT_MS).toISOString(),
      receiptsAfterLatestRotation: true,
    },
  };
  if (typeof mutate === 'function') {
    mutate(facts);
  }
  return facts;
}

function readinessExpectation(overrides = {}) {
  return {
    appAri: EXPECTED_APP_ID,
    appId: APP_UUID,
    installationId: INSTALLATION_ID,
    environmentId: ENVIRONMENT_ID,
    environmentType: 'staging',
    siteHost: LOCAL_HOST,
    ...overrides,
  };
}

function boundReadinessFacts(mutate) {
  return bindReadinessResponse(readinessFacts(mutate), readinessExpectation());
}

/** Simulates the future authenticated adapter resolving verified readiness. */
function adapterVerifies(mutate) {
  mockReadinessAdapter.mode = 'verified';
  mockReadinessAdapter.code = null;
  mockReadinessAdapter.facts = boundReadinessFacts(mutate);
}

/** Simulates the adapter binding a payload and rejecting it. */
function adapterRejects(code) {
  mockReadinessAdapter.mode = 'failure';
  mockReadinessAdapter.code = code;
  mockReadinessAdapter.facts = null;
}

function virtualClock() {
  let current = FIXED_NOW;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += Math.max(Number(ms) || 0, 1);
    },
  };
}
/**
 * Minimal in-memory Jira double. It mirrors issues between STG and RSTG the way
 * the connector would, but only after `syncDelayPolls` requests have passed so
 * the polling helpers are exercised honestly.
 */
function createFakeJira(options = {}) {
  const delay = Number.isSafeInteger(options.syncDelayPolls) ? options.syncDelayPolls : 2;
  const projects = {
    STG: { id: '10000', key: 'STG' },
    RSTG: { id: '10001', key: 'RSTG' },
  };
  const issues = new Map();
  const pending = [];
  const counters = { STG: 0, RSTG: 0 };
  const requests = [];
  const mutations = [];
  const deletedKeys = [];
  const failDeleteKeys = new Set(options.failDeleteKeys || []);
  const failDeleteProject = options.failDeleteProject || null;
  const failMyself = options.failMyself || null;
  const afterCreate = typeof options.afterCreate === 'function' ? options.afterCreate : null;
  const beforeMutation =
    typeof options.beforeMutation === 'function' ? options.beforeMutation : null;
  const searchPages = typeof options.searchPages === 'function' ? options.searchPages : null;
  const commentPages = typeof options.commentPages === 'function' ? options.commentPages : null;
  const metaPages = typeof options.metaPages === 'function' ? options.metaPages : null;
  const pageCounters = { search: 0, comment: 0, meta: 0 };
  let tick = 0;
  let issueId = 50000;

  const projectOf = (key) => String(key).split('-')[0];
  const otherProject = (key) => (projectOf(key) === 'STG' ? 'RSTG' : 'STG');

  function schedule(task) {
    pending.push({ dueTick: tick + delay, task });
  }

  function runPending() {
    tick += 1;
    for (;;) {
      const index = pending.findIndex((entry) => entry.dueTick <= tick);
      if (index === -1) {
        return;
      }
      const [entry] = pending.splice(index, 1);
      entry.task();
    }
  }

  function createRecord(projectKey, fields) {
    counters[projectKey] += 1;
    issueId += 1;
    const record = {
      key: `${projectKey}-${counters[projectKey]}`,
      id: String(issueId),
      projectKey,
      summary: fields.summary,
      description: fields.description || null,
      statusName: fields.statusName || 'To Do',
      issueTypeId: '10001',
      issueTypeName: fields.subtask ? 'Sub-task' : 'Task',
      parentKey: fields.parentKey || null,
      subtask: fields.subtask === true,
      comments: [],
      mirrorKey: null,
    };
    issues.set(record.key, record);
    return record;
  }

  function mirror(record) {
    return record.mirrorKey ? issues.get(record.mirrorKey) || null : null;
  }

  function scheduleMirror(record) {
    schedule(() => {
      if (!issues.has(record.key)) {
        return;
      }
      const copy = createRecord(otherProject(record.key), {
        summary: record.summary,
        description: record.description,
        statusName: record.statusName,
      });
      copy.comments = record.comments.map((comment) => ({
        id: `${comment.id}-mirror`,
        body: comment.body,
      }));
      record.mirrorKey = copy.key;
      copy.mirrorKey = record.key;
    });
  }

  function issuePayload(record, fields) {
    const requested = Array.isArray(fields) && fields.length > 0 ? fields : null;
    const body = { key: record.key, id: record.id, fields: {} };
    const include = (name) => requested === null || requested.includes(name);
    if (include('summary')) body.fields.summary = record.summary;
    if (include('description')) body.fields.description = record.description;
    if (include('status')) body.fields.status = { id: '1', name: record.statusName };
    if (include('issuetype')) {
      body.fields.issuetype = { id: record.issueTypeId, name: record.issueTypeName };
    }
    if (include('project')) body.fields.project = { key: record.projectKey };
    if (include('subtasks')) {
      body.fields.subtasks = [...issues.values()]
        .filter((entry) => entry.parentKey === record.key)
        .map((entry) => ({
          id: entry.id,
          key: entry.key,
          fields: { summary: entry.summary, issuetype: { id: entry.issueTypeId, name: entry.issueTypeName } },
        }));
    }
    if (include('created')) body.fields.created = new Date(FIXED_NOW).toISOString();
    if (include('updated')) body.fields.updated = new Date(FIXED_NOW).toISOString();
    return body;
  }

  /**
   * Test-only helper that attaches an issue the E2E run does not own, so
   * cascading cleanup is observable.
   */
  function addSubtask(parentKey, childKey) {
    const parent = issues.get(parentKey);
    if (!parent) {
      throw new Error(`Cannot attach a subtask to unknown issue ${parentKey}.`);
    }
    const [projectKey, number] = String(childKey).split('-');
    const record = {
      key: String(childKey),
      id: `9${number}`,
      projectKey,
      summary: 'unrelated subtask created by another user',
      description: null,
      statusName: 'To Do',
      issueTypeId: '10002',
      issueTypeName: 'Sub-task',
      parentKey,
      subtask: true,
      comments: [],
      mirrorKey: null,
    };
    issues.set(record.key, record);
    return record;
  }

  const transitionsByStatus = {
    'To Do': [
      { id: '11', name: 'Start Progress', to: 'In Progress' },
      { id: '21', name: 'Finish', to: 'Done' },
    ],
    'In Progress': [
      { id: '31', name: 'Finish', to: 'Done' },
      { id: '41', name: 'Stop Progress', to: 'To Do' },
    ],
    Done: [{ id: '51', name: 'Reopen', to: 'To Do' }],
  };

  function json(status, body) {
    return { status, headers: {}, body };
  }

  function notFound(message) {
    return json(404, { errorMessages: [message] });
  }

  function parseJql(jql) {
    const project = /project\s*=\s*"([A-Z][A-Z0-9_]*)"/.exec(jql || '');
    const marker = /summary\s*~\s*"([^"]+)"/.exec(jql || '');
    return {
      projectKey: project ? project[1] : null,
      marker: marker ? marker[1] : null,
    };
  }


  function handle(url, init = {}) {
    runPending();
    const method = String(init.method || 'GET').toUpperCase();
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    requests.push({ method, pathname, query: parsed.search });
    if (method !== 'GET') {
      mutations.push({ method, pathname });
      // The hook runs after the attempt is recorded, so a test can prove how
      // many attempts the transport actually received, and it may answer the
      // attempt itself (for example with a rate-limit response).
      if (beforeMutation) {
        const override = beforeMutation({
          method,
          pathname,
          attempt: mutations.length,
          query: parsed.searchParams,
        });
        if (override) {
          return override;
        }
      }
    }

    if (method === 'GET' && pathname === '/rest/api/3/myself') {
      if (failMyself) {
        return json(failMyself.status || 401, failMyself.body || null);
      }
      return json(200, { accountId: 'acct-1', displayName: 'E2E Bot', active: true });
    }

    const projectMatch = /^\/rest\/api\/3\/project\/([A-Z][A-Z0-9_]*)$/.exec(pathname);
    if (method === 'GET' && projectMatch) {
      const project = projects[projectMatch[1]];
      return project
        ? json(200, { ...project, projectTypeKey: 'software' })
        : notFound('No project could be found with key.');
    }

    if (method === 'GET' && pathname === '/rest/api/3/mypermissions') {
      const names = String(parsed.searchParams.get('permissions') || '')
        .split(',')
        .filter(Boolean);
      const permissions = {};
      names.forEach((name) => {
        permissions[name] = { havePermission: true };
      });
      return json(200, { permissions });
    }

    const metaMatch = /^\/rest\/api\/3\/issue\/createmeta\/([A-Z][A-Z0-9_]*)\/issuetypes$/.exec(
      pathname
    );
    if (method === 'GET' && metaMatch) {
      if (metaPages) {
        const body = metaPages({ page: pageCounters.meta, query: parsed.searchParams });
        pageCounters.meta += 1;
        if (body) {
          return json(200, body);
        }
      }
      return json(200, {
        issueTypes: [{ id: '10001', name: 'Task', subtask: false }],
        isLast: true,
      });
    }

    if (method === 'GET' && pathname === '/rest/api/3/search/jql') {
      const { projectKey, marker } = parseJql(parsed.searchParams.get('jql'));
      if (!projectKey || !marker) {
        return json(400, { errorMessages: ['Unsupported JQL.'] });
      }
      const fields = String(parsed.searchParams.get('fields') || '')
        .split(',')
        .filter(Boolean);
      if (searchPages) {
        const body = searchPages({
          page: pageCounters.search,
          query: parsed.searchParams,
          projectKey,
          marker,
          payload: (record) => issuePayload(record, fields),
          matches: [...issues.values()].filter(
            (record) => record.projectKey === projectKey && record.summary.includes(marker)
          ),
        });
        pageCounters.search += 1;
        if (body) {
          return json(200, body);
        }
      }
      const matches = [...issues.values()].filter(
        (record) => record.projectKey === projectKey && record.summary.includes(marker)
      );
      return json(200, {
        issues: matches.map((record) => issuePayload(record, fields)),
        total: matches.length,
        isLast: true,
      });
    }

    if (method === 'POST' && pathname === '/rest/api/3/issue') {
      const fields = init.body?.fields || {};
      const projectKey = fields.project?.key;
      if (!projects[projectKey]) {
        return json(400, { errorMessages: ['project is required'] });
      }
      const record = createRecord(projectKey, {
        summary: fields.summary,
        description: fields.description || null,
      });
      scheduleMirror(record);
      if (afterCreate) {
        afterCreate(record, { addSubtask, issues });
      }
      return json(201, { id: record.id, key: record.key, self: `${url}/issue/${record.key}` });
    }


    const issueMatch = /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]*-[0-9]+)$/.exec(pathname);
    if (issueMatch) {
      const record = issues.get(issueMatch[1]);
      if (!record) {
        return notFound('Issue does not exist or you do not have permission to see it.');
      }

      if (method === 'GET') {
        const fields = String(parsed.searchParams.get('fields') || '')
          .split(',')
          .filter(Boolean);
        return json(200, issuePayload(record, fields));
      }

      if (method === 'PUT') {
        if (init.body?.fields?.description) {
          record.description = init.body.fields.description;
          schedule(() => {
            const copy = mirror(record);
            if (copy) {
              copy.description = record.description;
            }
          });
        }
        return json(204, undefined);
      }

      if (method === 'DELETE') {
        if (failDeleteKeys.has(record.key) || record.projectKey === failDeleteProject) {
          return json(500, { errorMessages: ['Delete failed.'] });
        }
        const children = [...issues.values()].filter((entry) => entry.parentKey === record.key);
        const cascade = parsed.searchParams.get('deleteSubtasks') === 'true';
        if (children.length > 0 && !cascade) {
          return json(400, {
            errorMessages: [`Issue ${record.key} has subtasks and deleteSubtasks is not set.`],
          });
        }
        if (cascade) {
          children.forEach((child) => {
            issues.delete(child.key);
            deletedKeys.push(child.key);
          });
        }
        issues.delete(record.key);
        deletedKeys.push(record.key);
        return json(204, undefined);
      }
    }

    const transitionsMatch = /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]*-[0-9]+)\/transitions$/.exec(
      pathname
    );
    if (transitionsMatch) {
      const record = issues.get(transitionsMatch[1]);
      if (!record) {
        return notFound('Issue does not exist.');
      }
      const available = transitionsByStatus[record.statusName] || [];
      if (method === 'GET') {
        return json(200, {
          transitions: available.map((entry) => ({
            id: entry.id,
            name: entry.name,
            to: { id: '9', name: entry.to },
          })),
        });
      }
      if (method === 'POST') {
        const wanted = String(init.body?.transition?.id || '');
        const chosen = available.find((entry) => entry.id === wanted);
        if (!chosen) {
          return json(400, { errorMessages: ['Transition is not valid.'] });
        }
        record.statusName = chosen.to;
        schedule(() => {
          const copy = mirror(record);
          if (copy) {
            copy.statusName = record.statusName;
          }
        });
        return json(204, undefined);
      }
    }

    const commentMatch = /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]*-[0-9]+)\/comment$/.exec(
      pathname
    );
    if (commentMatch) {
      const record = issues.get(commentMatch[1]);
      if (!record) {
        return notFound('Issue does not exist.');
      }
      if (method === 'GET') {
        if (commentPages) {
          const body = commentPages({
            page: pageCounters.comment,
            query: parsed.searchParams,
            record,
          });
          pageCounters.comment += 1;
          if (body) {
            return json(200, body);
          }
        }
        return json(200, {
          comments: record.comments,
          total: record.comments.length,
          startAt: 0,
          maxResults: 100,
        });
      }
      if (method === 'POST') {
        issueId += 1;
        const comment = { id: String(issueId), body: init.body?.body || null };
        record.comments.push(comment);
        schedule(() => {
          const copy = mirror(record);
          const mirrorId = `${comment.id}-mirror`;
          if (copy && !copy.comments.some((entry) => entry.id === mirrorId)) {
            copy.comments.push({ id: mirrorId, body: comment.body });
          }
        });
        return json(201, { id: comment.id });
      }
    }

    return notFound(`Unsupported endpoint ${method} ${pathname}`);
  }

  return {
    request: async (url, init) => handle(url, init),
    issues,
    requests,
    mutations,
    deletedKeys,
    addSubtask,
  };
}


const PLAN_EVIDENCE_FILE = 'artifacts/staging-e2e/readiness.json';

// The plan only stats the readiness bundle; a stub keeps tests off the disk.
const PLAN_FS = {
  lstatSync: () => ({
    isSymbolicLink: () => false,
    isFile: () => true,
    size: 2048,
  }),
};

function buildPlan(mode, overrides = {}) {
  const argv = mode === 'write' ? ['--write', '--no-report'] : ['--dry-run', '--no-report'];
  const plan = buildE2EPlan({
    argv,
    config: {
      ...runnerConfig(),
      e2e: {
        writeMode: mode === 'write' ? E2E_WRITE_CONFIRMATION : '',
        evidenceFile: PLAN_EVIDENCE_FILE,
      },
    },
    env: {},
    fsImpl: PLAN_FS,
    cwd: process.cwd(),
  });
  expect(plan.issues).toEqual([]);
  return {
    ...plan,
    settings: {
      ...plan.settings,
      ...runnerSettings({ mode: plan.mode }),
      ...overrides,
      evidencePath: null,
    },
  };
}

/**
 * Runs the E2E runner against the real fail-closed readiness gate.
 *
 * `options.adapter` simulates the future authenticated readiness adapter at the
 * module boundary (see the mock comment above), never through run options:
 *   - `{ facts: (facts) => {} }` binds that payload and treats it as verified;
 *   - `{ code: 'READINESS_...' }` simulates the adapter rejecting a payload.
 * Every other call gets `AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE`, which is
 * the only behavior production code can reach today.
 */
async function executeRun(options = {}) {
  const plan = options.plan || buildPlan(options.mode || 'dry-run', options.settings);
  const clock = virtualClock();
  const jira = options.jira || createFakeJira(options.fakeOptions);
  if (options.adapter && options.adapter.code) {
    adapterRejects(options.adapter.code);
  } else if (options.adapter) {
    adapterVerifies(options.adapter.facts);
  }
  const result = await runE2E({
    config: options.config || runnerConfig(),
    plan,
    evidence: options.evidence,
    interrupted: options.interrupted,
    signal: options.signal,
    configIssues: options.configIssues,
    request: jira.request,
    now: clock.now,
    sleep: clock.sleep,
    random: () => Buffer.from('cafebabecafebabe', 'hex'),
    runId: 'e2e-jest-run',
  });
  return { ...result, plan, jira };
}

describe('staging E2E opt-in configuration', () => {
  it('stays in dry-run mode when only the confirmation variable is set', () => {
    const plan = buildE2EPlan({
      argv: ['--dry-run'],
      config: {
        e2e: { writeMode: E2E_WRITE_CONFIRMATION, evidenceFile: PLAN_EVIDENCE_FILE },
      },
      env: {},
      fsImpl: PLAN_FS,
      cwd: process.cwd(),
    });

    expect(plan.issues).toEqual([]);
    expect(plan.mode).toBe('dry-run');
    expect(plan.writeAuthorized).toBe(false);
    expect(plan.settings.confirmations).toMatchObject({ flag: false, matched: true });
  });

  it('refuses --write without the exact confirmation value', () => {
    const plan = buildE2EPlan({
      argv: ['--write'],
      config: { e2e: { writeMode: 'yes-please' } },
      env: {},
      cwd: process.cwd(),
    });

    expect(plan.mode).toBe('dry-run');
    expect(plan.writeAuthorized).toBe(false);
    expect(plan.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['write-not-authorized'])
    );
  });

  it('authorizes write mode only when the flag and the confirmation agree', () => {
    const plan = buildE2EPlan({
      argv: ['--write'],
      config: {
        e2e: { writeMode: E2E_WRITE_CONFIRMATION, evidenceFile: PLAN_EVIDENCE_FILE },
      },
      env: {},
      fsImpl: PLAN_FS,
      cwd: process.cwd(),
    });

    expect(plan.issues).toEqual([]);
    expect(plan.mode).toBe('write');
    expect(plan.writeAuthorized).toBe(true);
  });

  it('rejects mutually exclusive flags', () => {
    const parsed = parseE2EArguments(['--write', '--dry-run']);
    expect(parsed.issues.map((entry) => entry.code)).toEqual(['conflicting-arguments']);
  });

  it('flags an unexpected confirmation value during a dry run', () => {
    const plan = buildE2EPlan({
      argv: ['--dry-run'],
      config: { e2e: { writeMode: 'I_UNDERSTAND', evidenceFile: PLAN_EVIDENCE_FILE } },
      env: {},
      fsImpl: PLAN_FS,
      cwd: process.cwd(),
    });

    expect(plan.mode).toBe('dry-run');
    expect(plan.issues.map((entry) => entry.code)).toEqual(['write-confirmation-invalid']);
  });

  it('rejects an absolute readiness evidence path', () => {
    const plan = buildE2EPlan({
      argv: ['--dry-run'],
      config: { e2e: { evidenceFile: '/tmp/readiness.json' } },
      env: {},
      cwd: process.cwd(),
    });

    expect(plan.issues.map((entry) => entry.code)).toEqual(['evidence-path-absolute']);
    expect(plan.settings.evidencePath).toBeNull();
  });
});

describe('staging E2E readiness evidence', () => {
  const settings = runnerSettings();

  async function evaluate(document, extra = {}) {
    return validateReadiness({
      document,
      config: runnerConfig(),
      settings: { ...settings, ...(extra.settings || {}) },
      now: () => FIXED_NOW,
      readiness: extra.readiness,
      readinessFailure: extra.readinessFailure,
    });
  }

  it('keeps the expected app id aligned with manifest.yml', () => {
    const manifest = fs.readFileSync(path.join(__dirname, '..', 'manifest.yml'), 'utf8');
    expect(manifest).toContain(EXPECTED_APP_ID);
  });

  it('selects the staging pair from operator claims without claiming verification', async () => {
    const readiness = await evaluate(readinessDocument(), { readiness: boundReadinessFacts() });
    // A payload the caller bound and passed in is still only a claim: the gate
    // never accepts readiness from run options, bound or not.
    expect(readiness.status).toBe('unknown');
    expect(readiness.summary.readinessBasis).toBe('unverified-claims');
    expect(readiness.summary.verification).toBeNull();
    expect(readiness.reasons.map((entry) => entry.code)).toContain(
      'readiness-verification-unsupported'
    );
    expect(readiness.summary.selected).toMatchObject({
      localProjectKey: 'STG',
      remoteProjectKey: 'RSTG',
      syncDirection: 'bidirectional',
    });
    expect(readiness.summary.syncComments).toBe(true);
  });

  it('blocks when the connector is paused', async () => {
    const readiness = await evaluate(
      readinessDocument((document) => {
        document.pause.paused = true;
      })
    );
    expect(readiness.status).toBe('blocked');
    expect(readiness.reasons.map((entry) => entry.code)).toContain('pause-active');
  });

  it('degrades to unknown when the bundle is stale', async () => {
    const readiness = await evaluate(
      readinessDocument((document) => {
        document.generatedAt = new Date(FIXED_NOW - 3 * 60 * 60 * 1000).toISOString();
      })
    );
    expect(readiness.status).toBe('unknown');
    expect(readiness.reasons.map((entry) => entry.code)).toContain('evidence-stale');
  });

  it('blocks when the bundle belongs to a different Forge app', async () => {
    const readiness = await evaluate(
      readinessDocument((document) => {
        document.connector.appId = 'ari:cloud:ecosystem::app/00000000-0000-0000-0000-000000000000';
      })
    );
    expect(readiness.status).toBe('blocked');
    expect(readiness.reasons.map((entry) => entry.code)).toContain('connector-app-mismatch');
  });

  it('blocks when the bundle carries credential-shaped material', async () => {
    const readiness = await evaluate(
      readinessDocument((document) => {
        document.apiToken = 'not-a-real-token';
      })
    );
    expect(readiness.status).toBe('blocked');
    expect(readiness.reasons.map((entry) => entry.code)).toContain(
      'evidence-contains-credentials'
    );
  });

  it('selects a push-only bundle from claims without a webhook receipt', async () => {
    const readiness = await evaluate(
      readinessDocument((document) => {
        document.organizations[0].syncDirection = 'push';
        document.organizations[0].features.syncComments = false;
        document.webhook = { configured: true, lastReceipt: null };
      })
    );
    expect(readiness.status).not.toBe('verified');
    expect(readiness.summary.selected.syncDirection).toBe('push');
    expect(readiness.summary.syncComments).toBe(false);
    expect(readiness.summary.webhook).toMatchObject({ configured: true, required: false });
    expect(readiness.reasons.map((entry) => entry.code)).toContain('webhook-unverified');
  });
});



describe('staging E2E write boundary', () => {
  function makeClient(overrides = {}) {
    const jira = createFakeJira();
    const client = new JiraWriteClient({
      site: siteConfig('local', ['STG']),
      label: 'local',
      email: 'bot-local@example.test',
      apiToken: 'token-placeholder',
      allowedProjectKeys: ['STG'],
      maxMutations: MAX_MUTATIONS_PER_RUN,
      maxRetries: 2,
      retryMaxWaitMs: 0,
      request: jira.request,
      now: () => FIXED_NOW,
      sleep: async () => {},
      ...overrides,
    });
    return { client, jira };
  }

  it('refuses endpoints outside the documented whitelist', async () => {
    const { client, jira } = makeClient();
    await expect(client._dispatch('DELETE', '/rest/api/3/project/STG')).rejects.toMatchObject({
      code: 'endpoint-not-allowed',
    });
    expect(jira.requests).toHaveLength(0);
  });

  it('refuses to create issues outside the staging project allow-list', async () => {
    const { client, jira } = makeClient();
    await expect(
      client.createIssue({
        projectKey: 'PROD',
        issueTypeId: '10001',
        summary: 'not allowed',
        description: textToAdf('not allowed'),
      })
    ).rejects.toMatchObject({ code: 'project-not-allowed' });
    expect(jira.requests).toHaveLength(0);
  });

  it('stops writing when the mutation budget is exhausted', async () => {
    const { client, jira } = makeClient({ maxMutations: 1 });
    const created = await client.createIssue({
      projectKey: 'STG',
      issueTypeId: '10001',
      summary: 'budget probe',
      description: textToAdf('budget probe'),
    });
    expect(created.key).toMatch(/^STG-\d+$/);

    await expect(
      client.addComment(created.key, textToAdf('second mutation'))
    ).rejects.toMatchObject({ code: 'mutation-budget-exhausted' });
    expect(client.mutations).toBe(1);
    expect(jira.mutations).toHaveLength(1);
    expect(client.remainingMutations()).toBe(0);
  });

  it('does not retry a create that failed with a 4xx response', async () => {
    let calls = 0;
    const client = new JiraWriteClient({
      site: siteConfig('local', ['STG']),
      label: 'local',
      email: 'bot-local@example.test',
      apiToken: 'token-placeholder',
      allowedProjectKeys: ['STG'],
      maxMutations: MAX_MUTATIONS_PER_RUN,
      maxRetries: 2,
      retryMaxWaitMs: 0,
      now: () => FIXED_NOW,
      sleep: async () => {},
      request: async () => {
        calls += 1;
        return { status: 400, headers: {}, body: { errorMessages: ['nope'] } };
      },
    });

    await expect(
      client.createIssue({
        projectKey: 'STG',
        issueTypeId: '10001',
        summary: 'rejected',
        description: textToAdf('rejected'),
      })
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toBe(1);
  });
});

describe('staging E2E polling helper', () => {
  it('returns as soon as the predicate is satisfied', async () => {
    const clock = virtualClock();
    let attempts = 0;
    const result = await pollUntil({
      check: async () => {
        attempts += 1;
        return attempts;
      },
      isDone: (value) => value >= 3,
      timeoutMs: 5000,
      maxAttempts: 10,
      initialDelayMs: 10,
      maxDelayMs: 20,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('stops at maxAttempts and reports a timeout', async () => {
    const clock = virtualClock();
    const result = await pollUntil({
      check: async () => 'never',
      isDone: () => false,
      timeoutMs: 60_000,
      maxAttempts: 4,
      initialDelayMs: 10,
      maxDelayMs: 10,
      now: clock.now,
      sleep: clock.sleep,
      describe: 'a state that never arrives',
    });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.attempts).toBe(4);
  });
});

describe('staging E2E runner', () => {
  it('blocks every scenario and sends no request without readiness evidence', async () => {
    const result = await executeRun({ mode: 'write' });

    expect(result.status).toBe('blocked');
    expect(result.exitCode).toBe(3);
    expect(result.report.summary.e2eVerified).toBe(false);
    expect(result.report.readiness.status).toBe('unknown');
    expect(result.report.scenarios.every((entry) => entry.status === 'skipped')).toBe(true);
    expect(result.report.scenarios[0].reason).toMatch(/readiness/i);
    expect(result.jira.requests).toHaveLength(0);
    expect(result.report.mutations.attempted).toBe(0);
    expect(() => validateReport(result.report)).not.toThrow();
  });

  it('blocks before any request when the readiness bundle is paused', async () => {
    const evidence = readinessDocument((document) => {
      document.pause.paused = true;
    });
    const result = await executeRun({ mode: 'write', evidence });

    expect(result.status).toBe('blocked');
    expect(result.report.readiness.status).toBe('blocked');
    expect(result.jira.requests).toHaveLength(0);
    expect(result.report.nextActions.length).toBeGreaterThan(0);
  });

  it('passes a dry run with verified readiness and still writes nothing', async () => {
    const result = await executeRun({ mode: 'dry-run', evidence: readinessDocument() });

    expect(result.status).toBe('pass');
    expect(result.exitCode).toBe(0);
    expect(result.report.summary.e2eVerified).toBe(false);
    expect(result.report.summary.verificationScope).toBe('dry-run');
    expect(result.report.summary.counts.skipped).toBe(7);
    expect(result.report.prerequisites.every((entry) => entry.status === 'pass')).toBe(true);
    expect(result.report.mutations.attempted).toBe(0);
    expect(result.jira.mutations).toHaveLength(0);
    expect(result.jira.deletedKeys).toHaveLength(0);
    expect(() => validateReport(result.report)).not.toThrow();

    const text = formatE2ETerminalReport(result.report);
    expect(text).toContain('PASS');
    expect(text).toContain('dry run');
    expect(text).toContain(result.report.runId);
  });

  it('blocks a write run whose plan never authorized writing', async () => {
    const plan = buildPlan('write');
    const forged = {
      ...plan,
      writeAuthorized: false,
      settings: { ...plan.settings, mode: 'write' },
    };
    const result = await executeRun({ plan: forged, evidence: readinessDocument() });

    expect(result.status).toBe('blocked');
    expect(result.report.summary.e2eVerified).toBe(false);
    expect(result.jira.mutations).toHaveLength(0);
    expect(result.report.scenarios.every((entry) => entry.status === 'skipped')).toBe(true);
  });
});

describe('staging E2E write execution', () => {
  it('verifies a bidirectional write run and cleans up every fixture', async () => {
    const result = await executeRun({
      mode: 'write',
      evidence: readinessDocument(),
      adapter: {},
    });

    expect(result.status).toBe('pass');
    expect(result.exitCode).toBe(0);
    expect(result.report.summary.e2eVerified).toBe(true);
    expect(result.report.summary.writeVerified).toBe(true);
    expect(result.report.summary.verificationScope).toBe('live-write');
    expect(result.report.summary.counts).toMatchObject({ total: 7, pass: 7, fail: 0 });

    expect(result.report.fixtures).toHaveLength(4);
    expect(result.report.fixtures.map((entry) => entry.role).sort()).toEqual([
      'local',
      'local',
      'remote',
      'remote',
    ]);
    expect(result.report.fixtures.every((entry) => entry.cleanup.status === 'deleted')).toBe(true);
    expect(result.jira.deletedKeys).toHaveLength(4);
    expect([...result.jira.issues.keys()]).toEqual([]);

    expect(result.report.mutations.attempted).toBeGreaterThan(0);
    expect(result.report.mutations.attempted).toBeLessThanOrEqual(
      result.report.mutations.budget
    );
    expect(result.report.mutations.budget).toBe(MAX_MUTATIONS_PER_RUN);
    expect(() => validateReport(result.report)).not.toThrow();
  });

  it('skips reverse scenarios for push-only synchronization without failing them', async () => {
    const evidence = readinessDocument((document) => {
      document.organizations[0].syncDirection = 'push';
      document.organizations[0].features.syncComments = false;
      document.webhook = { configured: true, lastReceipt: null };
    });
    const result = await executeRun({
      mode: 'write',
      evidence,
      adapter: {
        facts: (facts) => {
          facts.mappings[0].syncDirection = 'push';
          facts.mappings[0].syncComments = false;
          facts.webhook = { configured: true, lastReceiptAt: null };
        },
      },
    });

    expect(result.status).toBe('pass');
    const byId = new Map(result.report.scenarios.map((entry) => [entry.id, entry]));
    expect(byId.get('local-issue-created-and-synced').status).toBe('pass');
    expect(byId.get('remote-issue-created-and-synced').status).toBe('skipped');
    expect(byId.get('remote-issue-created-and-synced').required).toBe(false);
    expect(byId.get('public-comment-propagates').status).toBe('skipped');
    expect(result.report.summary.e2eVerified).toBe(true);
    expect(result.report.fixtures).toHaveLength(2);
  });

  it('fails the run when a fixture cannot be deleted', async () => {
    const jira = createFakeJira({ failDeleteProject: 'RSTG' });
    const result = await executeRun({
      mode: 'write',
      evidence: readinessDocument(),
      adapter: {},
      jira,
    });

    expect(result.status).toBe('fail');
    expect(result.exitCode).toBe(1);
    expect(result.report.summary.e2eVerified).toBe(false);
    expect(result.report.summary.cleanupFailures).toHaveLength(2);
    expect(result.report.nextActions.join(' ')).toMatch(/Delete run-owned remote issue/);
    expect(() => validateReport(result.report)).not.toThrow();
  });
});

describe('staging E2E report', () => {
  it('refuses a dry-run report that claims live verification', async () => {
    const result = await executeRun({ mode: 'dry-run', evidence: readinessDocument() });
    const tampered = JSON.parse(JSON.stringify(result.report));
    tampered.summary.e2eVerified = true;

    expect(() => validateReport(tampered)).toThrow(/dry run cannot claim/i);
  });

  it('refuses reports that carry credential material', async () => {
    const result = await executeRun({ mode: 'dry-run', evidence: readinessDocument() });
    const tampered = JSON.parse(JSON.stringify(result.report));
    tampered.config.issueType = 'Basic dGVzdDp0ZXN0';

    expect(() => validateReport(tampered)).toThrow(/authorization header/i);
  });

  it('writes private run and latest reports', async () => {
    const result = await executeRun({ mode: 'dry-run', evidence: readinessDocument() });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-e2e-report-'));

    const written = writeE2EReport({
      report: result.report,
      cwd,
      dir: 'artifacts/staging-e2e',
    });

    expect(written.dir).toBe(path.join(cwd, 'artifacts', 'staging-e2e'));
    expect(path.basename(written.latestPath)).toBe(E2E_LATEST_REPORT_NAME);
    expect(written.runPath).toBe(path.join(written.dir, `${result.report.runId}.json`));

    expect(fs.statSync(written.dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(written.runPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(written.latestPath).mode & 0o777).toBe(0o600);

    const persisted = JSON.parse(fs.readFileSync(written.latestPath, 'utf8'));
    expect(persisted.kind).toBe(E2E_REPORT_KIND);
    expect(persisted.runId).toBe(result.report.runId);
  });
});

describe('staging E2E polling timeout budget', () => {
  it('never sleeps past the timeout budget', async () => {
    const clock = virtualClock();
    let slept = 0;
    const result = await pollUntil({
      check: async () => null,
      isDone: () => false,
      timeoutMs: 25,
      maxAttempts: 100,
      initialDelayMs: 10,
      maxDelayMs: 40,
      now: clock.now,
      sleep: async (ms) => {
        slept += 1;
        clock.sleep(ms);
      },
    });

    expect(result.ok).toBe(false);
    expect(slept).toBeGreaterThan(0);
    expect(clock.now() - FIXED_NOW).toBeLessThanOrEqual(25 + 40);
  });
});

/**
 * Defect 1: an operator-written readiness document is a claim, not proof. Only
 * an authenticated connector interface may mark connector facts VERIFIED.
 */
describe('staging E2E readiness trust boundary', () => {
  async function evaluate(document, extra = {}) {
    return validateReadiness({
      document,
      config: runnerConfig(),
      settings: runnerSettings(),
      now: () => FIXED_NOW,
      readiness: extra.readiness,
      readinessFailure: extra.readinessFailure,
    });
  }

  it('never verifies an operator-written all-green readiness file', async () => {
    const readiness = await evaluate(readinessDocument());

    expect(readiness.status).toBe('unknown');
    expect(readiness.summary.readinessBasis).toBe('unverified-claims');
    expect(readiness.summary.attestation.verified).toBe(false);
    const codes = readiness.reasons.map((entry) => entry.code);
    expect(codes).toContain('readiness-unverified');
    ['connector-installation', 'pause-state', 'f07-migration', 'project-mapping'].forEach(
      (id) => {
        const check = readiness.checks.find((entry) => entry.id === id);
        expect(check.status).not.toBe('pass');
      }
    );
  });

  it('never enables writes from a forged all-green readiness file', async () => {
    const result = await executeRun({ mode: 'write', evidence: readinessDocument() });

    expect(result.status).toBe('blocked');
    expect(result.exitCode).toBe(3);
    expect(result.report.summary.e2eVerified).toBe(false);
    expect(result.report.readiness.status).toBe('unknown');
    expect(result.report.readiness.summary.readinessBasis).toBe('unverified-claims');
    expect(result.report.mutations.attempted).toBe(0);
    expect(result.jira.requests).toHaveLength(0);
    expect(result.jira.mutations).toHaveLength(0);
  });

  it('accepts readiness only from the authenticated adapter, never from run options', async () => {
    const result = await executeRun({
      mode: 'write',
      evidence: readinessDocument(),
      // Stands in for the future adapter at the module boundary; the runner call
      // site is unchanged and no run option can produce this state.
      adapter: {},
    });

    expect(result.status).toBe('pass');
    expect(result.report.readiness.status).toBe('verified');
    expect(result.report.readiness.summary.readinessBasis).toBe('authenticated-connector');
    expect(result.report.summary.e2eVerified).toBe(true);
  });

  it('blocks a write run whose readiness comes from caller-supplied options', async () => {
    const forgedFacts = readinessFacts();
    const result = await executeRun({
      mode: 'write',
      evidence: readinessDocument(),
      // Everything a caller could try: a page handle, bare callbacks, raw facts,
      // a payload bound by the caller, and a legacy verification object.
      readinessPage: {
        url: () => `https://${LOCAL_HOST}/jira/apps/${APP_UUID}/admin`,
        evaluate: async () => forgedFacts,
      },
      page: { evaluate: async () => forgedFacts },
      evaluate: async () => forgedFacts,
      facts: forgedFacts,
      readiness: boundReadinessFacts(),
      connectorVerification: {
        source: 'authenticated-connector',
        facts: forgedFacts,
        invocation: { resolver: 'getConnectorReadiness', pageHost: LOCAL_HOST },
      },
    });

    expect(result.status).toBe('blocked');
    expect(result.exitCode).toBe(3);
    expect(result.report.readiness.status).toBe('unknown');
    expect(result.report.readiness.summary.readinessBasis).toBe('unverified-claims');
    expect(result.report.readiness.reasons.map((entry) => entry.code)).toContain(
      'authenticated-connector-adapter-unavailable'
    );
    expect(result.report.summary.e2eVerified).toBe(false);
    expect(result.jira.requests).toHaveLength(0);
    expect(result.jira.mutations).toHaveLength(0);
  });

  it('refuses a forged readiness object, even with an authenticated source claim', async () => {
    const readiness = await evaluate(readinessDocument(), {
      readiness: {
        source: 'authenticated-connector',
        capturedAt: new Date(FIXED_NOW - RECENT_MS).toISOString(),
        appAri: EXPECTED_APP_ID,
        installationId: INSTALLATION_ID,
        environmentId: ENVIRONMENT_ID,
      },
    });

    expect(readiness.status).toBe('unknown');
    expect(readiness.reasons.map((entry) => entry.code)).toContain(
      'readiness-verification-unsupported'
    );
  });

  it('treats a ready-looking adapter payload as unknown while no adapter exists', async () => {
    const readiness = await evaluate(readinessDocument(), {
      readiness: boundReadinessFacts((facts) => {
        facts.capturedAt = new Date(FIXED_NOW - 3 * 60 * 60 * 1000).toISOString();
      }),
    });

    expect(readiness.status).toBe('unknown');
    expect(readiness.summary.readinessBasis).toBe('unverified-claims');
    expect(readiness.reasons.map((entry) => entry.code)).toContain(
      'readiness-verification-unsupported'
    );
  });

  it('ignores a legacy verification object and never authorizes a write', async () => {
    const result = await executeRun({
      mode: 'write',
      evidence: readinessDocument(),
      // The removed test-only constructor is no longer a runner option. A
      // caller that still passes one gets unverified claims, not a write.
      connectorVerification: {
        source: 'authenticated-connector',
        facts: { appAri: EXPECTED_APP_ID, installationId: INSTALLATION_ID },
        invocation: { resolver: 'getConnectorReadiness', pageHost: LOCAL_HOST },
      },
    });

    expect(result.status).toBe('blocked');
    expect(result.exitCode).toBe(3);
    expect(result.report.readiness.status).toBe('unknown');
    expect(result.report.readiness.summary.readinessBasis).toBe('unverified-claims');
    expect(result.jira.requests).toHaveLength(0);
    expect(result.jira.mutations).toHaveLength(0);
  });

  it('blocks evidence the adapter binds to a previous installation', async () => {
    const result = await executeRun({
      mode: 'write',
      evidence: readinessDocument(),
      adapter: { code: 'READINESS_INSTALLATION_MISMATCH' },
    });

    expect(result.status).toBe('blocked');
    expect(result.exitCode).toBe(3);
    expect(result.report.readiness.status).toBe('blocked');
    expect(result.report.readiness.reasons.map((entry) => entry.code)).toContain(
      'readiness-verification-failed'
    );
    expect(result.jira.requests).toHaveLength(0);
    expect(result.jira.mutations).toHaveLength(0);
  });

  it('blocks evidence the adapter binds to a different Forge environment', async () => {
    const result = await executeRun({
      mode: 'write',
      evidence: readinessDocument(),
      adapter: { code: 'READINESS_ENVIRONMENT_ID_MISMATCH' },
    });

    expect(result.status).toBe('blocked');
    expect(result.report.readiness.status).toBe('blocked');
    expect(result.report.readiness.reasons.map((entry) => entry.code)).toContain(
      'readiness-verification-failed'
    );
    expect(result.jira.mutations).toHaveLength(0);
  });

  it('does not dispatch a caller-supplied evaluate callback', async () => {
    const evaluateSpy = jest.fn(async () => readinessFacts());
    const result = await executeRun({
      mode: 'write',
      evidence: readinessDocument(),
      readinessPage: { evaluate: evaluateSpy },
      page: { evaluate: evaluateSpy },
    });

    expect(evaluateSpy).not.toHaveBeenCalled();
    expect(result.status).toBe('blocked');
    expect(result.report.readiness.status).toBe('unknown');
    expect(result.jira.requests).toHaveLength(0);
    expect(result.jira.mutations).toHaveLength(0);
  });
});


/**
 * Defect 2: the connector runs on the local Jira site. Remote readiness is a
 * Jira REST connection plus webhook delivery, never a second installation.
 */
describe('staging E2E connector topology', () => {
  async function evaluate(document) {
    return validateReadiness({
      document,
      config: runnerConfig(),
      settings: runnerSettings(),
      now: () => FIXED_NOW,
    });
  }

  it('does not require a second Forge installation on the remote site', async () => {
    const readiness = await evaluate(
      readinessDocument((document) => {
        document.connector.installedSites = [LOCAL_HOST];
      })
    );

    // Claims-only: topology is read from the bundle, so the run stays unverified
    // while the remote site is still never treated as a second installation.
    expect(readiness.status).not.toBe('verified');
    expect(readiness.summary.remoteInstallationRequired).toBe(false);
    expect(readiness.reasons.map((entry) => entry.code)).not.toContain(
      'connector-site-not-installed'
    );
  });

  it('blocks when the local site has no connector installation', async () => {
    const readiness = await evaluate(
      readinessDocument((document) => {
        document.connector.installedSites = [REMOTE_HOST];
      })
    );

    expect(readiness.status).toBe('blocked');
    expect(readiness.reasons.map((entry) => entry.code)).toContain('connector-site-not-installed');
  });

  it('keeps remote webhook readiness a separate, unverified requirement', async () => {
    const readiness = await evaluate(readinessDocument());

    expect(readiness.status).toBe('unknown');
    expect(readiness.summary.webhook).toMatchObject({ configured: true, required: true });
    expect(readiness.reasons.map((entry) => entry.code)).toContain('webhook-unverified');
  });
});


/**
 * Defect 3: an interruption must stop new scenario writes and be reported as
 * INTERRUPTED by both the terminal output and the persisted report.
 */
describe('staging E2E interruption', () => {
  it('starts no further scenario write after an interruption', async () => {
    let interrupted = false;
    const jira = createFakeJira({
      afterCreate: () => {
        interrupted = true;
      },
    });

    const result = await executeRun({
      mode: 'write',
      evidence: readinessDocument(),
      adapter: {},
      interrupted: () => interrupted,
      jira,
    });

    expect(result.status).toBe('interrupted');
    expect(result.exitCode).toBe(2);
    expect(result.report.summary.status).toBe('interrupted');
    expect(result.report.summary.exitCode).toBe(2);
    expect(result.report.summary.e2eVerified).toBe(false);
    expect(result.report.interruption).toMatchObject({ interrupted: true });

    // Only the first create may reach Jira as a scenario write: no update,
    // transition, comment or reverse-direction create. The sole delete is the
    // bounded, run-owned cleanup of the fixture just created.
    const scenarioWrites = result.jira.mutations
      .filter((entry) => entry.method !== 'DELETE')
      .map((entry) => `${entry.method} ${entry.pathname}`);
    expect(scenarioWrites).toEqual(['POST /rest/api/3/issue']);
    expect(
      result.jira.mutations
        .filter((entry) => entry.method === 'DELETE')
        .map((entry) => entry.pathname)
    ).toEqual(['/rest/api/3/issue/STG-1']);

    const created = result.report.scenarios.find(
      (entry) => entry.id === 'local-issue-created-and-synced'
    );
    expect(
      created.assertions.some((entry) => entry.id === 'source-create' && entry.status === 'pass')
    ).toBe(true);
    expect(created.status).not.toBe('pass');
    expect(result.report.scenarios.some((entry) => entry.status === 'pass')).toBe(false);

    // The run-owned fixture is still accounted for, so cleanup and evidence
    // survive the interruption.
    expect(result.report.fixtures.map((entry) => entry.key)).toEqual(['STG-1']);
    expect(result.report.fixtures[0].cleanup.status).toBe('deleted');

    const text = formatE2ETerminalReport(result.report);
    expect(text).toContain('INTERRUPTED');
    expect(text).not.toContain('Staging E2E PASS');
    expect(() => validateReport(result.report)).not.toThrow();
  });

  it('honours an AbortSignal as the cancellation signal', async () => {
    const controller = new AbortController();
    const jira = createFakeJira({
      afterCreate: () => controller.abort(),
    });

    const result = await executeRun({
      mode: 'write',
      evidence: readinessDocument(),
      adapter: {},
      signal: controller.signal,
      jira,
    });

    expect(result.status).toBe('interrupted');
    expect(result.exitCode).toBe(2);
    expect(result.report.summary.status).toBe('interrupted');
    const scenarioWrites = result.jira.mutations
      .filter((entry) => entry.method !== 'DELETE')
      .map((entry) => `${entry.method} ${entry.pathname}`);
    expect(scenarioWrites).toEqual(['POST /rest/api/3/issue']);
    expect(result.report.summary.e2eVerified).toBe(false);
  });

  it('persists an interrupted report that says INTERRUPTED', async () => {
    let interrupted = false;
    const jira = createFakeJira({
      afterCreate: () => {
        interrupted = true;
      },
    });

    const result = await executeRun({
      mode: 'write',
      evidence: readinessDocument(),
      adapter: {},
      interrupted: () => interrupted,
      jira,
    });

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-e2e-interrupted-'));
    const written = writeE2EReport({
      report: result.report,
      cwd,
      dir: 'artifacts/staging-e2e',
      secrets: ['token-local-placeholder', 'token-remote-placeholder'],
    });
    const persisted = JSON.parse(fs.readFileSync(written.latestPath, 'utf8'));

    expect(persisted.summary.status).toBe('interrupted');
    expect(persisted.summary.exitCode).toBe(2);
    expect(persisted.summary.e2eVerified).toBe(false);
    expect(persisted.interruption).toMatchObject({ interrupted: true });
    expect(formatE2ETerminalReport(persisted)).toContain('INTERRUPTED');
  });

  it('marks a run interrupted before the first mutation as interrupted', async () => {
    const result = await executeRun({
      mode: 'write',
      evidence: readinessDocument(),
      adapter: {},
      interrupted: () => true,
    });

    expect(result.status).toBe('interrupted');
    expect(result.exitCode).toBe(2);
    expect(result.jira.mutations).toHaveLength(0);
    expect(result.report.summary.e2eVerified).toBe(false);
    expect(() => validateReport(result.report)).not.toThrow();
  });
});

/**
 * Cancellation must reach the transport itself. A 429 on a write is the one
 * retryable POST response, so an operator signal that lands while the client is
 * sleeping before the retry must stop the retry rather than send it.
 */
describe('staging E2E cancellation at the transport', () => {
  function createSignalController() {
    const state = { signal: null };
    return {
      interrupted: () => state.signal !== null,
      signal: () => state.signal,
      interrupt(value) {
        if (state.signal === null) {
          state.signal = value;
        }
        return state.signal;
      },
    };
  }

  const rateLimited = {
    status: 429,
    headers: { 'retry-after': '0' },
    body: { errorMessages: ['Rate limit exceeded.'] },
  };

  it.each(['SIGINT', 'SIGTERM'])(
    'does not retry the first issue create after %s',
    async (signal) => {
      const controller = createSignalController();
      const jira = createFakeJira({
        beforeMutation: () => {
          controller.interrupt(signal);
          return rateLimited;
        },
      });

      const result = await executeRun({
        mode: 'write',
        config: runnerConfig({ maxRetries: 1 }),
        evidence: readinessDocument(),
        adapter: {},
        interrupted: controller.interrupted,
        jira,
      });

      // The retry the client would otherwise send after Retry-After: 0 must not
      // reach Jira, and no later scenario write may start either.
      expect(
        jira.mutations.map((entry) => `${entry.method} ${entry.pathname}`)
      ).toEqual(['POST /rest/api/3/issue']);
      expect(
        jira.requests.filter(
          (entry) => entry.method === 'POST' && entry.pathname === '/rest/api/3/issue'
        )
      ).toHaveLength(1);
      expect(jira.deletedKeys).toEqual([]);

      expect(controller.signal()).toBe(signal);
      expect(result.status).toBe('interrupted');
      expect(result.exitCode).toBe(2);
      expect(result.report.summary.status).toBe('interrupted');
      expect(result.report.summary.exitCode).toBe(2);
      expect(result.report.summary.e2eVerified).toBe(false);
      expect(result.report.interruption).toMatchObject({ interrupted: true });
      expect(result.report.scenarios.some((entry) => entry.status === 'pass')).toBe(false);
      expect(formatE2ETerminalReport(result.report)).toContain('INTERRUPTED');
      expect(() => validateReport(result.report)).not.toThrow();
    }
  );

  it('stops retrying a description update and still cleans up the run-owned fixture', async () => {
    const controller = createSignalController();
    const jira = createFakeJira({
      beforeMutation: ({ method, pathname }) => {
        if (method === 'PUT' && pathname === '/rest/api/3/issue/STG-1') {
          controller.interrupt('SIGTERM');
          return rateLimited;
        }
        return null;
      },
    });

    const result = await executeRun({
      mode: 'write',
      config: runnerConfig({ maxRetries: 1 }),
      evidence: readinessDocument(),
      adapter: {},
      interrupted: controller.interrupted,
      jira,
    });

    // The guard sits on the shared mutation transport, so it covers updates and
    // not only issue creation: one create, one update attempt, no retry, and no
    // transition, comment or reverse-direction create afterwards.
    expect(jira.mutations.map((entry) => `${entry.method} ${entry.pathname}`)).toEqual([
      'POST /rest/api/3/issue',
      'PUT /rest/api/3/issue/STG-1',
      'DELETE /rest/api/3/issue/RSTG-1',
      'DELETE /rest/api/3/issue/STG-1',
    ]);
    expect(
      jira.requests.filter(
        (entry) => entry.method === 'PUT' && entry.pathname === '/rest/api/3/issue/STG-1'
      )
    ).toHaveLength(1);

    // Cleanup stays a separate, bounded, ownership-aware operation: it deletes
    // exactly the fixtures this run owns (the created issue and its mirrored
    // counterpart) and never asks Jira to cascade.
    expect(jira.deletedKeys).toEqual(['RSTG-1', 'STG-1']);
    expect(
      jira.requests
        .filter((entry) => entry.method === 'DELETE')
        .every((entry) => !String(entry.query).includes('deleteSubtasks'))
    ).toBe(true);

    expect(result.status).toBe('interrupted');
    expect(result.exitCode).toBe(2);
    expect(result.report.summary.status).toBe('interrupted');
    expect(result.report.summary.exitCode).toBe(2);
    expect(result.report.summary.e2eVerified).toBe(false);
    expect(result.report.fixtures.map((entry) => entry.key).sort()).toEqual(['RSTG-1', 'STG-1']);
    expect(result.report.fixtures.every((entry) => entry.cleanup.status === 'deleted')).toBe(true);
    // The create scenario completed before the signal; the update that was
    // cancelled must not be recorded as a pass, and nothing after it ran.
    const updated = result.report.scenarios.find((entry) => entry.id === 'field-update-propagates');
    expect(updated.status).not.toBe('pass');
    expect(result.report.scenarios.filter((entry) => entry.status === 'pass')).toHaveLength(1);
    expect(result.report.scenarios.find((entry) => entry.id === 'remote-issue-created-and-synced').status).toBe(
      'skipped'
    );
    expect(formatE2ETerminalReport(result.report)).toContain('INTERRUPTED');
    expect(() => validateReport(result.report)).not.toThrow();
  });

  it('still retries a rate-limited write when the run is not interrupted', async () => {
    let createAttempts = 0;
    const jira = createFakeJira({
      beforeMutation: ({ method, pathname }) => {
        if (method === 'POST' && pathname === '/rest/api/3/issue' && createAttempts === 0) {
          createAttempts += 1;
          return rateLimited;
        }
        return null;
      },
    });

    const result = await executeRun({
      mode: 'write',
      config: runnerConfig({ maxRetries: 1 }),
      evidence: readinessDocument(),
      adapter: {},
      jira,
    });

    // Ordinary retry behavior is unchanged: the second attempt creates the
    // issue and the run completes and cleans up as usual.
    expect(
      jira.requests.filter(
        (entry) => entry.method === 'POST' && entry.pathname === '/rest/api/3/issue'
      ).length
    ).toBeGreaterThanOrEqual(2);
    expect(result.status).toBe('pass');
    expect(result.exitCode).toBe(0);
    expect(result.report.summary.e2eVerified).toBe(true);
    expect(result.report.summary.counts.fail).toBe(0);
    expect(jira.deletedKeys.length).toBeGreaterThanOrEqual(1);
  });
});

/**
 * Defect 4: credentials echoed by Jira must never reach the terminal, the JSON
 * output or the persisted report.
 */
describe('staging E2E secret redaction', () => {
  it('redacts a token and an account email echoed by a Jira error', async () => {
    const jira = createFakeJira({
      failMyself: {
        status: 401,
        body: {
          errorMessages: [
            'Unauthorized: token-local-placeholder rejected for bot-local@example.test',
          ],
        },
      },
    });

    const result = await executeRun({
      mode: 'dry-run',
      evidence: readinessDocument(),
      jira,
    });

    const serialized = JSON.stringify(result.report);
    expect(serialized).not.toContain('token-local-placeholder');
    expect(serialized).not.toContain('bot-local@example.test');
    expect(serialized).toMatch(/401/);
    expect(() => validateReport(result.report)).not.toThrow();

    const text = formatE2ETerminalReport(result.report);
    expect(text).not.toContain('token-local-placeholder');
    expect(text).not.toContain('bot-local@example.test');
  });

  it('refuses to persist a report that still carries a configured secret', async () => {
    const result = await executeRun({ mode: 'dry-run', evidence: readinessDocument() });
    const tampered = JSON.parse(JSON.stringify(result.report));
    tampered.nextActions = ['Rotate token-local-placeholder before the next run.'];

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-e2e-secret-'));
    expect(() =>
      writeE2EReport({
        report: tampered,
        cwd,
        dir: 'artifacts/staging-e2e',
        secrets: ['token-local-placeholder'],
      })
    ).toThrow(/credential material/i);
    expect(fs.existsSync(path.join(cwd, 'artifacts', 'staging-e2e'))).toBe(false);
  });
});


/**
 * Defect 5: pagination must follow the documented endpoint response format and
 * must never let a partial read satisfy a uniqueness or destination assertion.
 */
describe('staging E2E pagination completeness', () => {
  const JQL = 'project = "STG" AND summary ~ "marker" ORDER BY created ASC';

  function makeClient(options = {}) {
    const jira = createFakeJira(options);
    const client = new JiraWriteClient({
      site: siteConfig('local', ['STG']),
      label: 'local',
      email: 'bot-local@example.test',
      apiToken: 'token-local-placeholder',
      allowedProjectKeys: ['STG'],
      maxMutations: MAX_MUTATIONS_PER_RUN,
      maxRetries: 0,
      retryMaxWaitMs: 0,
      request: jira.request,
      now: () => FIXED_NOW,
      sleep: async () => {},
    });
    return { client, jira };
  }

  it('reports an incomplete search when a continuation token repeats', async () => {
    const { client } = makeClient({
      searchPages: () => ({ issues: [], nextPageToken: 'tok-1', isLast: false }),
    });

    const page = await client.searchIssues(JQL);
    expect(page.complete).toBe(false);
    expect(page.reason).toBe('pagination-token-repeated');
  });

  it('reports an incomplete search when continuation is advertised without a token', async () => {
    const { client } = makeClient({
      searchPages: () => ({ issues: [], nextPageToken: null, isLast: false }),
    });

    const page = await client.searchIssues(JQL);
    expect(page.complete).toBe(false);
    expect(page.reason).toBe('pagination-stalled');
  });

  it('reports an incomplete search when the page cap is reached', async () => {
    const { client } = makeClient({
      searchPages: ({ page }) => ({
        issues: [],
        nextPageToken: `tok-${page + 1}`,
        isLast: false,
      }),
    });

    const page = await client.searchIssues(JQL);
    expect(page.complete).toBe(false);
    expect(page.reason).toBe('pagination-cap-reached');
  });

  it('reports an incomplete search when a page omits the issues array', async () => {
    const { client } = makeClient({
      searchPages: () => ({ nextPageToken: null, isLast: true }),
    });

    const page = await client.searchIssues(JQL);
    expect(page.complete).toBe(false);
    expect(page.reason).toBe('pagination-metadata-inconsistent');
  });

  it('reports only complete results for a well-formed token sequence', async () => {
    const { client } = makeClient();
    const created = await client.createIssue({
      projectKey: 'STG',
      issueTypeId: '10001',
      summary: 'marker page probe',
      description: textToAdf('marker page probe'),
    });

    const page = await client.searchIssues(JQL);
    expect(page.complete).toBe(true);
    expect(page.issues.map((entry) => entry.key)).toEqual([created.key]);
  });

  it('reports incomplete comment pages when the reported total is not reached', async () => {
    const { client } = makeClient({
      commentPages: ({ page }) => ({
        comments:
          page < 2
            ? [
                { id: `${page}-a`, body: null },
                { id: `${page}-b`, body: null },
              ]
            : [],
        total: 5,
        startAt: page * 2,
        maxResults: 2,
      }),
    });
    const created = await client.createIssue({
      projectKey: 'STG',
      issueTypeId: '10001',
      summary: 'comment page probe',
      description: textToAdf('comment page probe'),
    });

    const page = await client.getComments(created.key);
    expect(page.complete).toBe(false);
    expect(page.reason).toBe('pagination-empty-page');
    expect(page.comments).toHaveLength(4);
  });

  it('reports incomplete comment pages when the total changes between pages', async () => {
    const { client } = makeClient({
      commentPages: ({ page }) => ({
        comments: [{ id: `${page}-a`, body: null }],
        total: page === 0 ? 3 : 9,
        startAt: page,
        maxResults: 1,
      }),
    });
    const created = await client.createIssue({
      projectKey: 'STG',
      issueTypeId: '10001',
      summary: 'comment total probe',
      description: textToAdf('comment total probe'),
    });

    const page = await client.getComments(created.key);
    expect(page.complete).toBe(false);
    expect(page.reason).toBe('pagination-metadata-inconsistent');
  });

  it('reads every documented comment page', async () => {
    const { client } = makeClient({
      commentPages: ({ page }) => ({
        comments: [{ id: `${page}-a`, body: null }],
        total: 3,
        startAt: page,
        maxResults: 1,
      }),
    });
    const created = await client.createIssue({
      projectKey: 'STG',
      issueTypeId: '10001',
      summary: 'comment complete probe',
      description: textToAdf('comment complete probe'),
    });

    const page = await client.getComments(created.key);
    expect(page.complete).toBe(true);
    expect(page.comments.map((entry) => entry.id)).toEqual(['0-a', '1-a', '2-a']);
  });

  it('never passes the uniqueness scenario on incomplete search results', async () => {
    const jira = createFakeJira({
      searchPages: ({ matches, payload }) => ({
        issues: matches.map((record) => payload(record)),
        nextPageToken: 'tok-repeat',
        isLast: false,
      }),
    });

    const result = await executeRun({
      mode: 'write',
      evidence: readinessDocument(),
      adapter: {},
      jira,
    });

    const duplicate = result.report.scenarios.find(
      (entry) => entry.id === 'no-duplicate-counterparts'
    );
    const created = result.report.scenarios.find(
      (entry) => entry.id === 'local-issue-created-and-synced'
    );
    const counterpart = created.assertions.find((entry) => entry.id === 'counterpart-exists');
    expect(counterpart.status).toBe('unknown');
    expect(counterpart.detail).toMatch(/incomplete/i);
    expect(duplicate.status).not.toBe('pass');
    expect(duplicate.assertions.every((entry) => entry.status !== 'pass')).toBe(true);
    expect(result.report.summary.e2eVerified).toBe(false);
    expect(result.status).not.toBe('pass');
  });
});


/**
 * Defect 6: cleanup must never cascade-delete children the run does not own.
 */
describe('staging E2E cleanup ownership', () => {
  it('retains a run-owned parent whose child belongs to someone else', async () => {
    const jira = createFakeJira({
      afterCreate: (record, api) => {
        if (record.key === 'STG-1') {
          api.addSubtask(record.key, 'STG-999');
        }
      },
    });

    const result = await executeRun({
      mode: 'write',
      evidence: readinessDocument(),
      adapter: {},
      jira,
    });

    expect(result.jira.deletedKeys).not.toContain('STG-999');
    expect(result.jira.issues.has('STG-999')).toBe(true);

    const fixture = result.report.fixtures.find((entry) => entry.key === 'STG-1');
    expect(fixture.cleanup.status).toBe('retained-unowned-children');
    expect(fixture.cleanup.retainedChildren).toEqual(['STG-999']);
    expect(result.report.summary.cleanupFailures.map((entry) => entry.key)).toContain('STG-1');
    expect(result.report.summary.status).toBe('fail');
    expect(result.report.summary.e2eVerified).toBe(false);
    expect(result.report.nextActions.join(' ')).toMatch(/STG-999/);
    expect(() => validateReport(result.report)).not.toThrow();
  });

  it('never asks Jira to cascade a delete to subtasks', async () => {
    const jira = createFakeJira();
    const client = new JiraWriteClient({
      site: siteConfig('local', ['STG']),
      label: 'local',
      email: 'bot-local@example.test',
      apiToken: 'token-local-placeholder',
      allowedProjectKeys: ['STG'],
      maxMutations: MAX_MUTATIONS_PER_RUN,
      maxRetries: 0,
      retryMaxWaitMs: 0,
      request: jira.request,
      now: () => FIXED_NOW,
      sleep: async () => {},
    });
    const parent = await client.createIssue({
      projectKey: 'STG',
      issueTypeId: '10001',
      summary: 'parent with a child',
      description: textToAdf('parent with a child'),
    });
    jira.addSubtask(parent.key, 'STG-901');

    await expect(client.deleteIssue(parent.key)).rejects.toMatchObject({ status: 400 });
    expect(jira.issues.has('STG-901')).toBe(true);
    expect(jira.requests.every((entry) => !String(entry.query).includes('deleteSubtasks'))).toBe(
      true
    );
  });

  it('deletes run-owned children before their parent without cascading', async () => {
    const calls = [];
    const children = new Map([
      ['STG-1', ['STG-2']],
      ['STG-2', []],
    ]);
    const ctx = {
      settings: { cleanup: true },
      now: () => FIXED_NOW,
      warnings: [],
      fixtures: [
        { role: 'local', key: 'STG-1', marker: 'm1', ownership: 'run', cleanup: { status: 'pending', detail: null } },
        { role: 'local', key: 'STG-2', marker: 'm2', ownership: 'run', cleanup: { status: 'pending', detail: null } },
      ],
      clients: {
        local: {
          getIssueSubtasks: async (key) => ({
            known: true,
            subtasks: (children.get(key) || []).map((child) => ({ key: child })),
          }),
          deleteIssue: async (key, options) => {
            calls.push({ key, options });
            return { absent: false };
          },
        },
      },
    };

    await cleanupFixtures(ctx);

    expect(calls).toEqual([
      { key: 'STG-2', options: { force: true, allowInterrupted: true } },
      { key: 'STG-1', options: { force: true, allowInterrupted: true } },
    ]);
    expect(ctx.fixtures.every((entry) => entry.cleanup.status === 'deleted')).toBe(true);
  });
});
