import * as kvsStore from '../storage/kvs.js';
import { getPilotPause } from './pilot-pause.js';
import { readForgeInstallationIdentity } from '../readiness/connector-readiness.js';
import {
  MAX_SECTION_PAGES,
  MAX_SECTION_RECORDS,
  MAX_SNAPSHOT_BYTES,
  RECOVERY_SNAPSHOT_FORMAT,
  RECOVERY_SNAPSHOT_SECTIONS,
  RECOVERY_SNAPSHOT_SECTIONS_FOR_VERSION,
  RECOVERY_SNAPSHOT_VERSION_V1,
  RecoverySnapshotError,
  SNAPSHOT_PAGE_SIZE,
  digestLines,
  normalizeCounterpartStatusRecord,
  normalizeDirectionRecord,
  normalizeLedgerRecord,
  normalizeMappingEndedRecord,
  normalizeMappingRepairRecord,
  normalizePairRecord,
  normalizeSnapshotOrgId,
  readOrganizationScope,
  readStoredSection,
  sectionRecordLimit,
  stableStringify,
  verifySnapshotContent
} from './recovery-snapshot.js';
import { ISSUE_CREATE_DIRECTIONS, ISSUE_CREATE_STATES } from './issue-create-operation.js';
import { counterpartStatusBlocksSync } from './counterpart-status.js';
import { isValidIssueKey } from '../storage/mappings.js';

/**
 * Read-only restore preview for a previously exported recovery snapshot.
 *
 * The preview answers one question without changing anything: if the stored
 * mapping and create-ledger records were restored from this file, which pairs
 * already agree, which are absent, which disagree and which are blocked by an
 * existing ended, repair or deleted-counterpart record?
 *
 * Boundaries:
 * - No Jira read or write happens here. Pairing evidence is the stored
 *   `mapping-meta` index only; a description, summary or cross-reference text is
 *   never read and therefore never trusted as proof of a pairing.
 * - No mapping, ledger row, manifest, restore plan or pause state is written.
 *   The module imports no write helper from the storage layer.
 * - Live storage is read with one bounded cursor scan per section while the
 *   emergency pause holds. The pause is the consistency boundary, exactly as in
 *   the export; Forge offers no multi-key read transaction.
 * - Every structural problem in the uploaded file fails closed. A partial or
 *   unverifiable file is never partially classified.
 */

export const PREVIEW_PAIR_CLASSES = Object.freeze({
  PRESENT: 'already-present-consistent',
  MISSING: 'missing-potentially-restorable',
  CONFLICTING: 'conflicting',
  BLOCKED: 'blocked-by-existing-record',
  // Version 2 only. Storage holds the pair metadata but not both directed
  // lookups (or the two directions disagree), so synchronization cannot resolve
  // the pair and the record must never be reported as healthy.
  INCOMPLETE_DIRECTIONAL: 'incomplete-directional'
});

export const PREVIEW_LEDGER_CLASSES = Object.freeze({
  PRESENT: 'already-present-consistent',
  MISSING: 'missing',
  CONFLICTING: 'conflicting'
});

export const PREVIEW_IDENTITY_CLASSES = Object.freeze({
  SAME_INSTALLATION: 'same-installation',
  DIFFERENT_INSTALLATION: 'different-installation'
});

export const PREVIEW_SAMPLE_LIMIT = 5;

/**
 * A restore plan is deliberately bounded. A larger snapshot is restored over
 * several plans: once the first candidates are present, a fresh preview selects
 * the next slice. This keeps one KVS plan value and one approved batch set below
 * the storage and invocation limits instead of pretending an 8,000-pair file can
 * be approved atomically.
 */
export const RESTORE_CANDIDATE_LIMIT = 200;

export const PREVIEW_BLOCKER_REASONS = Object.freeze({
  MAPPING_ENDED: 'mapping-ended',
  MAPPING_REPAIR: 'mapping-repair',
  COUNTERPART_DELETED: 'counterpart-deleted',
  COUNTERPART_ARCHIVED: 'counterpart-archived',
  COUNTERPART_UNREADABLE: 'counterpart-unreadable'
});

export const PREVIEW_CONFLICT_REASONS = Object.freeze({
  REMOTE_KEY_DIFFERS: 'remote-key-differs',
  REMOTE_KEY_ALREADY_MAPPED: 'remote-key-already-mapped',
  DIRECTED_MAPPING_DIFFERS: 'directed-mapping-differs',
  LEDGER_TARGET_DIFFERS: 'ledger-target-differs-from-pair',
  LEDGER_STATE_DIFFERS: 'ledger-state-differs'
});

export const PREVIEW_EVIDENCE_CLASSES = Object.freeze({
  ENDED: 'ended-by-administrator',
  REPAIRED: 'repair-required',
  COUNTERPART_BLOCKING: 'counterpart-blocking',
  COUNTERPART_ARCHIVED: 'counterpart-archived',
  CONFLICTING: 'conflicting-evidence'
});

export const PREVIEW_RECOVERABILITY_REASONS = Object.freeze({
  V1_INSUFFICIENT_EVIDENCE: 'v1-insufficient-evidence',
  DIFFERENT_INSTALLATION: 'different-installation',
  DIRECTIONAL_EVIDENCE_INCOMPLETE: 'directional-evidence-incomplete',
  DIRECTIONAL_EVIDENCE_CONFLICTING: 'directional-evidence-conflicting',
  EVIDENCE_CONFLICTING: 'evidence-conflicting'
});

export const PREVIEW_LIMITATIONS = Object.freeze([
  'The preview only compares records. It writes no mapping, ledger row, manifest or restore plan, and it changes no Jira issue.',
  'Pairing evidence is limited to the stored mapping-meta index and the two directed lookup prefixes. No issue description, summary or cross-reference text is read, so none of it is trusted as proof of a pairing.',
  'Live storage is read with one bounded cursor scan per section while the emergency pause holds; Forge storage offers no multi-key read transaction.',
  'A ledger row reported as missing is evidence of a lost create attempt, not a row this preview would recreate. Nothing resolves an unknown or pending ledger row.'
]);


const PREVIEW_ERROR_TEXT = Object.freeze({
  SNAPSHOT_PREVIEW_EMPTY:
    'No snapshot content was supplied. Select the .ndjson file produced by the export before previewing.',
  SNAPSHOT_PREVIEW_TOO_LARGE:
    'This file exceeds the 3 MB preview budget. It is refused rather than partially compared.',
  SNAPSHOT_PREVIEW_TRUNCATED:
    'This file is incomplete: a line is missing, the final line is unterminated or the footer is absent. Nothing was compared.',
  SNAPSHOT_PREVIEW_MALFORMED:
    'This file could not be interpreted as a recovery snapshot. Nothing was compared.',
  SNAPSHOT_PREVIEW_CHECKSUM_MISMATCH:
    'The file checksum does not match its contents, so the file is corrupt or was edited after download. Nothing was compared.',
  SNAPSHOT_PREVIEW_FORMAT_UNSUPPORTED:
    'This file is not a connector recovery snapshot. Nothing was compared.',
  SNAPSHOT_PREVIEW_VERSION_UNSUPPORTED:
    'This file uses a snapshot format version this connector version does not understand. Nothing was compared.',
  SNAPSHOT_PREVIEW_ORGANIZATION_MISMATCH:
    'This file was exported for a different organization. Comparing it with the selected organization would mix unrelated records, so it was refused.',
  SNAPSHOT_PREVIEW_ROUTING_MISMATCH:
    'The file was exported with a different Jira site or remote project routing than the selected organization has now. Pair identities would not be comparable, so the preview was refused.',
  SNAPSHOT_PREVIEW_DIFFERENT_APP:
    'This file was produced by a different Forge app. Nothing was compared.',
  SNAPSHOT_PREVIEW_DIFFERENT_SITE:
    'This file was produced on a different Jira site. Nothing was compared.',
  SNAPSHOT_PREVIEW_STORAGE_UNAVAILABLE:
    'Connector storage could not be read completely. No comparison was reported and nothing was written.',
  SNAPSHOT_REQUIRES_PAUSE:
    'Pause synchronization before previewing a recovery snapshot. The preview never changes the pause state itself.',
  SNAPSHOT_PAUSE_UNREADABLE:
    'The emergency pause state could not be read. Previewing without it could compare a moving target, so the preview was refused.',
  SNAPSHOT_IDENTITY_UNAVAILABLE:
    'The Forge application, environment, installation or site identity could not be read, so the file cannot be compared with this installation.',
  SNAPSHOT_ORGANIZATION_REQUIRED: 'Select exactly one organization before previewing a snapshot.',
  SNAPSHOT_ORGANIZATION_INVALID: 'The selected organization identifier is not valid.',
  SNAPSHOT_ORGANIZATION_NOT_FOUND:
    'The selected organization is not configured in this installation.',
  SNAPSHOT_PREVIEW_FAILED: 'The recovery snapshot could not be previewed.'
});

export function previewErrorMessage(code) {
  return PREVIEW_ERROR_TEXT[code] || PREVIEW_ERROR_TEXT.SNAPSHOT_PREVIEW_FAILED;
}

function previewError(code, details = {}) {
  return new RecoverySnapshotError(code, code, details);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const HOST_PATTERN = /^[a-z0-9][a-z0-9.-]{0,252}$/;

function isHost(value) {
  return typeof value === 'string' && HOST_PATTERN.test(value);
}

function sortedUniqueStrings(value) {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((entry) => typeof entry === 'string'))).sort()
    : [];
}

function ledgerRestorePair(record) {
  if (!record || !record.targetKey) return null;
  if (record.direction === ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE) {
    return { localKey: record.sourceKey, remoteKey: record.targetKey };
  }
  if (record.direction === ISSUE_CREATE_DIRECTIONS.REMOTE_TO_LOCAL) {
    return { localKey: record.targetKey, remoteKey: record.sourceKey };
  }
  return null;
}

function pairKey(localKey, remoteKey) {
  return `${localKey}\u0000${remoteKey}`;
}

function ledgerIdentity(record) {
  return `${record.direction}\u0000${record.sourceKey}\u0000${record.operationSuffix || ''}`;
}


function parseSnapshotLine(line, index) {
  try {
    return JSON.parse(line);
  } catch {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { line: index });
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field });
  }
  return value;
}

function readHeader(header) {
  if (!isPlainObject(header) || header.kind !== 'header') {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: 'header' });
  }
  if (header.format !== RECOVERY_SNAPSHOT_FORMAT) {
    throw previewError('SNAPSHOT_PREVIEW_FORMAT_UNSUPPORTED');
  }
  const expectedSections = RECOVERY_SNAPSHOT_SECTIONS_FOR_VERSION[header.formatVersion];
  if (!Array.isArray(expectedSections)) {
    throw previewError('SNAPSHOT_PREVIEW_VERSION_UNSUPPORTED', {
      formatVersion: header.formatVersion
    });
  }
  if (header.scope !== 'one-organization') {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: 'scope' });
  }
  if (!isPlainObject(header.organization) || !isPlainObject(header.identity)) {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: 'identity' });
  }

  let orgId;
  try {
    orgId = normalizeSnapshotOrgId(header.organization.id);
  } catch {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: 'organization.id' });
  }

  const remoteHost = header.organization.remoteHost;
  if (!('remoteHost' in header.organization)) {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: 'organization.remoteHost' });
  }
  if (remoteHost !== null && !isHost(remoteHost)) {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: 'organization.remoteHost' });
  }
  if (!Array.isArray(header.organization.allowedProjects)) {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: 'organization.allowedProjects' });
  }
  if (!Array.isArray(header.identity.cloudIds)) {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: 'identity.cloudIds' });
  }

  const identity = {
    appId: requireString(header.identity.appId, 'identity.appId'),
    appAri: requireString(header.identity.appAri, 'identity.appAri'),
    appVersion: typeof header.identity.appVersion === 'string' ? header.identity.appVersion : null,
    environmentId: requireString(header.identity.environmentId, 'identity.environmentId'),
    environmentType: requireString(header.identity.environmentType, 'identity.environmentType'),
    installationId: requireString(header.identity.installationId, 'identity.installationId'),
    siteHost: requireString(header.identity.siteHost, 'identity.siteHost'),
    cloudIds: sortedUniqueStrings(header.identity.cloudIds)
  };

  if (header.pause?.paused !== true) {
    // The export only ever runs under the pause. A file without that marker is
    // not a consistent snapshot, so it is refused instead of classified.
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: 'pause' });
  }

  const manifest = new Map();
  if (!Array.isArray(header.sections) || header.sections.length !== expectedSections.length) {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: 'sections' });
  }
  for (const section of header.sections) {
    if (!isPlainObject(section) || !expectedSections.includes(section.name)) {
      throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: 'sections' });
    }
    if (!Number.isInteger(section.count) || section.count < 0
      || section.count > sectionRecordLimit(section.name)
      || typeof section.checksum !== 'string' || !section.checksum.startsWith('sha256:')) {
      throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: `sections.${section.name}` });
    }
    if (manifest.has(section.name)) {
      throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: `sections.${section.name}` });
    }
    manifest.set(section.name, { count: section.count, checksum: section.checksum });
  }
  if (manifest.size !== expectedSections.length) {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: 'sections' });
  }

  return {
    orgId,
    formatVersion: header.formatVersion,
    expectedSections,
    identity,
    organization: {
      id: orgId,
      name: typeof header.organization.name === 'string' ? header.organization.name : null,
      remoteHost: typeof remoteHost === 'string' ? remoteHost : null,
      remoteProjectKey: typeof header.organization.remoteProjectKey === 'string'
        ? header.organization.remoteProjectKey
        : null,
      allowedProjects: sortedUniqueStrings(header.organization.allowedProjects),
      syncDirection: header.organization.syncDirection === 'bidirectional'
        ? 'bidirectional'
        : 'push'
    },
    pause: {
      paused: true,
      pausedAt: typeof header.pause.pausedAt === 'string' ? header.pause.pausedAt : null,
      reasonCode: typeof header.pause.reasonCode === 'string' ? header.pause.reasonCode : null
    },
    exportedAt: requireString(header.exportedAt, 'exportedAt'),
    sections: manifest
  };
}

function normalizeSnapshotPair(record, line, index, orgId) {
  const localKey = typeof record.localKey === 'string' ? record.localKey : '';
  try {
    const normalized = normalizePairRecord(`mapping-meta:${orgId}:${localKey}`, record, orgId);
    // The export writes the normalizer output for every record. A line that
    // carries an extra, missing or renamed field is not a file this connector
    // produced and is refused. Whitespace and key order do not matter here; the
    // whole-file checksum already covers the raw bytes.
    if (normalized.skipped || stableStringify(normalized.record) !== line) {
      throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { line: index });
    }
    return normalized.record;
  } catch (error) {
    if (error instanceof RecoverySnapshotError && error.code.startsWith('SNAPSHOT_PREVIEW_')) {
      throw error;
    }
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', {
      line: index,
      cause: typeof error?.code === 'string' ? error.code : 'pair-record-invalid'
    });
  }
}

function normalizeSnapshotLedger(record, line, index, orgId) {
  const direction = typeof record.direction === 'string' ? record.direction : '';
  const sourceKey = typeof record.sourceKey === 'string' ? record.sourceKey : '';
  const suffix = typeof record.operationSuffix === 'string' ? record.operationSuffix : null;
  const base = `issue-create-op:${orgId}:${direction}:${encodeURIComponent(sourceKey)}`;
  const key = suffix === null ? base : `${base}:${encodeURIComponent(suffix)}`;

  try {
    const normalized = normalizeLedgerRecord(key, record, orgId);
    if (normalized.skipped || stableStringify(normalized.record) !== line) {
      throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { line: index });
    }
    return normalized.record;
  } catch (error) {
    if (error instanceof RecoverySnapshotError && error.code.startsWith('SNAPSHOT_PREVIEW_')) {
      throw error;
    }
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', {
      line: index,
      cause: typeof error?.code === 'string' ? error.code : 'ledger-record-invalid'
    });
  }
}

/** Builds the storage key the export would have read for a parsed record line. */
function snapshotRecordKey(section, record, orgId) {
  if (section === 'pairs') {
    return `mapping-meta:${orgId}:${typeof record.localKey === 'string' ? record.localKey : ''}`;
  }
  if (section === 'ledger') {
    const direction = typeof record.direction === 'string' ? record.direction : '';
    const sourceKey = typeof record.sourceKey === 'string' ? record.sourceKey : '';
    const base = `issue-create-op:${orgId}:${direction}:${encodeURIComponent(sourceKey)}`;
    return typeof record.operationSuffix === 'string'
      ? `${base}:${encodeURIComponent(record.operationSuffix)}`
      : base;
  }
  if (section === 'directions') {
    return record.direction === 'local-to-remote'
      ? `${orgId}:local-to-remote:${typeof record.localKey === 'string' ? record.localKey : ''}`
      : `${orgId}:remote-to-local:${typeof record.remoteKey === 'string' ? record.remoteKey : ''}`;
  }
  const localKey = typeof record.localKey === 'string' ? record.localKey : '';
  const remoteKey = typeof record.remoteKey === 'string' ? record.remoteKey : '';
  if (section === 'counterpartStatus') return `counterpart-status:${orgId}:${localKey}:${remoteKey}`;
  if (section === 'mappingEnded') return `mapping-ended:${orgId}:${localKey}:${remoteKey}`;
  if (section === 'mappingRepair') return `mapping-repair:${orgId}:${localKey}:${remoteKey}`;
  return null;
}

const EVIDENCE_NORMALIZERS = Object.freeze({
  directions: normalizeDirectionRecord,
  counterpartStatus: normalizeCounterpartStatusRecord,
  mappingEnded: normalizeMappingEndedRecord,
  mappingRepair: normalizeMappingRepairRecord
});

/**
 * Normalizes one record line through the export's own normalizer and requires
 * the line to be byte-identical to the canonical record. A file that carries an
 * added, removed or renamed field is refused instead of being interpreted.
 */
function normalizeSnapshotRecord(section, record, line, index, orgId) {
  if (section === 'pairs') return normalizeSnapshotPair(record, line, index, orgId);
  if (section === 'ledger') return normalizeSnapshotLedger(record, line, index, orgId);

  const normalize = EVIDENCE_NORMALIZERS[section];
  const key = snapshotRecordKey(section, record, orgId);
  if (!normalize || key === null) {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { line: index, reason: 'unknown-section' });
  }
  const value = section === 'directions'
    ? (record.direction === 'local-to-remote' ? record.remoteKey : record.localKey)
    : record;
  try {
    const normalized = normalize(key, value, orgId);
    if (normalized.skipped || stableStringify(normalized.record) !== line) {
      throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { line: index });
    }
    return normalized.record;
  } catch (error) {
    if (error instanceof RecoverySnapshotError && error.code.startsWith('SNAPSHOT_PREVIEW_')) {
      throw error;
    }
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', {
      line: index,
      cause: typeof error?.code === 'string' ? error.code : 'evidence-record-invalid'
    });
  }
}

function snapshotSectionIdentity(section, record) {
  if (section === 'pairs') return record.localKey;
  if (section === 'ledger') return ledgerIdentity(record);
  if (section === 'directions') {
    return `${record.direction}\u0000${record.localKey}\u0000${record.remoteKey}`;
  }
  return `${record.localKey}\u0000${record.remoteKey}`;
}

/**
 * Parses and fully validates uploaded snapshot text without reading storage.
 *
 * Validation order is deliberate: budget, line framing, whole-file checksum,
 * header/footer, per-section checksums, counts, then every record through the
 * export's own normalizer. Any failure aborts the whole preview.
 *
 * @param {string} content NDJSON snapshot text
 * @returns {object} parsed snapshot
 */
export function parseRecoverySnapshotContent(content) {
  if (typeof content !== 'string' || content.trim() === '') {
    throw previewError('SNAPSHOT_PREVIEW_EMPTY');
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw previewError('SNAPSHOT_PREVIEW_TOO_LARGE', { bytes });
  }
  if (content.includes('\r')) {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { reason: 'line-endings' });
  }
  if (!content.endsWith('\n')) {
    throw previewError('SNAPSHOT_PREVIEW_TRUNCATED', { reason: 'unterminated-final-line' });
  }

  const lines = content.slice(0, -1).split('\n');
  if (lines.length < 3) {
    throw previewError('SNAPSHOT_PREVIEW_TRUNCATED', { lines: lines.length });
  }
  if (lines.some((line) => line.trim() === '')) {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { reason: 'blank-line' });
  }
  const maxLines = RECOVERY_SNAPSHOT_SECTIONS
    .reduce((sum, name) => sum + sectionRecordLimit(name), 0) + 3;
  if (lines.length > maxLines) {
    throw previewError('SNAPSHOT_PREVIEW_TOO_LARGE', { lines: lines.length });
  }

  const verification = verifySnapshotContent(content);
  if (!verification.valid) {
    throw previewError(
      verification.declared
        ? 'SNAPSHOT_PREVIEW_CHECKSUM_MISMATCH'
        : 'SNAPSHOT_PREVIEW_TRUNCATED',
      { lines: verification.lines }
    );
  }

  const header = readHeader(parseSnapshotLine(lines[0], 0));

  const counts = parseSnapshotLine(lines[lines.length - 2], lines.length - 2);
  const countKeys = header.formatVersion === RECOVERY_SNAPSHOT_VERSION_V1
    ? ['pairs', 'ledger']
    : RECOVERY_SNAPSHOT_SECTIONS;
  if (!isPlainObject(counts) || counts.kind !== 'counts'
    || countKeys.some((name) => !Number.isInteger(counts[name]) || counts[name] < 0)
    || !Number.isInteger(counts.total) || counts.total < 0
    || !Number.isInteger(counts.skipped?.ledgerRetryClaims)
    || counts.skipped.ledgerRetryClaims < 0) {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: 'counts' });
  }

  const footer = parseSnapshotLine(lines[lines.length - 1], lines.length - 1);
  if (!isPlainObject(footer) || footer.kind !== 'footer'
    || footer.format !== RECOVERY_SNAPSHOT_FORMAT
    || footer.formatVersion !== header.formatVersion
    || footer.checksumScope !== 'header,records,counts'
    || !isPlainObject(footer.sectionChecksums)) {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: 'footer' });
  }

  const sectionRecords = Object.fromEntries(header.expectedSections.map((name) => [name, []]));
  const sectionLines = Object.fromEntries(header.expectedSections.map((name) => [name, []]));
  const seenIdentities = Object.fromEntries(
    header.expectedSections.map((name) => [name, new Set()])
  );
  const recordLines = lines.slice(1, lines.length - 2);

  for (let index = 0; index < recordLines.length; index += 1) {
    const lineNumber = index + 1;
    const line = recordLines[index];
    const record = parseSnapshotLine(line, lineNumber);
    if (!isPlainObject(record) || record.kind !== 'record') {
      throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { line: lineNumber });
    }

    const section = record.section;
    if (typeof section !== 'string' || !header.expectedSections.includes(section)) {
      throw previewError('SNAPSHOT_PREVIEW_MALFORMED', {
        line: lineNumber,
        reason: 'unknown-section'
      });
    }

    const normalized = normalizeSnapshotRecord(section, record, line, lineNumber, header.orgId);
    const identity = snapshotSectionIdentity(section, normalized);
    if (seenIdentities[section].has(identity)) {
      throw previewError('SNAPSHOT_PREVIEW_MALFORMED', {
        line: lineNumber,
        reason: `duplicate-${section}`
      });
    }
    seenIdentities[section].add(identity);
    sectionRecords[section].push(normalized);
    sectionLines[section].push(line);
    if (sectionRecords[section].length > sectionRecordLimit(section)) {
      throw previewError('SNAPSHOT_PREVIEW_TOO_LARGE', { section });
    }
  }

  const sectionDigests = Object.fromEntries(
    header.expectedSections.map((name) => [name, digestLines(sectionLines[name])])
  );
  for (const name of header.expectedSections) {
    const entry = header.sections.get(name);
    if (!entry
      || entry.count !== sectionRecords[name].length
      || entry.checksum !== sectionDigests[name]) {
      throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { reason: 'section-manifest-mismatch' });
    }
    if (footer.sectionChecksums[name] !== sectionDigests[name]) {
      throw previewError('SNAPSHOT_PREVIEW_MALFORMED', {
        reason: 'footer-section-checksum-mismatch'
      });
    }
    if (counts[name] !== sectionRecords[name].length) {
      throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { reason: 'counts-mismatch' });
    }
  }
  const totalRecords = header.expectedSections
    .reduce((sum, name) => sum + sectionRecords[name].length, 0);
  if (counts.total !== totalRecords) {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { reason: 'counts-mismatch' });
  }

  return {
    orgId: header.orgId,
    formatVersion: header.formatVersion,
    identity: header.identity,
    organization: header.organization,
    pause: header.pause,
    exportedAt: header.exportedAt,
    pairs: sectionRecords.pairs,
    ledger: sectionRecords.ledger,
    directions: sectionRecords.directions || [],
    counterpartStatus: sectionRecords.counterpartStatus || [],
    mappingEnded: sectionRecords.mappingEnded || [],
    mappingRepair: sectionRecords.mappingRepair || [],
    counts: {
      pairs: counts.pairs,
      ledger: counts.ledger,
      directions: counts.directions ?? 0,
      counterpartStatus: counts.counterpartStatus ?? 0,
      mappingEnded: counts.mappingEnded ?? 0,
      mappingRepair: counts.mappingRepair ?? 0,
      total: counts.total,
      skippedRetryClaims: counts.skipped.ledgerRetryClaims
    },
    checksum: verification.declared,
    bytes,
    lineCount: lines.length
  };
}

const IDENTITY_FIELDS = Object.freeze([
  'appId',
  'appAri',
  'environmentId',
  'environmentType',
  'installationId',
  'siteHost'
]);

/**
 * Classifies a snapshot against the current installation identity.
 *
 * A different app or a different Jira site cannot be compared at all and is
 * rejected. The same app on the same site with a different installation or
 * environment is reported as a cross-installation preview: the records are not
 * restorable here, so the summary never counts them as restorable.
 */
function compareIdentity(snapshotIdentity, currentIdentity) {
  const snapshotClouds = snapshotIdentity.cloudIds;
  const currentClouds = sortedUniqueStrings(currentIdentity.cloudIds);
  const differences = IDENTITY_FIELDS
    .filter((field) => snapshotIdentity[field] !== currentIdentity[field]);
  if (stableStringify(snapshotClouds) !== stableStringify(currentClouds)) {
    differences.push('cloudIds');
  }

  if (snapshotIdentity.appId !== currentIdentity.appId
    || snapshotIdentity.appAri !== currentIdentity.appAri) {
    return { classification: null, rejection: 'SNAPSHOT_PREVIEW_DIFFERENT_APP', differences };
  }
  if (snapshotIdentity.siteHost !== currentIdentity.siteHost
    || snapshotClouds.some((cloudId) => !currentClouds.includes(cloudId))) {
    return { classification: null, rejection: 'SNAPSHOT_PREVIEW_DIFFERENT_SITE', differences };
  }

  const sameInstallation = snapshotIdentity.installationId === currentIdentity.installationId
    && snapshotIdentity.environmentId === currentIdentity.environmentId;

  return {
    classification: sameInstallation
      ? PREVIEW_IDENTITY_CLASSES.SAME_INSTALLATION
      : PREVIEW_IDENTITY_CLASSES.DIFFERENT_INSTALLATION,
    rejection: null,
    differences
  };
}

/**
 * Compares the snapshot's organization routing with the selected organization.
 * A different remote host or remote project changes what the pair identities
 * mean, so those two fields block the preview. Allowed projects and direction
 * are reported as differences only.
 */
function compareOrganization(snapshotOrganization, currentOrganization) {
  const differences = [];
  if (snapshotOrganization.remoteHost !== currentOrganization.remoteHost) {
    differences.push('remoteHost');
  }
  if (snapshotOrganization.remoteProjectKey !== currentOrganization.remoteProjectKey) {
    differences.push('remoteProjectKey');
  }
  if (stableStringify(snapshotOrganization.allowedProjects)
    !== stableStringify(currentOrganization.allowedProjects)) {
    differences.push('allowedProjects');
  }
  if (snapshotOrganization.syncDirection !== currentOrganization.syncDirection) {
    differences.push('syncDirection');
  }
  return {
    differences,
    blocking: differences.filter((field) => field === 'remoteHost' || field === 'remoteProjectKey')
  };
}

async function readPause(deps) {
  try {
    const state = await deps.getPilotPause();
    return {
      paused: state?.paused === true,
      pausedAt: typeof state?.pausedAt === 'string' ? state.pausedAt : null,
      reasonCode: typeof state?.reasonCode === 'string' ? state.reasonCode : null
    };
  } catch {
    throw previewError('SNAPSHOT_PAUSE_UNREADABLE');
  }
}

async function readLiveSection(orgId, section, deps) {
  try {
    return await readStoredSection({ orgId, section, deps });
  } catch (error) {
    if (error?.code === 'SNAPSHOT_TOO_LARGE') {
      throw previewError('SNAPSHOT_PREVIEW_TOO_LARGE', { section });
    }
    throw previewError('SNAPSHOT_PREVIEW_STORAGE_UNAVAILABLE', {
      section,
      cause: typeof error?.code === 'string' ? error.code : 'unknown'
    });
  }
}

function parseScopedPairKey(key, prefix) {
  const parts = key.slice(prefix.length).split(':');
  if (parts.length !== 2) return null;
  const [localKey, remoteKey] = parts;
  if (!isValidIssueKey(localKey) || !isValidIssueKey(remoteKey)) return null;
  return { localKey, remoteKey };
}

/**
 * Walks a prefix that is not part of the exported sections (ended mappings,
 * repair markers, counterpart status). The same completeness rules apply: a
 * page that cannot be read, a repeated page, a stalled cursor or a duplicated
 * key fails the preview instead of producing a short blocking set.
 */
async function scanPrefix(prefix, deps) {
  const entries = [];
  const seenKeys = new Set();
  const seenPages = new Set();
  let cursor = null;
  let pages = 0;

  for (;;) {
    if (pages >= MAX_SECTION_PAGES) {
      throw previewError('SNAPSHOT_PREVIEW_TOO_LARGE', {
        section: 'blocking-records',
        pages
      });
    }
    pages += 1;

    let page;
    try {
      page = await deps.queryPage(prefix, { cursor, limit: SNAPSHOT_PAGE_SIZE });
    } catch {
      throw previewError('SNAPSHOT_PREVIEW_STORAGE_UNAVAILABLE', {
        section: 'blocking-records'
      });
    }
    if (!page || !Array.isArray(page.records)) {
      throw previewError('SNAPSHOT_PREVIEW_STORAGE_UNAVAILABLE', {
        section: 'blocking-records',
        cause: 'malformed-page'
      });
    }

    const signature = page.records
      .map((entry) => `${entry?.key}:${stableStringify(entry?.value)}`)
      .join('\u0001');
    if (seenPages.has(signature)) {
      throw previewError('SNAPSHOT_PREVIEW_STORAGE_UNAVAILABLE', {
        section: 'blocking-records',
        cause: 'repeated-page'
      });
    }
    seenPages.add(signature);

    if (page.records.length === 0 && page.nextCursor) {
      throw previewError('SNAPSHOT_PREVIEW_STORAGE_UNAVAILABLE', {
        section: 'blocking-records',
        cause: 'empty-page-with-cursor'
      });
    }

    for (const entry of page.records) {
      if (!entry || typeof entry.key !== 'string' || entry.key.length === 0) {
        throw previewError('SNAPSHOT_PREVIEW_STORAGE_UNAVAILABLE', {
          section: 'blocking-records',
          cause: 'missing-key'
        });
      }
      if (seenKeys.has(entry.key)) {
        throw previewError('SNAPSHOT_PREVIEW_STORAGE_UNAVAILABLE', {
          section: 'blocking-records',
          cause: 'duplicate-key'
        });
      }
      seenKeys.add(entry.key);
      entries.push(entry);
      if (entries.length > MAX_SECTION_RECORDS) {
        throw previewError('SNAPSHOT_PREVIEW_TOO_LARGE', { section: 'blocking-records' });
      }
    }

    cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
    if (!cursor) break;
  }

  return entries;
}

/**
 * Collects the existing records that make a missing pair unsafe to describe as
 * restorable: an administrator-ended mapping, a partial-write repair marker, or
 * a deleted-counterpart record. Nothing here is modified or resolved.
 */
async function readBlockingRecords(orgId, deps) {
  const blocking = new Map();
  const counters = {
    mappingEnded: 0,
    mappingRepair: 0,
    counterpartStatus: 0,
    unattributed: 0
  };

  const endedPrefix = `mapping-ended:${orgId}:`;
  for (const entry of await scanPrefix(endedPrefix, deps)) {
    const parsed = parseScopedPairKey(entry.key, endedPrefix);
    if (!parsed) {
      counters.unattributed += 1;
      continue;
    }
    counters.mappingEnded += 1;
    blocking.set(pairKey(parsed.localKey, parsed.remoteKey), PREVIEW_BLOCKER_REASONS.MAPPING_ENDED);
  }

  const repairPrefix = `mapping-repair:${orgId}:`;
  for (const entry of await scanPrefix(repairPrefix, deps)) {
    const parsed = parseScopedPairKey(entry.key, repairPrefix);
    if (!parsed) {
      counters.unattributed += 1;
      continue;
    }
    counters.mappingRepair += 1;
    const key = pairKey(parsed.localKey, parsed.remoteKey);
    if (!blocking.has(key)) {
      blocking.set(key, PREVIEW_BLOCKER_REASONS.MAPPING_REPAIR);
    }
  }

  const statusPrefix = `counterpart-status:${orgId}:`;
  for (const entry of await scanPrefix(statusPrefix, deps)) {
    const parsed = parseScopedPairKey(entry.key, statusPrefix);
    if (!parsed) {
      counters.unattributed += 1;
      continue;
    }
    counters.counterpartStatus += 1;
    const key = pairKey(parsed.localKey, parsed.remoteKey);
    if (blocking.has(key)) continue;

    const value = entry.value;
    if (!isPlainObject(value) || typeof value.state !== 'string') {
      blocking.set(key, PREVIEW_BLOCKER_REASONS.COUNTERPART_UNREADABLE);
      continue;
    }
    if (value.state === 'ended' || value.state === 'replaced') {
      blocking.set(key, PREVIEW_BLOCKER_REASONS.COUNTERPART_ARCHIVED);
      continue;
    }
    if (counterpartStatusBlocksSync(value, { hasMapping: false }).blocked) {
      blocking.set(key, PREVIEW_BLOCKER_REASONS.COUNTERPART_DELETED);
    }
  }

  return { blocking, counters };
}


function pushSample(list, entry) {
  if (list.length < PREVIEW_SAMPLE_LIMIT) {
    list.push(entry);
  }
}

function pairClassCounts(includeDirectional) {
  const counts = {
    [PREVIEW_PAIR_CLASSES.PRESENT]: 0,
    [PREVIEW_PAIR_CLASSES.MISSING]: 0,
    [PREVIEW_PAIR_CLASSES.CONFLICTING]: 0,
    [PREVIEW_PAIR_CLASSES.BLOCKED]: 0
  };
  if (includeDirectional) {
    counts[PREVIEW_PAIR_CLASSES.INCOMPLETE_DIRECTIONAL] = 0;
  }
  return counts;
}

/**
 * Indexes the directed lookup records so a pair can be resolved the way
 * synchronization resolves it: `local-to-remote:<local>` and
 * `remote-to-local:<remote>`, never the metadata index alone.
 */
function indexDirections(records) {
  const localToRemote = new Map();
  const remoteToLocal = new Map();
  for (const record of records || []) {
    if (record.direction === 'local-to-remote') {
      if (!localToRemote.has(record.localKey)) {
        localToRemote.set(record.localKey, record.remoteKey);
      }
    } else if (!remoteToLocal.has(record.remoteKey)) {
      remoteToLocal.set(record.remoteKey, record.localKey);
    }
  }
  return { localToRemote, remoteToLocal };
}

/**
 * A pair is directionally complete only when both lookups resolve to exactly
 * that pair. `absent` means neither lookup exists, `partial` means exactly one
 * exists, and `conflicting` means a lookup resolves to a different issue.
 */
function directionState(directions, localKey, remoteKey) {
  const forward = directions.localToRemote.get(localKey);
  const backward = directions.remoteToLocal.get(remoteKey);
  if (forward === remoteKey && backward === localKey) return 'complete';
  if (forward === undefined && backward === undefined) return 'absent';
  if (forward !== undefined && forward !== remoteKey) return 'conflicting';
  if (backward !== undefined && backward !== localKey) return 'conflicting';
  return 'partial';
}

/**
 * Classifies every exported pair against the live mapping-meta index.
 *
 * A stored pair with the same remote key is consistent. A stored pair with a
 * different remote key, or a remote key already claimed by another local key, is
 * conflicting. A pair that is absent is blocked when an ended, repair or
 * deleted-counterpart record exists for exactly that pair; otherwise it is
 * missing and potentially restorable.
 */
function classifyPairs({ snapshotPairs, livePairs, blocking, liveDirections = null }) {
  const hasDirections = liveDirections !== null && liveDirections !== undefined;
  const counts = pairClassCounts(hasDirections);
  const samples = { missing: [], conflicting: [], blocked: [] };
  if (hasDirections) samples.incomplete = [];
  const missingPairs = [];
  const liveByLocal = new Map();
  const liveByRemote = new Map();

  for (const record of livePairs) {
    liveByLocal.set(record.localKey, record);
    if (!liveByRemote.has(record.remoteKey)) {
      liveByRemote.set(record.remoteKey, record.localKey);
    }
  }

  for (const pair of snapshotPairs) {
    const live = liveByLocal.get(pair.localKey);
    const state = hasDirections
      ? directionState(liveDirections, pair.localKey, pair.remoteKey)
      : null;

    if (live) {
      if (live.remoteKey === pair.remoteKey) {
        if (!hasDirections || state === 'complete') {
          counts[PREVIEW_PAIR_CLASSES.PRESENT] += 1;
          continue;
        }
        if (state === 'conflicting') {
          counts[PREVIEW_PAIR_CLASSES.CONFLICTING] += 1;
          pushSample(samples.conflicting, {
            classification: PREVIEW_PAIR_CLASSES.CONFLICTING,
            localKey: pair.localKey,
            remoteKey: pair.remoteKey,
            reason: PREVIEW_CONFLICT_REASONS.DIRECTED_MAPPING_DIFFERS
          });
          continue;
        }
        counts[PREVIEW_PAIR_CLASSES.INCOMPLETE_DIRECTIONAL] += 1;
        pushSample(samples.incomplete, {
          classification: PREVIEW_PAIR_CLASSES.INCOMPLETE_DIRECTIONAL,
          localKey: pair.localKey,
          remoteKey: pair.remoteKey,
          directionalState: state
        });
        continue;
      }
      counts[PREVIEW_PAIR_CLASSES.CONFLICTING] += 1;
      pushSample(samples.conflicting, {
        classification: PREVIEW_PAIR_CLASSES.CONFLICTING,
        localKey: pair.localKey,
        remoteKey: pair.remoteKey,
        liveRemoteKey: live.remoteKey,
        reason: PREVIEW_CONFLICT_REASONS.REMOTE_KEY_DIFFERS
      });
      continue;
    }

    const blocker = blocking ? blocking.get(pairKey(pair.localKey, pair.remoteKey)) : null;
    if (blocker) {
      counts[PREVIEW_PAIR_CLASSES.BLOCKED] += 1;
      pushSample(samples.blocked, {
        classification: PREVIEW_PAIR_CLASSES.BLOCKED,
        localKey: pair.localKey,
        remoteKey: pair.remoteKey,
        reason: blocker
      });
      continue;
    }

    const claimant = liveByRemote.get(pair.remoteKey);
    if (claimant && claimant !== pair.localKey) {
      counts[PREVIEW_PAIR_CLASSES.CONFLICTING] += 1;
      pushSample(samples.conflicting, {
        classification: PREVIEW_PAIR_CLASSES.CONFLICTING,
        localKey: pair.localKey,
        remoteKey: pair.remoteKey,
        liveLocalKey: claimant,
        reason: PREVIEW_CONFLICT_REASONS.REMOTE_KEY_ALREADY_MAPPED
      });
      continue;
    }

    if (hasDirections && state === 'conflicting') {
      counts[PREVIEW_PAIR_CLASSES.CONFLICTING] += 1;
      pushSample(samples.conflicting, {
        classification: PREVIEW_PAIR_CLASSES.CONFLICTING,
        localKey: pair.localKey,
        remoteKey: pair.remoteKey,
        reason: PREVIEW_CONFLICT_REASONS.DIRECTED_MAPPING_DIFFERS
      });
      continue;
    }

    if (hasDirections && state === 'partial') {
      counts[PREVIEW_PAIR_CLASSES.INCOMPLETE_DIRECTIONAL] += 1;
      pushSample(samples.incomplete, {
        classification: PREVIEW_PAIR_CLASSES.INCOMPLETE_DIRECTIONAL,
        localKey: pair.localKey,
        remoteKey: pair.remoteKey,
        directionalState: state
      });
      continue;
    }

    counts[PREVIEW_PAIR_CLASSES.MISSING] += 1;
    missingPairs.push(pair);
    pushSample(samples.missing, {
      classification: PREVIEW_PAIR_CLASSES.MISSING,
      localKey: pair.localKey,
      remoteKey: pair.remoteKey,
      reason: null,
      directionalState: state
    });
  }

  return { counts, samples, missingPairs };
}

/**
 * A succeeded ledger row is only consistent if the pair it names points at the
 * same target. A description or summary is never consulted for this.
 */
function ledgerPairConflict(record, pairsByLocal, pairsByRemote) {
  if (record.state !== ISSUE_CREATE_STATES.SUCCEEDED || !record.targetKey) {
    return null;
  }
  if (record.direction === ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE) {
    const pair = pairsByLocal.get(record.sourceKey);
    return pair && pair.remoteKey !== record.targetKey
      ? { reason: PREVIEW_CONFLICT_REASONS.LEDGER_TARGET_DIFFERS, pairRemoteKey: pair.remoteKey }
      : null;
  }
  if (record.direction === ISSUE_CREATE_DIRECTIONS.REMOTE_TO_LOCAL) {
    const pair = pairsByRemote.get(record.sourceKey);
    return pair && pair.localKey !== record.targetKey
      ? { reason: PREVIEW_CONFLICT_REASONS.LEDGER_TARGET_DIFFERS, pairLocalKey: pair.localKey }
      : null;
  }
  return null;
}

/**
 * Compares every exported ledger row key-by-key with live storage and with the
 * exported pair index. A live row that differs is reported as a conflict and is
 * never resolved; a missing row is evidence only.
 */
function classifyLedger({ snapshotLedger, liveLedger, snapshotPairs }) {
  const counts = {
    [PREVIEW_LEDGER_CLASSES.PRESENT]: 0,
    [PREVIEW_LEDGER_CLASSES.MISSING]: 0,
    [PREVIEW_LEDGER_CLASSES.CONFLICTING]: 0
  };
  const samples = { missing: [], conflicting: [] };
  const missingRecords = [];
  const conflictingRecords = [];
  const liveByIdentity = new Map();
  const pairsByLocal = new Map();
  const pairsByRemote = new Map();

  for (const record of liveLedger) {
    liveByIdentity.set(ledgerIdentity(record), record);
  }
  for (const pair of snapshotPairs) {
    pairsByLocal.set(pair.localKey, pair);
    pairsByRemote.set(pair.remoteKey, pair);
  }

  for (const record of snapshotLedger) {
    const live = liveByIdentity.get(ledgerIdentity(record));
    const summary = {
      direction: record.direction,
      sourceKey: record.sourceKey,
      operationSuffix: record.operationSuffix,
      state: record.state
    };
    const internal = ledgerPairConflict(record, pairsByLocal, pairsByRemote);

    if (!live) {
      if (internal) {
        counts[PREVIEW_LEDGER_CLASSES.CONFLICTING] += 1;
        conflictingRecords.push(record);
        pushSample(samples.conflicting, {
          ...summary,
          classification: PREVIEW_LEDGER_CLASSES.CONFLICTING,
          liveState: null,
          ...internal
        });
      } else {
        counts[PREVIEW_LEDGER_CLASSES.MISSING] += 1;
        missingRecords.push(record);
        pushSample(samples.missing, {
          ...summary,
          classification: PREVIEW_LEDGER_CLASSES.MISSING
        });
      }
      continue;
    }

    if (stableStringify(live) !== stableStringify(record)) {
      counts[PREVIEW_LEDGER_CLASSES.CONFLICTING] += 1;
      conflictingRecords.push(record);
      pushSample(samples.conflicting, {
        ...summary,
        classification: PREVIEW_LEDGER_CLASSES.CONFLICTING,
        liveState: live.state,
        reason: PREVIEW_CONFLICT_REASONS.LEDGER_STATE_DIFFERS
      });
      continue;
    }

    if (internal) {
      counts[PREVIEW_LEDGER_CLASSES.CONFLICTING] += 1;
      conflictingRecords.push(record);
      pushSample(samples.conflicting, {
        ...summary,
        classification: PREVIEW_LEDGER_CLASSES.CONFLICTING,
        liveState: live.state,
        ...internal
      });
      continue;
    }

    counts[PREVIEW_LEDGER_CLASSES.PRESENT] += 1;
  }

  return { counts, samples, missingRecords, conflictingRecords };
}


/**
 * Indexes the evidence a version 2 file carries. Pairing intent lives in these
 * records, so a restore must consult them before it may re-create a mapping: an
 * ended pair, a repair marker or a deleted counterpart must never be revived by
 * restoring an older file over a newer decision.
 */
function buildFileEvidence(snapshot) {
  const ended = new Map();
  const repaired = new Map();
  const counterpart = new Map();
  for (const record of snapshot.mappingEnded || []) {
    ended.set(pairKey(record.localKey, record.remoteKey), record);
  }
  for (const record of snapshot.mappingRepair || []) {
    repaired.set(pairKey(record.localKey, record.remoteKey), record);
  }
  for (const record of snapshot.counterpartStatus || []) {
    counterpart.set(pairKey(record.localKey, record.remoteKey), record);
  }

  const counterpartReason = (record) => {
    if (!record) return null;
    if (record.state === 'ended' || record.state === 'replaced') {
      return PREVIEW_BLOCKER_REASONS.COUNTERPART_ARCHIVED;
    }
    return counterpartStatusBlocksSync(record, { hasMapping: false }).blocked
      ? PREVIEW_BLOCKER_REASONS.COUNTERPART_DELETED
      : null;
  };

  return {
    ended,
    repaired,
    counterpart,
    reasonFor(localKey, remoteKey) {
      const key = pairKey(localKey, remoteKey);
      if (ended.has(key)) return PREVIEW_BLOCKER_REASONS.MAPPING_ENDED;
      if (repaired.has(key)) return PREVIEW_BLOCKER_REASONS.MAPPING_REPAIR;
      return counterpartReason(counterpart.get(key));
    }
  };
}

/**
 * Summarizes the directional evidence the file itself carries, so an incomplete
 * or self-contradictory export is detectable before anything is labelled
 * recoverable.
 */
function buildSnapshotDirectionReport(snapshot) {
  const directions = indexDirections(snapshot.directions);
  const pairKeys = new Set((snapshot.pairs || []).map((pair) => pairKey(pair.localKey, pair.remoteKey)));
  const conflicting = new Set();
  const incomplete = new Set();
  const orphans = [];

  for (const pair of snapshot.pairs || []) {
    const key = pairKey(pair.localKey, pair.remoteKey);
    const state = directionState(directions, pair.localKey, pair.remoteKey);
    if (state === 'conflicting') conflicting.add(key);
    else if (state !== 'complete') incomplete.add(key);
  }

  for (const record of snapshot.directions || []) {
    const key = pairKey(record.localKey, record.remoteKey);
    const mirrored = record.direction === 'local-to-remote'
      ? directions.remoteToLocal.get(record.remoteKey)
      : directions.localToRemote.get(record.localKey);
    if (mirrored !== undefined && mirrored !== (record.direction === 'local-to-remote'
      ? record.localKey
      : record.remoteKey)) {
      conflicting.add(key);
    }
    if (!pairKeys.has(key)) {
      orphans.push(record);
      if (record.direction === 'local-to-remote'
        ? directions.remoteToLocal.get(record.remoteKey) !== record.localKey
        : directions.localToRemote.get(record.localKey) !== record.remoteKey) {
        incomplete.add(key);
      }
    }
  }

  return {
    directions,
    incompletePairs: incomplete.size,
    conflictingPairs: conflicting.size,
    orphanDirections: orphans.length
  };
}

/** Evidence that contradicts itself, so the file cannot be called recoverable. */
function buildEvidenceConflicts(snapshot, directionReport) {
  const evidence = buildFileEvidence(snapshot);
  const conflicts = [];
  for (const ended of evidence.ended.values()) {
    const key = pairKey(ended.localKey, ended.remoteKey);
    const status = evidence.counterpart.get(key);
    if (status && status.state === 'active') {
      conflicts.push({
        localKey: ended.localKey,
        remoteKey: ended.remoteKey,
        reason: 'ended-with-active-counterpart'
      });
    }
  }
  for (const repair of evidence.repaired.values()) {
    const state = directionReport.directions.localToRemote.get(repair.localKey) === repair.remoteKey
      && directionReport.directions.remoteToLocal.get(repair.remoteKey) === repair.localKey;
    if (state) {
      conflicts.push({
        localKey: repair.localKey,
        remoteKey: repair.remoteKey,
        reason: 'repair-with-complete-directions'
      });
    }
  }
  return conflicts;
}

const defaultDeps = {
  queryPage: (prefix, options) => kvsStore.queryPageByPrefix(prefix, options),
  getStored: (key) => kvsStore.get(key),
  getPilotPause,
  readIdentity: () => readForgeInstallationIdentity(),
  now: () => Date.now()
};

/**
 * Compares an uploaded recovery snapshot with current storage, read-only.
 *
 * @param {{orgId: string, content: string, deps?: object}} options
 * @returns {Promise<object>} classification result; rejects with
 *   RecoverySnapshotError when the file, identity, routing or pause is unusable
 */
export async function previewRestoreSnapshot(options = {}) {
  const deps = { ...defaultDeps, ...(options.deps || {}) };
  const orgId = normalizeSnapshotOrgId(options.orgId);
  const snapshot = parseRecoverySnapshotContent(options.content);

  if (snapshot.orgId !== orgId) {
    throw previewError('SNAPSHOT_PREVIEW_ORGANIZATION_MISMATCH', {
      snapshotOrgId: snapshot.orgId,
      requestedOrgId: orgId
    });
  }

  const pause = await readPause(deps);
  if (!pause.paused) {
    throw previewError('SNAPSHOT_REQUIRES_PAUSE');
  }

  const currentOrganization = await readOrganizationScope(orgId, deps);
  const routing = compareOrganization(snapshot.organization, currentOrganization);
  if (routing.blocking.length > 0) {
    throw previewError('SNAPSHOT_PREVIEW_ROUTING_MISMATCH', { fields: routing.blocking });
  }

  let currentIdentity = null;
  try {
    currentIdentity = await deps.readIdentity();
  } catch {
    currentIdentity = null;
  }
  if (!currentIdentity || currentIdentity.readable !== true) {
    throw previewError('SNAPSHOT_IDENTITY_UNAVAILABLE', {
      cause: typeof currentIdentity?.code === 'string' ? currentIdentity.code : 'identity-unreadable'
    });
  }

  const identityCheck = compareIdentity(snapshot.identity, currentIdentity);
  if (identityCheck.rejection) {
    throw previewError(identityCheck.rejection, { fields: identityCheck.differences });
  }

  const hasEvidenceSections = snapshot.formatVersion >= 2;
  const livePairs = await readLiveSection(orgId, 'pairs', deps);
  const liveLedger = await readLiveSection(orgId, 'ledger', deps);
  const liveDirections = hasEvidenceSections
    ? indexDirections((await readLiveSection(orgId, 'directions', deps)).records)
    : null;
  const liveDirectionCount = liveDirections
    ? liveDirections.localToRemote.size + liveDirections.remoteToLocal.size
    : 0;

  const directionReport = hasEvidenceSections
    ? buildSnapshotDirectionReport(snapshot)
    : {
      directions: indexDirections([]),
      incompletePairs: 0,
      conflictingPairs: 0,
      orphanDirections: 0
    };
  const fileEvidence = hasEvidenceSections ? buildFileEvidence(snapshot) : null;
  const evidenceConflicts = hasEvidenceSections
    ? buildEvidenceConflicts(snapshot, directionReport)
    : [];

  // Evidence carried by the file always applies. Live blocking records are only
  // scanned when a pair is actually absent, so a fully consistent file stays
  // cheap; both sources feed a single blocker map.
  const fileBlocking = new Map();
  if (fileEvidence) {
    for (const pair of snapshot.pairs) {
      const reason = fileEvidence.reasonFor(pair.localKey, pair.remoteKey);
      if (reason) fileBlocking.set(pairKey(pair.localKey, pair.remoteKey), reason);
    }
  }

  let blocking = { blocking: new Map(fileBlocking), counters: null };
  let pairs = classifyPairs({
    snapshotPairs: snapshot.pairs,
    livePairs: livePairs.records,
    blocking: blocking.blocking,
    liveDirections
  });
  if (pairs.missingPairs.length > 0) {
    const liveBlocking = await readBlockingRecords(orgId, deps);
    const merged = new Map(liveBlocking.blocking);
    for (const [key, reason] of fileBlocking) {
      if (!merged.has(key)) merged.set(key, reason);
    }
    blocking = { blocking: merged, counters: liveBlocking.counters };
    pairs = classifyPairs({
      snapshotPairs: snapshot.pairs,
      livePairs: livePairs.records,
      blocking: merged,
      liveDirections
    });
  }

  const ledger = classifyLedger({
    snapshotLedger: snapshot.ledger,
    liveLedger: liveLedger.records,
    snapshotPairs: snapshot.pairs
  });

  const counterpartRecords = snapshot.counterpartStatus || [];
  const evidence = {
    available: hasEvidenceSections,
    ended: (snapshot.mappingEnded || []).length,
    repaired: (snapshot.mappingRepair || []).length,
    counterpartBlocking: counterpartRecords.filter((record) => (
      record.state !== 'ended'
      && record.state !== 'replaced'
      && counterpartStatusBlocksSync(record, { hasMapping: false }).blocked
    )).length,
    counterpartArchived: counterpartRecords.filter((record) =>
      record.state === 'ended' || record.state === 'replaced').length,
    directional: {
      records: directionReport.directions.localToRemote.size
        + directionReport.directions.remoteToLocal.size,
      incompletePairs: directionReport.incompletePairs,
      conflictingPairs: directionReport.conflictingPairs,
      orphanRecords: directionReport.orphanDirections
    },
    conflicting: evidenceConflicts
  };

  const crossInstallation = identityCheck.classification
    === PREVIEW_IDENTITY_CLASSES.DIFFERENT_INSTALLATION;

  const recoverabilityReasons = [];
  if (!hasEvidenceSections) {
    recoverabilityReasons.push(PREVIEW_RECOVERABILITY_REASONS.V1_INSUFFICIENT_EVIDENCE);
  }
  if (crossInstallation) {
    recoverabilityReasons.push(PREVIEW_RECOVERABILITY_REASONS.DIFFERENT_INSTALLATION);
  }
  if (hasEvidenceSections && directionReport.conflictingPairs > 0) {
    recoverabilityReasons.push(PREVIEW_RECOVERABILITY_REASONS.DIRECTIONAL_EVIDENCE_CONFLICTING);
  }
  if (hasEvidenceSections && directionReport.incompletePairs > 0) {
    recoverabilityReasons.push(PREVIEW_RECOVERABILITY_REASONS.DIRECTIONAL_EVIDENCE_INCOMPLETE);
  }
  if (hasEvidenceSections && evidenceConflicts.length > 0) {
    recoverabilityReasons.push(PREVIEW_RECOVERABILITY_REASONS.EVIDENCE_CONFLICTING);
  }
  const recoverability = {
    recoverable: recoverabilityReasons.length === 0,
    reasons: recoverabilityReasons
  };

  const limitations = [...PREVIEW_LIMITATIONS];
  if (!hasEvidenceSections) {
    limitations.push(
      'This is a version 1 snapshot. It carries no directed lookup, ended-mapping, '
      + 'repair or counterpart-status records, so it is insufficient for recovery '
      + 'after total storage loss and is reported as not recoverable.'
    );
  }
  if (crossInstallation) {
    limitations.push(
      'This file was exported from a different installation or environment of the same app. '
      + 'Its records are shown for comparison only and are not restorable in this installation.'
    );
  }

  const snapshotCounts = snapshot.formatVersion === RECOVERY_SNAPSHOT_VERSION_V1
    ? {
      pairs: snapshot.counts.pairs,
      ledger: snapshot.counts.ledger,
      total: snapshot.counts.total,
      skippedRetryClaims: snapshot.counts.skippedRetryClaims
    }
    : { ...snapshot.counts };
  const liveCounts = hasEvidenceSections
    ? {
      pairs: livePairs.count,
      ledger: liveLedger.count,
      directions: liveDirectionCount,
      skippedRetryClaims: liveLedger.skippedRetryClaims
    }
    : {
      pairs: livePairs.count,
      ledger: liveLedger.count,
      skippedRetryClaims: liveLedger.skippedRetryClaims
    };

  const candidatePairKeys = new Set(
    pairs.missingPairs.slice(0, RESTORE_CANDIDATE_LIMIT)
      .map((pair) => pairKey(pair.localKey, pair.remoteKey))
  );
  const missingLedgerForCandidates = ledger.missingRecords.filter((record) => {
    const pair = ledgerRestorePair(record);
    return pair && candidatePairKeys.has(pairKey(pair.localKey, pair.remoteKey));
  });
  const conflictingLedgerForCandidates = ledger.conflictingRecords.filter((record) => {
    const pair = ledgerRestorePair(record);
    return pair && candidatePairKeys.has(pairKey(pair.localKey, pair.remoteKey));
  });

  const allPairCandidates = pairs.missingPairs.map((pair) => ({
    localKey: pair.localKey,
    remoteKey: pair.remoteKey
  }));

  const restoreCandidates = {
    pairs: allPairCandidates.slice(0, RESTORE_CANDIDATE_LIMIT),
    ledger: missingLedgerForCandidates.slice(0, RESTORE_CANDIDATE_LIMIT * 2).map((record) => ({
      direction: record.direction,
      sourceKey: record.sourceKey,
      operationSuffix: record.operationSuffix,
      state: record.state,
      attempt: record.attempt,
      targetKey: record.targetKey,
      operationId: record.operationId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      unknownAt: record.unknownAt,
      failedAt: record.failedAt,
      failureReason: record.failureReason
    })),
    truncatedPairs: Math.max(0, pairs.missingPairs.length - RESTORE_CANDIDATE_LIMIT),
    truncatedLedger: Math.max(0, ledger.missingRecords.length - RESTORE_CANDIDATE_LIMIT * 2),
    conflictingLedger: conflictingLedgerForCandidates
      .slice(0, RESTORE_CANDIDATE_LIMIT * 2)
      .map((record) => ({
        direction: record.direction,
        sourceKey: record.sourceKey,
        operationSuffix: record.operationSuffix,
        state: record.state,
        targetKey: record.targetKey
      }))
  };
  if (pairs.missingPairs.length > RESTORE_CANDIDATE_LIMIT) {
    // The visible candidate window stays bounded, but the restore planner may
    // scan the complete ordered list so a window of excluded pairs cannot hide
    // a later restorable pair. The planner stores at most its own 200 items.
    restoreCandidates.allPairs = allPairCandidates;
  }

  return {
    success: true,
    readOnly: true,
    noWritesPerformed: true,
    format: RECOVERY_SNAPSHOT_FORMAT,
    formatVersion: snapshot.formatVersion,
    exportedAt: snapshot.exportedAt,
    checkedAt: new Date(deps.now()).toISOString(),
    bytes: snapshot.bytes,
    lineCount: snapshot.lineCount,
    checksum: {
      algorithm: 'sha256',
      declared: snapshot.checksum,
      scope: 'header,records,counts',
      verified: true
    },
    pause,
    identity: {
      classification: identityCheck.classification,
      crossInstallation,
      differences: identityCheck.differences,
      snapshot: snapshot.identity,
      current: {
        appId: currentIdentity.appId,
        appAri: currentIdentity.appAri,
        appVersion: typeof currentIdentity.appVersion === 'string'
          ? currentIdentity.appVersion
          : null,
        environmentId: currentIdentity.environmentId,
        environmentType: currentIdentity.environmentType,
        installationId: currentIdentity.installationId,
        siteHost: currentIdentity.siteHost,
        cloudIds: sortedUniqueStrings(currentIdentity.cloudIds)
      }
    },
    organization: {
      requested: orgId,
      snapshotId: snapshot.organization.id,
      match: routing.differences.length === 0,
      differences: routing.differences,
      snapshot: snapshot.organization,
      current: currentOrganization
    },
    counts: {
      snapshot: snapshotCounts,
      live: liveCounts,
      pairs: pairs.counts,
      ledger: ledger.counts,
      evidence,
      restorablePairs: crossInstallation ? 0 : pairs.counts[PREVIEW_PAIR_CLASSES.MISSING],
      blockingRecords: blocking.counters || {
        mappingEnded: 0,
        mappingRepair: 0,
        counterpartStatus: 0,
        unattributed: 0
      }
    },
    evidence: {
      available: hasEvidenceSections,
      ended: evidence.ended,
      repaired: evidence.repaired,
      counterpartBlocking: evidence.counterpartBlocking,
      counterpartArchived: evidence.counterpartArchived,
      directional: evidence.directional,
      conflicting: evidence.conflicting,
      samples: {
        ended: (snapshot.mappingEnded || []).slice(0, PREVIEW_SAMPLE_LIMIT),
        repaired: (snapshot.mappingRepair || []).slice(0, PREVIEW_SAMPLE_LIMIT),
        counterpart: (snapshot.counterpartStatus || []).slice(0, PREVIEW_SAMPLE_LIMIT)
      }
    },
    recoverability,
    samples: {
      pairs: pairs.samples,
      ledger: ledger.samples
    },
    restore: {
      candidateLimit: RESTORE_CANDIDATE_LIMIT,
      candidates: restoreCandidates,
      availablePairs: pairs.missingPairs.length,
      availableLedger: ledger.missingRecords.length
    },
    limitations
  };
}
