/**
 * Read-only restore preview for an exported recovery snapshot.
 *
 * These tests drive the production export to produce the file, then compare it
 * with live in-memory storage through the production preview path: verified
 * classification, identity and routing refusal, fail-closed file parsing, the
 * pause gate, and the guarantee that the preview performs no write at all.
 */
import api, { getAppContext } from '@forge/api';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  createAuthorizedResolver,
  forbiddenResponse
} from '../src/resolvers/authorization.js';
import { RESOLVER_POLICIES } from '../src/resolvers/authorization-policy.js';
import { defineRecoverySnapshotResolvers } from '../src/resolvers/recovery-snapshot.js';
import {
  buildRecoverySnapshot,
  digestLines,
  MAX_SNAPSHOT_BYTES,
  RECOVERY_SNAPSHOT_FORMAT,
  stableStringify
} from '../src/services/sync/recovery-snapshot.js';
import {
  PREVIEW_IDENTITY_CLASSES,
  PREVIEW_PAIR_CLASSES,
  parseRecoverySnapshotContent,
  previewRestoreSnapshot
} from '../src/services/sync/recovery-snapshot-preview.js';
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

const ORG_TWO = {
  ...ORG,
  id: 'org-2',
  name: 'Second Org',
  remoteProjectKey: 'SECOND'
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
    getStored: jest.fn(async (key) => (key === 'organizations' ? [ORG, ORG_TWO] : null)),
    getPilotPause: jest.fn(async () => ({ ...PAUSED })),
    readIdentity: jest.fn(async () => ({ ...IDENTITY })),
    now: () => Date.parse('2026-02-03T04:05:06.000Z'),
    ...overrides
  };
}

function seedPair(localKey, remoteKey, orgId = 'org-1', extra = {}) {
  // Production writes the metadata index and both directed lookups together.
  store.set(`mapping-meta:${orgId}:${localKey}`, {
    localKey,
    remoteKey,
    orgId,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra
  });
  store.set(`${orgId}:local-to-remote:${localKey}`, remoteKey);
  store.set(`${orgId}:remote-to-local:${remoteKey}`, localKey);
}

function removePair(localKey, remoteKey, orgId = 'org-1') {
  store.delete(`mapping-meta:${orgId}:${localKey}`);
  store.delete(`${orgId}:local-to-remote:${localKey}`);
  store.delete(`${orgId}:remote-to-local:${remoteKey}`);
}

function seedEnded(localKey, remoteKey, orgId = 'org-1', extra = {}) {
  store.set(`mapping-ended:${orgId}:${localKey}:${remoteKey}`, {
    localKey,
    remoteKey,
    orgId,
    endedAt: '2026-01-05T00:00:00.000Z',
    endedBy: 'admin-account-id',
    reasonCode: 'administrator_ended',
    ...extra
  });
}

function seedRepair(localKey, remoteKey, orgId = 'org-1', extra = {}) {
  store.set(`mapping-repair:${orgId}:${localKey}:${remoteKey}`, {
    localKey,
    remoteKey,
    orgId,
    reason: 'partial-mapping-write',
    detectedAt: '2026-01-05T00:00:00.000Z',
    ...extra
  });
}

function seedCounterpartStatus(localKey, remoteKey, orgId = 'org-1', extra = {}) {
  store.set(`counterpart-status:${orgId}:${localKey}:${remoteKey}`, {
    version: 1,
    orgId,
    localKey,
    remoteKey,
    status: 'confirmed_deleted',
    deletedSide: 'remote',
    source: 'jira-probe',
    reasonCode: 'deleted',
    probeStatusCode: 404,
    firstDetectedAt: '2026-01-05T00:00:00.000Z',
    lastDetectedAt: '2026-01-05T00:00:00.000Z',
    updatedAt: '2026-01-05T00:00:00.000Z',
    state: 'active',
    endedAt: null,
    endedBy: 'admin-account-id',
    resolvedAt: null,
    replacementLocalKey: null,
    replacementRemoteKey: null,
    ...extra
  });
}

function ledgerKey({
  orgId = 'org-1',
  direction = 'local-to-remote',
  sourceKey = 'LOCAL-1',
  operationSuffix = null
} = {}) {
  const base = `issue-create-op:${orgId}:${direction}:${encodeURIComponent(sourceKey)}`;
  return operationSuffix ? `${base}:${encodeURIComponent(operationSuffix)}` : base;
}

function seedLedger({
  orgId = 'org-1',
  direction = 'local-to-remote',
  sourceKey = 'LOCAL-1',
  operationSuffix = null,
  value = {}
} = {}) {
  const key = ledgerKey({ orgId, direction, sourceKey, operationSuffix });
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

async function exportSnapshot({ orgId = 'org-1', overrides = {} } = {}) {
  return buildRecoverySnapshot({ orgId, deps: baseDeps(overrides) });
}

async function preview({ content, orgId = 'org-1', overrides = {} }) {
  return previewRestoreSnapshot({ orgId, content, deps: baseDeps(overrides) });
}

/**
 * Builds an internally consistent snapshot with controlled content so that
 * malformed-but-checksum-valid files can be exercised.
 */
function assembleSnapshot({ header, records = [], counts, sectionChecksums }) {
  const pairLines = records.filter((record) => record.section === 'pairs').map(stableStringify);
  const ledgerLines = records.filter((record) => record.section === 'ledger').map(stableStringify);
  const resolvedCounts = counts || {
    kind: 'counts',
    pairs: pairLines.length,
    ledger: ledgerLines.length,
    total: pairLines.length + ledgerLines.length,
    skipped: { ledgerRetryClaims: 0 }
  };
  const sections = sectionChecksums || {
    pairs: digestLines(pairLines),
    ledger: digestLines(ledgerLines)
  };
  const headerLine = stableStringify({
    kind: 'header',
    format: RECOVERY_SNAPSHOT_FORMAT,
    formatVersion: 1,
    exportedAt: '2026-02-03T04:05:06.000Z',
    scope: 'one-organization',
    notice: 'test',
    identity: { ...IDENTITY, readable: undefined },
    organization: {
      id: 'org-1',
      name: 'Pilot Org',
      remoteHost: 'vendor.example.com',
      remoteProjectKey: 'VEND',
      allowedProjects: ['ALPHA', 'LOCAL'],
      syncDirection: 'bidirectional'
    },
    pause: PAUSED,
    sections: [
      { name: 'pairs', recordType: 'issue-pair-mapping', count: pairLines.length, pagesScanned: 1, checksum: sections.pairs },
      { name: 'ledger', recordType: 'issue-create-ledger', count: ledgerLines.length, pagesScanned: 1, checksum: sections.ledger }
    ],
    omissions: [],
    limitations: [],
    ...header
  });
  const countsLine = stableStringify(resolvedCounts);
  const checksum = `sha256:${createHash('sha256')
    .update(`${[headerLine, ...pairLines, ...ledgerLines, countsLine].join('\n')}\n`, 'utf8')
    .digest('hex')}`;
  const footerLine = stableStringify({
    kind: 'footer',
    format: RECOVERY_SNAPSHOT_FORMAT,
    formatVersion: 1,
    checksumAlgorithm: 'sha256',
    checksumScope: 'header,records,counts',
    checksum,
    counts: resolvedCounts,
    sectionChecksums: sections,
    notice: 'test',
    limitations: []
  });
  return `${[headerLine, ...pairLines, ...ledgerLines, countsLine, footerLine].join('\n')}\n`;
}

function expectPreviewCode(promise, code) {
  return expect(promise).rejects.toMatchObject({ code });
}

describe('recovery snapshot preview classification', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  test('classifies a complete same-installation backup as consistent and writes nothing', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    seedPair('LOCAL-2', 'VEND-2');
    seedLedger({ sourceKey: 'LOCAL-1' });
    const snapshot = await exportSnapshot();
    jest.clearAllMocks();

    const result = await preview({ content: snapshot.content });

    expect(result.success).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.noWritesPerformed).toBe(true);
    expect(result.format).toBe(RECOVERY_SNAPSHOT_FORMAT);
    expect(result.checksum).toEqual(expect.objectContaining({
      verified: true,
      declared: snapshot.checksum,
      algorithm: 'sha256'
    }));
    expect(result.identity.classification).toBe(PREVIEW_IDENTITY_CLASSES.SAME_INSTALLATION);
    expect(result.identity.crossInstallation).toBe(false);
    expect(result.organization).toEqual(expect.objectContaining({ match: true, differences: [] }));
    expect(result.pause).toEqual({
      paused: true,
      pausedAt: PAUSED.pausedAt,
      reasonCode: PAUSED.reasonCode
    });
    expect(result.counts.snapshot).toEqual({
      pairs: 2, ledger: 1, directions: 4, counterpartStatus: 0,
      mappingEnded: 0, mappingRepair: 0, total: 7, skippedRetryClaims: 0
    });
    expect(result.counts.live).toEqual({
      pairs: 2, ledger: 1, directions: 4, skippedRetryClaims: 0
    });
    expect(result.counts.pairs).toEqual({
      [PREVIEW_PAIR_CLASSES.PRESENT]: 2,
      [PREVIEW_PAIR_CLASSES.MISSING]: 0,
      [PREVIEW_PAIR_CLASSES.CONFLICTING]: 0,
      [PREVIEW_PAIR_CLASSES.BLOCKED]: 0,
      [PREVIEW_PAIR_CLASSES.INCOMPLETE_DIRECTIONAL]: 0
    });
    expect(result.counts.ledger).toEqual({
      'already-present-consistent': 1,
      missing: 0,
      conflicting: 0
    });
    expect(result.counts.restorablePairs).toBe(0);
    expect(result.samples.pairs).toEqual({
      missing: [], conflicting: [], blocked: [], incomplete: []
    });
    expect(result.samples.ledger).toEqual({ missing: [], conflicting: [] });

    expect(kvsStore.set).not.toHaveBeenCalled();
    expect(kvsStore.del).not.toHaveBeenCalled();
    expect(kvsStore.createIfNotExists).not.toHaveBeenCalled();
    expect(kvsStore.transaction).not.toHaveBeenCalled();
    expect(api.asApp().requestJira).not.toHaveBeenCalled();
  });

  test('classifies an absent pair as missing and potentially restorable', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    seedPair('LOCAL-2', 'VEND-2');
    const snapshot = await exportSnapshot();

    removePair('LOCAL-2', 'VEND-2');
    const result = await preview({ content: snapshot.content });

    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.PRESENT]).toBe(1);
    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.MISSING]).toBe(1);
    expect(result.counts.restorablePairs).toBe(1);
    expect(result.samples.pairs.missing).toEqual([
      expect.objectContaining({ localKey: 'LOCAL-2', remoteKey: 'VEND-2' })
    ]);
  });

  test('classifies a pair whose stored remote key differs as conflicting', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();

    seedPair('LOCAL-1', 'VEND-9');
    const result = await preview({ content: snapshot.content });

    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.CONFLICTING]).toBe(1);
    expect(result.samples.pairs.conflicting).toEqual([
      expect.objectContaining({
        localKey: 'LOCAL-1',
        remoteKey: 'VEND-1',
        liveRemoteKey: 'VEND-9',
        reason: 'remote-key-differs'
      })
    ]);
  });

  test('classifies a pair whose remote key is already mapped elsewhere as conflicting', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();

    removePair('LOCAL-1', 'VEND-1');
    seedPair('LOCAL-9', 'VEND-1');
    const result = await preview({ content: snapshot.content });

    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.CONFLICTING]).toBe(1);
    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.MISSING]).toBe(0);
    expect(result.samples.pairs.conflicting).toEqual([
      expect.objectContaining({
        localKey: 'LOCAL-1',
        remoteKey: 'VEND-1',
        liveLocalKey: 'LOCAL-9',
        reason: 'remote-key-already-mapped'
      })
    ]);
  });

  test('blocks a missing pair that an administrator ended', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();

    removePair('LOCAL-1', 'VEND-1');
    store.set('mapping-ended:org-1:LOCAL-1:VEND-1', {
      localKey: 'LOCAL-1',
      remoteKey: 'VEND-1',
      orgId: 'org-1',
      endedAt: '2026-01-05T00:00:00.000Z',
      endedBy: 'admin-1',
      reasonCode: 'administrator_ended'
    });

    const result = await preview({ content: snapshot.content });

    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.BLOCKED]).toBe(1);
    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.MISSING]).toBe(0);
    expect(result.counts.restorablePairs).toBe(0);
    expect(result.counts.blockingRecords.mappingEnded).toBe(1);
    expect(result.samples.pairs.blocked).toEqual([
      expect.objectContaining({ localKey: 'LOCAL-1', remoteKey: 'VEND-1', reason: 'mapping-ended' })
    ]);
    // The ended record is evidence only: it is not deleted or rewritten.
    expect(store.has('mapping-ended:org-1:LOCAL-1:VEND-1')).toBe(true);
  });

  test('blocks a missing pair that a deleted-counterpart record covers', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();

    removePair('LOCAL-1', 'VEND-1');
    store.set('counterpart-status:org-1:LOCAL-1:VEND-1', {
      orgId: 'org-1',
      localKey: 'LOCAL-1',
      remoteKey: 'VEND-1',
      status: 'confirmed_deleted',
      state: 'active',
      updatedAt: '2026-01-05T00:00:00.000Z'
    });

    const result = await preview({ content: snapshot.content });

    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.BLOCKED]).toBe(1);
    expect(result.samples.pairs.blocked).toEqual([
      expect.objectContaining({ reason: 'counterpart-deleted' })
    ]);
  });

  test('blocks a missing pair that has a partial-write repair record', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();

    removePair('LOCAL-1', 'VEND-1');
    store.set('mapping-repair:org-1:LOCAL-1:VEND-1', {
      localKey: 'LOCAL-1',
      remoteKey: 'VEND-1',
      orgId: 'org-1'
    });

    const result = await preview({ content: snapshot.content });

    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.BLOCKED]).toBe(1);
    expect(result.samples.pairs.blocked).toEqual([
      expect.objectContaining({ reason: 'mapping-repair' })
    ]);
  });

  test('reports a missing ledger row as evidence and never recreates it', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    seedLedger({ sourceKey: 'LOCAL-1' });
    const snapshot = await exportSnapshot();

    store.delete(ledgerKey({ sourceKey: 'LOCAL-1' }));
    const result = await preview({ content: snapshot.content });

    expect(result.counts.ledger).toEqual({
      'already-present-consistent': 0,
      missing: 1,
      conflicting: 0
    });
    expect(result.samples.ledger.missing).toEqual([
      expect.objectContaining({
        direction: 'local-to-remote',
        sourceKey: 'LOCAL-1',
        state: 'succeeded'
      })
    ]);
    expect(kvsStore.set).not.toHaveBeenCalled();
  });

  test('reports a conflicting ledger row without resolving it', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const liveKey = seedLedger({ sourceKey: 'LOCAL-1' });
    const snapshot = await exportSnapshot();

    seedLedger({
      sourceKey: 'LOCAL-1',
      value: { state: 'unknown', updatedAt: '2026-01-02T00:00:00.000Z' }
    });

    const result = await preview({ content: snapshot.content });

    expect(result.counts.ledger.conflicting).toBe(1);
    expect(result.samples.ledger.conflicting).toEqual([
      expect.objectContaining({
        sourceKey: 'LOCAL-1',
        state: 'succeeded',
        liveState: 'unknown',
        reason: 'ledger-state-differs'
      })
    ]);
    // The live row is untouched, including its attempt token.
    expect(store.get(liveKey)).toEqual(expect.objectContaining({
      state: 'unknown',
      attemptToken: 'SECRET_ATTEMPT_TOKEN'
    }));
    expect(kvsStore.set).not.toHaveBeenCalled();
  });

  test('flags a succeeded ledger row whose target contradicts the exported pair', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const content = assembleSnapshot({
      records: [
        {
          kind: 'record',
          section: 'pairs',
          localKey: 'LOCAL-1',
          remoteKey: 'VEND-1',
          createdAt: null,
          updatedAt: null
        },
        {
          kind: 'record',
          section: 'ledger',
          direction: 'local-to-remote',
          sourceKey: 'LOCAL-1',
          operationSuffix: null,
          state: 'succeeded',
          attempt: 1,
          targetKey: 'VEND-2',
          operationId: null,
          createdAt: null,
          updatedAt: null,
          startedAt: null,
          completedAt: null,
          unknownAt: null,
          failedAt: null,
          failureReason: null
        }
      ]
    });

    const result = await preview({ content });

    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.PRESENT]).toBe(1);
    expect(result.counts.ledger.conflicting).toBe(1);
    expect(result.samples.ledger.conflicting).toEqual([
      expect.objectContaining({
        sourceKey: 'LOCAL-1',
        reason: 'ledger-target-differs-from-pair',
        pairRemoteKey: 'VEND-1'
      })
    ]);
  });
});


describe('recovery snapshot preview identity, routing and pause gates', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  test('reports a different installation of the same app without counting anything as restorable', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();
    removePair('LOCAL-1', 'VEND-1');

    const result = await preview({
      content: snapshot.content,
      overrides: {
        readIdentity: jest.fn(async () => ({ ...IDENTITY, installationId: 'installation-999' }))
      }
    });

    expect(result.success).toBe(true);
    expect(result.identity.classification).toBe(PREVIEW_IDENTITY_CLASSES.DIFFERENT_INSTALLATION);
    expect(result.identity.crossInstallation).toBe(true);
    expect(result.identity.differences).toContain('installationId');
    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.MISSING]).toBe(1);
    expect(result.counts.restorablePairs).toBe(0);
    expect(result.limitations.join(' ')).toContain('different installation');
  });

  test('rejects a file from a different app', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();

    await expectPreviewCode(
      preview({
        content: snapshot.content,
        overrides: {
          readIdentity: jest.fn(async () => ({
            ...IDENTITY,
            appId: 'other-app',
            appAri: 'ari:cloud:ecosystem::app/other-app'
          }))
        }
      }),
      'SNAPSHOT_PREVIEW_DIFFERENT_APP'
    );
  });

  test('rejects a file from a different Jira site', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();

    await expectPreviewCode(
      preview({
        content: snapshot.content,
        overrides: {
          readIdentity: jest.fn(async () => ({
            ...IDENTITY,
            siteHost: 'other-site.example.com',
            cloudIds: ['cloud-0000002']
          }))
        }
      }),
      'SNAPSHOT_PREVIEW_DIFFERENT_SITE'
    );
  });

  test('rejects a file whose remote project routing no longer matches', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();

    const deps = baseDeps({
      getStored: jest.fn(async (key) => (
        key === 'organizations' ? [{ ...ORG, remoteProjectKey: 'OTHER' }] : null
      ))
    });

    await expectPreviewCode(
      previewRestoreSnapshot({ orgId: 'org-1', content: snapshot.content, deps }),
      'SNAPSHOT_PREVIEW_ROUTING_MISMATCH'
    );
  });

  test('reports a non-blocking routing difference and still compares records', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();

    const deps = baseDeps({
      getStored: jest.fn(async (key) => (
        key === 'organizations' ? [{ ...ORG, allowedProjects: ['LOCAL'] }] : null
      ))
    });

    const result = await previewRestoreSnapshot({ orgId: 'org-1', content: snapshot.content, deps });

    expect(result.organization.match).toBe(false);
    expect(result.organization.differences).toEqual(['allowedProjects']);
    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.PRESENT]).toBe(1);
  });

  test('rejects a file exported for a different organization', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();

    await expectPreviewCode(
      preview({ content: snapshot.content, orgId: 'org-2' }),
      'SNAPSHOT_PREVIEW_ORGANIZATION_MISMATCH'
    );
  });

  test('rejects an organization that is not configured', async () => {
    const content = assembleSnapshot({
      header: {
        organization: {
          id: 'org-9',
          name: 'Missing Org',
          remoteHost: 'vendor.example.com',
          remoteProjectKey: 'VEND',
          allowedProjects: ['ALPHA', 'LOCAL'],
          syncDirection: 'bidirectional'
        }
      }
    });

    await expectPreviewCode(
      preview({ content, orgId: 'org-9' }),
      'SNAPSHOT_ORGANIZATION_NOT_FOUND'
    );
  });

  test('requires the emergency pause', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();

    await expectPreviewCode(
      preview({
        content: snapshot.content,
        overrides: { getPilotPause: jest.fn(async () => ({ paused: false })) }
      }),
      'SNAPSHOT_REQUIRES_PAUSE'
    );
  });

  test('fails closed when the pause state cannot be read', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();

    await expectPreviewCode(
      preview({
        content: snapshot.content,
        overrides: {
          getPilotPause: jest.fn(async () => {
            const error = new Error('kvs unavailable');
            error.code = 'STORAGE_UNAVAILABLE';
            throw error;
          })
        }
      }),
      'SNAPSHOT_PAUSE_UNREADABLE'
    );
  });

  test('fails closed when the installation identity cannot be read', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();

    await expectPreviewCode(
      preview({
        content: snapshot.content,
        overrides: { readIdentity: jest.fn(async () => ({ readable: false, code: 'NO_CONTEXT' })) }
      }),
      'SNAPSHOT_IDENTITY_UNAVAILABLE'
    );
  });
});


describe('recovery snapshot preview file validation', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  test('rejects a file whose checksum no longer matches its contents', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();
    const tampered = snapshot.content.replace('"remoteKey":"VEND-1"', '"remoteKey":"VEND-2"');

    expect(tampered).not.toBe(snapshot.content);
    await expectPreviewCode(
      preview({ content: tampered }),
      'SNAPSHOT_PREVIEW_CHECKSUM_MISMATCH'
    );
  });

  test('rejects truncated files before reading storage', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();
    const withoutFinalNewline = snapshot.content.slice(0, -1);
    const lines = snapshot.content.trimEnd().split('\n');
    const withoutFooter = `${lines.slice(0, -1).join('\n')}\n`;

    await expectPreviewCode(
      preview({ content: withoutFinalNewline }),
      'SNAPSHOT_PREVIEW_TRUNCATED'
    );
    await expectPreviewCode(
      preview({ content: withoutFooter }),
      'SNAPSHOT_PREVIEW_TRUNCATED'
    );

    const deps = baseDeps({ queryPage: jest.fn(fakePage) });
    await expectPreviewCode(
      previewRestoreSnapshot({ orgId: 'org-1', content: withoutFinalNewline, deps }),
      'SNAPSHOT_PREVIEW_TRUNCATED'
    );
    expect(deps.queryPage).not.toHaveBeenCalled();
  });

  test('rejects empty and oversized files', async () => {
    await expectPreviewCode(preview({ content: '' }), 'SNAPSHOT_PREVIEW_EMPTY');
    await expectPreviewCode(
      preview({ content: 'x'.repeat(MAX_SNAPSHOT_BYTES + 1) }),
      'SNAPSHOT_PREVIEW_TOO_LARGE'
    );
  });

  test('rejects an unknown format and an unknown format version', async () => {
    await expectPreviewCode(
      preview({ content: assembleSnapshot({ header: { format: 'other-format' } }) }),
      'SNAPSHOT_PREVIEW_FORMAT_UNSUPPORTED'
    );
    await expectPreviewCode(
      preview({ content: assembleSnapshot({ header: { formatVersion: 99 } }) }),
      'SNAPSHOT_PREVIEW_VERSION_UNSUPPORTED'
    );
  });

  test('rejects a record that was edited into a shape the export never writes', async () => {
    const content = assembleSnapshot({
      records: [{
        kind: 'record',
        section: 'pairs',
        localKey: 'LOCAL-1',
        remoteKey: 'VEND-1',
        createdAt: null,
        updatedAt: null,
        description: 'cross-reference text is not evidence'
      }]
    });

    await expectPreviewCode(preview({ content }), 'SNAPSHOT_PREVIEW_MALFORMED');
  });

  test('rejects duplicate pairs and inconsistent counts', async () => {
    const record = {
      kind: 'record',
      section: 'pairs',
      localKey: 'LOCAL-1',
      remoteKey: 'VEND-1',
      createdAt: null,
      updatedAt: null
    };

    await expectPreviewCode(
      preview({ content: assembleSnapshot({ records: [record, record] }) }),
      'SNAPSHOT_PREVIEW_MALFORMED'
    );

    await expectPreviewCode(
      preview({
        content: assembleSnapshot({
          records: [record],
          counts: {
            kind: 'counts',
            pairs: 2,
            ledger: 0,
            total: 2,
            skipped: { ledgerRetryClaims: 0 }
          }
        })
      }),
      'SNAPSHOT_PREVIEW_MALFORMED'
    );
  });

  test('rejects a header that does not record a paused export', async () => {
    await expectPreviewCode(
      preview({ content: assembleSnapshot({ header: { pause: { paused: false } } }) }),
      'SNAPSHOT_PREVIEW_MALFORMED'
    );
  });

  test('parses a valid file into its verified record sets', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    seedLedger({ sourceKey: 'LOCAL-1' });
    const snapshot = await exportSnapshot();

    const parsed = parseRecoverySnapshotContent(snapshot.content);

    expect(parsed.orgId).toBe('org-1');
    expect(parsed.formatVersion).toBe(2);
    expect(parsed.counts).toEqual({
      pairs: 1, ledger: 1, directions: 2, counterpartStatus: 0,
      mappingEnded: 0, mappingRepair: 0, total: 4, skippedRetryClaims: 0
    });
    expect(parsed.directions).toEqual([
      expect.objectContaining({ direction: 'local-to-remote', localKey: 'LOCAL-1', remoteKey: 'VEND-1' }),
      expect.objectContaining({ direction: 'remote-to-local', localKey: 'LOCAL-1', remoteKey: 'VEND-1' })
    ]);
    expect(parsed.pairs).toEqual([
      expect.objectContaining({ localKey: 'LOCAL-1', remoteKey: 'VEND-1' })
    ]);
    expect(parsed.ledger).toEqual([
      expect.objectContaining({ direction: 'local-to-remote', sourceKey: 'LOCAL-1' })
    ]);
    expect(parsed.checksum).toBe(snapshot.checksum);
  });
});


describe('recovery snapshot preview write boundary', () => {
  const previewSource = fs.readFileSync(
    path.join(process.cwd(), 'src/services/sync/recovery-snapshot-preview.js'),
    'utf8'
  );
  const resolverSource = fs.readFileSync(
    path.join(process.cwd(), 'src/resolvers/recovery-snapshot.js'),
    'utf8'
  );

  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  test('the preview module imports no write helper and no Jira client', () => {
    expect(previewSource).not.toContain('@forge/api');
    expect(previewSource).not.toMatch(
      /kvsStore\.(set|del|transaction|createIfNotExists|setIfNotExists|setWithTtl|setSecret|deleteSecret)\s*\(/
    );
    expect(previewSource).not.toMatch(/\bfetch\s*\(/);
    expect(previewSource).not.toMatch(/restoreMappings|applyRestore|writeMappings/);
  });

  test('the resolver exposes only export and preview for snapshots', () => {
    expect(resolverSource).toContain("resolver.define('exportRecoverySnapshot'");
    expect(resolverSource).toContain("resolver.define('previewRecoverySnapshot'");
    expect(resolverSource).not.toMatch(/resolver\.define\('(restore|apply|recover)/);
  });

  test('performs no storage or Jira mutation while reporting conflicts and blocks', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    seedPair('LOCAL-2', 'VEND-2');
    seedLedger({ sourceKey: 'LOCAL-1' });
    const snapshot = await exportSnapshot();

    seedPair('LOCAL-1', 'VEND-7');
    removePair('LOCAL-2', 'VEND-2');
    store.set('mapping-ended:org-1:LOCAL-2:VEND-2', {
      localKey: 'LOCAL-2',
      remoteKey: 'VEND-2',
      orgId: 'org-1',
      endedAt: '2026-01-05T00:00:00.000Z',
      reasonCode: 'administrator_ended'
    });
    const before = JSON.stringify([...store.entries()].sort());

    jest.clearAllMocks();
    const result = await preview({ content: snapshot.content });

    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.CONFLICTING]).toBe(1);
    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.BLOCKED]).toBe(1);
    expect(JSON.stringify([...store.entries()].sort())).toBe(before);
    expect(kvsStore.set).not.toHaveBeenCalled();
    expect(kvsStore.del).not.toHaveBeenCalled();
    expect(kvsStore.createIfNotExists).not.toHaveBeenCalled();
    expect(kvsStore.setWithTtl).not.toHaveBeenCalled();
    expect(kvsStore.transaction).not.toHaveBeenCalled();
    expect(api.asApp().requestJira).not.toHaveBeenCalled();
  });
});

describe('recovery snapshot preview resolver', () => {
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
  let snapshotContent;

  beforeEach(async () => {
    resetStore();
    jest.clearAllMocks();
    seedPair('LOCAL-1', 'VEND-1');
    seedLedger({ sourceKey: 'LOCAL-1' });
    snapshotContent = (await exportSnapshot()).content;

    getAppContext.mockReturnValue(FORGE_CONTEXT);
    requestJira.mockImplementation(async (url) => {
      if (String(url).includes('/serverInfo')) {
        return { ok: true, json: async () => ({ baseUrl: 'https://site.example.com' }) };
      }
      return {
        ok: true,
        json: async () => ({ permissions: { ADMINISTER: { havePermission: true } } })
      };
    });

    kvsStore.get.mockImplementation(async (key) => {
      if (key === 'organizations') return [ORG, ORG_TWO];
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
      call: { functionKey: 'previewRecoverySnapshot', payload },
      context: accountId === null ? {} : { accountId }
    });
  }

  test('is classified ADMIN_READ', () => {
    expect(RESOLVER_POLICIES.previewRecoverySnapshot).toBe('ADMIN_READ');
  });

  test('denies a caller without the Jira administrator permission', async () => {
    requestJira.mockResolvedValue({
      ok: true,
      json: async () => ({ permissions: { ADMINISTER: { havePermission: false } } })
    });

    await expect(invoke({ orgId: 'org-1', content: snapshotContent }))
      .resolves.toEqual(forbiddenResponse());
    expect(kvsStore.queryPageByPrefix).not.toHaveBeenCalled();
  });

  test('denies a caller without an account id', async () => {
    await expect(invoke({ orgId: 'org-1', content: snapshotContent }, null))
      .resolves.toEqual(forbiddenResponse());
  });

  test('returns the read-only classification for an authorized administrator', async () => {
    const result = await invoke({ orgId: 'org-1', content: snapshotContent });

    expect(result.success).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.noWritesPerformed).toBe(true);
    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.PRESENT]).toBe(1);
    expect(result.counts.ledger['already-present-consistent']).toBe(1);
    expect(kvsStore.set).not.toHaveBeenCalled();
  });

  test('returns fixed text for a file that cannot be previewed', async () => {
    const result = await invoke({ orgId: 'org-1', content: 'not-a-snapshot\n' });

    expect(result.success).toBe(false);
    expect(result.code).toBe('SNAPSHOT_PREVIEW_TRUNCATED');
    expect(result.error).toContain('incomplete');
    expect(result.error).not.toContain('not-a-snapshot');
  });

  test('reports the pause requirement through the resolver', async () => {
    kvsStore.get.mockImplementation(async (key) => {
      if (key === 'organizations') return [ORG, ORG_TWO];
      if (key === 'pilotPause') return { paused: false };
      return store.has(key) ? store.get(key) : null;
    });

    const result = await invoke({ orgId: 'org-1', content: snapshotContent });

    expect(result.code).toBe('SNAPSHOT_REQUIRES_PAUSE');
    expect(result.error).toContain('Pause synchronization');
    expect(kvsStore.set).not.toHaveBeenCalled();
  });

  test('does not leak internal failure detail', async () => {
    kvsStore.queryPageByPrefix.mockRejectedValue(new Error('internal kvs failure at node-7'));

    const result = await invoke({ orgId: 'org-1', content: snapshotContent });

    expect(result.code).toBe('SNAPSHOT_PREVIEW_STORAGE_UNAVAILABLE');
    expect(JSON.stringify(result)).not.toContain('internal kvs failure');
  });
});

