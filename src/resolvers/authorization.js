import api, { route } from '@forge/api';
import { logAuditEntry } from '../services/storage/stats.js';
import logger from '../utils/logger.js';
import {
  POLICY_CATEGORIES,
  getResolverPolicy,
  isAuditedPolicy
} from './authorization-policy.js';

// Jira Cloud REST API v3 Get my permissions. ADMINISTER is the global
// "Administer Jira" permission. The permissions query parameter is required.
export const JIRA_ADMIN_PERMISSION_ENDPOINT =
  '/rest/api/3/mypermissions?permissions=ADMINISTER';

const VALID_POLICIES = new Set(POLICY_CATEGORIES);

const FORBIDDEN_RESPONSE = Object.freeze({
  success: false,
  code: 'FORBIDDEN',
  error: 'Jira administrator permission required'
});

export function forbiddenResponse() {
  return { ...FORBIDDEN_RESPONSE };
}

/**
 * Verify that the invoking Jira user has the global ADMINISTER permission.
 * Runs as the user, never as the app. Any failure, malformed response, or
 * missing permission returns false (fail closed).
 */
export async function checkJiraAdminPermission() {
  try {
    const response = await api.asUser().requestJira(
      route`/rest/api/3/mypermissions?permissions=ADMINISTER`
    );

    if (!response || response.ok !== true) {
      return false;
    }

    const body = await response.json();
    const permission = body?.permissions?.ADMINISTER;

    return permission?.havePermission === true;
  } catch {
    return false;
  }
}

function normalizePolicy(policy) {
  if (typeof policy !== 'string' || !VALID_POLICIES.has(policy)) {
    return null;
  }
  return policy;
}

function deny(resolverName, policy, reason) {
  logger.warn('Resolver authorization denied', {
    resolver: resolverName,
    category: policy || 'UNCLASSIFIED',
    reason
  });
  return forbiddenResponse();
}

function resultSucceeded(result) {
  return !(result && typeof result === 'object' && result.success === false);
}

async function recordOutcome(recordAudit, resolverName, policy, accountId, success) {
  if (!isAuditedPolicy(policy)) return;

  try {
    await recordAudit({
      action: resolverName,
      actorAccountId: accountId,
      category: policy,
      success
    });
  } catch {
    // Audit failures must not expose implementation details or change the
    // resolver outcome. Log only safe identifiers.
    logger.warn('Resolver audit record failed', {
      resolver: resolverName,
      category: policy
    });
  }
}

/**
 * Wrap one resolver with default-deny authorization.
 *
 * Dependencies are injectable so the security boundary is independently
 * testable without Forge or Jira access.
 */
export function createAuthorizedHandler(resolverName, resolverFn, options = {}) {
  const hasExplicitPolicy = Object.prototype.hasOwnProperty.call(options, 'policy');
  const policy = normalizePolicy(
    hasExplicitPolicy ? options.policy : getResolverPolicy(resolverName)
  );
  const checkPermission = options.checkPermission || checkJiraAdminPermission;
  const recordAudit = options.recordAudit || logAuditEntry;

  return async (request) => {
    // No policy entry means no access, even if the resolver is registered.
    if (!policy) {
      return deny(resolverName, null, 'missing_policy');
    }

    const accountId = request?.context?.accountId;
    if (!request?.context) {
      return deny(resolverName, policy, 'missing_context');
    }

    if (typeof accountId !== 'string' || accountId.trim().length === 0) {
      return deny(resolverName, policy, 'missing_account_id');
    }

    let allowed = false;
    let checkFailed = false;
    try {
      allowed = await checkPermission();
    } catch {
      checkFailed = true;
      allowed = false;
    }

    if (allowed !== true) {
      return deny(
        resolverName,
        policy,
        checkFailed ? 'permission_check_failed' : 'permission_denied'
      );
    }

    if (typeof resolverFn !== 'function') {
      return deny(resolverName, policy, 'missing_implementation');
    }

    const actorAccountId = accountId.trim();
    let success = false;
    try {
      const result = await resolverFn(request);
      success = resultSucceeded(result);
      return result;
    } finally {
      // This executes only after authorization succeeded and never receives
      // the resolver payload or result.
      await recordOutcome(
        recordAudit,
        resolverName,
        policy,
        actorAccountId,
        success
      );
    }
  };
}

/**
 * Build the complete resolver handler from actual registered definitions.
 * Unknown names are still registered but always denied, so adding a resolver
 * without a policy cannot create an implicit public endpoint.
 */
export function createAuthorizedDefinitions(definitions, options = {}) {
  const policies = options.policies || null;
  const checkPermission = options.checkPermission || checkJiraAdminPermission;
  const recordAudit = options.recordAudit || logAuditEntry;
  const authorized = {};

  for (const [resolverName, resolverFn] of Object.entries(definitions || {})) {
    const policy = policies
      ? (Object.prototype.hasOwnProperty.call(policies, resolverName)
        ? policies[resolverName]
        : null)
      : getResolverPolicy(resolverName);

    authorized[resolverName] = createAuthorizedHandler(resolverName, resolverFn, {
      policy,
      checkPermission,
      recordAudit
    });
  }

  return authorized;
}
