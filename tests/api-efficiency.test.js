const mockRequestJira = jest.fn();
jest.mock('@forge/api', () => ({
  __esModule: true,
  default: { asApp: () => ({ requestJira: mockRequestJira }) },
  route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), '')
}));

import { getOrgName } from '../src/services/jira/local-client.js';

describe('API efficiency: display-only organization name', () => {
  test('coalesces concurrent and repeated serverInfo reads', async () => {
    // Without the cache, each getOrgName invocation would issue its own
    // /serverInfo GET (three invocations = three requests). The deterministic
    // mocked call count below is therefore 3 before / 1 after.
    mockRequestJira.mockResolvedValue({
      ok: true,
      json: async () => ({ baseUrl: 'https://local-site.atlassian.net' })
    });

    const [first, second] = await Promise.all([getOrgName(), getOrgName()]);
    const third = await getOrgName();

    expect(first).toBe('local-site');
    expect(second).toBe('local-site');
    expect(third).toBe('local-site');
    expect(mockRequestJira).toHaveBeenCalledTimes(1);
  });
});
