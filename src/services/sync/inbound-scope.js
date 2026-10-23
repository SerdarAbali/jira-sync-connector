import * as storage from '../storage/kvs.js';
import { getFullIssue } from '../jira/local-client.js';
import { readCommentJson, commentReadBudget } from '../jira/comment-read.js';
import { isValidIssueKey } from '../../utils/attachment-url.js';

export class InboundScopeError extends Error {
  constructor(reason, retryable = false) {
    super('Inbound synchronization scope denied');
    this.code = retryable ? 'INBOUND_SCOPE_UNVERIFIABLE' : 'INBOUND_SCOPE_BLOCKED';
    this.reason = reason;
    this.retryable = retryable;
  }
}

export const isInboundScopeError = error => error instanceof InboundScopeError;

// No cross-invocation config or issue cache: mappings never grant authorization.
export async function assertInboundScope({ orgId, issueKeys = [], projectKey = null, includeCurrentParents = false }) {
  try {
    const organizations = await storage.get('organizations');
    const org = orgId && orgId !== 'legacy'
      ? (Array.isArray(organizations) ? organizations.find(item => item.id === orgId) : null)
      : await storage.get('syncConfig');
    if (!org || org.syncDirection !== 'bidirectional') throw new InboundScopeError('ORGANIZATION_NOT_AUTHORIZED');
    const projects = org.allowedProjects;
    if (!Array.isArray(projects) || !projects.length) throw new InboundScopeError('PROJECTS_MISSING');
    if (projects.some(key => typeof key !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(key))
        || (org.jqlFilter !== undefined && (typeof org.jqlFilter !== 'string' || org.jqlFilter.length > 500))) {
      throw new InboundScopeError('SCOPE_CONFIGURATION_INVALID');
    }
    if (projectKey && !projects.includes(projectKey)) throw new InboundScopeError('TARGET_PROJECT_NOT_ALLOWED');
    if (!projectKey && !issueKeys.length) throw new InboundScopeError('DESTINATION_MISSING');
    const budget = commentReadBudget();
    const issues = new Map();
    const pending = [...new Set(issueKeys.filter(Boolean))];
    if (!projectKey && !pending.length) throw new InboundScopeError('DESTINATION_MISSING');
    for (const key of pending) {
      if (!isValidIssueKey(key)) throw new InboundScopeError('DESTINATION_INVALID');
      const issue = await readCommentJson(async () => ({ ok: true, json: () => getFullIssue(key) }), budget);
      const currentProject = issue?.fields?.project?.key;
      if (typeof currentProject !== 'string' || !currentProject) throw new InboundScopeError('DESTINATION_UNAVAILABLE', true);
      if (!projects.includes(currentProject)) throw new InboundScopeError('PROJECT_NOT_ALLOWED');
      issues.set(key, issue);
      if (includeCurrentParents && issue?.fields?.parent?.key && !pending.includes(issue.fields.parent.key)) {
        pending.push(issue.fields.parent.key);
      }
      if (pending.length > 8) throw new InboundScopeError('RELATED_ISSUES_UNVERIFIABLE', true);
    }
    // A config change during authoritative reads must not authorize a stale list.
    const latest = orgId && orgId !== 'legacy'
      ? (await storage.get('organizations'))?.find(item => item.id === orgId)
      : await storage.get('syncConfig');
    if (JSON.stringify(latest?.allowedProjects) !== JSON.stringify(projects)
        || latest?.syncDirection !== 'bidirectional' || latest?.jqlFilter !== org.jqlFilter) throw new InboundScopeError('SCOPE_CHANGED', true);
    return { org: latest, issues };
  } catch (error) {
    const denied = isInboundScopeError(error) ? error : new InboundScopeError('SCOPE_READ_FAILED', true);
    console.warn('Inbound scope denied', { orgId, issueKeys, code: denied.code, reason: denied.reason });
    throw denied;
  }
}
