jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  return {
    __esModule: true, default: { asApp: () => ({ requestJira }) },
    route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), '')
  };
});
jest.mock('../src/services/storage/kvs.js', () => ({ get: jest.fn() }));
jest.mock('../src/services/jira/local-client.js', () => ({ getFullIssue: jest.fn() }));
jest.mock('../src/services/storage/stats.js', () => ({ trackApiCall: jest.fn() }));

import api from '@forge/api';
import * as storage from '../src/services/storage/kvs.js';
import { getFullIssue } from '../src/services/jira/local-client.js';
import { assertOutboundScope, matchesJqlFilter } from '../src/services/sync/outbound-scope.js';
import { executeWriteOnce, retryWithBackoff } from '../src/utils/retry.js';
import { executeWriteWithRetry } from '../src/services/sync/write-retry.js';

const request = api.asApp().requestJira;
const org = { id: 'org-1', allowedProjects: ['LOCAL'], jqlFilter: 'labels = selected' };
const response = value => ({ ok: true, json: async () => value });

test.each([
  ['single-shot', executeWriteOnce, false],
  ['single-shot', executeWriteOnce, true],
  ['idempotent', executeWriteWithRetry, false],
  ['idempotent', executeWriteWithRetry, true]
])('%s write retains a pre-submission scope rejection (unverifiable=%s)', async (_name, execute, unverifiable) => {
  request.mockResolvedValue(response(unverifiable ? { issues: [] } : { issues: [], isLast: true }));
  const mutation = jest.fn(() => request('/rest/api/3/issue/REMOTE-1', { method: 'PUT' }));
  let rejection;
  const attempt = jest.fn(async () => {
    try {
      await assertOutboundScope({ orgId: org.id, issueKey: 'LOCAL-1' });
    } catch (error) {
      rejection = error;
      throw error;
    }
    return mutation();
  });
  // An outer retry layer must also preserve the rejection without resubmitting.
  await expect(retryWithBackoff(() => execute(attempt, 'scope guarded write'), 'outer write'))
    .rejects.toMatchObject({
      code: unverifiable ? 'OUTBOUND_SCOPE_UNVERIFIABLE' : 'OUTBOUND_SCOPE_BLOCKED',
      reason: unverifiable ? 'JQL_RESPONSE_INVALID' : 'JQL_NOT_SELECTED',
      message: `Outbound source selection denied: ${unverifiable ? 'JQL_RESPONSE_INVALID' : 'JQL_NOT_SELECTED'}`,
      retryable: unverifiable
    });
  expect(attempt).toHaveBeenCalledTimes(1);
  expect(rejection.message).toBe(`Outbound source selection denied: ${rejection.reason}`);
  expect(mutation).not.toHaveBeenCalled();
  // The only Jira transport call was the read-only enhanced search POST.
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toBe('/rest/api/3/search/jql');
});

beforeEach(() => {
  jest.resetAllMocks();
  storage.get.mockResolvedValue([org]);
  getFullIssue.mockResolvedValue({ id: '10001', key: 'LOCAL-1', fields: { project: { key: 'LOCAL' } } });
  request.mockResolvedValue(response({ issues: [{ key: 'LOCAL-1' }], isLast: true }));
});

test('uses current organization scope, specific key membership and reconcileIssues', async () => {
  await expect(assertOutboundScope({ orgId: 'org-1', issueKey: 'LOCAL-1' })).resolves.toHaveProperty('issue.key', 'LOCAL-1');
  expect(JSON.parse(request.mock.calls[0][1].body)).toEqual(expect.objectContaining({
    jql: 'key = "LOCAL-1" AND (labels = selected)', reconcileIssues: [10001]
  }));
});

test('follows the documented nextPageToken to verify membership', async () => {
  request.mockResolvedValueOnce(response({ issues: [{ key: 'OTHER-1' }], isLast: false, nextPageToken: 'page2' }));
  await expect(matchesJqlFilter('LOCAL-1', org.jqlFilter)).resolves.toBe(true);
  expect(JSON.parse(request.mock.calls[1][1].body).nextPageToken).toBe('page2');
});

test.each([
  { issues: [] }, { issues: null, isLast: true }, { issues: [null], isLast: true },
  { issues: [], isLast: false }, { issues: [], isLast: false, nextPageToken: '' }
])('malformed or incomplete enhanced response defers export: %p', async value => {
  request.mockResolvedValue(response(value));
  await expect(assertOutboundScope({ orgId: org.id, issueKey: 'LOCAL-1' })).rejects.toMatchObject({ code: 'OUTBOUND_SCOPE_UNVERIFIABLE', retryable: true });
});

test('repeated tokens and invocation pagination exhaustion fail closed', async () => {
  request.mockResolvedValue(response({ issues: [], isLast: false, nextPageToken: 'loop' }));
  await expect(matchesJqlFilter('LOCAL-1', org.jqlFilter)).rejects.toMatchObject({ reason: 'JQL_VERIFICATION_INCOMPLETE' });
  expect(request).toHaveBeenCalledTimes(2);
  request.mockClear().mockImplementation(async () => response({ issues: [], isLast: false, nextPageToken: `page${request.mock.calls.length}` }));
  await expect(matchesJqlFilter('LOCAL-1', org.jqlFilter)).rejects.toMatchObject({ reason: 'JQL_VERIFICATION_INCOMPLETE' });
  expect(request).toHaveBeenCalledTimes(5);
});

test.each(['network', 'JSON', 'HTTP'])('unavailable JQL verification (%s) never authorizes export', async mode => {
  if (mode === 'network') request.mockRejectedValue(new Error('unavailable'));
  if (mode === 'JSON') request.mockResolvedValue({ ok: true, json: async () => { throw new Error('bad JSON'); } });
  if (mode === 'HTTP') request.mockResolvedValue({ ok: false, status: 429 });
  await expect(assertOutboundScope({ orgId: org.id, issueKey: 'LOCAL-1' })).rejects.toMatchObject({ retryable: true });
});

test.each([
  ['revoked', []], ['other organization', [{ ...org, id: 'org-2' }]],
  ['excluded', [{ ...org, allowedProjects: ['OTHER'] }]]
])('current scope %s overrides a previously accepted caller', async (_name, organizations) => {
  storage.get.mockResolvedValue(organizations);
  await expect(assertOutboundScope({ orgId: org.id, issueKey: 'LOCAL-1' })).rejects.toMatchObject({ code: 'OUTBOUND_SCOPE_BLOCKED' });
  expect(request).not.toHaveBeenCalled();
});

test('a project move is checked from the current Jira issue', async () => {
  getFullIssue.mockResolvedValue({ key: 'LOCAL-1', fields: { project: { key: 'PRIVATE' } } });
  await expect(assertOutboundScope({ orgId: org.id, issueKey: 'LOCAL-1' })).rejects.toMatchObject({ reason: 'PROJECT_NOT_ALLOWED' });
});

test('configuration change during verification defers export', async () => {
  storage.get.mockResolvedValueOnce([org]).mockResolvedValue([{ ...org, jqlFilter: 'labels = revoked' }]);
  await expect(assertOutboundScope({ orgId: org.id, issueKey: 'LOCAL-1' })).rejects.toMatchObject({ reason: 'SCOPE_CHANGED', retryable: true });
});

test('absent or whitespace JQL needs no search; nonmatching keys are rejected', async () => {
  await expect(matchesJqlFilter('LOCAL-1', '')).resolves.toBe(true);
  await expect(matchesJqlFilter('LOCAL-1', '  ')).resolves.toBe(true);
  expect(request).not.toHaveBeenCalled();
  request.mockResolvedValue(response({ issues: [{ key: 'LOCAL-9' }], isLast: true }));
  await expect(assertOutboundScope({ orgId: org.id, issueKey: 'LOCAL-1' })).rejects.toMatchObject({ reason: 'JQL_NOT_SELECTED' });
});
