/** Jira submission boundary: preserve SDK transport, add fail-closed checks. */
import api, { fetch as forgeFetch } from '@forge/api';
import { assertPilotWritesAllowed } from '../sync/pilot-pause.js';
import { assertSyncAuthorized } from '../sync/sync-authorization.js';
import { assertIssueLeaseMigrationReady } from '../sync/lease-migration.js';
import { assertCurrentIssueLeases } from '../sync/issue-lease-context.js';
import {
  evaluatePairWitnessPermit,
  pairWitnessPermitMessage,
  PAIR_WITNESS_PERMIT_REASONS
} from '../sync/pair-witness-permit.js';
export { route } from '@forge/api';

/**
 * A permit-shaped request that fails its own checks is refused outright. It is
 * never retried through the ordinary chain, because "the pause would have
 * blocked it anyway" is not the same statement as "this exact payload is
 * approved", and only the second one is acceptable for a maintenance write.
 */
function permitRefusal(decision) {
  const error = new Error(
    decision.message || pairWitnessPermitMessage(decision.reason)
    || 'The maintenance permit does not authorize this write'
  );
  error.name = 'PairWitnessPermitError';
  error.code = 'PAIR_WITNESS_PERMIT_REFUSED';
  error.reason = decision.reason || PAIR_WITNESS_PERMIT_REASONS.PERMIT_MISSING;
  return error;
}

export async function assertJiraSubmissionAllowed(path, options) {
  const method = String(options?.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return;
  // Jira enhanced search uses POST for a read. Keep previews/search usable
  // while rollout is blocked, without exempting any mutation endpoint.
  const raw = path?.value ?? path;
  const pathname = new URL(raw, 'https://jira.invalid').pathname;
  if (method === 'POST' && pathname === '/rest/api/3/search/jql') return;

  // Narrow maintenance branch: evaluated first, and only for the exact approved
  // PUT shape. Anything that is not permit-shaped falls through to the ordinary
  // fail-closed chain below, unchanged and in the same order.
  const permit = await evaluatePairWitnessPermit({
    method,
    raw,
    pathname,
    body: options?.body
  });
  if (permit.allowed) return;
  if (permit.refusal === 'PERMIT_INVALID') throw permitRefusal(permit);

  await assertIssueLeaseMigrationReady();
  try {
    await assertPilotWritesAllowed('jira_submission');
  } catch (error) {
    if (error?.code === 'PILOT_PAUSED') throw error;
    const unavailable = new Error('Pause state could not be verified; no submission attempted');
    unavailable.code = 'PAUSE_STATE_UNAVAILABLE';
    throw unavailable;
  }
  // Positive authorization, independent of the pause. Absent, malformed,
  // unreadable, foreign or restore-in-progress authorization throws here and the
  // request is never handed to the SDK transport.
  await assertSyncAuthorized();
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
