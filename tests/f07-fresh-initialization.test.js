// Success uses the real installation-specific staging policy, without a provenance mock.
// KVS calls and entity probes use the installed SDK and local storage model.
jest.mock('@forge/api', () => ({
  __esModule: true, ...jest.requireActual('@forge/api'), getAppContext: jest.fn()
}));
const runtime = require('./helpers/forge-lease-runtime');
const api = require('@forge/api');
const {
  initializeFreshIssueLeases, FRESH_INITIALIZATION_CONFIRMATION
} = require('../src/services/sync/fresh-install-initialization');
const {
  readIssueLeaseMigrationState, evaluateIssueLeaseMigrationState,
  assertIssueLeaseMigrationReady, LEGACY_LEASE_DRAIN_MS
} = require('../src/services/sync/lease-migration');
const { assertJiraSubmissionAllowed } = require('../src/services/jira/guarded-api');
const NOW = Date.parse('2026-10-25T12:00:00Z');
const TARGET = {
  appId: '362d8e6b-b68c-4403-8020-d32ddcc02716',
  environmentId: '2e8c0cb5-881a-4345-b9ba-e887f790d316',
  installationId: '974910c5-2861-4d40-a7eb-37802842d0a0',
  siteHost: 'serdarjiraone.atlassian.net'
};
function context() {
  return {
    appAri: { appId: TARGET.appId, toString: () => `ari:cloud:ecosystem::app/${TARGET.appId}` },
    appVersion: '3.1.0', environmentAri: { environmentId: TARGET.environmentId },
    installationAri: { installationId: TARGET.installationId }, environmentType: 'STAGING'
  };
}
let readReadiness;
function invoke(payload = { confirmation: FRESH_INITIALIZATION_CONFIRMATION }, extra = {}) {
  return initializeFreshIssueLeases({ payload, deps: { readReadiness, now: () => NOW, ...extra } });
}
function writes() { return runtime.requests.filter(r => r.path === '/api/v1/set'); }
beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  runtime.state.migration = null;
  api.getAppContext.mockReturnValue(context());
  readReadiness = jest.fn(async () => ({
    success: true, ...TARGET, environment: 'STAGING', installedSites: [TARGET.siteHost],
    pause: { readable: true, paused: true },
    f07Status: await readIssueLeaseMigrationState(NOW)
  }));
});
afterEach(() => jest.restoreAllMocks());
test('rejects caller policy, provenance and state assertions', async () => {
  for (const field of ['fresh', 'provenance', 'policy', 'deps', 'state', 'retirement']) {
    expect(await invoke({ confirmation: FRESH_INITIALIZATION_CONFIRMATION, [field]: true }))
      .toMatchObject({ code: 'INVALID_FRESH_INITIALIZATION_INPUT' });
  }
  expect(writes()).toEqual([]);
});
test('requires exact confirmation', async () => {
  expect(await invoke({ confirmation: 'yes' })).toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
  expect(runtime.requests).toEqual([]);
});
test.each(['appId', 'environmentId', 'installationId'])('rejects runtime %s mismatch', async field => {
  const ctx = context();
  const fieldContainer = { appId: 'appAri', environmentId: 'environmentAri', installationId: 'installationAri' };
  ctx[fieldContainer[field]][field] = 'different';
  api.getAppContext.mockReturnValue(ctx);
  expect(await invoke()).toMatchObject({ code: 'FRESH_INSTALLATION_MISMATCH' });
  expect(writes()).toEqual([]);
});
test('rejects production, development and unavailable runtime identity', async () => {
  for (const environmentType of ['PRODUCTION', 'DEVELOPMENT', undefined]) {
    api.getAppContext.mockReturnValue({ ...context(), environmentType });
    expect(await invoke()).toMatchObject({ code: 'FRESH_INSTALLATION_MISMATCH' });
  }
  api.getAppContext.mockImplementationOnce(() => { throw Error('unavailable'); });
  expect(await invoke()).toMatchObject({ code: 'FRESH_INSTALLATION_MISMATCH' });
});
test.each(['siteHost', 'installationId', 'environmentId', 'appId', 'environment'])(
  'rejects readiness %s mismatch', async field => {
    const ready = await readReadiness();
    readReadiness.mockResolvedValue({ ...ready, [field]: 'different',
      ...(field === 'siteHost' ? { installedSites: ['different.atlassian.net'] } : {}) });
    expect(await invoke()).toMatchObject({ code: 'READINESS_BINDING_MISMATCH' });
    expect(writes()).toEqual([]);
  });
test.each([{}, false, 'malformed', { version: 1, phase: 'draining' }])(
  'never overwrites existing marker %p', async marker => {
    runtime.state.migration = marker;
    expect(await invoke()).toMatchObject({ code: 'F07_MARKER_EXISTS' });
    expect(writes()).toEqual([]);
  });
test.each([{ readable: true, paused: false }, { readable: false, paused: true }, {}])(
  'requires readable authoritative Pause %p', async pause => {
    const ready = await readReadiness(); readReadiness.mockResolvedValue({ ...ready, pause });
    expect(await invoke()).toMatchObject({ code: 'PAUSE_REQUIRED', error: expect.stringContaining('existing staging Pause control') });
    expect(writes()).toEqual([]);
  });
test('readiness and marker storage errors fail closed', async () => {
  readReadiness.mockRejectedValueOnce(Error('storage'));
  expect(await invoke()).toMatchObject({ code: 'FRESH_INITIALIZATION_UNAVAILABLE' });
  runtime.state.failure = Error('storage');
  expect(await invoke()).toMatchObject({ code: 'F07_STATE_UNREADABLE' });
  expect(writes()).toEqual([]);
});

test('registered administrator resolver succeeds with default readiness and audit services', async () => {
  const store = require('../src/services/storage/kvs');
  const { createAuthorizedHandler } = require('../src/resolvers/authorization');
  const { defineLeaseMigrationResolvers } = require('../src/resolvers/lease-migration');
  const audit = jest.spyOn(require('../src/services/storage/stats'), 'logAuditEntry');
  const seed = {
    pilotPause: { paused: true, reasonCode: 'emergency_stop' }, organizations: [], auditLog: [],
    'projectMappings:test': { MOB: 'VMOB' }, 'comment-fence:test': { token: 'retained' },
    'uncertain-operation:test': { status: 'unknown' }
  };
  const data = JSON.parse(JSON.stringify(seed));
  jest.spyOn(store, 'get').mockImplementation(async key => data[key] === undefined
    ? null : JSON.parse(JSON.stringify(data[key])));
  const set = jest.spyOn(store, 'set').mockImplementation(async (key, value) => {
    if (key !== 'auditLog') throw Error('Unexpected configuration write');
    data[key] = value;
  });
  const permission = jest.fn(async () => ({ ok: true,
    json: async () => ({ permissions: { ADMINISTER: { havePermission: true } } }) }));
  const siteInfo = jest.fn(async () => ({ ok: true,
    json: async () => ({ baseUrl: `https://${TARGET.siteHost}` }) }));
  jest.spyOn(api.default, 'asUser').mockReturnValue({ requestJira: permission });
  jest.spyOn(api.default, 'asApp').mockReturnValue({ requestJira: siteInfo });
  const handlers = {};
  defineLeaseMigrationResolvers({ define: (name, fn) => { handlers[name] = fn; } });
  const handler = createAuthorizedHandler('initializeFreshIssueLeases', handlers.initializeFreshIssueLeases);
  const result = await handler({ context: { accountId: 'test-admin' },
    payload: { confirmation: FRESH_INITIALIZATION_CONFIRMATION } });
  expect(result.code).toBeUndefined();
  expect(result).toMatchObject({ success: true, status: 'INITIALIZED', paused: true });
  expect(permission).toHaveBeenCalledTimes(1);
  expect(siteInfo).toHaveBeenCalledTimes(3);
  expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'initializeFreshIssueLeases', success: true,
    actorAccountId: 'test-admin', category: 'ADMIN_WRITE' }));
  expect(data.auditLog).toEqual([expect.objectContaining({ action: 'initializeFreshIssueLeases', success: true })]);
  expect(set).toHaveBeenCalledTimes(1);
  delete data.auditLog; delete seed.auditLog;
  expect(data).toEqual(seed);
  expect((await readIssueLeaseMigrationState()).valid).toBe(true);
  await expect(assertJiraSubmissionAllowed('https://jira.invalid/rest/api/3/issue', { method: 'POST' }))
    .rejects.toMatchObject({ code: 'PILOT_PAUSED' });
  expect(runtime.entities.size).toBe(0);
});

test.each(['appId', 'environmentId', 'installationId', 'siteHost'])(
  'v2 marker binding rejects a different %s', async field => {
    await invoke();
    runtime.state.migration[field] = 'different';
    expect((await readIssueLeaseMigrationState()).valid).toBe(false);
  });

test('v1 gate does not depend on the staging identity or policy', async () => {
  api.getAppContext.mockImplementationOnce(() => { throw Error('no context'); });
  runtime.state.migration = { version: 1, phase: 'entity-active', legacyDisabled: true,
    disabledAt: NOW - LEGACY_LEASE_DRAIN_MS, activatedAt: NOW };
  await expect(assertIssueLeaseMigrationReady()).resolves.toBeUndefined();
});

test('identity lost during the probe blocks initialization', async () => {
  runtime.state.beforeTransaction = () => api.getAppContext.mockReturnValue({});
  expect(await invoke()).toMatchObject({ code: 'FRESH_INSTALLATION_MISMATCH' });
  expect(writes()).toEqual([]);
});
test('exact staging installation can initialize with the real policy and production gate readback', async () => {
  const result = await invoke();
  expect(result).toMatchObject({ success: true, status: 'INITIALIZED', activation: {
    performed: true, wroteMigrationState: true
  } });
  expect(writes()).toHaveLength(1);
  expect(writes()[0].body.options).toEqual({ keyPolicy: 'FAIL_IF_EXISTS' });
  expect(runtime.state.migration).toMatchObject({ version: 2, basis: 'fresh-install',
    activatedAt: NOW, policy: 'disposable-staging-v1', ...TARGET });
  expect(runtime.state.migration).not.toHaveProperty('disabledAt');
  expect(await readIssueLeaseMigrationState(NOW)).toMatchObject({ valid: true });
  await expect(assertIssueLeaseMigrationReady()).resolves.toBeUndefined();
  expect(runtime.entities.size).toBe(0);
});
test('competing initializers preserve the single winner', async () => {
  const results = await Promise.all([invoke(), invoke()]);
  expect(results.filter(r => r.success)).toHaveLength(1);
  expect(results.filter(r => !r.success)).toHaveLength(1);
  expect(results.find(r => !r.success).code).toBe('F07_MARKER_EXISTS');
  expect(writes()).toHaveLength(2);
  expect(runtime.state.migration.version).toBe(2);
  expect(writes().every(r => r.body.options.keyPolicy === 'FAIL_IF_EXISTS')).toBe(true);
});
test('failed probe cannot write a marker', async () => {
  runtime.state.beforeTransaction = () => { throw Error('probe unavailable'); };
  expect(await invoke()).toMatchObject({ code: 'ENTITY_PROTOCOL_UNVERIFIED' });
  expect(writes()).toEqual([]);
});
test('rechecks Pause and marker after the probe', async () => {
  const ready = await readReadiness();
  readReadiness.mockResolvedValueOnce(ready).mockResolvedValueOnce({ ...ready,
    pause: { readable: true, paused: false } });
  expect(await invoke()).toMatchObject({ code: 'PAUSE_REQUIRED' });
  runtime.state.beforeTransaction = () => { runtime.state.migration = { version: 1 }; };
  expect(await invoke()).toMatchObject({ code: 'F07_MARKER_EXISTS' });
  expect(writes()).toEqual([]);
});
test('write failures never retry and report an unknown outcome', async () => {
  runtime.state.beforeSet = () => { throw Error('timeout'); };
  expect(await invoke()).toMatchObject({ code: 'FRESH_WRITE_OUTCOME_UNKNOWN', activation: {
    performed: false, wroteMigrationState: null
  } });
  expect(writes()).toHaveLength(1);
});
test('committed but lost response retains marker without cleanup or retry', async () => {
  runtime.state.beforeSet = body => { runtime.state.migration = body.value; throw Error('timeout'); };
  expect(await invoke()).toMatchObject({ code: 'FRESH_WRITE_OUTCOME_UNKNOWN' });
  expect(runtime.state.migration.version).toBe(2);
  expect(writes()).toHaveLength(1);
});
test('readback failure reports the persisted marker accurately', async () => {
  runtime.state.beforeSet = () => { api.getAppContext.mockReturnValue({}); };
  expect(await invoke()).toMatchObject({ code: 'FRESH_READBACK_UNVERIFIED', activation: {
    performed: false, wroteMigrationState: true
  } });
  expect(runtime.state.migration.version).toBe(2);
});

test('storage readback outage does not delete a committed marker', async () => {
  runtime.state.beforeSet = () => { runtime.state.failure = Error('readback outage'); };
  expect(await invoke()).toMatchObject({ code: 'FRESH_READBACK_UNVERIFIED', activation: {
    performed: false, wroteMigrationState: true
  } });
  expect(runtime.state.migration.version).toBe(2);
  expect(writes()).toHaveLength(1);
});

test('a legacy marker created just before set wins without being overwritten', async () => {
  const legacy = { version: 1, phase: 'draining', legacyDisabled: false };
  runtime.state.beforeSet = () => { runtime.state.migration = legacy; };
  expect(await invoke()).toMatchObject({ code: 'F07_MARKER_EXISTS' });
  expect(runtime.state.migration).toBe(legacy);
});
test('v2 rejects wrong identity, invalid policy and future activation', async () => {
  await invoke();
  expect(evaluateIssueLeaseMigrationState({ ...runtime.state.migration, activatedAt: NOW + 1 }, NOW, context()).valid)
    .toBe(false);
  api.getAppContext.mockReturnValue({});
  expect((await readIssueLeaseMigrationState(NOW)).valid).toBe(false);
  api.getAppContext.mockReturnValue(context());
  runtime.state.migration.policy = 'other';
  expect((await readIssueLeaseMigrationState(NOW)).valid).toBe(false);
});
test('unchanged v1 drain, malformed, future and inactive checks', () => {
  const marker = { version: 1, phase: 'entity-active', legacyDisabled: true,
    disabledAt: NOW - LEGACY_LEASE_DRAIN_MS, activatedAt: NOW };
  expect(evaluateIssueLeaseMigrationState(marker, NOW).valid).toBe(true);
  for (const change of [{ disabledAt: NOW }, { legacyDisabled: false },
    { activatedAt: NOW + 1 }, { phase: 'draining' }, { disabledAt: '0' }]) {
    expect(evaluateIssueLeaseMigrationState({ ...marker, ...change }, NOW).valid).toBe(false);
  }
});
test('v2 still reaches the unchanged submission Pause guard', async () => {
  await invoke();
  const pause = require('../src/services/sync/pilot-pause');
  jest.spyOn(pause, 'assertPilotWritesAllowed').mockRejectedValue(Object.assign(Error('paused'), { code: 'PILOT_PAUSED' }));
  await expect(assertJiraSubmissionAllowed('https://jira.invalid/rest/api/3/issue', { method: 'POST' }))
    .rejects.toMatchObject({ code: 'PILOT_PAUSED' });
});

test('v2 keeps conditional ownership and rejects a stale worker at submission', async () => {
  await invoke();
  const { acquireIssueLease, assertIssueLeaseOwned, releaseIssueLease } = require('../src/services/sync/issue-lease');
  const { runWithIssueLease } = require('../src/services/sync/issue-lease-context');
  const options = { orgId: 'test-org', localKey: 'MOB-1', remoteKey: 'VMOB-1' };
  const claims = await Promise.all([acquireIssueLease(options), acquireIssueLease(options)]);
  expect(claims.filter(c => c.acquired)).toHaveLength(1);
  const owner = claims.find(c => c.acquired);
  runtime.entities.set(owner.key, { leaseToken: 'successor', expiresAt: NOW + 120000 });
  await expect(assertIssueLeaseOwned(owner)).rejects.toMatchObject({ code: 'LEASE_OWNERSHIP_UNAVAILABLE' });
  await expect(runWithIssueLease(owner,
    () => assertJiraSubmissionAllowed('https://jira.invalid/rest/api/3/issue', { method: 'POST' })))
    .rejects.toMatchObject({ code: 'LEASE_OWNERSHIP_UNAVAILABLE' });
  expect((await releaseIssueLease(owner)).released).toBe(false);
  expect(runtime.entities.get(owner.key).leaseToken).toBe('successor');
});

test('historical-evidence markers do not substitute for the staging policy', async () => {
  runtime.state.migration = { ...TARGET, version: 2, basis: 'fresh-install',
    phase: 'entity-active', activatedAt: NOW, provenanceReference: 'claimed-history' };
  expect((await readIssueLeaseMigrationState(NOW)).valid).toBe(false);
  await expect(assertIssueLeaseMigrationReady()).rejects.toMatchObject({ code: 'LEASE_MIGRATION_REQUIRED' });
});

test('failed readback and Pause loss after commit preserve the marker', async () => {
  const ready = await readReadiness();
  readReadiness.mockResolvedValueOnce(ready).mockResolvedValueOnce(ready)
    .mockResolvedValueOnce({ ...ready, pause: { readable: true, paused: false } });
  expect(await invoke()).toMatchObject({ code: 'PAUSE_REQUIRED', activation: {
    performed: false, wroteMigrationState: true
  } });
  expect(runtime.state.migration.version).toBe(2);
  expect(writes()).toHaveLength(1);
});
