// Shared project-routing rules for local-to-remote issue creation.
//
// The organization's projectMappings are authoritative: a local project that
// has an explicit mapping must be created in that target project. Only local
// projects without an explicit mapping fall back to the organization's default
// remoteProjectKey. Malformed mappings fail closed so a create can never be
// silently routed to a different project than the administrator configured.

export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,49}$/;

export const PROJECT_ROUTING_REASONS = Object.freeze({
  INVALID_PROJECT_MAPPING: 'INVALID_PROJECT_MAPPING',
  TARGET_PROJECT_MISSING: 'TARGET_PROJECT_MISSING'
});

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isValidProjectKey(projectKey) {
  return typeof projectKey === 'string' && PROJECT_KEY_PATTERN.test(projectKey);
}

/**
 * Resolves the remote project that a local issue must be created in.
 *
 * @param {string} localProjectKey source project key
 * @param {{ projectMappings?: object, remoteProjectKey?: string }} config
 * @returns {{ key: string|null, reason: string|null }}
 */
export function resolveTargetProjectKey(localProjectKey, config = {}) {
  const { projectMappings, remoteProjectKey } = config;
  const mappings = projectMappings === undefined || projectMappings === null
    ? {}
    : projectMappings;

  if (!isPlainObject(mappings)) {
    return { key: null, reason: PROJECT_ROUTING_REASONS.INVALID_PROJECT_MAPPING };
  }

  if (typeof localProjectKey === 'string'
      && Object.prototype.hasOwnProperty.call(mappings, localProjectKey)) {
    const mapped = mappings[localProjectKey];
    if (!isValidProjectKey(mapped)) {
      return { key: null, reason: PROJECT_ROUTING_REASONS.INVALID_PROJECT_MAPPING };
    }
    return { key: mapped, reason: null };
  }

  if (!isValidProjectKey(remoteProjectKey)) {
    return { key: null, reason: PROJECT_ROUTING_REASONS.TARGET_PROJECT_MISSING };
  }

  return { key: remoteProjectKey, reason: null };
}
