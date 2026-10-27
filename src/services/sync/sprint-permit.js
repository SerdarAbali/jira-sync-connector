import { randomBytes } from 'crypto';
import { getAppContext } from '@forge/api';
import * as kvsStore from '../storage/kvs.js';
import { getPilotPause } from './pilot-pause.js';
import { assertSyncAuthorized } from './sync-authorization.js';

/**
 * Short-lived maintenance permit for one approved sprint membership batch.
 *
 * The ordinary Jira write chain correctly refuses every POST while Pause is ON.
 * Sprint maintenance is the narrow exception: a permit is minted only after the
 * administrator approved a fresh sprint preview while Pause is ON and Sync
 * Authorization is active. The guarded transport then permits exactly the
 * approved POST paths, sprint ids and issue lists, for a short bounded window.
 */

export const SPRINT_PERMIT_KEY = 'sprintSyncPermit';
export const SPRINT_PERMIT_VERSION = 1;
export const SPRINT_PERMIT_TTL_SECONDS = 120;

export const SPRINT_PERMIT_REASONS = Object.freeze({
  MISSING: 'SPRINT_PERMIT_MISSING',
  MALFORMED: 'SPRINT_PERMIT_MALFORMED',
  EXPIRED: 'SPRINT_PERMIT_EXPIRED',
  FOREIGN_INSTALLATION: 'SPRINT_PERMIT_FOREIGN_INSTALLATION',
  PAUSE_NOT_CONFIRMED: 'SPRINT_PERMIT_PAUSE_NOT_CONFIRMED',
  AUTHORIZATION_REQUIRED: 'SPRINT_PERMIT_AUTHORIZATION_REQUIRED',
  OPTION_DISABLED: 'SPRINT_PERMIT_OPTION_DISABLED',
  PATH_MISMATCH: 'SPRINT_PERMIT_PATH_MISMATCH',
  PAYLOAD_MISMATCH: 'SPRINT_PERMIT_PAYLOAD_MISMATCH',
  ALREADY_USED: 'SPRINT_PERMIT_ALREADY_USED',
  BUSY: 'SPRINT_PERMIT_BUSY',
  ISSUE_FAILED: 'SPRINT_PERMIT_ISSUE_FAILED'
});

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function permitUseKey(permitId, side, sprintId) {
  return `sprintPermitUsed:${permitId}:${side}:${sprintId}`;
}

const defaultDeps = {
  getStored: kvsStore.get,
  setIfNotExists: kvsStore.setIfNotExists,
  deleteKey: kvsStore.del,
  readPause: getPilotPause,
  assertAuthorization: assertSyncAuthorized,
  getContext: getAppContext,
  now: () => Date.now()
};

function depsOf(options = {}) {
  return { ...defaultDeps, ...(options.deps || {}) };
}

function readIdentity(getContext) {
  let context;
  try {
    context = getContext();
  } catch {
    return null;
  }
  const appId = typeof context?.appAri?.appId === 'string' ? context.appAri.appId : null;
  const installationId = typeof context?.installationAri?.installationId === 'string'
    ? context.installationAri.installationId
    : null;
  return appId && installationId ? { appId, installationId } : null;
}

function normalizePermit(value) {
  if (!isPlainObject(value) || value.version !== SPRINT_PERMIT_VERSION) return null;
  if (typeof value.permitId !== 'string' || value.permitId.length < 8) return null;
  if (typeof value.orgId !== 'string' || !/^org-\d+$/.test(value.orgId)) return null;
  if (typeof value.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.digest)) return null;
  if (typeof value.installationId !== 'string' || typeof value.appId !== 'string') return null;
  if (!Number.isFinite(Number(value.expiresAt))) return null;
  if (!Array.isArray(value.entries) || value.entries.length === 0) return null;
  const entries = value.entries.map((entry) => {
    if (!isPlainObject(entry)
      || !['local', 'remote'].includes(entry.side)
      || !/^\d{1,32}$/.test(String(entry.sprintId ?? ''))
      || (entry.side === 'remote' && typeof entry.host !== 'string')
      || !Array.isArray(entry.issues)
      || entry.issues.length === 0
      || entry.issues.some((key) => !/^[A-Za-z][A-Za-z0-9_]*-[0-9]+$/.test(key))) {
      return null;
    }
    return {
      side: entry.side,
      sprintId: String(entry.sprintId),
      host: entry.side === 'remote' ? entry.host.toLowerCase() : null,
      issues: [...new Set(entry.issues)].sort()
    };
  });
  if (entries.some((entry) => entry === null)) return null;
  return {
    version: SPRINT_PERMIT_VERSION,
    permitId: value.permitId,
    orgId: value.orgId,
    digest: value.digest,
    installationId: value.installationId,
    appId: value.appId,
    issuedAt: typeof value.issuedAt === 'string' ? value.issuedAt : null,
    expiresAt: Number(value.expiresAt),
    entries
  };
}

export class SprintPermitError extends Error {
  constructor(reason, details = {}) {
    super(reason);
    this.name = 'SprintPermitError';
    this.code = 'SPRINT_PERMIT_REFUSED';
    this.reason = reason;
    this.details = details;
  }
}

export async function issueSprintPermit(options = {}) {
  const deps = depsOf(options);
  const entries = Array.isArray(options.entries) ? options.entries : [];
  if (entries.length === 0) {
    throw new SprintPermitError(SPRINT_PERMIT_REASONS.ISSUE_FAILED);
  }
  const identity = readIdentity(deps.getContext);
  if (!identity) throw new SprintPermitError(SPRINT_PERMIT_REASONS.FOREIGN_INSTALLATION);
  const now = Number(deps.now());
  const permit = {
    version: SPRINT_PERMIT_VERSION,
    permitId: `sp_${now.toString(36)}_${randomBytes(8).toString('hex')}`,
    orgId: options.orgId,
    digest: options.digest,
    installationId: identity.installationId,
    appId: identity.appId,
    issuedAt: new Date(now).toISOString(),
    expiresAt: now + SPRINT_PERMIT_TTL_SECONDS * 1000,
    entries: entries.map((entry) => ({
      side: entry.side,
      sprintId: String(entry.sprintId),
      host: entry.side === 'remote' ? String(entry.host).toLowerCase() : null,
      issues: [...new Set(entry.issues || [])].sort()
    }))
  };
  try {
    if (typeof deps.setIfNotExists === 'function') {
      await deps.setIfNotExists(SPRINT_PERMIT_KEY, permit, SPRINT_PERMIT_TTL_SECONDS);
    } else {
      const existing = await deps.getStored(SPRINT_PERMIT_KEY);
      if (existing) throw Object.assign(new Error('permit exists'), { code: 'KEY_ALREADY_EXISTS' });
      await deps.setStored(SPRINT_PERMIT_KEY, permit);
    }
  } catch (error) {
    if (error?.code === 'KEY_ALREADY_EXISTS' || /exists/i.test(String(error?.message || ''))) {
      throw new SprintPermitError(SPRINT_PERMIT_REASONS.BUSY);
    }
    throw error;
  }
  return permit;
}

export async function revokeSprintPermit(options = {}) {
  const deps = depsOf(options);
  try {
    await deps.deleteKey(SPRINT_PERMIT_KEY);
    return true;
  } catch {
    return false;
  }
}


/**
 * Evaluates a prospective sprint POST against the current permit.
 *
 * `absent` means no sprint permit exists, so the request falls through to the
 * ordinary fail-closed chain (and is normally refused by Pause). `refused` means
 * a permit exists but this request is not exactly one approved entry; it is
 * rejected rather than downgraded to an ordinary attempt.
 */
export async function evaluateSprintPermit(options = {}) {
  const deps = depsOf(options);
  const method = String(options.method || '').toUpperCase();
  if (method !== 'POST') return { allowed: false, refused: false, absent: true };
  const match = /\/rest\/agile\/1\.0\/sprint\/(\d{1,32})\/issue$/.exec(String(options.pathname || ''));
  if (!match) return { allowed: false, refused: false, absent: true };
  const sprintId = match[1];
  const raw = String(options.raw ?? '');
  const absolute = /^https?:\/\//i.test(raw);
  let host = null;
  if (absolute) {
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      return { allowed: false, refused: true, reason: SPRINT_PERMIT_REASONS.PATH_MISMATCH, sprintId };
    }
  }

  let stored;
  try {
    stored = await deps.getStored(SPRINT_PERMIT_KEY);
  } catch {
    return { allowed: false, refused: true, reason: SPRINT_PERMIT_REASONS.MALFORMED, sprintId };
  }
  if (stored === null || stored === undefined) {
    return { allowed: false, refused: false, absent: true, sprintId };
  }
  const permit = normalizePermit(stored);
  if (!permit) {
    return { allowed: false, refused: true, reason: SPRINT_PERMIT_REASONS.MALFORMED, sprintId };
  }
  const now = Number(deps.now());
  if (!(permit.expiresAt > now)) {
    return { allowed: false, refused: true, reason: SPRINT_PERMIT_REASONS.EXPIRED, sprintId };
  }
  const identity = readIdentity(deps.getContext);
  if (!identity
    || identity.appId !== permit.appId
    || identity.installationId !== permit.installationId) {
    return { allowed: false, refused: true, reason: SPRINT_PERMIT_REASONS.FOREIGN_INSTALLATION, sprintId };
  }
  const entry = permit.entries.find((candidate) => (
    candidate.sprintId === sprintId
      && (candidate.side === 'remote' ? candidate.host === host : host === null)
  ));
  if (!entry) {
    return { allowed: false, refused: true, reason: SPRINT_PERMIT_REASONS.PATH_MISMATCH, sprintId };
  }
  if (typeof options.body !== 'string' || options.body === '') {
    return { allowed: false, refused: true, reason: SPRINT_PERMIT_REASONS.PAYLOAD_MISMATCH, sprintId };
  }
  let parsed;
  try {
    parsed = JSON.parse(options.body);
  } catch {
    return { allowed: false, refused: true, reason: SPRINT_PERMIT_REASONS.PAYLOAD_MISMATCH, sprintId };
  }
  if (!isPlainObject(parsed)
    || Object.keys(parsed).length !== 1
    || !Array.isArray(parsed.issues)
    || parsed.issues.length !== entry.issues.length
    || parsed.issues.some((key) => typeof key !== 'string')) {
    return { allowed: false, refused: true, reason: SPRINT_PERMIT_REASONS.PAYLOAD_MISMATCH, sprintId };
  }
  const actual = [...new Set(parsed.issues)].sort();
  if (actual.length !== parsed.issues.length
    || actual.length !== entry.issues.length
    || actual.some((key, index) => key !== entry.issues[index])) {
    return { allowed: false, refused: true, reason: SPRINT_PERMIT_REASONS.PAYLOAD_MISMATCH, sprintId };
  }
  try {
    const pause = await deps.readPause();
    if (pause?.paused !== true) {
      return { allowed: false, refused: true, reason: SPRINT_PERMIT_REASONS.PAUSE_NOT_CONFIRMED, sprintId };
    }
  } catch {
    return { allowed: false, refused: true, reason: SPRINT_PERMIT_REASONS.PAUSE_NOT_CONFIRMED, sprintId };
  }
  try {
    await deps.assertAuthorization();
  } catch {
    return { allowed: false, refused: true, reason: SPRINT_PERMIT_REASONS.AUTHORIZATION_REQUIRED, sprintId };
  }
  let storedOptions;
  try {
    storedOptions = await deps.getStored(`syncOptions:${permit.orgId}`);
  } catch {
    storedOptions = null;
  }
  if (storedOptions?.syncSprints !== true) {
    return { allowed: false, refused: true, reason: SPRINT_PERMIT_REASONS.OPTION_DISABLED, sprintId };
  }

  // One use per approved entry prevents a live permit from being replayed by a
  // second invocation while it remains within its TTL.
  const useKey = permitUseKey(permit.permitId, entry.side, entry.sprintId);
  try {
    if (typeof deps.setIfNotExists === 'function') {
      await deps.setIfNotExists(useKey, { permitId: permit.permitId }, SPRINT_PERMIT_TTL_SECONDS);
    } else {
      const used = await deps.getStored(useKey);
      if (used) throw Object.assign(new Error('used'), { code: 'KEY_ALREADY_EXISTS' });
    }
  } catch {
    return { allowed: false, refused: true, reason: SPRINT_PERMIT_REASONS.ALREADY_USED, sprintId };
  }

  return {
    allowed: true,
    refused: false,
    reason: null,
    kind: 'sprint',
    permit,
    entry,
    sprintId,
    side: entry.side,
    issues: entry.issues
  };
}

