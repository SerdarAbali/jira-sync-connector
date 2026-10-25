'use strict';
/* global document, window */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TARGET = Object.freeze({
  appId: '362d8e6b-b68c-4403-8020-d32ddcc02716',
  environmentId: '2e8c0cb5-881a-4345-b9ba-e887f790d316',
  installationId: '974910c5-2861-4d40-a7eb-37802842d0a0',
  environmentType: 'STAGING', siteHost: 'serdarjiraone.atlassian.net',
});
const ADMIN_PATH = `/jira/settings/apps/${TARGET.appId}/${TARGET.environmentId}`;
const ADMIN_URL = `https://${TARGET.siteHost}${ADMIN_PATH}`;
const TIMEOUT_MS = 600000;

function failure(code) {
  const error = new Error(code === 'READINESS_BROWSER_AUTHENTICATION_REQUIRED'
    ? 'Sign in to the staging Jira admin page in the private automation browser, then rerun.'
    : 'Authenticated staging browser readiness could not be obtained.');
  error.code = code;
  return error;
}

function isAdminPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === TARGET.siteHost
      && url.pathname.replace(/\/$/, '') === ADMIN_PATH && !url.username && !url.password;
  } catch { return false; }
}

function isForgeFrame(value) {
  try {
    const url = new URL(value);
    const prefix = `/${TARGET.appId}/${TARGET.environmentId}/`;
    return url.protocol === 'https:' && url.hostname.endsWith('.cdn.prod.atlassian-dev.net')
      && url.pathname.startsWith(prefix)
      && /^\/[^/]+\/admin-ui\//.test(url.pathname.slice(prefix.length - 1))
      && !url.username && !url.password;
  } catch { return false; }
}

/** Owns the browser lifecycle. No browser, page, callback or facts are inputs. */
async function readInstalledStagingReadiness() {
  if (arguments.length) throw failure('READINESS_BROWSER_INPUT_REJECTED');
  try {
    const executablePath = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
    if (!fs.existsSync(executablePath)) throw failure('READINESS_BROWSER_UNAVAILABLE');
    // Session state never enters the repository, reports, screenshots or logs.
    const profile = path.join(os.tmpdir(), `jira-sync-staging-adapter-${process.getuid()}`);
    fs.mkdirSync(profile, { mode: 0o700, recursive: true });
    const stat = fs.lstatSync(profile);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
        || (stat.mode & 0o077) !== 0) throw failure('READINESS_BROWSER_PROFILE_UNSAFE');
    return await readWithProfile(profile, executablePath);
  } catch (error) {
    throw error.code?.startsWith('READINESS_') ? error : failure('READINESS_BROWSER_UNAVAILABLE');
  }
}

async function connectOwnedBrowser(profile, executablePath) {
  const { chromium } = require('playwright-core');
  const portFile = path.join(profile, 'DevToolsActivePort');
  async function connect() {
    const [port, socket] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1024 || Number(port) > 65535
        || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(socket)) throw failure('READINESS_BROWSER_UNAVAILABLE');
    return chromium.connectOverCDP(`ws://127.0.0.1:${port}${socket}`, { timeout: 1000 });
  }
  try { return await connect(); } catch { /* Start only the fixed private profile. */ }
  const child = spawn(executablePath, [
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', ADMIN_URL,
  ], { detached: true, stdio: 'ignore' });
  let launchFailed = false;
  child.on('error', () => { launchFailed = true; });
  child.unref();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (launchFailed) break;
    try { return await connect(); } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  throw failure('READINESS_BROWSER_UNAVAILABLE');
}

async function readWithProfile(profile, executablePath) {
  let browser;
  let page;
  let stage = 'launch';
  try {
    browser = await connectOwnedBrowser(profile, executablePath);
    const context = browser.contexts()[0];
    if (!context) throw failure('READINESS_BROWSER_UNAVAILABLE');
    page = context.pages().find(candidate => isAdminPage(candidate.url())) || await context.newPage();
    await page.route('**/*', async route => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        const url = new URL(request.url());
        if (url.protocol !== 'https:' || ![TARGET.siteHost, 'id.atlassian.com', 'auth.atlassian.com'].includes(url.hostname)) {
          return route.abort();
        }
      }
      return route.continue();
    });
    stage = 'navigation';
    await page.bringToFront();
    await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // A first run permits an interactive login in this owned context. No
    // credentials are accepted by the adapter or copied from another profile.
    stage = 'authentication';
    await page.waitForURL(isAdminPage, { timeout: TIMEOUT_MS });
    stage = 'iframe';
    const frameHandle = await page.waitForFunction(() => [...document.querySelectorAll('iframe')]
      .some(frame => frame.src.includes('/admin-ui/')), null, { timeout: 30000 });
    await frameHandle.dispose();
    const matchingFrames = () => page.frames().filter(frame =>
      frame.parentFrame() === page.mainFrame() && isForgeFrame(frame.url()));
    // Jira inserts the iframe before its initial about:blank document navigates
    // to the Forge CDN. Wait for that navigation without relaxing the allowlist.
    if (matchingFrames().length === 0) {
      try {
        await page.waitForEvent('framenavigated', { timeout: 30000, predicate: frame =>
          frame.parentFrame() === page.mainFrame() && isForgeFrame(frame.url()) });
      } catch { throw failure('READINESS_BROWSER_BINDING_FAILED'); }
    }
    const frames = matchingFrames();
    if (frames.length !== 1 || !isAdminPage(page.url())) throw failure('READINESS_BROWSER_BINDING_FAILED');
    const frame = frames[0];
    await frame.waitForFunction(() => typeof window.__syncConnectorReadinessInvoke === 'function', null, { timeout: 30000 });
    stage = 'invocation';
    const raw = await frame.evaluate(() => window.__syncConnectorReadinessInvoke());
    if (!isAdminPage(page.url()) || !isForgeFrame(frame.url())) throw failure('READINESS_BROWSER_BINDING_FAILED');
    return raw;
  } catch (error) {
    throw error.code?.startsWith('READINESS_') ? error : failure(stage === 'authentication'
      ? 'READINESS_BROWSER_AUTHENTICATION_REQUIRED' : stage === 'launch'
        ? 'READINESS_BROWSER_UNAVAILABLE' : 'READINESS_BROWSER_INVOCATION_UNAVAILABLE');
  } finally {
    if (page) await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    // For a CDP-attached browser this closes the transport, not the independent
    // browser process. Leave its window open for the operator and later runs.
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { TARGET, readInstalledStagingReadiness };
