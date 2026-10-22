import { createHash } from 'crypto';
import api, { fetch, route } from '@forge/api';
import * as kvsStore from '../storage/kvs.js';
import { DEFAULT_SYNC_OPTIONS, normalizeSyncOptions } from '../../resolvers/config.js';
import { previewInitialSync } from '../sync/initial-sync.js';
import { getAuthenticatedWebhookReceipt } from '../storage/webhook-receipt.js';

export const SETUP_WIZARD_VERSION = 1;
export const SETUP_WIZARD_PROGRESS_PREFIX = 'setupWizard:';
export const SETUP_WIZARD_METADATA_PREFIX = 'setupWizardMetadata:';

export const SETUP_WIZARD_STEPS = Object.freeze([
  { key: 'connection', index: 1, label: 'Remote Jira connection' },
  { key: 'scope', index: 2, label: 'Source scope' },
  { key: 'direction', index: 3, label: 'Direction' },
  { key: 'mappings', index: 4, label: 'Mappings' },
  { key: 'features', index: 5, label: 'Features' },
  { key: 'webhook', index: 6, label: 'Webhook' },
  { key: 'communication', index: 7, label: 'Communication preflight' },
  { key: 'initial-sync', index: 8, label: 'Initial synchronization' },
  { key: 'review', index: 9, label: 'Review and activation' }
]);

export const SETUP_WIZARD_REQUIRED_WEBHOOK_EVENTS = Object.freeze([
  'jira:issue_created',
  'jira:issue_updated',
  'jira:issue_deleted',
  'comment_created',
  'issuelink_created',
  'issuelink_deleted',
  'attachment_created',
  'attachment_deleted'
]);

const STEP_KEYS = SETUP_WIZARD_STEPS.map(step => step.key);
const STEP_BY_KEY = new Map(SETUP_WIZARD_STEPS.map(step => [step.key, step]));
const ORG_ID_PATTERN = /^(?:org-\d+|legacy)$/;
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,49}$/;
const MAX_JQL_LENGTH = 500;
const MAX_ERROR_LENGTH = 500;

const DEPENDENCIES = Object.freeze({
  connection: [],
  scope: ['connection'],
  direction: ['connection'],
  mappings: ['connection', 'scope'],
  features: ['connection'],
  webhook: ['connection', 'direction'],
  communication: ['connection', 'direction', 'mappings', 'features'],
  'initial-sync': ['connection', 'scope', 'mappings', 'features'],
  review: ['connection', 'scope', 'direction', 'mappings', 'features', 'communication', 'initial-sync']
});

export class SetupWizardError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SetupWizardError';
    this.code = code;
    this.details = details;
  }
}

export function setupWizardProgressKey(orgId) {
  return `${SETUP_WIZARD_PROGRESS_PREFIX}${orgId}`;
}

export function setupWizardMetadataKey(orgId) {
  return `${SETUP_WIZARD_METADATA_PREFIX}${orgId}`;
}

function normalizeOrgId(orgId) {
  if (typeof orgId !== 'string' || !ORG_ID_PATTERN.test(orgId)) {
    throw new SetupWizardError('INVALID_ORG_ID', 'A valid organization is required.');
  }
  return orgId;
}

function normalizeStep(step) {
  if (typeof step === 'number' && Number.isInteger(step)) {
    return SETUP_WIZARD_STEPS[step - 1]?.key || null;
  }
  if (typeof step === 'string' && STEP_BY_KEY.has(step)) {
    return step;
  }
  return null;
}

function safeString(value, maxLength = MAX_ERROR_LENGTH) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function safeStringArray(values) {
  if (!Array.isArray(values)) return [];
  return values
    .filter(value => typeof value === 'string')
    .map(value => safeString(value));
}

function normalizeDirection(value) {
  return value === 'bidirectional' ? 'bidirectional' : 'push';
}

function stepNumber(key) {
  return STEP_BY_KEY.get(key)?.index || 0;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function createValidation(status = 'passed', errors = [], warnings = [], summary = {}) {
  return {
    status,
    errors: safeStringArray(errors),
    warnings: safeStringArray(warnings),
    summary
  };
}

function failedValidation(errors, warnings = [], summary = {}) {
  return createValidation('failed', errors, warnings, summary);
}

function mergeErrors(...results) {
  return results.flatMap(result => safeStringArray(result?.errors));
}

function mergeWarnings(...results) {
  return results.flatMap(result => safeStringArray(result?.warnings));
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

function configurationChecksum(value) {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function normalizedRemoteUrl(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

function connectionConfiguration(org) {
  return {
    remoteUrl: normalizedRemoteUrl(org.remoteUrl),
    remoteEmail: typeof org.remoteEmail === 'string' ? org.remoteEmail.trim() : '',
    remoteProjectKey: typeof org.remoteProjectKey === 'string' ? org.remoteProjectKey.trim() : '',
    hasRemoteApiToken: !!org.remoteApiToken
  };
}

function scopeConfiguration(org) {
  return {
    allowedProjects: (Array.isArray(org.allowedProjects) ? org.allowedProjects : [])
      .filter(value => typeof value === 'string')
      .sort(),
    jqlFilter: typeof org.jqlFilter === 'string' ? org.jqlFilter.trim() : ''
  };
}
function sanitizeMetadata(raw) {
  if (!isPlainObject(raw)) return null;
  if (raw.setupStatus !== 'completed') return null;
  if (Number(raw.setupVersion) !== SETUP_WIZARD_VERSION) return null;
  if (typeof raw.setupCompletedAt !== 'string'
      || Number.isNaN(Date.parse(raw.setupCompletedAt))) {
    return null;
  }
  return {
    setupStatus: 'completed',
    setupVersion: SETUP_WIZARD_VERSION,
    setupCompletedAt: raw.setupCompletedAt
  };
}

function normalizePreflightStatus(value) {
  if (value === 'ready' || value === 'not-ready' || value === 'skipped' || value === 'not-run') {
    return value;
  }
  if (value === 'passed') return 'ready';
  if (value === 'failed') return 'not-ready';
  return 'not-run';
}

function sanitizeCounts(value) {
  if (!isPlainObject(value)) return null;
  const counts = {};
  for (const key of [
    'eligible',
    'alreadyMapped',
    'blockedByValidation',
    'mappingConflicts',
    'matchingIssueCount'
  ]) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) {
      counts[key] = value[key];
    }
  }
  return Object.keys(counts).length > 0 ? counts : null;
}

function sanitizeSummary(stepKey, summary) {
  if (!isPlainObject(summary)) return {};
  switch (stepKey) {
    case 'connection':
      return {
        authenticated: summary.authenticated === true,
        projectAccessible: summary.projectAccessible === true,
        latencyMs: Number.isSafeInteger(summary.latencyMs) ? summary.latencyMs : null,
        configurationChecksum: safeString(summary.configurationChecksum, 128)
      };
    case 'scope':
      return {
        allowedProjects: Array.isArray(summary.allowedProjects)
          ? summary.allowedProjects.filter(value => typeof value === 'string' && PROJECT_KEY_PATTERN.test(value))
          : [],
        jqlFilter: safeString(summary.jqlFilter, MAX_JQL_LENGTH),
        counts: sanitizeCounts(summary.counts),
        configurationChecksum: safeString(summary.configurationChecksum, 128)
      };
    case 'direction':
      return { syncDirection: normalizeDirection(summary.syncDirection) };
    case 'mappings':
      return {
        userMappings: Number.isSafeInteger(summary.userMappings) ? summary.userMappings : 0,
        fieldMappings: Number.isSafeInteger(summary.fieldMappings) ? summary.fieldMappings : 0,
        statusMappings: Number.isSafeInteger(summary.statusMappings) ? summary.statusMappings : 0,
        issueTypeMappings: Number.isSafeInteger(summary.issueTypeMappings) ? summary.issueTypeMappings : 0,
        projectMappings: Number.isSafeInteger(summary.projectMappings) ? summary.projectMappings : 0,
        configurationChecksum: safeString(summary.configurationChecksum, 128)
      };
    case 'features':
      return {
        syncComments: summary.syncComments === true,
        syncCrossReference: summary.syncCrossReference === true,
        syncLinks: summary.syncLinks === true,
        syncAttachments: summary.syncAttachments === true,
        propagateAttachmentDeletions: summary.propagateAttachmentDeletions === true,
        maxAttachmentSizeBytes: Number.isSafeInteger(summary.maxAttachmentSizeBytes)
          ? summary.maxAttachmentSizeBytes
          : null,
        configurationChecksum: safeString(summary.configurationChecksum, 128)
      };
    case 'webhook':
      return {
        required: summary.required === true,
        verified: summary.verified === true,
        callbackConfigured: summary.callbackConfigured === true,
        lastAuthenticatedEventAt: typeof summary.lastAuthenticatedEventAt === 'string'
          ? summary.lastAuthenticatedEventAt
          : null,
        configurationChecksum: safeString(summary.configurationChecksum, 128)
      };
    case 'communication':
      return {
        approved: summary.approved === true,
        preflightOnly: true,
        readOnly: true,
        endToEndSynchronizationVerified: false,
        writesPerformed: 0,
        deletionPerformed: false,
        destructiveSystemTestUsed: false,
        issuesCreated: Array.isArray(summary.issuesCreated)
          ? summary.issuesCreated.filter(value => typeof value === 'string')
          : [],
        aToB: isPlainObject(summary.aToB)
          ? { status: normalizePreflightStatus(summary.aToB.status) }
          : null,
        bToA: isPlainObject(summary.bToA)
          ? { status: normalizePreflightStatus(summary.bToA.status) }
          : null
      };
    case 'initial-sync':
      return {
        choice: summary.choice === 'deferred' ? 'deferred' : 'previewed',
        acknowledged: summary.acknowledged === true,
        counts: sanitizeCounts(summary.counts),
        previewChecksum: safeString(summary.previewChecksum, 128),
        configurationChecksum: safeString(summary.configurationChecksum, 128)
      };
    default:
      return {};
  }
}

function sanitizeValidation(stepKey, value) {
  if (!isPlainObject(value)) return null;
  const status = ['passed', 'warning', 'skipped', 'failed'].includes(value.status)
    ? value.status
    : 'failed';
  return {
    status,
    validatedAt: typeof value.validatedAt === 'string' ? value.validatedAt : null,
    errors: safeStringArray(value.errors),
    warnings: safeStringArray(value.warnings),
    summary: sanitizeSummary(stepKey, value.summary)
  };
}

function sanitizeProgress(raw, orgId) {
  const empty = {
    version: SETUP_WIZARD_VERSION,
    orgId,
    currentStep: 'connection',
    completedSteps: [],
    validations: {},
    choices: {},
    startedAt: null,
    updatedAt: null
  };
  if (!isPlainObject(raw) || raw.orgId !== orgId) return empty;

  const completedSteps = Array.isArray(raw.completedSteps)
    ? STEP_KEYS.filter(key => raw.completedSteps.includes(key))
    : [];
  const validations = {};
  const choices = {};

  for (const key of STEP_KEYS) {
    const validation = sanitizeValidation(key, raw.validations?.[key]);
    if (!validation) continue;
    validations[key] = validation;
    const summary = validation.summary;
    if (key === 'scope' && summary.counts) {
      choices.scope = {
        allowedProjects: summary.allowedProjects,
        jqlFilter: summary.jqlFilter,
        counts: summary.counts
      };
    }
    if (key === 'direction') {
      choices.direction = { syncDirection: summary.syncDirection };
    }
    if (key === 'features') {
      choices.features = summary;
    }
    if (key === 'initial-sync' && summary.counts) {
      choices.initialSync = {
        choice: summary.choice,
        acknowledged: summary.acknowledged,
        counts: summary.counts
      };
    }
  }

  return {
    version: SETUP_WIZARD_VERSION,
    orgId,
    currentStep: normalizeStep(raw.currentStep) || 'connection',
    completedSteps,
    validations,
    choices,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null
  };
}

async function loadOrganization(orgId) {
  const organizations = await kvsStore.get('organizations');
  let org = Array.isArray(organizations)
    ? organizations.find(candidate => candidate?.id === orgId)
    : null;

  if (!org && orgId === 'legacy') {
    const legacy = await kvsStore.get('syncConfig');
    if (legacy && legacy.remoteUrl) {
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
    throw new SetupWizardError('ORGANIZATION_NOT_FOUND', 'Organization not found.');
  }

  const token = await kvsStore.getSecret(`secret:${orgId}:token`);
  return { ...org, remoteApiToken: token || '' };
}

function safeOrganization(org, token, receipt, metadata, hasWebhookSecret) {
  return {
    id: org.id,
    name: typeof org.name === 'string' ? org.name : '',
    remoteUrl: typeof org.remoteUrl === 'string' ? org.remoteUrl : '',
    remoteEmail: typeof org.remoteEmail === 'string' ? org.remoteEmail : '',
    remoteProjectKey: typeof org.remoteProjectKey === 'string' ? org.remoteProjectKey : '',
    allowedProjects: Array.isArray(org.allowedProjects)
      ? org.allowedProjects.filter(value => typeof value === 'string')
      : [],
    jqlFilter: typeof org.jqlFilter === 'string' ? org.jqlFilter : '',
    syncDirection: normalizeDirection(org.syncDirection),
    hasRemoteApiToken: !!token,
    webhookConfigured: hasWebhookSecret === true,
    webhookSecretLastRotatedAt: typeof metadata?.rotatedAt === 'string' ? metadata.rotatedAt : null,
    lastAuthenticatedWebhookAt: receipt?.receivedAt || null
  };
}

function buildStepsView(state) {
  return SETUP_WIZARD_STEPS.map(step => {
    const validation = state.validations[step.key] || null;
    return {
      key: step.key,
      index: step.index,
      label: step.label,
      completed: state.completedSteps.includes(step.key),
      status: validation?.status || 'pending',
      errors: validation?.errors || [],
      warnings: validation?.warnings || []
    };
  });
}

async function buildLoadResult(orgId, org) {
  const [rawProgress, rawMetadata, webhookMetadata, webhookSecret, receipt] = await Promise.all([
    kvsStore.get(setupWizardProgressKey(orgId)),
    kvsStore.get(setupWizardMetadataKey(orgId)),
    kvsStore.get(`webhookSecretMeta:${orgId}`),
    kvsStore.getSecret(`secret:${orgId}:incomingSecret`),
    getAuthenticatedWebhookReceipt(orgId)
  ]);
  const progress = rawProgress ? sanitizeProgress(rawProgress, orgId) : null;
  const metadata = sanitizeMetadata(rawMetadata);
  return {
    success: true,
    setupVersion: SETUP_WIZARD_VERSION,
    organization: safeOrganization(org, org.remoteApiToken, receipt, webhookMetadata, !!webhookSecret),
    state: progress,
    metadata,
    steps: progress ? buildStepsView(progress) : [],
    requiredWebhookEvents: SETUP_WIZARD_REQUIRED_WEBHOOK_EVENTS
  };
}

async function persistProgress(state) {
  const next = {
    ...state,
    version: SETUP_WIZARD_VERSION,
    updatedAt: new Date().toISOString()
  };
  await kvsStore.set(setupWizardProgressKey(state.orgId), next);
  return next;
}

function failureResult(error) {
  if (error instanceof SetupWizardError) {
    return {
      success: false,
      code: error.code,
      error: error.message,
      errors: safeStringArray(error.details.errors),
      warnings: safeStringArray(error.details.warnings),
      ...(typeof error.details.step === 'string'
        ? { step: error.details.step, requiresRevalidation: error.details.step }
        : {})
    };
  }
  return {
    success: false,
    code: 'SETUP_WIZARD_FAILED',
    error: 'Setup wizard action could not be completed.'
  };
}

async function validateConnection(org) {
  const errors = [];
  if (!org.remoteUrl) errors.push('Remote Jira URL is required.');
  if (!org.remoteEmail) errors.push('Remote Jira email is required.');
  if (!org.remoteProjectKey) errors.push('Destination project is required.');
  if (!org.remoteApiToken) errors.push('A remote API token must be saved in secure storage.');

  try {
    const parsed = new URL(org.remoteUrl);
    if (parsed.protocol !== 'https:') {
      errors.push('Remote Jira URL must use HTTPS.');
    }
  } catch {
    errors.push('Remote Jira URL is invalid.');
  }

  if (errors.length > 0) {
    return failedValidation(errors, [], {
      authenticated: false,
      projectAccessible: false,
      latencyMs: null,
      configurationChecksum: configurationChecksum(connectionConfiguration(org))
    });
  }

  const startedAt = Date.now();
  try {
    const auth = Buffer.from(`${org.remoteEmail}:${org.remoteApiToken}`).toString('base64');
    const headers = {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json'
    };
    const baseUrl = org.remoteUrl.replace(/\/$/, '');
    const myselfResponse = await fetch(`${baseUrl}/rest/api/3/myself`, {
      method: 'GET',
      headers
    });
    if (!myselfResponse?.ok) {
      errors.push(`Remote authentication failed (${myselfResponse?.status || 'unknown'}).`);
    } else {
      const projectResponse = await fetch(
        `${baseUrl}/rest/api/3/project/${encodeURIComponent(org.remoteProjectKey)}`,
        { method: 'GET', headers }
      );
      if (!projectResponse?.ok) {
        errors.push(`Destination project is not accessible (${projectResponse?.status || 'unknown'}).`);
      }
    }
  } catch {
    errors.push('Remote Jira connection could not be verified.');
  }

  const authenticated = !errors.some(message => message.startsWith('Remote authentication'));
  const projectAccessible = !errors.some(message => message.startsWith('Destination project'));
  return createValidation(
    errors.length > 0 ? 'failed' : 'passed',
    errors,
    [],
    {
      authenticated,
      projectAccessible,
      latencyMs: Date.now() - startedAt,
      configurationChecksum: configurationChecksum(connectionConfiguration(org))
    }
  );
}

async function validateScope(orgId, org) {
  const errors = [];
  const warnings = [];
  const allowedProjects = Array.isArray(org.allowedProjects)
    ? org.allowedProjects.filter(Boolean)
    : [];

  if (allowedProjects.length === 0) {
    errors.push('Select at least one allowed source project.');
  }
  for (const projectKey of allowedProjects) {
    if (typeof projectKey !== 'string' || !PROJECT_KEY_PATTERN.test(projectKey)) {
      errors.push('The source project selection contains an invalid project key.');
      break;
    }
  }
  if (typeof org.jqlFilter === 'string' && org.jqlFilter.length > MAX_JQL_LENGTH) {
    errors.push(`JQL must be ${MAX_JQL_LENGTH} characters or fewer.`);
  }

  let counts = null;
  if (errors.length === 0) {
    try {
      const preview = await previewInitialSync({ orgId });
      if (!preview?.success || !preview.preview?.counts) {
        errors.push(preview?.error || 'The source scope could not be previewed.');
      } else {
        const rawCounts = preview.preview.counts;
        const eligible = Number(rawCounts.eligible) || 0;
        const alreadyMapped = Number(rawCounts.alreadyMapped) || 0;
        const blockedByValidation = Number(rawCounts.blockedByValidation) || 0;
        const mappingConflicts = Number(rawCounts.mappingConflicts) || 0;
        counts = {
          eligible,
          alreadyMapped,
          blockedByValidation,
          mappingConflicts,
          matchingIssueCount: eligible + alreadyMapped + blockedByValidation + mappingConflicts
        };
        if (counts.matchingIssueCount === 0) {
          warnings.push('The selected scope currently matches no issues.');
        }
      }
    } catch {
      errors.push('The source scope could not be previewed safely.');
    }
  }

  return createValidation(
    errors.length > 0 ? 'failed' : 'passed',
    errors,
    warnings,
    { allowedProjects, jqlFilter: org.jqlFilter || '', counts, configurationChecksum: configurationChecksum(scopeConfiguration(org)) }
  );
}

function validateDirection(org) {
  const direction = org.syncDirection;
  if (direction !== undefined && direction !== null
      && direction !== 'push' && direction !== 'bidirectional') {
    return failedValidation(
      ['Direction must use the existing push or bidirectional setting.'],
      [],
      { syncDirection: 'push' }
    );
  }
  return createValidation('passed', [], [], {
    syncDirection: normalizeDirection(direction)
  });
}

function validateMappingEntries(value, label, errors) {
  if (value === undefined || value === null) return 0;
  if (!isPlainObject(value)) {
    errors.push(`${label} must be a mapping object.`);
    return 0;
  }
  const entries = Object.entries(value);
  if (entries.length > 500) {
    errors.push(`${label} exceeds the existing 500-entry limit.`);
  }
  for (const [sourceId, mapping] of entries) {
    if (!sourceId) {
      errors.push(`${label} contains an empty source key.`);
      continue;
    }
    if (typeof mapping === 'string') {
      if (!mapping.trim()) errors.push(`${label} contains an empty destination value.`);
      continue;
    }
    if (!isPlainObject(mapping)) {
      errors.push(`${label} contains an unsupported entry.`);
      continue;
    }
    if (typeof mapping.localId !== 'string' || !mapping.localId.trim()) {
      errors.push(`${label} contains an entry without a local destination ID.`);
    }
  }
  return entries.length;
}

async function validateMappings(orgId, org) {
  const errors = [];
  const warnings = [];
  const [userMappingsRaw, fieldMappings, statusMappings, issueTypeMappings, projectMappings] =
    await Promise.all([
      kvsStore.get(`userMappings:${orgId}`),
      kvsStore.get(`fieldMappings:${orgId}`),
      kvsStore.get(`statusMappings:${orgId}`),
      kvsStore.get(`issueTypeMappings:${orgId}`),
      kvsStore.get(`projectMappings:${orgId}`)
    ]);

  const userMappings = isPlainObject(userMappingsRaw?.mappings)
    ? userMappingsRaw.mappings
    : userMappingsRaw;
  const counts = {
    userMappings: validateMappingEntries(userMappings, 'User mappings', errors),
    fieldMappings: validateMappingEntries(fieldMappings, 'Field mappings', errors),
    statusMappings: validateMappingEntries(statusMappings, 'Status mappings', errors),
    issueTypeMappings: validateMappingEntries(issueTypeMappings, 'Issue type mappings', errors),
    projectMappings: 0
  };

  if (isPlainObject(issueTypeMappings)) {
    for (const [sourceId, mapping] of Object.entries(issueTypeMappings)) {
      if (typeof mapping === 'string') {
        errors.push(`Issue type mapping ${sourceId} must include a destination issue type name.`);
      } else if (isPlainObject(mapping)
          && (typeof mapping.remoteName !== 'string' || !mapping.remoteName.trim())) {
        errors.push(`Issue type mapping ${sourceId} is missing its destination issue type name.`);
      }
    }
  }

  if (projectMappings !== undefined && projectMappings !== null) {
    if (!isPlainObject(projectMappings)) {
      errors.push('Project mappings must be a mapping object.');
    } else {
      const entries = Object.entries(projectMappings);
      counts.projectMappings = entries.length;
      for (const [sourceProject, targetProject] of entries) {
        if (typeof targetProject !== 'string' || !PROJECT_KEY_PATTERN.test(targetProject)) {
          errors.push(`Project mapping ${sourceProject} has an invalid target project.`);
        }
      }
    }
  }

  const allowedProjects = Array.isArray(org.allowedProjects)
    ? org.allowedProjects.filter(Boolean)
    : [];
  if (allowedProjects.length === 0) {
    errors.push('Source scope must be selected before mappings can be validated.');
  }
  for (const sourceProject of allowedProjects) {
    const mapped = isPlainObject(projectMappings) ? projectMappings[sourceProject] : null;
    if (mapped === undefined || mapped === null) {
      if (!PROJECT_KEY_PATTERN.test(org.remoteProjectKey || '')) {
        errors.push(`No destination project is configured for ${sourceProject}.`);
      }
    }
  }

  if (counts.userMappings === 0) {
    warnings.push('No explicit user mappings are configured; existing automatic user mapping remains in use.');
  }
  if (counts.statusMappings === 0) {
    warnings.push('No status mappings are configured; existing status handling remains in use.');
  }
  if (counts.issueTypeMappings === 0) {
    warnings.push('No issue type mappings are configured; matching names remain in use.');
  }
  if (counts.fieldMappings === 0) {
    warnings.push('No custom field mappings are configured.');
  }

  return createValidation(errors.length > 0 ? 'failed' : 'passed', errors, warnings, {
    ...counts,
    configurationChecksum: configurationChecksum({
      userMappings,
      fieldMappings: fieldMappings ?? null,
      statusMappings: statusMappings ?? null,
      issueTypeMappings: issueTypeMappings ?? null,
      projectMappings: projectMappings ?? null
    })
  });
}

async function validateFeatures(orgId) {
  const stored = await kvsStore.get(`syncOptions:${orgId}`);
  const options = normalizeSyncOptions(stored || DEFAULT_SYNC_OPTIONS);
  const warnings = [];
  if (options.propagateAttachmentDeletions && !options.syncAttachments) {
    warnings.push('Attachment deletion propagation has no effect while attachment synchronization is Off.');
  }
  return createValidation(
    'passed',
    [],
    warnings,
    {
      syncComments: options.syncComments === true,
      syncCrossReference: options.syncCrossReference === true,
      syncLinks: options.syncLinks === true,
      syncAttachments: options.syncAttachments === true,
      propagateAttachmentDeletions: options.propagateAttachmentDeletions === true,
      maxAttachmentSizeBytes: Number.isSafeInteger(options.maxAttachmentSizeBytes)
        ? options.maxAttachmentSizeBytes
        : null,
      configurationChecksum: configurationChecksum(options)
    }
  );
}

async function validateWebhook(orgId, org) {
  if (normalizeDirection(org.syncDirection) !== 'bidirectional') {
    return createValidation('skipped', [], [], {
      required: false,
      verified: true,
      callbackConfigured: false,
      lastAuthenticatedEventAt: null,
      configurationChecksum: configurationChecksum({ required: false, rotatedAt: null })
    });
  }

  const [secret, metadata, receipt] = await Promise.all([
    kvsStore.getSecret(`secret:${orgId}:incomingSecret`),
    kvsStore.get(`webhookSecretMeta:${orgId}`),
    getAuthenticatedWebhookReceipt(orgId)
  ]);
  const errors = [];
  if (!secret) {
    errors.push('A webhook credential must be created before bidirectional setup can continue.');
  }
  if (!receipt) {
    errors.push('No authenticated webhook event has been received.');
  }
  if (receipt && typeof metadata?.rotatedAt === 'string') {
    const rotatedAt = Date.parse(metadata.rotatedAt);
    const receivedAt = Date.parse(receipt.receivedAt);
    if (Number.isFinite(rotatedAt) && Number.isFinite(receivedAt) && receivedAt < rotatedAt) {
      errors.push('The latest webhook credential has not received an authenticated event yet.');
    }
  }

  return createValidation(
    errors.length > 0 ? 'failed' : 'passed',
    errors,
    [],
    {
      required: true,
      verified: errors.length === 0,
      callbackConfigured: !!secret,
      lastAuthenticatedEventAt: receipt?.receivedAt || null,
      configurationChecksum: configurationChecksum({
        required: true,
        rotatedAt: typeof metadata?.rotatedAt === 'string' ? metadata.rotatedAt : null
      })
    }
  );
}

async function verifyRemoteWritePermissions(org) {
  const errors = [];
  try {
    const auth = Buffer.from(`${org.remoteEmail}:${org.remoteApiToken}`).toString('base64');
    const response = await fetch(
      `${org.remoteUrl.replace(/\/$/, '')}/rest/api/3/mypermissions?projectKey=${encodeURIComponent(org.remoteProjectKey)}&permissions=CREATE_ISSUES,EDIT_ISSUES`,
      {
        method: 'GET',
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json'
        }
      }
    );
    if (!response?.ok) {
      errors.push('Remote issue permissions could not be verified.');
      return { ok: false, errors };
    }
    const body = await response.json();
    if (body?.permissions?.CREATE_ISSUES?.havePermission !== true) {
      errors.push('The remote account cannot create issues in the destination project.');
    }
    if (body?.permissions?.EDIT_ISSUES?.havePermission !== true) {
      errors.push('The remote account cannot edit issues in the destination project.');
    }
  } catch {
    errors.push('Remote issue permissions could not be verified.');
  }
  return { ok: errors.length === 0, errors };
}

async function verifyLocalWritePermissions() {
  const errors = [];
  try {
    const response = await api.asApp().requestJira(
      route`/rest/api/3/mypermissions?permissions=CREATE_ISSUES,EDIT_ISSUES`
    );
    if (!response?.ok) {
      errors.push('Local app issue permissions could not be verified.');
      return { ok: false, errors };
    }
    const body = await response.json();
    if (body?.permissions?.CREATE_ISSUES?.havePermission !== true) {
      errors.push('The local app cannot create issues.');
    }
    if (body?.permissions?.EDIT_ISSUES?.havePermission !== true) {
      errors.push('The local app cannot edit issues.');
    }
  } catch {
    errors.push('Local app issue permissions could not be verified.');
  }
  return { ok: errors.length === 0, errors };
}

async function validateCommunication(orgId, org, approved) {
  if (approved !== true) {
    return failedValidation(
      ['Explicit administrator approval is required before running the communication preflight.'],
      [],
      {
        approved: false,
        preflightOnly: true,
        readOnly: true,
        endToEndSynchronizationVerified: false,
        writesPerformed: 0,
        deletionPerformed: false,
        destructiveSystemTestUsed: false,
        issuesCreated: [],
        aToB: { status: 'not-run' },
        bToA: { status: 'not-run' }
      }
    );
  }

  const [connection, mappings, features, webhook, remotePermissions] = await Promise.all([
    validateConnection(org),
    validateMappings(orgId, org),
    validateFeatures(orgId),
    validateWebhook(orgId, org),
    verifyRemoteWritePermissions(org)
  ]);
  const direction = normalizeDirection(org.syncDirection);
  const localPermissions = direction === 'bidirectional'
    ? await verifyLocalWritePermissions()
    : { ok: true, errors: [] };

  const aToBPassed = connection.errors.length === 0
    && mappings.errors.length === 0
    && features.errors.length === 0
    && remotePermissions.ok;
  const bToAPassed = direction === 'bidirectional'
    && webhook.errors.length === 0
    && localPermissions.ok;
  const errors = mergeErrors(
    connection,
    mappings,
    features,
    remotePermissions,
    direction === 'bidirectional' ? webhook : null,
    localPermissions
  );

  return createValidation(
    errors.length > 0 ? 'failed' : 'passed',
    errors,
    mergeWarnings(mappings, features),
    {
      approved: true,
      preflightOnly: true,
      readOnly: true,
      endToEndSynchronizationVerified: false,
      writesPerformed: 0,
      deletionPerformed: false,
      destructiveSystemTestUsed: false,
      issuesCreated: [],
      aToB: { status: aToBPassed ? 'ready' : 'not-ready' },
      bToA: direction === 'bidirectional'
        ? { status: bToAPassed ? 'ready' : 'not-ready' }
        : { status: 'skipped' }
    }
  );
}

async function validateInitialSync(orgId, data) {
  const choice = data?.choice === 'deferred' ? 'deferred' : 'previewed';
  const acknowledged = data?.acknowledged === true;
  const errors = [];
  if (choice === 'deferred' && !acknowledged) {
    errors.push('Acknowledge that initial synchronization is deferred before continuing.');
  }

  let counts = null;
  let previewChecksum = '';
  let configurationChecksum = '';
  try {
    const preview = await previewInitialSync({ orgId });
    if (!preview?.success || !preview.preview?.counts) {
      errors.push(preview?.error || 'Initial synchronization could not be previewed.');
    } else {
      counts = sanitizeCounts(preview.preview.counts);
      previewChecksum = safeString(preview.preview.previewChecksum, 128);
      configurationChecksum = safeString(preview.preview.configurationChecksum, 128);
    }
  } catch {
    errors.push('Initial synchronization could not be previewed safely.');
  }

  return createValidation(
    errors.length > 0 ? 'failed' : 'passed',
    errors,
    [],
    { choice, acknowledged, counts, previewChecksum, configurationChecksum }
  );
}

function dependenciesFor(stepKey) {
  return DEPENDENCIES[stepKey] || [];
}

function missingDependencies(state, stepKey) {
  const completed = new Set(state.completedSteps);
  return dependenciesFor(stepKey).filter(key => !completed.has(key));
}

function firstIncompleteStep(state) {
  return STEP_KEYS.find(key => !state.completedSteps.includes(key)) || 'review';
}

function invalidateFrom(state, stepKey) {
  const invalid = new Set([stepKey]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of STEP_KEYS) {
      if (invalid.has(key)) continue;
      if (dependenciesFor(key).some(dependency => invalid.has(dependency))) {
        invalid.add(key);
        changed = true;
      }
    }
  }

  const validations = { ...state.validations };
  const choices = { ...state.choices };
  for (const key of invalid) {
    delete validations[key];
    if (key === 'scope') delete choices.scope;
    if (key === 'direction') delete choices.direction;
    if (key === 'features') delete choices.features;
    if (key === 'initial-sync') delete choices.initialSync;
  }
  return {
    ...state,
    completedSteps: state.completedSteps.filter(key => !invalid.has(key)),
    validations,
    choices,
    currentStep: stepKey
  };
}

function assertStepOrder(state, stepKey) {
  const index = stepNumber(stepKey);
  const missingPrior = STEP_KEYS
    .slice(0, index - 1)
    .filter(key => !state.completedSteps.includes(key));
  if (missingPrior.length > 0) {
    throw new SetupWizardError(
      'STEP_ORDER_VIOLATION',
      `Complete ${STEP_BY_KEY.get(missingPrior[0])?.label || missingPrior[0]} first.`,
      { errors: [`Missing prerequisite step: ${missingPrior[0]}`] }
    );
  }
  const missing = missingDependencies(state, stepKey);
  if (missing.length > 0) {
    throw new SetupWizardError(
      'STEP_ORDER_VIOLATION',
      `Complete ${STEP_BY_KEY.get(missing[0])?.label || missing[0]} first.`,
      { errors: [`Missing prerequisite validation: ${missing[0]}`] }
    );
  }
}

async function runStepValidation(stepKey, orgId, org, data) {
  switch (stepKey) {
    case 'connection':
      return validateConnection(org);
    case 'scope':
      return validateScope(orgId, org);
    case 'direction':
      return validateDirection(org);
    case 'mappings':
      return validateMappings(orgId, org);
    case 'features':
      return validateFeatures(orgId);
    case 'webhook':
      return validateWebhook(orgId, org);
    case 'communication':
      return validateCommunication(orgId, org, data.approved === true);
    case 'initial-sync':
      return validateInitialSync(orgId, data);
    default:
      throw new SetupWizardError('INVALID_STEP', 'This step cannot be validated directly.');
  }
}

async function startSetupWizard(orgId, org) {
  const existing = await kvsStore.get(setupWizardProgressKey(orgId));
  if (existing) {
    return await buildLoadResult(orgId, org);
  }

  const now = new Date().toISOString();
  await persistProgress({
    version: SETUP_WIZARD_VERSION,
    orgId,
    currentStep: 'connection',
    completedSteps: [],
    validations: {},
    choices: {},
    startedAt: now,
    updatedAt: now
  });
  return await buildLoadResult(orgId, org);
}

async function saveSetupStep(orgId, org, stepKey, data) {
  if (stepKey === 'review') {
    throw new SetupWizardError('REVIEW_REQUIRES_COMPLETION', 'Use the activation action to complete setup.');
  }
  const raw = await kvsStore.get(setupWizardProgressKey(orgId));
  if (!raw) {
    throw new SetupWizardError('SETUP_NOT_STARTED', 'Start the guided setup before validating a step.');
  }
  const state = sanitizeProgress(raw, orgId);
  assertStepOrder(state, stepKey);

  const invalidated = invalidateFrom(state, stepKey);
  const validation = await runStepValidation(stepKey, orgId, org, data);

  if (validation.errors.length > 0) {
    const next = await persistProgress(sanitizeProgress({
      ...invalidated,
      currentStep: stepKey
    }, orgId));
    return {
      success: false,
      code: 'SETUP_VALIDATION_FAILED',
      error: 'This step did not pass validation.',
      errors: validation.errors,
      warnings: validation.warnings,
      validation,
      state: next,
      steps: buildStepsView(next)
    };
  }

  const validated = {
    ...validation,
    validatedAt: new Date().toISOString()
  };
  const completedSteps = invalidated.completedSteps.includes(stepKey)
    ? invalidated.completedSteps
    : [...invalidated.completedSteps, stepKey];
  const candidate = {
    ...invalidated,
    completedSteps,
    validations: {
      ...invalidated.validations,
      [stepKey]: validated
    }
  };
  candidate.currentStep = firstIncompleteStep(candidate);
  const next = await persistProgress(sanitizeProgress(candidate, orgId));
  return {
    success: true,
    code: 'STEP_VALIDATED',
    validation: next.validations[stepKey],
    state: next,
    steps: buildStepsView(next)
  };
}

async function validateExistingSetup(orgId, org) {
  const results = {};
  results.connection = await validateConnection(org);
  results.scope = await validateScope(orgId, org);
  results.direction = validateDirection(org);
  results.mappings = await validateMappings(orgId, org);
  results.features = await validateFeatures(orgId);
  results.webhook = await validateWebhook(orgId, org);

  const errors = Object.values(results).flatMap(result => result.errors);
  const warnings = Object.values(results).flatMap(result => result.warnings);
  return {
    success: errors.length === 0,
    code: errors.length === 0 ? 'EXISTING_SETUP_VALID' : 'EXISTING_SETUP_ISSUES',
    steps: results,
    errors,
    warnings,
    writesPerformed: 0
  };
}

function staleRevalidationError(stepKey, current) {
  const label = STEP_BY_KEY.get(stepKey)?.label || stepKey;
  const code = `SETUP_STALE_${stepKey.toUpperCase().replace(/-/g, '_')}`;
  const fallback = `Configuration changed after the ${label} step was validated. Re-run that step before activation.`;
  return new SetupWizardError(
    code,
    `Current configuration no longer matches the validated ${label} step. Re-run ${label} before activation.`,
    {
      step: stepKey,
      errors: current?.errors?.length > 0
        ? safeStringArray(current.errors)
        : [fallback]
    }
  );
}

function currentStepIsStale(stepKey, current, state) {
  const recorded = state.validations[stepKey]?.summary || {};
  const summary = current?.summary || {};
  if (!current || current.status === 'failed' || current.errors.length > 0) {
    return true;
  }

  switch (stepKey) {
    case 'connection':
      return !recorded.configurationChecksum
        || summary.configurationChecksum !== recorded.configurationChecksum;
    case 'scope':
      return !recorded.configurationChecksum
        || summary.configurationChecksum !== recorded.configurationChecksum;
    case 'direction':
      return summary.syncDirection !== recorded.syncDirection;
    case 'mappings':
      return !recorded.configurationChecksum
        || summary.configurationChecksum !== recorded.configurationChecksum;
    case 'features':
      return !recorded.configurationChecksum
        || summary.configurationChecksum !== recorded.configurationChecksum;
    case 'webhook':
      return !recorded.configurationChecksum
        || summary.configurationChecksum !== recorded.configurationChecksum
        || summary.required !== recorded.required
        || summary.verified !== recorded.verified;
    case 'initial-sync':
      return !recorded.previewChecksum
        || !recorded.configurationChecksum
        || summary.previewChecksum !== recorded.previewChecksum
        || summary.configurationChecksum !== recorded.configurationChecksum;
    default:
      return true;
  }
}

async function revalidateBeforeActivation(orgId, org, state) {
  const recordedInitialSync = state.validations['initial-sync']?.summary || {};
  const [connection, scope, direction, mappings, features, webhook, initialSync] =
    await Promise.all([
      validateConnection(org),
      validateScope(orgId, org),
      validateDirection(org),
      validateMappings(orgId, org),
      validateFeatures(orgId),
      validateWebhook(orgId, org),
      validateInitialSync(orgId, {
        choice: recordedInitialSync.choice,
        acknowledged: recordedInitialSync.acknowledged === true
      })
    ]);

  const current = {
    connection,
    scope,
    direction,
    mappings,
    features,
    webhook,
    'initial-sync': initialSync
  };
  for (const stepKey of [
    'connection',
    'scope',
    'direction',
    'mappings',
    'features',
    'webhook',
    'initial-sync'
  ]) {
    if (currentStepIsStale(stepKey, current[stepKey], state)) {
      throw staleRevalidationError(stepKey, current[stepKey]);
    }
  }
  return current;
}

async function completeSetupWizard(orgId, org, approved) {
  const existingMetadata = sanitizeMetadata(await kvsStore.get(setupWizardMetadataKey(orgId)));
  if (existingMetadata) {
    return { success: true, code: 'SETUP_ALREADY_COMPLETED', metadata: existingMetadata };
  }
  if (approved !== true) {
    return {
      success: false,
      code: 'SETUP_APPROVAL_REQUIRED',
      error: 'Explicit approval is required to activate the reviewed configuration.',
      errors: ['Explicit approval is required to activate the reviewed configuration.']
    };
  }

  const raw = await kvsStore.get(setupWizardProgressKey(orgId));
  if (!raw) {
    throw new SetupWizardError('SETUP_NOT_STARTED', 'Start the guided setup before activation.');
  }
  const state = sanitizeProgress(raw, orgId);
  const missing = STEP_KEYS
    .filter(key => key !== 'review')
    .filter(key => !state.completedSteps.includes(key));
  if (missing.length > 0) {
    throw new SetupWizardError(
      'SETUP_INCOMPLETE',
      'Every wizard step must pass validation before activation.',
      { errors: missing.map(key => `Incomplete step: ${key}`) }
    );
  }

  await revalidateBeforeActivation(orgId, org, state);

  if (normalizeDirection(org.syncDirection) === 'bidirectional'
      && state.validations.webhook?.status !== 'passed') {
    throw new SetupWizardError(
      'WEBHOOK_NOT_VERIFIED',
      'Bidirectional setup requires a verified authenticated webhook event.',
      { errors: ['Webhook verification is incomplete.'] }
    );
  }

  const metadata = {
    setupStatus: 'completed',
    setupVersion: SETUP_WIZARD_VERSION,
    setupCompletedAt: new Date().toISOString()
  };
  await kvsStore.set(setupWizardMetadataKey(orgId), metadata);
  await kvsStore.del(setupWizardProgressKey(orgId));
  return { success: true, code: 'SETUP_COMPLETED', metadata };
}

export async function handleSetupWizardAction({
  action,
  orgId,
  step,
  data,
  approved
} = {}) {
  try {
    const normalizedOrgId = normalizeOrgId(orgId);

    if (action === 'load') {
      const org = await loadOrganization(normalizedOrgId);
      return await buildLoadResult(normalizedOrgId, org);
    }

    if (action === 'start') {
      const org = await loadOrganization(normalizedOrgId);
      return await startSetupWizard(normalizedOrgId, org);
    }

    if (action === 'save-step') {
      const stepKey = normalizeStep(step);
      if (!stepKey) {
        throw new SetupWizardError('INVALID_STEP', 'A valid wizard step is required.');
      }
      const org = await loadOrganization(normalizedOrgId);
      return await saveSetupStep(normalizedOrgId, org, stepKey, {
        approved: approved === true || data?.approved === true,
        choice: data?.choice,
        acknowledged: data?.acknowledged === true
      });
    }

    if (action === 'validate-existing') {
      const org = await loadOrganization(normalizedOrgId);
      return await validateExistingSetup(normalizedOrgId, org);
    }

    if (action === 'complete') {
      const org = await loadOrganization(normalizedOrgId);
      return await completeSetupWizard(normalizedOrgId, org, approved === true);
    }

    throw new SetupWizardError('INVALID_ACTION', 'Unsupported setup wizard action.');
  } catch (error) {
    return failureResult(error);
  }
}
