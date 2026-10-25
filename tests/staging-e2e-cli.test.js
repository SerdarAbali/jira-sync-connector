/** @jest-environment node */
'use strict';

/**
 * Regression coverage for the operator-facing staging E2E CLI.
 *
 * Every test is offline: configuration is injected or built from a temporary
 * workspace, and the HTTP transport is replaced with a read-only fake Jira.
 * The write test never sends a request; it asserts that the authorization
 * decisions the CLI hands to `runE2E` are correct.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { USAGE, runCli } = require('../scripts/staging/lib/e2e-cli');
const { E2E_WRITE_CONFIRMATION } = require('../scripts/staging/lib/e2e-config');
const { EXPECTED_APP_ID } = require('../scripts/staging/lib/e2e-evidence');
const {
  bindReadinessResponse,
  readForgeAdminReadiness,
} = require('../scripts/staging/lib/forge-admin-readiness');
const { E2E_EXIT_CODES } = require('../scripts/staging/lib/e2e-runner');
const {
  E2E_LATEST_REPORT_NAME,
  E2E_PLAN_LATEST_NAME,
  E2E_PLAN_REPORT_KIND,
  E2E_REPORT_KIND,
  validatePlanReport,
  validateReport,
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
    apiToken: `placeholder-${role}-token`,
    stagingProjects: projects,
    nonStagingProjects: [],
  };
}

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-e2e-cli-'));
  const reportDir = path.join(dir, 'artifacts', 'staging-e2e');
  fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  return { dir, reportDir };
}

function stagingConfig(workspace, e2eOverrides = {}) {
  return {
    local: siteConfig('local', ['STG']),
    remote: siteConfig('remote', ['RSTG']),
    maxRetries: 0,
    retryMaxWaitMs: 0,
    requestTimeoutMs: 5000,
    e2e: {
      writeMode: '',
      evidenceFile: 'artifacts/staging-e2e/readiness.json',
      environment: 'staging',
      forgeInstallationId: INSTALLATION_ID,
      forgeEnvironmentId: ENVIRONMENT_ID,
      localProject: null,
      remoteProject: null,
      issueType: 'Task',
      evidenceMaxAgeMs: 15 * 60 * 1000,
      syncTimeoutMs: 500,
      pollIntervalMs: 10,
      pollMaxIntervalMs: 20,
      maxPolls: 3,
      duplicateSettleMs: 0,
      cleanup: true,
      reportDir: workspace.reportDir,
      reportDirLabel: 'artifacts/staging-e2e',
      ...e2eOverrides,
    },
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
 * The production readiness gate is fail-closed: no CLI flag, environment
 * variable, file or option can supply verified connector readiness, and
 * `readForgeAdminReadiness()` always rejects. These tests still need to exercise
 * the pass/blocked reporting paths, so they simulate the *future* authenticated
 * adapter at the module boundary only:
 *
 *  - the adapter resolver returns a payload the test bound to the expected app,
 *    installation, environment and site (`bindReadinessResponse`);
 *  - the readiness evaluator records that simulated adapter as verification.
 *
 * The CLI and runner call sites are unchanged. Tests that do not call
 * `adapterVerifies()` exercise the real fail-closed behavior.
 */
const mockReadinessAdapter = { mode: 'unavailable', facts: null };

jest.mock('../scripts/staging/lib/forge-admin-readiness', () => {
  const actual = jest.requireActual('../scripts/staging/lib/forge-admin-readiness');
  return {
    ...actual,
    readForgeAdminReadiness: jest.fn(async () => {
      if (mockReadinessAdapter.mode === 'verified') {
        return mockReadinessAdapter.facts;
      }
      const error = new Error('Simulated authenticated readiness adapter state.');
      error.code = actual.AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE;
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
            note: 'Simulated adapter verification: CLI tests only.',
          },
        },
      };
    },
  };
});

beforeEach(() => {
  mockReadinessAdapter.mode = 'unavailable';
  mockReadinessAdapter.facts = null;
  readForgeAdminReadiness.mockClear();
});

/** Payload a real authenticated adapter would return, before binding. */
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

/** Simulates the future authenticated adapter resolving verified readiness. */
function adapterVerifies(mutate) {
  mockReadinessAdapter.mode = 'verified';
  mockReadinessAdapter.facts = bindReadinessResponse(readinessFacts(mutate), {
    appAri: EXPECTED_APP_ID,
    appId: APP_UUID,
    installationId: INSTALLATION_ID,
    environmentId: ENVIRONMENT_ID,
    environmentType: 'staging',
    siteHost: LOCAL_HOST,
  });
}

function writeEvidence(workspace, document) {
  const file = path.join(workspace.dir, 'artifacts', 'staging-e2e', 'readiness.json');
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function capture() {
  const out = [];
  const err = [];
  return {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    outText: () => out.join(''),
    errText: () => err.join(''),
  };
}

function loadedConfig(config, issues = []) {
  return () => ({ config, issues });
}

function writeFileIn(workspace, name) {
  return path.join(workspace.reportDir, name);
}

/**
 * Report artifacts only: the readiness bundle lives in the same directory and
 * is not a report.
 */
function persistedReports(workspace) {
  return fs
    .readdirSync(workspace.reportDir)
    .filter((name) => name.startsWith('e2e-') || name.startsWith('latest'))
    .sort();
}

function json(body, status = 200) {
  return { status, headers: {}, body };
}

/**
 * Read-only Jira double: it answers only the endpoints `runE2E` prerequisites
 * use and records every call so a test can prove that no mutation was sent.
 */
function createReadOnlyJira(options = {}) {
  const calls = [];
  const denied = new Set(options.denied || []);
  const failMyself = options.failMyself || null;

  const request = async (urlString, init = {}) => {
    const url = new URL(urlString);
    const method = init.method || 'GET';
    calls.push({ method, pathname: url.pathname, origin: url.origin });
    const pathname = url.pathname;

    if (method !== 'GET') {
      return json({ errorMessages: ['The read-only fake rejects mutations.'] }, 405);
    }

    if (pathname === '/rest/api/3/myself') {
      if (failMyself) {
        return json(failMyself.body || null, failMyself.status || 401);
      }
      return json({ accountId: `acc-${url.origin}`, displayName: 'Bot', active: true });
    }

    const project = pathname.match(/^\/rest\/api\/3\/project\/([A-Za-z0-9]+)$/);
    if (project) {
      return json({
        id: project[1] === 'STG' ? '10000' : '10001',
        key: project[1],
        projectTypeKey: 'software',
      });
    }

    if (pathname === '/rest/api/3/mypermissions') {
      const names = String(url.searchParams.get('permissions') || '')
        .split(',')
        .filter(Boolean);
      const permissions = {};
      names.forEach((name) => {
        permissions[name] = { havePermission: !denied.has(name) };
      });
      return json({ permissions });
    }

    const meta = pathname.match(/^\/rest\/api\/3\/issue\/createmeta\/([A-Za-z0-9]+)\/issuetypes$/);
    if (meta) {
      return json({ issueTypes: [{ id: '10001', name: 'Task', subtask: false }], isLast: true });
    }

    return json({ errorMessages: [`Unexpected path ${pathname}`] }, 404);
  };

  return { request, calls };
}

/**
 * Write-enabled double for the cancellation regression. It answers the
 * prerequisite reads, then replies to the first issue-create POST with HTTP 429
 * and `Retry-After: 0` so the client would retry unless the cancellation reaches
 * the transport.
 */
function createRateLimitedJira(options = {}) {
  const calls = [];
  const state = { createAttempts: 0 };

  const request = async (urlString, init = {}) => {
    const url = new URL(urlString);
    const method = String(init.method || 'GET').toUpperCase();
    const pathname = url.pathname;
    calls.push({ method, pathname, query: url.search });

    if (method === 'GET' && pathname === '/rest/api/3/myself') {
      return json({ accountId: `acc-${url.origin}`, displayName: 'Bot', active: true });
    }

    if (method === 'GET' && /^\/rest\/api\/3\/project\/[A-Za-z0-9]+$/.test(pathname)) {
      return json({
        id: pathname.endsWith('STG') ? '10000' : '10001',
        key: pathname.split('/').pop(),
        projectTypeKey: 'software',
      });
    }

    if (method === 'GET' && pathname === '/rest/api/3/mypermissions') {
      const permissions = {};
      String(url.searchParams.get('permissions') || '')
        .split(',')
        .filter(Boolean)
        .forEach((name) => {
          permissions[name] = { havePermission: true };
        });
      return json({ permissions });
    }

    const meta = /^\/rest\/api\/3\/issue\/createmeta\/[A-Za-z0-9]+\/issuetypes$/.test(pathname);
    if (method === 'GET' && meta) {
      return json({ issueTypes: [{ id: '10001', name: 'Task', subtask: false }], isLast: true });
    }

    if (method === 'POST' && pathname === '/rest/api/3/issue') {
      state.createAttempts += 1;
      if (state.createAttempts === 1) {
        if (typeof options.onFirstCreate === 'function') {
          options.onFirstCreate();
        }
        return {
          status: 429,
          headers: { 'retry-after': '0' },
          body: { errorMessages: ['Rate limit exceeded.'] },
        };
      }
      return json({ id: '50001', key: 'STG-1' }, 201);
    }

    return json({ errorMessages: [`Unexpected ${method} ${pathname}`] }, 404);
  };

  return { request, calls, createAttempts: () => state.createAttempts };
}

describe('staging E2E CLI arguments', () => {
  it('prints usage for --help without reading configuration', async () => {
    const ui = capture();
    const loadConfig = jest.fn(() => {
      throw new Error('configuration must not be loaded for --help');
    });

    const result = await runCli({ argv: ['--help'], env: {}, loadConfig, ...ui });

    expect(result.exitCode).toBe(E2E_EXIT_CODES.PASS);
    expect(result.mode).toBe('help');
    expect(loadConfig).not.toHaveBeenCalled();
    expect(ui.outText()).toContain('Usage: node scripts/staging/e2e.js');
    expect(USAGE).toContain('--plan');
    expect(USAGE).toContain('STAGING_E2E_WRITE_MODE');
  });

  it('rejects an unknown argument before reading credentials', async () => {
    const ui = capture();
    const loadConfig = jest.fn(() => {
      throw new Error('configuration must not be loaded for an invalid invocation');
    });

    const result = await runCli({ argv: ['--bogus'], env: {}, loadConfig, ...ui });

    expect(result.exitCode).toBe(E2E_EXIT_CODES.ERROR);
    expect(result.report).toBeNull();
    expect(loadConfig).not.toHaveBeenCalled();
    expect(ui.errText()).toContain('unknown-argument');
    expect(ui.errText()).toContain('Usage: node scripts/staging/e2e.js');
  });

  it('rejects --plan combined with --write', async () => {
    const ui = capture();
    const loadConfig = jest.fn();

    const result = await runCli({ argv: ['--plan', '--write'], env: {}, loadConfig, ...ui });

    expect(result.exitCode).toBe(E2E_EXIT_CODES.ERROR);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(ui.errText()).toContain('conflicting-arguments');
    expect(ui.errText()).toContain('--plan and --write cannot be combined.');
  });

  it('rejects a missing --env-file value', async () => {
    const ui = capture();
    const loadConfig = jest.fn();

    const result = await runCli({ argv: ['--env-file'], env: {}, loadConfig, ...ui });

    expect(result.exitCode).toBe(E2E_EXIT_CODES.ERROR);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(ui.errText()).toContain('missing-argument-value');
  });
});


describe('staging E2E CLI plan mode', () => {
  it('previews every proposed scenario without any Jira request', async () => {
    const workspace = makeWorkspace();
    writeEvidence(workspace, readinessDocument());
    const ui = capture();
    const runE2E = jest.fn(async () => {
      throw new Error('runE2E must not be called in plan mode');
    });

    adapterVerifies();
    const result = await runCli({
      argv: ['--plan'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace)),
      runE2E,
      now: () => FIXED_NOW,
      runId: 'e2e-jest-planrun',
      ...ui,
    });

    expect(runE2E).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(E2E_EXIT_CODES.PASS);
    expect(result.status).toBe('pass');
    expect(result.mode).toBe('plan');
    expect(result.report.kind).toBe(E2E_PLAN_REPORT_KIND);
    expect(result.report.mode).toMatchObject({
      mode: 'plan',
      writeAuthorized: false,
      dryRun: true,
    });
    expect(result.report.readiness.status).toBe('verified');
    expect(result.report.config.local).toMatchObject({ host: LOCAL_HOST, projectKey: 'STG' });
    expect(result.report.config.remote).toMatchObject({ host: REMOTE_HOST, projectKey: 'RSTG' });
    expect(result.report.scenarios.map((entry) => entry.id)).toEqual([
      'local-issue-created-and-synced',
      'field-update-propagates',
      'status-transition-propagates',
      'public-comment-propagates',
      'remote-issue-created-and-synced',
      'remote-public-comment-propagates',
      'no-duplicate-counterparts',
    ]);
    expect(result.report.plan.issues).toEqual([]);
    expect(ui.errText()).toBe('');
    expect(ui.outText()).toContain('Staging E2E plan PASS');
    expect(ui.outText()).toContain('(no Jira requests, no mutations)');
    expect(ui.outText()).toContain('Scenarios (7 proposed, 7 required)');
    expect(ui.outText()).toContain('[PLAN] local-issue-created-and-synced');

    const persisted = JSON.parse(
      fs.readFileSync(writeFileIn(workspace, 'e2e-jest-planrun-plan.json'), 'utf8')
    );
    validatePlanReport(persisted);
    expect(persisted.summary).toMatchObject({ status: 'pass', exitCode: 0 });
    expect(fs.existsSync(writeFileIn(workspace, E2E_PLAN_LATEST_NAME))).toBe(true);
    // A plan is never persisted as a run report.
    expect(fs.existsSync(writeFileIn(workspace, E2E_LATEST_REPORT_NAME))).toBe(false);
  });

  it('blocks a plan when the readiness bundle is missing', async () => {
    const workspace = makeWorkspace();
    const ui = capture();
    const runE2E = jest.fn();

    const result = await runCli({
      argv: ['--plan'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace)),
      runE2E,
      now: () => FIXED_NOW,
      ...ui,
    });

    expect(runE2E).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(E2E_EXIT_CODES.BLOCKED);
    expect(result.status).toBe('blocked');
    expect(result.report.summary.reason).toContain('Blocked before any mutation');
    expect(result.report.plan.issues.map((entry) => entry.code)).toContain('evidence-missing');
    expect(result.report.nextActions.length).toBeGreaterThan(0);
    expect(ui.outText()).toContain('Staging E2E plan BLOCKED');
    expect(ui.outText()).toContain('[BLOCK] evidence-missing');
  });

  it('blocks a plan when mandatory credentials are missing', async () => {
    const workspace = makeWorkspace();
    writeEvidence(workspace, readinessDocument());
    const ui = capture();
    const issues = [
      {
        check: 'configuration',
        code: 'missing-configuration',
        field: 'STAGING_LOCAL_API_TOKEN',
        message: 'STAGING_LOCAL_API_TOKEN is required.',
        action:
          'Set STAGING_LOCAL_API_TOKEN in the staging environment file (mode 600) or the process environment.',
      },
    ];

    const result = await runCli({
      argv: ['--plan'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace), issues),
      runE2E: jest.fn(),
      now: () => FIXED_NOW,
      ...ui,
    });

    expect(result.exitCode).toBe(E2E_EXIT_CODES.BLOCKED);
    expect(result.report.plan.issues).toHaveLength(1);
    expect(result.report.plan.issues[0]).toMatchObject({
      code: 'missing-configuration',
      message: 'STAGING_LOCAL_API_TOKEN is required.',
    });
    expect(result.report.nextActions).toEqual([issues[0].action]);
    expect(ui.outText()).toContain('STAGING_LOCAL_API_TOKEN is required.');
  });


  it('does not require a Forge installation on the remote site', async () => {
    const workspace = makeWorkspace();
    writeEvidence(
      workspace,
      readinessDocument((document) => {
        document.connector.installedSites = [LOCAL_HOST];
      })
    );
    const ui = capture();

    const result = await runCli({
      argv: ['--plan'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace)),
      runE2E: jest.fn(),
      now: () => FIXED_NOW,
      ...ui,
    });

    const codes = result.report.readiness.reasons.map((entry) => entry.code);
    expect(codes).not.toContain('connector-site-not-installed');
    // The claim still cannot be verified, so the plan stays blocked - but not
    // because the remote site lacks an installation.
    expect(result.exitCode).toBe(E2E_EXIT_CODES.BLOCKED);
    expect(result.report.readiness.status).toBe('unknown');
    expect(codes).toContain('readiness-unverified');
    // The gate never pretends the authenticated adapter ran.
    expect(codes).toContain('authenticated-connector-adapter-unavailable');
  });

  it('blocks a plan when the local site has no connector installation', async () => {
    const workspace = makeWorkspace();
    writeEvidence(
      workspace,
      readinessDocument((document) => {
        document.connector.installedSites = [REMOTE_HOST];
      })
    );
    const ui = capture();

    const result = await runCli({
      argv: ['--plan'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace)),
      runE2E: jest.fn(),
      now: () => FIXED_NOW,
      ...ui,
    });

    expect(result.exitCode).toBe(E2E_EXIT_CODES.BLOCKED);
    expect(result.report.readiness.status).toBe('blocked');
    expect(result.report.readiness.reasons.map((entry) => entry.code)).toContain(
      'connector-site-not-installed'
    );
    expect(ui.outText()).toContain('is not reported as installed on the local staging site');
  });

  it('blocks a plan when the readiness bundle has no project mapping', async () => {
    const workspace = makeWorkspace();
    writeEvidence(
      workspace,
      readinessDocument((document) => {
        document.organizations = [];
      })
    );
    const ui = capture();

    const result = await runCli({
      argv: ['--plan'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace)),
      runE2E: jest.fn(),
      now: () => FIXED_NOW,
      ...ui,
    });

    expect(result.exitCode).toBe(E2E_EXIT_CODES.BLOCKED);
    expect(result.report.readiness.status).toBe('blocked');
    expect(ui.outText()).toContain('does not describe a project mapping');
  });

  it('prints machine-readable plan JSON with --json', async () => {
    const workspace = makeWorkspace();
    writeEvidence(workspace, readinessDocument());
    const ui = capture();

    adapterVerifies();
    const result = await runCli({
      argv: ['--plan', '--json'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace)),
      runE2E: jest.fn(),
      now: () => FIXED_NOW,
      runId: 'e2e-jest-planjson',
      ...ui,
    });

    expect(result.exitCode).toBe(E2E_EXIT_CODES.PASS);
    expect(ui.outText().trim().startsWith('{')).toBe(true);
    expect(JSON.parse(ui.outText()).kind).toBe(E2E_PLAN_REPORT_KIND);
    expect(ui.outText()).not.toContain('Staging E2E plan');
  });

  it('does not persist anything with --no-report', async () => {
    const workspace = makeWorkspace();
    writeEvidence(workspace, readinessDocument());
    const ui = capture();

    adapterVerifies();
    const result = await runCli({
      argv: ['--plan', '--no-report'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace)),
      runE2E: jest.fn(),
      now: () => FIXED_NOW,
      ...ui,
    });

    expect(result.exitCode).toBe(E2E_EXIT_CODES.PASS);
    expect(result.paths).toBeNull();
    expect(persistedReports(workspace)).toEqual([]);
  });
});

describe('staging E2E CLI dry run', () => {
  it('verifies read-only prerequisites and persists a validated run report', async () => {
    const workspace = makeWorkspace();
    writeEvidence(workspace, readinessDocument());
    const jira = createReadOnlyJira();
    const ui = capture();

    const result = await runCli({
      argv: ['--dry-run'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace)),
      request: jira.request,
      now: () => FIXED_NOW,
      sleep: async () => {},
      random: () => Buffer.from('cafebabecafebabe', 'hex'),
      runId: 'e2e-jest-dryrun',
      ...ui,
    });

    expect(result.exitCode).toBe(E2E_EXIT_CODES.PASS);
    expect(result.status).toBe('pass');
    expect(result.mode).toBe('dry-run');
    expect(result.report.kind).toBe(E2E_REPORT_KIND);
    expect(result.report.mode).toMatchObject({ mode: 'dry-run', writeAuthorized: false });
    expect(result.report.scenarios.every((entry) => entry.status === 'skipped')).toBe(true);
    expect(result.report.mutations.attempted).toBe(0);
    expect(jira.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(jira.calls.map((call) => call.origin)).toEqual(
      expect.arrayContaining([`https://${LOCAL_HOST}`, `https://${REMOTE_HOST}`])
    );
    expect(ui.outText()).toContain('Staging E2E PASS (dry run)');
    expect(ui.errText()).toBe('');

    const persisted = JSON.parse(
      fs.readFileSync(writeFileIn(workspace, 'e2e-jest-dryrun.json'), 'utf8')
    );
    validateReport(persisted);
    expect(persisted.summary).toMatchObject({
      status: 'pass',
      exitCode: 0,
      verificationScope: 'dry-run',
      e2eVerified: false,
    });
    expect(fs.existsSync(writeFileIn(workspace, E2E_LATEST_REPORT_NAME))).toBe(true);
  });

  it('blocks when a required Jira permission is missing', async () => {
    const workspace = makeWorkspace();
    writeEvidence(workspace, readinessDocument());
    const jira = createReadOnlyJira({ denied: ['ADD_COMMENTS'] });
    const ui = capture();

    const result = await runCli({
      argv: [],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace)),
      request: jira.request,
      now: () => FIXED_NOW,
      sleep: async () => {},
      ...ui,
    });

    expect(result.exitCode).toBe(E2E_EXIT_CODES.BLOCKED);
    expect(result.status).toBe('blocked');
    expect(result.report.summary.reason).toContain('permission');
    expect(
      result.report.prerequisites.filter((entry) => entry.status === 'fail').map((entry) => entry.id)
    ).toContain('local.permissions');
    expect(result.report.mutations.attempted).toBe(0);
    expect(jira.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(ui.outText()).toContain('Staging E2E BLOCKED');
  });

  it('stays in dry-run mode when only the confirmation variable is set', async () => {
    const workspace = makeWorkspace();
    writeEvidence(workspace, readinessDocument());
    const jira = createReadOnlyJira();
    const ui = capture();

    const result = await runCli({
      argv: [],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace, { writeMode: E2E_WRITE_CONFIRMATION })),
      request: jira.request,
      now: () => FIXED_NOW,
      sleep: async () => {},
      ...ui,
    });

    expect(result.report.mode).toMatchObject({ mode: 'dry-run', writeAuthorized: false });
    expect(result.exitCode).toBe(E2E_EXIT_CODES.PASS);
    expect(jira.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('blocks a dry run on missing configuration without sending a request', async () => {
    const workspace = makeWorkspace();
    writeEvidence(workspace, readinessDocument());
    const jira = createReadOnlyJira();
    const ui = capture();
    const issues = [
      {
        check: 'configuration',
        code: 'missing-configuration',
        field: 'STAGING_REMOTE_API_TOKEN',
        message: 'STAGING_REMOTE_API_TOKEN is required.',
        action: 'Set STAGING_REMOTE_API_TOKEN in the staging environment file.',
      },
    ];

    const result = await runCli({
      argv: ['--dry-run'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace), issues),
      request: jira.request,
      now: () => FIXED_NOW,
      sleep: async () => {},
      ...ui,
    });

    expect(jira.calls).toHaveLength(0);
    expect(result.exitCode).toBe(E2E_EXIT_CODES.BLOCKED);
    expect(result.status).toBe('blocked');
    expect(result.report.summary.reason).toContain('STAGING_REMOTE_API_TOKEN is required.');
    expect(result.report.mutations.attempted).toBe(0);
    expect(ui.errText()).toBe('');
  });

  it('does not persist a run report with --no-report', async () => {
    const workspace = makeWorkspace();
    writeEvidence(workspace, readinessDocument());
    const jira = createReadOnlyJira();
    const ui = capture();

    const result = await runCli({
      argv: ['--no-report'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace)),
      request: jira.request,
      now: () => FIXED_NOW,
      sleep: async () => {},
      ...ui,
    });

    expect(result.exitCode).toBe(E2E_EXIT_CODES.PASS);
    expect(result.paths).toBeNull();
    expect(persistedReports(workspace)).toEqual([]);
  });
});


/**
 * Minimal but complete run report used when the runner itself is stubbed. It
 * only needs to satisfy the terminal formatter, because the write tests assert
 * authorization plumbing rather than a live run.
 */
function stubbedReport(status = 'blocked') {
  return {
    kind: E2E_REPORT_KIND,
    schemaVersion: '1.0',
    runId: 'e2e-jest-write',
    startedAt: new Date(FIXED_NOW).toISOString(),
    finishedAt: new Date(FIXED_NOW).toISOString(),
    generatedAt: new Date(FIXED_NOW).toISOString(),
    durationMs: 0,
    environment: 'staging',
    mode: { mode: 'write', writeAuthorized: true, dryRun: false },
    config: {
      local: { role: 'local', host: LOCAL_HOST, projectKey: 'STG' },
      remote: { role: 'remote', host: REMOTE_HOST, projectKey: 'RSTG' },
      syncDirection: 'bidirectional',
      cleanupEnabled: true,
      maxMutations: 60,
    },
    readiness: { status: 'verified', checks: [], reasons: [], summary: {} },
    prerequisites: [],
    scenarios: [],
    fixtures: [],
    mutations: { attempted: 0, budget: 60, operations: [] },
    summary: {
      status,
      exitCode: status === 'pass' ? 0 : E2E_EXIT_CODES.BLOCKED,
      e2eVerified: false,
      writeVerified: false,
      verificationScope: 'live-write',
      reason: 'Blocked before any mutation: simulated by the test double.',
      counts: { total: 0, pass: 0, fail: 0, unknown: 0, skipped: 0 },
      requiredFailures: [],
      cleanupFailures: [],
    },
    nextActions: [],
    warnings: [],
  };
}


describe('staging E2E CLI write authorization', () => {
  it('refuses --write without the exact confirmation and sends no request', async () => {
    for (const writeMode of ['', 'yes-please']) {
      const workspace = makeWorkspace();
      writeEvidence(workspace, readinessDocument());
      const jira = createReadOnlyJira();
      const ui = capture();

      const result = await runCli({
        argv: ['--write'],
        cwd: workspace.dir,
        env: {},
        loadConfig: loadedConfig(stagingConfig(workspace, { writeMode })),
        request: jira.request,
        now: () => FIXED_NOW,
        sleep: async () => {},
        ...ui,
      });

      expect(jira.calls).toHaveLength(0);
      expect(result.exitCode).toBe(E2E_EXIT_CODES.BLOCKED);
      expect(result.status).toBe('blocked');
      expect(result.report.mode).toMatchObject({ mode: 'dry-run', writeAuthorized: false });
      expect(result.report.summary.reason).toContain('write confirmation');
      expect(ui.errText()).toContain('Write mode refused');
    }
  });

  it('authorizes write mode only when the flag and confirmation agree', async () => {
    const workspace = makeWorkspace();
    writeEvidence(workspace, readinessDocument());
    const ui = capture();
    const report = stubbedReport();
    const runE2E = jest.fn(async () => ({
      report,
      status: 'blocked',
      exitCode: E2E_EXIT_CODES.BLOCKED,
    }));
    const writeE2EReport = jest.fn(() => ({
      runPath: '/tmp/e2e-jest-write.json',
      latestPath: '/tmp/latest-e2e.json',
    }));

    const result = await runCli({
      argv: ['--write'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace, { writeMode: E2E_WRITE_CONFIRMATION })),
      runE2E,
      writeE2EReport,
      now: () => FIXED_NOW,
      ...ui,
    });

    expect(runE2E).toHaveBeenCalledTimes(1);
    const forwarded = runE2E.mock.calls[0][0];
    expect(forwarded.plan.writeAuthorized).toBe(true);
    expect(forwarded.plan.settings.mode).toBe('write');
    expect(forwarded.plan.settings.confirmations).toMatchObject({ flag: true, matched: true });
    expect(forwarded.configIssues).toEqual([]);
    expect(writeE2EReport).toHaveBeenCalledTimes(1);
    expect(writeE2EReport.mock.calls[0][0].dir).toBe(workspace.reportDir);
    expect(writeE2EReport.mock.calls[0][0].report).toEqual(report);
    expect(writeE2EReport.mock.calls[0][0].secrets).toEqual(
      expect.arrayContaining(['placeholder-local-token'])
    );
    expect(result.exitCode).toBe(E2E_EXIT_CODES.BLOCKED);
    expect(ui.errText()).toBe('');
    expect(ui.outText()).toContain('Report: /tmp/e2e-jest-write.json');
  });

  it('never enables write mode from an npm script', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const scripts = pkg.scripts || {};

    expect(scripts['staging:e2e']).toBe('node scripts/staging/e2e.js');
    expect(scripts['staging:e2e:plan']).toContain('--plan');
    expect(scripts['staging:e2e:dry-run']).toContain('--dry-run');
    ['staging:e2e', 'staging:e2e:plan', 'staging:e2e:dry-run'].forEach((name) => {
      expect(scripts[name]).not.toContain('--write');
    });
    expect(scripts['test:staging:e2e']).toContain('tests/staging-e2e-cli.test.js');
  });
});


describe('staging E2E CLI error reporting', () => {
  it('reports a runner failure with a redacted message', async () => {
    const workspace = makeWorkspace();
    writeEvidence(workspace, readinessDocument());
    const ui = capture();
    const runE2E = jest.fn(async () => {
      throw new Error('transport failed with header Basic YWJjOjEyMzQ1Ng==');
    });

    const result = await runCli({
      argv: ['--dry-run'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace)),
      runE2E,
      now: () => FIXED_NOW,
      ...ui,
    });

    expect(result.exitCode).toBe(E2E_EXIT_CODES.ERROR);
    expect(result.status).toBe('error');
    expect(ui.errText()).toContain('Staging E2E error');
    expect(ui.errText()).toContain('Basic [REDACTED]');
    expect(ui.errText()).not.toContain('YWJjOjEyMzQ1Ng');
  });

  it('still prints the summary when the report cannot be written', async () => {
    const workspace = makeWorkspace();
    writeEvidence(workspace, readinessDocument());
    const jira = createReadOnlyJira();
    const ui = capture();
    const writeE2EReport = jest.fn(() => {
      throw new Error('Unsafe report directory: outside the private artifacts/ subtree.');
    });

    const result = await runCli({
      argv: ['--dry-run'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace)),
      request: jira.request,
      writeE2EReport,
      now: () => FIXED_NOW,
      sleep: async () => {},
      ...ui,
    });

    expect(result.exitCode).toBe(E2E_EXIT_CODES.ERROR);
    expect(result.report.summary.status).toBe('pass');
    expect(result.reportError).toContain('Unsafe report directory');
    expect(ui.outText()).toContain('Staging E2E PASS (dry run)');
    expect(ui.errText()).toContain('Could not write the staging E2E report');
  });

  it('reports an interrupted run as an error with the partial report', async () => {
    const workspace = makeWorkspace();
    writeEvidence(workspace, readinessDocument());
    const ui = capture();
    let controller = null;
    const report = stubbedReport('pass');

    const result = await runCli({
      argv: ['--dry-run'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace)),
      onReady: (ready) => {
        controller = ready;
      },
      runE2E: async () => {
        controller.interrupt('SIGINT');
        return { report, status: 'pass', exitCode: E2E_EXIT_CODES.PASS };
      },
      writeE2EReport: () => ({ runPath: '/tmp/run.json', latestPath: '/tmp/latest.json' }),
      now: () => FIXED_NOW,
      ...ui,
    });

    expect(result.interrupted).toBe(true);
    expect(result.exitCode).toBe(E2E_EXIT_CODES.ERROR);
    expect(result.status).toBe('interrupted');
    expect(result.report.summary.status).toBe('interrupted');
    expect(result.report.summary.exitCode).toBe(E2E_EXIT_CODES.ERROR);
    expect(result.report.summary.e2eVerified).toBe(false);
    expect(result.report.interruption).toMatchObject({ interrupted: true, signal: 'SIGINT' });
    expect(ui.errText()).toContain('Interrupted by SIGINT');
    expect(ui.outText()).toContain('INTERRUPTED');
    expect(ui.outText()).not.toContain('Staging E2E PASS');
  });

  it('reports an interrupted plan as interrupted without claiming a pass', async () => {
    const workspace = makeWorkspace();
    writeEvidence(workspace, readinessDocument());
    const ui = capture();

    const result = await runCli({
      argv: ['--plan', '--no-report'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace)),
      onReady: (ready) => {
        ready.interrupt('SIGTERM');
      },
      runE2E: jest.fn(),
      now: () => FIXED_NOW,
      ...ui,
    });

    expect(result.interrupted).toBe(true);
    expect(result.exitCode).toBe(E2E_EXIT_CODES.ERROR);
    expect(result.report.summary.status).toBe('interrupted');
    expect(result.report.summary.exitCode).toBe(E2E_EXIT_CODES.ERROR);
    expect(ui.errText()).toContain('Interrupted by SIGTERM');
    expect(ui.outText()).toContain('Staging E2E plan INTERRUPTED');
    expect(ui.outText()).not.toContain('Staging E2E plan PASS');
  });
});


/**
 * Defects 1, 3 and 4 at the CLI boundary: write gating, interruption plumbing
 * and credential redaction across every output path.
 */
describe('staging E2E CLI readiness trust, interruption and redaction', () => {
  it('never enables --write from a forged all-green readiness file', async () => {
    const workspace = makeWorkspace();
    writeEvidence(workspace, readinessDocument());
    const jira = createReadOnlyJira();
    const ui = capture();

    const result = await runCli({
      argv: ['--write'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(
        stagingConfig(workspace, { writeMode: E2E_WRITE_CONFIRMATION })
      ),
      request: jira.request,
      now: () => FIXED_NOW,
      sleep: async () => {},
      ...ui,
    });

    expect(result.exitCode).toBe(E2E_EXIT_CODES.BLOCKED);
    expect(result.status).toBe('blocked');
    // The confirmation still authorizes intent; it never substitutes for
    // technical readiness evidence.
    expect(result.report.mode.writeAuthorized).toBe(true);
    expect(result.report.readiness.status).toBe('unknown');
    expect(result.report.readiness.summary.readinessBasis).toBe('unverified-claims');
    expect(result.report.summary.e2eVerified).toBe(false);
    expect(result.report.mutations.attempted).toBe(0);
    expect(jira.calls).toHaveLength(0);
    expect(ui.outText()).not.toContain('Staging E2E PASS');
  });

  it('keeps --write blocked when a caller supplies a page, callback or facts', async () => {
    const workspace = makeWorkspace();
    writeEvidence(workspace, readinessDocument());
    const jira = createReadOnlyJira();
    const evaluate = jest.fn(async () => readinessFacts());
    const ui = capture();

    const result = await runCli({
      argv: ['--write'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(
        stagingConfig(workspace, { writeMode: E2E_WRITE_CONFIRMATION })
      ),
      // None of these may authorize a write: the CLI has no readiness input and
      // the runner has no argument that supplies one.
      readinessPage: {
        url: () => `https://${LOCAL_HOST}/jira/apps/${APP_UUID}/admin`,
        evaluate,
      },
      readiness: readinessFacts(),
      connectorVerification: readinessFacts(),
      request: jira.request,
      now: () => FIXED_NOW,
      sleep: async () => {},
      ...ui,
    });

    expect(result.exitCode).toBe(E2E_EXIT_CODES.BLOCKED);
    expect(result.status).toBe('blocked');
    expect(evaluate).not.toHaveBeenCalled();
    // The only readiness acquisition is the server-side resolver, called with
    // no caller object.
    expect(readForgeAdminReadiness).toHaveBeenCalledWith();
    expect(readForgeAdminReadiness).toHaveBeenCalledTimes(1);
    expect(jira.calls).toHaveLength(0);
    expect(result.report.mutations.attempted).toBe(0);
    expect(result.report.readiness.status).toBe('unknown');
    expect(result.report.readiness.summary.readinessBasis).toBe('unverified-claims');
    expect(result.report.summary.e2eVerified).toBe(false);
    const codes = result.report.readiness.reasons.map((entry) => entry.code);
    expect(codes).toContain('authenticated-connector-adapter-unavailable');
    expect(codes).toContain('readiness-unverified');
    expect(ui.outText()).not.toContain('Staging E2E PASS');
  });

  it('forwards an interruption predicate into the runner', async () => {
    const workspace = makeWorkspace();
    writeEvidence(workspace, readinessDocument());
    const ui = capture();
    let controller = null;
    let observed = null;

    const report = stubbedReport('blocked');
    await runCli({
      argv: ['--dry-run'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace)),
      onReady: (ready) => {
        controller = ready;
      },
      runE2E: async (args) => {
        observed = {
          before: args.interrupted(),
          signalBefore: args.interruptionSignal(),
        };
        controller.interrupt('SIGTERM');
        observed.after = args.interrupted();
        observed.signalAfter = args.interruptionSignal();
        return { report, status: 'blocked', exitCode: E2E_EXIT_CODES.BLOCKED };
      },
      writeE2EReport: () => ({ runPath: '/tmp/run.json', latestPath: '/tmp/latest.json' }),
      now: () => FIXED_NOW,
      ...ui,
    });

    expect(observed).toEqual({
      before: false,
      after: true,
      signalBefore: null,
      signalAfter: 'SIGTERM',
    });
  });

  it('keeps a token and an email echoed by Jira out of terminal and persisted output', async () => {
    const workspace = makeWorkspace();
    writeEvidence(workspace, readinessDocument());
    const jira = createReadOnlyJira({
      failMyself: {
        status: 401,
        body: {
          errorMessages: [
            'Unauthorized: placeholder-local-token rejected for bot-local@example.test',
          ],
        },
      },
    });
    const ui = capture();

    const result = await runCli({
      argv: ['--dry-run'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace)),
      request: jira.request,
      now: () => FIXED_NOW,
      sleep: async () => {},
      runId: 'e2e-jest-redaction',
      ...ui,
    });

    expect(result.exitCode).toBe(E2E_EXIT_CODES.BLOCKED);
    const detail = (result.report.prerequisites.find((entry) => entry.status === 'fail') || {})
      .detail;
    expect(detail).toMatch(/401/);
    expect(detail).toContain('[REDACTED]');
    [ui.outText(), ui.errText()].forEach((text) => {
      expect(text).not.toContain('placeholder-local-token');
      expect(text).not.toContain('bot-local@example.test');
    });
    expect(ui.outText()).toMatch(/401/);

    const persisted = fs.readFileSync(
      writeFileIn(workspace, 'e2e-jest-redaction.json'),
      'utf8'
    );
    expect(persisted).not.toContain('placeholder-local-token');
    expect(persisted).not.toContain('bot-local@example.test');
    validateReport(JSON.parse(persisted));
  });

  it('keeps the same redaction on the --json and --no-report paths', async () => {
    const workspace = makeWorkspace();
    writeEvidence(workspace, readinessDocument());
    const jira = createReadOnlyJira({
      failMyself: {
        status: 401,
        body: {
          errorMessages: [
            'Unauthorized: placeholder-local-token rejected for bot-local@example.test',
          ],
        },
      },
    });

    const jsonUi = capture();
    await runCli({
      argv: ['--dry-run', '--json'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace)),
      request: jira.request,
      now: () => FIXED_NOW,
      sleep: async () => {},
      runId: 'e2e-jest-json-redaction',
      ...jsonUi,
    });

    expect(jsonUi.outText()).not.toContain('placeholder-local-token');
    expect(jsonUi.outText()).not.toContain('bot-local@example.test');
    validateReport(JSON.parse(jsonUi.outText()));

    const noReportUi = capture();
    await runCli({
      argv: ['--dry-run', '--no-report'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace)),
      request: jira.request,
      now: () => FIXED_NOW,
      sleep: async () => {},
      runId: 'e2e-jest-noreport-redaction',
      ...noReportUi,
    });

    expect(noReportUi.outText()).not.toContain('placeholder-local-token');
    expect(noReportUi.outText()).not.toContain('bot-local@example.test');
    expect(persistedReports(workspace).some((name) => name.includes('noreport'))).toBe(false);
  });
});

describe('staging E2E CLI output sanitisation', () => {
  it('sanitizes a credential-shaped value returned by the runner', async () => {
    const workspace = makeWorkspace();
    writeEvidence(workspace, readinessDocument());
    const jira = createReadOnlyJira();

    // A real dry run produces a report that passes validation.
    const seed = await runCli({
      argv: ['--dry-run', '--no-report'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace)),
      request: jira.request,
      now: () => FIXED_NOW,
      sleep: async () => {},
      runId: 'e2e-jest-seed',
      stdout: () => {},
      stderr: () => {},
    });
    expect(seed.report).not.toBeNull();

    const tampered = JSON.parse(JSON.stringify(seed.report));
    tampered.runId = 'e2e-jest-sanitized';
    tampered.summary.reason =
      'Blocked before any mutation: Authorization was Basic dGVzdDp0ZXN0MTIzNDU2Nzg5MA==';

    const ui = capture();
    const result = await runCli({
      argv: ['--dry-run'],
      cwd: workspace.dir,
      env: {},
      loadConfig: loadedConfig(stagingConfig(workspace)),
      runE2E: async () => ({
        report: tampered,
        status: tampered.summary.status,
        exitCode: tampered.summary.exitCode,
      }),
      now: () => FIXED_NOW,
      runId: 'e2e-jest-sanitized',
      ...ui,
    });

    expect(result.exitCode).toBe(E2E_EXIT_CODES.PASS);
    expect(ui.outText()).not.toContain('dGVzdDp0ZXN0');
    expect(ui.outText()).toContain('Basic [REDACTED]');
    const persisted = fs.readFileSync(writeFileIn(workspace, 'e2e-jest-sanitized.json'), 'utf8');
    expect(persisted).not.toContain('dGVzdDp0ZXN0');
    expect(persisted).toContain('Basic [REDACTED]');
  });
});


/**
 * The operator signal must reach the HTTP client, not only the run loop: the
 * real CLI, the real runner and the real client run here against a simulated
 * transport so a rate-limited retry cannot be sent after SIGINT/SIGTERM.
 */
describe('staging E2E CLI cancellation at the transport', () => {
  it.each(['SIGINT', 'SIGTERM'])(
    'never starts a retried issue create after %s',
    async (signal) => {
      const workspace = makeWorkspace();
      writeEvidence(workspace, readinessDocument());
      const ui = capture();
      let controller = null;
      const jira = createRateLimitedJira({
        onFirstCreate: () => controller.interrupt(signal),
      });
      const config = {
        ...stagingConfig(workspace, { writeMode: E2E_WRITE_CONFIRMATION }),
        maxRetries: 1,
      };

      adapterVerifies();
      const result = await runCli({
        argv: ['--write'],
        cwd: workspace.dir,
        env: {},
        loadConfig: loadedConfig(config),
        onReady: (ready) => {
          controller = ready;
        },
        request: jira.request,
        now: () => FIXED_NOW,
        sleep: async () => {},
        ...ui,
      });

      expect(controller).not.toBeNull();
      // One attempt reached Jira, the interruption was recorded while the client
      // was waiting to retry, and the retry was never sent.
      expect(jira.createAttempts()).toBe(1);
      expect(jira.calls.filter((entry) => entry.method === 'POST')).toHaveLength(1);
      expect(jira.calls.filter((entry) => entry.method === 'DELETE')).toHaveLength(0);

      expect(result.exitCode).toBe(E2E_EXIT_CODES.ERROR);
      expect(result.exitCode).toBe(2);
      expect(result.status).toBe('interrupted');
      // Write mode really was authorized and attempted: the run is not blocked,
      // it is cancelled mid-transport.
      expect(result.report.mode.writeAuthorized).toBe(true);
      expect(result.report.readiness.status).toBe('verified');
      expect(result.report.mutations.attempted).toBe(1);
      expect(result.report.summary.status).toBe('interrupted');
      expect(result.report.summary.exitCode).toBe(2);
      expect(result.report.summary.e2eVerified).toBe(false);
      expect(result.report.interruption).toMatchObject({ interrupted: true, signal });
      expect(ui.errText()).toContain(`Interrupted by ${signal}`);
      expect(ui.outText()).toContain('INTERRUPTED');
      expect(ui.outText()).not.toContain('Staging E2E PASS');

      const latest = JSON.parse(
        fs.readFileSync(path.join(workspace.reportDir, E2E_LATEST_REPORT_NAME), 'utf8')
      );
      expect(latest.summary.status).toBe('interrupted');
      expect(latest.summary.exitCode).toBe(2);
      expect(latest.summary.e2eVerified).toBe(false);
      expect(() => validateReport(latest)).not.toThrow();
    }
  );
});
