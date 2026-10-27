import { createHash, randomBytes } from 'crypto';
import api, { route } from '@forge/api';
import { Queue } from '@forge/events';
import * as kvsStore from '../storage/kvs.js';
import {
  getRemoteKey,
  getLocalKey,
  getLastSyncedLocalUpdated,
  isValidIssueKey
} from '../storage/mappings.js';
import { getFullIssue } from '../jira/local-client.js';
import { createRemoteIssue, updateRemoteIssue } from './issue-sync.js';
import { isOutboundScopeError } from './outbound-scope.js';
import {
  getIssueCreateOperation,
  ISSUE_CREATE_STATES,
  ISSUE_CREATE_DIRECTIONS
} from './issue-create-operation.js';
import { getPilotPause } from './pilot-pause.js';
import { readWitnessIdentity } from '../readiness/connector-readiness.js';
import {
  evaluatePairWitnessCreateGuard,
  PAIR_WITNESS_GUARD_CODES,
  PAIR_WITNESS_GUARD_DECISIONS
} from './pair-witness-guard.js';
import { formatHttpFailure } from '../../utils/http-error.js';
import { isKeyConflictError } from '../../utils/storage-errors.js';
import {
  PROJECT_ROUTING_REASONS,
  resolveTargetProjectKey
} from './project-routing.js';

export const INITIAL_SYNC_QUEUE_KEY = 'initial-sync-queue';
export const INITIAL_SYNC_JOB_PREFIX = 'initialSyncJob:';
export const INITIAL_SYNC_BATCH_PREFIX = 'initialSyncBatch:';
export const INITIAL_SYNC_LOCK_PREFIX = 'initialSyncLock:';
export const INITIAL_SYNC_BATCH_SIZE = 25;
export const INITIAL_SYNC_PAGE_SIZE = 100;
export const INITIAL_SYNC_MAX_ITEMS_PER_EVENT = 5;
// A single invocation processes at most five items. The 15-minute lease safely
// exceeds the 10-minute processing envelope, and ownership is rechecked before
// every item and checkpoint so expiration is never mistaken for ownership.
export const INITIAL_SYNC_MAX_PROCESSING_WINDOW_MS = 10 * 60 * 1000;
export const INITIAL_SYNC_PROCESSING_LEASE_SECONDS = Math.ceil(
  (INITIAL_SYNC_MAX_PROCESSING_WINDOW_MS * 1.5) / 1000
);
export const INITIAL_SYNC_RECOVERY_AGE_MS = 2 * 60 * 1000;

export const INITIAL_SYNC_STATES = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
  FAILED: 'failed'
});

export const INITIAL_SYNC_CATEGORIES = Object.freeze({
  ELIGIBLE: 'eligible',
  ALREADY_MAPPED: 'already_mapped',
  BLOCKED: 'blocked',
  CONFLICT: 'mapping_conflict'
});

export const INITIAL_SYNC_REASONS = Object.freeze({
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  PREVIEW_CHECKSUM_REQUIRED: 'PREVIEW_CHECKSUM_REQUIRED',
  PREVIEW_CHECKSUM_MISMATCH: 'PREVIEW_CHECKSUM_MISMATCH',
  CONFIGURATION_CHECKSUM_REQUIRED: 'CONFIGURATION_CHECKSUM_REQUIRED',
  CONFIGURATION_CHECKSUM_MISMATCH: 'CONFIGURATION_CHECKSUM_MISMATCH',
  JOB_ALREADY_ACTIVE: 'JOB_ALREADY_ACTIVE',
  NO_ELIGIBLE_ISSUES: 'NO_ELIGIBLE_ISSUES',
  GLOBAL_PAUSE_ACTIVE: 'GLOBAL_PAUSE_ACTIVE',
  ADMIN_PAUSE: 'ADMIN_PAUSE',
  ADMIN_CANCELLED: 'ADMIN_CANCELLED',
  QUEUE_ENQUEUE_FAILED: 'QUEUE_ENQUEUE_FAILED',
  LEASE_LOST: 'LEASE_LOST',
  LEASE_STORAGE_ERROR: 'LEASE_STORAGE_ERROR',
  SEARCH_FAILED: 'SEARCH_FAILED',
  INVALID_SCOPE: 'INVALID_SCOPE',
  INVALID_ORGANIZATION: 'INVALID_ORGANIZATION',
  INVALID_PROJECT_KEY: 'INVALID_PROJECT_KEY',
  INVALID_MAPPING: 'INVALID_MAPPING',
  INVALID_ISSUE_KEY: 'INVALID_ISSUE_KEY',
  INVALID_ISSUE_TYPE_MAPPING: 'INVALID_ISSUE_TYPE_MAPPING',
  INVALID_PROJECT_MAPPING: 'INVALID_PROJECT_MAPPING',
  ISSUE_SUMMARY_MISSING: 'ISSUE_SUMMARY_MISSING',
  ISSUE_SUMMARY_TOO_LONG: 'ISSUE_SUMMARY_TOO_LONG',
  ISSUE_TYPE_MISSING: 'ISSUE_TYPE_MISSING',
  TARGET_PROJECT_MISSING: 'TARGET_PROJECT_MISSING',
  PROJECT_OUT_OF_SCOPE: 'PROJECT_OUT_OF_SCOPE',
  SUBTASK_PARENT_MISSING: 'SUBTASK_PARENT_MISSING',
  PARENT_OUTSIDE_SCOPE: 'PARENT_OUTSIDE_SCOPE',
  PARENT_NOT_ELIGIBLE: 'PARENT_NOT_ELIGIBLE',
  PARENT_CYCLE: 'PARENT_CYCLE',
  PARENT_NOT_MAPPED: 'PARENT_NOT_MAPPED',
  INVALID_EXISTING_MAPPING: 'INVALID_EXISTING_MAPPING',
  MAPPING_PAIR_INCOMPLETE: 'MAPPING_PAIR_INCOMPLETE',
  MAPPING_REVERSE_CONFLICT: 'MAPPING_REVERSE_CONFLICT',
  CREATE_LEDGER_SUCCEEDED_NO_MAPPING: 'CREATE_LEDGER_SUCCEEDED_NO_MAPPING',
  CREATE_OUTCOME_UNKNOWN: 'CREATE_OUTCOME_UNKNOWN',
  CREATE_IN_PROGRESS: 'CREATE_IN_PROGRESS',
  CREATE_NOT_STARTED: 'CREATE_NOT_STARTED',
  WITNESS_CONFIRMS_EXISTING_PAIR: 'WITNESS_CONFIRMS_EXISTING_PAIR',
  WITNESS_CONFLICT: 'WITNESS_CONFLICT',
  WITNESS_UNVERIFIABLE: 'WITNESS_UNVERIFIABLE',
  WITNESS_IDENTITY_UNAVAILABLE: 'WITNESS_IDENTITY_UNAVAILABLE',
  WITNESS_STORAGE_UNREADABLE: 'WITNESS_STORAGE_UNREADABLE',
  UPDATE_NOT_STARTED: 'UPDATE_NOT_STARTED',
  UPDATE_SKIPPED: 'UPDATE_SKIPPED',
  UPDATED: 'UPDATED',
  ALREADY_MAPPED: 'ALREADY_MAPPED',
  ALREADY_CURRENT: 'ALREADY_CURRENT',
  ISSUE_READ_FAILED: 'ISSUE_READ_FAILED',
  JOB_BATCH_MISSING: 'JOB_BATCH_MISSING',
  TARGET_CONFIGURATION_CHANGED: 'TARGET_CONFIGURATION_CHANGED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  ORGANIZATION_NOT_FOUND: 'ORGANIZATION_NOT_FOUND',
  CREDENTIAL_MISSING: 'CREDENTIAL_MISSING'
});

const ORG_ID_PATTERN = /^(?:org-[0-9]+|legacy)$/;
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,49}$/;
const SAFE_REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_PREVIEW_PAGES = 1000;
const MAX_JQL_LENGTH = 500;
const MAX_SUMMARY_LENGTH = 255;

export class InitialSyncError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InitialSyncError';
    this.code = SAFE_REASON_PATTERN.test(code) ? code : INITIAL_SYNC_REASONS.INTERNAL_ERROR;
  }
}

function normalizeOrgId(orgId) {
  if (typeof orgId !== 'string' || !ORG_ID_PATTERN.test(orgId)) {
    throw new InitialSyncError(
      INITIAL_SYNC_REASONS.INVALID_ORGANIZATION,
      'A valid organization is required.'
    );
  }
  return orgId;
}

function scopeSegment(orgId) {
  return orgId === 'legacy' ? 'legacy' : orgId;
}

export function buildInitialSyncJobKey(orgId) {
  return `${INITIAL_SYNC_JOB_PREFIX}${scopeSegment(normalizeOrgId(orgId))}`;
}

function buildBatchKey(orgId, jobId, batchNumber) {
  return `${INITIAL_SYNC_BATCH_PREFIX}${scopeSegment(orgId)}:${jobId}:${batchNumber}`;
}

function buildLockKey(orgId) {
  return `${INITIAL_SYNC_LOCK_PREFIX}${scopeSegment(orgId)}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashJson(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeMappings(value) {
  return isPlainObject(value) ? value : {};
}

function normalizeBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeRemoteUrl(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

function normalizeSyncOptions(stored) {
  const input = isPlainObject(stored) ? stored : {};
  const options = {
    syncComments: normalizeBoolean(input.syncComments, true),
    syncAttachments: normalizeBoolean(input.syncAttachments, false),
    syncLinks: normalizeBoolean(input.syncLinks, true),
    syncCrossReference: normalizeBoolean(input.syncCrossReference, true),
    forceCheckAttachments: true,
    forceCheckLinks: true,
    recreateDeletedIssues: false,
    automaticReplacementAfterDeletion: false,
    propagateAttachmentDeletions: false
  };
  if (Number.isSafeInteger(input.maxAttachmentSizeBytes) && input.maxAttachmentSizeBytes > 0) {
    options.maxAttachmentSizeBytes = input.maxAttachmentSizeBytes;
  }
  return options;
}

function normalizeConfigurationSnapshot(org, mappings, syncOptions) {
  return {
    version: 1,
    orgId: org.id,
    allowedProjects: Array.isArray(org.allowedProjects)
      ? [...new Set(org.allowedProjects.filter(Boolean))].sort()
      : [],
    jqlFilter: typeof org.jqlFilter === 'string' ? org.jqlFilter.trim() : '',
    remoteUrl: normalizeRemoteUrl(org.remoteUrl),
    remoteProjectKey: typeof org.remoteProjectKey === 'string' ? org.remoteProjectKey : '',
    mappings: {
      userMappings: normalizeMappings(mappings.userMappings),
      fieldMappings: normalizeMappings(mappings.fieldMappings),
      statusMappings: normalizeMappings(mappings.statusMappings),
      issueTypeMappings: normalizeMappings(mappings.issueTypeMappings),
      projectMappings: normalizeMappings(mappings.projectMappings)
    },
    syncOptions: normalizeSyncOptions(syncOptions)
  };
}

function validateScope(configuration) {
  if (!Array.isArray(configuration.allowedProjects) || configuration.allowedProjects.length === 0) {
    throw new InitialSyncError(
      INITIAL_SYNC_REASONS.INVALID_SCOPE,
      'Select at least one allowed project before previewing initial sync.'
    );
  }
  for (const projectKey of configuration.allowedProjects) {
    if (typeof projectKey !== 'string' || !PROJECT_KEY_PATTERN.test(projectKey)) {
      throw new InitialSyncError(
        INITIAL_SYNC_REASONS.INVALID_PROJECT_KEY,
        'The allowed-project configuration contains an invalid project key.'
      );
    }
  }
  if (configuration.jqlFilter.length > MAX_JQL_LENGTH) {
    throw new InitialSyncError(
      INITIAL_SYNC_REASONS.INVALID_SCOPE,
      'The configured JQL filter is too long.'
    );
  }
  if (!PROJECT_KEY_PATTERN.test(configuration.remoteProjectKey)
      && !Object.keys(configuration.mappings.projectMappings).length) {
    throw new InitialSyncError(
      INITIAL_SYNC_REASONS.TARGET_PROJECT_MISSING,
      'A target project is not configured.'
    );
  }
}

async function loadFreshOrganization(orgId) {
  const normalizedOrgId = normalizeOrgId(orgId);
  const organizations = await kvsStore.get('organizations');
  let org = Array.isArray(organizations)
    ? organizations.find(candidate => candidate?.id === normalizedOrgId)
    : null;

  if (!org && normalizedOrgId === 'legacy') {
    const legacy = await kvsStore.get('syncConfig');
    if (legacy && legacy.remoteUrl && legacy.remoteProjectKey) {
      org = {
        id: 'legacy',
        name: 'Legacy Organization',
        remoteUrl: legacy.remoteUrl,
        remoteEmail: legacy.remoteEmail,
        remoteProjectKey: legacy.remoteProjectKey,
        allowedProjects: legacy.allowedProjects || [],
        jqlFilter: legacy.jqlFilter || '',
        syncDirection: legacy.syncDirection || 'push'
      };
    }
  }

  if (!org) {
    throw new InitialSyncError(
      INITIAL_SYNC_REASONS.ORGANIZATION_NOT_FOUND,
      'Organization not found.'
    );
  }

  const token = await kvsStore.getSecret(`secret:${normalizedOrgId}:token`);
  return { ...org, remoteApiToken: token || '' };
}

async function loadPreviewConfiguration(orgId) {
  const normalizedOrgId = normalizeOrgId(orgId);
  const org = await loadFreshOrganization(normalizedOrgId);

  const [userMappings, fieldMappings, statusMappings, issueTypeMappings, projectMappings, syncOptions] =
    await Promise.all([
      kvsStore.get(`userMappings:${org.id}`),
      kvsStore.get(`fieldMappings:${org.id}`),
      kvsStore.get(`statusMappings:${org.id}`),
      kvsStore.get(`issueTypeMappings:${org.id}`),
      kvsStore.get(`projectMappings:${org.id}`),
      kvsStore.get(`syncOptions:${org.id}`)
    ]);

  const mappingSnapshot = {
    userMappings: normalizeMappings(userMappings),
    fieldMappings: normalizeMappings(fieldMappings),
    statusMappings: normalizeMappings(statusMappings),
    issueTypeMappings: normalizeMappings(issueTypeMappings),
    projectMappings: normalizeMappings(projectMappings)
  };
  const configuration = normalizeConfigurationSnapshot(org, mappingSnapshot, syncOptions);
  validateScope(configuration);

  return {
    org,
    configuration,
    configurationChecksum: hashJson(configuration)
  };
}


function buildProjectJql(projectKey, configuration) {
  const filter = configuration.jqlFilter
    ? `project = ${projectKey} AND (${configuration.jqlFilter})`
    : `project = ${projectKey}`;
  return `${filter} ORDER BY key ASC`;
}

async function searchScopedIssues(configuration) {
  const byKey = new Map();
  const seenTokens = new Set();

  for (const projectKey of configuration.allowedProjects) {
    let nextPageToken = null;
    let pageCount = 0;

    do {
      pageCount += 1;
      if (pageCount > MAX_PREVIEW_PAGES) {
        throw new InitialSyncError(
          INITIAL_SYNC_REASONS.SEARCH_FAILED,
          'The configured scope is too large to preview safely.'
        );
      }

      const requestBody = {
        jql: buildProjectJql(projectKey, configuration),
        maxResults: INITIAL_SYNC_PAGE_SIZE,
        fields: ['key', 'summary', 'issuetype', 'status', 'project', 'parent', 'subtasks', 'updated']
      };
      if (nextPageToken) {
        requestBody.nextPageToken = nextPageToken;
      }

      const response = await api.asApp().requestJira(
        route`/rest/api/3/search/jql`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        }
      );

      if (!response?.ok) {
        throw new InitialSyncError(
          INITIAL_SYNC_REASONS.SEARCH_FAILED,
          `Initial-sync preview search failed (${formatHttpFailure(response?.status)}).`
        );
      }

      const data = await response.json();
      const issues = Array.isArray(data?.issues) ? data.issues : [];
      for (const issue of issues) {
        if (issue && typeof issue.key === 'string' && !byKey.has(issue.key)) {
          byKey.set(issue.key, issue);
        }
      }

      const nextToken = typeof data?.nextPageToken === 'string' && data.nextPageToken
        ? data.nextPageToken
        : null;
      if (nextToken && seenTokens.has(nextToken)) {
        throw new InitialSyncError(
          INITIAL_SYNC_REASONS.SEARCH_FAILED,
          'Initial-sync preview pagination did not advance.'
        );
      }
      if (nextToken) {
        seenTokens.add(nextToken);
      }
      nextPageToken = nextToken;
    } while (nextPageToken);
  }

  return Array.from(byKey.values());
}

function resolveMappedIssueType(issueType, issueTypeMappings) {
  if (!isPlainObject(issueTypeMappings)) {
    return { name: issueType?.name, reason: null };
  }
  for (const mapping of Object.values(issueTypeMappings)) {
    if (!isPlainObject(mapping)) {
      return { name: null, reason: INITIAL_SYNC_REASONS.INVALID_ISSUE_TYPE_MAPPING };
    }
    if (mapping.localName === issueType?.name || mapping.localId === issueType?.id) {
      if (typeof mapping.remoteName !== 'string' || mapping.remoteName.trim().length === 0) {
        return { name: null, reason: INITIAL_SYNC_REASONS.INVALID_ISSUE_TYPE_MAPPING };
      }
      return { name: mapping.remoteName, reason: null };
    }
  }
  return { name: issueType?.name, reason: null };
}

function resolveTargetProject(projectKey, configuration) {
  const routing = resolveTargetProjectKey(projectKey, {
    projectMappings: configuration.mappings.projectMappings,
    remoteProjectKey: configuration.remoteProjectKey
  });
  if (routing.key) {
    return { key: routing.key, reason: null };
  }
  return {
    key: null,
    reason: routing.reason === PROJECT_ROUTING_REASONS.INVALID_PROJECT_MAPPING
      ? INITIAL_SYNC_REASONS.INVALID_PROJECT_MAPPING
      : INITIAL_SYNC_REASONS.TARGET_PROJECT_MISSING
  };
}

function validateIssueForCreate(issue, configuration) {
  const fields = issue?.fields;
  const projectKey = fields?.project?.key;
  if (typeof projectKey !== 'string' || !configuration.allowedProjects.includes(projectKey)) {
    return INITIAL_SYNC_REASONS.PROJECT_OUT_OF_SCOPE;
  }
  if (typeof fields?.summary !== 'string' || fields.summary.trim().length === 0) {
    return INITIAL_SYNC_REASONS.ISSUE_SUMMARY_MISSING;
  }
  if (fields.summary.length > MAX_SUMMARY_LENGTH) {
    return INITIAL_SYNC_REASONS.ISSUE_SUMMARY_TOO_LONG;
  }
  if (!fields?.issuetype || typeof fields.issuetype.name !== 'string') {
    return INITIAL_SYNC_REASONS.ISSUE_TYPE_MISSING;
  }
  if (fields.issuetype.subtask === true && !fields?.parent?.key) {
    return INITIAL_SYNC_REASONS.SUBTASK_PARENT_MISSING;
  }
  const issueType = resolveMappedIssueType(fields.issuetype, configuration.mappings.issueTypeMappings);
  if (issueType.reason) {
    return issueType.reason;
  }
  const targetProject = resolveTargetProject(projectKey, configuration);
  if (targetProject.reason) {
    return targetProject.reason;
  }
  return null;
}


function validateIssueForUpdate(issue, configuration) {
  const fields = issue?.fields;
  const projectKey = fields?.project?.key;
  if (typeof projectKey !== 'string' || !configuration.allowedProjects.includes(projectKey)) {
    return INITIAL_SYNC_REASONS.PROJECT_OUT_OF_SCOPE;
  }
  if (typeof fields?.summary !== 'string' || fields.summary.trim().length === 0) {
    return INITIAL_SYNC_REASONS.ISSUE_SUMMARY_MISSING;
  }
  if (fields.summary.length > MAX_SUMMARY_LENGTH) {
    return INITIAL_SYNC_REASONS.ISSUE_SUMMARY_TOO_LONG;
  }
  if (!fields?.issuetype || typeof fields.issuetype.name !== 'string') {
    return INITIAL_SYNC_REASONS.ISSUE_TYPE_MISSING;
  }
  return null;
}

async function existingMappingClassification(issueKey, orgId) {
  const remoteKey = await getRemoteKey(issueKey, orgId);
  if (!remoteKey) {
    return null;
  }
  if (!isValidIssueKey(remoteKey)) {
    return {
      category: INITIAL_SYNC_CATEGORIES.CONFLICT,
      reasonCode: INITIAL_SYNC_REASONS.INVALID_EXISTING_MAPPING
    };
  }
  const localKey = await getLocalKey(remoteKey, orgId);
  if (!localKey) {
    return {
      category: INITIAL_SYNC_CATEGORIES.CONFLICT,
      reasonCode: INITIAL_SYNC_REASONS.MAPPING_PAIR_INCOMPLETE
    };
  }
  if (localKey !== issueKey) {
    return {
      category: INITIAL_SYNC_CATEGORIES.CONFLICT,
      reasonCode: INITIAL_SYNC_REASONS.MAPPING_REVERSE_CONFLICT
    };
  }
  return { category: INITIAL_SYNC_CATEGORIES.ALREADY_MAPPED, reasonCode: null };
}

async function createLedgerClassification(issueKey, orgId) {
  const operation = await getIssueCreateOperation({
    orgId,
    direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
    sourceKey: issueKey
  });
  if (!operation) {
    return null;
  }
  if (operation.state === ISSUE_CREATE_STATES.SUCCEEDED) {
    return {
      category: INITIAL_SYNC_CATEGORIES.CONFLICT,
      reasonCode: INITIAL_SYNC_REASONS.CREATE_LEDGER_SUCCEEDED_NO_MAPPING
    };
  }
  if (operation.state === ISSUE_CREATE_STATES.UNKNOWN) {
    return {
      category: INITIAL_SYNC_CATEGORIES.CONFLICT,
      reasonCode: INITIAL_SYNC_REASONS.CREATE_OUTCOME_UNKNOWN
    };
  }
  if (operation.state === ISSUE_CREATE_STATES.PENDING) {
    return {
      category: INITIAL_SYNC_CATEGORIES.CONFLICT,
      reasonCode: typeof operation.submissionStartedAt === 'string'
        ? INITIAL_SYNC_REASONS.CREATE_OUTCOME_UNKNOWN
        : INITIAL_SYNC_REASONS.CREATE_IN_PROGRESS
    };
  }
  return null;
}

async function witnessClassification(issue, orgId, org, identity) {
  if (!org || org.id === 'legacy') {
    return null;
  }
  const gate = await evaluatePairWitnessCreateGuard({
    orgId,
    org,
    direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
    sourceKey: issue.key,
    sourceIssueId: issue.id,
    identity
  });
  if (gate.decision === PAIR_WITNESS_GUARD_DECISIONS.ALLOW) {
    return null;
  }

  if (gate.code === PAIR_WITNESS_GUARD_CODES.PAIR_PROVEN) {
    return {
      category: INITIAL_SYNC_CATEGORIES.CONFLICT,
      reasonCode: INITIAL_SYNC_REASONS.WITNESS_CONFIRMS_EXISTING_PAIR
    };
  }
  if (gate.code === PAIR_WITNESS_GUARD_CODES.IDENTITY_UNAVAILABLE) {
    return {
      category: INITIAL_SYNC_CATEGORIES.BLOCKED,
      reasonCode: INITIAL_SYNC_REASONS.WITNESS_IDENTITY_UNAVAILABLE
    };
  }
  if (gate.code === PAIR_WITNESS_GUARD_CODES.STORAGE_UNREADABLE) {
    return {
      category: INITIAL_SYNC_CATEGORIES.BLOCKED,
      reasonCode: INITIAL_SYNC_REASONS.WITNESS_STORAGE_UNREADABLE
    };
  }
  if (gate.code === PAIR_WITNESS_GUARD_CODES.WITNESS_INACCESSIBLE
      || gate.code === PAIR_WITNESS_GUARD_CODES.WITNESS_UNVERIFIABLE
      || gate.code === PAIR_WITNESS_GUARD_CODES.SOURCE_INACCESSIBLE
      || gate.code === PAIR_WITNESS_GUARD_CODES.SOURCE_UNVERIFIABLE
      || gate.code === PAIR_WITNESS_GUARD_CODES.COUNTERPART_INACCESSIBLE
      || gate.code === PAIR_WITNESS_GUARD_CODES.COUNTERPART_UNVERIFIABLE
      || gate.code === PAIR_WITNESS_GUARD_CODES.ORGANIZATION_UNUSABLE) {
    return {
      category: INITIAL_SYNC_CATEGORIES.BLOCKED,
      reasonCode: INITIAL_SYNC_REASONS.WITNESS_UNVERIFIABLE
    };
  }
  // A proven-but-missing or one-sided counterpart is a conflict, not a
  // permission to create. The existing create path would block it anyway.
  return {
    category: INITIAL_SYNC_CATEGORIES.CONFLICT,
    reasonCode: INITIAL_SYNC_REASONS.WITNESS_CONFLICT
  };
}

async function classifyBaseIssue(issue, orgId, configuration, org = null, identity = null) {
  const issueKey = issue.key;
  if (!isValidIssueKey(issueKey)) {
    return {
      issueKey,
      category: INITIAL_SYNC_CATEGORIES.BLOCKED,
      reasonCode: INITIAL_SYNC_REASONS.INVALID_ISSUE_KEY,
      parentKey: null
    };
  }

  const mapped = await existingMappingClassification(issueKey, orgId);
  if (mapped) {
    return {
      issueKey,
      ...mapped,
      parentKey: issue.fields?.parent?.key || null,
      localUpdated: typeof issue.fields?.updated === 'string' ? issue.fields.updated : null
    };
  }

  const ledger = await createLedgerClassification(issueKey, orgId);
  if (ledger) {
    return { issueKey, ...ledger, parentKey: issue.fields?.parent?.key || null };
  }

  // Only issues with no mapping and no in-doubt ledger reach this point. The
  // witness is the last pre-create evidence: it either proves an existing pair,
  // conflicts, or cannot be read. A confirmed 404 keeps the issue eligible.
  const witness = await witnessClassification(issue, orgId, org, identity);
  if (witness) {
    return {
      issueKey,
      ...witness,
      parentKey: issue.fields?.parent?.key || null,
      localUpdated: typeof issue.fields?.updated === 'string' ? issue.fields.updated : null
    };
  }

  const validationReason = validateIssueForCreate(issue, configuration);
  return {
    issueKey,
    category: validationReason
      ? INITIAL_SYNC_CATEGORIES.BLOCKED
      : INITIAL_SYNC_CATEGORIES.ELIGIBLE,
    reasonCode: validationReason,
    parentKey: typeof issue.fields?.parent?.key === 'string' ? issue.fields.parent.key : null
  };
}

function computeParentDepths(records) {
  const byKey = new Map(records.map(record => [record.issueKey, record]));
  const state = new Map();
  const depths = new Map();
  const cycleKeys = new Set();

  const visit = (key, path) => {
    if (state.get(key) === 'done') {
      return depths.get(key);
    }
    if (state.get(key) === 'visiting') {
      const cycleStart = path.indexOf(key);
      if (cycleStart >= 0) {
        path.slice(cycleStart).forEach(cycleKey => cycleKeys.add(cycleKey));
      }
      return null;
    }

    state.set(key, 'visiting');
    path.push(key);
    const parentKey = byKey.get(key)?.parentKey;
    let depth = 0;
    if (parentKey) {
      if (!byKey.has(parentKey)) {
        depth = null;
      } else {
        const parentDepth = visit(parentKey, path);
        depth = parentDepth === null ? null : parentDepth + 1;
      }
    }
    path.pop();
    state.set(key, 'done');
    depths.set(key, depth);
    return depth;
  };

  for (const record of records) {
    visit(record.issueKey, []);
  }
  return { depths, cycleKeys };
}

function applyParentSafety(records) {
  const byKey = new Map(records.map(record => [record.issueKey, record]));
  const { depths, cycleKeys } = computeParentDepths(records);

  for (const record of records) {
    if (record.parentKey && !byKey.has(record.parentKey)) {
      if (record.category === INITIAL_SYNC_CATEGORIES.ELIGIBLE) {
        record.category = INITIAL_SYNC_CATEGORIES.BLOCKED;
        record.reasonCode = INITIAL_SYNC_REASONS.PARENT_OUTSIDE_SCOPE;
      }
      record.parentDepth = null;
      continue;
    }
    if (cycleKeys.has(record.issueKey) || depths.get(record.issueKey) === null) {
      if (record.category === INITIAL_SYNC_CATEGORIES.ELIGIBLE) {
        record.category = INITIAL_SYNC_CATEGORIES.BLOCKED;
        record.reasonCode = INITIAL_SYNC_REASONS.PARENT_CYCLE;
      }
      record.parentDepth = null;
      continue;
    }
    record.parentDepth = depths.get(record.issueKey) || 0;
  }

  const ordered = [...records].sort((left, right) => {
    const leftDepth = left.parentDepth === null ? Number.MAX_SAFE_INTEGER : left.parentDepth;
    const rightDepth = right.parentDepth === null ? Number.MAX_SAFE_INTEGER : right.parentDepth;
    if (leftDepth !== rightDepth) return leftDepth - rightDepth;
    return left.issueKey.localeCompare(right.issueKey);
  });

  for (const record of ordered) {
    if (record.category !== INITIAL_SYNC_CATEGORIES.ELIGIBLE || !record.parentKey) {
      continue;
    }
    const parent = byKey.get(record.parentKey);
    if (!parent) {
      record.category = INITIAL_SYNC_CATEGORIES.BLOCKED;
      record.reasonCode = INITIAL_SYNC_REASONS.PARENT_OUTSIDE_SCOPE;
      continue;
    }
    if (parent.category === INITIAL_SYNC_CATEGORIES.BLOCKED
        || parent.category === INITIAL_SYNC_CATEGORIES.CONFLICT) {
      record.category = INITIAL_SYNC_CATEGORIES.BLOCKED;
      record.reasonCode = INITIAL_SYNC_REASONS.PARENT_NOT_ELIGIBLE;
    }
  }

  return ordered;
}


function groupClassification(records, configurationChecksum) {
  const groups = {
    eligible: [],
    alreadyMapped: [],
    blockedByValidation: [],
    mappingConflicts: []
  };
  const reasons = {
    blockedByValidation: {},
    mappingConflicts: {}
  };

  for (const record of records) {
    if (record.category === INITIAL_SYNC_CATEGORIES.ELIGIBLE) {
      groups.eligible.push(record);
    } else if (record.category === INITIAL_SYNC_CATEGORIES.ALREADY_MAPPED) {
      groups.alreadyMapped.push(record);
    } else if (record.category === INITIAL_SYNC_CATEGORIES.BLOCKED) {
      groups.blockedByValidation.push(record);
      const reason = record.reasonCode || INITIAL_SYNC_REASONS.INVALID_MAPPING;
      reasons.blockedByValidation[reason] = (reasons.blockedByValidation[reason] || 0) + 1;
    } else {
      groups.mappingConflicts.push(record);
      const reason = record.reasonCode || INITIAL_SYNC_REASONS.INVALID_MAPPING;
      reasons.mappingConflicts[reason] = (reasons.mappingConflicts[reason] || 0) + 1;
    }
  }

  const makeGroup = recordsInGroup => ({
    count: recordsInGroup.length,
    issueKeys: recordsInGroup.map(record => record.issueKey)
  });

  return {
    counts: {
      eligible: groups.eligible.length,
      alreadyMapped: groups.alreadyMapped.length,
      blockedByValidation: groups.blockedByValidation.length,
      mappingConflicts: groups.mappingConflicts.length
    },
    classification: {
      eligible: makeGroup(groups.eligible),
      alreadyMapped: makeGroup(groups.alreadyMapped),
      blockedByValidation: {
        ...makeGroup(groups.blockedByValidation),
        reasons: reasons.blockedByValidation
      },
      mappingConflicts: {
        ...makeGroup(groups.mappingConflicts),
        reasons: reasons.mappingConflicts
      }
    },
    canonical: records
      .map(record => [record.issueKey, record.category, record.reasonCode || null])
      .sort((left, right) => left[0].localeCompare(right[0])),
    configurationChecksum
  };
}

function issueKeyGroup(issueKeys) {
  return {
    count: issueKeys.length,
    issueKeys: [...issueKeys]
  };
}

async function localUpdatedForMappedRecord(record) {
  if (typeof record.localUpdated === 'string' && record.localUpdated) {
    return record.localUpdated;
  }
  try {
    const issue = await getFullIssue(record.issueKey);
    return typeof issue?.fields?.updated === 'string' ? issue.fields.updated : null;
  } catch {
    return null;
  }
}

/**
 * Split valid mappings into current and outdated source records. The last
 * locally-synced timestamp is the same current-version marker used by the
 * existing scheduled update path. A mapping with no marker is treated as
 * outdated: reconciliation may update its existing counterpart, but it must
 * never create a second remote issue.
 */
async function classifyMappedReconciliationState(records, orgId) {
  const mappedCurrent = [];
  const mappedOutdated = [];
  const candidateKeys = [];

  for (const record of records) {
    if (record.category === INITIAL_SYNC_CATEGORIES.ELIGIBLE) {
      candidateKeys.push(record.issueKey);
      continue;
    }
    if (record.category !== INITIAL_SYNC_CATEGORIES.ALREADY_MAPPED) {
      continue;
    }

    const localUpdated = await localUpdatedForMappedRecord(record);
    let lastSynced = null;
    try {
      lastSynced = await getLastSyncedLocalUpdated(record.issueKey, orgId);
    } catch {
      lastSynced = null;
    }
    if (typeof localUpdated === 'string' && localUpdated
        && lastSynced === localUpdated) {
      mappedCurrent.push(record.issueKey);
    } else {
      mappedOutdated.push(record.issueKey);
      candidateKeys.push(record.issueKey);
    }
  }

  return {
    candidateKeys,
    mappedCurrent: issueKeyGroup(mappedCurrent),
    mappedOutdated: issueKeyGroup(mappedOutdated)
  };
}

async function buildPreview(orgId, { includeMappedReconciliation = false } = {}) {
  const loaded = await loadPreviewConfiguration(orgId);
  const issues = await searchScopedIssues(loaded.configuration);
  const records = [];

  // One installation-identity read per preview. An unreadable identity makes
  // every otherwise-eligible issue blocked, because its witness could not be
  // attributed; no issue is silently treated as new.
  let witnessIdentity = null;
  try {
    witnessIdentity = await readWitnessIdentity();
  } catch {
    witnessIdentity = null;
  }

  for (const issue of issues) {
    records.push(await classifyBaseIssue(
      issue,
      orgId,
      loaded.configuration,
      loaded.org,
      witnessIdentity
    ));
  }

  const ordered = applyParentSafety(records);
  const grouped = groupClassification(ordered, loaded.configurationChecksum);
  const previewChecksum = hashJson({
    configuration: loaded.configuration,
    classification: grouped.canonical,
    version: 1
  });

  const preview = {
    org: loaded.org,
    configuration: loaded.configuration,
    configurationChecksum: loaded.configurationChecksum,
    previewChecksum,
    counts: grouped.counts,
    classification: grouped.classification,
    totalIssues: ordered.length,
    generatedAt: new Date().toISOString()
  };

  if (includeMappedReconciliation) {
    const mappedState = await classifyMappedReconciliationState(ordered, orgId);
    preview.classification = {
      ...preview.classification,
      mappedCurrent: mappedState.mappedCurrent,
      mappedOutdated: mappedState.mappedOutdated,
      reconciliationCandidates: issueKeyGroup(mappedState.candidateKeys)
    };
    preview.reconciliation = {
      candidateKeys: mappedState.candidateKeys,
      mappedCurrent: mappedState.mappedCurrent,
      mappedOutdated: mappedState.mappedOutdated
    };
  }

  return preview;
}

function publicPreview(preview) {
  return {
    counts: preview.counts,
    classification: preview.classification,
    totalIssues: preview.totalIssues,
    previewChecksum: preview.previewChecksum,
    configurationChecksum: preview.configurationChecksum,
    generatedAt: preview.generatedAt
  };
}

function safeFailure(error) {
  const code = error instanceof InitialSyncError && SAFE_REASON_PATTERN.test(error.code)
    ? error.code
    : INITIAL_SYNC_REASONS.INTERNAL_ERROR;
  return {
    success: false,
    code,
    error: error instanceof InitialSyncError
      ? error.message
      : 'Initial sync could not complete safely.'
  };
}

/**
 * Read-only scope preview. It never calls fetch(), creates a queue, or writes
 * KVS/Jira. Only issue keys and safe reason codes are returned.
 */
export async function previewInitialSync({ orgId } = {}) {
  try {
    return { success: true, preview: publicPreview(await buildPreview(normalizeOrgId(orgId))) };
  } catch (error) {
    return safeFailure(error);
  }
}


/**
 * Full preview data for the recurring reconciliation worker. Unlike the public
 * preview response this includes the normalized configuration and organization
 * needed to reuse the exact initial-sync classification and create path. It is
 * server-side only and must never be returned by a resolver.
 */
export async function previewReconciliationCandidates({ orgId } = {}) {
  try {
    const preview = await buildPreview(normalizeOrgId(orgId), {
      includeMappedReconciliation: true
    });
    return { success: true, preview };
  } catch (error) {
    return safeFailure(error);
  }
}

/**
 * Reuse one initial-sync candidate operation without creating a second
 * initial-sync job, cursor or approval record. The reconciliation worker owns
 * its own job state and scheduling.
 */
export async function processReconciliationCandidate({
  orgId,
  org,
  configuration,
  issueKey
} = {}) {
  let normalizedOrgId;
  try {
    normalizedOrgId = normalizeOrgId(orgId);
  } catch (error) {
    return {
      issueKey,
      outcome: 'failed',
      reasonCode: INITIAL_SYNC_REASONS.INVALID_ORGANIZATION
    };
  }
  if (!org || !configuration || !org.remoteApiToken) {
    return {
      issueKey,
      outcome: 'failed',
      reasonCode: INITIAL_SYNC_REASONS.CREDENTIAL_MISSING
    };
  }
  try {
    const pause = await getPilotPause();
    if (pause.paused) {
      return {
        issueKey,
        outcome: 'global_pause',
        reasonCode: INITIAL_SYNC_REASONS.GLOBAL_PAUSE_ACTIVE
      };
    }
    return await processSingleItem(
      { orgId: normalizedOrgId, configuration },
      org,
      issueKey,
      { reconcileMapped: true }
    );
  } catch (error) {
    return {
      issueKey,
      outcome: 'failed',
      reasonCode: error instanceof InitialSyncError || isOutboundScopeError(error)
        ? error.code
        : INITIAL_SYNC_REASONS.INTERNAL_ERROR
    };
  }
}

/**
 * Acquire a per-organization processing lease using conditional KVS creation.
 * Every acquisition gets a new cryptographic token. Missing conditional storage
 * and storage failures fail closed with an explicit storage status; only a
 * genuine conditional-write conflict is reported as contention.
 */
export async function acquireInitialSyncProcessingLease({ orgId, jobId, now = Date.now() } = {}) {
  const normalizedOrgId = normalizeOrgId(orgId);
  if (typeof jobId !== 'string' || jobId.length === 0
      || typeof kvsStore.setIfNotExists !== 'function') {
    return { acquired: false, status: 'LEASE_STORAGE_ERROR' };
  }

  const leaseToken = randomBytes(32).toString('hex');
  const acquiredAt = new Date(now).toISOString();
  const expiresAt = new Date(
    now + INITIAL_SYNC_PROCESSING_LEASE_SECONDS * 1000
  ).toISOString();
  const lease = {
    key: buildLockKey(normalizedOrgId),
    jobId,
    leaseToken,
    acquiredAt,
    expiresAt
  };

  try {
    await kvsStore.setIfNotExists(
      lease.key,
      { jobId, leaseToken, acquiredAt, expiresAt },
      INITIAL_SYNC_PROCESSING_LEASE_SECONDS
    );
    return { acquired: true, status: 'ACQUIRED', ...lease };
  } catch (error) {
    if (isKeyConflictError(error)) {
      return { acquired: false, status: 'LEASE_CONTENDED', key: lease.key };
    }
    return { acquired: false, status: 'LEASE_STORAGE_ERROR' };
  }
}

/**
 * Confirm the caller still owns the exact persisted lease. A storage read
 * failure is reported separately and is never treated as ownership.
 */
export async function verifyInitialSyncProcessingLease(lease) {
  if (!lease || typeof lease.key !== 'string' || typeof lease.jobId !== 'string'
      || typeof lease.leaseToken !== 'string') {
    return { owned: false, status: 'LEASE_LOST' };
  }
  try {
    const current = await kvsStore.get(lease.key);
    if (!current || current.jobId !== lease.jobId
        || current.leaseToken !== lease.leaseToken) {
      return { owned: false, status: 'LEASE_LOST' };
    }
    return { owned: true, status: 'OWNED' };
  } catch {
    return { owned: false, status: 'LEASE_STORAGE_ERROR' };
  }
}

/**
 * Release only the exact lease owned by this invocation. Both identifiers must
 * match; a stale invocation can never delete a newer invocation's lease.
 */
export async function releaseInitialSyncProcessingLease(lease) {
  const ownership = await verifyInitialSyncProcessingLease(lease);
  if (!ownership.owned) {
    return { released: false, status: ownership.status };
  }
  try {
    await kvsStore.del(lease.key);
    return { released: true, status: 'RELEASED' };
  } catch {
    return { released: false, status: 'LEASE_STORAGE_ERROR' };
  }
}

async function enqueueInitialSync(orgId, jobId) {
  const queue = new Queue({ key: INITIAL_SYNC_QUEUE_KEY });
  await queue.push({ body: { type: 'initial-sync', orgId, jobId } });
}

function safeJob(job) {
  if (!job) {
    return { state: INITIAL_SYNC_STATES.IDLE };
  }
  return {
    version: job.version,
    jobId: job.jobId,
    orgId: job.orgId,
    state: job.state,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    startedBy: job.startedBy || null,
    completedAt: job.completedAt || null,
    pausedAt: job.pausedAt || null,
    cancelledAt: job.cancelledAt || null,
    failedAt: job.failedAt || null,
    previewChecksum: job.previewChecksum,
    configurationChecksum: job.configurationChecksum,
    scope: job.scope,
    counts: job.counts,
    progress: job.progress,
    lastConfirmedKey: job.lastConfirmedKey || null,
    reasonCode: job.reasonCode || null
  };
}

export async function getInitialSyncJob(orgId) {
  const normalizedOrgId = normalizeOrgId(orgId);
  const stored = await kvsStore.get(buildInitialSyncJobKey(normalizedOrgId));
  if (!stored || typeof stored !== 'object' || stored.orgId !== normalizedOrgId) {
    return null;
  }
  return stored;
}

export async function getInitialSyncStatus({ orgId } = {}) {
  try {
    const job = await getInitialSyncJob(normalizeOrgId(orgId));
    return { success: true, status: safeJob(job) };
  } catch (error) {
    return safeFailure(error);
  }
}

function newJobId() {
  return `job-${Date.now()}-${randomBytes(8).toString('hex')}`;
}

function initialCounts(preview) {
  return {
    eligibleTotal: preview.counts.eligible,
    created: 0,
    alreadyMapped: preview.counts.alreadyMapped,
    blocked: preview.counts.blockedByValidation,
    mappingConflicts: preview.counts.mappingConflicts,
    skipped: 0,
    reconciliationRequired: 0,
    failed: 0,
    cancelled: 0
  };
}


/**
 * Explicit administrator-approved start. The preview is recomputed from
 * current configuration, mappings and scope; any drift rejects execution.
 */
export async function startInitialSync({
  orgId,
  approved = false,
  previewChecksum,
  configurationChecksum,
  startedBy = null
} = {}) {
  try {
    const normalizedOrgId = normalizeOrgId(orgId);
    if (approved !== true) {
      return {
        success: false,
        code: INITIAL_SYNC_REASONS.APPROVAL_REQUIRED,
        error: 'Explicit administrator approval is required.'
      };
    }
    if (typeof previewChecksum !== 'string' || previewChecksum.length === 0) {
      return {
        success: false,
        code: INITIAL_SYNC_REASONS.PREVIEW_CHECKSUM_REQUIRED,
        error: 'Preview checksum is required.'
      };
    }
    if (typeof configurationChecksum !== 'string' || configurationChecksum.length === 0) {
      return {
        success: false,
        code: INITIAL_SYNC_REASONS.CONFIGURATION_CHECKSUM_REQUIRED,
        error: 'Configuration checksum is required.'
      };
    }

    const existing = await getInitialSyncJob(normalizedOrgId);
    if (existing && (existing.state === INITIAL_SYNC_STATES.RUNNING
        || existing.state === INITIAL_SYNC_STATES.PAUSED)) {
      return {
        success: false,
        code: INITIAL_SYNC_REASONS.JOB_ALREADY_ACTIVE,
        error: 'An initial-sync job is already active for this organization.'
      };
    }

    const pause = await getPilotPause();
    if (pause.paused) {
      return {
        success: false,
        code: INITIAL_SYNC_REASONS.GLOBAL_PAUSE_ACTIVE,
        error: 'Global Jira writes are paused. Resume writes before starting initial sync.'
      };
    }

    const preview = await buildPreview(normalizedOrgId);
    if (preview.configurationChecksum !== configurationChecksum) {
      return {
        success: false,
        code: INITIAL_SYNC_REASONS.CONFIGURATION_CHECKSUM_MISMATCH,
        error: 'Project, mapping, option, or JQL configuration changed after preview. Run preview again.'
      };
    }
    if (preview.previewChecksum !== previewChecksum) {
      return {
        success: false,
        code: INITIAL_SYNC_REASONS.PREVIEW_CHECKSUM_MISMATCH,
        error: 'The previewed scope changed after preview. Run preview again.'
      };
    }
    if (preview.counts.eligible === 0) {
      return {
        success: false,
        code: INITIAL_SYNC_REASONS.NO_ELIGIBLE_ISSUES,
        error: 'No eligible issues remain for initial sync.'
      };
    }
    if (!preview.org.remoteApiToken) {
      return {
        success: false,
        code: INITIAL_SYNC_REASONS.CREDENTIAL_MISSING,
        error: 'The target organization credential is missing.'
      };
    }


    const jobId = newJobId();
    const eligibleKeys = preview.classification.eligible.issueKeys;
    const totalBatches = Math.ceil(eligibleKeys.length / INITIAL_SYNC_BATCH_SIZE);
    for (let batchNumber = 0; batchNumber < totalBatches; batchNumber += 1) {
      const start = batchNumber * INITIAL_SYNC_BATCH_SIZE;
      const batchKeys = eligibleKeys.slice(start, start + INITIAL_SYNC_BATCH_SIZE);
      await kvsStore.set(
        buildBatchKey(normalizedOrgId, jobId, batchNumber),
        { keys: batchKeys }
      );
    }

    const timestamp = new Date().toISOString();
    const job = {
      version: 1,
      jobId,
      orgId: normalizedOrgId,
      state: INITIAL_SYNC_STATES.RUNNING,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: timestamp,
      startedBy: typeof startedBy === 'string' ? startedBy.slice(0, 100) : null,
      previewChecksum,
      configurationChecksum,
      scope: {
        allowedProjects: preview.configuration.allowedProjects,
        jqlFilter: preview.configuration.jqlFilter,
        remoteProjectKey: preview.configuration.remoteProjectKey
      },
      configuration: preview.configuration,
      counts: initialCounts(preview),
      progress: {
        total: eligibleKeys.length,
        processed: 0,
        remaining: eligibleKeys.length
      },
      cursor: { batch: 0, index: 0 },
      batchSize: INITIAL_SYNC_BATCH_SIZE,
      totalBatches,
      lastConfirmedKey: null,
      reasonCode: null,
      completedAt: null
    };

    await kvsStore.set(buildInitialSyncJobKey(normalizedOrgId), job);

    try {
      await enqueueInitialSync(normalizedOrgId, jobId);
    } catch {
      job.state = INITIAL_SYNC_STATES.PAUSED;
      job.reasonCode = INITIAL_SYNC_REASONS.QUEUE_ENQUEUE_FAILED;
      job.updatedAt = new Date().toISOString();
      await kvsStore.set(buildInitialSyncJobKey(normalizedOrgId), job);
      return {
        success: false,
        code: INITIAL_SYNC_REASONS.QUEUE_ENQUEUE_FAILED,
        error: 'The job was saved but could not be queued. Use Resume to retry.'
      };
    }

    return { success: true, job: safeJob(job) };
  } catch (error) {
    return safeFailure(error);
  }
}


export async function pauseInitialSync({ orgId } = {}) {
  try {
    const normalizedOrgId = normalizeOrgId(orgId);
    const job = await getInitialSyncJob(normalizedOrgId);
    if (!job) {
      return { success: false, code: 'INITIAL_SYNC_NOT_FOUND', error: 'No initial-sync job exists.' };
    }
    if (job.state === INITIAL_SYNC_STATES.PAUSED) {
      return { success: true, job: safeJob(job), idempotent: true };
    }
    if (job.state !== INITIAL_SYNC_STATES.RUNNING) {
      return {
        success: false,
        code: 'INITIAL_SYNC_NOT_RUNNING',
        error: 'Only a running initial-sync job can be paused.'
      };
    }
    const timestamp = new Date().toISOString();
    const next = {
      ...job,
      state: INITIAL_SYNC_STATES.PAUSED,
      reasonCode: INITIAL_SYNC_REASONS.ADMIN_PAUSE,
      pausedAt: timestamp,
      updatedAt: timestamp
    };
    await kvsStore.set(buildInitialSyncJobKey(normalizedOrgId), next);
    return { success: true, job: safeJob(next) };
  } catch (error) {
    return safeFailure(error);
  }
}

export async function resumeInitialSync({ orgId } = {}) {
  try {
    const normalizedOrgId = normalizeOrgId(orgId);
    const job = await getInitialSyncJob(normalizedOrgId);
    if (!job) {
      return { success: false, code: 'INITIAL_SYNC_NOT_FOUND', error: 'No initial-sync job exists.' };
    }
    if (job.state === INITIAL_SYNC_STATES.RUNNING) {
      return { success: true, job: safeJob(job), idempotent: true };
    }
    if (job.state !== INITIAL_SYNC_STATES.PAUSED) {
      return {
        success: false,
        code: 'INITIAL_SYNC_NOT_PAUSED',
        error: 'Only a paused initial-sync job can be resumed.'
      };
    }
    const pause = await getPilotPause();
    if (pause.paused) {
      return {
        success: false,
        code: INITIAL_SYNC_REASONS.GLOBAL_PAUSE_ACTIVE,
        error: 'Global Jira writes are still paused.'
      };
    }

    await loadOrganizationForJob(normalizedOrgId, job.configuration);
    const timestamp = new Date().toISOString();
    const next = {
      ...job,
      state: INITIAL_SYNC_STATES.RUNNING,
      reasonCode: null,
      pausedAt: null,
      resumedAt: timestamp,
      updatedAt: timestamp
    };
    await kvsStore.set(buildInitialSyncJobKey(normalizedOrgId), next);
    try {
      await enqueueInitialSync(normalizedOrgId, next.jobId);
    } catch {
      next.state = INITIAL_SYNC_STATES.PAUSED;
      next.reasonCode = INITIAL_SYNC_REASONS.QUEUE_ENQUEUE_FAILED;
      next.updatedAt = new Date().toISOString();
      await kvsStore.set(buildInitialSyncJobKey(normalizedOrgId), next);
      return {
        success: false,
        code: INITIAL_SYNC_REASONS.QUEUE_ENQUEUE_FAILED,
        error: 'The job could not be queued. Try Resume again.'
      };
    }
    return { success: true, job: safeJob(next) };
  } catch (error) {
    return safeFailure(error);
  }
}


export async function cancelInitialSync({ orgId } = {}) {
  try {
    const normalizedOrgId = normalizeOrgId(orgId);
    const job = await getInitialSyncJob(normalizedOrgId);
    if (!job) {
      return { success: false, code: 'INITIAL_SYNC_NOT_FOUND', error: 'No initial-sync job exists.' };
    }
    if (job.state === INITIAL_SYNC_STATES.CANCELLED) {
      return { success: true, job: safeJob(job), idempotent: true };
    }
    if (job.state !== INITIAL_SYNC_STATES.RUNNING
        && job.state !== INITIAL_SYNC_STATES.PAUSED) {
      return {
        success: false,
        code: 'INITIAL_SYNC_NOT_ACTIVE',
        error: 'Only a running or paused initial-sync job can be cancelled.'
      };
    }
    const timestamp = new Date().toISOString();
    const remaining = Math.max(0, job.progress.total - job.progress.processed);
    const next = {
      ...job,
      state: INITIAL_SYNC_STATES.CANCELLED,
      reasonCode: INITIAL_SYNC_REASONS.ADMIN_CANCELLED,
      cancelledAt: timestamp,
      updatedAt: timestamp,
      counts: {
        ...job.counts,
        cancelled: remaining
      },
      progress: {
        ...job.progress,
        remaining
      }
    };
    await kvsStore.set(buildInitialSyncJobKey(normalizedOrgId), next);
    return { success: true, job: safeJob(next) };
  } catch (error) {
    return safeFailure(error);
  }
}


async function loadOrganizationForJob(orgId, approvedConfiguration) {
  const org = await loadFreshOrganization(orgId);
  if (!org.remoteApiToken) {
    throw new InitialSyncError(
      INITIAL_SYNC_REASONS.CREDENTIAL_MISSING,
      'The target organization credential is missing.'
    );
  }
  const currentScope = normalizeConfigurationSnapshot(org, {}, {});
  if ((org.jqlFilter != null && typeof org.jqlFilter !== 'string')
      || JSON.stringify(currentScope.allowedProjects) !== JSON.stringify(approvedConfiguration?.allowedProjects)
      || currentScope.jqlFilter !== approvedConfiguration?.jqlFilter
      || normalizeRemoteUrl(org.remoteUrl) !== approvedConfiguration?.remoteUrl
      || (typeof org.remoteProjectKey === 'string' ? org.remoteProjectKey : '')
        !== approvedConfiguration?.remoteProjectKey) {
    throw new InitialSyncError(
      INITIAL_SYNC_REASONS.TARGET_CONFIGURATION_CHANGED,
      'The approved project scope, JQL, or target configuration changed. Run preview again.'
    );
  }
  return org;
}

async function readBatchKeys(job) {
  const batch = await kvsStore.get(
    buildBatchKey(job.orgId, job.jobId, job.cursor.batch)
  );
  if (!batch || !Array.isArray(batch.keys)) {
    throw new InitialSyncError(
      INITIAL_SYNC_REASONS.JOB_BATCH_MISSING,
      'A persisted initial-sync batch is missing.'
    );
  }
  return batch.keys;
}

function jobRemaining(job) {
  return Math.max(0, job.progress.total - job.progress.processed);
}

function advanceCursor(job) {
  job.cursor.index += 1;
  if (job.cursor.index >= job.batchSize) {
    job.cursor.batch += 1;
    job.cursor.index = 0;
  }
}

function applyOutcome(job, outcome) {
  const counts = { ...job.counts };
  if (outcome.outcome === 'created') {
    counts.created += 1;
  } else if (outcome.outcome === 'skipped') {
    counts.skipped += 1;
  } else if (outcome.outcome === 'reconciliation') {
    counts.reconciliationRequired += 1;
  } else if (outcome.outcome === 'failed') {
    counts.failed += 1;
  }
  job.counts = counts;
  job.progress = {
    ...job.progress,
    processed: job.progress.processed + 1,
    remaining: Math.max(0, jobRemaining(job) - 1)
  };
  job.lastConfirmedKey = outcome.issueKey;
  job.updatedAt = new Date().toISOString();
}

async function ledgerOutcome(issueKey, orgId) {
  const operation = await getIssueCreateOperation({
    orgId,
    direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
    sourceKey: issueKey
  });
  if (!operation) {
    return null;
  }
  if (operation.state === ISSUE_CREATE_STATES.UNKNOWN
      || operation.state === ISSUE_CREATE_STATES.SUCCEEDED) {
    return { outcome: 'reconciliation', reasonCode: INITIAL_SYNC_REASONS.CREATE_OUTCOME_UNKNOWN };
  }
  if (operation.state === ISSUE_CREATE_STATES.PENDING) {
    return { outcome: 'skipped', reasonCode: INITIAL_SYNC_REASONS.CREATE_IN_PROGRESS };
  }
  return null;
}

function safeUpdateStatus(value) {
  return typeof value === 'string' && SAFE_REASON_PATTERN.test(value)
    ? value
    : INITIAL_SYNC_REASONS.UPDATE_SKIPPED;
}

async function processMappedItem(job, org, issueKey, remoteKey) {
  if (!isValidIssueKey(remoteKey)) {
    return {
      issueKey,
      outcome: 'failed',
      reasonCode: INITIAL_SYNC_REASONS.INVALID_EXISTING_MAPPING
    };
  }

  const mappedLocalKey = await getLocalKey(remoteKey, job.orgId);
  if (!mappedLocalKey) {
    return {
      issueKey,
      outcome: 'failed',
      reasonCode: INITIAL_SYNC_REASONS.MAPPING_PAIR_INCOMPLETE
    };
  }
  if (mappedLocalKey !== issueKey) {
    return {
      issueKey,
      outcome: 'failed',
      reasonCode: INITIAL_SYNC_REASONS.MAPPING_REVERSE_CONFLICT
    };
  }

  const issue = await getFullIssue(issueKey);
  if (!issue) {
    return { issueKey, outcome: 'failed', reasonCode: INITIAL_SYNC_REASONS.ISSUE_READ_FAILED };
  }

  const validationReason = validateIssueForUpdate(issue, job.configuration);
  if (validationReason) {
    return { issueKey, outcome: 'skipped', reasonCode: validationReason };
  }

  const localUpdated = issue.fields?.updated;
  const lastSynced = await getLastSyncedLocalUpdated(issueKey, job.orgId);
  if (typeof localUpdated === 'string' && localUpdated
      && lastSynced === localUpdated) {
    return {
      issueKey,
      outcome: 'skipped',
      reasonCode: INITIAL_SYNC_REASONS.ALREADY_CURRENT
    };
  }

  let result;
  try {
    org = await loadOrganizationForJob(job.orgId, job.configuration);
    result = await updateRemoteIssue(
      issueKey,
      remoteKey,
      issue,
      org,
      job.configuration.mappings,
      null,
      job.configuration.syncOptions
    );
  } catch (error) {
    if (error?.code === INITIAL_SYNC_REASONS.TARGET_CONFIGURATION_CHANGED || isOutboundScopeError(error)) throw error;
    result = null;
  }

  if (result?.skipped) {
    return {
      issueKey,
      outcome: 'skipped',
      reasonCode: safeUpdateStatus(result.status)
    };
  }
  if (result) {
    return {
      issueKey,
      outcome: 'updated',
      reasonCode: INITIAL_SYNC_REASONS.UPDATED
    };
  }

  const pause = await getPilotPause();
  if (pause.paused) {
    return {
      issueKey,
      outcome: 'global_pause',
      reasonCode: INITIAL_SYNC_REASONS.GLOBAL_PAUSE_ACTIVE
    };
  }

  return {
    issueKey,
    outcome: 'failed',
    reasonCode: INITIAL_SYNC_REASONS.UPDATE_NOT_STARTED
  };
}

async function processSingleItem(job, org, issueKey, { reconcileMapped = false } = {}) {
  org = await loadOrganizationForJob(job.orgId, job.configuration);
  if (!isValidIssueKey(issueKey)) {
    return { issueKey, outcome: 'failed', reasonCode: INITIAL_SYNC_REASONS.INVALID_ISSUE_KEY };
  }

  const currentRemoteKey = await getRemoteKey(issueKey, job.orgId);
  if (currentRemoteKey) {
    if (reconcileMapped) {
      return processMappedItem(job, org, issueKey, currentRemoteKey);
    }
    return {
      issueKey,
      outcome: 'skipped',
      reasonCode: INITIAL_SYNC_REASONS.ALREADY_MAPPED
    };
  }

  const beforeLedger = await ledgerOutcome(issueKey, job.orgId);
  if (beforeLedger) {
    return { issueKey, ...beforeLedger };
  }

  const issue = await getFullIssue(issueKey);
  if (!issue) {
    return { issueKey, outcome: 'failed', reasonCode: INITIAL_SYNC_REASONS.ISSUE_READ_FAILED };
  }

  const validationReason = validateIssueForCreate(issue, job.configuration);
  if (validationReason) {
    return { issueKey, outcome: 'skipped', reasonCode: validationReason };
  }

  const parentKey = issue.fields?.parent?.key;
  if (parentKey) {
    const parentRemoteKey = await getRemoteKey(parentKey, job.orgId);
    if (!parentRemoteKey) {
      return { issueKey, outcome: 'skipped', reasonCode: INITIAL_SYNC_REASONS.PARENT_NOT_MAPPED };
    }
  }

  let result;
  try {
    org = await loadOrganizationForJob(job.orgId, job.configuration);
    result = await createRemoteIssue(
      issue,
      org,
      job.configuration.mappings,
      null,
      job.configuration.syncOptions
    );
  } catch (error) {
    if (error?.code === INITIAL_SYNC_REASONS.TARGET_CONFIGURATION_CHANGED || isOutboundScopeError(error)) throw error;
    result = null;
  }

  if (result?.key) {
    return { issueKey, outcome: 'created', reasonCode: 'CREATED' };
  }

  const pause = await getPilotPause();
  if (pause.paused) {
    return { issueKey, outcome: 'global_pause', reasonCode: INITIAL_SYNC_REASONS.GLOBAL_PAUSE_ACTIVE };
  }

  const mappedAfter = await getRemoteKey(issueKey, job.orgId);
  if (mappedAfter) {
    return {
      issueKey,
      outcome: 'skipped',
      reasonCode: INITIAL_SYNC_REASONS.ALREADY_MAPPED
    };
  }

  const afterLedger = await ledgerOutcome(issueKey, job.orgId);
  if (afterLedger) {
    return { issueKey, ...afterLedger };
  }

  return { issueKey, outcome: 'failed', reasonCode: INITIAL_SYNC_REASONS.CREATE_NOT_STARTED };
}


function completeJob(job) {
  const timestamp = new Date().toISOString();
  job.state = INITIAL_SYNC_STATES.COMPLETED;
  job.completedAt = timestamp;
  job.updatedAt = timestamp;
  job.reasonCode = null;
  job.progress = {
    ...job.progress,
    processed: job.progress.total,
    remaining: 0
  };
  job.counts = {
    ...job.counts,
    cancelled: 0
  };
}

async function markJobFailed(job, code, lease) {
  if (!job || job.state !== INITIAL_SYNC_STATES.RUNNING) {
    return;
  }
  const ownership = await verifyInitialSyncProcessingLease(lease);
  if (!ownership.owned) {
    return;
  }
  const timestamp = new Date().toISOString();
  await kvsStore.set(buildInitialSyncJobKey(job.orgId), {
    ...job,
    state: INITIAL_SYNC_STATES.FAILED,
    reasonCode: SAFE_REASON_PATTERN.test(code) ? code : INITIAL_SYNC_REASONS.INTERNAL_ERROR,
    failedAt: timestamp,
    updatedAt: timestamp
  });
}

function leaseFailureResult(ownership, processed = 0) {
  return {
    success: false,
    code: ownership.status === 'LEASE_STORAGE_ERROR'
      ? INITIAL_SYNC_REASONS.LEASE_STORAGE_ERROR
      : INITIAL_SYNC_REASONS.LEASE_LOST,
    processed
  };
}

/**
 * Process a bounded number of eligible keys. The queue payload contains only
 * identifiers; issue content is fetched at execution time and never persisted.
 */
export async function processInitialSyncJob({
  orgId,
  jobId,
  maxItems = INITIAL_SYNC_MAX_ITEMS_PER_EVENT
} = {}) {
  let normalizedOrgId;
  try {
    normalizedOrgId = normalizeOrgId(orgId);
  } catch (error) {
    return safeFailure(error);
  }

  let lock;
  try {
    lock = await acquireInitialSyncProcessingLease({
      orgId: normalizedOrgId,
      jobId
    });
  } catch {
    return {
      success: false,
      code: INITIAL_SYNC_REASONS.LEASE_STORAGE_ERROR,
      processed: 0
    };
  }
  if (!lock.acquired) {
    if (lock.status === 'LEASE_STORAGE_ERROR') {
      return {
        success: false,
        code: INITIAL_SYNC_REASONS.LEASE_STORAGE_ERROR,
        processed: 0
      };
    }
    return { success: true, processed: 0, code: 'INITIAL_SYNC_JOB_LOCKED' };
  }

  let shouldEnqueue = false;
  let processedThisRun = 0;
  let latestJob = null;
  try {
    latestJob = await getInitialSyncJob(normalizedOrgId);
    if (!latestJob || latestJob.jobId !== jobId) {
      return { success: false, code: 'INITIAL_SYNC_JOB_NOT_FOUND' };
    }
    if (latestJob.state !== INITIAL_SYNC_STATES.RUNNING) {
      return { success: true, processed: 0, state: latestJob.state };
    }

    const pause = await getPilotPause();
    if (pause.paused) {
      const ownership = await verifyInitialSyncProcessingLease(lock);
      if (!ownership.owned) {
        return leaseFailureResult(ownership);
      }
      const timestamp = new Date().toISOString();
      latestJob = {
        ...latestJob,
        state: INITIAL_SYNC_STATES.PAUSED,
        reasonCode: INITIAL_SYNC_REASONS.GLOBAL_PAUSE_ACTIVE,
        pausedAt: timestamp,
        updatedAt: timestamp
      };
      await kvsStore.set(buildInitialSyncJobKey(normalizedOrgId), latestJob);
      return { success: true, processed: 0, state: latestJob.state, code: 'GLOBAL_PAUSE_ACTIVE' };
    }

    const org = await loadOrganizationForJob(normalizedOrgId, latestJob.configuration);
    const limit = Math.max(1, Math.min(Number(maxItems) || INITIAL_SYNC_MAX_ITEMS_PER_EVENT,
      INITIAL_SYNC_MAX_ITEMS_PER_EVENT));

    while (processedThisRun < limit) {
      latestJob = await getInitialSyncJob(normalizedOrgId);
      if (!latestJob || latestJob.jobId !== jobId) {
        return { success: false, code: 'INITIAL_SYNC_JOB_NOT_FOUND', processed: processedThisRun };
      }
      if (latestJob.state !== INITIAL_SYNC_STATES.RUNNING) {
        break;
      }
      const ownership = await verifyInitialSyncProcessingLease(lock);
      if (!ownership.owned) {
        return leaseFailureResult(ownership, processedThisRun);
      }
      if (latestJob.progress.processed >= latestJob.progress.total) {
        completeJob(latestJob);
        await kvsStore.set(buildInitialSyncJobKey(normalizedOrgId), latestJob);
        break;
      }

      const keys = await readBatchKeys(latestJob);
      const issueKey = keys[latestJob.cursor.index];
      if (typeof issueKey !== 'string') {
        await markJobFailed(latestJob, INITIAL_SYNC_REASONS.JOB_BATCH_MISSING, lock);
        return { success: false, code: INITIAL_SYNC_REASONS.JOB_BATCH_MISSING };
      }

      const itemOwnership = await verifyInitialSyncProcessingLease(lock);
      if (!itemOwnership.owned) {
        return leaseFailureResult(itemOwnership, processedThisRun);
      }

      const outcome = await processSingleItem(latestJob, org, issueKey);
      if (outcome.outcome === 'global_pause') {
        const pauseOwnership = await verifyInitialSyncProcessingLease(lock);
        if (!pauseOwnership.owned) {
          return leaseFailureResult(pauseOwnership, processedThisRun);
        }
        const timestamp = new Date().toISOString();
        latestJob = {
          ...latestJob,
          state: INITIAL_SYNC_STATES.PAUSED,
          reasonCode: INITIAL_SYNC_REASONS.GLOBAL_PAUSE_ACTIVE,
          pausedAt: timestamp,
          updatedAt: timestamp
        };
        await kvsStore.set(buildInitialSyncJobKey(normalizedOrgId), latestJob);
        break;
      }

      const current = await getInitialSyncJob(normalizedOrgId);
      if (!current || current.jobId !== jobId) {
        return { success: false, code: 'INITIAL_SYNC_JOB_NOT_FOUND', processed: processedThisRun };
      }
      const checkpointOwnership = await verifyInitialSyncProcessingLease(lock);
      if (!checkpointOwnership.owned) {
        return leaseFailureResult(checkpointOwnership, processedThisRun);
      }

      applyOutcome(current, outcome);
      advanceCursor(current);
      if (current.state === INITIAL_SYNC_STATES.CANCELLED) {
        current.counts.cancelled = jobRemaining(current);
      }
      if (current.progress.processed >= current.progress.total
          && current.state === INITIAL_SYNC_STATES.RUNNING) {
        completeJob(current);
      }
      await kvsStore.set(buildInitialSyncJobKey(normalizedOrgId), current);
      latestJob = current;
      processedThisRun += 1;

      if (latestJob.state !== INITIAL_SYNC_STATES.RUNNING) {
        break;
      }
    }

    shouldEnqueue = latestJob?.state === INITIAL_SYNC_STATES.RUNNING
      && latestJob.progress.processed < latestJob.progress.total;

    if (shouldEnqueue) {
      const continuationOwnership = await verifyInitialSyncProcessingLease(lock);
      if (!continuationOwnership.owned) {
        return leaseFailureResult(continuationOwnership, processedThisRun);
      }
      try {
        await enqueueInitialSync(normalizedOrgId, jobId);
      } catch {
        const job = await getInitialSyncJob(normalizedOrgId).catch(() => null);
        if (job && job.state === INITIAL_SYNC_STATES.RUNNING) {
          const pauseOwnership = await verifyInitialSyncProcessingLease(lock);
          if (pauseOwnership.owned) {
            job.state = INITIAL_SYNC_STATES.PAUSED;
            job.reasonCode = INITIAL_SYNC_REASONS.QUEUE_ENQUEUE_FAILED;
            job.updatedAt = new Date().toISOString();
            await kvsStore.set(buildInitialSyncJobKey(normalizedOrgId), job).catch(() => {});
          }
        }
      }
    }

    return {
      success: true,
      processed: processedThisRun,
      state: latestJob?.state || null,
      progress: latestJob?.progress || null
    };
  } catch (error) {
    await markJobFailed(
      latestJob,
      error instanceof InitialSyncError || isOutboundScopeError(error) ? error.code : INITIAL_SYNC_REASONS.INTERNAL_ERROR,
      lock
    );
    return {
      success: false,
      code: error instanceof InitialSyncError || isOutboundScopeError(error) ? error.code : INITIAL_SYNC_REASONS.INTERNAL_ERROR
    };
  } finally {
    await releaseInitialSyncProcessingLease(lock);
  }
}


/**
 * Requeue persisted running jobs whose async event was lost during a restart.
 * This never resets the cursor and never processes issue content itself.
 */
export async function recoverInitialSyncJobs({ now = Date.now() } = {}) {
  if (typeof kvsStore.queryByPrefix !== 'function') {
    return { success: true, recovered: 0 };
  }

  const entries = await kvsStore.queryByPrefix(INITIAL_SYNC_JOB_PREFIX, 100);
  let recovered = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.key !== 'string' || !entry.key.startsWith(INITIAL_SYNC_JOB_PREFIX)) {
      continue;
    }
    const job = entry.value;
    if (!job || job.state !== INITIAL_SYNC_STATES.RUNNING) {
      continue;
    }
    const updatedAt = Date.parse(job.updatedAt);
    if (!Number.isFinite(updatedAt) || now - updatedAt < INITIAL_SYNC_RECOVERY_AGE_MS) {
      continue;
    }
    try {
      await enqueueInitialSync(job.orgId, job.jobId);
      recovered += 1;
    } catch {
      // A later recovery invocation will try again.
    }
  }
  return { success: true, recovered };
}
