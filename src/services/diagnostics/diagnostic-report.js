import { createHash } from 'crypto';
import { getAppContext } from '@forge/api';
import * as kvsStore from '../storage/kvs.js';
import { getPilotPause } from '../sync/pilot-pause.js';
import { readSyncAuthorizationStatus } from '../sync/sync-authorization.js';
import {
  listReconciliationAttention,
  summarizeReconciliationAttention
} from '../sync/reconciliation-attention.js';
import { sanitizeAuditEntry, safeErrorSummary } from '../../utils/redaction.js';

/**
 * Customer-exportable diagnostic report.
 *
 * Evidence is read from existing Forge records only. This module performs no
 * Jira request, no synchronization and no storage write. Every value that leaves
 * this module is constructed by an explicit allowlist function below; raw
 * configuration, mapping, statistics, audit or Jira records are never spread
 * into the report.
 */

export const DIAGNOSTIC_REPORT_SCHEMA = 'syncapp.diagnostic-report';
export const DIAGNOSTIC_REPORT_VERSION = 1;
export const DIAGNOSTIC_REPORT_MAX_BYTES = 64 * 1024;
export const DIAGNOSTIC_SAMPLE_LIMIT = 10;
export const DIAGNOSTIC_HISTORY_LIMIT = 6;
export const DIAGNOSTIC_PROJECT_LIMIT = 20;
export const DIAGNOSTIC_SCAN_LIMIT = 1000;
export const DIAGNOSTIC_LEDGER_SCAN_LIMIT = 500;

export const DIAGNOSTIC_SECTION_CODES = Object.freeze({
  ORGANIZATION_REQUIRED: 'DIAGNOSTIC_ORGANIZATION_REQUIRED',
  ORGANIZATION_INVALID: 'DIAGNOSTIC_ORGANIZATION_INVALID',
  ORGANIZATION_NOT_FOUND: 'DIAGNOSTIC_ORGANIZATION_NOT_FOUND',
  ORGANIZATION_UNREADABLE: 'DIAGNOSTIC_ORGANIZATION_UNREADABLE',
  IDENTITY_UNAVAILABLE: 'DIAGNOSTIC_IDENTITY_UNAVAILABLE',
  APPLICATION_VERSION_UNAVAILABLE: 'DIAGNOSTIC_APPLICATION_VERSION_UNAVAILABLE',
  PAUSE_UNREADABLE: 'DIAGNOSTIC_PAUSE_UNREADABLE',
  AUTHORIZATION_UNREADABLE: 'DIAGNOSTIC_AUTHORIZATION_UNREADABLE',
  TELEMETRY_NOT_RECORDED: 'DIAGNOSTIC_TELEMETRY_NOT_RECORDED',
  MAPPINGS_UNREADABLE: 'DIAGNOSTIC_MAPPINGS_UNREADABLE',
  LEDGER_UNREADABLE: 'DIAGNOSTIC_LEDGER_UNREADABLE',
  PAIR_WITNESS_UNREADABLE: 'DIAGNOSTIC_PAIR_WITNESS_UNREADABLE',
  RECOVERY_ATTENTION_UNREADABLE: 'DIAGNOSTIC_RECOVERY_ATTENTION_UNREADABLE',
  AUDIT_UNREADABLE: 'DIAGNOSTIC_AUDIT_UNREADABLE',
  REPORT_TRUNCATED: 'DIAGNOSTIC_REPORT_TRUNCATED',
  MAPPINGS_TRUNCATED: 'DIAGNOSTIC_MAPPINGS_TRUNCATED',
  LEDGER_TRUNCATED: 'DIAGNOSTIC_LEDGER_TRUNCATED',
  AUDIT_TRUNCATED: 'DIAGNOSTIC_AUDIT_TRUNCATED',
  ERRORS_TRUNCATED: 'DIAGNOSTIC_ERRORS_TRUNCATED',
  RATE_HISTORY_TRUNCATED: 'DIAGNOSTIC_RATE_HISTORY_TRUNCATED'
});

export class DiagnosticReportError extends Error {
  constructor(code, message = 'The diagnostic report could not be generated.') {
    super(message);
    this.name = 'DiagnosticReportError';
    this.code = code;
  }
}

const ORG_ID_PATTERN = /^(?:org-\d+|legacy)$/;
const CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,96}$/;
const PROJECT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,49}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAINTENANCE_ACTIONS = new Set([
  'adopt-pair-witness',
  'pair-witness-establishment',
  'pair_witness_property_write',
  'recovery-restore',
  'sprint-sync',
  'sync-conflict'
]);
const ENDPOINT_CATEGORIES = new Set([
  'comments', 'attachments', 'links', 'issues', 'search', 'projects',
  'users', 'fields', 'statuses', 'other'
]);
const SYNC_OPTION_KEYS = Object.freeze([
  'syncComments', 'syncAttachments', 'syncLinks', 'syncCrossReference',
  'syncSprints', 'recreateDeletedIssues', 'automaticReplacementAfterDeletion',
  'propagateAttachmentDeletions'
]);

const LIMITATIONS = Object.freeze([
  'The report contains retained connector records only; it is not a complete synchronization ledger.',
  'No Jira issue descriptions, comment bodies, attachment content, recovery snapshots or full issue payloads are included.',
  'Jira group/role visibility is not mapped across sites and is not evaluated by this export.',
  'Comment edits and deletions are not propagated by the connector.',
  'Forge quota, success percentages and future activity are not inferred when not recorded.'
]);

const defaultDeps = {
  getStored: kvsStore.get,
  getSecret: kvsStore.getSecret,
  queryPageByPrefix: kvsStore.queryPageByPrefix,
  queryByPrefix: kvsStore.queryByPrefix,
  getAppContext,
  getPilotPause,
  readSyncAuthorizationStatus,
  listReconciliationAttention,
  now: () => Date.now()
};

function safeText(value, maxLength = 120) {
  if (typeof value !== 'string') return null;
  const text = Array.from(value)
    .map((character) => {
      const code = character.codePointAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.includes('@') || EMAIL_PATTERN.test(text)) return null;
  return text.slice(0, maxLength);
}

function safeReason(value) {
  return safeCode(value);
}

function safeCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim();
  return CODE_PATTERN.test(code) ? code : null;
}

function safeTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function safeProjectKey(value) {
  return typeof value === 'string' && PROJECT_KEY_PATTERN.test(value) ? value : null;
}

function digest(value) {
  return typeof value === 'string' && value
    ? `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
    : null;
}

function objectCount(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).length
    : null;
}

function unavailable(code) {
  return { available: false, code };
}

function available(extra = {}) {
  return { available: true, ...extra };
}

function stableErrorCode(value) {
  const text = safeErrorSummary(value, 96);
  return CODE_PATTERN.test(text) ? text : 'operation_failed';
}

function hostFromUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function safeOrganizationId(value) {
  return typeof value === 'string' && ORG_ID_PATTERN.test(value) ? value : null;
}

function scopePrefix(orgId) {
  return orgId === 'legacy' ? '' : `${orgId}:`;
}

async function readStored(deps, key) {
  try {
    return { ok: true, value: await deps.getStored(key) };
  } catch {
    return { ok: false, value: null };
  }
}

async function readSecretPresent(deps, key) {
  try {
    return { ok: true, present: !!(await deps.getSecret(key)) };
  } catch {
    return { ok: false, present: null };
  }
}

async function scanPrefix(deps, prefix, limit) {
  if (typeof deps.queryPageByPrefix === 'function') {
    const records = [];
    let cursor = null;
    let pages = 0;
    try {
      while (records.length < limit && pages < 20) {
        const page = await deps.queryPageByPrefix(prefix, {
          cursor,
          limit: Math.min(100, limit - records.length)
        });
        if (!page || !Array.isArray(page.records)) throw new Error('malformed page');
        records.push(...page.records);
        pages += 1;
        cursor = page.nextCursor;
        if (!cursor) return { available: true, records: records.slice(0, limit), truncated: false };
      }
      return { available: true, records: records.slice(0, limit), truncated: true };
    } catch {
      return unavailable(DIAGNOSTIC_SECTION_CODES.MAPPINGS_UNREADABLE);
    }
  }
  if (typeof deps.queryByPrefix === 'function') {
    try {
      const records = await deps.queryByPrefix(prefix, limit);
      if (!Array.isArray(records)) throw new Error('malformed result');
      return { available: true, records: records.slice(0, limit), truncated: records.length >= limit };
    } catch {
      return unavailable(DIAGNOSTIC_SECTION_CODES.MAPPINGS_UNREADABLE);
    }
  }
  return unavailable(DIAGNOSTIC_SECTION_CODES.MAPPINGS_UNREADABLE);
}


function syncOptionsSummary(stored) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return unavailable(DIAGNOSTIC_SECTION_CODES.TELEMETRY_NOT_RECORDED);
  }
  const values = {};
  for (const key of SYNC_OPTION_KEYS) {
    if (typeof stored[key] === 'boolean') values[key] = stored[key];
  }
  return available({ values });
}

function scheduledConfigSummary(stored) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return unavailable(DIAGNOSTIC_SECTION_CODES.TELEMETRY_NOT_RECORDED);
  }
  return available({
    enabled: safeBoolean(stored.enabled),
    intervalMinutes: safeCount(stored.intervalMinutes),
    syncScope: ['recent', 'all'].includes(stored.syncScope) ? stored.syncScope : null,
    lastRun: safeTimestamp(stored.lastRun)
  });
}

function projectScopeSummary(org) {
  const configured = Array.isArray(org?.allowedProjects)
    ? org.allowedProjects.map(safeProjectKey).filter(Boolean)
    : [];
  const jql = typeof org?.jqlFilter === 'string' ? org.jqlFilter : '';
  return {
    syncDirection: ['push', 'bidirectional'].includes(org?.syncDirection)
      ? org.syncDirection
      : 'unknown',
    remoteHost: hostFromUrl(org?.remoteUrl),
    remoteProjectKey: safeProjectKey(org?.remoteProjectKey),
    allowedProjectCount: configured.length,
    allowedProjects: configured.slice(0, DIAGNOSTIC_PROJECT_LIMIT),
    jql: {
      configured: jql.trim().length > 0,
      length: jql.length,
      digest: jql.trim() ? digest(jql) : null
    }
  };
}

function organizationIdentity(org, orgId) {
  return {
    ...projectScopeSummary(org),
    id: orgId,
    name: safeText(org?.name, 120),
    configuredAt: safeTimestamp(org?.createdAt),
    updatedAt: safeTimestamp(org?.updatedAt)
  };
}

function installationSummary(context, codes) {
  if (!context || typeof context !== 'object') {
    codes.add(DIAGNOSTIC_SECTION_CODES.IDENTITY_UNAVAILABLE);
    return {
      available: false,
      code: DIAGNOSTIC_SECTION_CODES.IDENTITY_UNAVAILABLE,
      applicationVersion: null,
      environmentType: null,
      installationDigest: null,
      cloudIdCount: null
    };
  }
  const installationId = typeof context.installationAri?.installationId === 'string'
    ? context.installationAri.installationId
    : null;
  const cloudIdCount = Array.isArray(context.installation?.contexts)
    ? context.installation.contexts.filter(entry => typeof entry?.cloudId === 'string').length
    : null;
  const installationDigest = digest(installationId);
  const applicationVersion = safeText(context.appVersion, 80);
  const result = {
    available: !!installationDigest,
    applicationVersion,
    environmentType: safeCode(context.environmentType),
    installationDigest,
    cloudIdCount
  };
  if (!installationDigest) {
    codes.add(DIAGNOSTIC_SECTION_CODES.IDENTITY_UNAVAILABLE);
    result.code = DIAGNOSTIC_SECTION_CODES.IDENTITY_UNAVAILABLE;
  }
  if (!applicationVersion) {
    codes.add(DIAGNOSTIC_SECTION_CODES.APPLICATION_VERSION_UNAVAILABLE);
  }
  return result;
}

async function pauseSummary(deps, codes) {
  const raw = await readStored(deps, 'pilotPause');
  let state;
  try {
    state = await deps.getPilotPause();
  } catch {
    codes.add(DIAGNOSTIC_SECTION_CODES.PAUSE_UNREADABLE);
    return unavailable(DIAGNOSTIC_SECTION_CODES.PAUSE_UNREADABLE);
  }
  if (!state || typeof state.paused !== 'boolean') {
    codes.add(DIAGNOSTIC_SECTION_CODES.PAUSE_UNREADABLE);
    return unavailable(DIAGNOSTIC_SECTION_CODES.PAUSE_UNREADABLE);
  }
  return available({
    paused: state.paused,
    pausedAt: safeTimestamp(state.pausedAt),
    reasonCode: safeReason(state.reasonCode),
    recorded: raw.ok && raw.value !== null && raw.value !== undefined,
    defaultApplied: raw.ok && (raw.value === null || raw.value === undefined)
  });
}

async function authorizationSummary(deps, codes) {
  try {
    const status = await deps.readSyncAuthorizationStatus();
    if (!status || typeof status !== 'object') throw new Error('invalid status');
    return available({
      authorized: status.authorized === true,
      state: safeCode(status.state),
      reason: safeCode(status.reason),
      basis: safeCode(status.basis || status.record?.basis),
      authorizedAt: safeTimestamp(status.authorizedAt || status.record?.authorizedAt),
      configuredOrganizationCount: Array.isArray(status.configuredOrganizationIds)
        ? status.configuredOrganizationIds.length : null,
      uncoveredOrganizationCount: Array.isArray(status.uncoveredOrganizationIds)
        ? status.uncoveredOrganizationIds.length : null,
      organizationSetDelta: {
        added: Array.isArray(status.organizationSetDelta?.added)
          ? status.organizationSetDelta.added.length : null,
        removed: Array.isArray(status.organizationSetDelta?.removed)
          ? status.organizationSetDelta.removed.length : null
      }
    });
  } catch {
    codes.add(DIAGNOSTIC_SECTION_CODES.AUTHORIZATION_UNREADABLE);
    return unavailable(DIAGNOSTIC_SECTION_CODES.AUTHORIZATION_UNREADABLE);
  }
}


function countMappingRows(result) {
  return {
    count: Array.isArray(result.records) ? result.records.length : 0,
    truncated: result.truncated === true
  };
}

async function mappingSummary(deps, orgId, codes) {
  const scope = scopePrefix(orgId);
  const prefixes = {
    localToRemote: `${scope}local-to-remote:`,
    remoteToLocal: `${scope}remote-to-local:`,
    metadata: `mapping-meta:${orgId}:`,
    repairs: `mapping-repair:${orgId}:`
  };
  const [local, remote, metadata, repairs] = await Promise.all([
    scanPrefix(deps, prefixes.localToRemote, DIAGNOSTIC_SCAN_LIMIT),
    scanPrefix(deps, prefixes.remoteToLocal, DIAGNOSTIC_SCAN_LIMIT),
    scanPrefix(deps, prefixes.metadata, DIAGNOSTIC_SCAN_LIMIT),
    scanPrefix(deps, prefixes.repairs, DIAGNOSTIC_SCAN_LIMIT)
  ]);
  if ([local, remote, metadata, repairs].some(result => !result.available)) {
    codes.add(DIAGNOSTIC_SECTION_CODES.MAPPINGS_UNREADABLE);
    return unavailable(DIAGNOSTIC_SECTION_CODES.MAPPINGS_UNREADABLE);
  }
  const localCount = countMappingRows(local);
  const remoteCount = countMappingRows(remote);
  const metadataCount = countMappingRows(metadata);
  const repairCount = countMappingRows(repairs);
  const truncated = [local, remote, metadata, repairs].some(result => result.truncated === true);
  if (truncated) codes.add(DIAGNOSTIC_SECTION_CODES.MAPPINGS_TRUNCATED);
  return available({
    localToRemoteCount: localCount.count,
    remoteToLocalCount: remoteCount.count,
    metadataCount: metadataCount.count,
    repairCount: repairCount.count,
    scannedRecordCount: localCount.count + remoteCount.count + metadataCount.count + repairCount.count,
    truncated
  });
}

async function ledgerSummary(deps, orgId, codes) {
  const result = await scanPrefix(deps, `issue-create-op:${orgId}:`, DIAGNOSTIC_LEDGER_SCAN_LIMIT);
  if (!result.available) {
    codes.add(DIAGNOSTIC_SECTION_CODES.LEDGER_UNREADABLE);
    return unavailable(DIAGNOSTIC_SECTION_CODES.LEDGER_UNREADABLE);
  }
  const states = { pending: 0, succeeded: 0, unknown: 0, failed_definitive: 0 };
  const directions = { localToRemote: 0, remoteToLocal: 0 };
  let latestUpdatedAt = null;
  let recognized = 0;
  for (const entry of result.records) {
    const value = entry?.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (!Object.prototype.hasOwnProperty.call(states, value.state)) continue;
    recognized += 1;
    states[value.state] += 1;
    if (value.direction === 'local-to-remote') directions.localToRemote += 1;
    if (value.direction === 'remote-to-local') directions.remoteToLocal += 1;
    const updated = safeTimestamp(value.updatedAt);
    if (updated && (!latestUpdatedAt || updated > latestUpdatedAt)) latestUpdatedAt = updated;
  }
  if (result.truncated) codes.add(DIAGNOSTIC_SECTION_CODES.LEDGER_TRUNCATED);
  return available({
    total: recognized,
    states,
    directions,
    latestUpdatedAt,
    truncated: result.truncated === true
  });
}


function webhookStatCounts(record) {
  return {
    totalSyncs: safeCount(record?.totalSyncs),
    issuesCreated: safeCount(record?.issuesCreated),
    issuesUpdated: safeCount(record?.issuesUpdated),
    commentsSynced: safeCount(record?.commentsSynced),
    issuesSkipped: safeCount(record?.issuesSkipped),
    loopsPrevented: safeCount(record?.loopsPrevented)
  };
}

function webhookErrorSample(entry) {
  return {
    timestamp: safeTimestamp(entry?.timestamp),
    operation: safeCode(entry?.operation),
    code: stableErrorCode(entry?.error),
    statusCode: Number.isInteger(entry?.details?.statusCode) ? entry.details.statusCode : null,
    reason: safeCode(entry?.details?.reason)
  };
}

function scheduledErrorSample(entry) {
  return { code: stableErrorCode(typeof entry === 'string' ? entry : entry?.error) };
}

async function activitySummary(deps, orgId, codes) {
  const [webhook, scheduled] = await Promise.all([
    readStored(deps, 'webhookSyncStats'),
    readStored(deps, 'scheduledSyncStats')
  ]);
  const orgRecord = webhook.ok && webhook.value?.byOrg
    && typeof webhook.value.byOrg === 'object'
    ? webhook.value.byOrg[orgId]
    : null;
  if (webhook.ok === false) codes.add(DIAGNOSTIC_SECTION_CODES.TELEMETRY_NOT_RECORDED);
  if (scheduled.ok === false) codes.add(DIAGNOSTIC_SECTION_CODES.TELEMETRY_NOT_RECORDED);
  return {
    webhook: orgRecord
      ? available({
        scope: 'organization',
        lastSync: safeTimestamp(orgRecord.lastSync),
        lastSuccessfulJiraWrite: safeTimestamp(orgRecord.lastSuccessfulJiraWrite),
        counts: webhookStatCounts(orgRecord)
      })
      : unavailable(DIAGNOSTIC_SECTION_CODES.TELEMETRY_NOT_RECORDED),
    scheduled: scheduled.ok && scheduled.value
      ? available({
        scope: 'installation',
        lastRun: safeTimestamp(scheduled.value.lastRun),
        lastSuccessfulJiraWrite: safeTimestamp(scheduled.value.lastSuccessfulJiraWrite),
        counts: {
          issuesChecked: safeCount(scheduled.value.issuesChecked),
          issuesCreated: safeCount(scheduled.value.issuesCreated),
          issuesUpdated: safeCount(scheduled.value.issuesUpdated),
          issuesAlreadyCurrent: safeCount(scheduled.value.issuesAlreadyCurrent),
          issuesSkipped: safeCount(scheduled.value.issuesSkipped),
          issuesFailed: safeCount(scheduled.value.issuesFailed)
        }
      })
      : unavailable(DIAGNOSTIC_SECTION_CODES.TELEMETRY_NOT_RECORDED)
  };
}

async function errorsSummary(deps, orgId, codes) {
  const [webhook, scheduled] = await Promise.all([
    readStored(deps, 'webhookSyncStats'),
    readStored(deps, 'scheduledSyncStats')
  ]);
  if (!webhook.ok && !scheduled.ok) {
    codes.add(DIAGNOSTIC_SECTION_CODES.TELEMETRY_NOT_RECORDED);
    return unavailable(DIAGNOSTIC_SECTION_CODES.TELEMETRY_NOT_RECORDED);
  }
  if (!webhook.ok) codes.add(DIAGNOSTIC_SECTION_CODES.TELEMETRY_NOT_RECORDED);
  if (!scheduled.ok) codes.add(DIAGNOSTIC_SECTION_CODES.TELEMETRY_NOT_RECORDED);
  const webhookEntries = webhook.ok && Array.isArray(webhook.value?.errors)
    ? webhook.value.errors
      .filter(entry => entry?.orgId === orgId || (orgId === 'legacy' && !entry?.orgId))
      .map(webhookErrorSample)
    : [];
  const scheduledEntries = scheduled.ok && Array.isArray(scheduled.value?.errors)
    ? scheduled.value.errors.map(scheduledErrorSample)
    : [];
  const all = [
    ...webhookEntries.map(entry => ({ source: 'webhook', scope: 'organization', ...entry })),
    ...scheduledEntries.map(entry => ({ source: 'scheduled', scope: 'installation', ...entry }))
  ];
  const samples = all.slice(0, DIAGNOSTIC_SAMPLE_LIMIT);
  if (all.length > samples.length) codes.add(DIAGNOSTIC_SECTION_CODES.ERRORS_TRUNCATED);
  return available({
    webhook: webhook.ok && webhook.value
      ? { available: true, retainedCount: webhookEntries.length }
      : unavailable(DIAGNOSTIC_SECTION_CODES.TELEMETRY_NOT_RECORDED),
    scheduled: scheduled.ok && scheduled.value
      ? { available: true, retainedCount: scheduledEntries.length }
      : unavailable(DIAGNOSTIC_SECTION_CODES.TELEMETRY_NOT_RECORDED),
    samples,
    retainedCount: all.length,
    truncated: all.length > samples.length
  });
}

function rateLimitHistory(history, codes) {
  if (!Array.isArray(history)) return { history: [], truncated: false };
  const samples = history.slice(0, DIAGNOSTIC_HISTORY_LIMIT).map(entry => ({
    hour: typeof entry?.hour === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(entry.hour)
      ? entry.hour : null,
    calls: safeCount(entry?.calls),
    rateLimits: safeCount(entry?.rateLimits)
  }));
  if (history.length > samples.length) codes.add(DIAGNOSTIC_SECTION_CODES.RATE_HISTORY_TRUNCATED);
  return { history: samples, truncated: history.length > samples.length };
}

function rateCategoryCounts(byEndpoint) {
  const result = {};
  if (!byEndpoint || typeof byEndpoint !== 'object' || Array.isArray(byEndpoint)) return result;
  for (const category of ENDPOINT_CATEGORIES) {
    const value = byEndpoint[category];
    if (!value || typeof value !== 'object') continue;
    result[category] = {
      calls: safeCount(value.calls),
      rateLimits: safeCount(value.rateLimits)
    };
  }
  return result;
}

async function rateLimitSummary(deps, orgId, codes) {
  const result = await readStored(deps, 'apiUsageStats');
  if (!result.ok || !result.value || typeof result.value !== 'object') {
    return unavailable(DIAGNOSTIC_SECTION_CODES.TELEMETRY_NOT_RECORDED);
  }
  const stats = result.value;
  const orgStats = stats.byOrg && typeof stats.byOrg === 'object' ? stats.byOrg[orgId] : null;
  const history = rateLimitHistory(stats.history, codes);
  return available({
    scope: 'installation',
    totalCalls: safeCount(stats.totalCalls),
    successfulCalls: safeCount(stats.successfulCalls),
    failedCalls: safeCount(stats.failedCalls),
    rateLimitHits: safeCount(stats.rateLimitHits),
    lastRateLimitHit: safeTimestamp(stats.lastRateLimitHit),
    callsThisHour: safeCount(stats.callsThisHour),
    callsThisMinute: safeCount(stats.callsThisMinute),
    organization: orgStats
      ? { calls: safeCount(orgStats.calls), rateLimits: safeCount(orgStats.rateLimits) }
      : null,
    byCategory: rateCategoryCounts(stats.byEndpoint),
    history: history.history,
    truncated: history.truncated
  });
}


async function pairWitnessSummary(deps, orgId, codes) {
  const result = await readStored(deps, `pairWitnessPlan:${orgId}`);
  if (!result.ok) {
    codes.add(DIAGNOSTIC_SECTION_CODES.PAIR_WITNESS_UNREADABLE);
    return unavailable(DIAGNOSTIC_SECTION_CODES.PAIR_WITNESS_UNREADABLE);
  }
  const plan = result.value;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return available({
      planPresent: false, status: null, expired: null, pairCount: 0,
      states: {}, remaining: 0, batches: null
    });
  }
  const items = Array.isArray(plan.items) ? plan.items : [];
  const states = {};
  for (const item of items) {
    const state = safeCode(item?.state);
    if (!state) continue;
    states[state] = (states[state] || 0) + 1;
  }
  const remaining = items.filter(item => ['pending', 'partial', 'deferred'].includes(item?.state)).length;
  const expiresAt = Number(plan.expiresAt);
  return available({
    planPresent: true,
    status: safeCode(plan.status),
    expired: Number.isFinite(expiresAt) ? expiresAt <= Number(deps.now()) : null,
    pairCount: items.length,
    states,
    remaining,
    batches: safeCount(plan.batches)
  });
}

async function recoveryAttentionSummary(deps, orgId, codes) {
  try {
    const records = await deps.listReconciliationAttention(orgId);
    if (!Array.isArray(records)) throw new Error('invalid attention records');
    const summary = summarizeReconciliationAttention(records);
    const reasonCounts = {};
    for (const record of records) {
      const reason = safeCode(record?.reasonCode) || 'UNSPECIFIED';
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }
    return available({ ...summary, reasonCounts });
  } catch {
    codes.add(DIAGNOSTIC_SECTION_CODES.RECOVERY_ATTENTION_UNREADABLE);
    return unavailable(DIAGNOSTIC_SECTION_CODES.RECOVERY_ATTENTION_UNREADABLE);
  }
}

function maintenanceAuditSample(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const safe = sanitizeAuditEntry(entry);
  if (!MAINTENANCE_ACTIONS.has(safe.action)) return null;
  return {
    timestamp: safeTimestamp(safe.timestamp),
    action: safe.action,
    outcome: safeCode(safe.outcome),
    source: safeCode(safe.source),
    site: safeCode(safe.site),
    statusCode: Number.isInteger(safe.statusCode) ? safe.statusCode : null,
    success: safeBoolean(safe.success)
  };
}

async function maintenanceAuditSummary(deps, orgId, codes) {
  const result = await readStored(deps, 'auditLog');
  if (!result.ok || (result.value !== null && result.value !== undefined && !Array.isArray(result.value))) {
    codes.add(DIAGNOSTIC_SECTION_CODES.AUDIT_UNREADABLE);
    return unavailable(DIAGNOSTIC_SECTION_CODES.AUDIT_UNREADABLE);
  }
  const entries = Array.isArray(result.value) ? result.value : [];
  const matching = entries
    .filter(entry => entry?.orgId === orgId)
    .map(maintenanceAuditSample)
    .filter(Boolean);
  const samples = matching.slice(0, DIAGNOSTIC_SAMPLE_LIMIT);
  if (matching.length > samples.length) codes.add(DIAGNOSTIC_SECTION_CODES.AUDIT_TRUNCATED);
  return available({ retainedCount: matching.length, samples, truncated: matching.length > samples.length });
}

async function mappingConfigurationCounts(deps, orgId) {
  const scope = orgId === 'legacy' ? '' : orgId;
  const key = name => scope ? `${name}:${scope}` : name;
  const [projects, users, fields, statuses, issueTypes] = await Promise.all([
    readStored(deps, key('projectMappings')),
    readStored(deps, key('userMappings')),
    readStored(deps, key('fieldMappings')),
    readStored(deps, key('statusMappings')),
    readStored(deps, key('issueTypeMappings'))
  ]);
  return {
    projectMappings: projects.ok ? objectCount(projects.value) : null,
    userMappings: users.ok ? objectCount(users.value) : null,
    fieldMappings: fields.ok ? objectCount(fields.value) : null,
    statusMappings: statuses.ok ? objectCount(statuses.value) : null,
    issueTypeMappings: issueTypes.ok ? objectCount(issueTypes.value) : null
  };
}


async function loadOrganization(deps, orgId) {
  if (orgId === 'legacy') {
    const legacy = await readStored(deps, 'syncConfig');
    if (!legacy.ok) throw new DiagnosticReportError(DIAGNOSTIC_SECTION_CODES.ORGANIZATION_UNREADABLE);
    if (!legacy.value || !legacy.value.remoteUrl) {
      throw new DiagnosticReportError(DIAGNOSTIC_SECTION_CODES.ORGANIZATION_NOT_FOUND);
    }
    return legacy.value;
  }
  const organizations = await readStored(deps, 'organizations');
  if (!organizations.ok) throw new DiagnosticReportError(DIAGNOSTIC_SECTION_CODES.ORGANIZATION_UNREADABLE);
  const list = Array.isArray(organizations.value) ? organizations.value : [];
  const organization = list.find(entry => entry?.id === orgId);
  if (!organization) throw new DiagnosticReportError(DIAGNOSTIC_SECTION_CODES.ORGANIZATION_NOT_FOUND);
  return organization;
}

function boundReport(report, codes) {
  report.limitations = LIMITATIONS.slice();
  const sectionTruncated = [
    report.evidence.mappings?.truncated,
    report.evidence.issueCreateLedger?.truncated,
    report.evidence.errors?.truncated,
    report.evidence.maintenanceAudit?.truncated,
    report.evidence.rateLimits?.truncated
  ].some(Boolean);
  if (sectionTruncated) report.truncated = true;
  const serialized = JSON.stringify(report);
  if (Buffer.byteLength(serialized, 'utf8') <= DIAGNOSTIC_REPORT_MAX_BYTES) return report;
  codes.add(DIAGNOSTIC_SECTION_CODES.REPORT_TRUNCATED);
  report.truncated = true;
  if (Array.isArray(report.evidence.errors?.samples)) {
    report.evidence.errors.samples = report.evidence.errors.samples.slice(0, 3);
  }
  if (Array.isArray(report.evidence.maintenanceAudit?.samples)) {
    report.evidence.maintenanceAudit.samples = report.evidence.maintenanceAudit.samples.slice(0, 3);
  }
  if (Array.isArray(report.evidence.rateLimits?.history)) {
    report.evidence.rateLimits.history = report.evidence.rateLimits.history.slice(0, 2);
  }
  report.statusCodes = Array.from(codes).sort();
  if (Buffer.byteLength(JSON.stringify(report), 'utf8') <= DIAGNOSTIC_REPORT_MAX_BYTES) return report;

  report.evidence.errors = {
    available: report.evidence.errors?.available ?? false,
    samples: [], retainedCount: 0, truncated: true
  };
  report.evidence.maintenanceAudit = {
    available: report.evidence.maintenanceAudit?.available ?? false,
    retainedCount: 0, samples: [], truncated: true
  };
  if (report.evidence.rateLimits) {
    report.evidence.rateLimits.history = [];
    report.evidence.rateLimits.truncated = true;
  }
  return report;
}

function overallStatus(codes) {
  if (codes.has(DIAGNOSTIC_SECTION_CODES.ORGANIZATION_UNREADABLE)
      || codes.has(DIAGNOSTIC_SECTION_CODES.ORGANIZATION_NOT_FOUND)
      || codes.has(DIAGNOSTIC_SECTION_CODES.IDENTITY_UNAVAILABLE)) return 'error';
  return codes.size > 0 ? 'warning' : 'ok';
}

function addSectionCodes(report, codes) {
  for (const section of Object.values(report.evidence)) {
    if (section && section.available === false && section.code) codes.add(section.code);
  }
  const webhook = report.evidence.synchronizationActivity?.webhook;
  if (webhook && webhook.available === false && webhook.code) codes.add(webhook.code);
  const scheduled = report.evidence.synchronizationActivity?.scheduled;
  if (scheduled && scheduled.available === false && scheduled.code) codes.add(scheduled.code);
  if (report.evidence.rateLimits?.available === false && report.evidence.rateLimits.code) {
    codes.add(report.evidence.rateLimits.code);
  }
  const webhookErrors = report.evidence.errors?.webhook;
  if (webhookErrors && webhookErrors.available === false && webhookErrors.code) {
    codes.add(webhookErrors.code);
  }
  const scheduledErrors = report.evidence.errors?.scheduled;
  if (scheduledErrors && scheduledErrors.available === false && scheduledErrors.code) {
    codes.add(scheduledErrors.code);
  }
  if (report.evidence.safety?.pause?.paused === true) codes.add('PAUSE_ACTIVE');
  if (report.evidence.safety?.syncAuthorization?.authorized === false
      && report.evidence.safety.syncAuthorization.reason) {
    codes.add(report.evidence.safety.syncAuthorization.reason);
  }
  if (Number(report.evidence.mappings?.repairCount) > 0) {
    codes.add('MAPPING_REPAIR_RECORDS_PRESENT');
  }
  if (Number(report.evidence.issueCreateLedger?.states?.unknown) > 0
      || Number(report.evidence.issueCreateLedger?.states?.pending) > 0) {
    codes.add('ISSUE_CREATE_ATTENTION_REQUIRED');
  }
  if (Number(report.evidence.recoveryAttention?.open) > 0) {
    codes.add('RECONCILIATION_ATTENTION_OPEN');
  }
}


export async function buildDiagnosticReport({ orgId, deps = {} } = {}) {
  if (typeof orgId !== 'string' || orgId.trim() === '') {
    throw new DiagnosticReportError(DIAGNOSTIC_SECTION_CODES.ORGANIZATION_REQUIRED);
  }
  const selectedOrgId = safeOrganizationId(orgId.trim());
  if (!selectedOrgId) {
    throw new DiagnosticReportError(DIAGNOSTIC_SECTION_CODES.ORGANIZATION_INVALID);
  }
  const d = { ...defaultDeps, ...deps };
  const codes = new Set();
  const organization = await loadOrganization(d, selectedOrgId);

  let context = null;
  try {
    context = d.getAppContext();
  } catch {
    context = null;
  }
  const installation = installationSummary(context, codes);

  const [
    syncOptionsRead, scheduledRead, mappingConfig, mappings, ledger, pause, authorization,
    activity, errors, rateLimits, pairingWitness, recoveryAttention, maintenanceAudit
  ] = await Promise.all([
    readStored(d, selectedOrgId === 'legacy' ? 'syncOptions' : `syncOptions:${selectedOrgId}`),
    readStored(d, 'scheduledSyncConfig'),
    mappingConfigurationCounts(d, selectedOrgId),
    mappingSummary(d, selectedOrgId, codes),
    ledgerSummary(d, selectedOrgId, codes),
    pauseSummary(d, codes),
    authorizationSummary(d, codes),
    activitySummary(d, selectedOrgId, codes),
    errorsSummary(d, selectedOrgId, codes),
    rateLimitSummary(d, selectedOrgId, codes),
    pairWitnessSummary(d, selectedOrgId, codes),
    recoveryAttentionSummary(d, selectedOrgId, codes),
    maintenanceAuditSummary(d, selectedOrgId, codes)
  ]);

  const [tokenPresent, webhookPresent] = await Promise.all([
    readSecretPresent(d, `secret:${selectedOrgId}:token`),
    readSecretPresent(d, `secret:${selectedOrgId}:webhookSigningSecret`)
  ]);
  if (!tokenPresent.ok || !webhookPresent.ok) {
    codes.add(DIAGNOSTIC_SECTION_CODES.TELEMETRY_NOT_RECORDED);
  }
  const syncOptions = syncOptionsRead.ok
    ? syncOptionsSummary(syncOptionsRead.value)
    : unavailable(DIAGNOSTIC_SECTION_CODES.TELEMETRY_NOT_RECORDED);
  const scheduled = scheduledRead.ok
    ? scheduledConfigSummary(scheduledRead.value)
    : unavailable(DIAGNOSTIC_SECTION_CODES.TELEMETRY_NOT_RECORDED);
  if (!syncOptions.available) codes.add(DIAGNOSTIC_SECTION_CODES.TELEMETRY_NOT_RECORDED);
  if (!scheduled.available) codes.add(DIAGNOSTIC_SECTION_CODES.TELEMETRY_NOT_RECORDED);

  const mappingConfiguration = {
    available: Object.values(mappingConfig).every(value => value !== null),
    ...mappingConfig
  };
  const organizationReport = {
    ...organizationIdentity(organization, selectedOrgId),
    credentialConfigured: tokenPresent.present,
    webhookConfigured: webhookPresent.present,
    syncOptions,
    scheduled,
    mappingConfiguration
  };
  if (!mappingConfiguration.available) codes.add(DIAGNOSTIC_SECTION_CODES.TELEMETRY_NOT_RECORDED);

  const generatedMs = Number(d.now());
  const report = {
    schema: DIAGNOSTIC_REPORT_SCHEMA,
    schemaVersion: DIAGNOSTIC_REPORT_VERSION,
    generatedAt: new Date(Number.isFinite(generatedMs) ? generatedMs : Date.now()).toISOString(),
    diagnosticStatus: 'warning',
    statusCodes: [],
    scope: {
      selection: 'explicit-organization',
      organizationId: selectedOrgId,
      organizationName: organizationReport.name
    },
    includedEvidence: [
      'installation', 'organization', 'safety-gates', 'scope-and-mappings',
      'synchronization-activity', 'recorded-errors', 'rate-limits',
      'issue-create-ledger', 'pairing-witness', 'recovery-attention',
      'maintenance-audit'
    ],
    installation,
    evidence: {
      organization: organizationReport,
      safety: { pause, syncAuthorization: authorization },
      mappings,
      issueCreateLedger: ledger,
      synchronizationActivity: activity,
      errors,
      rateLimits,
      pairingWitness,
      recoveryAttention,
      maintenanceAudit
    },
    bounds: {
      errorSamples: DIAGNOSTIC_SAMPLE_LIMIT,
      historySamples: DIAGNOSTIC_HISTORY_LIMIT,
      projectList: DIAGNOSTIC_PROJECT_LIMIT,
      mappingScan: DIAGNOSTIC_SCAN_LIMIT,
      ledgerScan: DIAGNOSTIC_LEDGER_SCAN_LIMIT,
      maxBytes: DIAGNOSTIC_REPORT_MAX_BYTES
    },
    truncated: false,
    limitations: LIMITATIONS.slice()
  };

  addSectionCodes(report, codes);
  const bounded = boundReport(report, codes);
  bounded.statusCodes = Array.from(codes).sort();
  bounded.diagnosticStatus = overallStatus(codes);
  return bounded;
}

