import api, { fetch, route } from '@forge/api';
import { readCommentJson } from './comment-read.js';

// Cache only within the verification operation, never across installations.
export async function getCommentProjectType(issueKey, config, budget) {
  const cacheKey = `project:${issueKey}`;
  if (budget.cache.has(cacheKey)) return budget.cache.get(cacheKey);
  const remote = !!config;
  const headers = remote ? {
    Authorization: `Basic ${Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64')}`,
    Accept: 'application/json'
  } : { Accept: 'application/json' };
  const read = (path, localRoute) => readCommentJson(() => remote
    ? fetch(`${config.remoteUrl}${path}`, { method: 'GET', redirect: 'error', headers })
    : api.asApp().requestJira(localRoute, { method: 'GET', headers }), budget);
  const issue = await read(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=project`,
    route`/rest/api/3/issue/${issueKey}?fields=project`);
  const project = issue?.fields?.project;
  let type = project?.projectTypeKey;
  if (!type && typeof project?.id === 'string' && /^\d+$/.test(project.id)) {
    const details = await read(`/rest/api/3/project/${project.id}`, route`/rest/api/3/project/${project.id}`);
    type = details?.projectTypeKey;
  }
  const verified = ['software', 'business', 'service_desk'].includes(type) ? type : null;
  budget.cache.set(cacheKey, verified);
  return verified;
}
