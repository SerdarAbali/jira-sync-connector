/**
 * Jira issue-property pairing witness: schema, canonical form and read classes.
 *
 * The production module runs unmodified. Only the Forge SDK surface and the KVS
 * boundary are modelled, so the assertions describe what the deployed app does:
 * a witness is either a complete canonical record or it is refused, and an
 * unreadable witness is never reported as absent.
 */
import fs from 'fs';
import path from 'path';
import api from '@forge/api';
import { resetStore } from './helpers/pair-witness-store.js';
import {
  PAIR_WITNESS_CODES,
  PAIR_WITNESS_ISSUE_CLASSES,
  PAIR_WITNESS_READ_CLASSES,
  PAIR_WITNESS_STATES,
  PairWitnessError,
  buildPairWitness,
  classifyIssueResponse,
  classifyPairWitnessResponse,
  pairWitnessBlocksCreation,
  pairWitnessDigest,
  parsePairWitnessValue,
  readIssueIdentity,
  readPairWitness,
  serializePairWitness
} from '../src/services/sync/pair-witness.js';

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  const fetch = jest.fn();
  return {
    __esModule: true,
    default: { asApp: () => ({ requestJira }), asUser: () => ({ requestJira }) },
    getAppContext: jest.fn(() => ({
      appAri: { appId: '362d8e6b-b68c-4403-8020-d32ddcc02716' },
      environmentAri: { environmentId: '2e8c0cb5-881a-4345-b9ba-e887f790d316' },
      installationAri: { installationId: '974910c5-2861-4d40-a7eb-37802842d0a0' }
    })),
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

const requestJira = api.asApp().requestJira;
const forgeFetch = require('@forge/api').fetch;

const INSTALLATION_ID = '974910c5-2861-4d40-a7eb-37802842d0a0';
const APP_ID = '362d8e6b-b68c-4403-8020-d32ddcc02716';
const LOCAL_SITE = '11111111-2222-4333-8444-555555555555';
const REMOTE_SITE = 'remote.atlassian.net';
const PAIR_ID = '3f6c1a8e-9b21-4f0d-9d4e-6a1b2c3d4e5f';

const ORG = {
  id: 'org-1',
  remoteUrl: 'https://remote.atlassian.net',
  remoteEmail: 'sync@example.com',
  remoteApiToken: 'remote-token'
};

function witness(overrides = {}) {
  return buildPairWitness({
    pairId: PAIR_ID,
    state: PAIR_WITNESS_STATES.ACTIVE,
    installationId: INSTALLATION_ID,
    appId: APP_ID,
    orgId: 'org-1',
    localSite: LOCAL_SITE,
    remoteSite: REMOTE_SITE,
    localIssueId: '10001',
    localKey: 'LOCAL-1',
    remoteIssueId: '20881',
    remoteKey: 'REMOT-1',
    direction: 'local-to-remote',
    writtenAt: '2026-10-26T09:41:12.004Z',
    ...overrides
  });
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    }
  };
}

const EXPECTED = {
  installationId: INSTALLATION_ID,
  appId: APP_ID,
  orgId: 'org-1',
  localSite: LOCAL_SITE,
  remoteSite: REMOTE_SITE
};

beforeEach(() => {
  resetStore();
  jest.clearAllMocks();
});

describe('witness schema', () => {
  test('builds a version 1 record with a stable digest', () => {
    const record = witness();
    expect(record.v).toBe(1);
    expect(record.pairId).toBe(PAIR_ID);
    expect(record.state).toBe('active');
    expect(record.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(pairWitnessDigest(record)).toBe(record.digest);
  });

  test('serialization is canonical regardless of field insertion order', () => {
    const record = witness();
    const reordered = {
      digest: record.digest,
      writtenAt: record.writtenAt,
      direction: record.direction,
      remoteKey: record.remoteKey,
      remoteIssueId: record.remoteIssueId,
      localKey: record.localKey,
      localIssueId: record.localIssueId,
      remoteSite: record.remoteSite,
      localSite: record.localSite,
      orgId: record.orgId,
      appId: record.appId,
      installationId: record.installationId,
      state: record.state,
      pairId: record.pairId,
      v: record.v
    };
    expect(serializePairWitness(reordered)).toBe(serializePairWitness(record));
    expect(parsePairWitnessValue(reordered).ok).toBe(true);
  });

  test('a built value is far below the Jira property limits', () => {
    expect(Buffer.byteLength(JSON.stringify(witness()), 'utf8')).toBeLessThan(1024);
    expect(Buffer.byteLength('sync-connector-pair', 'utf8')).toBeLessThan(255);
  });

  test.each([
    ['pairId', { pairId: 'not-a-uuid' }],
    ['state', { state: 'trusted' }],
    ['installationId', { installationId: 'short' }],
    ['appId', { appId: null }],
    ['orgId', { orgId: 'organization-1' }],
    ['localSite', { localSite: '' }],
    ['remoteSite', { remoteSite: 42 }],
    ['localIssueId', { localIssueId: 'abc' }],
    ['remoteIssueId', { remoteIssueId: '' }],
    ['localKey', { localKey: 'not a key' }],
    ['remoteKey', { remoteKey: '' }],
    ['direction', { direction: 'sideways' }],
    ['writtenAt', { writtenAt: 'yesterday' }]
  ])('refuses to build a record with an invalid %s', (field, overrides) => {
    try {
      witness(overrides);
      throw new Error('expected the builder to refuse the record');
    } catch (error) {
      expect(error).toBeInstanceOf(PairWitnessError);
      expect(error.code).toBe(PAIR_WITNESS_CODES.INVALID_INPUT);
      expect(error.details.field).toBe(field);
    }
  });

  test('parses a record this connector wrote', () => {
    const parsed = parsePairWitnessValue(witness());
    expect(parsed.ok).toBe(true);
    expect(parsed.record).toMatchObject({ pairId: PAIR_ID, state: 'active', localIssueId: '10001' });
  });

  test('a newer schema version is reported, never coerced', () => {
    const parsed = parsePairWitnessValue({ ...witness(), v: 2 });
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe(PAIR_WITNESS_CODES.SCHEMA_UNKNOWN);
  });

  test('a tampered field fails the digest check', () => {
    const parsed = parsePairWitnessValue({ ...witness(), remoteIssueId: '99999' });
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe(PAIR_WITNESS_CODES.MALFORMED);
  });

  test('a record without a digest, with a missing field or of the wrong shape is malformed', () => {
    const withoutDigest = { ...witness() };
    delete withoutDigest.digest;
    expect(parsePairWitnessValue(withoutDigest).code).toBe(PAIR_WITNESS_CODES.MALFORMED);
    expect(parsePairWitnessValue({ ...witness(), orgId: undefined }).code)
      .toBe(PAIR_WITNESS_CODES.MALFORMED);
    expect(parsePairWitnessValue('not-an-object').code).toBe(PAIR_WITNESS_CODES.MALFORMED);
    expect(parsePairWitnessValue({ v: 1 }).code).toBe(PAIR_WITNESS_CODES.MALFORMED);
  });
});


describe('property read classification', () => {
  const classify = (overrides = {}) => classifyPairWitnessResponse({
    side: 'local',
    status: 200,
    body: { key: 'sync-connector-pair', value: witness() },
    expected: EXPECTED,
    ...overrides
  });

  test('404 means absent and only absent', () => {
    expect(classify({ status: 404, body: null })).toMatchObject({
      class: PAIR_WITNESS_READ_CLASSES.ABSENT,
      code: PAIR_WITNESS_CODES.NOT_FOUND
    });
  });

  test.each([401, 403])('%i is inaccessible, never absent', (status) => {
    const result = classify({ status, body: null });
    expect(result.class).toBe(PAIR_WITNESS_READ_CLASSES.INACCESSIBLE);
    expect(result.class).not.toBe(PAIR_WITNESS_READ_CLASSES.ABSENT);
  });

  test('429 and 5xx are unverifiable', () => {
    expect(classify({ status: 429, body: null })).toMatchObject({
      class: PAIR_WITNESS_READ_CLASSES.UNVERIFIABLE,
      code: PAIR_WITNESS_CODES.RATE_LIMITED
    });
    expect(classify({ status: 503, body: null })).toMatchObject({
      class: PAIR_WITNESS_READ_CLASSES.UNVERIFIABLE,
      code: PAIR_WITNESS_CODES.UNAVAILABLE
    });
  });

  test('a transport failure is unverifiable', () => {
    expect(classify({ transportError: true, status: null })).toMatchObject({
      class: PAIR_WITNESS_READ_CLASSES.UNVERIFIABLE,
      code: PAIR_WITNESS_CODES.NETWORK
    });
  });

  test('an unreadable body is malformed rather than absent', () => {
    expect(classify({ bodyUnreadable: true })).toMatchObject({
      class: PAIR_WITNESS_READ_CLASSES.MALFORMED
    });
    expect(classify({ body: { key: 'sync-connector-pair' } })).toMatchObject({
      class: PAIR_WITNESS_READ_CLASSES.MALFORMED
    });
  });

  test('a matching record is the only class that proves a pair', () => {
    expect(classify().class).toBe(PAIR_WITNESS_READ_CLASSES.MATCHING);
  });

  test('a malformed value and a newer schema are conflicts', () => {
    expect(classify({ body: { key: 'x', value: { v: 1 } } }).class)
      .toBe(PAIR_WITNESS_READ_CLASSES.MALFORMED);
    expect(classify({ body: { key: 'x', value: { ...witness(), v: 9 } } }).class)
      .toBe(PAIR_WITNESS_READ_CLASSES.SCHEMA_NEWER);
  });

  test('a foreign installation or app is a conflict', () => {
    const foreignInstallation = buildPairWitness({
      ...witness(),
      installationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    });
    expect(classify({ body: { key: 'x', value: foreignInstallation } })).toMatchObject({
      class: PAIR_WITNESS_READ_CLASSES.FOREIGN_INSTALLATION,
      code: PAIR_WITNESS_CODES.FOREIGN_INSTALLATION
    });
  });

  test('a foreign organization is a conflict even for an otherwise valid record', () => {
    const foreignOrg = buildPairWitness({ ...witness(), orgId: 'org-2' });
    expect(classify({ body: { key: 'x', value: foreignOrg } })).toMatchObject({
      class: PAIR_WITNESS_READ_CLASSES.FOREIGN_ORGANIZATION,
      code: PAIR_WITNESS_CODES.FOREIGN_ORGANIZATION
    });
  });

  test('a site mismatch is a conflict', () => {
    const otherSite = buildPairWitness({ ...witness(), remoteSite: 'other.atlassian.net' });
    expect(classify({ body: { key: 'x', value: otherSite } }).class)
      .toBe(PAIR_WITNESS_READ_CLASSES.SITE_MISMATCH);
  });

  test('a witness naming another issue is a conflict', () => {
    expect(classify({ expected: { ...EXPECTED, issueId: '55555' } }).class)
      .toBe(PAIR_WITNESS_READ_CLASSES.ISSUE_MISMATCH);
  });

  test('a different pair id is a conflict', () => {
    expect(classify({ expected: { ...EXPECTED, pairId: '9f6c1a8e-9b21-4f0d-9d4e-6a1b2c3d4e5f' } }).class)
      .toBe(PAIR_WITNESS_READ_CLASSES.DIFFERENT_PAIR);
  });

  test('ended and pending-create states are reported as such', () => {
    expect(classify({ body: { key: 'x', value: witness({ state: 'ended' }) } }).class)
      .toBe(PAIR_WITNESS_READ_CLASSES.ENDED);
    expect(classify({ body: { key: 'x', value: witness({ state: 'pending-create' }) } }).class)
      .toBe(PAIR_WITNESS_READ_CLASSES.PENDING_CREATE);
  });

  test('only an absent witness permits a future create', () => {
    expect(pairWitnessBlocksCreation(PAIR_WITNESS_READ_CLASSES.ABSENT)).toBe(false);
    for (const readClass of Object.values(PAIR_WITNESS_READ_CLASSES)) {
      if (readClass === PAIR_WITNESS_READ_CLASSES.ABSENT) continue;
      expect(pairWitnessBlocksCreation(readClass)).toBe(true);
    }
  });

  test('issue reads distinguish missing from inaccessible and unverifiable', () => {
    expect(classifyIssueResponse({ side: 'local', status: 404 }).class)
      .toBe(PAIR_WITNESS_ISSUE_CLASSES.MISSING);
    expect(classifyIssueResponse({ side: 'local', status: 403 }).class)
      .toBe(PAIR_WITNESS_ISSUE_CLASSES.INACCESSIBLE);
    expect(classifyIssueResponse({ side: 'local', status: 429 }).class)
      .toBe(PAIR_WITNESS_ISSUE_CLASSES.UNVERIFIABLE);
    expect(classifyIssueResponse({ side: 'local', status: 200, body: { id: '10001', key: 'LOCAL-1' } }))
      .toMatchObject({ class: PAIR_WITNESS_ISSUE_CLASSES.PRESENT, id: '10001', key: 'LOCAL-1' });
  });
});


describe('property reads use only GET through the guarded transport', () => {
  test('the local read addresses the property path on the issue and returns matching', async () => {
    requestJira.mockResolvedValue(response(200, { key: 'sync-connector-pair', value: witness() }));

    const result = await readPairWitness({ side: 'local', issueRef: '10001', expected: EXPECTED });

    expect(result.class).toBe(PAIR_WITNESS_READ_CLASSES.MATCHING);
    const [pathArg, options] = requestJira.mock.calls[0];
    expect(String(pathArg)).toContain('/rest/api/3/issue/10001/properties/sync-connector-pair');
    expect(options?.method ?? 'GET').toBe('GET');
    expect(options?.body).toBeUndefined();
  });

  test('a local 403 is inaccessible and is never reported as absent', async () => {
    requestJira.mockResolvedValue(response(403, null));

    const result = await readPairWitness({ side: 'local', issueRef: '10001', expected: EXPECTED });

    expect(result.class).toBe(PAIR_WITNESS_READ_CLASSES.INACCESSIBLE);
    expect(result.statusCode).toBe(403);
    expect(requestJira).toHaveBeenCalledTimes(1);
  });

  test('the remote read uses Basic auth, a GET and the remote site', async () => {
    forgeFetch.mockResolvedValue(response(200, { key: 'sync-connector-pair', value: witness() }));

    const result = await readPairWitness({
      side: 'remote',
      issueRef: '20881',
      org: ORG,
      expected: EXPECTED
    });

    expect(result.class).toBe(PAIR_WITNESS_READ_CLASSES.MATCHING);
    const [url, options] = forgeFetch.mock.calls[0];
    expect(url).toBe('https://remote.atlassian.net/rest/api/3/issue/20881/properties/sync-connector-pair');
    expect(options.method).toBe('GET');
    expect(options.headers.Authorization)
      .toBe(`Basic ${Buffer.from('sync@example.com:remote-token').toString('base64')}`);
    expect(options.body).toBeUndefined();
  });

  test('a remote transport failure is unverifiable', async () => {
    forgeFetch.mockRejectedValue(new Error('socket hang up'));

    const result = await readPairWitness({
      side: 'remote',
      issueRef: '20881',
      org: ORG,
      expected: EXPECTED
    });

    expect(result.class).toBe(PAIR_WITNESS_READ_CLASSES.UNVERIFIABLE);
    expect(result.code).toBe(PAIR_WITNESS_CODES.NETWORK);
  });

  test('an issue identity read returns the stable id and key', async () => {
    requestJira.mockResolvedValue(response(200, { id: '10001', key: 'LOCAL-1', fields: {} }));

    const identity = await readIssueIdentity({ side: 'local', issueRef: 'LOCAL-1' });

    expect(identity).toMatchObject({
      class: PAIR_WITNESS_ISSUE_CLASSES.PRESENT,
      id: '10001',
      key: 'LOCAL-1'
    });
    expect(String(requestJira.mock.calls[0][0])).toContain('/rest/api/3/issue/LOCAL-1?fields=key');
  });

  test('the remote identity read treats 403 as inaccessible, not missing', async () => {
    forgeFetch.mockResolvedValue(response(403, null));

    const identity = await readIssueIdentity({ side: 'remote', issueRef: 'REMOT-1', org: ORG });

    expect(identity.class).toBe(PAIR_WITNESS_ISSUE_CLASSES.INACCESSIBLE);
    expect(identity.class).not.toBe(PAIR_WITNESS_ISSUE_CLASSES.MISSING);
  });

  test('invalid arguments are refused before any request', async () => {
    await expect(readPairWitness({ side: 'local', issueRef: '  ' }))
      .rejects.toMatchObject({ code: PAIR_WITNESS_CODES.INVALID_INPUT });
    await expect(readPairWitness({ side: 'remote', issueRef: '20881' }))
      .rejects.toMatchObject({ code: PAIR_WITNESS_CODES.INVALID_INPUT });
    expect(requestJira).not.toHaveBeenCalled();
    expect(forgeFetch).not.toHaveBeenCalled();
  });
});

describe('read-only wiring', () => {
  const root = process.cwd();
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
  const witnessSource = read('src/services/sync/pair-witness.js');
  const previewSource = read('src/services/sync/pair-witness-preview.js');
  const resolverSource = read('src/resolvers/pair-witness.js');

  test('neither module can issue a write verb', () => {
    for (const source of [witnessSource, previewSource]) {
      expect(source).not.toMatch(/method:\s*'(POST|PUT|DELETE)'/);
      expect(source).not.toMatch(/requestJira\([\s\S]{0,200}method:\s*'(POST|PUT|DELETE)'/);
    }
  });

  test('the witness module imports no storage or write helper', () => {
    expect(witnessSource).not.toContain('storage/kvs');
    expect(witnessSource).not.toContain('storeMapping');
    expect(witnessSource).not.toContain('beginIssueCreateOperation');
    expect(witnessSource).not.toContain('issue-create-operation');
    expect(witnessSource).not.toContain('createRemoteIssue');
  });

  test('the preview module only reads and never mutates storage', () => {
    expect(previewSource).not.toMatch(/\bsetStored\b/);
    expect(previewSource).not.toMatch(/\bkvsStore\.set\(/);
    expect(previewSource).not.toMatch(/\bkvsStore\.del\(/);
    expect(previewSource).not.toContain('beginIssueCreateOperation(');
    expect(previewSource).not.toContain('createRemoteIssue');
    expect(previewSource).not.toContain('replaceIssueMapping');
    expect(previewSource).not.toContain('storeMapping');
  });

  test('the resolver defines exactly one read-only action', () => {
    const definitions = [...resolverSource.matchAll(/resolver\.define\('([^']+)'/g)].map((m) => m[1]);
    expect(definitions).toEqual(['previewPairWitnessMigration']);
    expect(resolverSource).not.toMatch(/resolver\.define\('(approve|apply|migrate|restore)/i);
  });

  test('both modules read the issue property key instead of inventing paths', () => {
    expect(witnessSource).toContain('PAIR_WITNESS_PROPERTY_KEY');
    expect(witnessSource).toContain('/properties/');
  });
});

