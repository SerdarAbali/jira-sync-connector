const mockStore = new Map();

jest.mock('@forge/api', () => ({
  __esModule: true,
  default: { asApp: () => ({ requestJira: jest.fn() }), asUser: () => ({ requestJira: jest.fn() }) },
  getAppContext: jest.fn(),
  route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
  fetch: jest.fn(async () => ({ ok: true, status: 200 }))
}));

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(async key => (mockStore.has(key) ? mockStore.get(key) : null)),
  set: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  del: jest.fn(async key => { mockStore.delete(key); })
}));

jest.mock('../src/services/sync/sync-authorization.js', () => ({
  assertSyncAuthorized: jest.fn(async () => ({ authorized: true }))
}));

jest.mock('../src/services/sync/lease-migration.js', () => ({
  assertIssueLeaseMigrationReady: jest.fn(async () => undefined)
}));

jest.mock('../src/services/sync/issue-lease-context.js', () => ({
  assertCurrentIssueLeases: jest.fn(async () => undefined)
}));

jest.mock('../src/services/sync/pair-witness-permit.js', () => {
  const actual = jest.requireActual('../src/services/sync/pair-witness-permit.js');
  return actual;
});

import { fetch } from '@forge/api';
import { assertSyncAuthorized } from '../src/services/sync/sync-authorization.js';
import { assertJiraSubmissionAllowed } from '../src/services/jira/guarded-api.js';
import { assertIssueLeaseMigrationReady } from '../src/services/sync/lease-migration.js';
import { assertCurrentIssueLeases } from '../src/services/sync/issue-lease-context.js';

const PROPERTY_PATH = '/rest/api/3/issue/10001/properties/sync-connector-pair';
const OPTIONS = {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ v: 1 })
};

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
  assertSyncAuthorized.mockResolvedValue({ authorized: true });
  assertIssueLeaseMigrationReady.mockResolvedValue(undefined);
  assertCurrentIssueLeases.mockResolvedValue(undefined);
});

describe('normal witness property writes at the guarded boundary', () => {
  test('without any maintenance permit an unpaused, authorized property write is ordinary', async () => {
    mockStore.set('pilotPause', { paused: false });

    const decision = await assertJiraSubmissionAllowed(PROPERTY_PATH, OPTIONS);

    expect(decision).toBeNull();
    expect(assertSyncAuthorized).toHaveBeenCalled();
  });

  test('without a permit a paused property write is still refused', async () => {
    mockStore.set('pilotPause', { paused: true, reasonCode: 'emergency_stop' });

    await expect(assertJiraSubmissionAllowed(PROPERTY_PATH, OPTIONS))
      .rejects.toMatchObject({ code: 'PILOT_PAUSED' });
  });

  test('without a permit a blocked synchronization authorization is still refused', async () => {
    mockStore.set('pilotPause', { paused: false });
    assertSyncAuthorized.mockRejectedValueOnce(Object.assign(new Error('blocked'), {
      code: 'SYNC_AUTHORIZATION_MISSING'
    }));

    await expect(assertJiraSubmissionAllowed(PROPERTY_PATH, OPTIONS))
      .rejects.toMatchObject({ code: 'SYNC_AUTHORIZATION_MISSING' });
  });

  test('an existing but malformed permit is refused outright, never downgraded', async () => {
    mockStore.set('pilotPause', { paused: false });
    mockStore.set('pairWitnessPermit', { malformed: true });

    await expect(assertJiraSubmissionAllowed(PROPERTY_PATH, OPTIONS))
      .rejects.toMatchObject({ code: 'PAIR_WITNESS_PERMIT_REFUSED' });
    expect(assertSyncAuthorized).not.toHaveBeenCalled();
  });

  test('a malformed pause record blocks an ordinary witness-establishment write', async () => {
    mockStore.set('pilotPause', { paused: 'yes' });

    await expect(assertJiraSubmissionAllowed(PROPERTY_PATH, OPTIONS))
      .rejects.toMatchObject({ code: 'PILOT_PAUSED' });
  });

  test('the lease-migration gate still applies to ordinary witness writes', async () => {
    mockStore.set('pilotPause', { paused: false });
    assertIssueLeaseMigrationReady.mockRejectedValueOnce(
      Object.assign(new Error('migration required'), { code: 'LEASE_MIGRATION_REQUIRED' })
    );

    await expect(assertJiraSubmissionAllowed(PROPERTY_PATH, OPTIONS))
      .rejects.toMatchObject({ code: 'LEASE_MIGRATION_REQUIRED' });
    expect(assertSyncAuthorized).not.toHaveBeenCalled();
  });

  test('the current-lease gate still applies after authorization', async () => {
    mockStore.set('pilotPause', { paused: false });
    assertCurrentIssueLeases.mockRejectedValueOnce(
      Object.assign(new Error('lease held'), { code: 'ISSUE_LEASE_HELD' })
    );

    await expect(assertJiraSubmissionAllowed(PROPERTY_PATH, OPTIONS))
      .rejects.toMatchObject({ code: 'ISSUE_LEASE_HELD' });
  });

  test('a GET is never treated as a permit-shaped write', async () => {
    mockStore.set('pilotPause', { paused: true, reasonCode: 'emergency_stop' });

    await expect(assertJiraSubmissionAllowed(PROPERTY_PATH, { method: 'GET' }))
      .resolves.toBeNull();
  });

  test('the ordinary boundary still submits through the SDK transport', async () => {
    mockStore.set('pilotPause', { paused: false });
    const forgeFetch = jest.requireMock('@forge/api').fetch;

    await fetch(PROPERTY_PATH, OPTIONS);

    expect(forgeFetch).toHaveBeenCalledWith(PROPERTY_PATH, OPTIONS);
  });
});
