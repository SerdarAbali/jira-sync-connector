import * as kvsStore from '../storage/kvs.js';

/**
 * One global emergency pause for all Jira writes.
 *
 * There is deliberately no second operating-mode configuration here. Per-org
 * direction continues to come from the existing organization.syncDirection
 * values ("push" or "bidirectional").
 */
export const PILOT_PAUSE_KEY = 'pilotPause';
export const PAUSE_REASON_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

const ACTIVE_STATE = Object.freeze({
  paused: false,
  pausedAt: null,
  pausedBy: null,
  reasonCode: null
});

export class PilotPausedError extends Error {
  constructor(operation = 'jira_write') {
    super('Jira writes are paused by the connector administrator');
    this.name = 'PilotPausedError';
    this.code = 'PILOT_PAUSED';
    this.operation = operation;
  }
}

function normalizeStoredState(stored) {
  // A missing record means active: this preserves upgraded installations, which
  // behaved exactly this way before the emergency pause existed.
  if (stored === null || stored === undefined) {
    return { ...ACTIVE_STATE };
  }

  // Fail closed. An existing record that is not an object with a boolean
  // `paused` decision was never written by pausePilot/resumePilot, so its
  // intent is unknown. Unknown intent must never authorize a Jira mutation.
  if (typeof stored !== 'object' || Array.isArray(stored) || typeof stored.paused !== 'boolean') {
    return { ...ACTIVE_STATE, paused: true };
  }

  if (stored.paused === false) {
    return { ...ACTIVE_STATE };
  }

  return {
    paused: true,
    pausedAt: typeof stored.pausedAt === 'string' ? stored.pausedAt : null,
    pausedBy: typeof stored.pausedBy === 'string' ? stored.pausedBy : null,
    reasonCode: typeof stored.reasonCode === 'string' ? stored.reasonCode : null
  };
}

/**
 * Reads the stored pause decision. A missing record means active; a malformed
 * existing record means paused so that an unreadable decision can never
 * authorize writes.
 */
export async function getPilotPause() {
  const stored = await kvsStore.get(PILOT_PAUSE_KEY);
  return normalizeStoredState(stored);
}

export async function pausePilot(reasonCode, pausedBy) {
  if (typeof reasonCode !== 'string' || !PAUSE_REASON_PATTERN.test(reasonCode)) {
    const error = new Error('Invalid pilot pause reason code');
    error.code = 'INVALID_PAUSE_REASON';
    throw error;
  }

  const current = await getPilotPause();
  if (current.paused) {
    return current;
  }

  const next = {
    paused: true,
    pausedAt: new Date().toISOString(),
    pausedBy: typeof pausedBy === 'string' ? pausedBy.trim() : null,
    reasonCode
  };
  await kvsStore.set(PILOT_PAUSE_KEY, next);
  return next;
}

export async function resumePilot(resumedBy) {
  const current = await getPilotPause();
  if (!current.paused) {
    return current;
  }

  const next = {
    ...ACTIVE_STATE,
    resumedAt: new Date().toISOString(),
    resumedBy: typeof resumedBy === 'string' ? resumedBy.trim() : null
  };
  await kvsStore.set(PILOT_PAUSE_KEY, next);
  return normalizeStoredState(next);
}

export async function assertPilotWritesAllowed(operation = 'jira_write') {
  const state = await getPilotPause();
  if (state.paused) {
    throw new PilotPausedError(operation);
  }
}

function safeOrganizationSummary(org) {
  return {
    id: typeof org?.id === 'string' ? org.id : null,
    name: typeof org?.name === 'string' ? org.name : null,
    syncDirection: org?.syncDirection === 'bidirectional' ? 'bidirectional' : 'push'
  };
}

export async function getPilotStatus() {
  const pause = await getPilotPause();
  const organizations = await kvsStore.get('organizations');

  return {
    state: pause.paused ? 'paused' : 'active',
    paused: pause.paused,
    pausedAt: pause.pausedAt,
    pausedBy: pause.pausedBy,
    reasonCode: pause.reasonCode,
    organizations: Array.isArray(organizations)
      ? organizations.map(safeOrganizationSummary)
      : []
  };
}
