import { getRemoteIssue } from '../src/services/jira/remote-client.js';
import { fetch } from '@forge/api';

jest.mock('@forge/api', () => ({
  __esModule: true,
  default: {},
  fetch: jest.fn()
}));

jest.mock('../src/services/storage/stats.js', () => ({
  trackApiCall: jest.fn(),
  trackWebhookSync: jest.fn(),
  logAuditEntry: jest.fn()
}));

describe('Pilot safety: safe reads may still retry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('GET issue retries after a transient network error', async () => {
    fetch
      .mockRejectedValueOnce(new Error('transient network error'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ key: 'REMOTE-1', fields: {} })
      });

    const result = await getRemoteIssue('REMOTE-1', {
      remoteUrl: 'https://target.atlassian.net',
      remoteEmail: 'sync@example.com',
      remoteApiToken: 'token'
    });

    expect(result).toEqual({ key: 'REMOTE-1', fields: {} });
    expect(fetch).toHaveBeenCalledTimes(2);
  }, 5000);
});
