/** @jest-environment node */
'use strict';
// Only the browser transport is simulated. Production acquisition, branding,
// identity binding and runner readiness validation execute unchanged.
jest.mock('playwright-core', () => ({ chromium: { connectOverCDP: jest.fn() } }));
const fs = require('fs');
const { chromium } = require('playwright-core');
const { TARGET, readInstalledStagingReadiness } = require('../scripts/staging/lib/forge-admin-browser-adapter');
const { readForgeAdminReadiness, bindReadinessResponse, isAuthenticatedReadiness } = require('../scripts/staging/lib/forge-admin-readiness');
const { validateReadiness } = require('../scripts/staging/lib/e2e-evidence');
const ADMIN = `https://${TARGET.siteHost}/jira/settings/apps/${TARGET.appId}/${TARGET.environmentId}`;
const FRAME = `https://tenant.cdn.prod.atlassian-dev.net/${TARGET.appId}/${TARGET.environmentId}/6cd265f5-b7c0-43a4-88c7-fc77eeb680a2/admin-ui/_ctx_test/`;
let context, browser, page, frame, raw;
function response() {
  return { success: true, version: 1, capturedAt: new Date().toISOString(),
    appId: TARGET.appId, appVersion: '3.2.0', environment: 'STAGING',
    environmentId: TARGET.environmentId, installationId: TARGET.installationId,
    installedSites: [TARGET.siteHost], paused: false, f07: null,
    f07Status: { readable: true, present: false, valid: false },
    mappings: [{ orgId: 'test-org', syncDirection: 'push', syncComments: true,
      localProjectKey: 'MOB', remoteProjectKey: 'VMOB' }],
    webhook: { configured: false, lastReceiptAt: null, lastRotatedAt: null } };
}
function evaluate(readiness, document = null) {
  return validateReadiness({ readiness, document,
    config: { local: { host: TARGET.siteHost, stagingProjects: ['MOB'] },
      remote: { host: 'serdarjiratwo.atlassian.net', stagingProjects: ['VMOB'] } },
    settings: { environment: 'staging', forgeInstallationId: TARGET.installationId,
      forgeEnvironmentId: TARGET.environmentId } });
}
beforeEach(() => {
  raw = response();
  const exists = fs.existsSync;
  jest.spyOn(fs, 'existsSync').mockImplementation(p => p.includes('/Applications/Brave Browser.app') || exists(p));
  const mkdir = fs.mkdirSync;
  jest.spyOn(fs, 'mkdirSync').mockImplementation((p, ...args) => String(p).includes('jira-sync-staging-adapter-') ? undefined : mkdir(p, ...args));
  const read = fs.readFileSync;
  jest.spyOn(fs, 'readFileSync').mockImplementation((p, ...args) => String(p).endsWith('DevToolsActivePort') ? '43210\n/devtools/browser/test-session\n' : read(p, ...args));
  const stat = fs.lstatSync;
  jest.spyOn(fs, 'lstatSync').mockImplementation((p, ...args) => String(p).includes('jira-sync-staging-adapter-')
    ? { isDirectory: () => true, isSymbolicLink: () => false, uid: process.getuid(), mode: 0o700 } : stat(p, ...args));
  const main = {};
  page = { goto: jest.fn(), bringToFront: jest.fn(), route: jest.fn(), unrouteAll: jest.fn(async () => {}), mainFrame: () => main,
    waitForEvent: jest.fn(async () => { throw new Error('no trusted frame'); }),
    url: jest.fn(() => ADMIN), waitForURL: jest.fn(),
    waitForFunction: jest.fn(async () => ({ dispose: jest.fn() })), frames: () => [frame] };
  frame = { parentFrame: () => main, url: jest.fn(() => FRAME),
    waitForFunction: jest.fn(), evaluate: jest.fn(async () => raw) };
  context = { newPage: jest.fn(async () => page), pages: () => [page], close: jest.fn(async () => {}) };
  browser = { contexts: () => [context], close: jest.fn(async () => {}) };
  chromium.connectOverCDP.mockResolvedValue(browser);
});
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

test('owns the browser, invokes only the iframe handle and produces branded, frozen facts', async () => {
  const facts = await readForgeAdminReadiness();
  expect(isAuthenticatedReadiness(facts)).toBe(true);
  expect(Object.isFrozen(facts)).toBe(true);
  expect(Object.isFrozen(facts.mappings)).toBe(true);
  expect(page.goto).toHaveBeenCalledWith(ADMIN, expect.any(Object));
  expect(frame.evaluate).toHaveBeenCalledTimes(1);
  expect(frame.evaluate.mock.calls[0][0].toString()).toContain('window.__syncConnectorReadinessInvoke()');
  expect(browser.close).toHaveBeenCalledTimes(1);
  expect(context.close).not.toHaveBeenCalled();
  expect(chromium.connectOverCDP).toHaveBeenCalledWith('ws://127.0.0.1:43210/devtools/browser/test-session', { timeout: 1000 });
  const result = evaluate(facts);
  expect(result.summary.readinessBasis).toBe('authenticated-connector');
  expect(result.summary.verification.installationId).toBe(TARGET.installationId);
  expect(result.reasons.some(r => r.code === 'f07-not-verified')).toBe(true);
});
test('pure normalization, copies, JSON and forged page handles never acquire authentication', async () => {
  const facts = await readForgeAdminReadiness();
  for (const fake of [raw, bindReadinessResponse(raw, TARGET), { ...facts }, JSON.parse(JSON.stringify(facts))]) {
    expect(isAuthenticatedReadiness(fake)).toBe(false);
    expect(evaluate(fake).status).not.toBe('verified');
  }
  const callback = jest.fn();
  await expect(readForgeAdminReadiness({ page: { evaluate: callback } })).rejects.toBeDefined();
  await expect(readInstalledStagingReadiness({ evaluate: callback })).rejects.toBeDefined();
  expect(callback).not.toHaveBeenCalled();
});
test.each(['appId', 'environmentId', 'installationId', 'environment', 'installedSites'])(
  'rejects wrong response %s and never brands it', async key => {
    raw[key] = key === 'installedSites' ? ['elsewhere.atlassian.net'] : 'different';
    await expect(readForgeAdminReadiness()).rejects.toBeDefined();
    expect(browser.close).toHaveBeenCalledTimes(1);
  expect(context.close).not.toHaveBeenCalled();
  });
test.each(['http://tenant.cdn.prod.atlassian-dev.net/', 'https://evil.test/admin-ui/',
  FRAME.replace(TARGET.environmentId, 'different'), FRAME.replace('atlassian-dev.net', 'atlassian-dev.net.evil.test')])(
  'rejects an untrusted iframe URL %s before invocation', async url => {
    frame.url.mockReturnValue(url);
    await expect(readForgeAdminReadiness()).rejects.toMatchObject({ code: 'READINESS_BROWSER_BINDING_FAILED' });
    expect(frame.evaluate).not.toHaveBeenCalled();
  });
test('authentication failure fails closed without invoking Forge', async () => {
  page.waitForURL.mockRejectedValue(new Error('login timeout, sensitive details omitted'));
  await expect(readForgeAdminReadiness()).rejects.toMatchObject({ code: 'READINESS_BROWSER_AUTHENTICATION_REQUIRED' });
  expect(frame.evaluate).not.toHaveBeenCalled();
  expect(browser.close).toHaveBeenCalledTimes(1);
  expect(context.close).not.toHaveBeenCalled();
});
test('waits for a genuine iframe to navigate away from its initial blank document', async () => {
  page.frames = jest.fn().mockReturnValueOnce([]).mockReturnValue([frame]);
  page.waitForEvent.mockResolvedValueOnce(frame);
  expect(isAuthenticatedReadiness(await readForgeAdminReadiness())).toBe(true);
  expect(page.waitForEvent).toHaveBeenCalledWith('framenavigated', expect.any(Object));
});
test('rejects redirected page after invocation and credential-shaped payloads', async () => {
  frame.evaluate.mockImplementationOnce(async () => { page.url.mockReturnValue('https://other.atlassian.net'); return raw; });
  await expect(readForgeAdminReadiness()).rejects.toMatchObject({ code: 'READINESS_BROWSER_BINDING_FAILED' });
  page.url.mockReturnValue(ADMIN);
  raw.cookie = 'not-a-real-session';
  await expect(readForgeAdminReadiness()).rejects.toMatchObject({ code: 'READINESS_RESPONSE_CONTAINS_SECRETS' });
});
test('fresh v2 marker needs the production gate and exact staging policy', async () => {
  raw.f07 = { version: 2, phase: 'entity-active', basis: 'fresh-install', policy: 'disposable-staging-v1',
    ...TARGET, activatedAt: Date.now() - 60000 };
  raw.f07Status.valid = true;
  expect(evaluate(await readForgeAdminReadiness()).status).toBe('verified');
  raw.f07Status.valid = false;
  expect(evaluate(await readForgeAdminReadiness()).status).toBe('blocked');
});
