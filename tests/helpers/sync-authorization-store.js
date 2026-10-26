/**
 * Shared in-memory Forge KVS boundary for the synchronization authorization
 * suite. `kvsModule` is installed as the jest mock of the storage module and
 * `kvsStore` exposes the same functions for assertions and seeding.
 */
const store = new Map();
let failingKey = null;

function failure(key) {
  if (failingKey !== null && failingKey === key) {
    const error = new Error('kvs get failed');
    error.code = 'KVS_GET_FAILED';
    return error;
  }
  return null;
}

const get = jest.fn(async (key) => {
  const error = failure(key);
  if (error) throw error;
  return store.has(key) ? store.get(key) : null;
});

const set = jest.fn(async (key, value) => {
  store.set(key, value);
  return { key, value };
});

const del = jest.fn(async (key) => {
  store.delete(key);
  return { key };
});

const queryPageByPrefix = jest.fn(async (prefix, options = {}) => {
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 100);
  const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
  const start = options.cursor ? Number(options.cursor) : 0;
  const slice = keys.slice(start, start + limit);
  const nextIndex = start + slice.length;
  return {
    records: slice.map((key) => ({ key, value: store.get(key) })),
    nextCursor: nextIndex < keys.length ? String(nextIndex) : null
  };
});

const kvsModule = {
  get,
  set,
  del,
  getSecret: jest.fn(async (key) => (store.has(`secret:${key}`) ? store.get(`secret:${key}`) : null)),
  setSecret: jest.fn(async (key, value) => {
    store.set(`secret:${key}`, value);
  }),
  deleteSecret: jest.fn(async (key) => {
    store.delete(`secret:${key}`);
  }),
  createIfNotExists: jest.fn(async (key, value) => {
    if (store.has(key)) {
      const error = new Error('key exists');
      error.code = 'KEY_ALREADY_EXISTS';
      throw error;
    }
    store.set(key, value);
  }),
  setIfNotExists: jest.fn(async (key, value) => {
    if (store.has(key)) {
      const error = new Error('key exists');
      error.code = 'KEY_ALREADY_EXISTS';
      throw error;
    }
    store.set(key, value);
  }),
  setWithTtl: jest.fn(async (key, value) => {
    store.set(key, value);
  }),
  queryPageByPrefix,
  queryByPrefix: jest.fn(async (prefix, limit = 100) => {
    const page = await queryPageByPrefix(prefix, { limit });
    return page.records;
  }),
  transaction: jest.fn(() => ({
    set: () => ({ delete: () => ({ set: () => ({ execute: async () => ({}) }), execute: async () => ({}) }), execute: async () => ({}) }),
    delete: () => ({ set: () => ({ execute: async () => ({}) }), execute: async () => ({}) }),
    execute: async () => ({})
  }))
};

module.exports = {
  kvsModule,
  kvsStore: { get, set, del },
  resetAuthorizationStore: () => {
    store.delete('syncAuthorization');
    store.delete('pilotPause');
  },
  resetOrganizationStore: () => {
    store.delete('organizations');
  },
  seedOrganizations: (organizations) => {
    store.set('organizations', organizations);
  },
  setStoreFailure: (key) => {
    failingKey = key;
  },
  authorizationKeys: () => [...store.keys()].filter((key) => key === 'syncAuthorization'),
  storeSnapshot: () => new Map(store)
};
