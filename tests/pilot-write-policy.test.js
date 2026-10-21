import { executeWriteOnce } from '../src/utils/retry.js';

jest.mock('../src/services/storage/stats.js', () => ({
  trackApiCall: jest.fn()
}));

describe('Pilot safety: executeWriteOnce never retries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('HTTP 429 invokes fn exactly once and reports a rate-limited outcome', async () => {
    const fn = jest.fn().mockResolvedValue({ ok: false, status: 429 });

    await expect(executeWriteOnce(fn, 'Create issue')).rejects.toMatchObject({
      code: 'RATE_LIMITED_WRITE_OUTCOME',
      status: 429
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('HTTP 503 invokes fn exactly once', async () => {
    const response = { ok: false, status: 503 };
    const fn = jest.fn().mockResolvedValue(response);

    await expect(executeWriteOnce(fn, 'Create issue')).resolves.toBe(response);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('successful write invokes fn exactly once', async () => {
    const response = { ok: true, status: 201 };
    const fn = jest.fn().mockResolvedValue(response);

    await expect(executeWriteOnce(fn, 'Create issue')).resolves.toBe(response);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
