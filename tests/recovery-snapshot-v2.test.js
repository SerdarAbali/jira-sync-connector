/**
 * Recovery snapshot format v2.
 *
 * These tests drive the production export and preview with an in-memory KVS page
 * reader. They cover the evidence version 2 adds — directed mapping lookups,
 * counterpart status, ended mappings and repair markers — together with version 1
 * compatibility, cross-organization isolation, malformed sections and the
 * guarantee that neither path writes anything.
 */
import api from '@forge/api';
import { createHash } from 'crypto';
import {
  buildRecoverySnapshot,
  digestLines,
  RECOVERY_SNAPSHOT_FORMAT,
  RECOVERY_SNAPSHOT_SECTION_RECORD_TYPES,
  RECOVERY_SNAPSHOT_SECTIONS,
  stableStringify,
  verifySnapshotContent
} from '../src/services/sync/recovery-snapshot.js';
import {
  PREVIEW_PAIR_CLASSES,
  PREVIEW_RECOVERABILITY_REASONS,
  parseRecoverySnapshotContent,
  previewRestoreSnapshot
} from '../src/services/sync/recovery-snapshot-preview.js';
import * as kvsStore from '../src/services/storage/kvs.js';

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  return {
    __esModule: true,
    default: { asApp: () => ({ requestJira }), asUser: () => ({ requestJira }) },
    getAppContext: jest.fn(),
    route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch: jest.fn()
  };
});

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
const scannedPrefixes = [];

function fakePage(prefix, options = {}) {
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
  remoteProjectKey: 'VEND',
  allowedProjects: ['LOCAL'],
  syncDirection: 'push'
};

const ORG_TWO = { ...ORG, id: 'org-2', name: 'Second Org', remoteProjectKey: 'SECOND' };

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
  appVersion: '3.13.0',
  environmentId: 'env-0000000000000001',
  environmentType: 'staging',
  installationId: 'installation-0000001',
  cloudIds: ['cloud-0000001'],
  siteHost: 'site.example.com',
  siteReason: null,
  bound: true
};

function baseDeps() {
  return {
    queryPage: jest.fn((prefix, options) => {
      scannedPrefixes.push(prefix);
      return fakePage(prefix, options);
    }),
    getStored: jest.fn(async (key) => (key === 'organizations' ? [ORG, ORG_TWO] : null)),
    getPilotPause: jest.fn(async () => ({ ...PAUSED })),
    readIdentity: jest.fn(async () => ({ ...IDENTITY })),
    now: () => Date.parse('2026-02-03T04:05:06.000Z')
  };
}

function seedPair(localKey, remoteKey, orgId = 'org-1') {
  store.set(`mapping-meta:${orgId}:${localKey}`, {
    localKey,
    remoteKey,
    orgId,
    updatedAt: '2026-01-01T00:00:00.000Z'
  });
  store.set(`${orgId}:local-to-remote:${localKey}`, remoteKey);
  store.set(`${orgId}:remote-to-local:${remoteKey}`, localKey);
}

function seedLedger(orgId = 'org-1', sourceKey = 'LOCAL-1') {
  store.set(`issue-create-op:${orgId}:local-to-remote:${encodeURIComponent(sourceKey)}`, {
    orgId,
    direction: 'local-to-remote',
    sourceKey,
    state: 'succeeded',
    attempt: 1,
    targetKey: 'VEND-1',
    operationId: 'op-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:05:00.000Z',
    attemptToken: 'SECRET_ATTEMPT_TOKEN'
  });
}

function seedEnded(localKey, remoteKey, orgId = 'org-1') {
  store.set(`mapping-ended:${orgId}:${localKey}:${remoteKey}`, {
    localKey,
    remoteKey,
    orgId,
    endedAt: '2026-01-05T00:00:00.000Z',
    endedBy: 'admin-account-id',
    reasonCode: 'administrator_ended'
  });
}

function seedCounterpartStatus(localKey, remoteKey, value = {}, orgId = 'org-1') {
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
    ...value
  });
}

async function exportSnapshot(orgId = 'org-1') {
  return buildRecoverySnapshot({ orgId, deps: baseDeps() });
}

function preview(content, orgId = 'org-1') {
  return previewRestoreSnapshot({ orgId, content, deps: baseDeps() });
}

describe('recovery snapshot v2 export', () => {
  beforeEach(() => {
    store.clear();
    scannedPrefixes.length = 0;
    jest.clearAllMocks();
  });

  test('exports every version 2 section with deterministic checksums', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    seedLedger();
    seedEnded('LOCAL-2', 'VEND-2');
    seedCounterpartStatus('LOCAL-3', 'VEND-3');

    const result = await exportSnapshot();
    const [header] = result.content.trimEnd().split('\n').map((line) => JSON.parse(line));

    expect(result.formatVersion).toBe(2);
    expect(header.formatVersion).toBe(2);
    expect(header.sections.map((entry) => entry.name)).toEqual([...RECOVERY_SNAPSHOT_SECTIONS]);
    expect(header.sections.map((entry) => entry.recordType)).toEqual([
      'issue-pair-mapping',
      'issue-create-ledger',
      'mapping-direction',
      'counterpart-status',
      'mapping-ended',
      'mapping-repair'
    ]);
    expect(result.counts).toEqual({
      pairs: 1, ledger: 1, directions: 2, counterpartStatus: 1,
      mappingEnded: 1, mappingRepair: 0, total: 6, skippedRetryClaims: 0
    });
    expect(verifySnapshotContent(result.content).valid).toBe(true);
  });

  test('is deterministic and keeps secrets and actor identifiers out', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    seedLedger();
    seedEnded('LOCAL-2', 'VEND-2');
    seedCounterpartStatus('LOCAL-3', 'VEND-3');

    const first = await exportSnapshot();
    const second = await exportSnapshot();

    expect(second.content).toBe(first.content);
    expect(first.content).not.toContain('SECRET_ATTEMPT_TOKEN');
    expect(first.content).not.toContain('admin-account-id');
    expect(kvsStore.getSecret).not.toHaveBeenCalled();
    expect(kvsStore.set).not.toHaveBeenCalled();
  });

  test('isolates every section to the selected organization', async () => {
    seedPair('LOCAL-1', 'VEND-1', 'org-1');
    seedPair('OTHER-1', 'SECOND-1', 'org-2');
    seedEnded('OTHER-2', 'SECOND-2', 'org-2');
    seedCounterpartStatus('OTHER-3', 'SECOND-3', {}, 'org-2');

    const result = await exportSnapshot('org-1');

    expect(result.counts).toEqual({
      pairs: 1, ledger: 0, directions: 2, counterpartStatus: 0,
      mappingEnded: 0, mappingRepair: 0, total: 3, skippedRetryClaims: 0
    });
    expect(result.content).not.toContain('OTHER-1');
    expect(result.content).not.toContain('SECOND-2');
    expect(result.content).not.toContain('SECOND-3');
  });

  test('exports a metadata-only pair as incomplete directional evidence', async () => {
    store.set('mapping-meta:org-1:LOCAL-1', {
      localKey: 'LOCAL-1', remoteKey: 'VEND-1', orgId: 'org-1',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
    store.set('org-1:local-to-remote:LOCAL-1', 'VEND-1');

    const result = await exportSnapshot();
    const parsed = parseRecoverySnapshotContent(result.content);

    expect(result.counts.pairs).toBe(1);
    expect(result.counts.directions).toBe(1);
    expect(parsed.directions).toEqual([
      expect.objectContaining({ direction: 'local-to-remote', localKey: 'LOCAL-1', remoteKey: 'VEND-1' })
    ]);
  });
});

describe('recovery snapshot v2 evidence preservation', () => {
  beforeEach(() => {
    store.clear();
    scannedPrefixes.length = 0;
    jest.clearAllMocks();
  });

  test('keeps an ended pair blocked after the mapping itself is gone', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    seedEnded('LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();

    store.delete('mapping-meta:org-1:LOCAL-1');
    store.delete('org-1:local-to-remote:LOCAL-1');
    store.delete('org-1:remote-to-local:VEND-1');
    store.delete('mapping-ended:org-1:LOCAL-1:VEND-1');

    const result = await preview(snapshot.content);

    expect(result.evidence.ended).toBe(1);
    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.BLOCKED]).toBe(1);
    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.MISSING]).toBe(0);
    expect(result.counts.restorablePairs).toBe(0);
    expect(result.samples.pairs.blocked).toEqual([
      expect.objectContaining({ localKey: 'LOCAL-1', remoteKey: 'VEND-1', reason: 'mapping-ended' })
    ]);
    expect(kvsStore.set).not.toHaveBeenCalled();
  });

  test('keeps a confirmed-deleted counterpart blocked and counted', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    seedCounterpartStatus('LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();

    store.delete('mapping-meta:org-1:LOCAL-1');
    store.delete('org-1:local-to-remote:LOCAL-1');
    store.delete('org-1:remote-to-local:VEND-1');
    store.delete('counterpart-status:org-1:LOCAL-1:VEND-1');

    const result = await preview(snapshot.content);

    expect(result.evidence.counterpartBlocking).toBe(1);
    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.BLOCKED]).toBe(1);
    expect(result.samples.pairs.blocked).toEqual([
      expect.objectContaining({ reason: 'counterpart-deleted' })
    ]);
  });

  test('reports a replaced counterpart as archived, not restorable', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    seedCounterpartStatus('LOCAL-1', 'VEND-1', { state: 'replaced', status: 'confirmed_deleted' });
    const snapshot = await exportSnapshot();

    store.delete('mapping-meta:org-1:LOCAL-1');
    store.delete('org-1:local-to-remote:LOCAL-1');
    store.delete('org-1:remote-to-local:VEND-1');
    store.delete('counterpart-status:org-1:LOCAL-1:VEND-1');

    const result = await preview(snapshot.content);

    expect(result.evidence.counterpartArchived).toBe(1);
    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.BLOCKED]).toBe(1);
    expect(result.samples.pairs.blocked).toEqual([
      expect.objectContaining({ reason: 'counterpart-archived' })
    ]);
  });

  test('keeps a repair marker blocking instead of completing the pair', async () => {
    const content = assembleSnapshot({
      records: [
        pairRecord('LOCAL-1', 'VEND-1'),
        repairRecord('LOCAL-1', 'VEND-1')
      ]
    });

    const result = await preview(content);

    expect(result.evidence.repaired).toBe(1);
    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.BLOCKED]).toBe(1);
    expect(result.counts.restorablePairs).toBe(0);
  });

  test('refuses to call a file recoverable when its evidence contradicts itself', async () => {
    const content = assembleSnapshot({
      records: [
        pairRecord('LOCAL-1', 'VEND-1'),
        directionRecord('local-to-remote', 'LOCAL-1', 'VEND-1'),
        directionRecord('remote-to-local', 'LOCAL-1', 'VEND-1'),
        endedRecord('LOCAL-1', 'VEND-1'),
        statusRecord('LOCAL-1', 'VEND-1', { state: 'active', status: 'temporary_failure' })
      ]
    });

    const result = await preview(content);

    expect(result.evidence.conflicting).toEqual([
      expect.objectContaining({ localKey: 'LOCAL-1', remoteKey: 'VEND-1', reason: 'ended-with-active-counterpart' })
    ]);
    expect(result.recoverability.recoverable).toBe(false);
    expect(result.recoverability.reasons)
      .toContain(PREVIEW_RECOVERABILITY_REASONS.EVIDENCE_CONFLICTING);
  });
});

describe('recovery snapshot v1 compatibility', () => {
  beforeEach(() => {
    store.clear();
    scannedPrefixes.length = 0;
    jest.clearAllMocks();
  });

  test('still parses a version 1 file and reports it as insufficient evidence', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const content = assembleSnapshot({
      version: 1,
      records: [pairRecord('LOCAL-1', 'VEND-1')]
    });

    const parsed = parseRecoverySnapshotContent(content);
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.directions).toEqual([]);
    expect(parsed.counterpartStatus).toEqual([]);

    const result = await preview(content);
    expect(result.formatVersion).toBe(1);
    expect(result.counts.snapshot).toEqual({
      pairs: 1, ledger: 0, total: 1, skippedRetryClaims: 0
    });
    expect(result.counts.live).toEqual({ pairs: 1, ledger: 0, skippedRetryClaims: 0 });
    expect(result.counts.pairs).toEqual({
      [PREVIEW_PAIR_CLASSES.PRESENT]: 1,
      [PREVIEW_PAIR_CLASSES.MISSING]: 0,
      [PREVIEW_PAIR_CLASSES.CONFLICTING]: 0,
      [PREVIEW_PAIR_CLASSES.BLOCKED]: 0
    });
    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.INCOMPLETE_DIRECTIONAL]).toBeUndefined();
    expect(result.evidence.available).toBe(false);
    expect(result.recoverability).toEqual({
      recoverable: false,
      reasons: [PREVIEW_RECOVERABILITY_REASONS.V1_INSUFFICIENT_EVIDENCE]
    });
    expect(scannedPrefixes).not.toContain('org-1:local-to-remote:');
    expect(kvsStore.set).not.toHaveBeenCalled();
    expect(api.asApp().requestJira).not.toHaveBeenCalled();
  });

  test('refuses an unsupported format version', () => {
    const content = assembleSnapshot({ version: 2, headerVersion: 3, records: [] });
    expect(() => parseRecoverySnapshotContent(content))
      .toThrow(expect.objectContaining({ code: 'SNAPSHOT_PREVIEW_VERSION_UNSUPPORTED' }));
  });
});

/* Canonical record builders. The preview requires each line to be exactly the
 * bytes the export's own normalizer produces. */
const pairRecord = (localKey, remoteKey) => ({
  kind: 'record', section: 'pairs', localKey, remoteKey, createdAt: null, updatedAt: null
});
const directionRecord = (direction, localKey, remoteKey) => ({
  kind: 'record', section: 'directions', direction, localKey, remoteKey
});
const endedRecord = (localKey, remoteKey) => ({
  kind: 'record', section: 'mappingEnded', localKey, remoteKey,
  endedAt: '2026-01-05T00:00:00.000Z', reasonCode: 'administrator_ended'
});
const repairRecord = (localKey, remoteKey) => ({
  kind: 'record', section: 'mappingRepair', localKey, remoteKey,
  reason: 'partial-mapping-write', detectedAt: '2026-01-05T00:00:00.000Z'
});
const statusRecord = (localKey, remoteKey, { state = 'active', status = 'confirmed_deleted' } = {}) => ({
  kind: 'record', section: 'counterpartStatus', localKey, remoteKey, state, status,
  deletedSide: 'remote', source: 'jira-probe', reasonCode: 'deleted', probeStatusCode: 404,
  firstDetectedAt: '2026-01-05T00:00:00.000Z', lastDetectedAt: '2026-01-05T00:00:00.000Z',
  updatedAt: '2026-01-05T00:00:00.000Z', endedAt: null, resolvedAt: null,
  replacementLocalKey: null, replacementRemoteKey: null
});

function assembleSnapshot({ version = 2, headerVersion = null, records = [], counts, sectionChecksums } = {}) {
  const declaredVersion = headerVersion ?? version;
  const sections = version === 2 ? RECOVERY_SNAPSHOT_SECTIONS : ['pairs', 'ledger'];
  const lines = Object.fromEntries(sections.map((name) => [name, []]));
  for (const record of records) {
    lines[record.section].push(stableStringify(record));
  }
  const resolvedCounts = counts || {
    kind: 'counts',
    ...Object.fromEntries(sections.map((name) => [name, lines[name].length])),
    total: sections.reduce((sum, name) => sum + lines[name].length, 0),
    skipped: { ledgerRetryClaims: 0 }
  };
  const checksums = sectionChecksums
    || Object.fromEntries(sections.map((name) => [name, digestLines(lines[name])]));
  const headerLine = stableStringify({
    kind: 'header',
    format: RECOVERY_SNAPSHOT_FORMAT,
    formatVersion: declaredVersion,
    exportedAt: '2026-02-03T04:05:06.000Z',
    scope: 'one-organization',
    notice: 'test',
    identity: { ...IDENTITY, readable: undefined },
    organization: {
      id: 'org-1',
      name: 'Pilot Org',
      remoteHost: 'vendor.example.com',
      remoteProjectKey: 'VEND',
      allowedProjects: ['LOCAL'],
      syncDirection: 'push'
    },
    pause: PAUSED,
    sections: sections.map((name) => ({
      name,
      recordType: RECOVERY_SNAPSHOT_SECTION_RECORD_TYPES[name] || 'issue-pair-mapping',
      count: lines[name].length,
      pagesScanned: 1,
      checksum: checksums[name]
    })),
    omissions: [],
    limitations: []
  });
  const recordLines = sections.flatMap((name) => lines[name]);
  const countsLine = stableStringify(resolvedCounts);
  const checksum = `sha256:${createHash('sha256')
    .update(`${[headerLine, ...recordLines, countsLine].join('\n')}\n`, 'utf8')
    .digest('hex')}`;
  const footerLine = stableStringify({
    kind: 'footer',
    format: RECOVERY_SNAPSHOT_FORMAT,
    formatVersion: declaredVersion,
    checksumAlgorithm: 'sha256',
    checksumScope: 'header,records,counts',
    checksum,
    counts: resolvedCounts,
    sectionChecksums: checksums,
    notice: 'test',
    limitations: []
  });
  return `${[headerLine, ...recordLines, countsLine, footerLine].join('\n')}\n`;
}

describe('recovery snapshot v2 directional evidence', () => {
  beforeEach(() => {
    store.clear();
    scannedPrefixes.length = 0;
    jest.clearAllMocks();
  });

  test('never reports a metadata-only pair as healthy', async () => {
    store.set('mapping-meta:org-1:LOCAL-1', {
      localKey: 'LOCAL-1', remoteKey: 'VEND-1', orgId: 'org-1',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
    store.set('org-1:local-to-remote:LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();

    const result = await preview(snapshot.content);

    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.PRESENT]).toBe(0);
    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.INCOMPLETE_DIRECTIONAL]).toBe(1);
    expect(result.counts.restorablePairs).toBe(0);
    expect(result.evidence.directional.incompletePairs).toBe(1);
    expect(result.recoverability.recoverable).toBe(false);
    expect(result.recoverability.reasons)
      .toContain(PREVIEW_RECOVERABILITY_REASONS.DIRECTIONAL_EVIDENCE_INCOMPLETE);
  });

  test('reports a live missing direction as incomplete, not as present', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();

    store.delete('org-1:remote-to-local:VEND-1');
    const result = await preview(snapshot.content);

    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.PRESENT]).toBe(0);
    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.INCOMPLETE_DIRECTIONAL]).toBe(1);
    expect(result.counts.restorablePairs).toBe(0);
    expect(result.samples.pairs.incomplete).toEqual([
      expect.objectContaining({ localKey: 'LOCAL-1', remoteKey: 'VEND-1', directionalState: 'partial' })
    ]);
    expect(result.recoverability.recoverable).toBe(true);
  });

  test('reports two directions that disagree as a conflict', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();

    store.set('org-1:remote-to-local:VEND-1', 'LOCAL-9');
    const result = await preview(snapshot.content);

    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.CONFLICTING]).toBe(1);
    expect(result.samples.pairs.conflicting).toEqual([
      expect.objectContaining({ reason: 'directed-mapping-differs' })
    ]);
  });

  test('detects a directional-only pair when the metadata index was lost', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();

    store.delete('mapping-meta:org-1:LOCAL-1');
    const result = await preview(snapshot.content);

    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.MISSING]).toBe(1);
    expect(result.counts.restorablePairs).toBe(1);
    expect(result.samples.pairs.missing).toEqual([
      expect.objectContaining({ directionalState: 'complete' })
    ]);
  });

  test('keeps evidence scoped to the pair it names', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    seedPair('LOCAL-2', 'VEND-2');
    seedEnded('LOCAL-2', 'VEND-2');
    const snapshot = await exportSnapshot();

    const result = await preview(snapshot.content);

    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.PRESENT]).toBe(2);
    expect(result.counts.pairs[PREVIEW_PAIR_CLASSES.BLOCKED]).toBe(0);
    expect(result.evidence.ended).toBe(1);
  });
});

describe('recovery snapshot v2 fail-closed validation', () => {
  beforeEach(() => {
    store.clear();
    scannedPrefixes.length = 0;
    jest.clearAllMocks();
  });

  test('refuses a truncated file', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    seedEnded('LOCAL-1', 'VEND-1');
    const snapshot = await exportSnapshot();
    const lines = snapshot.content.trimEnd().split('\n');
    const truncated = `${lines.slice(0, -2).join('\n')}\n`;

    expect(() => parseRecoverySnapshotContent(truncated))
      .toThrow(expect.objectContaining({ code: 'SNAPSHOT_PREVIEW_TRUNCATED' }));
    await expect(preview(truncated)).rejects
      .toMatchObject({ code: 'SNAPSHOT_PREVIEW_TRUNCATED' });
  });

  test('refuses a file whose counts do not match its records', () => {
    const content = assembleSnapshot({
      records: [directionRecord('local-to-remote', 'LOCAL-1', 'VEND-1')],
      counts: {
        kind: 'counts', pairs: 4, ledger: 0, directions: 1, counterpartStatus: 0,
        mappingEnded: 0, mappingRepair: 0, total: 5, skipped: { ledgerRetryClaims: 0 }
      }
    });

    expect(() => parseRecoverySnapshotContent(content))
      .toThrow(expect.objectContaining({ code: 'SNAPSHOT_PREVIEW_MALFORMED' }));
  });

  test('refuses an evidence record the export never writes', () => {
    const content = assembleSnapshot({
      records: [
        directionRecord('local-to-remote', 'LOCAL-1', 'VEND-1'),
        directionRecord('remote-to-local', 'LOCAL-1', 'VEND-1'),
        statusRecord('LOCAL-1', 'VEND-1', { status: 'something_else' })
      ]
    });

    expect(() => parseRecoverySnapshotContent(content))
      .toThrow(expect.objectContaining({ code: 'SNAPSHOT_PREVIEW_MALFORMED' }));
  });

  test('refuses a record with an added field even when re-signed', () => {
    const tampered = { ...endedRecord('LOCAL-1', 'VEND-1'), note: 'extra' };
    const content = assembleSnapshot({ records: [tampered] });

    expect(() => parseRecoverySnapshotContent(content))
      .toThrow(expect.objectContaining({ code: 'SNAPSHOT_PREVIEW_MALFORMED' }));
  });

  test('performs no storage or Jira write while comparing a version 2 file', async () => {
    seedPair('LOCAL-1', 'VEND-1');
    seedLedger();
    seedEnded('LOCAL-2', 'VEND-2');
    const snapshot = await exportSnapshot();
    jest.clearAllMocks();

    await preview(snapshot.content);

    expect(kvsStore.set).not.toHaveBeenCalled();
    expect(kvsStore.del).not.toHaveBeenCalled();
    expect(kvsStore.createIfNotExists).not.toHaveBeenCalled();
    expect(kvsStore.transaction).not.toHaveBeenCalled();
    expect(api.asApp().requestJira).not.toHaveBeenCalled();
  });
});
