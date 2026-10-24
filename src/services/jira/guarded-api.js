/** Jira submission boundary: preserve SDK transport, add fail-closed checks. */
import api, { fetch as forgeFetch } from '@forge/api';
import { assertPilotWritesAllowed } from '../sync/pilot-pause.js';
import { assertIssueLeaseMigrationReady } from '../sync/lease-migration.js';
import { assertCurrentIssueLeases } from '../sync/issue-lease-context.js';
export { route } from '@forge/api';

export async function assertJiraSubmissionAllowed(path, options) {
  const method = String(options?.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return;
  // Jira enhanced search uses POST for a read. Keep previews/search usable
  // while rollout is blocked, without exempting any mutation endpoint.
  const pathname = new URL(path?.value ?? path, 'https://jira.invalid').pathname;
  if (method === 'POST' && pathname === '/rest/api/3/search/jql') return;
  await assertIssueLeaseMigrationReady();
  try {
    await assertPilotWritesAllowed('jira_submission');
  } catch (error) {
    if (error?.code === 'PILOT_PAUSED') throw error;
    const unavailable = new Error('Pause state could not be verified; no submission attempted');
    unavailable.code = 'PAUSE_STATE_UNAVAILABLE';
    throw unavailable;
  }
  await assertCurrentIssueLeases();
}

export async function fetch(url, options, beforeSend) {
  await assertJiraSubmissionAllowed(url, options);
  // Runs after every submission guard has passed and immediately before the SDK
  // transport receives the request. A throw here aborts the request unsent, so
  // callers may treat it as proof that no submission attempt was made.
  if (typeof beforeSend === 'function') await beforeSend();
  return forgeFetch(url, options);
}

function guardedClient(client) {
  return {
    ...client,
    requestJira: async (...args) => {
      await assertJiraSubmissionAllowed(args[0], args[1]);
      return client.requestJira(...args);
    }
  };
}

export default {
  asApp: (...args) => guardedClient(api.asApp(...args)),
  asUser: (...args) => guardedClient(api.asUser(...args))
};
