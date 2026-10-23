// Local Forge boundary model. Production Filter/transaction serialization comes
// from the installed SDK, not a hand-written replacement for its builders.
const entities = new Map();
const requests = [];
const state = { migration: null, beforeTransaction: null, failure: null };
function response(status, value) {
  return { ok: status < 400, status, headers: { get: () => null },
    text: async () => value === undefined ? '' : JSON.stringify(value) };
}
function matches(value, filters) {
  if (!filters) return true;
  const items = filters.and || filters.or;
  const match = ({ property, condition, values }) => {
    const current = value?.[property];
    switch (condition) {
      case 'NOT_EXISTS': return current === undefined;
      case 'EQUAL_TO': return current === values[0];
      case 'GREATER_THAN': return current !== undefined && current > values[0];
      case 'LESS_THAN_EQUAL_TO': return current !== undefined && current <= values[0];
      default: throw new Error(`Unmodelled condition ${condition}`);
    }
  };
  return filters.and ? items.every(match) : items.some(match);
}
async function fetchBoundary(_target, path, options) {
  const body = JSON.parse(options.body);
  requests.push({ path, body });
  if (state.failure) throw state.failure;
  if (path === '/api/v1/get' && body.key === 'issueLeaseMigration:v1') {
    return state.migration ? response(200, { key: body.key, value: state.migration })
      : response(404, { code: 'KEY_NOT_FOUND', message: 'Missing' });
  }
  if (path === '/api/v1/get' && body.key === 'pilotPause') {
    return response(404, { code: 'KEY_NOT_FOUND', message: 'Missing' });
  }
  if (path === '/api/v1/entity/get') {
    const value = entities.get(body.key);
    return value ? response(200, { key: body.key, value })
      : response(404, { code: 'KEY_NOT_FOUND', message: 'Missing' });
  }
  if (path === '/api/v1/transaction') {
    if (state.beforeTransaction) {
      const callback = state.beforeTransaction;
      state.beforeTransaction = null;
      await callback(body);
    }
    const ops = [...(body.set || []), ...(body.delete || []), ...(body.check || [])];
    if (ops.some(op => op.entityName !== 'issue-lease')) throw new Error('Unexpected entity');
    if (ops.some(op => !matches(entities.get(op.key), op.conditions))) {
      // A conditional rejection is never applied. Production also fails closed
      // for unrecognised Forge error codes (live rejection code needs validation).
      return response(409, { code: 'CONDITIONAL_CHECK_FAILED', message: 'Condition failed' });
    }
    for (const op of body.set || []) entities.set(op.key, { ...op.value });
    for (const op of body.delete || []) entities.delete(op.key);
    return response(204);
  }
  throw new Error(`Unexpected Forge KVS request: ${path}`);
}
function reset() {
  entities.clear(); requests.length = 0;
  state.failure = null; state.beforeTransaction = null;
  // Existing regression suites represent an already migrated installation.
  // Migration-specific tests replace/remove this explicit fixture.
  state.migration = { version: 1, phase: 'entity-active', legacyDisabled: true,
    disabledAt: 0, activatedAt: 1140000 };
  global.__forge_fetch__ = fetchBoundary;
}
module.exports = { entities, requests, state, reset };
