import * as kvsStore from '../storage/kvs.js';
import { getPilotPause } from './pilot-pause.js';
import { readForgeInstallationIdentity } from '../readiness/connector-readiness.js';
import {
  MAX_SECTION_PAGES,
  MAX_SECTION_RECORDS,
  MAX_SNAPSHOT_BYTES,
  RECOVERY_SNAPSHOT_FORMAT,
  RECOVERY_SNAPSHOT_VERSION,
  RecoverySnapshotError,
  SNAPSHOT_PAGE_SIZE,
  digestLines,
  normalizeLedgerRecord,
  normalizePairRecord,
  normalizeSnapshotOrgId,
  readOrganizationScope,
  readStoredSection,
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
  BLOCKED: 'blocked-by-existing-record'
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
  LEDGER_TARGET_DIFFERS: 'ledger-target-differs-from-pair',
  LEDGER_STATE_DIFFERS: 'ledger-state-differs'
});

export const PREVIEW_LIMITATIONS = Object.freeze([
  'The preview only compares records. It writes no mapping, ledger row, manifest or restore plan, and it changes no Jira issue.',
  'Pairing evidence is limited to the stored mapping-meta index. No issue description, summary or cross-reference text is read, so none of it is trusted as proof of a pairing.',
  'Live storage is read with one bounded cursor scan per section while the emergency pause holds; Forge storage offers no multi-key read transaction.',
  'Directed lookup records are not compared. A pair left half-written and repaired only through ensureMappingPair() is invisible to both the export and this preview.',
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
  if (header.formatVersion !== RECOVERY_SNAPSHOT_VERSION) {
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
  if (!Array.isArray(header.sections) || header.sections.length !== 2) {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: 'sections' });
  }
  for (const section of header.sections) {
    if (!isPlainObject(section) || (section.name !== 'pairs' && section.name !== 'ledger')) {
      throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: 'sections' });
    }
    if (!Number.isInteger(section.count) || section.count < 0
      || typeof section.checksum !== 'string' || !section.checksum.startsWith('sha256:')) {
      throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: `sections.${section.name}` });
    }
    if (manifest.has(section.name)) {
      throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: `sections.${section.name}` });
    }
    manifest.set(section.name, { count: section.count, checksum: section.checksum });
  }
  if (manifest.size !== 2) {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: 'sections' });
  }

  return {
    orgId,
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
  if (lines.length > (MAX_SECTION_RECORDS * 2) + 3) {
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
  if (!isPlainObject(counts) || counts.kind !== 'counts'
    || !Number.isInteger(counts.pairs) || counts.pairs < 0
    || !Number.isInteger(counts.ledger) || counts.ledger < 0
    || !Number.isInteger(counts.total) || counts.total < 0
    || !Number.isInteger(counts.skipped?.ledgerRetryClaims)
    || counts.skipped.ledgerRetryClaims < 0) {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: 'counts' });
  }

  const footer = parseSnapshotLine(lines[lines.length - 1], lines.length - 1);
  if (!isPlainObject(footer) || footer.kind !== 'footer'
    || footer.format !== RECOVERY_SNAPSHOT_FORMAT
    || footer.formatVersion !== RECOVERY_SNAPSHOT_VERSION
    || footer.checksumScope !== 'header,records,counts'
    || !isPlainObject(footer.sectionChecksums)) {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { field: 'footer' });
  }

  const pairs = [];
  const ledger = [];
  const pairKeys = new Set();
  const ledgerKeys = new Set();
  const pairLines = [];
  const ledgerLines = [];
  const recordLines = lines.slice(1, lines.length - 2);

  for (let index = 0; index < recordLines.length; index += 1) {
    const lineNumber = index + 1;
    const line = recordLines[index];
    const record = parseSnapshotLine(line, lineNumber);
    if (!isPlainObject(record) || record.kind !== 'record') {
      throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { line: lineNumber });
    }

    if (record.section === 'pairs') {
      const normalized = normalizeSnapshotPair(record, line, lineNumber, header.orgId);
      if (pairKeys.has(normalized.localKey)) {
        throw previewError('SNAPSHOT_PREVIEW_MALFORMED', {
          line: lineNumber,
          reason: 'duplicate-pair'
        });
      }
      pairKeys.add(normalized.localKey);
      pairs.push(normalized);
      pairLines.push(line);
      if (pairs.length > MAX_SECTION_RECORDS) {
        throw previewError('SNAPSHOT_PREVIEW_TOO_LARGE', { section: 'pairs' });
      }
      continue;
    }

    if (record.section === 'ledger') {
      const normalized = normalizeSnapshotLedger(record, line, lineNumber, header.orgId);
      const identity = ledgerIdentity(normalized);
      if (ledgerKeys.has(identity)) {
        throw previewError('SNAPSHOT_PREVIEW_MALFORMED', {
          line: lineNumber,
          reason: 'duplicate-ledger'
        });
      }
      ledgerKeys.add(identity);
      ledger.push(normalized);
      ledgerLines.push(line);
      if (ledger.length > MAX_SECTION_RECORDS) {
        throw previewError('SNAPSHOT_PREVIEW_TOO_LARGE', { section: 'ledger' });
      }
      continue;
    }

    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', {
      line: lineNumber,
      reason: 'unknown-section'
    });
  }

  const pairDigest = digestLines(pairLines);
  const ledgerDigest = digestLines(ledgerLines);
  const pairsManifest = header.sections.get('pairs');
  const ledgerManifest = header.sections.get('ledger');

  if (pairsManifest.count !== pairs.length || pairsManifest.checksum !== pairDigest
    || ledgerManifest.count !== ledger.length || ledgerManifest.checksum !== ledgerDigest) {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { reason: 'section-manifest-mismatch' });
  }
  if (footer.sectionChecksums.pairs !== pairDigest
    || footer.sectionChecksums.ledger !== ledgerDigest) {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', {
      reason: 'footer-section-checksum-mismatch'
    });
  }
  if (counts.pairs !== pairs.length
    || counts.ledger !== ledger.length
    || counts.total !== pairs.length + ledger.length) {
    throw previewError('SNAPSHOT_PREVIEW_MALFORMED', { reason: 'counts-mismatch' });
  }

  return {
    orgId: header.orgId,
    identity: header.identity,
    organization: header.organization,
    pause: header.pause,
    exportedAt: header.exportedAt,
    pairs,
    ledger,
    counts: {
      pairs: counts.pairs,
      ledger: counts.ledger,
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

function pairClassCounts() {
  return {
    [PREVIEW_PAIR_CLASSES.PRESENT]: 0,
    [PREVIEW_PAIR_CLASSES.MISSING]: 0,
    [PREVIEW_PAIR_CLASSES.CONFLICTING]: 0,
    [PREVIEW_PAIR_CLASSES.BLOCKED]: 0
  };
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
function classifyPairs({ snapshotPairs, livePairs, blocking }) {
  const counts = pairClassCounts();
  const samples = { missing: [], conflicting: [], blocked: [] };
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

    if (live) {
      if (live.remoteKey === pair.remoteKey) {
        counts[PREVIEW_PAIR_CLASSES.PRESENT] += 1;
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

    counts[PREVIEW_PAIR_CLASSES.MISSING] += 1;
    missingPairs.push(pair);
    pushSample(samples.missing, {
      classification: PREVIEW_PAIR_CLASSES.MISSING,
      localKey: pair.localKey,
      remoteKey: pair.remoteKey,
      reason: null
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
        pushSample(samples.conflicting, {
          ...summary,
          classification: PREVIEW_LEDGER_CLASSES.CONFLICTING,
          liveState: null,
          ...internal
        });
      } else {
        counts[PREVIEW_LEDGER_CLASSES.MISSING] += 1;
        pushSample(samples.missing, {
          ...summary,
          classification: PREVIEW_LEDGER_CLASSES.MISSING
        });
      }
      continue;
    }

    if (stableStringify(live) !== stableStringify(record)) {
      counts[PREVIEW_LEDGER_CLASSES.CONFLICTING] += 1;
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

  return { counts, samples };
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

  const livePairs = await readLiveSection(orgId, 'pairs', deps);
  const liveLedger = await readLiveSection(orgId, 'ledger', deps);

  // Blocking records are only read when at least one pair is actually absent.
  // A fully consistent file therefore costs two section scans and nothing else.
  let blocking = { blocking: new Map(), counters: null };
  let pairs = classifyPairs({
    snapshotPairs: snapshot.pairs,
    livePairs: livePairs.records,
    blocking: null
  });
  if (pairs.missingPairs.length > 0) {
    blocking = await readBlockingRecords(orgId, deps);
    pairs = classifyPairs({
      snapshotPairs: snapshot.pairs,
      livePairs: livePairs.records,
      blocking: blocking.blocking
    });
  }

  const ledger = classifyLedger({
    snapshotLedger: snapshot.ledger,
    liveLedger: liveLedger.records,
    snapshotPairs: snapshot.pairs
  });

  const crossInstallation = identityCheck.classification
    === PREVIEW_IDENTITY_CLASSES.DIFFERENT_INSTALLATION;
  const limitations = [...PREVIEW_LIMITATIONS];
  if (crossInstallation) {
    limitations.push(
      'This file was exported from a different installation or environment of the same app. '
      + 'Its records are shown for comparison only and are not restorable in this installation.'
    );
  }

  return {
    success: true,
    readOnly: true,
    noWritesPerformed: true,
    format: RECOVERY_SNAPSHOT_FORMAT,
    formatVersion: RECOVERY_SNAPSHOT_VERSION,
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
      snapshot: snapshot.counts,
      live: {
        pairs: livePairs.count,
        ledger: liveLedger.count,
        skippedRetryClaims: liveLedger.skippedRetryClaims
      },
      pairs: pairs.counts,
      ledger: ledger.counts,
      restorablePairs: crossInstallation ? 0 : pairs.counts[PREVIEW_PAIR_CLASSES.MISSING],
      blockingRecords: blocking.counters || {
        mappingEnded: 0,
        mappingRepair: 0,
        counterpartStatus: 0,
        unattributed: 0
      }
    },
    samples: {
      pairs: pairs.samples,
      ledger: ledger.samples
    },
    limitations
  };
}
