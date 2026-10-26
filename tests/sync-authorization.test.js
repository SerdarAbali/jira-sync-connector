/**
 * Fail-closed synchronization authorization.
 *
 * The production module and the production guarded Jira transport run unmodified.
 * Only the Forge context, the Jira transport and the Forge KVS boundary are
 * modelled, so the assertions describe what the deployed app does: without a
 * positive, installation-bound, organization-complete authorization record no
 * Jira mutation ever reaches the transport.
 */
import fs from 'fs';
import path from 'path';
import api, { getAppContext } from '@forge/api';
import {
  authorizationKeys,
  kvsStore,
  resetAuthorizationStore,
  resetOrganizationStore,
  seedOrganizations,
  setStoreFailure,
  storeSnapshot
} from './helpers/sync-authorization-store.js';
import {
  SYNC_AUTHORIZATION_BASES,
  SYNC_AUTHORIZATION_KEY,
  SYNC_AUTHORIZATION_REASONS,
  SYNC_AUTHORIZATION_STATES,
  SyncAuthorizationError,
  assertSyncAuthorized,
  authorizeSynchronization,
  readSyncAuthorizationStatus,
  setSyncAuthorizationState,
  syncAuthorizationConfirmation,
  syncAuthorizationOrganizationDigest
} from '../src/services/sync/sync-authorization.js';
import { fetch as guardedFetch } from '../src/services/jira/guarded-api.js';
import { resumePilot } from '../src/services/sync/pilot-pause.js';

jest.mock('@forge/api', () => {
  const requestJira = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  const fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  const getAppContext = jest.fn();
  return {
    __esModule: true,
    default: { asApp: () => ({ requestJira }), asUser: () => ({ requestJira }) },
    getAppContext,
    route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch
  };
});

jest.mock('../src/services/storage/kvs.js', () => require('./helpers/sync-authorization-store.js').kvsModule);

jest.mock('../src/services/sync/lease-migration.js', () => ({
  assertIssueLeaseMigrationReady: jest.fn(async () => true)
}));

jest.mock('../src/services/sync/issue-lease-context.js', () => ({
  assertCurrentIssueLeases: jest.fn(async () => true)
}));

const APP_ID = '362d8e6b-b68c-4403-8020-d32ddcc02716';
const ENVIRONMENT_ID = '2e8c0cb5-881a-4345-b9ba-e887f790d316';
const INSTALLATION_ID = '974910c5-2861-4d40-a7eb-37802842d0a0';

const requestJira = api.asApp().requestJira;
const forgeFetch = require('@forge/api').fetch;

function identity(overrides = {}) {
  return {
    appAri: { appId: overrides.appId ?? APP_ID },
    environmentAri: { environmentId: overrides.environmentId ?? ENVIRONMENT_ID },
    installationAri: { installationId: overrides.installationId ?? INSTALLATION_ID }
  };
}

function authorizedRecord(overrides = {}) {
  return {
    version: 1,
    state: SYNC_AUTHORIZATION_STATES.AUTHORIZED,
    appId: APP_ID,
    environmentId: ENVIRONMENT_ID,
    installationId: INSTALLATION_ID,
    organizationIds: ['org-1'],
    basis: 'established',
    authorizedAt: '2026-10-26T00:00:00.000Z',
    authorizedBy: 'admin-account',
    reason: null,
    ...overrides
  };
}

function storeAuthorization(value) {
  kvsStore.set(SYNC_AUTHORIZATION_KEY, value);
}

function missingAuthorizationBlocked(error) {
  return error instanceof SyncAuthorizationError
    && error.code === SYNC_AUTHORIZATION_REASONS.MISSING;
}

beforeEach(() => {
  resetAuthorizationStore();
  resetOrganizationStore();
  setStoreFailure(null);
  jest.clearAllMocks();
  getAppContext.mockReturnValue(identity());
  seedOrganizations([{ id: 'org-1', name: 'Org one' }]);
});

describe('synchronization authorization boundary', () => {
  test('blocks a mutation when authorization and the pause record are both absent', async () => {
    await expect(guardedFetch('https://jira.example/rest/api/3/issue', {
      method: 'POST',
      body: '{}'
    })).rejects.toMatchObject({ code: SYNC_AUTHORIZATION_REASONS.MISSING });
    expect(requestJira).not.toHaveBeenCalled();
    expect(forgeFetch).not.toHaveBeenCalled();
  });

  test('blocks an authorized installation while the pause is in force', async () => {
    kvsStore.set('pilotPause', {
      paused: true,
      pausedAt: '2026-10-26T00:00:00.000Z',
      pausedBy: 'admin-account',
      reasonCode: 'emergency_stop'
    });
    storeAuthorization(authorizedRecord());

    await expect(guardedFetch('https://jira.example/rest/api/3/issue', { method: 'POST' }))
      .rejects.toMatchObject({ code: 'PILOT_PAUSED' });
    expect(forgeFetch).not.toHaveBeenCalled();
  });

  test('allows an authorized installation with no pause record (legacy active behaviour)', async () => {
    storeAuthorization(authorizedRecord());

    await guardedFetch('https://jira.example/rest/api/3/issue', { method: 'POST' });

    expect(forgeFetch).toHaveBeenCalledTimes(1);
  });

  test('resuming the pause cannot bypass a missing authorization', async () => {
    kvsStore.set('pilotPause', {
      paused: true,
      pausedAt: '2026-10-26T00:00:00.000Z',
      pausedBy: 'admin-account',
      reasonCode: 'emergency_stop'
    });
    await resumePilot('admin-account');

    await expect(guardedFetch('https://jira.example/rest/api/3/issue', { method: 'POST' }))
      .rejects.toMatchObject({ code: SYNC_AUTHORIZATION_REASONS.MISSING });
    expect(forgeFetch).not.toHaveBeenCalled();
  });

  test('never blocks reads: GET and the JQL search POST stay usable', async () => {
    await guardedFetch('https://jira.example/rest/api/3/issue/ABC-1');
    await guardedFetch('https://jira.example/rest/api/3/search/jql', { method: 'POST' });
    expect(forgeFetch).toHaveBeenCalledTimes(2);
  });
});

describe('synchronization authorization states', () => {
  test('blocks every malformed shape', async () => {
    const malformed = [
      42,
      'authorized',
      [],
      authorizedRecord({ version: 2 }),
      authorizedRecord({ state: 'enabled' }),
      authorizedRecord({ organizationIds: [] }),
      authorizedRecord({ installationId: 'short' }),
      authorizedRecord({ appId: null })
    ];
    for (const value of malformed) {
      storeAuthorization(value);
      await expect(guardedFetch('https://jira.example/rest/api/3/issue', { method: 'POST' }))
        .rejects.toMatchObject({ code: SYNC_AUTHORIZATION_REASONS.MALFORMED });
    }
    expect(forgeFetch).not.toHaveBeenCalled();
  });

  test('blocks when the record cannot be read', async () => {
    storeAuthorization(authorizedRecord());
    setStoreFailure(SYNC_AUTHORIZATION_KEY);

    await expect(guardedFetch('https://jira.example/rest/api/3/issue', { method: 'POST' }))
      .rejects.toMatchObject({ code: SYNC_AUTHORIZATION_REASONS.UNREADABLE });
    expect(forgeFetch).not.toHaveBeenCalled();
  });

  test('blocks a record from another installation', async () => {
    storeAuthorization(authorizedRecord({ installationId: 'installation-other-01' }));

    await expect(guardedFetch('https://jira.example/rest/api/3/issue', { method: 'POST' }))
      .rejects.toMatchObject({ code: SYNC_AUTHORIZATION_REASONS.INSTALLATION_MISMATCH });
  });

  test('blocks a record from another environment of the same app', async () => {
    storeAuthorization(authorizedRecord({ environmentId: '75401cd2-115b-4ca8-8a77-4b44b33ec233' }));

    await expect(guardedFetch('https://jira.example/rest/api/3/issue', { method: 'POST' }))
      .rejects.toMatchObject({ code: SYNC_AUTHORIZATION_REASONS.INSTALLATION_MISMATCH });
  });

  test('blocks while a restore is in progress', async () => {
    storeAuthorization(authorizedRecord({ state: SYNC_AUTHORIZATION_STATES.RESTORE_IN_PROGRESS }));

    await expect(guardedFetch('https://jira.example/rest/api/3/issue', { method: 'POST' }))
      .rejects.toMatchObject({ code: SYNC_AUTHORIZATION_REASONS.RESTORE_IN_PROGRESS });
    expect(forgeFetch).not.toHaveBeenCalled();
  });

  test('blocks an explicitly blocked installation', async () => {
    storeAuthorization(authorizedRecord({ state: SYNC_AUTHORIZATION_STATES.BLOCKED }));

    await expect(guardedFetch('https://jira.example/rest/api/3/issue', { method: 'POST' }))
      .rejects.toMatchObject({ code: SYNC_AUTHORIZATION_REASONS.BLOCKED });
  });

  test('blocks when no organization is configured', async () => {
    seedOrganizations([]);
    storeAuthorization(authorizedRecord());

    await expect(guardedFetch('https://jira.example/rest/api/3/issue', { method: 'POST' }))
      .rejects.toMatchObject({ code: SYNC_AUTHORIZATION_REASONS.NO_ORGANIZATIONS });
  });

  test('requires every configured organization to be covered', async () => {
    seedOrganizations([{ id: 'org-1' }, { id: 'org-2' }]);
    storeAuthorization(authorizedRecord({ organizationIds: ['org-1'] }));

    await expect(guardedFetch('https://jira.example/rest/api/3/issue', { method: 'POST' }))
      .rejects.toMatchObject({ code: SYNC_AUTHORIZATION_REASONS.ORGANIZATIONS_UNVERIFIED });

    const status = await readSyncAuthorizationStatus();
    expect(status.authorized).toBe(false);
    expect(status.uncoveredOrganizationIds).toEqual(['org-2']);
    expect(status.configuredOrganizationIds).toEqual(['org-1', 'org-2']);
  });

  test('a restore for one organization never authorizes another organization', async () => {
    seedOrganizations([{ id: 'org-1' }, { id: 'org-2' }]);

    await setSyncAuthorizationState({
      state: SYNC_AUTHORIZATION_STATES.RESTORE_IN_PROGRESS,
      organizationIds: ['org-1']
    });
    await expect(guardedFetch('https://jira.example/rest/api/3/issue', { method: 'POST' }))
      .rejects.toMatchObject({ code: SYNC_AUTHORIZATION_REASONS.RESTORE_IN_PROGRESS });

    await setSyncAuthorizationState({
      state: SYNC_AUTHORIZATION_STATES.AUTHORIZED,
      organizationIds: ['org-1'],
      basis: 'restored'
    });
    await expect(guardedFetch('https://jira.example/rest/api/3/issue', { method: 'POST' }))
      .rejects.toMatchObject({ code: SYNC_AUTHORIZATION_REASONS.ORGANIZATIONS_UNVERIFIED });
    expect(forgeFetch).not.toHaveBeenCalled();
  });

  test('allows writes once every organization is covered and the pause is off', async () => {
    seedOrganizations([{ id: 'org-1' }, { id: 'org-2' }]);
    storeAuthorization(authorizedRecord({ organizationIds: ['org-1', 'org-2'] }));

    const status = await assertSyncAuthorized();
    expect(status.authorized).toBe(true);
    await guardedFetch('https://jira.example/rest/api/3/issue', { method: 'POST' });
    expect(forgeFetch).toHaveBeenCalledTimes(1);
  });
});

describe('exact organization-set equality', () => {
  test('removing an authorized organization invalidates the record', async () => {
    // Authorized for org-1 and org-2, but only org-1 is still configured. The
    // old containment check accepted this; exact equality must refuse it.
    seedOrganizations([{ id: 'org-1' }]);
    storeAuthorization(authorizedRecord({ organizationIds: ['org-1', 'org-2'] }));

    const status = await readSyncAuthorizationStatus();
    expect(status.authorized).toBe(false);
    expect(status.reason).toBe(SYNC_AUTHORIZATION_REASONS.ORGANIZATION_SET_CHANGED);
    expect(status.organizationSetDelta).toEqual({ added: [], removed: ['org-2'] });
    expect(status.message).toContain('added or removed');

    await expect(guardedFetch('https://jira.example/rest/api/3/issue', { method: 'POST' }))
      .rejects.toMatchObject({ code: SYNC_AUTHORIZATION_REASONS.ORGANIZATION_SET_CHANGED });
    expect(forgeFetch).not.toHaveBeenCalled();
  });

  test('re-adding a previously authorized organization does not silently restore coverage', async () => {
    seedOrganizations([{ id: 'org-1' }, { id: 'org-2' }]);
    storeAuthorization(authorizedRecord({ organizationIds: ['org-1', 'org-2'] }));

    seedOrganizations([{ id: 'org-1' }]);
    expect((await readSyncAuthorizationStatus()).reason)
      .toBe(SYNC_AUTHORIZATION_REASONS.ORGANIZATION_SET_CHANGED);

    // The same record is reused after the organization comes back: exact equality
    // holds again, which is why the removal itself had to invalidate writes.
    seedOrganizations([{ id: 'org-1' }, { id: 'org-2' }]);
    const restored = await readSyncAuthorizationStatus();
    expect(restored.authorized).toBe(true);
  });

  test('adding a configured organization is reported as uncovered coverage', async () => {
    seedOrganizations([{ id: 'org-1' }, { id: 'org-2' }]);
    storeAuthorization(authorizedRecord({ organizationIds: ['org-1'] }));

    const status = await readSyncAuthorizationStatus();
    expect(status.authorized).toBe(false);
    expect(status.reason).toBe(SYNC_AUTHORIZATION_REASONS.ORGANIZATIONS_UNVERIFIED);
    expect(status.organizationSetDelta).toEqual({ added: ['org-2'], removed: [] });
  });

  test('the order of organizations never changes the decision', async () => {
    seedOrganizations([{ id: 'org-2' }, { id: 'org-1' }]);
    storeAuthorization(authorizedRecord({
      organizationIds: ['org-1', 'org-2'],
      organizationSetDigest: syncAuthorizationOrganizationDigest(['org-2', 'org-1'])
    }));

    const status = await assertSyncAuthorized();
    expect(status.authorized).toBe(true);
    expect(status.configuredOrganizationIds).toEqual(['org-1', 'org-2']);
  });

  test('a digest that disagrees with the stored set is refused even when the sets match', async () => {
    seedOrganizations([{ id: 'org-1' }, { id: 'org-2' }]);
    storeAuthorization(authorizedRecord({
      organizationIds: ['org-1', 'org-2'],
      organizationSetDigest: syncAuthorizationOrganizationDigest(['org-1'])
    }));

    const status = await readSyncAuthorizationStatus();
    expect(status.authorized).toBe(false);
    expect(status.reason).toBe(SYNC_AUTHORIZATION_REASONS.ORGANIZATION_SET_CHANGED);
    expect(status.organizationSetDelta).toEqual({ added: [], removed: [] });
  });

  test('a record written before digests existed is still compared by exact set', async () => {
    seedOrganizations([{ id: 'org-1' }]);
    const legacy = authorizedRecord({ organizationIds: ['org-1'] });
    delete legacy.organizationSetDigest;
    storeAuthorization(legacy);

    expect((await readSyncAuthorizationStatus()).authorized).toBe(true);

    seedOrganizations([{ id: 'org-1' }, { id: 'org-2' }]);
    expect((await readSyncAuthorizationStatus()).reason)
      .toBe(SYNC_AUTHORIZATION_REASONS.ORGANIZATIONS_UNVERIFIED);
  });

  test('authorization stores the canonical set digest', async () => {
    seedOrganizations([{ id: 'org-2' }, { id: 'org-1' }]);
    const confirmation = syncAuthorizationConfirmation({
      installationId: INSTALLATION_ID,
      organizationIds: ['org-1', 'org-2']
    });

    await authorizeSynchronization({ confirmation, accountId: 'admin-account' });

    const stored = storeSnapshot().get(SYNC_AUTHORIZATION_KEY);
    expect(stored.organizationIds).toEqual(['org-1', 'org-2']);
    expect(stored.organizationSetDigest)
      .toBe(syncAuthorizationOrganizationDigest(['org-1', 'org-2']));
    expect(stored.organizationSetDigest).toBe(syncAuthorizationOrganizationDigest(['org-2', 'org-1']));
    expect(stored.organizationSetDigest).not.toBe(syncAuthorizationOrganizationDigest(['org-1']));
  });

  test('the digest is order independent and ignores duplicates', () => {
    expect(syncAuthorizationOrganizationDigest(['org-2', 'org-1', 'org-2']))
      .toBe(syncAuthorizationOrganizationDigest(['org-1', 'org-2']));
    expect(syncAuthorizationOrganizationDigest([]))
      .toBe(syncAuthorizationOrganizationDigest([]));
  });
});


describe('legacy installation activation', () => {
  test('an established installation stays blocked until it is explicitly authorized', async () => {
    seedOrganizations([{ id: 'org-1', name: 'Established org' }]);
    kvsStore.set('mapping-meta:org-1:LOCAL-1', {
      localKey: 'LOCAL-1', remoteKey: 'VEND-1', orgId: 'org-1'
    });

    const before = await readSyncAuthorizationStatus();
    expect(before.authorized).toBe(false);
    expect(before.reason).toBe(SYNC_AUTHORIZATION_REASONS.MISSING);
    expect(before.configuredOrganizationIds).toEqual(['org-1']);

    const confirmation = syncAuthorizationConfirmation({
      installationId: INSTALLATION_ID,
      organizationIds: ['org-1']
    });
    expect(confirmation).toBe(`AUTHORIZE ${INSTALLATION_ID} org-1`);
    expect(before.confirmationPhrase).toBeUndefined();

    const activated = await authorizeSynchronization({ confirmation, accountId: 'admin-account' });
    expect(activated).toMatchObject({
      success: true,
      state: SYNC_AUTHORIZATION_STATES.AUTHORIZED,
      organizationIds: ['org-1'],
      jiraWritesPerformed: false
    });

    await guardedFetch('https://jira.example/rest/api/3/issue', { method: 'POST' });
    expect(forgeFetch).toHaveBeenCalledTimes(1);
  });

  test('rejects a wrong confirmation without writing anything or calling Jira', async () => {
    seedOrganizations([{ id: 'org-1' }]);
    const before = storeSnapshot();

    await expect(authorizeSynchronization({ confirmation: 'AUTHORIZE nope' }))
      .rejects.toMatchObject({ code: SYNC_AUTHORIZATION_REASONS.CONFIRMATION_REQUIRED });
    await expect(authorizeSynchronization({})).rejects
      .toMatchObject({ code: SYNC_AUTHORIZATION_REASONS.CONFIRMATION_REQUIRED });

    expect(authorizationKeys()).toEqual([]);
    expect(storeSnapshot().size).toBe(before.size);
    expect(requestJira).not.toHaveBeenCalled();
    expect(forgeFetch).not.toHaveBeenCalled();
  });

  test('writes exactly one storage record and performs no Jira request', async () => {
    seedOrganizations([{ id: 'org-1' }, { id: 'org-2' }]);
    const confirmation = syncAuthorizationConfirmation({
      installationId: INSTALLATION_ID,
      organizationIds: ['org-2', 'org-1']
    });

    const result = await authorizeSynchronization({ confirmation, accountId: 'admin-account' });

    expect(result.organizationIds).toEqual(['org-1', 'org-2']);
    expect(kvsStore.set).toHaveBeenCalledTimes(1);
    expect(authorizationKeys()).toHaveLength(1);
    const record = storeSnapshot().get(SYNC_AUTHORIZATION_KEY);
    expect(record).toMatchObject({
      version: 1,
      state: SYNC_AUTHORIZATION_STATES.AUTHORIZED,
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      installationId: INSTALLATION_ID,
      organizationIds: ['org-1', 'org-2'],
      basis: 'established',
      authorizedBy: 'admin-account'
    });
    expect(SYNC_AUTHORIZATION_BASES).toContain(record.basis);
    expect(requestJira).not.toHaveBeenCalled();
    expect(forgeFetch).not.toHaveBeenCalled();
  });

  test('authorizing does not lift the pause', async () => {
    kvsStore.set('pilotPause', {
      paused: true,
      pausedAt: '2026-10-26T00:00:00.000Z',
      pausedBy: 'admin-account',
      reasonCode: 'emergency_stop'
    });
    seedOrganizations([{ id: 'org-1' }]);
    const confirmation = syncAuthorizationConfirmation({
      installationId: INSTALLATION_ID,
      organizationIds: ['org-1']
    });
    await authorizeSynchronization({ confirmation });

    await expect(guardedFetch('https://jira.example/rest/api/3/issue', { method: 'POST' }))
      .rejects.toMatchObject({ code: 'PILOT_PAUSED' });
    expect(forgeFetch).not.toHaveBeenCalled();
  });

  test('refuses activation when the installation identity is unavailable', async () => {
    getAppContext.mockReturnValue(undefined);

    await expect(authorizeSynchronization({
      confirmation: `AUTHORIZE ${INSTALLATION_ID} org-1`
    })).rejects.toMatchObject({ code: SYNC_AUTHORIZATION_REASONS.IDENTITY_UNAVAILABLE });
    expect(authorizationKeys()).toEqual([]);
  });

  test('refuses activation when no organization is configured', async () => {
    seedOrganizations([]);

    await expect(authorizeSynchronization({
      confirmation: `AUTHORIZE ${INSTALLATION_ID} org-1`
    })).rejects.toMatchObject({ code: SYNC_AUTHORIZATION_REASONS.NO_ORGANIZATIONS });
    expect(authorizationKeys()).toEqual([]);
  });

  test('refuses an unknown state transition', async () => {
    seedOrganizations([{ id: 'org-1' }]);

    await expect(setSyncAuthorizationState({ state: 'trusted', organizationIds: ['org-1'] }))
      .rejects.toMatchObject({ code: SYNC_AUTHORIZATION_REASONS.INVALID_STATE });
    expect(authorizationKeys()).toEqual([]);
  });
});

describe('transport wiring', () => {
  const root = process.cwd();
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

  function listSourceFiles(directory) {
    const entries = fs.readdirSync(path.join(root, directory), { withFileTypes: true });
    return entries.flatMap((entry) => {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return listSourceFiles(relative);
      return entry.name.endsWith('.js') ? [relative] : [];
    });
  }

  test('the guarded transport asserts synchronization authorization', () => {
    const source = read('src/services/jira/guarded-api.js');
    expect(source).toContain("from '../sync/sync-authorization.js'");
    expect(source).toMatch(/await assertSyncAuthorized\(\)/);
    const authorizationIndex = source.indexOf('await assertSyncAuthorized()');
    const sendIndex = source.indexOf('return forgeFetch(url, options)');
    expect(authorizationIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(authorizationIndex);
  });

  test('every Jira mutation call site is guarded or explicitly exempt', () => {
    const allowlist = new Map([
      ['src/triggers/bulk-sync.js', 'legacy queue consumer is disabled and returns before any Jira call'],
      ['src/resolvers/data.js', 'only write verb is the enhanced-search read POST /rest/api/3/search/jql'],
      ['src/services/sync/initial-sync.js', 'only write verb is the enhanced-search read POST /rest/api/3/search/jql']
    ]);
    const offenders = [];
    for (const file of listSourceFiles('src')) {
      const source = read(file);
      if (!/method:\s*'(POST|PUT|DELETE)'/.test(source)) continue;
      if (allowlist.has(file)) continue;
      if (!source.includes('guarded-api')) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test('the exemptions are still real', () => {
    const bulk = read('src/triggers/bulk-sync.js');
    expect(bulk).toContain('BULK_SYNC_CONSUMER_DISABLED');
    expect(bulk).toMatch(/export async function run\(\) \{\s*return \{\s*success: false/);

    for (const file of ['src/resolvers/data.js', 'src/services/sync/initial-sync.js']) {
      const source = read(file);
      const indexes = [...source.matchAll(/method:\s*'POST'/g)].map((match) => match.index);
      expect(indexes.length).toBeGreaterThan(0);
      for (const index of indexes) {
        const window = source.slice(Math.max(0, index - 400), index + 60);
        expect(window).toContain('/rest/api/3/search/jql');
      }
    }
  });

  test('every synchronization entry point routes through the guarded transport', () => {
    const entryPoints = new Map([
      ['src/services/sync/issue-sync.js', 'guarded-api'],
      ['src/services/sync/incoming-sync.js', 'guarded-api'],
      ['src/services/sync/comment-sync.js', 'guarded-api'],
      ['src/services/sync/comment-submission.js', 'guarded-api'],
      ['src/services/sync/link-sync.js', 'guarded-api'],
      ['src/services/sync/transition-sync.js', 'guarded-api'],
      ['src/services/sync/attachment-sync.js', 'attachment-client'],
      ['src/services/sync/initial-sync.js', "from './issue-sync.js'"],
      ['src/services/scheduled/scheduled-sync.js', 'guarded-api'],
      ['src/services/scheduled/scheduled-scan.js', 'guarded-api'],
      ['src/triggers/link-deleted.js', 'guarded-api']
    ]);
    for (const [file, marker] of entryPoints) {
      expect(read(file)).toContain(marker);
    }
  });

  test('the authorization module performs no Jira call and no write helper import', () => {
    const source = read('src/services/sync/sync-authorization.js');
    expect(source).not.toMatch(/requestJira\(/);
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toContain('issue-sync');
    expect(source).not.toContain('lease-migration');
    expect(source).not.toContain('recovery-snapshot');
  });
});
