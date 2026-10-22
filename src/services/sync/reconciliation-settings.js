import * as kvsStore from '../storage/kvs.js';

/**
 * Opt-in settings for recurring local-to-remote source reconciliation.
 *
 * This feature periodically re-runs the safe initial-sync preview for the
 * configured local scope and creates remote issues that are still unmapped. It
 * is deliberately not a remote scan and it is not full bidirectional
 * reconciliation.
 */
export const RECONCILIATION_SETTINGS_VERSION = 1;
export const RECONCILIATION_MIN_INTERVAL_MINUTES = 15;
export const RECONCILIATION_MAX_INTERVAL_MINUTES = 7 * 24 * 60;
export const RECONCILIATION_MAX_FAILURE_THRESHOLD = 20;

export const RECONCILIATION_DEFAULTS = Object.freeze({
  recurringReconciliationEnabled: false,
  reconciliationIntervalMinutes: 60,
  reconciliationCommentOnReview: true,
  reconciliationFailureThreshold: 3
});

const ORG_ID_PATTERN = /^(?:org-[0-9]+|legacy)$/;

export class ReconciliationSettingsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReconciliationSettingsError';
    this.code = code;
  }
}

function normalizeOrgId(orgId) {
  if (typeof orgId !== 'string' || !ORG_ID_PATTERN.test(orgId)) {
    throw new ReconciliationSettingsError(
      'RECONCILIATION_INVALID_ORGANIZATION',
      'A valid organization is required.'
    );
  }
  return orgId;
}

function scopeSegment(orgId) {
  return orgId === 'legacy' ? 'legacy' : orgId;
}

export function buildReconciliationSettingsKey(orgId) {
  return `reconciliationSettings:${scopeSegment(normalizeOrgId(orgId))}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeInteger(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

export function normalizeReconciliationSettings(stored) {
  const input = isPlainObject(stored) ? stored : {};
  return {
    version: RECONCILIATION_SETTINGS_VERSION,
    recurringReconciliationEnabled: normalizeBoolean(
      input.recurringReconciliationEnabled,
      RECONCILIATION_DEFAULTS.recurringReconciliationEnabled
    ),
    reconciliationIntervalMinutes: normalizeInteger(
      input.reconciliationIntervalMinutes,
      RECONCILIATION_DEFAULTS.reconciliationIntervalMinutes,
      RECONCILIATION_MIN_INTERVAL_MINUTES,
      RECONCILIATION_MAX_INTERVAL_MINUTES
    ),
    reconciliationCommentOnReview: normalizeBoolean(
      input.reconciliationCommentOnReview,
      RECONCILIATION_DEFAULTS.reconciliationCommentOnReview
    ),
    reconciliationFailureThreshold: normalizeInteger(
      input.reconciliationFailureThreshold,
      RECONCILIATION_DEFAULTS.reconciliationFailureThreshold,
      1,
      RECONCILIATION_MAX_FAILURE_THRESHOLD
    )
  };
}

function assertInputType(value, name, type) {
  if (typeof value !== type) {
    throw new ReconciliationSettingsError(
      'RECONCILIATION_INVALID_SETTINGS',
      `${name} has an invalid type.`
    );
  }
}

export function validateReconciliationSettings(input) {
  if (!isPlainObject(input)) {
    throw new ReconciliationSettingsError(
      'RECONCILIATION_INVALID_SETTINGS',
      'Reconciliation settings must be an object.'
    );
  }

  const allowedKeys = new Set([
    'recurringReconciliationEnabled',
    'reconciliationIntervalMinutes',
    'reconciliationCommentOnReview',
    'reconciliationFailureThreshold'
  ]);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw new ReconciliationSettingsError(
        'RECONCILIATION_INVALID_SETTINGS',
        `${key} is not a supported reconciliation setting.`
      );
    }
  }

  assertInputType(
    input.recurringReconciliationEnabled,
    'recurringReconciliationEnabled',
    'boolean'
  );
  assertInputType(
    input.reconciliationCommentOnReview,
    'reconciliationCommentOnReview',
    'boolean'
  );
  if (!Number.isSafeInteger(input.reconciliationIntervalMinutes)
      || input.reconciliationIntervalMinutes < RECONCILIATION_MIN_INTERVAL_MINUTES
      || input.reconciliationIntervalMinutes > RECONCILIATION_MAX_INTERVAL_MINUTES) {
    throw new ReconciliationSettingsError(
      'RECONCILIATION_INVALID_SETTINGS',
      `reconciliationIntervalMinutes must be an integer between ${RECONCILIATION_MIN_INTERVAL_MINUTES} and ${RECONCILIATION_MAX_INTERVAL_MINUTES}.`
    );
  }
  if (!Number.isSafeInteger(input.reconciliationFailureThreshold)
      || input.reconciliationFailureThreshold < 1
      || input.reconciliationFailureThreshold > RECONCILIATION_MAX_FAILURE_THRESHOLD) {
    throw new ReconciliationSettingsError(
      'RECONCILIATION_INVALID_SETTINGS',
      `reconciliationFailureThreshold must be an integer between 1 and ${RECONCILIATION_MAX_FAILURE_THRESHOLD}.`
    );
  }

  return {
    version: RECONCILIATION_SETTINGS_VERSION,
    recurringReconciliationEnabled: input.recurringReconciliationEnabled,
    reconciliationIntervalMinutes: input.reconciliationIntervalMinutes,
    reconciliationCommentOnReview: input.reconciliationCommentOnReview,
    reconciliationFailureThreshold: input.reconciliationFailureThreshold
  };
}

export async function getReconciliationSettings(orgId) {
  const normalizedOrgId = normalizeOrgId(orgId);
  const stored = await kvsStore.get(buildReconciliationSettingsKey(normalizedOrgId));
  return normalizeReconciliationSettings(stored);
}

/**
 * Persist only validated settings. The schedule's nextRunAt is intentionally
 * untouched here; it is advanced only when a reconciliation attempt reaches a
 * terminal state.
 */
export async function saveReconciliationSettings({ orgId, settings } = {}) {
  const normalizedOrgId = normalizeOrgId(orgId);
  const normalized = validateReconciliationSettings(settings);
  await kvsStore.set(buildReconciliationSettingsKey(normalizedOrgId), normalized);
  return normalized;
}

export function reconciliationIntervalMs(settings) {
  const normalized = normalizeReconciliationSettings(settings);
  return normalized.reconciliationIntervalMinutes * 60 * 1000;
}
