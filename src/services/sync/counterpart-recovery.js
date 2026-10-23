import * as kvsStore from '../storage/kvs.js';
import {
  getOrganizationsWithTokens,
  replaceIssueMapping,
  deactivateIssueMapping
} from '../storage/mappings.js';
import { getFullIssue } from '../jira/local-client.js';
import { getRemoteIssue } from '../jira/remote-client.js';
import { createIssueForOrg } from './issue-sync.js';
import {
  COUNTERPART_DELETED_SIDES,
  COUNTERPART_RECORD_STATES,
  COUNTERPART_STATUS_VALUES,
  getCounterpartStatus,
  listCounterpartStatuses,
  recordCounterpartStatus,
  resolveCounterpartStatus
} from './counterpart-status.js';
import { probeCounterpart, clearCounterpartNotice } from './counterpart-probe.js';

function normalizeDirection(org) {
  return org?.syncDirection === 'bidirectional' ? 'bidirectional' : 'push';
}

function storageOrgId(org) {
  return !org?.id || org.id === 'legacy' ? null : org.id;
}

function survivorSideForDeletedSide(deletedSide) {
  if (deletedSide === COUNTERPART_DELETED_SIDES.LOCAL) return 'remote';
  if (deletedSide === COUNTERPART_DELETED_SIDES.REMOTE) return 'local';
  return null;
}

export function replacementAllowedForDirection(org, deletedSide) {
  if (!org || !deletedSide) return false;
  if (deletedSide === COUNTERPART_DELETED_SIDES.REMOTE) {
    return true;
  }
  if (deletedSide === COUNTERPART_DELETED_SIDES.LOCAL) {
    return normalizeDirection(org) === 'bidirectional';
  }
  return false;
}

export function automaticReplacementOperationSuffix(record, side) {
  const localPart = String(record?.localKey || 'local').replace(/[^A-Za-z0-9_]/g, '_');
  const remotePart = String(record?.remoteKey || 'remote').replace(/[^A-Za-z0-9_]/g, '_');
  return `replacement_${side || 'unknown'}_${localPart}_${remotePart}`.slice(0, 120);
}

async function loadOrganization(orgId) {
  const organizations = await getOrganizationsWithTokens();
  const id = orgId === null || orgId === undefined || orgId === ''
    ? 'legacy'
    : String(orgId);
  return organizations.find(org => org.id === id) || null;
}

async function loadReplacementContext(orgId) {
  const org = await loadOrganization(orgId);
  if (!org) return null;
  const orgIdForStorage = storageOrgId(org);
  const key = suffix => orgIdForStorage ? `${suffix}:${orgIdForStorage}` : suffix;
  const [userMappings, fieldMappings, statusMappings, issueTypeMappings, projectMappings, syncOptions] =
    await Promise.all([
      kvsStore.get(key('userMappings')),
      kvsStore.get(key('fieldMappings')),
      kvsStore.get(key('statusMappings')),
      kvsStore.get(key('issueTypeMappings')),
      kvsStore.get(key('projectMappings')),
      kvsStore.get(key('syncOptions'))
    ]);
  return {
    org,
    orgId: orgIdForStorage,
    syncOptions: syncOptions || {},
    mappings: {
      userMappings: userMappings?.mappings || userMappings || {},
      fieldMappings: fieldMappings || {},
      statusMappings: statusMappings || {},
      issueTypeMappings: issueTypeMappings || {},
      projectMappings: projectMappings || {}
    }
  };
}

async function safeLoadOrganization(orgId) {
  try {
    return await loadOrganization(orgId);
  } catch {
    return null;
  }
}

async function safeGetSyncOptions(orgId) {
  try {
    return await kvsStore.get(orgId ? `syncOptions:${orgId}` : 'syncOptions');
  } catch {
    return null;
  }
}

async function clearNoticeForSurvivor({ orgId, record, org }) {
  try {
    const side = survivorSideForDeletedSide(record?.deletedSide);
    if (!side) return { skipped: true };
    return await clearCounterpartNotice({
      side,
      key: side === 'remote' ? record.remoteKey : record.localKey,
      org,
      scope: { orgId }
    });
  } catch (error) {
    if (error?.code?.startsWith('INBOUND_SCOPE_')) return { success: false, skipped: true, code: error.code };
    return { success: false, skipped: true, code: 'NOTICE_CLEAR_FAILED' };
  }
}

export async function listDeletedCounterparts(orgId) {
  const [records, org, options] = await Promise.all([
    listCounterpartStatuses(orgId, { includeResolved: false, limit: 200 }),
    safeLoadOrganization(orgId),
    safeGetSyncOptions(orgId)
  ]);
  const direction = normalizeDirection(org);
  return records.map(record => ({
    ...record,
    survivorSide: survivorSideForDeletedSide(record.deletedSide),
    replacementAllowed: replacementAllowedForDirection(org, record.deletedSide),
    syncDirection: direction,
    automaticReplacementEnabled: options?.automaticReplacementAfterDeletion === true
  }));
}

/**
 * Read-only probe. The caller must explicitly resolve or dismiss the record.
 */
export async function probeDeletedCounterpart({ orgId, localKey, remoteKey }) {
  const record = await getCounterpartStatus({ orgId, localKey, remoteKey });
  if (!record) {
    return { success: false, code: 'COUNTERPART_STATUS_NOT_FOUND' };
  }
  const org = await loadOrganization(orgId);
  if (!org) {
    return { success: false, code: 'ORGANIZATION_NOT_FOUND' };
  }
  const deletedProbe = await probeCounterpart({
    side: record.deletedSide,
    key: record.deletedSide === 'remote' ? record.remoteKey : record.localKey,
    org
  });
  const survivorSide = survivorSideForDeletedSide(record.deletedSide);
  const survivorProbe = survivorSide
    ? await probeCounterpart({
      side: survivorSide,
      key: survivorSide === 'remote' ? record.remoteKey : record.localKey,
      org
    })
    : null;
  return {
    success: true,
    record,
    deletedProbe,
    survivorProbe,
    survivorAvailable: survivorProbe?.status === 'active',
    readsOnly: true
  };
}

async function replaceRemoteCounterpart(context, record, automatic) {
  const probe = await probeCounterpart({
    side: 'local',
    key: record.localKey,
    org: context.org
  });
  if (probe.status !== 'active') {
    return { success: false, code: 'SURVIVOR_UNAVAILABLE', probe };
  }
  const localIssue = await getFullIssue(record.localKey);
  if (!localIssue) {
    return { success: false, code: 'SURVIVOR_UNAVAILABLE' };
  }
  const result = await createIssueForOrg(
    localIssue,
    context.org,
    context.mappings,
    {
      ...context.syncOptions,
      operationSuffix: automaticReplacementOperationSuffix(record, 'remote'),
      replacementOfRemoteKey: record.remoteKey
    },
    null
  );
  const newRemoteKey = result?.key || null;
  if (!newRemoteKey) {
    return { success: false, code: result?.code || 'REPLACEMENT_CREATE_FAILED' };
  }
  await resolveCounterpartStatus({
    orgId: context.orgId,
    localKey: record.localKey,
    remoteKey: record.remoteKey,
    state: COUNTERPART_RECORD_STATES.REPLACED,
    replacementLocalKey: record.localKey,
    replacementRemoteKey: newRemoteKey
  });
  await clearNoticeForSurvivor({ orgId: context.orgId, record, org: context.org });
  return {
    success: true,
    code: 'COUNTERPART_REPLACED',
    replacementLocalKey: record.localKey,
    replacementRemoteKey: newRemoteKey,
    automatic
  };
}

async function replaceLocalCounterpart(context, record, automatic) {
  const probe = await probeCounterpart({
    side: 'remote',
    key: record.remoteKey,
    org: context.org
  });
  if (probe.status !== 'active') {
    return { success: false, code: 'SURVIVOR_UNAVAILABLE', probe };
  }
  const remoteIssue = await getRemoteIssue(record.remoteKey, context.org, [
    'summary', 'description', 'issuetype', 'status', 'priority', 'labels',
    'duedate', 'components', 'fixVersions', 'versions', 'timetracking',
    'assignee', 'reporter', 'parent', 'attachment'
  ]);
  if (!remoteIssue?.fields) {
    return { success: false, code: 'SURVIVOR_UNAVAILABLE' };
  }
  const { handleRemoteIssueCreated } = await import('./incoming-sync.js');
  const result = await handleRemoteIssueCreated({ key: record.remoteKey }, context, {
    replacementOfLocalKey: record.localKey,
    operationSuffix: automaticReplacementOperationSuffix(record, 'local')
  });
  const newLocalKey = result?.localKey || null;
  if (!newLocalKey) {
    return { success: false, code: result?.status || result?.code || 'REPLACEMENT_CREATE_FAILED' };
  }
  await resolveCounterpartStatus({
    orgId: context.orgId,
    localKey: record.localKey,
    remoteKey: record.remoteKey,
    state: COUNTERPART_RECORD_STATES.REPLACED,
    replacementLocalKey: newLocalKey,
    replacementRemoteKey: record.remoteKey
  });
  await clearNoticeForSurvivor({ orgId: context.orgId, record, org: context.org });
  return {
    success: true,
    code: 'COUNTERPART_REPLACED',
    replacementLocalKey: newLocalKey,
    replacementRemoteKey: record.remoteKey,
    automatic
  };
}

/**
 * Controlled replacement of a confirmed-deleted counterpart. Push may recreate
 * only a deleted remote counterpart from the surviving local issue. Recreation
 * of a deleted local issue from the remote side requires bidirectional sync.
 */
export async function replaceCounterpart({
  orgId = null,
  localKey,
  remoteKey,
  automatic = false
}) {
  const record = await getCounterpartStatus({ orgId, localKey, remoteKey });
  if (!record || record.state !== COUNTERPART_RECORD_STATES.ACTIVE) {
    return { success: false, code: 'COUNTERPART_STATUS_NOT_ACTIVE' };
  }
  if (record.status !== COUNTERPART_STATUS_VALUES.CONFIRMED_DELETED) {
    return { success: false, code: 'COUNTERPART_NOT_CONFIRMED_DELETED' };
  }

  const context = await loadReplacementContext(orgId);
  if (!context) {
    return { success: false, code: 'ORGANIZATION_NOT_FOUND' };
  }
  if (!replacementAllowedForDirection(context.org, record.deletedSide)) {
    return { success: false, code: 'DIRECTION_BLOCKED', deletedSide: record.deletedSide };
  }

  return record.deletedSide === COUNTERPART_DELETED_SIDES.REMOTE
    ? replaceRemoteCounterpart(context, record, automatic)
    : replaceLocalCounterpart(context, record, automatic);
}

/**
 * Automatic replacement is a new, explicit opt-in. Legacy
 * recreateDeletedIssues is deliberately never consulted.
 */
export async function maybeAutoReplaceAfterDeletion({
  orgId = null,
  org = null,
  localKey,
  remoteKey,
  deletedSide
}) {
  try {
    const options = await kvsStore.get(orgId ? `syncOptions:${orgId}` : 'syncOptions');
    if (options?.automaticReplacementAfterDeletion !== true) {
      return { success: false, code: 'AUTOMATIC_REPLACEMENT_OFF' };
    }
    const resolvedOrg = org || await loadOrganization(orgId);
    if (!replacementAllowedForDirection(resolvedOrg, deletedSide)) {
      return { success: false, code: 'DIRECTION_BLOCKED' };
    }
    const record = await getCounterpartStatus({ orgId, localKey, remoteKey });
    if (!record || record.status !== COUNTERPART_STATUS_VALUES.CONFIRMED_DELETED) {
      return { success: false, code: 'COUNTERPART_NOT_CONFIRMED_DELETED' };
    }
    return await replaceCounterpart({ orgId, localKey, remoteKey, automatic: true });
  } catch (error) {
    return {
      success: false,
      code: 'AUTOMATIC_REPLACEMENT_FAILED',
      reason: error?.code || 'REPLACEMENT_FAILED'
    };
  }
}


/**
 * Administrator remap to a verified existing pair. Both changed sides must be
 * reachable before either lookup direction is replaced.
 */
export async function remapDeletedCounterpart({
  orgId = null,
  localKey,
  remoteKey,
  newLocalKey = null,
  newRemoteKey = null,
  actorAccountId = null
}) {
  if (![localKey, remoteKey, newLocalKey, newRemoteKey].every(isValidIssueKeyValue)) {
    return { success: false, code: 'MAPPING_INVALID' };
  }
  if (newLocalKey === localKey && newRemoteKey === remoteKey) {
    return { success: false, code: 'REMAP_UNCHANGED' };
  }
  const record = await getCounterpartStatus({ orgId, localKey, remoteKey });
  if (!record || record.state !== COUNTERPART_RECORD_STATES.ACTIVE) {
    return { success: false, code: 'COUNTERPART_STATUS_NOT_ACTIVE' };
  }
  const context = await loadReplacementContext(orgId);
  if (!context) {
    return { success: false, code: 'ORGANIZATION_NOT_FOUND' };
  }

  const [localProbe, remoteProbe] = await Promise.all([
    probeCounterpart({
      side: 'local',
      key: newLocalKey,
      org: context.org
    }),
    probeCounterpart({
      side: 'remote',
      key: newRemoteKey,
      org: context.org
    })
  ]);
  if (localProbe.status !== 'active') {
    return { success: false, code: 'REMAP_LOCAL_NOT_AVAILABLE', probe: localProbe };
  }
  if (remoteProbe.status !== 'active') {
    return { success: false, code: 'REMAP_REMOTE_NOT_AVAILABLE', probe: remoteProbe };
  }

  try {
    const mapping = await replaceIssueMapping({
      oldLocalKey: localKey,
      oldRemoteKey: remoteKey,
      newLocalKey,
      newRemoteKey,
      orgId: context.orgId
    });
    if (!mapping.success) {
      return mapping;
    }
  } catch (error) {
    return {
      success: false,
      code: error?.code || 'REMAP_FAILED'
    };
  }

  await resolveCounterpartStatus({
    orgId: context.orgId,
    localKey,
    remoteKey,
    state: COUNTERPART_RECORD_STATES.REPLACED,
    replacementLocalKey: newLocalKey,
    replacementRemoteKey: newRemoteKey
  });
  await clearNoticeForSurvivor({
    orgId: context.orgId,
    record,
    org: context.org
  });
  return {
    success: true,
    code: 'COUNTERPART_REMAPPED',
    localKey: newLocalKey,
    remoteKey: newRemoteKey,
    remappedBy: typeof actorAccountId === 'string' ? actorAccountId : null
  };
}

/**
 * End synchronization by atomically removing both active lookup directions and
 * preserving a safe ending record. No Jira issue is deleted.
 */
export async function endCounterpartSync({
  orgId = null,
  localKey,
  remoteKey,
  actorAccountId = null
}) {
  if (!isValidIssueKeyValue(localKey) || !isValidIssueKeyValue(remoteKey)) {
    return { success: false, code: 'MAPPING_INVALID' };
  }
  const record = await getCounterpartStatus({ orgId, localKey, remoteKey });
  if (!record || record.state !== COUNTERPART_RECORD_STATES.ACTIVE) {
    return { success: false, code: 'COUNTERPART_STATUS_NOT_ACTIVE' };
  }
  const endedAt = new Date().toISOString();
  const ended = await deactivateIssueMapping({
    localKey,
    remoteKey,
    orgId,
    endedAt,
    endedBy: actorAccountId,
    reasonCode: 'administrator_ended_counterpart_sync'
  });
  if (!ended.success) {
    return ended;
  }
  const statusResult = await resolveCounterpartStatus({
    orgId,
    localKey,
    remoteKey,
    state: COUNTERPART_RECORD_STATES.ENDED,
    endedAt,
    endedBy: actorAccountId
  });
  const org = await safeLoadOrganization(orgId);
  await clearNoticeForSurvivor({
    orgId,
    record,
    org
  });
  return {
    success: true,
    code: 'COUNTERPART_SYNC_ENDED',
    endedAt,
    endedBy: typeof actorAccountId === 'string' ? actorAccountId : null,
    statusRecorded: statusResult.success,
    jiraIssueDeleted: false
  };
}

/**
 * Dismiss a non-deletion classification after an administrator confirms the
 * pair is healthy again. Confirmed deletions must be remapped, replaced, or
 * explicitly ended instead.
 */
export async function dismissDeletedCounterpart({
  orgId = null,
  localKey,
  remoteKey,
  actorAccountId = null
}) {
  const record = await getCounterpartStatus({ orgId, localKey, remoteKey });
  if (!record || record.state !== COUNTERPART_RECORD_STATES.ACTIVE) {
    return { success: false, code: 'COUNTERPART_STATUS_NOT_ACTIVE' };
  }
  if (record.status === COUNTERPART_STATUS_VALUES.CONFIRMED_DELETED) {
    return { success: false, code: 'CONFIRMED_DELETION_REQUIRES_REMAP_OR_END' };
  }
  const resolved = await resolveCounterpartStatus({
    orgId,
    localKey,
    remoteKey,
    state: COUNTERPART_RECORD_STATES.DISMISSED
  });
  if (!resolved.success) {
    return resolved;
  }
  const org = await safeLoadOrganization(orgId);
  await clearNoticeForSurvivor({ orgId, record, org });
  return {
    success: true,
    code: 'COUNTERPART_STATUS_DISMISSED',
    dismissedBy: typeof actorAccountId === 'string' ? actorAccountId : null
  };
}

/**
 * Persist a probe result only when it adds a blocking classification. Active
 * probes are handled by resolving/dismissing the explicit recovery record.
 */
export async function recordProbeFailure({
  orgId = null,
  localKey,
  remoteKey,
  deletedSide = null,
  probe,
  source = 'counterpart_probe'
}) {
  return recordCounterpartStatus({
    orgId,
    localKey,
    remoteKey,
    status: probe?.status,
    deletedSide,
    source,
    reasonCode: probe?.reasonCode || 'PROBE_FAILED',
    probeStatusCode: probe?.statusCode ?? null
  });
}

function isValidIssueKeyValue(value) {
  return typeof value === 'string'
    && value.length <= 100
    && /^[A-Za-z][A-Za-z0-9_]*-[0-9]+$/.test(value);
}
