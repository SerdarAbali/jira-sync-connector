// Local Forge boundary model. Production Filter/transaction serialization comes
// from the installed SDK, not a hand-written replacement for its builders.
// Entity names and attributes are read from manifest.yml so an undeclared
// custom entity or attribute cannot silently work in tests.
const manifest = require('./forge-manifest');

const entities = new Map();
const requests = [];
const state = { migration: null, beforeTransaction: null, beforeSet: null, failure: null, basicStore: null };
let declarations = manifest.readEntities();
function response(status, value) {
  return { ok: status < 400, status, headers: { get: () => null },
    text: async () => value === undefined ? '' : JSON.stringify(value) };
}
function conditionsOf(filter) {
  if (!filter) return [];
  const items = filter.and || filter.or;
  if (!Array.isArray(items)) throw new Error('Unmodelled filter shape');
  return items.flatMap(item => item.condition
    ? [{ property: item.property, condition: item.condition }]
    : conditionsOf(item));
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
function declaredEntity(name) {
  const declaration = declarations.get(name);
  if (!declaration) {
    throw new Error(`Undeclared custom entity "${name}" in ${manifest.MANIFEST_PATH}`);
  }
  return declaration;
}
function assertDeclaredAttributes(declaration, operation) {
  for (const [attribute, value] of Object.entries(operation.value || {})) {
    const type = declaration.attributes[attribute];
    if (!type) {
      throw new Error(`Attribute "${attribute}" is not declared for entity "${declaration.name}"`);
    }
    const valid = type === 'any'
      || (type === 'string' && typeof value === 'string')
      || (type === 'boolean' && typeof value === 'boolean')
      || ((type === 'float' || type === 'integer') && typeof value === 'number');
    if (!valid) {
      throw new Error(`Attribute "${attribute}" of entity "${declaration.name}" is not ${type}`);
    }
  }
  for (const { property } of conditionsOf(operation.conditions)) {
    if (!(property in declaration.attributes)) {
      throw new Error(`Condition attribute "${property}" is not declared for entity "${declaration.name}"`);
    }
  }
}
async function fetchBoundary(_target, path, options) {
  const body = JSON.parse(options.body);
  requests.push({ path, body });
  if (state.failure) throw state.failure;
  if (path === '/api/v1/get' && body.key === 'issueLeaseMigration:v1') {
    return state.migration !== null && state.migration !== undefined ? response(200, { key: body.key, value: state.migration })
      : response(404, { code: 'KEY_NOT_FOUND', message: 'Missing' });
  }
  if (path === '/api/v1/set' && body.key === 'issueLeaseMigration:v1') {
    if (body.options?.keyPolicy !== 'FAIL_IF_EXISTS') throw new Error('Unconditional migration write');
    if (state.beforeSet) {
      const callback = state.beforeSet; state.beforeSet = null; await callback(body);
    }
    if (state.migration !== null && state.migration !== undefined) {
      return response(409, { code: 'KEY_ALREADY_EXISTS', message: 'Key already exists' });
    }
    state.migration = body.value;
    return response(204);
  }
  if (path === '/api/v1/get' && body.key === 'pilotPause') {
    return response(404, { code: 'KEY_NOT_FOUND', message: 'Missing' });
  }
  if (path === '/api/v1/entity/get') {
    if (body.entityName) declaredEntity(body.entityName);
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
    const sets = body.set || [];
    const deletes = body.delete || [];
    const checks = body.check || [];
    if (checks.some(op => !op.entityName)) throw new Error('Unexpected basic KVS check');
    // Entity operations must reference a declared entity and only declared
    // attributes, in both the written value and every condition predicate.
    const entityOperations = [
      ...sets.filter(op => op.entityName),
      ...deletes.filter(op => op.entityName),
      ...checks
    ];
    for (const op of entityOperations) {
      assertDeclaredAttributes(declaredEntity(op.entityName), op);
    }
    // Entity-less operations are Key-Value Store transactions. They are only
    // modelled when the calling suite links its basic store; otherwise an
    // entity-less transaction stays an error instead of becoming a silent
    // basic write.
    const basicSets = sets.filter(op => !op.entityName);
    const basicDeletes = deletes.filter(op => !op.entityName);
    if ((basicSets.length + basicDeletes.length) && !state.basicStore) {
      throw new Error('Basic KVS transaction is not modelled for this suite');
    }
    if (entityOperations.some(op => !matches(entities.get(op.key), op.conditions))) {
      // A conditional rejection is never applied. Production also fails closed
      // for unrecognised Forge error codes (live rejection code needs validation).
      return response(409, { code: 'CONDITIONAL_CHECK_FAILED', message: 'Condition failed' });
    }
    // Key-Value Store and custom entity writes in one transaction commit or
    // roll back together, as the platform guarantees.
    for (const op of basicSets) state.basicStore.set(op.key, op.value);
    for (const op of basicDeletes) state.basicStore.delete(op.key);
    for (const op of sets.filter(op => op.entityName)) entities.set(op.key, { ...op.value });
    for (const op of deletes.filter(op => op.entityName)) entities.delete(op.key);
    return response(204);
  }
  throw new Error(`Unexpected Forge KVS request: ${path}`);
}
/** Parse declarations from an explicit manifest source (tests only). */
function useManifest(source) {
  declarations = manifest.readEntities(source);
}
function reset() {
  entities.clear(); requests.length = 0;
  state.failure = null; state.beforeTransaction = null; state.beforeSet = null; state.basicStore = null;
  declarations = manifest.readEntities();
  // Existing regression suites represent an already migrated installation.
  // Migration-specific tests replace/remove this explicit fixture.
  state.migration = { version: 1, phase: 'entity-active', legacyDisabled: true,
    disabledAt: 0, activatedAt: 1140000 };
  global.__forge_fetch__ = fetchBoundary;
}
module.exports = { entities, requests, state, reset, useManifest,
  declaredEntities: () => declarations };
