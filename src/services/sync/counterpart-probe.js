import { assertInboundScope, isInboundScopeError } from './inbound-scope.js';
import { fetch } from '../jira/guarded-api.js';
import { getFullIssue, probeLocalIssue, updateLocalIssueDescription } from '../jira/local-client.js';
import { probeRemoteIssue } from '../jira/remote-client.js';
import { getPilotPause } from './pilot-pause.js';
import {
  COUNTERPART_STATUS_VALUES,
  normalizeCounterpartStatusClass
} from './counterpart-status.js';
import {
  updateCounterpartNoticeInADF,
  adfPreservesOriginalContent
} from '../../utils/adf.js';

function classifyProbe(result) {
  if (result?.reachable === true) {
    return {
      status: 'active',
      statusCode: result.statusCode ?? 200,
      reasonCode: 'ACTIVE'
    };
  }
  const status = normalizeCounterpartStatusClass(result?.statusCode)
    || COUNTERPART_STATUS_VALUES.TEMPORARY_FAILURE;
  return {
    status,
    statusCode: Number.isInteger(result?.statusCode) ? result.statusCode : null,
    reasonCode: result?.statusCode
      ? `HTTP_${result.statusCode}`
      : (result?.reasonCode || 'NETWORK_ERROR')
  };
}

/**
 * Probe one side without writing to Jira. 404 is "unavailable" rather than a
 * confirmed deletion; only verified deletion events produce confirmed_deleted.
 */
export async function probeCounterpart({ side, key, org = null }) {
  if (typeof key !== 'string' || !key) {
    return { status: COUNTERPART_STATUS_VALUES.TEMPORARY_FAILURE, statusCode: null };
  }
  if (side !== 'local' && side !== 'remote') {
    return {
      status: COUNTERPART_STATUS_VALUES.TEMPORARY_FAILURE,
      statusCode: null,
      reasonCode: 'UNKNOWN_SIDE'
    };
  }
  const result = side === 'remote'
    ? await probeRemoteIssue(key, org)
    : await probeLocalIssue(key);
  return classifyProbe(result);
}

async function pilotWritesPaused() {
  try {
    const pause = await getPilotPause();
    return pause.paused === true;
  } catch {
    return true;
  }
}

function noticeInfo({ localKey, remoteKey, status }) {
  return {
    localKey,
    remoteKey,
    status: status === COUNTERPART_STATUS_VALUES.UNAVAILABLE ? 'unavailable' : 'deleted'
  };
}

async function updateRemoteDescription({ key, org, info }) {
  if (!org?.remoteUrl || !org?.remoteEmail || !org?.remoteApiToken) {
    return { success: false, skipped: true, code: 'MISSING_CONFIGURATION' };
  }
  const auth = Buffer.from(`${org.remoteEmail}:${org.remoteApiToken}`).toString('base64');
  try {
    const response = await fetch(`${org.remoteUrl}/rest/api/3/issue/${key}?fields=description`, {
      method: 'GET',
      redirect: 'error',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json'
      }
    });
    if (!response?.ok) {
      return { success: false, skipped: true, code: 'SURVIVOR_UNREADABLE' };
    }
    const issue = await response.json();
    const original = issue?.fields?.description ?? null;
    const updated = updateCounterpartNoticeInADF(original, info);
    if (!updated || !adfPreservesOriginalContent(original, updated)) {
      return { success: false, skipped: true, code: 'DESCRIPTION_UNSAFE' };
    }
    if (JSON.stringify(original) === JSON.stringify(updated)) {
      return { success: true, changed: false };
    }
    const write = await fetch(`${org.remoteUrl}/rest/api/3/issue/${key}?notifyUsers=false`, {
      method: 'PUT',
      redirect: 'error',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fields: { description: updated } })
    });
    if (!write?.ok && write?.status !== 204) {
      return { success: false, skipped: true, code: 'NOTICE_WRITE_FAILED' };
    }
    return { success: true, changed: true };
  } catch {
    return { success: false, skipped: true, code: 'NOTICE_WRITE_FAILED' };
  }
}

async function updateLocalDescription({ key, info, scope }) {
  try {
    const issue = await getFullIssue(key);
    if (!issue) {
      return { success: false, skipped: true, code: 'SURVIVOR_UNREADABLE' };
    }
    const original = issue.fields?.description ?? null;
    const updated = updateCounterpartNoticeInADF(original, info);
    if (!updated || !adfPreservesOriginalContent(original, updated)) {
      return { success: false, skipped: true, code: 'DESCRIPTION_UNSAFE' };
    }
    if (JSON.stringify(original) === JSON.stringify(updated)) {
      return { success: true, changed: false };
    }
    await assertInboundScope({ orgId: scope?.orgId, issueKeys: [key] });
    const written = await updateLocalIssueDescription(key, updated);
    return written
      ? { success: true, changed: true }
      : { success: false, skipped: true, code: 'NOTICE_WRITE_FAILED' };
  } catch (error) {
    if (isInboundScopeError(error)) throw error;
    return { success: false, skipped: true, code: 'NOTICE_WRITE_FAILED' };
  }
}

/**
 * Add or remove exactly one connector-owned notice on the surviving issue. No
 * Jira issue is ever deleted. A paused connector performs no description write.
 */
export async function setCounterpartNotice({
  side,
  key,
  org = null,
  localKey,
  remoteKey,
  status,
  scope = null
}) {
  if (await pilotWritesPaused()) {
    return { success: false, skipped: true, code: 'PILOT_PAUSED' };
  }
  const info = noticeInfo({ localKey, remoteKey, status });
  return side === 'remote'
    ? updateRemoteDescription({ key, org, info })
    : updateLocalDescription({ key, info, scope });
}

export async function clearCounterpartNotice({ side, key, org = null, scope = null }) {
  if (await pilotWritesPaused()) {
    return { success: false, skipped: true, code: 'PILOT_PAUSED' };
  }
  return side === 'remote'
    ? updateRemoteDescription({ key, org, info: null })
    : updateLocalDescription({ key, info: null, scope });
}
