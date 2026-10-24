import api, { route } from '../jira/guarded-api.js';
import * as storage from '../storage/kvs.js';
import { readCommentJson, commentReadBudget } from '../jira/comment-read.js';
import { getFullIssue } from '../jira/local-client.js';
import { getLocalKey, getRemoteKey } from '../storage/mappings.js';

export class OutboundScopeError extends Error {
  constructor(reason, retryable = false) {
    super(`Outbound source selection denied: ${reason}`);
    this.code = retryable ? 'OUTBOUND_SCOPE_UNVERIFIABLE' : 'OUTBOUND_SCOPE_BLOCKED';
    this.reason = reason;
    this.retryable = retryable;
  }
}

export const isOutboundScopeError = error => error instanceof OutboundScopeError;

export async function assertOutboundScopes({ orgId, issueKeys }) {
  let verifiedSelection;
  for (const issueKey of new Set(issueKeys)) {
    const { org } = await assertOutboundScope({ orgId, issueKey });
    if (verifiedSelection !== undefined && verifiedSelection !== selection(org)) {
      throw new OutboundScopeError('SCOPE_CHANGED', true);
    }
    verifiedSelection = selection(org);
  }
  try {
    if (verifiedSelection === undefined || verifiedSelection !== selection(await currentOrganization(orgId))) {
      throw new OutboundScopeError('SCOPE_CHANGED', true);
    }
  } catch (error) {
    if (isOutboundScopeError(error)) throw error;
    throw new OutboundScopeError('SOURCE_SELECTION_UNAVAILABLE', true);
  }
}

// A destination mapping supplies source identity, never continuing authority.
// Relationships disclose both endpoints, regardless of link direction.
export async function assertOutboundRemoteScope({ orgId, remoteKeys }) {
  try {
    const issueKeys = [];
    for (const remoteKey of new Set(remoteKeys)) {
      const issueKey = await getLocalKey(remoteKey, orgId === 'legacy' ? null : orgId);
      if (!issueKey || await getRemoteKey(issueKey, orgId === 'legacy' ? null : orgId) !== remoteKey) {
        throw new OutboundScopeError('SOURCE_MAPPING_UNAVAILABLE', true);
      }
      issueKeys.push(issueKey);
    }
    await assertOutboundScopes({ orgId, issueKeys });
  } catch (error) {
    if (isOutboundScopeError(error)) throw error;
    throw new OutboundScopeError('SOURCE_SELECTION_UNAVAILABLE', true);
  }
}

export async function matchesJqlFilter(issueKey, jqlFilter, issueId, budget = commentReadBudget()) {
  if (jqlFilter === undefined || jqlFilter === null || jqlFilter === '') return true;
  if (typeof jqlFilter !== 'string' || jqlFilter.length > 500) {
    throw new OutboundScopeError('INVALID_JQL');
  }
  if (!jqlFilter.trim()) return true;
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(issueKey)) throw new OutboundScopeError('INVALID_ISSUE_KEY');
  const seen = new Set();
  let nextPageToken;
  // A key-constrained query normally returns at most one issue. Bound unexpected
  // pagination to protect the Forge invocation; exhaustion defers verification.
  for (let page = 0; page < 5; page += 1) {
    const result = await readCommentJson(() => api.asApp().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jql: `key = "${issueKey}" AND (${jqlFilter})`,
        fields: ['key'], maxResults: 100,
        ...(nextPageToken ? { nextPageToken } : {}),
        ...(Number.isSafeInteger(Number(issueId)) && Number(issueId) > 0
          ? { reconcileIssues: [Number(issueId)] } : {})
      })
    }), budget);
    if (!Array.isArray(result?.issues) || result.issues.some(issue => typeof issue?.key !== 'string')
        || typeof result.isLast !== 'boolean' || result.errorMessages?.length || result.warningMessages?.length) {
      throw new OutboundScopeError('JQL_RESPONSE_INVALID', true);
    }
    if (!result.isLast && (typeof result.nextPageToken !== 'string' || !result.nextPageToken || seen.has(result.nextPageToken))) {
      throw new OutboundScopeError('JQL_VERIFICATION_INCOMPLETE', true);
    }
    if (result.issues.some(issue => issue.key === issueKey)) return true;
    if (result.isLast) return false;
    nextPageToken = result.nextPageToken;
    seen.add(nextPageToken);
  }
  throw new OutboundScopeError('JQL_VERIFICATION_INCOMPLETE', true);
}

async function currentOrganization(orgId) {
  return orgId && orgId !== 'legacy'
    ? (await storage.get('organizations'))?.find(org => org.id === orgId)
    : await storage.get('syncConfig');
}

function selection(org) {
  return JSON.stringify({ projects: [...new Set(org?.allowedProjects || [])].sort(), jql: org?.jqlFilter || '' });
}

// Neither a mapping nor a caller's organization snapshot grants export authority.
export async function assertOutboundScope({ orgId, issueKey }) {
  try {
    const org = await currentOrganization(orgId);
    if (!org || !Array.isArray(org.allowedProjects) || !org.allowedProjects.length
        || org.allowedProjects.some(key => typeof key !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(key))) {
      throw new OutboundScopeError('PROJECTS_NOT_AUTHORIZED');
    }
    const budget = commentReadBudget();
    const issue = await readCommentJson(async () => ({ ok: true, json: () => getFullIssue(issueKey) }), budget);
    if (issue?.key !== issueKey || !issue?.fields?.project?.key) throw new OutboundScopeError('ISSUE_UNAVAILABLE', true);
    if (!org.allowedProjects.includes(issue.fields.project.key)) throw new OutboundScopeError('PROJECT_NOT_ALLOWED');
    if (!await matchesJqlFilter(issueKey, org.jqlFilter, issue.id, budget)) throw new OutboundScopeError('JQL_NOT_SELECTED');
    const latest = await currentOrganization(orgId);
    if (!latest || selection(latest) !== selection(org)) throw new OutboundScopeError('SCOPE_CHANGED', true);
    return { issue, org: latest };
  } catch (error) {
    if (error instanceof OutboundScopeError) throw error;
    throw new OutboundScopeError('SOURCE_SELECTION_UNAVAILABLE', true);
  }
}
