/**
 * Production custom-entity references must be declared in manifest.yml.
 *
 * F06's phase record used the `comment-submission` entity while the manifest
 * still declared only `issue-lease`. Unit tests could not detect this because
 * the Forge boundary carried a hard-coded entity allowlist; the boundary is now
 * manifest-driven (tests/helpers/forge-lease-runtime.js) and this suite pins the
 * declaration itself.
 */
const fs = require('fs');
const path = require('path');
const manifest = require('./helpers/forge-manifest');

const SOURCE_ROOT = path.join(__dirname, '..', 'src');
const declarations = manifest.readEntities();
const FORGE_ENTITY_NAME = /^[_a-z0-9:.-]{3,60}$/;
const FORGE_ATTRIBUTE_NAME = /^[_A-Za-z][_0-9A-Za-z]{0,29}$/;
const FORGE_ATTRIBUTE_TYPES = new Set(['string', 'integer', 'float', 'boolean', 'any']);

function sourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

/**
 * Resolve entity names from `kvs.entity(...)` and `entityName: ...` uses,
 * including module-local constants such as `OPERATION_ENTITY`. A literal that
 * is not declared in the manifest is reported instead of ignored.
 */
function referencedEntities() {
  const references = new Map();
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const code = fs.readFileSync(file, 'utf8');
    const constants = new Map();
    for (const match of code.matchAll(/([A-Z][A-Z0-9_]*)\s*=\s*['"]([a-z][\w:.-]*)['"]/g)) {
      constants.set(match[1], match[2]);
    }
    const add = name => {
      if (!references.has(name)) references.set(name, []);
      references.get(name).push(path.relative(path.join(__dirname, '..'), file));
    };
    for (const match of code.matchAll(/kvs\.entity\(\s*(?:'([^']+)'|"([^"]+)"|([A-Z][A-Z0-9_]*))\s*\)/g)) {
      const name = match[1] || match[2] || constants.get(match[3]);
      if (name) add(name);
    }
    for (const match of code.matchAll(/entityName:\s*(?:'([^']+)'|"([^"]+)"|([A-Z][A-Z0-9_]*))/g)) {
      const name = match[1] || match[2] || constants.get(match[3]);
      if (name) add(name);
    }
  }
  return references;
}

describe('F06 custom entity manifest declaration', () => {
  test('the comment-submission phase entity is declared', () => {
    expect(declarations.has('comment-submission')).toBe(true);
  });

  test('every custom entity referenced by production code is declared', () => {
    const references = referencedEntities();
    // Both F07 and F06 must remain visible; a scan that silently finds nothing
    // would hide exactly the defect this suite exists for.
    expect([...references.keys()].sort()).toEqual(['comment-submission', 'issue-lease']);
    for (const [name, files] of references) {
      expect({ name, declared: declarations.has(name), files }).toEqual({ name, declared: true, files });
    }
  });

  test('the declared attributes match the phase record exactly', () => {
    // Mirrors operationRecord/claimRecord in
    // src/services/sync/comment-submission.js. Adding a stored field without
    // declaring it here fails before the boundary has to reject it.
    expect(Object.entries(declarations.get('comment-submission').attributes)).toEqual([
      ['orgId', 'string'],
      ['direction', 'string'],
      ['issueKey', 'string'],
      ['commentId', 'string'],
      ['remoteKey', 'string'],
      ['state', 'string'],
      ['token', 'string'],
      ['reason', 'string'],
      ['createdAt', 'float'],
      ['updatedAt', 'float']
    ]);
  });

  test('no custom index is declared for keyed phase reads and transactions', () => {
    // Inspection reads one key and every write is a conditional transaction on
    // `token` + `state`; Forge's automatic by-key index covers those, so no
    // deploy-time indexing step is introduced (docs/F07-ISSUE-LEASE-DECISION.md:83).
    expect(declarations.get('comment-submission').indexes).toEqual([]);
  });

  test.each([...declarations.keys()])('entity %s follows the Forge schema limits', name => {
    const entity = declarations.get(name);
    expect(name).toMatch(FORGE_ENTITY_NAME);
    expect(name.startsWith('-') || name.startsWith('_')).toBe(false);
    expect(entity.attributes).not.toEqual({});
    expect(Object.keys(entity.attributes).length).toBeLessThanOrEqual(50);
    expect(entity.indexes.length).toBeLessThanOrEqual(7);
    for (const [attribute, type] of Object.entries(entity.attributes)) {
      expect(attribute).toMatch(FORGE_ATTRIBUTE_NAME);
      expect(FORGE_ATTRIBUTE_TYPES.has(type)).toBe(true);
    }
  });

  test('an untyped attribute is rejected instead of silently accepted', () => {
    expect(() => manifest.readEntities([
      'app:', '  storage:', '    entities:', '      - name: sample', '        attributes:',
      '          untyped:'
    ].join('\n'))).toThrow(/has no type/);
  });
});
