/**
 * Real guarded transport boundary for sprint maintenance.
 *
 * Only the Forge SDK, KVS, pause/auth and lease gates are modelled. Production
 * `guarded-api` and `sprint-permit` execute unchanged.
 */
import { getAppContext } from '@forge/api';
import { fetch as guardedFetch } from '../src/services/jira/guarded-api.js';
import { assertJiraSubmissionAllowed } from '../src/services/jira/guarded-api.js';
import { assertSyncAuthorized } from '../src/services/sync/sync-authorization.js';
import { assertIssueLeaseMigrationReady } from '../src/services/sync/lease-migration.js';
import { assertCurrentIssueLeases } from '../src/services/sync/issue-lease-context.js';
import {
  SPRINT_PERMIT_KEY,
  SPRINT_PERMIT_REASONS,
  issueSprintPermit,
  revokeSprintPermit
} from '../src/services/sync/sprint-permit.js';
import { resetStore, seed, store } from './helpers/pair-witness-store.js';

jest.mock('@forge/api', () => {
  const requestJira = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  const fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  return {
    __esModule: true,
    default: { asApp: () => ({ requestJira }), asUser: () => ({ requestJira }) },
    getAppContext: jest.fn(),
    route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch
  };
});

jest.mock('../src/services/storage/kvs.js', () => require('./helpers/pair-witness-store.js').kvsModule);
jest.mock('../src/services/storage/stats.js', () => ({
  logAuditEntry: jest.fn(),
  trackWebhookSync: jest.fn(),
  trackApiCall: jest.fn()
}));
jest.mock('../src/services/sync/sync-authorization.js', () => ({
  assertSyncAuthorized: jest.fn(async () => ({ authorized: true }))
}));
jest.mock('../src/services/sync/lease-migration.js', () => ({
  assertIssueLeaseMigrationReady: jest.fn(async () => true)
}));
jest.mock('../src/services/sync/issue-lease-context.js', () => ({
  assertCurrentIssueLeases: jest.fn(async () => true)
}));

const APP_ID = '362d8e6b-b68c-4403-8020-d32ddcc02716';
const ENVIRONMENT_ID = '2e8c0cb5-881a-4345-b9ba-e887f790d316';
const INSTALLATION_ID = '974910c5-2861-4d40-a7eb-37802842d0a0';
const DIGEST = `sha256:${'b'.repeat(64)}`;
const LOCAL_PATH = '/rest/agile/1.0/sprint/10/issue';
const REMOTE_PATH = 'https://remote.example.com/jira/rest/agile/1.0/sprint/20/issue';

function body(issues) {
  return JSON.stringify({ issues });
}

function seedPause(paused = true) {
  seed('pilotPause', { paused, pausedAt: '2026-01-01T00:00:00.000Z', reasonCode: 'PILOT_CHANGE' });
}

async function seedPermit(entries = [{
  side: 'local',
  sprintId: '10',
  issues: ['LOCAL-2']
}]) {
  return issueSprintPermit({ orgId: 'org-1', digest: DIGEST, entries });
}

beforeEach(() => {
  resetStore();
  jest.clearAllMocks();
  getAppContext.mockReturnValue({
    appAri: { appId: APP_ID },
    environmentAri: { environmentId: ENVIRONMENT_ID },
    installationAri: { installationId: INSTALLATION_ID }
  });
  seedPause(true);
  seed('syncOptions:org-1', { syncSprints: true });
  assertSyncAuthorized.mockResolvedValue({ authorized: true });
  assertIssueLeaseMigrationReady.mockResolvedValue(true);
  assertCurrentIssueLeases.mockResolvedValue(true);
});

describe('sprint maintenance at the real guarded boundary', () => {
  test('an exact approved sprint POST writes while Pause remains ON', async () => {
    const permit = await seedPermit();
    const decision = await assertJiraSubmissionAllowed(LOCAL_PATH, {
      method: 'POST',
      body: body(['LOCAL-2'])
    });
    expect(decision).toEqual(expect.objectContaining({
      allowed: true,
      kind: 'sprint',
      side: 'local',
      sprintId: '10'
    }));
    expect(decision.permit.permitId).toBe(permit.permitId);

    await revokeSprintPermit();
    await seedPermit();
    const forgeFetch = jest.requireMock('@forge/api').fetch;
    await guardedFetch(LOCAL_PATH, { method: 'POST', body: body(['LOCAL-2']) });
    expect(forgeFetch).toHaveBeenCalledWith(LOCAL_PATH, { method: 'POST', body: body(['LOCAL-2']) });
  });

  test('without a permit, Pause still refuses the sprint POST', async () => {
    await expect(assertJiraSubmissionAllowed(LOCAL_PATH, {
      method: 'POST',
      body: body(['LOCAL-2'])
    })).rejects.toMatchObject({ code: 'PILOT_PAUSED' });
    expect(assertSyncAuthorized).not.toHaveBeenCalled();
  });

  test('without a permit, missing Sync Authorization still refuses an unpaused ordinary POST', async () => {
    seedPause(false);
    assertSyncAuthorized.mockRejectedValueOnce(Object.assign(new Error('blocked'), {
      code: 'SYNC_AUTHORIZATION_MISSING'
    }));
    await expect(assertJiraSubmissionAllowed(LOCAL_PATH, {
      method: 'POST',
      body: body(['LOCAL-2'])
    })).rejects.toMatchObject({ code: 'SYNC_AUTHORIZATION_MISSING' });
    expect(assertSyncAuthorized).toHaveBeenCalled();
  });

  test('a permit is refused when Pause is turned off or authorization is missing', async () => {
    await seedPermit();
    seedPause(false);
    await expect(assertJiraSubmissionAllowed(LOCAL_PATH, {
      method: 'POST',
      body: body(['LOCAL-2'])
    })).rejects.toMatchObject({
      code: 'SPRINT_PERMIT_REFUSED',
      reason: SPRINT_PERMIT_REASONS.PAUSE_NOT_CONFIRMED
    });

    await revokeSprintPermit();
    seedPause(true);
    await seedPermit();
    assertSyncAuthorized.mockRejectedValueOnce(Object.assign(new Error('blocked'), {
      code: 'SYNC_AUTHORIZATION_MISSING'
    }));
    await expect(assertJiraSubmissionAllowed(LOCAL_PATH, {
      method: 'POST',
      body: body(['LOCAL-2'])
    })).rejects.toMatchObject({
      code: 'SPRINT_PERMIT_REFUSED',
      reason: SPRINT_PERMIT_REASONS.AUTHORIZATION_REQUIRED
    });
  });

  test('a permit cannot be used after Sync Sprints is disabled', async () => {
    await seedPermit();
    seed('syncOptions:org-1', { syncSprints: false });
    await expect(assertJiraSubmissionAllowed(LOCAL_PATH, {
      method: 'POST',
      body: body(['LOCAL-2'])
    })).rejects.toMatchObject({
      code: 'SPRINT_PERMIT_REFUSED',
      reason: SPRINT_PERMIT_REASONS.OPTION_DISABLED
    });
  });

  test('an expired permit is refused before any transport call', async () => {
    const permit = await seedPermit();
    seed(SPRINT_PERMIT_KEY, { ...permit, expiresAt: Date.now() - 1 });
    await expect(assertJiraSubmissionAllowed(LOCAL_PATH, {
      method: 'POST',
      body: body(['LOCAL-2'])
    })).rejects.toMatchObject({
      code: 'SPRINT_PERMIT_REFUSED',
      reason: SPRINT_PERMIT_REASONS.EXPIRED
    });
  });

  test('wrong sprint, wrong body and replay are refused as permit-scope violations', async () => {
    await seedPermit();
    await expect(assertJiraSubmissionAllowed('/rest/agile/1.0/sprint/11/issue', {
      method: 'POST',
      body: body(['LOCAL-2'])
    })).rejects.toMatchObject({ code: 'SPRINT_PERMIT_REFUSED' });
    await expect(assertJiraSubmissionAllowed(LOCAL_PATH, {
      method: 'POST',
      body: body(['LOCAL-3'])
    })).rejects.toMatchObject({ code: 'SPRINT_PERMIT_REFUSED' });

    await expect(assertJiraSubmissionAllowed(LOCAL_PATH, {
      method: 'POST',
      body: body(['LOCAL-2'])
    })).resolves.toEqual(expect.objectContaining({ kind: 'sprint' }));
    await expect(assertJiraSubmissionAllowed(LOCAL_PATH, {
      method: 'POST',
      body: body(['LOCAL-2'])
    })).rejects.toMatchObject({
      code: 'SPRINT_PERMIT_REFUSED',
      reason: SPRINT_PERMIT_REASONS.ALREADY_USED
    });
  });

  test('a remote permit is bound to the remote host and exact sprint id', async () => {
    await seedPermit([{
      side: 'remote',
      sprintId: '20',
      host: 'remote.example.com',
      issues: ['VEND-2']
    }]);
    const decision = await assertJiraSubmissionAllowed(REMOTE_PATH, {
      method: 'POST',
      body: body(['VEND-2'])
    });
    expect(decision).toEqual(expect.objectContaining({
      allowed: true,
      kind: 'sprint',
      side: 'remote',
      sprintId: '20'
    }));
    await expect(assertJiraSubmissionAllowed(
      'https://other.example.com/jira/rest/agile/1.0/sprint/20/issue',
      { method: 'POST', body: body(['VEND-2']) }
    )).rejects.toMatchObject({ code: 'SPRINT_PERMIT_REFUSED' });
  });

  test('a permit does not authorize an unrelated issue POST', async () => {
    await seedPermit();
    await expect(assertJiraSubmissionAllowed('/rest/api/3/issue', {
      method: 'POST',
      body: body(['LOCAL-2'])
    })).rejects.toMatchObject({ code: 'PILOT_PAUSED' });
  });

  test('revocation removes the only permit', async () => {
    await seedPermit();
    expect(await revokeSprintPermit()).toBe(true);
    expect(await store.get(SPRINT_PERMIT_KEY)).toBeNull();
  });
});

