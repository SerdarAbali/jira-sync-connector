import * as kvsStore from '../src/services/storage/kvs.js';

jest.mock('@forge/kvs', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
    getSecret: jest.fn(),
    setSecret: jest.fn(),
    deleteSecret: jest.fn(),
    query: jest.fn(),
    transact: jest.fn(),
  },
  WhereConditions: {
    beginsWith: (value) => ({ op: 'beginsWith', value }),
  },
}));

import kvs, { WhereConditions } from '@forge/kvs';

describe('KVS wrapper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('get returns value on success', async () => {
    kvs.get.mockResolvedValue({ foo: 'bar' });
    await expect(kvsStore.get('key')).resolves.toEqual({ foo: 'bar' });
    expect(kvs.get).toHaveBeenCalledWith('key');
  });

  test('get returns null on KEY_NOT_FOUND', async () => {
    const err = new Error('missing');
    err.code = 'KEY_NOT_FOUND';
    kvs.get.mockRejectedValue(err);
    await expect(kvsStore.get('missing')).resolves.toBeNull();
  });

  test('set stores raw value without ttl', async () => {
    kvs.set.mockResolvedValue(undefined);
    await kvsStore.set('k', 'v');
    expect(kvs.set).toHaveBeenCalledWith('k', 'v');
  });

  test('set with ttl wraps value with expiresAt', async () => {
    kvs.set.mockResolvedValue(undefined);
    await kvsStore.set('k', 'v', { ttl: 1000 });
    expect(kvs.set).toHaveBeenCalledWith(
      'k',
      expect.objectContaining({ value: 'v', expiresAt: expect.any(Number) })
    );
  });

  test('del calls delete and swallows KEY_NOT_FOUND', async () => {
    kvs.delete.mockResolvedValue(undefined);
    await kvsStore.del('k');
    expect(kvs.delete).toHaveBeenCalledWith('k');

    const err = new Error('missing');
    err.code = 'KEY_NOT_FOUND';
    kvs.delete.mockRejectedValueOnce(err);
    await expect(kvsStore.del('missing')).resolves.toBeUndefined();
  });

  test('getSecret/setSecret/deleteSecret delegate to kvs', async () => {
    kvs.getSecret.mockResolvedValue('secret');
    kvs.setSecret.mockResolvedValue(undefined);
    kvs.deleteSecret.mockResolvedValue(undefined);

    await expect(kvsStore.getSecret('s')).resolves.toBe('secret');
    await kvsStore.setSecret('s', 'v');
    await kvsStore.deleteSecret('s');

    expect(kvs.getSecret).toHaveBeenCalledWith('s');
    expect(kvs.setSecret).toHaveBeenCalledWith('s', 'v');
    expect(kvs.deleteSecret).toHaveBeenCalledWith('s');
  });

  test('queryByPrefix paginates with cursor', async () => {
    const builder = {
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      cursor: jest.fn().mockReturnThis(),
      getMany: jest
        .fn()
        .mockResolvedValueOnce({ results: [{ key: 'a', value: 1 }], nextCursor: 'c1' })
        .mockResolvedValueOnce({ results: [{ key: 'b', value: 2 }], nextCursor: null }),
    };
    kvs.query.mockReturnValue(builder);

    const results = await kvsStore.queryByPrefix('pre', 10);

    expect(results).toEqual([
      { key: 'a', value: 1 },
      { key: 'b', value: 2 },
    ]);
    expect(kvs.query).toHaveBeenCalled();
    expect(WhereConditions.beginsWith('pre')).toEqual({ op: 'beginsWith', value: 'pre' });
  });
});
