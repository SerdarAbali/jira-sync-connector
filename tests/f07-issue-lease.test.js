import { entities, requests, state } from './helpers/forge-lease-runtime';
import {
  acquireIssueLease, assertIssueLeaseOwned, renewIssueLease, releaseIssueLease,
  withIssueLease, issueLeaseEntityKey, buildIssueLeaseKey
} from '../src/services/sync/issue-lease';
import { runWithIssueLease } from '../src/services/sync/issue-lease-context';
import { assertIssueLeaseMigrationReady, LEGACY_LEASE_DRAIN_MS } from '../src/services/sync/lease-migration';
import guardedApi, { fetch as guardedFetch } from '../src/services/jira/guarded-api';
import api, { fetch } from '@forge/api';
import { executeWriteOnce, retryWithBackoff, createRetryBudget } from '../src/utils/retry';
import { executeWriteWithRetry } from '../src/services/sync/write-retry';
import { updateLocalIssueDescription, addLocalIssueComment } from '../src/services/jira/local-client';
import { deleteAttachmentContent, ATTACHMENT_SOURCE } from '../src/services/jira/attachment-client';
import { createLinkOnRemote } from '../src/services/sync/link-sync';
import { transitionRemoteIssue } from '../src/services/sync/transition-sync';

jest.mock('@forge/api', () => ({
  __esModule: true,
  default: { asApp: () => ({ requestJira: jest.fn() }) },
  fetch: jest.fn(), route: (s, ...v) => s.reduce((out, x, i) => out + x + (v[i] ?? ''), '')
}));
jest.mock('../src/services/storage/kvs', () => ({ get: jest.fn(async key => {
  if (key === 'syncConfig') return { allowedProjects: ['LOCAL'] };
  if (key.startsWith('remote-to-local:')) return key.slice('remote-to-local:'.length).replace('REMOTE-', 'LOCAL-');
  if (key.startsWith('local-to-remote:')) return key.slice('local-to-remote:'.length).replace('LOCAL-', 'REMOTE-');
  return null;
}) }));
jest.mock('../src/services/storage/stats', () => ({ trackApiCall: jest.fn(), logAuditEntry: jest.fn() }));

const options = { orgId: 'org-1', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' };
let now;
beforeEach(() => {
  jest.clearAllMocks();
  now = 1800000000000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  fetch.mockResolvedValue({ ok: true, status: 204, json: async () => ({}) });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
const claim = extra => acquireIssueLease({ ...options, ...extra });

async function replaceAfterExpiry(lease) {
  now = lease.metadata.expiresAt;
  const successor = await claim();
  expect(successor.acquired).toBe(true);
  expect(successor.token).not.toBe(lease.token);
  return successor;
}

test('concurrent initial claims have a single owner (actual SDK conditional create)', async () => {
  const claims = await Promise.all([claim(), claim(), claim()]);
  expect(claims.filter(x => x.acquired)).toHaveLength(1);
  expect(entities.size).toBe(1);
  expect(requests.filter(x => x.body.set).every(x => x.body.set[0].conditions)).toBe(true);
});

test('crashed owner is replaced at application expiry without deleting its entity', async () => {
  const lease = await claim();
  const successor = await replaceAfterExpiry(lease);
  expect(entities.get(lease.key).leaseToken).toBe(successor.token);
  expect(requests.some(x => x.body.delete)).toBe(false);
  expect(requests.filter(x => x.body.set).every(x => !x.body.set[0].options?.ttl)).toBe(true);
});

test('concurrent expired-row takeovers have one winner', async () => {
  const lease = await claim(); now = lease.metadata.expiresAt;
  const claims = await Promise.all([claim(), claim()]);
  expect(claims.filter(x => x.acquired)).toHaveLength(1);
});

test('renewal keeps token and extends expiry; expired worker cannot renew or write', async () => {
  const lease = await claim(); const oldExpiry = lease.metadata.expiresAt;
  now += 70000;
  await renewIssueLease(lease);
  expect(lease.metadata.expiresAt).toBe(now + 120000);
  expect(lease.metadata.expiresAt).toBeGreaterThan(oldExpiry);
  now = lease.metadata.expiresAt;
  await expect(renewIssueLease(lease)).rejects.toMatchObject({ code: 'LEASE_NOT_OWNED' });
  await expect(assertIssueLeaseOwned(lease)).rejects.toMatchObject({ code: 'LEASE_NOT_OWNED' });
});

test('stale token cannot renew or release successor even with a forged future local deadline', async () => {
  const lease = await claim();
  const successor = await replaceAfterExpiry(lease);
  lease.metadata.expiresAt = now + 120000;
  await expect(renewIssueLease(lease)).rejects.toMatchObject({ code: 'LEASE_OWNERSHIP_UNAVAILABLE' });
  expect((await releaseIssueLease(lease)).released).toBe(false);
  expect(entities.get(lease.key)).toEqual(successor.metadata);
});

test('renewal delayed after check cannot overwrite a takeover', async () => {
  const lease = await claim(); now += 70000;
  const original = global.__forge_fetch__;
  let successor;
  global.__forge_fetch__ = async (target, path, request) => {
    if (JSON.parse(request.body).set) {
      global.__forge_fetch__ = original;
      successor = await replaceAfterExpiry(lease);
    }
    return original(target, path, request);
  };
  await expect(renewIssueLease(lease)).rejects.toMatchObject({ code: 'LEASE_OWNERSHIP_UNAVAILABLE' });
  expect(entities.get(lease.key)).toEqual(successor.metadata);
});

test('concurrent owner release and renewal cannot resurrect a deleted claim', async () => {
  const lease = await claim(); now += 70000;
  state.beforeTransaction = async body => {
    expect(body.check).toBeDefined();
    await releaseIssueLease(lease);
  };
  await expect(renewIssueLease(lease)).rejects.toMatchObject({ code: 'LEASE_OWNERSHIP_UNAVAILABLE' });
  expect(entities.has(lease.key)).toBe(false);
});

test('failed release retains entity for crash recovery', async () => {
  const lease = await claim(); state.failure = new Error('offline');
  expect((await releaseIssueLease(lease)).released).toBe(false);
  expect(entities.has(lease.key)).toBe(true);
  state.failure = null;
  await replaceAfterExpiry(lease);
});

test('delayed ownership response past expiry fails locally before transport', async () => {
  const lease = await claim();
  state.beforeTransaction = async () => { now = lease.metadata.expiresAt; };
  await expect(runWithIssueLease(lease, () => guardedFetch('https://remote.example.invalid', { method: 'PUT' })))
    .rejects.toMatchObject({ code: 'LEASE_NOT_OWNED' });
  expect(fetch).not.toHaveBeenCalled();
});

test('near-expiry protected submission renews and validates via transaction before writing', async () => {
  const lease = await claim(); now += 70000;
  await runWithIssueLease(lease, () => guardedFetch('https://remote.example.invalid', { method: 'PUT' }));
  expect(lease.metadata.expiresAt).toBe(now + 120000);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('F05 429 retry revalidates ownership and never resubmits after expiry', async () => {
  jest.useFakeTimers({ doNotFake: ['Date', 'nextTick', 'performance'] });
  const lease = await claim();
  fetch.mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => '1' } });
  const work = runWithIssueLease(lease, () => executeWriteWithRetry(
    () => guardedFetch('https://remote.example.invalid', { method: 'PUT' }), 'update', {
      budget: createRetryBudget({ budgetMs: 2000 }), onRetry: async () => { await replaceAfterExpiry(lease); }
    }));
  const outcome = work.then(() => null, error => error);
  await jest.runAllTimersAsync();
  expect(await outcome).toMatchObject({ code: 'LEASE_NOT_OWNED' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('nested child scope cannot bypass expired parent', async () => {
  const parent = await claim();
  await runWithIssueLease(parent, async () => {
    await replaceAfterExpiry(parent);
    const child = await claim({ localKey: 'LOCAL-2' });
    await expect(runWithIssueLease(child, () => guardedFetch('https://remote.example.invalid', { method: 'POST' })))
      .rejects.toMatchObject({ code: 'LEASE_NOT_OWNED' });
  });
  expect(fetch).not.toHaveBeenCalled();
});

test('closed async descendant cannot write after the lease callback exits', async () => {
  const lease = await claim(); let resume; let descendant;
  const held = new Promise(resolve => { resume = resolve; });
  await runWithIssueLease(lease, async () => {
    descendant = (async () => { await held; return guardedFetch('https://remote.example.invalid', { method: 'PUT' }); })();
  });
  const outcome = expect(descendant).rejects.toMatchObject({ code: 'LEASE_NOT_OWNED' });
  resume(); await outcome;
  expect(fetch).not.toHaveBeenCalled();
});

test('real nested local description, remote link and attachment clients cannot submit after loss', async () => {
  const lease = await claim(); await replaceAfterExpiry(lease);
  const localRequest = jest.fn();
  jest.spyOn(api, 'asApp').mockReturnValue({ requestJira: localRequest });
  await runWithIssueLease(lease, async () => {
    // Some existing clients report errors as false/structured results. The
    // invariant is zero transport calls, regardless of their return convention.
    await updateLocalIssueDescription('LOCAL-1', { type: 'doc', version: 1, content: [] });
    await addLocalIssueComment('LOCAL-1', { type: 'doc', version: 1, content: [] });
    await createLinkOnRemote({
      remoteUrl: 'https://remote.example.invalid', remoteEmail: 'test', remoteApiToken: 'test'
    }, 'REMOTE-1', 'REMOTE-2', 'Relates', 'outward');
    await deleteAttachmentContent({ source: ATTACHMENT_SOURCE.REMOTE, attachmentId: '42', config: {
      remoteUrl: 'https://remote.example.invalid', remoteEmail: 'test', remoteApiToken: 'test'
    } }).catch(() => undefined);
  });
  expect(fetch).not.toHaveBeenCalled(); expect(localRequest).not.toHaveBeenCalled();
});

test.each(['LEASE_NOT_OWNED', 'LEASE_OWNERSHIP_UNAVAILABLE', 'LEASE_MIGRATION_REQUIRED'])(
  '%s is preserved by single-write helper and never retried', async code => {
    const fn = jest.fn(async () => { throw Object.assign(new Error('blocked'), { code }); });
    await expect(executeWriteOnce(fn)).rejects.toMatchObject({ code });
    fn.mockClear();
    await expect(retryWithBackoff(fn)).rejects.toMatchObject({ code });
    expect(fn).toHaveBeenCalledTimes(1);
  }
);

test.each([null, {}, { version: 1, phase: 'draining' },
  { version: 1, phase: 'entity-active', legacyDisabled: true, disabledAt: 0, activatedAt: LEGACY_LEASE_DRAIN_MS - 1 },
  { version: 1, phase: 'entity-active', legacyDisabled: false, disabledAt: 0, activatedAt: LEGACY_LEASE_DRAIN_MS },
  { version: 1, phase: 'entity-active', legacyDisabled: true, disabledAt: 0, activatedAt: 1900000000000 }
])('missing/uncertain migration state fails closed: %j', async migration => {
  state.migration = migration;
  await expect(assertIssueLeaseMigrationReady()).rejects.toMatchObject({ code: 'LEASE_MIGRATION_REQUIRED' });
  expect((await claim()).acquired).toBe(false);
  await expect(guardedFetch('https://remote.example.invalid', { method: 'POST' }))
    .rejects.toMatchObject({ code: 'LEASE_MIGRATION_REQUIRED' });
  expect(fetch).not.toHaveBeenCalled(); expect(entities.size).toBe(0);
});

test('unreadable migration and ownership state fail closed', async () => {
  const lease = await claim(); state.failure = new Error('storage offline');
  expect((await claim()).status).toBe('LEASE_STORAGE_ERROR');
  await expect(guardedFetch('https://remote.example.invalid', { method: 'DELETE' }))
    .rejects.toMatchObject({ code: 'LEASE_MIGRATION_REQUIRED' });
  await expect(assertIssueLeaseOwned(lease)).rejects.toMatchObject({ code: 'LEASE_OWNERSHIP_UNAVAILABLE' });
  expect(fetch).not.toHaveBeenCalled();
});

test('migration disabled between lease acquisition and transport blocks writes', async () => {
  const lease = await claim(); state.migration.phase = 'draining';
  await expect(runWithIssueLease(lease, () => guardedFetch('https://remote.example.invalid', { method: 'PUT' })))
    .rejects.toMatchObject({ code: 'LEASE_MIGRATION_REQUIRED' });
  expect(fetch).not.toHaveBeenCalled();
});

test('scope hashes support entity key restrictions and retain direction contention', () => {
  const scope = { orgId: 'org/å', localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' };
  const key = issueLeaseEntityKey(buildIssueLeaseKey({ ...scope, direction: 'remote-to-local' }));
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(key).toBe(issueLeaseEntityKey(buildIssueLeaseKey({ ...scope, direction: 'local-to-remote' })));
});

test('callback errors release the conditional lease and allow immediate reacquisition', async () => {
  await expect(withIssueLease(options, async () => { throw new Error('callback failed'); })).rejects.toThrow('callback failed');
  expect(entities.size).toBe(0);
  expect((await claim()).acquired).toBe(true);
});

test('local transport and remote transport both validate an unexpired mismatched token', async () => {
  const lease = await claim(); entities.get(lease.key).leaseToken = 'successor';
  const requestJira = jest.fn(); jest.spyOn(api, 'asApp').mockReturnValue({ requestJira });
  await runWithIssueLease(lease, async () => {
    await expect(guardedApi.asApp().requestJira('/rest/api/3/issue/LOCAL-1', { method: 'PUT' }))
      .rejects.toMatchObject({ code: 'LEASE_OWNERSHIP_UNAVAILABLE' });
    await expect(guardedFetch('https://remote.example.invalid', { method: 'POST' }))
      .rejects.toMatchObject({ code: 'LEASE_OWNERSHIP_UNAVAILABLE' });
  });
  expect(requestJira).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

test('search POST remains read-only during migration; issue POST remains blocked', async () => {
  state.migration = null;
  await guardedFetch('https://remote.example.invalid/rest/api/3/search/jql', { method: 'POST' });
  expect(fetch).toHaveBeenCalledTimes(1);
  await expect(guardedFetch('https://remote.example.invalid/rest/api/3/issue', { method: 'POST' }))
    .rejects.toMatchObject({ code: 'LEASE_MIGRATION_REQUIRED' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('nested clients can submit with a valid lease, proving lost-ownership coverage reaches transport', async () => {
  const lease = await claim();
  const requestJira = jest.fn(async path => ({ ok: true, status: 204,
    json: async () => ({ key: String(path).split('/').pop().split('?')[0], fields: { project: { key: 'LOCAL' } } }) }));
  jest.spyOn(api, 'asApp').mockReturnValue({ requestJira });
  await runWithIssueLease(lease, async () => {
    expect(await updateLocalIssueDescription('LOCAL-1', { type: 'doc', version: 1, content: [] })).toBe(true);
    expect(await addLocalIssueComment('LOCAL-1', { type: 'doc', version: 1, content: [] })).toMatchObject({ success: true });
    expect(await createLinkOnRemote({ remoteUrl: 'https://remote.example.invalid', remoteEmail: 'test', remoteApiToken: 'test' },
      'REMOTE-1', 'REMOTE-2', 'Relates', 'outward')).toMatchObject({ success: true });
    expect(await deleteAttachmentContent({ source: ATTACHMENT_SOURCE.REMOTE, attachmentId: '42', config: {
      remoteUrl: 'https://remote.example.invalid', remoteEmail: 'test', remoteApiToken: 'test'
    } })).toMatchObject({ deleted: true });
  });
  expect(requestJira).toHaveBeenCalledTimes(4); expect(fetch).toHaveBeenCalledTimes(2);
});

test('renewal response delayed past original expiry cannot revive the worker', async () => {
  const lease = await claim(); now += 70000;
  const original = global.__forge_fetch__;
  global.__forge_fetch__ = async (target, path, request) => {
    const result = await original(target, path, request);
    if (JSON.parse(request.body).set) now = lease.metadata.expiresAt;
    return result;
  };
  await expect(renewIssueLease(lease)).rejects.toMatchObject({ code: 'LEASE_NOT_OWNED' });
  expect(lease.closed).toBe(true);
  await expect(runWithIssueLease(lease, () => guardedFetch('https://remote.example.invalid', { method: 'PUT' })))
    .rejects.toMatchObject({ code: 'LEASE_NOT_OWNED' });
  expect(fetch).not.toHaveBeenCalled();
});

test('nested transition revalidates after its Jira reads and submits no POST after takeover', async () => {
  const lease = await claim();
  fetch.mockImplementation(async url => {
    if (url.endsWith('/transitions')) {
      await replaceAfterExpiry(lease);
      return { ok: true, json: async () => ({ transitions: [{ id: '31', to: { name: 'Done' } }] }) };
    }
    return { ok: true, json: async () => ({ fields: { status: { name: 'Open' } } }) };
  });
  await runWithIssueLease(lease, async () => {
    expect(await transitionRemoteIssue('REMOTE-1', 'Done', {
      remoteUrl: 'https://remote.example.invalid', remoteEmail: 'test', remoteApiToken: 'test'
    }, {})).toBe(false);
  });
  expect(fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(0);
  expect(fetch).toHaveBeenCalledTimes(2);
});
