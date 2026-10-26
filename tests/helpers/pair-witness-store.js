/**
 * In-memory Forge KVS boundary for the pairing-witness suites.
 *
 * `kvsModule` is what the storage module is mocked with; `store` exposes the
 * same functions so a test can seed records and assert that nothing was written.
 * Every function is a jest mock, so a zero-write assertion is a call-count check.
 */
const records = new Map();

const get = jest.fn(async (key) => (records.has(key) ? records.get(key) : null));

const set = jest.fn(async (key, value) => {
  records.set(key, value);
  return { key, value };
});

const del = jest.fn(async (key) => {
  records.delete(key);
  return { key };
});

const queryPageByPrefix = jest.fn(async (prefix, options = {}) => {
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 100);
  const keys = [...records.keys()].filter((key) => key.startsWith(prefix)).sort();
  const start = options.cursor ? Number(options.cursor) : 0;
  const slice = keys.slice(start, start + limit);
  const nextIndex = start + slice.length;
  return {
    records: slice.map((key) => ({ key, value: records.get(key) })),
    nextCursor: nextIndex < keys.length ? String(nextIndex) : null
  };
});

const kvsModule = {
  get,
  set,
  del,
  getSecret: jest.fn(async (key) => (records.has(key) ? records.get(key) : null)),
  setSecret: jest.fn(async (key, value) => {
    records.set(key, value);
  }),
  deleteSecret: jest.fn(async (key) => {
    records.delete(key);
  }),
  createIfNotExists: jest.fn(async (key, value) => {
    if (records.has(key)) {
      const error = new Error('key exists');
      error.code = 'KEY_ALREADY_EXISTS';
      throw error;
    }
    records.set(key, value);
  }),
  setIfNotExists: jest.fn(async (key, value) => {
    if (records.has(key)) {
      const error = new Error('key exists');
      error.code = 'KEY_ALREADY_EXISTS';
      throw error;
    }
    records.set(key, value);
  }),
  setWithTtl: jest.fn(async (key, value) => {
    records.set(key, value);
  }),
  queryPageByPrefix,
  queryByPrefix: jest.fn(async (prefix, limit = 100) => {
    const page = await queryPageByPrefix(prefix, { limit });
    return page.records;
  }),
  transaction: jest.fn(() => ({
    set: () => ({
      delete: () => ({ set: () => ({ execute: async () => ({}) }), execute: async () => ({}) }),
      execute: async () => ({})
    }),
    delete: () => ({ set: () => ({ execute: async () => ({}) }), execute: async () => ({}) }),
    execute: async () => ({})
  }))
};

module.exports = {
  kvsModule,
  store: { get, set, del, queryPageByPrefix },
  resetStore: () => {
    records.clear();
    get.mockClear();
    set.mockClear();
    del.mockClear();
    queryPageByPrefix.mockClear();
  },
  seed: (key, value) => {
    records.set(key, value);
  },
  keys: () => [...records.keys()].sort()
};
