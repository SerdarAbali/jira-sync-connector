/**
 * Phase 1 integration recovery snapshot export.
 *
 * These tests exercise the production export path with an in-memory KVS page
 * reader: bounded cursor pagination, completeness fail-closed behaviour, empty
 * integrations, installation identity, organization isolation, checksum
 * verification, secret exclusion, the pause requirement and the ADMIN_READ
 * authorization boundary.
 */
import api, { getAppContext } from '@forge/api';
import { createHash } from 'crypto';
import {
  createAuthorizedResolver,
  forbiddenResponse
} from '../src/resolvers/authorization.js';
import { RESOLVER_POLICIES } from '../src/resolvers/authorization-policy.js';
import { defineRecoverySnapshotResolvers } from '../src/resolvers/recovery-snapshot.js';
import {
  buildRecoverySnapshot,
  RECOVERY_SNAPSHOT_FORMAT,
  SNAPSHOT_ERROR_MESSAGES,
  verifySnapshotContent
} from '../src/services/sync/recovery-snapshot.js';
import * as kvsStore from '../src/services/storage/kvs.js';

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  const getAppContext = jest.fn();
  return {
    __esModule: true,
    default: {
      asApp: () => ({ requestJira }),
      asUser: () => ({ requestJira })
    },
    getAppContext,
    route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch: jest.fn()
  };
});

jest.mock('@forge/resolver', () => {
  class FakeResolver {
    constructor() {
      this.functions = {};
    }

    define(name, fn) {
      this.functions[name] = fn;
      return this;
    }

    getDefinitions() {
      const functions = this.functions;
      return async (request) => {
        const fn = functions[request.call.functionKey];
        return fn({
          payload: request.call.payload || {},
          context: request.context || {}
        });
      };
    }
  }
  return { __esModule: true, default: FakeResolver };
});

jest.mock('@forge/events', () => ({
  Queue: jest.fn(() => ({ push: jest.fn() }))
}));

jest.mock('@forge/kvs', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
    getSecret: jest.fn(),
    setSecret: jest.fn(),
    deleteSecret: jest.fn(),
    query: jest.fn(),
    transact: jest.fn()
  },
  WhereConditions: { beginsWith: (value) => ({ op: 'beginsWith', value }) }
}));

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  getSecret: jest.fn(),
  setSecret: jest.fn(),
  deleteSecret: jest.fn(),
  createIfNotExists: jest.fn(),
  setIfNotExists: jest.fn(),
  setWithTtl: jest.fn(),
  queryPageByPrefix: jest.fn(),
  queryByPrefix: jest.fn(),
  transaction: jest.fn()
}));

const store = new Map();
let pageOverride = null;

function resetStore() {
  store.clear();
  pageOverride = null;
}

function fakePage(prefix, options = {}) {
  if (pageOverride) return pageOverride(prefix, options);
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 100);
  const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
  const start = options.cursor ? Number(options.cursor) : 0;
  const slice = keys.slice(start, start + limit);
  const nextIndex = start + slice.length;
  return {
    records: slice.map((key) => ({ key, value: store.get(key) })),
    nextCursor: nextIndex < keys.length ? String(nextIndex) : null
  };
}

const ORG = {
  id: 'org-1',
  name: 'Pilot Org',
  remoteUrl: 'https://vendor.example.com/jira',
  remoteEmail: 'operator@vendor.example.com',
  remoteProjectKey: 'VEND',
  allowedProjects: ['LOCAL', 'ALPHA'],
  syncDirection: 'bidirectional',
  remoteApiToken: 'SECRET_ORG_TOKEN',
  jqlFilter: 'assignee = operator@vendor.example.com'
};

const PAUSED = {
  paused: true,
  pausedAt: '2026-02-03T00:00:00.000Z',
  reasonCode: 'PILOT_CHANGE'
};

const IDENTITY = {
  readable: true,
  code: null,
  appId: '362d8e6b-b68c-4403-8020-d32ddcc02716',
  appAri: 'ari:cloud:ecosystem::app/362d8e6b-b68c-4403-8020-d32ddcc02716',
  appVersion: '3.10.0',
  environmentId: 'env-0000000000000001',
  environmentType: 'development',
  installationId: 'installation-0000001',
  cloudIds: ['cloud-0000001'],
  siteHost: 'site.example.com',
  siteReason: null,
  bound: true
};

function baseDeps(overrides = {}) {
  return {
    queryPage: jest.fn(fakePage),
    getStored: jest.fn(async (key) => (key === 'organizations' ? [ORG] : null)),
    getPilotPause: jest.fn(async () => ({ ...PAUSED })),
    readIdentity: jest.fn(async () => ({ ...IDENTITY })),
    now: () => Date.parse('2026-02-03T04:05:06.000Z'),
    ...overrides
  };
}

function seedPair(localKey, remoteKey, orgId = 'org-1', extra = {}) {
  store.set(`mapping-meta:${orgId}:${localKey}`, {
    localKey,
    remoteKey,
    orgId,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra
  });
}

function seedLedger({
  orgId = 'org-1',
  direction = 'local-to-remote',
  sourceKey = 'LOCAL-1',
  operationSuffix = null,
  value = {}
} = {}) {
  const base = `issue-create-op:${orgId}:${direction}:${encodeURIComponent(sourceKey)}`;
  const key = operationSuffix ? `${base}:${encodeURIComponent(operationSuffix)}` : base;
  store.set(key, {
    orgId,
    direction,
    sourceKey,
    state: 'succeeded',
    attempt: 1,
    targetKey: 'VEND-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:05:00.000Z',
    attemptToken: 'SECRET_ATTEMPT_TOKEN',
    ...value
  });
  return key;
}

function snapshotLines(result) {
  return result.content.trimEnd().split('\n').map((line) => JSON.parse(line));
}

async function expectSnapshotError(promise, code) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('recovery snapshot export', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  test('paginates with bounded cursors and exports every pair', async () => {
    for (let index = 1; index <= 250; index += 1) {
      seedPair(`LOCAL-${index}`, `VEND-${index}`);
    }
    seedLedger({ sourceKey: 'LOCAL-1' });

    const deps = baseDeps();
    const result = await buildRecoverySnapshot({ orgId: 'org-1', deps });

    expect(result.success).toBe(true);
    expect(result.counts).toEqual({ pairs: 250, ledger: 1, total: 251, skippedRetryClaims: 0 });

    for (const [, options] of deps.queryPage.mock.calls) {
      expect(options.limit).toBeLessThanOrEqual(100);
    }

    const pairCalls = deps.queryPage.mock.calls.filter(([prefix]) => prefix === 'mapping-meta:org-1:');
    // Two complete scans of 250 records at 100 per page.
    expect(pairCalls).toHaveLength(6);
    expect(pairCalls.map(([, options]) => options.cursor))
      .toEqual([null, '100', '200', null, '100', '200']);

    const lines = snapshotLines(result);
    expect(lines.filter((line) => line.section === 'pairs')).toHaveLength(250);
  });

  test('does not inherit the 1000-record listing limit', async () => {
    for (let index = 1; index <= 1200; index += 1) {
      seedPair(`LOCAL-${index}`, `VEND-${index}`);
    }

    const result = await buildRecoverySnapshot({ orgId: 'org-1', deps: baseDeps() });

    expect(result.counts.pairs).toBe(1200);
    expect(result.counts.total).toBe(1200);
    expect(kvsStore.queryByPrefix).not.toHaveBeenCalled();
  });

  test('exports an empty integration as a valid zero-record snapshot', async () => {
    const result = await buildRecoverySnapshot({ orgId: 'org-1', deps: baseDeps() });

    expect(result.counts).toEqual({ pairs: 0, ledger: 0, total: 0, skippedRetryClaims: 0 });
    const lines = snapshotLines(result);
    expect(lines.map((line) => line.kind)).toEqual(['header', 'counts', 'footer']);
    expect(verifySnapshotContent(result.content).valid).toBe(true);
  });

  test('fails closed when a page cannot be read', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    seedPair('LOCAL-2', 'VEND-2');

    let calls = 0;
    const deps = baseDeps({
      queryPage: jest.fn((prefix, options) => {
        calls += 1;
        if (calls === 2) {
          const error = new Error('storage unavailable');
          error.code = 'STORAGE_UNAVAILABLE';
          throw error;
        }
        return fakePage(prefix, options);
      })
    });

    await expectSnapshotError(
      buildRecoverySnapshot({ orgId: 'org-1', deps }),
      'SNAPSHOT_PAGE_UNREADABLE'
    );
  });

  test('fails closed when pagination returns an empty page with a cursor', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const seeded = { key: 'mapping-meta:org-1:LOCAL-1', value: store.get('mapping-meta:org-1:LOCAL-1') };

    let calls = 0;
    const deps = baseDeps({
      queryPage: jest.fn(() => {
        calls += 1;
        if (calls === 1) {
          return { records: [seeded], nextCursor: 'c1' };
        }
        return { records: [], nextCursor: 'c2' };
      })
    });

    await expectSnapshotError(
      buildRecoverySnapshot({ orgId: 'org-1', deps }),
      'SNAPSHOT_PAGINATION_INCOMPLETE'
    );
  });

  test('fails closed when the same page is returned twice', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const seeded = { key: 'mapping-meta:org-1:LOCAL-1', value: store.get('mapping-meta:org-1:LOCAL-1') };

    const deps = baseDeps({
      queryPage: jest.fn(() => ({ records: [seeded], nextCursor: 'c1' }))
    });

    await expectSnapshotError(
      buildRecoverySnapshot({ orgId: 'org-1', deps }),
      'SNAPSHOT_PAGINATION_INCOMPLETE'
    );
  });

  test('fails closed on an unrecognized ledger key shape', async () => {
    store.set('issue-create-op:org-1:local-to-remote:LOCAL-1:unexpected:extra', { state: 'pending' });

    await expectSnapshotError(
      buildRecoverySnapshot({ orgId: 'org-1', deps: baseDeps() }),
      'SNAPSHOT_LEDGER_KEY_UNRECOGNIZED'
    );
  });

  test('fails closed when records change between the two scans', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    seedPair('LOCAL-2', 'VEND-2');

    let calls = 0;
    const deps = baseDeps({
      queryPage: jest.fn((prefix, options) => {
        calls += 1;
        if (calls === 2) {
          seedPair('LOCAL-3', 'VEND-3');
        }
        return fakePage(prefix, options);
      })
    });

    await expectSnapshotError(
      buildRecoverySnapshot({ orgId: 'org-1', deps }),
      'SNAPSHOT_UNSTABLE'
    );
  });

  test('refuses to export while writes are active and writes nothing', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const deps = baseDeps({ getPilotPause: jest.fn(async () => ({ paused: false })) });

    await expectSnapshotError(
      buildRecoverySnapshot({ orgId: 'org-1', deps }),
      'SNAPSHOT_REQUIRES_PAUSE'
    );

    expect(deps.queryPage).not.toHaveBeenCalled();
    expect(deps.getStored).not.toHaveBeenCalled();
    expect(kvsStore.set).not.toHaveBeenCalled();
    expect(kvsStore.setSecret).not.toHaveBeenCalled();
  });

  test('refuses to export when the pause state cannot be read', async () => {
    const deps = baseDeps({
      getPilotPause: jest.fn(async () => {
        const error = new Error('storage error');
        error.code = 'STORAGE_ERROR';
        throw error;
      })
    });

    await expectSnapshotError(
      buildRecoverySnapshot({ orgId: 'org-1', deps }),
      'SNAPSHOT_PAUSE_UNREADABLE'
    );
  });

  test('fails closed when the pause is released during the export', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const deps = baseDeps({
      getPilotPause: jest.fn()
        .mockResolvedValueOnce({ ...PAUSED })
        .mockResolvedValueOnce({ paused: false })
    });

    await expectSnapshotError(
      buildRecoverySnapshot({ orgId: 'org-1', deps }),
      'SNAPSHOT_PAUSE_CHANGED'
    );
  });

  test('fails closed when installation identity is incomplete', async () => {
    const deps = baseDeps({
      readIdentity: jest.fn(async () => ({ readable: false, code: 'IDENTITY_INCOMPLETE' }))
    });

    await expectSnapshotError(
      buildRecoverySnapshot({ orgId: 'org-1', deps }),
      'SNAPSHOT_IDENTITY_UNAVAILABLE'
    );
  });
});

describe('recovery snapshot contents', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  test('records installation and organization routing identity', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    seedLedger();

    const result = await buildRecoverySnapshot({ orgId: 'org-1', deps: baseDeps() });
    const [header] = snapshotLines(result);

    expect(header.format).toBe(RECOVERY_SNAPSHOT_FORMAT);
    expect(header.formatVersion).toBe(1);
    expect(header.exportedAt).toBe('2026-02-03T04:05:06.000Z');
    expect(header.identity).toEqual({
      appId: IDENTITY.appId,
      appAri: IDENTITY.appAri,
      appVersion: '3.10.0',
      environmentId: IDENTITY.environmentId,
      environmentType: 'development',
      installationId: IDENTITY.installationId,
      cloudIds: ['cloud-0000001'],
      siteHost: 'site.example.com'
    });
    expect(header.organization).toEqual({
      id: 'org-1',
      name: 'Pilot Org',
      remoteHost: 'vendor.example.com',
      remoteProjectKey: 'VEND',
      allowedProjects: ['ALPHA', 'LOCAL'],
      syncDirection: 'bidirectional'
    });
    expect(header.pause).toEqual({
      paused: true,
      pausedAt: PAUSED.pausedAt,
      reasonCode: PAUSED.reasonCode
    });
    expect(result.fileName).toBe('pilot-org-org-1-recovery-snapshot-2026-02-03.ndjson');
    expect(result.contentType).toContain('ndjson');
  });

  test('excludes credentials, attempt tokens and personal data', async () => {
    seedPair('LOCAL-1', 'VEND-1', 'org-1', { token: 'SECRET_PAIR_TOKEN' });
    seedLedger({ value: { failureReason: null } });

    const result = await buildRecoverySnapshot({ orgId: 'org-1', deps: baseDeps() });

    expect(result.content).not.toContain('SECRET_ORG_TOKEN');
    expect(result.content).not.toContain('SECRET_ATTEMPT_TOKEN');
    expect(result.content).not.toContain('SECRET_PAIR_TOKEN');
    expect(result.content).not.toContain('operator@vendor.example.com');
    expect(result.content).not.toContain('assignee =');
    expect(kvsStore.getSecret).not.toHaveBeenCalled();
    expect(kvsStore.setSecret).not.toHaveBeenCalled();
  });

  test('is isolated to the selected organization', async () => {
    seedPair('LOCAL-1', 'VEND-1', 'org-1');
    seedPair('LOCAL-2', 'VEND-2', 'org-2');
    seedPair('LOCAL-3', 'VEND-3', 'org-2');
    seedPair('LOCAL-4', 'VEND-4', 'org-10');
    seedLedger({ orgId: 'org-2' });

    const result = await buildRecoverySnapshot({ orgId: 'org-1', deps: baseDeps() });

    expect(result.counts).toEqual({ pairs: 1, ledger: 0, total: 1, skippedRetryClaims: 0 });
    expect(result.content).toContain('LOCAL-1');
    expect(result.content).not.toContain('LOCAL-2');
    expect(result.content).not.toContain('LOCAL-4');
  });

  test('rejects unknown, missing and malformed organization identifiers', async () => {
    await expectSnapshotError(
      buildRecoverySnapshot({ orgId: 'org-9', deps: baseDeps() }),
      'SNAPSHOT_ORGANIZATION_NOT_FOUND'
    );
    await expectSnapshotError(
      buildRecoverySnapshot({ deps: baseDeps() }),
      'SNAPSHOT_ORGANIZATION_REQUIRED'
    );
    await expectSnapshotError(
      buildRecoverySnapshot({ orgId: 'org-1:local-to-remote:ABC-1', deps: baseDeps() }),
      'SNAPSHOT_ORGANIZATION_INVALID'
    );
  });

  test('skips retry-claim markers and reports them', async () => {
    seedLedger({ sourceKey: 'LOCAL-1' });
    store.set('issue-create-op:org-1:local-to-remote:LOCAL-1:retry:abc123:2', {
      operationId: 'abc123',
      attempt: 2,
      claimedAt: '2026-01-01T00:06:00.000Z'
    });

    const result = await buildRecoverySnapshot({ orgId: 'org-1', deps: baseDeps() });

    expect(result.counts).toEqual({ pairs: 0, ledger: 1, total: 1, skippedRetryClaims: 1 });
    expect(result.content).not.toContain('abc123');
  });

  test('verifies the checksum over records and counts', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    seedLedger();

    const result = await buildRecoverySnapshot({ orgId: 'org-1', deps: baseDeps() });
    expect(verifySnapshotContent(result.content)).toEqual(
      expect.objectContaining({ valid: true, declared: result.checksum })
    );

    // Manual verification contract: every line except the final footer line,
    // newline-terminated, is what `sed '$d' <file> | shasum -a 256` hashes.
    const allLines = result.content.split('\n');
    allLines.pop();
    const footerLine = allLines.pop();
    const manual = createHash('sha256')
      .update(`${allLines.join('\n')}\n`, 'utf8')
      .digest('hex');
    expect(result.checksum).toBe(`sha256:${manual}`);
    expect(JSON.parse(footerLine).checksum).toBe(result.checksum);

    const tamperedRecord = result.content.replace('"localKey":"LOCAL-1"', '"localKey":"LOCAL-2"');
    expect(tamperedRecord).not.toBe(result.content);
    expect(verifySnapshotContent(tamperedRecord).valid).toBe(false);

    const tamperedCounts = result.content.replace('"pairs":1', '"pairs":2');
    expect(tamperedCounts).not.toBe(result.content);
    expect(verifySnapshotContent(tamperedCounts).valid).toBe(false);

    // Malformed or truncated input never reports validity.
    expect(verifySnapshotContent('{"kind":"header"}\n{"kind":"counts"}\n{"kind":"footer"').valid)
      .toBe(false);
    expect(verifySnapshotContent('').valid).toBe(false);
  });

  test('is deterministic for identical inputs', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    seedLedger();

    const first = await buildRecoverySnapshot({ orgId: 'org-1', deps: baseDeps() });
    const second = await buildRecoverySnapshot({ orgId: 'org-1', deps: baseDeps() });

    expect(second.content).toBe(first.content);
    expect(second.checksum).toBe(first.checksum);
  });
});

describe('recovery snapshot resolver authorization', () => {
  const requestJira = api.asApp().requestJira;
  const FORGE_CONTEXT = {
    appAri: 'ari:cloud:ecosystem::app/362d8e6b-b68c-4403-8020-d32ddcc02716',
    appVersion: '3.10.0',
    environmentAri: { environmentId: 'env-0000000000000001' },
    environmentType: 'development',
    installationAri: { installationId: 'installation-0000001' },
    installation: { contexts: [{ cloudId: 'cloud-0000001' }] }
  };

  let callable;

  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();

    getAppContext.mockReturnValue(FORGE_CONTEXT);
    requestJira.mockImplementation(async (url) => {
      if (String(url).includes('/serverInfo')) {
        return { ok: true, json: async () => ({ baseUrl: 'https://site.example.com' }) };
      }
      return { ok: true, json: async () => ({ permissions: { ADMINISTER: { havePermission: true } } }) };
    });

    kvsStore.get.mockImplementation(async (key) => {
      if (key === 'organizations') return [ORG];
      if (key === 'pilotPause') return { ...PAUSED };
      return store.has(key) ? store.get(key) : null;
    });
    kvsStore.queryPageByPrefix.mockImplementation(async (prefix, options) => fakePage(prefix, options));

    const resolver = createAuthorizedResolver({ policies: RESOLVER_POLICIES });
    defineRecoverySnapshotResolvers(resolver);
    callable = resolver.getDefinitions();
  });

  function invoke(payload, accountId = 'admin-1') {
    return callable({
      call: { functionKey: 'exportRecoverySnapshot', payload },
      context: accountId === null ? {} : { accountId }
    });
  }

  test('is classified ADMIN_READ and reads nothing else', () => {
    expect(RESOLVER_POLICIES.exportRecoverySnapshot).toBe('ADMIN_READ');
  });

  test('denies a caller without the Jira administrator permission', async () => {
    requestJira.mockResolvedValue({
      ok: true,
      json: async () => ({ permissions: { ADMINISTER: { havePermission: false } } })
    });

    await expect(invoke({ orgId: 'org-1' })).resolves.toEqual(forbiddenResponse());
    expect(kvsStore.queryPageByPrefix).not.toHaveBeenCalled();
  });

  test('denies a caller without an account id', async () => {
    await expect(invoke({ orgId: 'org-1' }, null)).resolves.toEqual(forbiddenResponse());
    expect(kvsStore.queryPageByPrefix).not.toHaveBeenCalled();
  });

  test('returns the snapshot for an authorized administrator', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    seedLedger();

    const result = await invoke({ orgId: 'org-1' });

    expect(result.success).toBe(true);
    expect(result.counts).toEqual({ pairs: 1, ledger: 1, total: 2, skippedRetryClaims: 0 });
    expect(result.identity).toEqual(expect.objectContaining({
      appId: '362d8e6b-b68c-4403-8020-d32ddcc02716',
      installationId: 'installation-0000001',
      environmentId: 'env-0000000000000001',
      siteHost: 'site.example.com'
    }));
    expect(verifySnapshotContent(result.content).valid).toBe(true);
    expect(result.fileName).toMatch(/^pilot-org-org-1-recovery-snapshot-\d{4}-\d{2}-\d{2}\.ndjson$/);
  });

  test('returns a fixed message and no content when the pause is not in force', async () => {
    kvsStore.get.mockImplementation(async (key) => {
      if (key === 'organizations') return [ORG];
      if (key === 'pilotPause') return { paused: false };
      return null;
    });

    const result = await invoke({ orgId: 'org-1' });

    expect(result).toEqual({
      success: false,
      code: 'SNAPSHOT_REQUIRES_PAUSE',
      error: SNAPSHOT_ERROR_MESSAGES.SNAPSHOT_REQUIRES_PAUSE
    });
    expect(result.content).toBeUndefined();
    expect(kvsStore.set).not.toHaveBeenCalled();
  });

  test('does not leak internal failure detail', async () => {
    kvsStore.queryPageByPrefix.mockRejectedValue(new Error('internal kvs failure at node-7'));

    const result = await invoke({ orgId: 'org-1' });

    expect(result).toEqual({
      success: false,
      code: 'SNAPSHOT_PAGE_UNREADABLE',
      error: SNAPSHOT_ERROR_MESSAGES.SNAPSHOT_PAGE_UNREADABLE
    });
    expect(JSON.stringify(result)).not.toContain('internal kvs failure');
  });
});
