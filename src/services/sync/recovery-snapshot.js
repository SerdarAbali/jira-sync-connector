import { createHash } from 'crypto';
import * as kvsStore from '../storage/kvs.js';
import { getPilotPause } from './pilot-pause.js';
import { readForgeInstallationIdentity } from '../readiness/connector-readiness.js';
import { ISSUE_CREATE_DIRECTIONS, ISSUE_CREATE_STATES } from './issue-create-operation.js';
import { isValidIssueKey } from '../storage/mappings.js';

/**
 * Read-only export of the connector's own recovery metadata for exactly one
 * organization.
 *
 * Scope and boundaries:
 * - Only the issue-pair index (`mapping-meta:<orgId>:*`) and the issue-create
 *   ledger (`issue-create-op:<orgId>:*`) are exported. Comments, descriptions,
 *   attachment content, credentials, tokens and user email addresses are never
 *   read into the result.
 * - The export performs no writes. It stores no second copy in Forge storage:
 *   the only artifact is the NDJSON file the administrator downloads.
 * - Every read walks the storage cursor to exhaustion. A page that cannot be
 *   read, a cursor that stops making progress, a repeated page, a duplicated
 *   key or an uninterpretable record fails the whole export. A partial result is
 *   never reported as a successful backup.
 * - Each section is scanned twice and the two scans must agree on count and
 *   content digest, and the emergency pause must remain unchanged before and
 *   after the export. That is the consistency boundary this invocation can
 *   actually prove; it is not a transaction across Forge storage and Jira.
 */

export const RECOVERY_SNAPSHOT_FORMAT = 'jira-sync-recovery-snapshot';
export const RECOVERY_SNAPSHOT_VERSION = 2;
export const RECOVERY_SNAPSHOT_VERSION_V1 = 1;
export const RECOVERY_SNAPSHOT_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';
export const RECOVERY_SNAPSHOT_NOTICE =
  'Mapping and create-operation ledger recovery snapshot for one organization. '
  + 'This is not a complete Forge installation backup: Forge installation '
  + 'configuration, credentials, secrets, comments, issue descriptions, '
  + 'attachment content and Jira issue data are not included.';

export const SNAPSHOT_PAGE_SIZE = 100;
export const MAX_SECTION_PAGES = 400;
export const MAX_SECTION_RECORDS = 8000;
export const MAX_SNAPSHOT_BYTES = 3 * 1024 * 1024;

export const RECOVERY_SNAPSHOT_SECTIONS_V1 = Object.freeze(['pairs', 'ledger']);

/**
 * Version 2 sections, in file order. The first two are the version 1 sections,
 * unchanged; the remaining four add the evidence a restore needs so that an old
 * backup cannot silently reactivate a relationship an administrator ended, a
 * repair marker left half-written, or a counterpart recorded as deleted.
 */
export const RECOVERY_SNAPSHOT_SECTIONS = Object.freeze([
  ...RECOVERY_SNAPSHOT_SECTIONS_V1,
  'directions',
  'counterpartStatus',
  'mappingEnded',
  'mappingRepair'
]);

export const RECOVERY_SNAPSHOT_SECTIONS_FOR_VERSION = Object.freeze({
  1: RECOVERY_SNAPSHOT_SECTIONS_V1,
  2: RECOVERY_SNAPSHOT_SECTIONS
});

export const RECOVERY_SNAPSHOT_SECTION_RECORD_TYPES = Object.freeze({
  pairs: 'issue-pair-mapping',
  ledger: 'issue-create-ledger',
  directions: 'mapping-direction',
  counterpartStatus: 'counterpart-status',
  mappingEnded: 'mapping-ended',
  mappingRepair: 'mapping-repair'
});

const SAFE_REASON_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const SAFE_OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_STATUS_TOKEN_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;
const PROJECT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,49}$/;
const MAX_ALLOWED_PROJECTS = 200;

const COUNTERPART_STATES = Object.freeze(['active', 'resolved', 'ended', 'replaced', 'dismissed']);
const COUNTERPART_STATUS_VALUES = Object.freeze([
  'confirmed_deleted',
  'unavailable',
  'access_problem',
  'temporary_failure'
]);
const COUNTERPART_DELETED_SIDES = Object.freeze(['local', 'remote']);

export const SNAPSHOT_OMISSIONS = Object.freeze([
  'api tokens and webhook signing secrets',
  'comments and issue descriptions',
  'attachment content and attachment mappings',
  'remote API user email address',
  'JQL filter and installation-level Forge configuration',
  'account identifiers recorded on ended-mapping, repair and counterpart-status records'
]);

export const SNAPSHOT_LIMITATIONS = Object.freeze([
  'Completeness is proven only for the six exported prefixes and only while the '
    + 'emergency pause stays unchanged for the whole export.',
  'Two agreeing full scans detect concurrent modification; they cannot prove '
    + 'that Forge storage was read at a single instant.',
  'Pairs are exported from the mapping-meta index and both directed lookup '
    + 'prefixes. A pair that is present in only one of those two directions is '
    + 'exported as evidence and reported by the preview as incomplete; the export '
    + 'never repairs that divergence.',
  'The checksum detects accidental corruption and edit-after-download tampering; '
    + 'it is not a signature and does not authenticate the file.'
]);

export class RecoverySnapshotError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RecoverySnapshotError';
    this.code = code;
    this.details = details;
  }
}

function snapshotError(code, message, details) {
  return new RecoverySnapshotError(code, message, details);
}

/**
 * Fixed operator-facing text. Resolver failures never echo an underlying
 * storage or SDK message.
 */
export const SNAPSHOT_ERROR_MESSAGES = Object.freeze({
  SNAPSHOT_ORGANIZATION_REQUIRED: 'Select exactly one organization before exporting a snapshot.',
  SNAPSHOT_ORGANIZATION_INVALID: 'The selected organization identifier is not valid.',
  SNAPSHOT_ORGANIZATION_NOT_FOUND: 'The selected organization is not configured in this installation.',
  SNAPSHOT_PAUSE_UNREADABLE:
    'The emergency pause state could not be read, so a consistent export cannot be guaranteed. Nothing was exported.',
  SNAPSHOT_REQUIRES_PAUSE:
    'Pause synchronization before exporting a recovery snapshot. The export never changes the pause state itself.',
  SNAPSHOT_PAUSE_CHANGED:
    'The emergency pause state changed during the export. The snapshot is not authoritative and was discarded.',
  SNAPSHOT_IDENTITY_UNAVAILABLE:
    'The Forge application, environment, installation or site identity could not be read. A snapshot without installation identity would be unusable, so nothing was exported.',
  SNAPSHOT_STORAGE_UNAVAILABLE:
    'Connector storage could not be read. Nothing was exported.',
  SNAPSHOT_PAGE_UNREADABLE:
    'A storage page could not be read. The export was stopped; no partial file was produced.',
  SNAPSHOT_PAGINATION_INCOMPLETE:
    'Storage pagination did not reach a complete end state. The export was stopped; no partial file was produced.',
  SNAPSHOT_RECORD_INVALID:
    'A stored recovery record could not be interpreted. The export was stopped rather than exporting an unusable record.',
  SNAPSHOT_LEDGER_KEY_UNRECOGNIZED:
    'A stored issue-create key shape is not recognized by this version. The export was stopped rather than silently skipping it.',
  SNAPSHOT_UNSTABLE:
    'The stored recovery records changed during the export. The snapshot is not a consistent backup and was discarded.',
  SNAPSHOT_TOO_LARGE:
    'This organization exceeds the size limit of a single snapshot export. Nothing was exported; contact the connector maintainer.',
  SNAPSHOT_EXPORT_FAILED: 'The recovery snapshot could not be exported.'
});

export function snapshotErrorMessage(code) {
  return SNAPSHOT_ERROR_MESSAGES[code] || SNAPSHOT_ERROR_MESSAGES.SNAPSHOT_EXPORT_FAILED;
}

function orgScope(orgId) {
  return String(orgId);
}

/**
 * Deterministic JSON: object keys are emitted in sorted order so the same
 * record always serializes to the same bytes, which the checksum depends on.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',');
  return `{${body}}`;
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function digestLines(lines) {
  return `sha256:${sha256Hex(`${lines.join('\n')}\n`)}`;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeTimestamp(value) {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

function safeReason(value) {
  return typeof value === 'string' && SAFE_REASON_PATTERN.test(value) ? value : null;
}

function safeOperationId(value) {
  return typeof value === 'string' && SAFE_OPERATION_ID_PATTERN.test(value) ? value : null;
}

export function sectionPrefixes(orgId, section) {
  const scope = orgScope(orgId);
  if (section === 'pairs') return [`mapping-meta:${scope}:`];
  if (section === 'ledger') return [`issue-create-op:${scope}:`];
  if (section === 'directions') return [`${scope}:local-to-remote:`, `${scope}:remote-to-local:`];
  if (section === 'counterpartStatus') return [`counterpart-status:${scope}:`];
  if (section === 'mappingEnded') return [`mapping-ended:${scope}:`];
  if (section === 'mappingRepair') return [`mapping-repair:${scope}:`];
  throw snapshotError('SNAPSHOT_EXPORT_FAILED', 'Unknown snapshot section');
}

/** First prefix of a section. Kept for callers that only need the primary one. */
export function sectionPrefix(orgId, section) {
  return sectionPrefixes(orgId, section)[0];
}

/** Parses `<localKey>:<remoteKey>` suffixes used by the evidence sections. */
function parseEvidencePairKey(key, prefix, section) {
  if (typeof key !== 'string' || !key.startsWith(prefix)) {
    throw snapshotError('SNAPSHOT_RECORD_INVALID', `${section} record outside the selected organization`);
  }
  const parts = key.slice(prefix.length).split(':');
  if (parts.length !== 2 || !isValidIssueKey(parts[0]) || !isValidIssueKey(parts[1])) {
    throw snapshotError('SNAPSHOT_RECORD_INVALID', `${section} record has an invalid issue pair`);
  }
  return { localKey: parts[0], remoteKey: parts[1] };
}

function safeStatusToken(value) {
  return typeof value === 'string' && SAFE_STATUS_TOKEN_PATTERN.test(value)
    ? value.slice(0, 80)
    : null;
}


function hostFromUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function normalizePairRecord(key, value, orgId) {
  const prefix = sectionPrefix(orgId, 'pairs');
  if (!key.startsWith(prefix)) {
    throw snapshotError('SNAPSHOT_RECORD_INVALID', 'Pair record outside the selected organization');
  }
  const localKey = key.slice(prefix.length);
  if (!isValidIssueKey(localKey)) {
    throw snapshotError('SNAPSHOT_RECORD_INVALID', 'Pair record has an invalid local issue key');
  }
  if (!isPlainObject(value)) {
    throw snapshotError('SNAPSHOT_RECORD_INVALID', 'Pair record is not an object');
  }
  if (value.localKey !== localKey) {
    throw snapshotError('SNAPSHOT_RECORD_INVALID', 'Pair record key does not match its stored value');
  }
  if (!isValidIssueKey(value.remoteKey)) {
    throw snapshotError('SNAPSHOT_RECORD_INVALID', 'Pair record has an invalid remote issue key');
  }

  return {
    identity: localKey,
    record: {
      kind: 'record',
      section: 'pairs',
      localKey,
      remoteKey: value.remoteKey,
      createdAt: safeTimestamp(value.createdAt),
      updatedAt: safeTimestamp(value.updatedAt)
    }
  };
}

export function normalizeLedgerRecord(key, value, orgId) {
  const base = sectionPrefix(orgId, 'ledger');
  if (!key.startsWith(base)) {
    throw snapshotError('SNAPSHOT_RECORD_INVALID', 'Ledger record outside the selected organization');
  }

  const parts = key.slice(base.length).split(':');
  if (parts.length > 3) {
    // Retry-claim markers are transient concurrency fences, not ledger
    // records. Anything else with extra segments is an unknown key shape.
    if (parts.some((part) => part === 'retry')) {
      return { skipped: 'ledgerRetryClaim' };
    }
    throw snapshotError('SNAPSHOT_LEDGER_KEY_UNRECOGNIZED', 'Unrecognized ledger key shape');
  }

  const direction = parts[0];
  if (direction !== ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE
    && direction !== ISSUE_CREATE_DIRECTIONS.REMOTE_TO_LOCAL) {
    throw snapshotError('SNAPSHOT_LEDGER_KEY_UNRECOGNIZED', 'Unrecognized ledger direction');
  }

  let sourceKey;
  try {
    sourceKey = decodeURIComponent(parts[1] || '');
  } catch {
    throw snapshotError('SNAPSHOT_RECORD_INVALID', 'Ledger source key is not decodable');
  }
  // Reject an encoded spelling that is not the canonical one so two distinct
  // stored keys can never claim the same source issue.
  if (!isValidIssueKey(sourceKey) || encodeURIComponent(sourceKey) !== parts[1]) {
    throw snapshotError('SNAPSHOT_RECORD_INVALID', 'Ledger source key is invalid');
  }

  let operationSuffix = null;
  if (parts.length === 3) {
    try {
      operationSuffix = decodeURIComponent(parts[2]);
    } catch {
      throw snapshotError('SNAPSHOT_RECORD_INVALID', 'Ledger operation suffix is not decodable');
    }
    if (!safeOperationId(operationSuffix)) {
      throw snapshotError('SNAPSHOT_RECORD_INVALID', 'Ledger operation suffix is invalid');
    }
  }

  if (!isPlainObject(value)) {
    throw snapshotError('SNAPSHOT_RECORD_INVALID', 'Ledger record is not an object');
  }
  const states = Object.values(ISSUE_CREATE_STATES);
  if (!states.includes(value.state)) {
    throw snapshotError('SNAPSHOT_RECORD_INVALID', 'Ledger record has an unrecognized state');
  }
  if (value.direction !== undefined && value.direction !== direction) {
    throw snapshotError('SNAPSHOT_RECORD_INVALID', 'Ledger direction does not match its key');
  }
  if (value.sourceKey !== undefined && value.sourceKey !== sourceKey) {
    throw snapshotError('SNAPSHOT_RECORD_INVALID', 'Ledger source key does not match its key');
  }
  if (value.operationSuffix !== undefined
    && value.operationSuffix !== null
    && value.operationSuffix !== operationSuffix) {
    throw snapshotError('SNAPSHOT_RECORD_INVALID', 'Ledger operation suffix does not match its key');
  }
  if (value.targetKey !== undefined && value.targetKey !== null && !isValidIssueKey(value.targetKey)) {
    throw snapshotError('SNAPSHOT_RECORD_INVALID', 'Ledger target key is invalid');
  }
  const attempt = Number.isInteger(value.attempt) && value.attempt > 0 ? value.attempt : 1;

  return {
    identity: `${direction}\u0000${sourceKey}\u0000${operationSuffix || ''}`,
    record: {
      kind: 'record',
      section: 'ledger',
      direction,
      sourceKey,
      operationSuffix,
      state: value.state,
      attempt,
      targetKey: typeof value.targetKey === 'string' ? value.targetKey : null,
      operationId: safeOperationId(value.operationId),
      createdAt: safeTimestamp(value.createdAt),
      updatedAt: safeTimestamp(value.updatedAt),
      startedAt: safeTimestamp(value.startedAt),
      completedAt: safeTimestamp(value.completedAt),
      unknownAt: safeTimestamp(value.unknownAt),
      failedAt: safeTimestamp(value.failedAt),
      failureReason: safeReason(value.failureReason)
    }
  };
}

/**
 * Directional mapping evidence.
 *
 * Version 1 exported only the mapping-meta index, so a pair held only in the
 * directed lookup records was invisible and a metadata-only pair looked healthy.
 * Version 2 exports both directions as canonical records, so the preview can
 * distinguish a complete pair, a metadata-only pair, a directional-only pair and
 * two directions that disagree.
 */
export function normalizeDirectionRecord(key, value, orgId) {
  const [localToRemotePrefix, remoteToLocalPrefix] = sectionPrefixes(orgId, 'directions');
  let direction;
  let localKey;
  let remoteKey;
  if (typeof key === 'string' && key.startsWith(localToRemotePrefix)) {
    direction = 'local-to-remote';
    localKey = key.slice(localToRemotePrefix.length);
    remoteKey = value;
  } else if (typeof key === 'string' && key.startsWith(remoteToLocalPrefix)) {
    direction = 'remote-to-local';
    remoteKey = key.slice(remoteToLocalPrefix.length);
    localKey = value;
  } else {
    throw snapshotError('SNAPSHOT_RECORD_INVALID', 'Direction record outside the selected organization');
  }
  if (!isValidIssueKey(localKey) || !isValidIssueKey(remoteKey)) {
    throw snapshotError('SNAPSHOT_RECORD_INVALID', 'Direction record has an invalid issue pair');
  }
  return {
    identity: `${direction}\u0000${localKey}\u0000${remoteKey}`,
    record: {
      kind: 'record',
      section: 'directions',
      direction,
      localKey,
      remoteKey
    }
  };
}

/**
 * Counterpart-status evidence. A record whose status is not one this connector
 * writes is refused instead of being exported as an uninterpretable state: a
 * backup that cannot say why a counterpart was blocked is worse than no backup.
 */
export function normalizeCounterpartStatusRecord(key, value, orgId) {
  const prefix = sectionPrefixes(orgId, 'counterpartStatus')[0];
  const { localKey, remoteKey } = parseEvidencePairKey(key, prefix, 'Counterpart status');
  if (!isPlainObject(value)) {
    throw snapshotError('SNAPSHOT_RECORD_INVALID', 'Counterpart status record is not an object');
  }
  if (!COUNTERPART_STATUS_VALUES.includes(value.status)) {
    throw snapshotError('SNAPSHOT_RECORD_INVALID', 'Counterpart status record has an unrecognized status');
  }
  return {
    identity: `${localKey}\u0000${remoteKey}`,
    record: {
      kind: 'record',
      section: 'counterpartStatus',
      localKey,
      remoteKey,
      state: COUNTERPART_STATES.includes(value.state) ? value.state : 'active',
      status: value.status,
      deletedSide: COUNTERPART_DELETED_SIDES.includes(value.deletedSide) ? value.deletedSide : null,
      source: safeStatusToken(value.source),
      reasonCode: safeStatusToken(value.reasonCode),
      probeStatusCode: Number.isInteger(value.probeStatusCode) ? value.probeStatusCode : null,
      firstDetectedAt: safeTimestamp(value.firstDetectedAt),
      lastDetectedAt: safeTimestamp(value.lastDetectedAt),
      updatedAt: safeTimestamp(value.updatedAt),
      endedAt: safeTimestamp(value.endedAt),
      resolvedAt: safeTimestamp(value.resolvedAt),
      replacementLocalKey: isValidIssueKey(value.replacementLocalKey) ? value.replacementLocalKey : null,
      replacementRemoteKey: isValidIssueKey(value.replacementRemoteKey) ? value.replacementRemoteKey : null
    }
  };
}

/** Administrator intent: this exact pair was ended and must not be revived. */
export function normalizeMappingEndedRecord(key, value, orgId) {
  const prefix = sectionPrefixes(orgId, 'mappingEnded')[0];
  const { localKey, remoteKey } = parseEvidencePairKey(key, prefix, 'Ended mapping');
  if (!isPlainObject(value)) {
    throw snapshotError('SNAPSHOT_RECORD_INVALID', 'Ended mapping record is not an object');
  }
  return {
    identity: `${localKey}\u0000${remoteKey}`,
    record: {
      kind: 'record',
      section: 'mappingEnded',
      localKey,
      remoteKey,
      endedAt: safeTimestamp(value.endedAt),
      reasonCode: safeStatusToken(value.reasonCode)
    }
  };
}

/** A pair whose write was only partially applied; it must not be completed. */
export function normalizeMappingRepairRecord(key, value, orgId) {
  const prefix = sectionPrefixes(orgId, 'mappingRepair')[0];
  const { localKey, remoteKey } = parseEvidencePairKey(key, prefix, 'Mapping repair');
  if (!isPlainObject(value)) {
    throw snapshotError('SNAPSHOT_RECORD_INVALID', 'Mapping repair record is not an object');
  }
  return {
    identity: `${localKey}\u0000${remoteKey}`,
    record: {
      kind: 'record',
      section: 'mappingRepair',
      localKey,
      remoteKey,
      reason: safeStatusToken(value.reason),
      detectedAt: safeTimestamp(value.detectedAt)
    }
  };
}

const SECTION_NORMALIZERS = Object.freeze({
  pairs: normalizePairRecord,
  ledger: normalizeLedgerRecord,
  directions: normalizeDirectionRecord,
  counterpartStatus: normalizeCounterpartStatusRecord,
  mappingEnded: normalizeMappingEndedRecord,
  mappingRepair: normalizeMappingRepairRecord
});

/**
 * Per-section record budget. The direction section carries two records per pair
 * (one per direction), so it needs twice the budget of a pair section.
 */
export function sectionRecordLimit(section) {
  return section === 'directions' ? MAX_SECTION_RECORDS * 2 : MAX_SECTION_RECORDS;
}

/**
 * Reads one section to exhaustion using bounded cursor pages. A section may span
 * more than one storage prefix (the two directed mapping lookups); each prefix is
 * walked with its own cursor while the page budget and the duplicate-key check
 * cover the section as a whole. Throws instead of returning a short read.
 */
async function collectSection({ orgId, section, deps }) {
  const prefixes = sectionPrefixes(orgId, section);
  const normalize = SECTION_NORMALIZERS[section];
  const limit = sectionRecordLimit(section);
  const entries = [];
  const seenKeys = new Set();
  const seenPages = new Set();
  let skippedRetryClaims = 0;
  let pages = 0;

  for (const prefix of prefixes) {
    let cursor = null;
    for (;;) {
      if (pages >= MAX_SECTION_PAGES) {
        throw snapshotError('SNAPSHOT_TOO_LARGE', 'Section exceeds the page budget', {
          section,
          pages
        });
      }
      pages += 1;

      let page;
      try {
        page = await deps.queryPage(prefix, { cursor, limit: SNAPSHOT_PAGE_SIZE });
      } catch (error) {
        throw snapshotError('SNAPSHOT_PAGE_UNREADABLE', 'A storage page could not be read', {
          section,
          cause: typeof error?.code === 'string' ? error.code : 'unknown'
        });
      }

      if (!page || !Array.isArray(page.records)) {
        throw snapshotError('SNAPSHOT_PAGE_UNREADABLE', 'A storage page was not readable', {
          section,
          cause: 'malformed-page'
        });
      }

      // The prefix is part of the signature so two different prefixes that both
      // return an empty page are not mistaken for a repeated page.
      const pageSignature = `${prefix}\u0000${page.records
        .map((record) => (typeof record?.key === 'string' ? record.key : '?invalid?'))
        .join('\n')}`;
      if (seenPages.has(pageSignature)) {
        throw snapshotError('SNAPSHOT_PAGINATION_INCOMPLETE', 'The same page was returned twice', {
          section,
          pages
        });
      }
      seenPages.add(pageSignature);

      // A cursor that advances without records would otherwise loop or truncate.
      if (page.records.length === 0 && page.nextCursor) {
        throw snapshotError(
          'SNAPSHOT_PAGINATION_INCOMPLETE',
          'Pagination returned an empty page with a continuation cursor',
          { section, pages }
        );
      }

      for (const entry of page.records) {
        if (!entry || typeof entry.key !== 'string' || entry.key.length === 0) {
          throw snapshotError('SNAPSHOT_RECORD_INVALID', 'A stored entry has no usable key', {
            section
          });
        }
        if (seenKeys.has(entry.key)) {
          throw snapshotError('SNAPSHOT_PAGINATION_INCOMPLETE', 'A stored key was returned twice', {
            section
          });
        }
        seenKeys.add(entry.key);

        const normalized = normalize(entry.key, entry.value, orgId);
        if (normalized.skipped) {
          skippedRetryClaims += 1;
          continue;
        }
        entries.push(normalized);
        if (entries.length > limit) {
          throw snapshotError('SNAPSHOT_TOO_LARGE', 'Section exceeds the record budget', {
            section,
            records: entries.length
          });
        }
      }

      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
      if (!cursor) break;
    }
  }

  entries.sort((left, right) => (left.identity < right.identity
    ? -1
    : left.identity > right.identity ? 1 : 0));
  const records = entries.map((entry) => entry.record);
  const lines = records.map((record) => stableStringify(record));

  return {
    section,
    records,
    lines,
    pages,
    skippedRetryClaims,
    count: records.length,
    digest: digestLines(lines)
  };
}

/**
 * Read-only single scan of one exported section.
 *
 * The restore preview compares a snapshot against current storage. It reuses the
 * export normalizer and the export's cursor discipline, so an unreadable page, a
 * stalled cursor, a repeated page, a duplicated key or an uninterpretable record
 * fails the preview instead of producing a short comparison.
 *
 * @param {{orgId: string, section: 'pairs'|'ledger', deps?: object}} options
 * @returns {Promise<{section: string, records: Array<object>, lines: string[],
 *   pages: number, skippedRetryClaims: number, count: number, digest: string}>}
 */
export async function readStoredSection({ orgId, section, deps = {} }) {
  return collectSection({ orgId, section, deps: { ...defaultDeps, ...deps } });
}

export async function readOrganizationScope(orgId, deps) {
  let stored;
  try {
    stored = await deps.getStored('organizations');
  } catch (error) {
    throw snapshotError('SNAPSHOT_STORAGE_UNAVAILABLE', 'Organizations could not be read', {
      cause: typeof error?.code === 'string' ? error.code : 'unknown'
    });
  }
  const organizations = Array.isArray(stored) ? stored : [];
  const organization = organizations.find((entry) => entry && entry.id === orgId);
  if (!organization) {
    throw snapshotError('SNAPSHOT_ORGANIZATION_NOT_FOUND', 'Organization is not configured');
  }

  const remoteUrl = typeof organization.remoteUrl === 'string' ? organization.remoteUrl.trim() : '';
  const remoteHost = hostFromUrl(remoteUrl);
  if (remoteUrl !== '' && !remoteHost) {
    throw snapshotError('SNAPSHOT_ORGANIZATION_INVALID', 'Organization remote URL is not usable');
  }

  const allowedProjects = Array.isArray(organization.allowedProjects)
    ? Array.from(new Set(organization.allowedProjects
      .filter((entry) => typeof entry === 'string' && PROJECT_KEY_PATTERN.test(entry))))
      .sort()
      .slice(0, MAX_ALLOWED_PROJECTS)
    : [];

  return {
    id: orgId,
    name: typeof organization.name === 'string' ? organization.name : null,
    remoteHost,
    remoteProjectKey: typeof organization.remoteProjectKey === 'string'
      && PROJECT_KEY_PATTERN.test(organization.remoteProjectKey)
      ? organization.remoteProjectKey
      : null,
    allowedProjects,
    syncDirection: organization.syncDirection === 'bidirectional' ? 'bidirectional' : 'push'
  };
}

async function readPauseState(deps) {
  try {
    const state = await deps.getPilotPause();
    return {
      paused: state?.paused === true,
      pausedAt: typeof state?.pausedAt === 'string' ? state.pausedAt : null,
      reasonCode: typeof state?.reasonCode === 'string' ? state.reasonCode : null
    };
  } catch (error) {
    throw snapshotError('SNAPSHOT_PAUSE_UNREADABLE', 'Emergency pause state could not be read', {
      cause: typeof error?.code === 'string' ? error.code : 'unknown'
    });
  }
}

function requirePaused(state) {
  if (!state.paused) {
    throw snapshotError('SNAPSHOT_REQUIRES_PAUSE', 'Export requires the emergency pause');
  }
  return state;
}

function assertSamePause(before, after) {
  if (!after.paused
    || before.pausedAt !== after.pausedAt
    || before.reasonCode !== after.reasonCode) {
    throw snapshotError('SNAPSHOT_PAUSE_CHANGED', 'Emergency pause changed during the export');
  }
}

function slugify(value, fallback) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const slug = text.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (slug || fallback).slice(0, 60);
}

export function snapshotFileName({ organization, exportedAt }) {
  const date = typeof exportedAt === 'string' ? exportedAt.slice(0, 10) : 'unknown-date';
  return `${slugify(organization?.name, 'organization')}-${slugify(organization?.id, 'org')}`
    + `-recovery-snapshot-${date}.ndjson`;
}

const defaultDeps = {
  queryPage: (prefix, options) => kvsStore.queryPageByPrefix(prefix, options),
  getStored: (key) => kvsStore.get(key),
  getPilotPause,
  readIdentity: () => readForgeInstallationIdentity(),
  now: () => Date.now()
};

/** Normalizes the explicitly selected organization identifier. */
export function normalizeSnapshotOrgId(value) {
  if (value === undefined || value === null || value === '') {
    throw snapshotError('SNAPSHOT_ORGANIZATION_REQUIRED', 'An organization is required');
  }
  if (typeof value !== 'string' || !/^org-\d+$/.test(value.trim())) {
    throw snapshotError('SNAPSHOT_ORGANIZATION_INVALID', 'The organization identifier is invalid');
  }
  return value.trim();
}

/**
 * Builds the complete recovery snapshot for one organization.
 *
 * @param {{orgId: string, deps?: object}} options
 * @returns {Promise<object>} success result with the NDJSON content
 */
export async function buildRecoverySnapshot(options = {}) {
  const deps = { ...defaultDeps, ...(options.deps || {}) };
  const orgId = normalizeSnapshotOrgId(options.orgId);
  const exportedAt = new Date(deps.now()).toISOString();

  // The pause is the consistency boundary: while it is in force the connector
  // performs no Jira writes and therefore records no new pairs or ledger rows.
  const pauseBefore = requirePaused(await readPauseState(deps));
  const organization = await readOrganizationScope(orgId, deps);

  let identity;
  try {
    identity = await deps.readIdentity();
  } catch {
    identity = null;
  }
  if (!identity || identity.readable !== true) {
    throw snapshotError('SNAPSHOT_IDENTITY_UNAVAILABLE', 'Installation identity is incomplete', {
      cause: typeof identity?.code === 'string' ? identity.code : 'identity-unreadable'
    });
  }

  const sections = [];
  for (const section of RECOVERY_SNAPSHOT_SECTIONS) {
    const first = await collectSection({ orgId, section, deps });
    const second = await collectSection({ orgId, section, deps });
    if (first.count !== second.count
      || first.digest !== second.digest
      || first.skippedRetryClaims !== second.skippedRetryClaims) {
      throw snapshotError('SNAPSHOT_UNSTABLE', 'Stored records changed during the export', {
        section
      });
    }
    sections.push(first);
  }

  assertSamePause(pauseBefore, await readPauseState(deps));

  const sectionCount = (name) => (sections.find((entry) => entry.section === name)?.count ?? 0);
  const sectionDigest = (name) => (sections.find((entry) => entry.section === name)?.digest ?? null);
  const counts = {
    kind: 'counts',
    pairs: sectionCount('pairs'),
    ledger: sectionCount('ledger'),
    directions: sectionCount('directions'),
    counterpartStatus: sectionCount('counterpartStatus'),
    mappingEnded: sectionCount('mappingEnded'),
    mappingRepair: sectionCount('mappingRepair'),
    total: sections.reduce((sum, entry) => sum + entry.count, 0),
    skipped: {
      ledgerRetryClaims: sections.find((entry) => entry.section === 'ledger')?.skippedRetryClaims ?? 0
    }
  };

  const header = {
    kind: 'header',
    format: RECOVERY_SNAPSHOT_FORMAT,
    formatVersion: RECOVERY_SNAPSHOT_VERSION,
    exportedAt,
    scope: 'one-organization',
    notice: RECOVERY_SNAPSHOT_NOTICE,
    identity: {
      appId: identity.appId,
      appAri: identity.appAri,
      appVersion: identity.appVersion,
      environmentId: identity.environmentId,
      environmentType: identity.environmentType,
      installationId: identity.installationId,
      cloudIds: identity.cloudIds,
      siteHost: identity.siteHost
    },
    organization,
    pause: {
      paused: true,
      pausedAt: pauseBefore.pausedAt,
      reasonCode: pauseBefore.reasonCode
    },
    sections: sections.map((entry) => ({
      name: entry.section,
      recordType: RECOVERY_SNAPSHOT_SECTION_RECORD_TYPES[entry.section],
      count: entry.count,
      pagesScanned: entry.pages,
      checksum: entry.digest
    })),
    omissions: [...SNAPSHOT_OMISSIONS],
    limitations: [...SNAPSHOT_LIMITATIONS]
  };

  const headerLine = stableStringify(header);
  const recordLines = sections.flatMap((entry) => entry.lines);
  const countsLine = stableStringify(counts);
  // The digest covers the counts as well as every exported record, so a file
  // whose counts were edited no longer verifies. Every covered line is
  // newline-terminated so `sed '$d' <file> | shasum -a 256` reproduces it.
  const checksum = `sha256:${sha256Hex(`${[headerLine, ...recordLines, countsLine].join('\n')}\n`)}`;

  const footerLine = stableStringify({
    kind: 'footer',
    format: RECOVERY_SNAPSHOT_FORMAT,
    formatVersion: RECOVERY_SNAPSHOT_VERSION,
    checksumAlgorithm: 'sha256',
    checksumScope: 'header,records,counts',
    checksum,
    counts,
    sectionChecksums: Object.fromEntries(
      RECOVERY_SNAPSHOT_SECTIONS.map((name) => [name, sectionDigest(name)])
    ),
    notice: RECOVERY_SNAPSHOT_NOTICE,
    limitations: [...SNAPSHOT_LIMITATIONS]
  });

  const content = `${[headerLine, ...recordLines, countsLine, footerLine].join('\n')}\n`;
  if (content.length > MAX_SNAPSHOT_BYTES) {
    throw snapshotError('SNAPSHOT_TOO_LARGE', 'Snapshot exceeds the export size budget', {
      bytes: content.length
    });
  }

  return {
    success: true,
    format: RECOVERY_SNAPSHOT_FORMAT,
    formatVersion: RECOVERY_SNAPSHOT_VERSION,
    exportedAt,
    fileName: snapshotFileName({ organization, exportedAt }),
    contentType: RECOVERY_SNAPSHOT_CONTENT_TYPE,
    content,
    checksum,
    checksumAlgorithm: 'sha256',
    counts: {
      pairs: counts.pairs,
      ledger: counts.ledger,
      directions: counts.directions,
      counterpartStatus: counts.counterpartStatus,
      mappingEnded: counts.mappingEnded,
      mappingRepair: counts.mappingRepair,
      total: counts.total,
      skippedRetryClaims: counts.skipped.ledgerRetryClaims
    },
    identity: header.identity,
    organization,
    bytes: content.length,
    notice: RECOVERY_SNAPSHOT_NOTICE,
    limitations: [...SNAPSHOT_LIMITATIONS]
  };
}

/**
 * Recomputes the checksum from a snapshot text. Used by verification tooling
 * and tests; the export path never trusts this instead of its own computation.
 *
 * @param {string} content NDJSON snapshot text
 * @returns {{valid: boolean, checksum: string|null, declared: string|null, lines: number}}
 */
export function verifySnapshotContent(content) {
  if (typeof content !== 'string' || content.length === 0) {
    return { valid: false, checksum: null, declared: null, lines: 0 };
  }
  const lines = content.split('\n').filter((line) => line.length > 0);
  if (lines.length < 3) {
    return { valid: false, checksum: null, declared: null, lines: lines.length };
  }

  let footer;
  try {
    footer = JSON.parse(lines[lines.length - 1]);
  } catch {
    return { valid: false, checksum: null, declared: null, lines: lines.length };
  }
  const countsLine = lines[lines.length - 2];
  const coveredLines = lines.slice(0, lines.length - 1);
  const checksum = `sha256:${sha256Hex(`${coveredLines.join('\n')}\n`)}`;
  const declared = typeof footer?.checksum === 'string' ? footer.checksum : null;
  const countsMatch = footer?.kind === 'footer'
    && stableStringify(footer.counts) === countsLine;

  return {
    valid: Boolean(declared) && declared === checksum && countsMatch,
    checksum,
    declared,
    lines: lines.length
  };
}
