/** @jest-environment node */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  buildConfig,
  loadConfig,
  parseEnvFile,
  validateJiraSiteUrl,
} = require('../scripts/staging/lib/config');
const {
  JiraReadOnlyClient,
  JiraRequestError,
  assertReadOnlyEndpoint,
  assertSafeNodeDebug,
} = require('../scripts/staging/lib/http');
const {
  fetchAccessibleProjects,
  fetchPermissions,
  evaluateSiteIsolation,
} = require('../scripts/staging/lib/jira');
const {
  EXIT_CODES,
  SCHEMA_VERSION,
  runPreflight,
} = require('../scripts/staging/lib/preflight');
const {
  formatTerminalReport,
  latestReportPath,
  readReport,
  validateReport,
  writeReport,
} = require('../scripts/staging/lib/report');

const ROOT = path.resolve(__dirname, '..');
const LOCAL_HOST = 'localstaging.atlassian.net';
const REMOTE_HOST = 'remotestaging.atlassian.net';
const LOCAL_TOKEN = 'local-api-token-1234567890';
const REMOTE_TOKEN = 'remote-api-token-1234567890';
const LOCAL_EMAIL = 'local-admin@example.com';
const REMOTE_EMAIL = 'remote-admin@example.com';

function baseEnv(overrides = {}) {
  return {
    STAGING_ALLOWED_HOSTS: `${LOCAL_HOST},${REMOTE_HOST}`,
    STAGING_LOCAL_URL: `https://${LOCAL_HOST}`,
    STAGING_LOCAL_EMAIL: LOCAL_EMAIL,
    STAGING_LOCAL_API_TOKEN: LOCAL_TOKEN,
    STAGING_LOCAL_PROJECTS: 'STG',
    STAGING_LOCAL_NON_STAGING_PROJECTS: 'DEV',
    STAGING_REMOTE_URL: `https://${REMOTE_HOST}`,
    STAGING_REMOTE_EMAIL: REMOTE_EMAIL,
    STAGING_REMOTE_API_TOKEN: REMOTE_TOKEN,
    STAGING_REMOTE_PROJECTS: 'RSTG',
    STAGING_REMOTE_NON_STAGING_PROJECTS: 'RDEV',
    ...overrides,
  };
}

function buildFrom(overrides = {}) {
  return buildConfig(baseEnv(overrides), { cwd: ROOT });
}

function validConfig(overrides = {}) {
  const result = buildFrom(overrides);
  expect(result.issues).toEqual([]);
  return result.config;
}

function envFileText(overrides = {}) {
  return Object.entries(baseEnv(overrides))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function response(status, body, headers = {}) {
  return { status, headers, body };
}

function project(id, key, name = key) {
  return { id, key, name, projectTypeKey: 'software', simplified: false };
}

function fakeJira(options = {}) {
  const calls = [];
  const projects = options.projects || {};
  const identities = options.identities || {};
  const permissions = options.permissions || {};
  const failures = options.failures || {};

  function handler(url, requestOptions = {}) {
    const parsed = new URL(url);
    calls.push({
      url: parsed,
      authorization: requestOptions.headers && requestOptions.headers.Authorization,
    });

    const siteFailure = failures[parsed.hostname] || {};
    if (siteFailure[parsed.pathname]) {
      const failure = siteFailure[parsed.pathname];
      return Promise.resolve(
        response(failure.status || 500, failure.body || { errorMessages: ['simulated failure'] })
      );
    }

    if (parsed.pathname === '/rest/api/3/myself') {
      return Promise.resolve(
        response(
          200,
          identities[parsed.hostname] || {
            accountId: `account-${parsed.hostname}`,
            active: true,
            accountType: 'atlassian',
            emailAddress: 'masked@example.com',
            timeZone: 'Etc/UTC',
          }
        )
      );
    }

    if (parsed.pathname === '/rest/api/3/project/search') {
      const all = projects[parsed.hostname] || [];
      const startAt = Number(parsed.searchParams.get('startAt') || 0);
      const maxResults = Number(parsed.searchParams.get('maxResults') || 50);
      const values = all.slice(startAt, startAt + maxResults);
      const next = startAt + values.length;
      return Promise.resolve(
        response(200, {
          values,
          startAt,
          maxResults,
          total: all.length,
          isLast: next >= all.length,
        })
      );
    }

    if (parsed.pathname.startsWith('/rest/api/3/project/')) {
      const key = decodeURIComponent(parsed.pathname.split('/').pop());
      const found = (projects[parsed.hostname] || []).find(
        (entry) => entry.key.toUpperCase() === key.toUpperCase()
      );
      return Promise.resolve(
        found ? response(200, found) : response(404, { errorMessages: ['project not found'] })
      );
    }

    if (parsed.pathname === '/rest/api/3/mypermissions') {
      const projectKey = parsed.searchParams.get('projectKey');
      const requested = (parsed.searchParams.get('permissions') || '')
        .split(',')
        .filter(Boolean);
      const granted = (permissions[parsed.hostname] || {})[projectKey] || {};
      const payload = {};
      requested.forEach((key) => {
        payload[key] = {
          key,
          name: key,
          type: 'PROJECT',
          havePermission: granted[key] === true,
        };
      });
      return Promise.resolve(response(200, { permissions: payload }));
    }

    return Promise.resolve(response(404, { errorMessages: ['not found'] }));
  }

  return { handler, calls };
}

async function healthyPersistedReport(runId = 'run-valid-report') {
  const config = validConfig();
  const jira = fakeJira({
    projects: {
      [LOCAL_HOST]: [project('100', 'STG'), project('101', 'DEV')],
      [REMOTE_HOST]: [project('200', 'RSTG'), project('201', 'RDEV')],
    },
    permissions: {
      [LOCAL_HOST]: { STG: { BROWSE_PROJECTS: true } },
      [REMOTE_HOST]: { RSTG: { BROWSE_PROJECTS: true } },
    },
  });
  return runPreflight({
    config,
    request: jira.handler,
    now: () => new Date('2026-10-24T12:00:00.000Z'),
    runId,
  });
}

describe('secure configuration', () => {
  test('parses comments, export prefixes, quoted values, and inline comments', () => {
    const parsed = parseEnvFile(
      [
        '# comment',
        'export STAGING_LOCAL_PROJECTS="STG,STG2"',
        "STAGING_LOCAL_EMAIL='admin@example.com'",
        'STAGING_LOCAL_API_TOKEN=token-value # note',
        '',
      ].join('\n')
    );

    expect(parsed.issues).toEqual([]);
    expect(parsed.vars).toEqual({
      STAGING_LOCAL_PROJECTS: 'STG,STG2',
      STAGING_LOCAL_EMAIL: 'admin@example.com',
      STAGING_LOCAL_API_TOKEN: 'token-value',
    });
  });

  test('reports duplicate keys and malformed lines without echoing line contents', () => {
    const parsed = parseEnvFile(
      [
        'STAGING_LOCAL_API_TOKEN=super-secret-token',
        'STAGING_LOCAL_API_TOKEN=other-secret-token',
        'this is not an assignment',
      ].join('\n')
    );

    expect(parsed.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['env-file-duplicate-key', 'env-file-syntax'])
    );
    expect(JSON.stringify(parsed.issues)).not.toContain('super-secret-token');
    expect(JSON.stringify(parsed.issues)).not.toContain('other-secret-token');
  });

  test('rejects a group- or world-readable environment file and accepts mode 600', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-config-'));
    const file = path.join(dir, '.env.staging');
    fs.writeFileSync(file, envFileText(), 'utf8');
    fs.chmodSync(file, 0o644);

    const insecure = loadConfig({ cwd: dir, env: {}, envFile: '.env.staging' });
    const permissionIssue = insecure.issues.find(
      (issue) => issue.code === 'env-file-permissions'
    );
    expect(permissionIssue).toBeDefined();
    expect(permissionIssue.action).toContain('chmod 600');
    expect(JSON.stringify(insecure.issues)).not.toContain(LOCAL_TOKEN);

    fs.chmodSync(file, 0o600);
    const secure = loadConfig({ cwd: dir, env: {}, envFile: '.env.staging' });
    expect(secure.issues).toEqual([]);
    expect(secure.config.local.host).toBe(LOCAL_HOST);
    expect(secure.config.local.apiToken).toBe(LOCAL_TOKEN);
  });

  test('lists every required field when configuration is absent', () => {
    const result = buildConfig({}, { cwd: ROOT });
    const fields = result.issues
      .filter((issue) => issue.code === 'missing-configuration')
      .map((issue) => issue.field);

    expect(fields).toEqual(
      expect.arrayContaining([
        'STAGING_ALLOWED_HOSTS',
        'STAGING_LOCAL_URL',
        'STAGING_LOCAL_EMAIL',
        'STAGING_LOCAL_API_TOKEN',
        'STAGING_LOCAL_PROJECTS',
        'STAGING_LOCAL_NON_STAGING_PROJECTS',
        'STAGING_REMOTE_URL',
        'STAGING_REMOTE_EMAIL',
        'STAGING_REMOTE_API_TOKEN',
        'STAGING_REMOTE_PROJECTS',
        'STAGING_REMOTE_NON_STAGING_PROJECTS',
      ])
    );
  });



  test('validates Jira Cloud origins against the explicit host allow-list', () => {
    const allowed = [LOCAL_HOST];
    expect(validateJiraSiteUrl(`https://${LOCAL_HOST}`, allowed)).toEqual({
      host: LOCAL_HOST,
      origin: `https://${LOCAL_HOST}`,
    });
    expect(validateJiraSiteUrl(`https://${LOCAL_HOST.toUpperCase()}`, allowed)).toEqual({
      host: LOCAL_HOST,
      origin: `https://${LOCAL_HOST}`,
    });

    const rejected = [
      `http://${LOCAL_HOST}`,
      `https://${LOCAL_HOST}:443`,
      `https://user:pass@${LOCAL_HOST}`,
      `https://${LOCAL_HOST}/rest/api/3`,
      `https://${LOCAL_HOST}/?x=1`,
      `https://${LOCAL_HOST}.evil.example`,
      'https://evilatlassian.net',
      `https://${REMOTE_HOST}`,
    ];

    rejected.forEach((value) => {
      const result = validateJiraSiteUrl(value, allowed);
      expect(result.issues.length).toBeGreaterThan(0);
    });
  });

  test('rejects wildcard, scheme, port, and path entries in the allow-list', () => {
    const cases = [
      '*.atlassian.net',
      `https://${LOCAL_HOST}`,
      `${LOCAL_HOST}:443`,
      `${LOCAL_HOST}/path`,
    ];

    cases.forEach((allowedHosts) => {
      const result = buildFrom({ STAGING_ALLOWED_HOSTS: allowedHosts });
      expect(result.issues.some((issue) => issue.check === 'host-allow-list')).toBe(true);
    });
  });

  test('requires distinct local and remote sites', () => {
    const result = buildFrom({
      STAGING_ALLOWED_HOSTS: LOCAL_HOST,
      STAGING_REMOTE_URL: `https://${LOCAL_HOST}`,
    });
    expect(result.issues.some((issue) => issue.code === 'host-not-distinct')).toBe(true);
  });

  test('rejects staging projects repeated in the non-staging inventory', () => {
    const result = buildFrom({ STAGING_LOCAL_NON_STAGING_PROJECTS: 'DEV,STG' });
    expect(
      result.issues.some((issue) => issue.code === 'project-overlap-configuration')
    ).toBe(true);
  });

  test('requires the non-staging inventory variable even when it is empty', () => {
    const missing = buildFrom({ STAGING_LOCAL_NON_STAGING_PROJECTS: undefined });
    const empty = buildFrom({ STAGING_LOCAL_NON_STAGING_PROJECTS: '' });

    expect(
      missing.issues.some(
        (issue) =>
          issue.code === 'missing-configuration' &&
          issue.field === 'STAGING_LOCAL_NON_STAGING_PROJECTS'
      )
    ).toBe(true);
    expect(empty.issues).toEqual([]);
    expect(empty.config.local.nonStagingProjects).toEqual([]);
  });

  test('rejects report directories outside the working directory', () => {
    const result = buildFrom({ STAGING_REPORT_DIR: '../outside' });
    expect(
      result.issues.some((issue) => issue.code === 'invalid-report-directory')
    ).toBe(true);
  });

  test('requires report output to stay in the private artifact subtree', () => {
    const publicReports = buildFrom({ STAGING_REPORT_DIR: 'public-reports' });
    expect(
      publicReports.issues.some(
        (issue) => issue.code === 'invalid-report-directory'
      )
    ).toBe(true);

    const traversal = buildFrom({
      STAGING_REPORT_DIR: 'artifacts/../public-reports',
    });
    expect(
      traversal.issues.some((issue) => issue.code === 'invalid-report-directory')
    ).toBe(true);

    const custom = buildFrom({ STAGING_REPORT_DIR: 'artifacts/custom' });
    expect(custom.issues).toEqual([]);
    expect(custom.config.reportDir).toBe(path.join(ROOT, 'artifacts', 'custom'));
  });

  test('rejects symlinked report paths that escape the artifact subtree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-path-root-'));
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), 'staging-path-outside-')
    );
    try {
      fs.mkdirSync(path.join(root, 'artifacts'));
      fs.symlinkSync(
        outside,
        path.join(root, 'artifacts', 'escape'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );

      const escaped = buildConfig(
        baseEnv({ STAGING_REPORT_DIR: 'artifacts/escape' }),
        { cwd: root }
      );
      expect(
        escaped.issues.some((issue) => issue.code === 'invalid-report-directory')
      ).toBe(true);

      const linkedRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'staging-path-linked-')
      );
      try {
        const unignoredTarget = path.join(linkedRoot, 'public-reports');
        fs.mkdirSync(unignoredTarget);
        fs.symlinkSync(
          unignoredTarget,
          path.join(linkedRoot, 'artifacts'),
          process.platform === 'win32' ? 'junction' : 'dir'
        );
        const defaultDir = buildConfig(baseEnv(), { cwd: linkedRoot });
        expect(
          defaultDir.issues.some(
            (issue) =>
              issue.code === 'invalid-report-directory' &&
              /symbolic link/i.test(issue.message)
          )
        ).toBe(true);
      } finally {
        fs.rmSync(linkedRoot, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('rejects repository credential files that Git does not ignore', () => {
    const unignoredDir = fs.mkdtempSync(path.join(ROOT, '.staging-env-'));
    const unignoredFile = path.join(unignoredDir, 'credentials');
    fs.writeFileSync(unignoredFile, envFileText(), 'utf8');
    fs.chmodSync(unignoredFile, 0o600);
    try {
      const result = loadConfig({
        cwd: ROOT,
        env: {},
        envFile: path.relative(ROOT, unignoredFile),
      });
      expect(
        result.issues.some((issue) => issue.code === 'env-file-not-ignored')
      ).toBe(true);
      expect(JSON.stringify(result.issues)).not.toContain(LOCAL_TOKEN);
    } finally {
      fs.rmSync(unignoredDir, { recursive: true, force: true });
    }
  });

  test('accepts an ignored private repository credential file', () => {
    fs.mkdirSync(path.join(ROOT, 'artifacts'), { recursive: true });
    const dir = fs.mkdtempSync(path.join(ROOT, 'artifacts', 'env-file-'));
    const file = path.join(dir, '.env.staging');
    fs.writeFileSync(file, envFileText(), 'utf8');
    fs.chmodSync(file, 0o600);
    try {
      const result = loadConfig({
        cwd: ROOT,
        env: {},
        envFile: path.relative(ROOT, file),
      });
      expect(result.issues).toEqual([]);
      expect(result.config.local.host).toBe(LOCAL_HOST);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('checks the resolved target of a symlinked credential file', () => {
    fs.mkdirSync(path.join(ROOT, 'artifacts'), { recursive: true });
    const unignoredDir = fs.mkdtempSync(path.join(ROOT, '.staging-env-target-'));
    const ignoredDir = fs.mkdtempSync(path.join(ROOT, 'artifacts', 'env-link-'));
    const target = path.join(unignoredDir, 'credentials');
    const link = path.join(ignoredDir, '.env.staging');
    fs.writeFileSync(target, envFileText(), 'utf8');
    fs.chmodSync(target, 0o600);
    fs.symlinkSync(target, link);
    try {
      const result = loadConfig({
        cwd: ROOT,
        env: {},
        envFile: path.relative(ROOT, link),
      });
      expect(
        result.issues.some((issue) => issue.code === 'env-file-not-ignored')
      ).toBe(true);
      expect(JSON.stringify(result.issues)).not.toContain(LOCAL_TOKEN);
    } finally {
      fs.rmSync(unignoredDir, { recursive: true, force: true });
      fs.rmSync(ignoredDir, { recursive: true, force: true });
    }
  });

  test('rejects malformed project keys and duplicate entries', () => {
    const invalid = buildFrom({ STAGING_LOCAL_PROJECTS: 'bad/key' });
    const duplicate = buildFrom({ STAGING_LOCAL_PROJECTS: 'STG,STG' });

    expect(invalid.issues.some((issue) => issue.code === 'invalid-project-key')).toBe(true);
    expect(
      duplicate.issues.some((issue) => issue.code === 'duplicate-project-key')
    ).toBe(true);
  });
});

describe('read-only Jira client', () => {
  function site() {
    return { role: 'local', host: LOCAL_HOST, origin: `https://${LOCAL_HOST}` };
  }

  function makeClient(request, overrides = {}) {
    return new JiraReadOnlyClient({
      site: site(),
      email: LOCAL_EMAIL,
      apiToken: LOCAL_TOKEN,
      request,
      sleep: jest.fn().mockResolvedValue(undefined),
      maxRetries: 2,
      retryMaxWaitMs: 1000,
      ...overrides,
    });
  }

  test('only permits exact read-only endpoints and validated parameters', async () => {
    expect(assertReadOnlyEndpoint('/rest/api/3/myself')).toEqual({ kind: 'myself' });
    expect(assertReadOnlyEndpoint('/rest/api/3/project/STG')).toEqual({
      kind: 'project',
      key: 'STG',
    });

    const request = jest.fn().mockResolvedValue(response(200, {}));
    const client = makeClient(request);

    const invalidCalls = [
      () => client.get('/rest/api/3/issue'),
      () => client.get('/rest/api/3/project/search?startAt=0'),
      () => client.get('/rest/api/3/project/search', { maxResults: 101 }),
      () => client.get('/rest/api/3/project/BAD%2FKEY'),
      () => client.get('/rest/api/3/project/search', { startAt: -1 }),
      () => client.get('/rest/api/3/mypermissions', { permissions: 'BROWSE_PROJECTS;DROP' }),
    ];

    for (const call of invalidCalls) {
      await expect(call()).rejects.toMatchObject({ code: 'endpoint-not-allowed' });
    }
    expect(request).not.toHaveBeenCalled();
  });

  test('builds encoded queries and sends GET-only requests with basic auth', async () => {
    const request = jest.fn().mockResolvedValue(response(200, { ok: true }));
    const client = makeClient(request);

    await client.get('/rest/api/3/project/search', {
      startAt: 0,
      maxResults: 50,
      status: ['live', 'archived'],
      orderBy: 'key',
    });

    const [url, options] = request.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.origin).toBe(`https://${LOCAL_HOST}`);
    expect(parsed.searchParams.getAll('status')).toEqual(['live', 'archived']);
    expect(parsed.searchParams.get('orderBy')).toBe('key');
    expect(options.method).toBeUndefined();
    expect(options.headers.Authorization).toBe(
      `Basic ${Buffer.from(`${LOCAL_EMAIL}:${LOCAL_TOKEN}`).toString('base64')}`
    );
  });

  test('redacts credentials from Jira error messages', async () => {
    const request = jest
      .fn()
      .mockResolvedValue(response(401, { errorMessages: [`denied ${LOCAL_TOKEN}`] }));
    const client = makeClient(request);

    let error;
    try {
      await client.get('/rest/api/3/myself');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(JiraRequestError);
    expect(error.code).toBe('authentication');
    expect(error.status).toBe(401);
    expect(error.message).not.toContain(LOCAL_TOKEN);
    expect(error.message).toContain('[REDACTED]');
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('honours Retry-After for bounded 429 retries', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(response(429, {}, { 'retry-after': '0' }))
      .mockResolvedValueOnce(response(200, { ok: true }));
    const sleep = jest.fn().mockResolvedValue(undefined);
    const client = makeClient(request, { sleep });

    await expect(client.get('/rest/api/3/myself')).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0);
  });

  test('stops after the configured retry budget for rate limiting', async () => {
    const request = jest
      .fn()
      .mockResolvedValue(response(429, {}, { 'retry-after': '0' }));
    const client = makeClient(request);

    await expect(client.get('/rest/api/3/myself')).rejects.toMatchObject({
      code: 'rate-limited',
      status: 429,
      attempts: 3,
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  test('does not retry authorization failures', async () => {
    const request = jest
      .fn()
      .mockResolvedValue(response(403, { errorMessages: ['forbidden'] }));
    const client = makeClient(request);

    await expect(client.get('/rest/api/3/myself')).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
      attempts: 1,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('accepts the documented HTTP 200 response for every read-only endpoint', async () => {
    const endpoints = [
      '/rest/api/3/myself',
      '/rest/api/3/project/search',
      '/rest/api/3/mypermissions',
      '/rest/api/3/project/STG',
    ];

    for (const endpoint of endpoints) {
      const body = { endpoint };
      const request = jest.fn().mockResolvedValue(response(200, body));
      await expect(makeClient(request).get(endpoint)).resolves.toEqual(body);
      expect(request).toHaveBeenCalledTimes(1);
    }
  });

  test('rejects unexpected successful HTTP statuses without retrying', async () => {
    const endpoints = [
      '/rest/api/3/myself',
      '/rest/api/3/project/search',
      '/rest/api/3/mypermissions',
      '/rest/api/3/project/STG',
    ];
    const statuses = [201, 202, 204, 206, 299];

    for (const endpoint of endpoints) {
      for (const status of statuses) {
        const request = jest
          .fn()
          .mockResolvedValue(response(status, { errorMessages: ['simulated'] }));
        await expect(makeClient(request).get(endpoint)).rejects.toMatchObject({
          code: 'unexpected-status',
          status,
          attempts: 1,
        });
        expect(request).toHaveBeenCalledTimes(1);
      }
    }
  });

  test('retries transient server failures and fails after the budget', async () => {
    const transient = jest
      .fn()
      .mockResolvedValueOnce(response(503, {}))
      .mockResolvedValueOnce(response(200, { ok: true }));
    await expect(makeClient(transient).get('/rest/api/3/myself')).resolves.toEqual({
      ok: true,
    });

    const persistent = jest.fn().mockResolvedValue(response(503, {}));
    await expect(makeClient(persistent).get('/rest/api/3/myself')).rejects.toMatchObject({
      code: 'server',
      status: 503,
      attempts: 3,
    });
  });
});


describe('native HTTP diagnostic disclosure', () => {
  function runCredentialScenario(nodeDebug) {
    const email = 'synthetic-debug-user@example.test';
    const token = 'synthetic-debug-token-1234567890';
    const encoded = Buffer.from(`${email}:${token}`, 'utf8').toString('base64');
    const authorization = `Basic ${encoded}`;
    const script = `
const { JiraReadOnlyClient } = require(${JSON.stringify(
      path.join(ROOT, 'scripts', 'staging', 'lib', 'http.js')
    )});
let requests = 0;
try {
  const client = new JiraReadOnlyClient({
    site: { origin: 'https://${LOCAL_HOST}', host: '${LOCAL_HOST}' },
    email: process.env.STAGING_TEST_EMAIL,
    apiToken: process.env.STAGING_TEST_TOKEN,
    request: () => {
      requests += 1;
      return Promise.resolve({ status: 200, headers: {}, body: { ok: true } });
    }
  });
  client.get('/rest/api/3/myself').then(
    () => { process.stdout.write('requests=' + requests + '\\n'); },
    (error) => {
      process.stderr.write(((error && error.message) || 'request failed') + '\\n');
      process.exitCode = 3;
    }
  );
} catch (error) {
  process.stdout.write('rejected requests=' + requests + '\\n');
  process.stderr.write(((error && error.message) || 'rejected') + '\\n');
  process.exitCode = 2;
}
`;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NODE_DEBUG: nodeDebug,
        STAGING_TEST_EMAIL: email,
        STAGING_TEST_TOKEN: token,
      },
      encoding: 'utf8',
      timeout: 20000,
    });

    return {
      result,
      output: `${result.stdout}${result.stderr}`,
      email,
      token,
      encoded,
      authorization,
    };
  }

  function expectNoCredentialDisclosure(run) {
    expect(run.output).not.toContain(run.token);
    expect(run.output).not.toContain(run.encoded);
    expect(run.output).not.toContain(run.authorization);
    expect(run.output).not.toContain(run.email);
  }

  test('detects exact and wildcard debug patterns conservatively', () => {
    for (const nodeDebug of [
      'http',
      'HTTPS',
      'worker, HTTP',
      'net,https',
      '*',
      'http*',
      'HTTP*',
      'net,h*,fs',
      '*ttps',
      'diagnostics,http*,worker',
    ]) {
      expect(() => assertSafeNodeDebug({ NODE_DEBUG: nodeDebug })).toThrow(
        /NODE_DEBUG/
      );
    }

    expect(() =>
      assertSafeNodeDebug({ NODE_DEBUG: 'net,fs' })
    ).not.toThrow();
    expect(() =>
      assertSafeNodeDebug({ NODE_DEBUG: 'diagnostics,worker' })
    ).not.toThrow();
    expect(() => assertSafeNodeDebug({})).not.toThrow();
  });

  test.each([
    ['http'],
    ['https'],
    ['HTTPS'],
    ['HTTP,HTTPS'],
    ['net,http'],
    ['diagnostics,https,worker'],
    ['http*'],
    ['HTTP*'],
    ['net,h*,fs'],
    ['*ttps'],
    ['*'],
    ['diagnostics,http*,worker'],
  ])(
    'refuses credential-bearing execution when NODE_DEBUG includes %s',
    (nodeDebug) => {
      const run = runCredentialScenario(nodeDebug);

      expect(run.result.status).toBe(2);
      expect(run.result.stdout).toContain('rejected requests=0');
      expect(run.result.stdout).not.toContain('requests=1');
      expect(run.output).not.toContain(`NODE_DEBUG=${nodeDebug}`);
      expectNoCredentialDisclosure(run);
    }
  );

  test('allows unrelated exact namespaces that do not expose request headers', () => {
    const run = runCredentialScenario('net,fs');

    expect(run.result.status).toBe(0);
    expect(run.result.stdout).toContain('requests=1');
    expectNoCredentialDisclosure(run);
  });
});

describe('project inventory and permissions', () => {
  test('paginates the complete accessible project inventory', async () => {
    const client = {
      get: jest
        .fn()
        .mockResolvedValueOnce({
          values: [project('100', 'STG')],
          total: 2,
          isLast: false,
          startAt: 0,
        })
        .mockResolvedValueOnce({
          values: [project('101', 'DEV')],
          total: 2,
          isLast: true,
          startAt: 1,
        }),
    };

    const result = await fetchAccessibleProjects(client, { pageSize: 1, maxPages: 5 });
    expect(result.complete).toBe(true);
    expect(result.projects.map((entry) => entry.key)).toEqual(['STG', 'DEV']);
    expect(result.pages).toBe(2);
    expect(client.get).toHaveBeenNthCalledWith(1, '/rest/api/3/project/search', {
      startAt: 0,
      maxResults: 1,
      status: ['live', 'archived'],
      orderBy: 'key',
    });
  });

  test('fails closed when pagination stops making progress', async () => {
    const client = {
      get: jest.fn().mockResolvedValue({
        values: [],
        total: 5,
        isLast: false,
        startAt: 0,
      }),
    };

    await expect(
      fetchAccessibleProjects(client, { pageSize: 50, maxPages: 5 })
    ).rejects.toMatchObject({ code: 'incomplete-pagination' });
  });

  test('fails closed when the page cap is reached before the inventory is complete', async () => {
    const client = {
      get: jest.fn().mockResolvedValue({
        values: [project('100', 'STG')],
        total: 100,
        isLast: false,
        startAt: 0,
      }),
    };

    await expect(
      fetchAccessibleProjects(client, { pageSize: 1, maxPages: 2 })
    ).rejects.toMatchObject({ code: 'incomplete-pagination' });
  });

  test('requires every requested permission to be present in the response', async () => {
    const granted = {
      get: jest.fn().mockResolvedValue({
        permissions: { BROWSE_PROJECTS: { havePermission: true } },
      }),
    };
    await expect(
      fetchPermissions(granted, 'STG', ['BROWSE_PROJECTS'])
    ).resolves.toEqual({ BROWSE_PROJECTS: true });

    const incomplete = {
      get: jest.fn().mockResolvedValue({ permissions: {} }),
    };
    await expect(
      fetchPermissions(incomplete, 'STG', ['BROWSE_PROJECTS'])
    ).rejects.toMatchObject({ code: 'permission-response-incomplete' });
  });
});

describe('isolation evidence', () => {
  const accessible = [
    project('100', 'STG', 'Staging'),
    project('101', 'DEV', 'Development'),
  ];

  function evaluate(overrides = {}) {
    return evaluateSiteIsolation({
      role: 'local',
      host: LOCAL_HOST,
      stagingProjects: [{ key: 'STG', id: '100', name: 'Staging' }],
      configuredNonStagingProjects: ['DEV'],
      accessibleProjects: accessible,
      ...overrides,
    });
  }

  test('verifies a fully classified, disjoint inventory and hashes the evidence', () => {
    const result = evaluate();
    expect(result.verified).toBe(true);
    expect(result.overlaps).toEqual([]);
    expect(result.unclassified).toEqual([]);
    expect(result.missingNonStaging).toEqual([]);
    expect(result.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test('rejects project-id overlap even when keys differ', () => {
    const result = evaluate({
      accessibleProjects: [
        project('100', 'STG', 'Staging'),
        project('100', 'DEV', 'Development'),
      ],
    });
    expect(result.verified).toBe(false);
    expect(result.overlaps).toEqual([
      expect.objectContaining({ key: 'DEV', reason: 'project-id-overlap' }),
    ]);
  });

  test('rejects unclassified accessible projects', () => {
    const result = evaluate({
      accessibleProjects: [...accessible, project('102', 'UNKNOWN', 'Unclassified')],
    });
    expect(result.verified).toBe(false);
    expect(result.unclassified.map((entry) => entry.key)).toEqual(['UNKNOWN']);
  });

  test('rejects missing non-staging projects instead of assuming they are absent', () => {
    const result = evaluate({
      accessibleProjects: [project('100', 'STG', 'Staging')],
    });
    expect(result.verified).toBe(false);
    expect(result.missingNonStaging.map((entry) => entry.key)).toEqual(['DEV']);
  });

  test('rejects an unverified staging project', () => {
    const result = evaluate({ stagingProjects: [{ key: 'STG', id: null }] });
    expect(result.verified).toBe(false);
    expect(result.missingStaging.map((entry) => entry.key)).toEqual(['STG']);
  });
});


describe('staging preflight orchestration', () => {
  function checkById(report, id) {
    return report.checks.find((entry) => entry.id === id);
  }

  function grantedFor(keys) {
    const granted = {};
    keys.forEach((key) => {
      granted[key] = true;
    });
    return granted;
  }

  function healthyJira(config) {
    const localProjects = [project('100', 'STG', 'Staging'), project('101', 'DEV', 'Development')];
    const remoteProjects = [
      project('200', 'RSTG', 'Remote Staging'),
      project('201', 'RDEV', 'Remote Development'),
    ];
    const permissionKeys = ['BROWSE_PROJECTS', ...config.e2ePermissions];

    return fakeJira({
      projects: {
        [LOCAL_HOST]: localProjects,
        [REMOTE_HOST]: remoteProjects,
      },
      identities: {
        [LOCAL_HOST]: {
          accountId: 'local-account',
          active: true,
          accountType: 'atlassian',
          emailAddress: LOCAL_EMAIL,
        },
        [REMOTE_HOST]: {
          accountId: 'remote-account',
          active: true,
          accountType: 'atlassian',
          emailAddress: REMOTE_EMAIL,
        },
      },
      permissions: {
        [LOCAL_HOST]: { STG: grantedFor(permissionKeys) },
        [REMOTE_HOST]: { RSTG: grantedFor(permissionKeys) },
      },
    });
  }

  function run(config, jira, overrides = {}) {
    return runPreflight({
      config,
      request: jira.handler,
      now: () => new Date('2026-10-24T12:00:00.000Z'),
      runId: 'run-test-1',
      ...overrides,
    });
  }

  test('passes all verifiable checks, withholds certification, and leaks no credentials', async () => {
    const config = validConfig();
    const jira = healthyJira(config);
    const report = await run(config, jira);

    expect(report.schemaVersion).toBe(SCHEMA_VERSION);
    expect(report.kind).toBe('jira-sync-staging-preflight');
    expect(report.mode).toBe('read-only');
    expect(report.summary.status).toBe('pass');
    expect(report.summary.exitCode).toBe(EXIT_CODES.PASS);
    expect(report.summary.certification).toBe('withheld');
    expect(checkById(report, 'configuration').status).toBe('pass');
    expect(checkById(report, 'host-allow-list').status).toBe('pass');
    expect(checkById(report, 'authentication').status).toBe('pass');
    expect(checkById(report, 'accessible-projects').status).toBe('pass');
    expect(checkById(report, 'staging-projects').status).toBe('pass');
    expect(checkById(report, 'permissions').status).toBe('pass');
    expect(checkById(report, 'isolation').status).toBe('unknown');
    expect(checkById(report, 'forge-staging-installation').status).toBe('unknown');
    expect(checkById(report, 'f07-migration-state').status).toBe('unknown');
    expect(report.isolation.verified).toBe(false);
    expect(report.isolation.classificationVerified).toBe(true);
    expect(report.isolation.operationalIsolation.status).toBe('unknown');
    expect(report.isolation.local.classificationVerified).toBe(true);
    expect(report.isolation.local.verified).toBeUndefined();
    expect(report.isolation.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(LOCAL_TOKEN);
    expect(serialized).not.toContain(REMOTE_TOKEN);
    expect(serialized).not.toContain(LOCAL_EMAIL);
    expect(serialized).not.toContain(REMOTE_EMAIL);
    expect(serialized).toContain('l***@example.com');

    const paths = jira.calls.map((call) => call.url.pathname);
    expect(paths.every((value) => value.startsWith('/rest/api/3/'))).toBe(true);
    expect(
      paths.every((value) =>
        [
          '/rest/api/3/myself',
          '/rest/api/3/project/search',
          '/rest/api/3/mypermissions',
          '/rest/api/3/project/STG',
          '/rest/api/3/project/RSTG',
        ].includes(value)
      )
    ).toBe(true);
  });


  test('fails closed on authentication errors and redacts the response body', async () => {
    const config = validConfig();
    const jira = healthyJira(config);
    jira.handler = ((base) => (url, options) => {
      const parsed = new URL(url);
      if (parsed.hostname === LOCAL_HOST && parsed.pathname === '/rest/api/3/myself') {
        return Promise.resolve(
          response(401, { errorMessages: [`invalid credential ${LOCAL_TOKEN}`] })
        );
      }
      return base(url, options);
    })(jira.handler);

    const report = await run(config, jira);
    expect(report.summary.status).toBe('fail');
    expect(report.summary.exitCode).toBe(EXIT_CODES.FAIL);
    expect(checkById(report, 'authentication').status).toBe('fail');
    expect(checkById(report, 'authentication').detail).toContain('[REDACTED]');
    expect(JSON.stringify(report)).not.toContain(LOCAL_TOKEN);
    expect(report.nextActions.join(' ')).toContain('STAGING_LOCAL_EMAIL');
  });

  test('detects missing configuration without making any request', async () => {
    const { config } = buildConfig({}, { cwd: ROOT });
    const request = jest.fn();
    const report = await runPreflight({
      config,
      request,
      now: () => new Date('2026-10-24T12:00:00.000Z'),
      runId: 'run-config-missing',
    });

    expect(request).not.toHaveBeenCalled();
    expect(report.summary.status).toBe('fail');
    expect(report.summary.exitCode).toBe(EXIT_CODES.FAIL);
    expect(checkById(report, 'configuration').status).toBe('fail');
    expect(checkById(report, 'authentication').status).toBe('skipped');
    expect(report.nextActions.join(' ')).toContain('STAGING_LOCAL_API_TOKEN');
    expect(JSON.stringify(report)).not.toContain(LOCAL_TOKEN);
  });

  test('fails when a configured staging project is absent or inaccessible', async () => {
    const config = validConfig();
    const jira = healthyJira(config);
    jira.handler = ((base) => (url, options) => {
      const parsed = new URL(url);
      if (parsed.hostname === LOCAL_HOST && parsed.pathname === '/rest/api/3/project/STG') {
        return Promise.resolve(response(404, { errorMessages: ['missing'] }));
      }
      return base(url, options);
    })(jira.handler);

    const report = await run(config, jira);
    expect(report.summary.status).toBe('fail');
    expect(checkById(report, 'staging-projects').status).toBe('fail');
    expect(checkById(report, 'isolation').status).toBe('fail');
    expect(report.nextActions.join(' ')).toContain('STG');
  });

  test('fails when the required browse permission is not granted', async () => {
    const config = validConfig();
    const jira = healthyJira(config);
    jira.handler = ((base) => (url, options) => {
      const parsed = new URL(url);
      if (
        parsed.hostname === LOCAL_HOST &&
        parsed.pathname === '/rest/api/3/mypermissions' &&
        parsed.searchParams.get('projectKey') === 'STG'
      ) {
        const requested = parsed.searchParams.get('permissions').split(',');
        const payload = {};
        requested.forEach((key) => {
          payload[key] = { key, havePermission: key !== 'BROWSE_PROJECTS' };
        });
        return Promise.resolve(response(200, { permissions: payload }));
      }
      return base(url, options);
    })(jira.handler);

    const report = await run(config, jira);
    expect(report.summary.status).toBe('fail');
    expect(checkById(report, 'permissions').status).toBe('fail');
    expect(report.nextActions.join(' ')).toContain('BROWSE_PROJECTS');
  });


  test('refuses to certify isolation when an accessible project is unclassified', async () => {
    const config = validConfig();
    const jira = healthyJira(config);
    jira.handler = ((base) => (url, options) => {
      const parsed = new URL(url);
      if (parsed.hostname === LOCAL_HOST && parsed.pathname === '/rest/api/3/project/search') {
        return Promise.resolve(
          response(200, {
            values: [
              project('100', 'STG', 'Staging'),
              project('101', 'DEV', 'Development'),
              project('102', 'EXTRA', 'Unclassified'),
            ],
            total: 3,
            isLast: true,
            startAt: 0,
          })
        );
      }
      return base(url, options);
    })(jira.handler);

    const report = await run(config, jira);
    expect(report.summary.status).toBe('fail');
    expect(checkById(report, 'isolation').status).toBe('fail');
    expect(checkById(report, 'isolation').detail).toContain('EXTRA');
    expect(report.nextActions.join(' ')).toContain('STAGING_LOCAL_NON_STAGING_PROJECTS');
  });

  test('never trusts environment claims for Forge or F07 state', async () => {
    const config = validConfig({
      STAGING_FORGE_INSTALLED: 'verified',
      STAGING_F07_MIGRATION_STATE: 'active',
    });
    const report = await run(config, healthyJira(config));

    expect(checkById(report, 'forge-staging-installation').status).toBe('unknown');
    expect(checkById(report, 'f07-migration-state').status).toBe('unknown');
    expect(report.forge.status).toBe('unknown');
    expect(report.f07.status).toBe('unknown');
    expect(report.summary.certification).toBe('withheld');
  });
});


describe('report validation', () => {
  let baseReport;

  beforeAll(async () => {
    baseReport = await healthyPersistedReport('run-validation-base');
  });

  function copy() {
    return JSON.parse(JSON.stringify(baseReport));
  }

  test('accepts a structurally consistent persisted report', () => {
    expect(validateReport(copy())).toEqual(baseReport);
  });

  test.each([
    [
      'a missing required check',
      (report) => {
        report.checks = report.checks.filter(
          (entry) => entry.id !== 'permissions'
        );
      },
    ],
    [
      'a duplicate check identifier',
      (report) => {
        report.checks.push({ ...report.checks[0] });
      },
    ],
    [
      'an invalid check status',
      (report) => {
        report.checks[0].status = 'ok';
      },
    ],
    [
      'summary counts that do not match the checks',
      (report) => {
        report.summary.checks.pass += 1;
      },
    ],
    [
      'a failed check with a passing summary',
      (report) => {
        const target = report.checks.find(
          (entry) => entry.id === 'permissions'
        );
        target.status = 'fail';
        report.summary.checks.pass -= 1;
        report.summary.checks.fail += 1;
        report.summary.failedChecks = ['permissions'];
        report.summary.status = 'pass';
        report.summary.exitCode = EXIT_CODES.PASS;
      },
    ],
    [
      'a certification contradiction',
      (report) => {
        report.summary.certification = 'certified';
      },
    ],
    [
      'an unsupported persisted exit code',
      (report) => {
        report.summary.exitCode = EXIT_CODES.ERROR;
      },
    ],
    [
      'a failed-check list that contradicts the checks',
      (report) => {
        report.summary.failedChecks = ['not-a-real-check'];
      },
    ],
    [
      'a verified operational-isolation claim',
      (report) => {
        report.isolation.verified = true;
      },
    ],
    [
      'a passing operational-isolation check',
      (report) => {
        report.checks.find((entry) => entry.id === 'isolation').status = 'pass';
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const report = copy();
    mutate(report);
    expect(() => validateReport(report)).toThrow(/invalid preflight report/i);
  });

  test('the terminal renderer refuses contradictory reports instead of printing a pass', () => {
    const report = copy();
    const target = report.checks.find((entry) => entry.id === 'permissions');
    target.status = 'fail';
    report.summary.checks.pass -= 1;
    report.summary.checks.fail += 1;
    report.summary.failedChecks = ['permissions'];
    report.summary.status = 'pass';
    report.summary.exitCode = EXIT_CODES.PASS;

    expect(() => formatTerminalReport(report)).toThrow(
      /invalid preflight report/i
    );
  });
});

describe('report storage and rendering', () => {
  test('writes private JSON reports and keeps latest.json in sync', async () => {
    const config = validConfig();
    const jira = fakeJira({
      projects: {
        [LOCAL_HOST]: [project('100', 'STG'), project('101', 'DEV')],
        [REMOTE_HOST]: [project('200', 'RSTG'), project('201', 'RDEV')],
      },
      permissions: {
        [LOCAL_HOST]: { STG: { BROWSE_PROJECTS: true } },
        [REMOTE_HOST]: { RSTG: { BROWSE_PROJECTS: true } },
      },
    });
    const report = await runPreflight({
      config,
      request: jira.handler,
      now: () => new Date('2026-10-24T12:00:00.000Z'),
      runId: 'run-report-1',
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-report-'));
    const root = path.join(dir, 'artifacts', 'staging-preflight');
    const written = writeReport({ cwd: dir, dir: root, report });

    expect(fs.existsSync(written.runPath)).toBe(true);
    expect(fs.existsSync(written.latestPath)).toBe(true);
    expect(path.basename(written.runPath)).toContain('run-report-1');

    if (process.platform !== 'win32') {
      expect(fs.statSync(written.runPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(written.latestPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(written.dir).mode & 0o777).toBe(0o700);
    }

    expect(readReport(written.latestPath)).toEqual(report);
    expect(latestReportPath(written.dir)).toBe(written.latestPath);

    const terminal = formatTerminalReport(report);
    expect(terminal).toContain('PREFLIGHT PASSED');
    expect(terminal).toContain('CERTIFICATION WITHHELD');
    expect(terminal).toContain('sha256:');
    expect(terminal).not.toContain(LOCAL_TOKEN);
    expect(terminal).not.toContain(REMOTE_TOKEN);
    expect(terminal).not.toContain(LOCAL_EMAIL);
  });

  test('refuses report paths outside the canonical artifact subtree', async () => {
    const report = await healthyPersistedReport('run-path-safety');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-report-root-'));
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), 'staging-report-outside-')
    );
    try {
      expect(() =>
        writeReport({
          cwd: root,
          dir: path.join(root, 'public-reports'),
          report,
        })
      ).toThrow(/artifacts/i);

      fs.mkdirSync(path.join(root, 'artifacts'));
      fs.symlinkSync(
        outside,
        path.join(root, 'artifacts', 'escape'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      expect(() =>
        writeReport({
          cwd: root,
          dir: path.join(root, 'artifacts', 'escape'),
          report,
        })
      ).toThrow(/artifacts|symlink|outside/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }

    const linkedRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'staging-report-linked-')
    );
    try {
      const unignoredTarget = path.join(linkedRoot, 'public-reports');
      fs.mkdirSync(unignoredTarget);
      fs.symlinkSync(
        unignoredTarget,
        path.join(linkedRoot, 'artifacts'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      expect(() =>
        writeReport({
          cwd: linkedRoot,
          dir: path.join(linkedRoot, 'artifacts', 'staging-preflight'),
          report,
        })
      ).toThrow(/symbolic link/i);
    } finally {
      fs.rmSync(linkedRoot, { recursive: true, force: true });
    }
  });

  test('refuses an existing report directory with unsafe permissions', async () => {
    const report = await healthyPersistedReport('run-path-permissions');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-report-mode-'));
    const dir = path.join(root, 'artifacts', 'staging-preflight');
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o755);
    try {
      expect(() => writeReport({ cwd: root, dir, report })).toThrow(
        /permissions/i
      );
      fs.chmodSync(dir, 0o700);
      expect(() => writeReport({ cwd: root, dir, report })).not.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses to persist a structurally invalid report', async () => {
    const report = await healthyPersistedReport('run-invalid-write');
    report.checks[0].status = 'invalid';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-report-bad-'));
    try {
      expect(() =>
        writeReport({
          cwd: root,
          dir: path.join(root, 'artifacts', 'staging-preflight'),
          report,
        })
      ).toThrow(/invalid preflight report/i);
      expect(fs.existsSync(path.join(root, 'artifacts'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('persists a valid failing report without changing its exit semantics', async () => {
    const { config } = buildConfig({}, { cwd: ROOT });
    const report = await runPreflight({
      config,
      request: jest.fn(),
      now: () => new Date('2026-10-24T12:00:00.000Z'),
      runId: 'run-valid-failure',
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-report-fail-'));
    try {
      const written = writeReport({
        cwd: root,
        dir: path.join(root, 'artifacts', 'staging-preflight'),
        report,
      });
      const persisted = readReport(written.latestPath);
      expect(persisted.summary.status).toBe('fail');
      expect(persisted.summary.exitCode).toBe(EXIT_CODES.FAIL);
      expect(formatTerminalReport(persisted)).toContain('PREFLIGHT FAILED');
      expect(formatTerminalReport(persisted)).not.toContain('PREFLIGHT PASSED');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects oversized or malformed report files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-report-bad-'));
    const malformed = path.join(dir, 'bad.json');
    fs.writeFileSync(malformed, '{not json', 'utf8');
    expect(() => readReport(malformed)).toThrow(/valid JSON/i);

    const wrongKind = path.join(dir, 'wrong.json');
    fs.writeFileSync(wrongKind, JSON.stringify({ schemaVersion: 1, kind: 'other' }), 'utf8');
    expect(() => readReport(wrongKind)).toThrow(/preflight report/i);

    const huge = path.join(dir, 'huge.json');
    fs.writeFileSync(huge, 'x'.repeat(5 * 1024 * 1024), 'utf8');
    expect(() => readReport(huge)).toThrow(/too large|valid JSON/i);
  });
});


describe('command-line interface', () => {
  function runNode(script, args, cwd) {
    return spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NO_COLOR: '1',
      },
      encoding: 'utf8',
      timeout: 20000,
    });
  }

  test('returns a nonzero code and actionable output when configuration is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-cli-missing-'));
    const result = runNode('scripts/staging/preflight.js', ['--json', '--no-report'], dir);

    expect(result.status).toBe(EXIT_CODES.FAIL);
    const report = JSON.parse(result.stdout);
    expect(report.summary.exitCode).toBe(EXIT_CODES.FAIL);
    expect(report.checks.find((entry) => entry.id === 'configuration').status).toBe('fail');
    expect(report.nextActions.join(' ')).toContain('STAGING_LOCAL_API_TOKEN');
    expect(result.stdout).not.toContain(LOCAL_TOKEN);
  });

  test('refuses to read a world-readable environment file before requesting Jira', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-cli-perms-'));
    const file = path.join(dir, '.env.staging');
    fs.writeFileSync(file, envFileText(), 'utf8');
    fs.chmodSync(file, 0o644);

    const result = runNode(
      'scripts/staging/preflight.js',
      ['--json', '--no-report', '--env-file', '.env.staging'],
      dir
    );

    expect(result.status).toBe(EXIT_CODES.FAIL);
    const report = JSON.parse(result.stdout);
    expect(JSON.stringify(report)).toContain('chmod 600');
    expect(JSON.stringify(report)).not.toContain(LOCAL_TOKEN);
    expect(JSON.stringify(report)).not.toContain(REMOTE_TOKEN);
  });

  test('renders a persisted report and preserves its exit status', async () => {
    const config = validConfig();
    const jira = fakeJira({
      projects: {
        [LOCAL_HOST]: [project('100', 'STG'), project('101', 'DEV')],
        [REMOTE_HOST]: [project('200', 'RSTG'), project('201', 'RDEV')],
      },
      permissions: {
        [LOCAL_HOST]: { STG: { BROWSE_PROJECTS: true } },
        [REMOTE_HOST]: { RSTG: { BROWSE_PROJECTS: true } },
      },
    });
    const report = await runPreflight({
      config,
      request: jira.handler,
      now: () => new Date('2026-10-24T12:00:00.000Z'),
      runId: 'run-cli-report',
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-cli-report-'));
    const written = writeReport({
      cwd: dir,
      dir: path.join(dir, 'artifacts', 'staging-preflight'),
      report,
    });

    const result = runNode(
      'scripts/staging/report.js',
      ['--input', written.latestPath, '--json'],
      dir
    );
    expect(result.status).toBe(EXIT_CODES.PASS);
    expect(JSON.parse(result.stdout).runId).toBe('run-cli-report');
    expect(result.stdout).not.toContain(LOCAL_TOKEN);
  });

  test('returns an error instead of a pass for a contradictory report', async () => {
    const report = await healthyPersistedReport('run-cli-contradictory');
    report.checks.find((entry) => entry.id === 'permissions').status = 'fail';
    report.summary.checks.pass -= 1;
    report.summary.checks.fail += 1;
    report.summary.failedChecks = ['permissions'];
    report.summary.status = 'pass';
    report.summary.exitCode = EXIT_CODES.PASS;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-cli-bad-report-'));
    const reportPath = path.join(dir, 'report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report), 'utf8');
    const result = runNode(
      'scripts/staging/report.js',
      ['--input', reportPath],
      dir
    );

    expect(result.status).toBe(EXIT_CODES.ERROR);
    expect(result.stdout).not.toContain('PREFLIGHT PASSED');
    expect(result.stderr).toMatch(/invalid preflight report/i);
  });

  test('returns a distinct error code when the report does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-cli-no-report-'));
    const result = runNode('scripts/staging/report.js', ['--input', 'missing.json'], dir);

    expect(result.status).toBe(EXIT_CODES.ERROR);
    expect(result.stderr.toLowerCase()).toContain('report');
  });

  test('returns an error for a report with an unsupported exit code', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-cli-bad-exit-'));
    const reportPath = path.join(dir, 'report.json');
    fs.writeFileSync(
      reportPath,
      JSON.stringify({
        kind: 'jira-sync-staging-preflight',
        schemaVersion: '1.0',
        runId: 'run-bad-exit',
        summary: { status: 'pass', exitCode: 7 },
        checks: [],
      })
    );

    const result = runNode('scripts/staging/report.js', ['--input', reportPath], dir);

    expect(result.status).toBe(EXIT_CODES.ERROR);
  });
});
