import { createHash } from 'crypto';
import api, { route, fetch as guardedFetch } from '../jira/guarded-api.js';
import * as kvsStore from '../storage/kvs.js';
import { getOrganizationsWithTokens, getRemoteKey, getLocalKey } from '../storage/mappings.js';
import { getPilotPause } from './pilot-pause.js';
import { readSyncAuthorizationStatus } from './sync-authorization.js';
import { isProjectAllowedToSync } from '../../utils/validation.js';
import { stableStringify } from './recovery-snapshot.js';
import { logAuditEntry } from '../storage/stats.js';
import {
  issueSprintPermit,
  revokeSprintPermit
} from './sprint-permit.js';

/**
 * Optional, mapping-based sprint synchronization.
 *
 * The connector never assumes sprint IDs match between Jira instances and never
 * derives a mapping from sprint names. An administrator must explicitly verify a
 * local sprint id against a remote sprint id. Preview is read-only. Apply only
 * adds already-mapped counterpart issues to those two verified sprints while the
 * connector is paused and synchronization is authorized.
 *
 * Boundaries:
 * - Never creates a sprint, board or sprint mapping automatically.
 * - Never removes an issue from a sprint (no destructive membership change).
 * - Never infers a mapping from a name, date, board or matching issue list.
 * - Closed/inaccessible/ambiguous sprints are reported and not written.
 * - Project scope and organization direction are checked before additions.
 * - All POSTs use the existing guarded Jira transport, so pause, authorization,
 *   lease migration and issue-lease checks still apply.
 */

export const SPRINT_MAPPING_VERSION = 1;
export const SPRINT_SYNC_BATCH_SIZE = 50;
export const SPRINT_SYNC_MAX_ISSUES = 500;
export const SPRINT_SYNC_MAX_MAPPINGS = 100;

export const SPRINT_SYNC_ERRORS = Object.freeze({
  ORGANIZATION_INVALID: 'SPRINT_SYNC_ORGANIZATION_INVALID',
  ORGANIZATION_NOT_FOUND: 'SPRINT_SYNC_ORGANIZATION_NOT_FOUND',
  ORGANIZATION_UNUSABLE: 'SPRINT_SYNC_ORGANIZATION_UNUSABLE',
  PAUSE_REQUIRED: 'SPRINT_SYNC_PAUSE_REQUIRED',
  PAUSE_UNREADABLE: 'SPRINT_SYNC_PAUSE_UNREADABLE',
  OPTION_DISABLED: 'SPRINT_SYNC_OPTION_DISABLED',
  SPRINT_ID_INVALID: 'SPRINT_SYNC_ID_INVALID',
  SPRINT_MISSING: 'SPRINT_SYNC_SPRINT_MISSING',
  SPRINT_INACCESSIBLE: 'SPRINT_SYNC_SPRINT_INACCESSIBLE',
  SPRINT_UNVERIFIABLE: 'SPRINT_SYNC_SPRINT_UNVERIFIABLE',
  MAPPING_MISSING: 'SPRINT_SYNC_MAPPING_MISSING',
  MAPPING_AMBIGUOUS: 'SPRINT_SYNC_MAPPING_AMBIGUOUS',
  MAPPING_CONFLICT: 'SPRINT_SYNC_MAPPING_CONFLICT',
  CONFIRMATION_REQUIRED: 'SPRINT_SYNC_CONFIRMATION_REQUIRED',
  CONFIRMATION_MISMATCH: 'SPRINT_SYNC_CONFIRMATION_MISMATCH',
  CLOSED_SPRINT: 'SPRINT_SYNC_CLOSED_SPRINT',
  ISSUES_UNREADABLE: 'SPRINT_SYNC_ISSUES_UNREADABLE',
  ISSUES_TOO_LARGE: 'SPRINT_SYNC_ISSUES_TOO_LARGE',
  AUTHORIZATION_REQUIRED: 'SPRINT_SYNC_AUTHORIZATION_REQUIRED',
  STALE_PREVIEW: 'SPRINT_SYNC_STALE_PREVIEW',
  APPLY_FAILED: 'SPRINT_SYNC_APPLY_FAILED',
  BUSY: 'SPRINT_SYNC_BUSY',
  PARTIAL: 'SPRINT_SYNC_PARTIAL'
});

export const SPRINT_SYNC_MESSAGES = Object.freeze({
  [SPRINT_SYNC_ERRORS.ORGANIZATION_INVALID]: 'A configured organization id is required.',
  [SPRINT_SYNC_ERRORS.ORGANIZATION_NOT_FOUND]: 'The selected organization is not configured.',
  [SPRINT_SYNC_ERRORS.ORGANIZATION_UNUSABLE]: 'The organization has no usable remote site or credentials.',
  [SPRINT_SYNC_ERRORS.PAUSE_REQUIRED]: 'Pause synchronization before sprint mapping or sprint synchronization.',
  [SPRINT_SYNC_ERRORS.PAUSE_UNREADABLE]: 'The emergency pause could not be read, so sprint synchronization was refused.',
  [SPRINT_SYNC_ERRORS.OPTION_DISABLED]: 'Sync Sprints is Off for this organization.',
  [SPRINT_SYNC_ERRORS.SPRINT_ID_INVALID]: 'Sprint ids must be positive numeric Jira sprint ids.',
  [SPRINT_SYNC_ERRORS.SPRINT_MISSING]: 'One of the sprint identities does not exist.',
  [SPRINT_SYNC_ERRORS.SPRINT_INACCESSIBLE]: 'One of the sprints is not accessible to the connector.',
  [SPRINT_SYNC_ERRORS.SPRINT_UNVERIFIABLE]: 'One of the sprint identities could not be verified.',
  [SPRINT_SYNC_ERRORS.MAPPING_MISSING]: 'No verified local-to-remote sprint mapping exists for this pair.',
  [SPRINT_SYNC_ERRORS.MAPPING_AMBIGUOUS]: 'The sprint mapping is ambiguous; remove the duplicate mapping first.',
  [SPRINT_SYNC_ERRORS.MAPPING_CONFLICT]: 'A local or remote sprint is already used by another mapping.',
  [SPRINT_SYNC_ERRORS.CONFIRMATION_REQUIRED]: 'Type the exact sprint confirmation phrase.',
  [SPRINT_SYNC_ERRORS.CONFIRMATION_MISMATCH]: 'The confirmation phrase does not match this sprint operation.',
  [SPRINT_SYNC_ERRORS.CLOSED_SPRINT]: 'A closed sprint cannot be changed. Reopen it or choose another sprint.',
  [SPRINT_SYNC_ERRORS.ISSUES_UNREADABLE]: 'Sprint issue membership could not be read safely.',
  [SPRINT_SYNC_ERRORS.ISSUES_TOO_LARGE]: 'The sprint contains more issues than the safe preview budget.',
  [SPRINT_SYNC_ERRORS.AUTHORIZATION_REQUIRED]: 'Synchronization authorization is not active; sprint writes were refused.',
  [SPRINT_SYNC_ERRORS.STALE_PREVIEW]: 'Sprint membership changed after preview; run a fresh preview.',
  [SPRINT_SYNC_ERRORS.APPLY_FAILED]: 'The sprint membership update was not completed.',
  [SPRINT_SYNC_ERRORS.BUSY]: 'Another sprint update is already in progress.',
  [SPRINT_SYNC_ERRORS.PARTIAL]: 'Part of the sprint update succeeded; re-preview before retrying.'
});

export class SprintSyncError extends Error {
  constructor(code, details = {}) {
    super(SPRINT_SYNC_MESSAGES[code] || SPRINT_SYNC_MESSAGES[SPRINT_SYNC_ERRORS.APPLY_FAILED]);
    this.name = 'SprintSyncError';
    this.code = code;
    this.details = details;
  }
}

const ORG_ID_PATTERN = /^org-\d+$/;
const SPRINT_ID_PATTERN = /^\d{1,32}$/;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hostFromUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function digest(value) {
  return `sha256:${createHash('sha256').update(stableStringify(value), 'utf8').digest('hex')}`;
}

function normalizeSprintId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && SPRINT_ID_PATTERN.test(value) && value !== '0') return value;
  throw new SprintSyncError(SPRINT_SYNC_ERRORS.SPRINT_ID_INVALID);
}

function mappingKey(orgId) {
  return `sprintMappings:${orgId}`;
}

function mappingPhrase({ orgId, localSprintId, remoteSprintId }) {
  return `MAP SPRINT ${orgId} ${localSprintId} ${remoteSprintId}`;
}

function applyPhrase({ orgId, digestValue }) {
  return `SYNC SPRINT ${orgId} ${digestValue}`;
}


const defaultDeps = {
  getStored: kvsStore.get,
  setStored: kvsStore.set,
  readPause: getPilotPause,
  getOrganizations: getOrganizationsWithTokens,
  getRemoteKey,
  getLocalKey,
  readAuthorization: readSyncAuthorizationStatus,
  issuePermit: issueSprintPermit,
  revokePermit: revokeSprintPermit,
  localRequest: async ({ requestRoute = null, method = 'GET', body = null }) => {
    if (!requestRoute) throw new Error('A trusted local Jira route is required');
    return api.asApp().requestJira(requestRoute, {
      method,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body } : {})
    });
  },
  remoteRequest: async (org, { path, method = 'GET', body = null }) => {
    const auth = Buffer.from(`${org.remoteEmail}:${org.remoteApiToken}`).toString('base64');
    return guardedFetch(`${org.remoteUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body } : {})
    });
  },
  auditWrite: logAuditEntry,
  now: () => Date.now()
};

function depsOf(options = {}) {
  return { ...defaultDeps, ...(options.deps || {}) };
}

async function readPause(deps) {
  let pause;
  try {
    pause = await deps.readPause();
  } catch {
    throw new SprintSyncError(SPRINT_SYNC_ERRORS.PAUSE_UNREADABLE);
  }
  if (!pause || pause.paused !== true) {
    throw new SprintSyncError(SPRINT_SYNC_ERRORS.PAUSE_REQUIRED);
  }
  return pause;
}

async function resolveOrganization(orgId, deps) {
  if (typeof orgId !== 'string' || !ORG_ID_PATTERN.test(orgId)) {
    throw new SprintSyncError(SPRINT_SYNC_ERRORS.ORGANIZATION_INVALID);
  }
  let organizations;
  try {
    organizations = await deps.getOrganizations();
  } catch {
    organizations = [];
  }
  const org = (Array.isArray(organizations) ? organizations : [])
    .find((entry) => entry?.id === orgId);
  if (!org) throw new SprintSyncError(SPRINT_SYNC_ERRORS.ORGANIZATION_NOT_FOUND);
  if (!hostFromUrl(org.remoteUrl)
    || typeof org.remoteApiToken !== 'string'
    || org.remoteApiToken === '') {
    throw new SprintSyncError(SPRINT_SYNC_ERRORS.ORGANIZATION_UNUSABLE);
  }
  return org;
}

async function readOption(orgId, deps) {
  let stored;
  try {
    stored = await deps.getStored(`syncOptions:${orgId}`);
  } catch {
    stored = null;
  }
  if (stored?.syncSprints !== true) {
    throw new SprintSyncError(SPRINT_SYNC_ERRORS.OPTION_DISABLED);
  }
  return stored;
}

function normalizeMapping(value) {
  if (!isPlainObject(value)) return null;
  try {
    return {
      version: SPRINT_MAPPING_VERSION,
      localSprintId: normalizeSprintId(value.localSprintId),
      remoteSprintId: normalizeSprintId(value.remoteSprintId),
      localName: typeof value.localName === 'string' ? value.localName.slice(0, 200) : null,
      remoteName: typeof value.remoteName === 'string' ? value.remoteName.slice(0, 200) : null,
      localState: typeof value.localState === 'string' ? value.localState.slice(0, 32) : null,
      remoteState: typeof value.remoteState === 'string' ? value.remoteState.slice(0, 32) : null,
      localBoardId: typeof value.localBoardId === 'string' ? value.localBoardId : null,
      remoteBoardId: typeof value.remoteBoardId === 'string' ? value.remoteBoardId : null,
      verifiedAt: typeof value.verifiedAt === 'string' ? value.verifiedAt : null
    };
  } catch {
    return null;
  }
}

async function readMappings(orgId, deps) {
  let value;
  try {
    value = await deps.getStored(mappingKey(orgId));
  } catch {
    throw new SprintSyncError(SPRINT_SYNC_ERRORS.ISSUES_UNREADABLE, { reason: 'mapping-unreadable' });
  }
  return (Array.isArray(value) ? value : [])
    .map(normalizeMapping)
    .filter(Boolean);
}

async function resolveMapping(orgId, localSprintId, remoteSprintId, deps) {
  const mappings = await readMappings(orgId, deps);
  const local = mappings.filter((entry) => entry.localSprintId === localSprintId);
  const remote = mappings.filter((entry) => entry.remoteSprintId === remoteSprintId);
  const exact = mappings.filter((entry) => (
    entry.localSprintId === localSprintId && entry.remoteSprintId === remoteSprintId
  ));
  if (exact.length === 0) throw new SprintSyncError(SPRINT_SYNC_ERRORS.MAPPING_MISSING);
  if (exact.length > 1 || local.length > 1 || remote.length > 1) {
    throw new SprintSyncError(SPRINT_SYNC_ERRORS.MAPPING_AMBIGUOUS);
  }
  return exact[0];
}


async function readSprint(side, sprintId, org, deps) {
  const path = `/rest/agile/1.0/sprint/${sprintId}`;
  const requestRoute = route`/rest/agile/1.0/sprint/${sprintId}`;
  let response;
  try {
    response = side === 'local'
      ? await deps.localRequest({ path, requestRoute, method: 'GET' })
      : await deps.remoteRequest(org, { path, method: 'GET' });
  } catch {
    throw new SprintSyncError(SPRINT_SYNC_ERRORS.SPRINT_UNVERIFIABLE, { side });
  }
  const status = Number(response?.status);
  if (status === 404) throw new SprintSyncError(SPRINT_SYNC_ERRORS.SPRINT_MISSING, { side });
  if (status === 401 || status === 403) {
    throw new SprintSyncError(SPRINT_SYNC_ERRORS.SPRINT_INACCESSIBLE, { side, status });
  }
  if (!response?.ok) {
    throw new SprintSyncError(SPRINT_SYNC_ERRORS.SPRINT_UNVERIFIABLE, { side, status });
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new SprintSyncError(SPRINT_SYNC_ERRORS.SPRINT_UNVERIFIABLE, { side });
  }
  if (!isPlainObject(body) || String(body.id) !== sprintId) {
    throw new SprintSyncError(SPRINT_SYNC_ERRORS.SPRINT_UNVERIFIABLE, { side });
  }
  return {
    side,
    id: sprintId,
    name: typeof body.name === 'string' ? body.name.slice(0, 200) : null,
    state: typeof body.state === 'string' ? body.state : null,
    boardId: body.originBoardId === undefined || body.originBoardId === null
      ? null
      : String(body.originBoardId)
  };
}

async function readSprintIssues(side, sprintId, org, deps) {
  const keys = new Set();
  const projects = new Map();
  let startAt = 0;
  let pages = 0;
  for (;;) {
    const path = `/rest/agile/1.0/sprint/${sprintId}/issue?maxResults=50&startAt=${startAt}&fields=key,project`;
    const requestRoute = route`/rest/agile/1.0/sprint/${sprintId}/issue?maxResults=50&startAt=${startAt}&fields=key,project`;
    let response;
    try {
      response = side === 'local'
        ? await deps.localRequest({ path, requestRoute, method: 'GET' })
        : await deps.remoteRequest(org, { path, method: 'GET' });
    } catch {
      throw new SprintSyncError(SPRINT_SYNC_ERRORS.ISSUES_UNREADABLE, { side });
    }
    const status = Number(response?.status);
    if (status === 401 || status === 403) {
      throw new SprintSyncError(SPRINT_SYNC_ERRORS.ISSUES_UNREADABLE, {
        side,
        reason: 'permission'
      });
    }
    if (status === 404) {
      throw new SprintSyncError(SPRINT_SYNC_ERRORS.SPRINT_MISSING, { side });
    }
    if (!response?.ok) {
      throw new SprintSyncError(SPRINT_SYNC_ERRORS.ISSUES_UNREADABLE, { side, status });
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new SprintSyncError(SPRINT_SYNC_ERRORS.ISSUES_UNREADABLE, { side });
    }
    if (!isPlainObject(body) || !Array.isArray(body.issues)) {
      throw new SprintSyncError(SPRINT_SYNC_ERRORS.ISSUES_UNREADABLE, { side });
    }
    for (const issue of body.issues) {
      if (typeof issue?.key !== 'string') continue;
      keys.add(issue.key);
      const projectKey = typeof issue.fields?.project?.key === 'string'
        ? issue.fields.project.key
        : issue.key.split('-')[0];
      if (projectKey) projects.set(issue.key, projectKey);
    }
    if (keys.size > SPRINT_SYNC_MAX_ISSUES) {
      throw new SprintSyncError(SPRINT_SYNC_ERRORS.ISSUES_TOO_LARGE, { side });
    }
    const total = Number(body.total);
    const isLast = body.isLast === true
      || (Number.isFinite(total) && startAt + body.issues.length >= total)
      || body.issues.length === 0;
    if (isLast) break;
    if (body.issues.length === 0) break;
    startAt += body.issues.length;
    pages += 1;
    if (pages >= 10) {
      throw new SprintSyncError(SPRINT_SYNC_ERRORS.ISSUES_TOO_LARGE, { side });
    }
  }
  return { keys, projects };
}


export async function getSprintSyncStatus(options = {}) {
  const deps = depsOf(options);
  const orgId = options.orgId;
  if (typeof orgId !== 'string' || !ORG_ID_PATTERN.test(orgId)) {
    throw new SprintSyncError(SPRINT_SYNC_ERRORS.ORGANIZATION_INVALID);
  }
  const mappings = await readMappings(orgId, deps);
  let enabled = false;
  try {
    enabled = (await deps.getStored(`syncOptions:${orgId}`))?.syncSprints === true;
  } catch {
    enabled = false;
  }
  return {
    success: true,
    readOnly: true,
    orgId,
    enabled,
    mappings: mappings.map((entry) => ({
      localSprintId: entry.localSprintId,
      remoteSprintId: entry.remoteSprintId,
      localName: entry.localName,
      remoteName: entry.remoteName,
      localState: entry.localState,
      remoteState: entry.remoteState,
      verifiedAt: entry.verifiedAt
    }))
  };
}

/**
 * Explicitly verifies one local/remote sprint identity pair and stores the
 * mapping. Names are display-only and are never used to derive the pair.
 */
export async function saveSprintMapping(options = {}) {
  const deps = depsOf(options);
  const orgId = options.orgId;
  const localSprintId = normalizeSprintId(options.localSprintId);
  const remoteSprintId = normalizeSprintId(options.remoteSprintId);
  await readPause(deps);
  const org = await resolveOrganization(orgId, deps);
  const expectedPhrase = mappingPhrase({ orgId, localSprintId, remoteSprintId });
  if (typeof options.confirmation !== 'string' || options.confirmation.trim() === '') {
    throw new SprintSyncError(SPRINT_SYNC_ERRORS.CONFIRMATION_REQUIRED, {
      expectedPhrase
    });
  }
  if (options.confirmation !== expectedPhrase) {
    throw new SprintSyncError(SPRINT_SYNC_ERRORS.CONFIRMATION_MISMATCH);
  }

  const local = await readSprint('local', localSprintId, org, deps);
  const remote = await readSprint('remote', remoteSprintId, org, deps);
  const mappings = await readMappings(orgId, deps);
  const conflict = mappings.find((entry) => (
    entry.localSprintId !== localSprintId && entry.remoteSprintId !== remoteSprintId
      ? false
      : (entry.localSprintId !== localSprintId || entry.remoteSprintId !== remoteSprintId)
  ));
  if (conflict) {
    throw new SprintSyncError(SPRINT_SYNC_ERRORS.MAPPING_CONFLICT, {
      localSprintId: conflict.localSprintId,
      remoteSprintId: conflict.remoteSprintId
    });
  }
  const record = {
    version: SPRINT_MAPPING_VERSION,
    localSprintId,
    remoteSprintId,
    localName: local.name,
    remoteName: remote.name,
    localState: local.state,
    remoteState: remote.state,
    localBoardId: local.boardId,
    remoteBoardId: remote.boardId,
    verifiedAt: new Date(Number(deps.now())).toISOString()
  };
  const next = mappings
    .filter((entry) => !(entry.localSprintId === localSprintId
      && entry.remoteSprintId === remoteSprintId))
    .concat(record)
    .slice(-SPRINT_SYNC_MAX_MAPPINGS);
  await deps.setStored(mappingKey(orgId), next);
  await Promise.resolve(deps.auditWrite({
    action: 'sprint-sync',
    orgId,
    outcome: 'mapping-verified',
    success: true,
    reason: 'sprint-mapping-verified'
  })).catch(() => false);
  return {
    success: true,
    readOnlyJira: true,
    orgId,
    mapping: record,
    mappings: next
  };
}


async function buildPreview({ orgId, localSprintId, remoteSprintId, deps }) {
  await readPause(deps);
  await readOption(orgId, deps);
  const org = await resolveOrganization(orgId, deps);
  const mapping = await resolveMapping(orgId, localSprintId, remoteSprintId, deps);
  const localSprint = await readSprint('local', localSprintId, org, deps);
  const remoteSprint = await readSprint('remote', remoteSprintId, org, deps);
  const localIssues = await readSprintIssues('local', localSprintId, org, deps);
  const remoteIssues = await readSprintIssues('remote', remoteSprintId, org, deps);
  const bidirectional = org.syncDirection === 'bidirectional';
  const remoteAdditions = [];
  const localAdditions = [];
  let unmapped = 0;
  let skippedProject = 0;
  let alreadyPresent = 0;

  for (const localKey of [...localIssues.keys].sort()) {
    const localProject = localIssues.projects.get(localKey) || localKey.split('-')[0];
    if (!(await isProjectAllowedToSync(localProject, org))) {
      skippedProject += 1;
      continue;
    }
    const remoteKey = await deps.getRemoteKey(localKey, orgId);
    if (!remoteKey) {
      unmapped += 1;
      continue;
    }
    if (remoteIssues.keys.has(remoteKey)) {
      alreadyPresent += 1;
      continue;
    }
    remoteAdditions.push({ localKey, remoteKey });
  }

  if (bidirectional) {
    for (const remoteKey of [...remoteIssues.keys].sort()) {
      const localKey = await deps.getLocalKey(remoteKey, orgId);
      if (!localKey) {
        unmapped += 1;
        continue;
      }
      const localProject = localIssues.projects.get(localKey) || localKey.split('-')[0];
      if (!(await isProjectAllowedToSync(localProject, org))) {
        skippedProject += 1;
        continue;
      }
      if (localIssues.keys.has(localKey)) {
        alreadyPresent += 1;
        continue;
      }
      localAdditions.push({ localKey, remoteKey });
    }
  }

  const closed = localSprint.state === 'closed' || remoteSprint.state === 'closed';
  const additions = {
    remote: remoteAdditions.slice(0, SPRINT_SYNC_BATCH_SIZE),
    local: localAdditions.slice(0, SPRINT_SYNC_BATCH_SIZE)
  };
  const digestValue = digest({
    purpose: 'sprint-sync-preview',
    orgId,
    mapping: {
      localSprintId: mapping.localSprintId,
      remoteSprintId: mapping.remoteSprintId
    },
    localState: localSprint.state,
    remoteState: remoteSprint.state,
    direction: bidirectional ? 'bidirectional' : 'push',
    additions
  });
  const authorization = await deps.readAuthorization().catch(() => null);
  return {
    success: true,
    readOnly: true,
    noWritesPerformed: true,
    orgId,
    mapping,
    sprints: {
      local: localSprint,
      remote: remoteSprint
    },
    direction: bidirectional ? 'bidirectional' : 'push',
    status: closed ? 'blocked' : ((additions.remote.length + additions.local.length) > 0 ? 'ready' : 'noop'),
    blockedReasons: closed ? ['closed-sprint'] : [],
    counts: {
      localIssues: localIssues.keys.size,
      remoteIssues: remoteIssues.keys.size,
      remoteToAdd: additions.remote.length,
      localToAdd: additions.local.length,
      alreadyPresent,
      unmapped,
      skippedProject,
      remainingRemote: Math.max(0, remoteAdditions.length - additions.remote.length),
      remainingLocal: Math.max(0, localAdditions.length - additions.local.length)
    },
    additions,
    authorization: {
      authorized: authorization?.authorized === true,
      reason: authorization?.reason || null
    },
    digest: digestValue,
    confirmationPhrase: applyPhrase({ orgId, digestValue }),
    limitations: [
      'Preview reads sprint identities and issue membership only; it performs no Jira write.',
      'Sprint ids come only from the explicitly verified mapping. Names and dates are display-only and are never matched.',
      'Apply only adds mapped counterpart issues to the two mapped sprints; it never creates a sprint and never removes membership.',
      'Closed or inaccessible sprints are reported as blocked and are never written.'
    ]
  };
}

export async function previewSprintSync(options = {}) {
  const deps = depsOf(options);
  const orgId = options.orgId;
  const localSprintId = normalizeSprintId(options.localSprintId);
  const remoteSprintId = normalizeSprintId(options.remoteSprintId);
  return await buildPreview({ orgId, localSprintId, remoteSprintId, deps });
}


async function addIssuesToSprint({ side, sprintId, keys, org, deps }) {
  if (!Array.isArray(keys) || keys.length === 0) return { success: true, wrote: 0 };
  const path = `/rest/agile/1.0/sprint/${sprintId}/issue`;
  const requestRoute = route`/rest/agile/1.0/sprint/${sprintId}/issue`;
  const body = JSON.stringify({ issues: keys });
  let response;
  try {
    response = side === 'local'
      ? await deps.localRequest({ path, requestRoute, method: 'POST', body })
      : await deps.remoteRequest(org, { path, method: 'POST', body });
  } catch {
    return { success: false, wrote: 0, code: 'transport' };
  }
  const status = Number(response?.status);
  if (!response?.ok) {
    return {
      success: false,
      wrote: 0,
      code: status === 401 || status === 403 ? 'permission' : 'http',
      status: Number.isFinite(status) ? status : null
    };
  }
  return { success: true, wrote: keys.length };
}

/**
 * Applies one explicit, digest-bound sprint preview.
 *
 * Only additions are submitted. There is deliberately no sprint creation,
 * membership removal or name-based matching path.
 */
export async function applySprintSync(options = {}) {
  const deps = depsOf(options);
  const orgId = options.orgId;
  const localSprintId = normalizeSprintId(options.localSprintId);
  const remoteSprintId = normalizeSprintId(options.remoteSprintId);
  await readPause(deps);
  await readOption(orgId, deps);
  const org = await resolveOrganization(orgId, deps);
  const preview = await buildPreview({ orgId, localSprintId, remoteSprintId, deps });
  if (preview.status === 'blocked') {
    throw new SprintSyncError(SPRINT_SYNC_ERRORS.CLOSED_SPRINT, {
      blockedReasons: preview.blockedReasons
    });
  }
  if (preview.digest !== options.digest) {
    throw new SprintSyncError(SPRINT_SYNC_ERRORS.STALE_PREVIEW);
  }
  if (typeof options.confirmation !== 'string' || options.confirmation.trim() === '') {
    throw new SprintSyncError(SPRINT_SYNC_ERRORS.CONFIRMATION_REQUIRED, {
      expectedPhrase: preview.confirmationPhrase
    });
  }
  if (options.confirmation !== preview.confirmationPhrase) {
    throw new SprintSyncError(SPRINT_SYNC_ERRORS.CONFIRMATION_MISMATCH);
  }
  let authorization;
  try {
    authorization = await deps.readAuthorization();
  } catch {
    authorization = null;
  }
  if (authorization?.authorized !== true) {
    throw new SprintSyncError(SPRINT_SYNC_ERRORS.AUTHORIZATION_REQUIRED);
  }

  const remoteKeys = preview.additions.remote.map((entry) => entry.remoteKey);
  const localKeys = preview.additions.local.map((entry) => entry.localKey);
  const permitEntries = [];
  if (remoteKeys.length > 0) {
    permitEntries.push({
      side: 'remote',
      sprintId: remoteSprintId,
      host: new URL(org.remoteUrl).hostname.toLowerCase(),
      issues: remoteKeys
    });
  }
  if (localKeys.length > 0) {
    permitEntries.push({
      side: 'local',
      sprintId: localSprintId,
      issues: localKeys
    });
  }
  let permit = null;
  if (permitEntries.length > 0) {
    try {
      permit = await deps.issuePermit({
        orgId,
        digest: preview.digest,
        entries: permitEntries,
        deps
      });
    } catch (error) {
      if (error?.code === 'SPRINT_PERMIT_REFUSED'
        && error?.reason === 'SPRINT_PERMIT_BUSY') {
        throw new SprintSyncError(SPRINT_SYNC_ERRORS.BUSY);
      }
      throw new SprintSyncError(SPRINT_SYNC_ERRORS.APPLY_FAILED, {
        reason: 'sprint-permit-not-issued'
      });
    }
  }

  let writes = 0;
  let remoteApplied = false;
  try {
    const remoteResult = await addIssuesToSprint({
      side: 'remote',
      sprintId: remoteSprintId,
      keys: remoteKeys,
      org,
      deps
    });
    if (!remoteResult.success) {
      throw new SprintSyncError(SPRINT_SYNC_ERRORS.APPLY_FAILED, {
        side: 'remote',
        status: remoteResult.status || null,
        reason: remoteResult.code
      });
    }
    writes += remoteResult.wrote > 0 ? 1 : 0;
    remoteApplied = remoteResult.wrote > 0;

    const localResult = await addIssuesToSprint({
      side: 'local',
      sprintId: localSprintId,
      keys: localKeys,
      org,
      deps
    });
    if (!localResult.success) {
      throw new SprintSyncError(
        remoteApplied ? SPRINT_SYNC_ERRORS.PARTIAL : SPRINT_SYNC_ERRORS.APPLY_FAILED,
        { side: 'local', status: localResult.status || null, reason: localResult.code }
      );
    }
    writes += localResult.wrote > 0 ? 1 : 0;
  } catch (error) {
    await Promise.resolve(deps.auditWrite({
      action: 'sprint-sync',
      orgId,
      success: false,
      reason: error?.code || SPRINT_SYNC_ERRORS.APPLY_FAILED,
      errors: [error?.code || SPRINT_SYNC_ERRORS.APPLY_FAILED]
    })).catch(() => false);
    throw error;
  } finally {
    if (permit) {
      await Promise.resolve(deps.revokePermit({ deps })).catch(() => false);
    }
  }

  await Promise.resolve(deps.auditWrite({
    action: 'sprint-sync',
    orgId,
    success: true,
    reason: writes > 0 ? 'sprint-membership-added' : 'sprint-noop',
    errors: []
  })).catch(() => false);

  return {
    success: true,
    orgId,
    digest: preview.digest,
    mapping: {
      localSprintId,
      remoteSprintId
    },
    counts: preview.counts,
    jiraWrites: writes,
    status: writes > 0 ? 'applied' : 'noop',
    remaining: {
      remote: preview.counts.remainingRemote,
      local: preview.counts.remainingLocal
    },
    message: writes > 0
      ? 'Mapped counterpart issues were added to the verified sprints. No sprint was created and no membership was removed.'
      : 'No sprint membership change was needed.'
  };
}

