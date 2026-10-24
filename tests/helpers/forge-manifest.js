/**
 * Reader for the `app.storage.entities` section of manifest.yml.
 *
 * The repository does not depend on a YAML package, and existing manifest
 * assertions read the file by indentation (see
 * tests/batch9-manifest-scopes.test.js). This reader understands exactly the
 * subset Forge custom entities use today: entity names, typed attributes, and
 * simple or named indexes. Anything it does not understand throws instead of
 * silently accepting a schema, so an unparsed declaration fails the boundary
 * rather than disappearing from the model.
 */
const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.join(__dirname, '..', '..', 'manifest.yml');

function parseEntities(source) {
  const entities = new Map();
  let entity = null;
  let section = null;
  let attribute = null;
  let started = false;

  for (const raw of String(source).split(/\r?\n/)) {
    const text = raw.trim();
    if (!text || text.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;

    if (!started) {
      if (indent === 4 && text === 'entities:') started = true;
      continue;
    }
    // The entities block ends at the next key with an indentation of four
    // spaces or less (for example `  id:` under `app:`).
    if (indent <= 4) break;

    if (indent === 6 && text.startsWith('- name:')) {
      const name = text.slice('- name:'.length).trim();
      if (!name) throw new Error('Entity declaration without a name');
      if (entities.has(name)) throw new Error(`Duplicate entity declaration: ${name}`);
      entity = { name, attributes: {}, indexes: [] };
      entities.set(name, entity);
      section = null;
      attribute = null;
      continue;
    }
    if (!entity) throw new Error(`Unsupported entity manifest syntax: ${raw}`);

    if (indent === 8 && text === 'attributes:') { section = 'attributes'; attribute = null; continue; }
    if (indent === 8 && text === 'indexes:') { section = 'indexes'; attribute = null; continue; }
    if (indent === 8) throw new Error(`Unsupported entity manifest syntax: ${raw}`);

    if (section === 'attributes') {
      if (indent === 10 && /^[A-Za-z_][A-Za-z0-9_]*:$/.test(text)) {
        attribute = text.slice(0, -1);
        entity.attributes[attribute] = null;
        continue;
      }
      if (indent === 12 && attribute && text.startsWith('type:')) {
        entity.attributes[attribute] = text.slice('type:'.length).trim();
        continue;
      }
      throw new Error(`Unsupported attribute manifest syntax: ${raw}`);
    }

    if (section === 'indexes' && indent >= 10) {
      // Simple (`- name`) and named (`- name:`/`range:`/`partition:`) indexes
      // are recorded verbatim; nothing in this app queries them today.
      entity.indexes.push(text);
      continue;
    }
    throw new Error(`Unsupported entity manifest syntax: ${raw}`);
  }

  return entities;
}

function readManifest() {
  return fs.readFileSync(MANIFEST_PATH, 'utf8');
}

/** Parsed declarations from manifest.yml, or from an explicit override source. */
function readEntities(source = readManifest()) {
  const entities = parseEntities(source);
  // Forge requires at least the entity name and a typed attribute set; a
  // declared entity with no attributes can never store anything.
  for (const [name, entity] of entities) {
    for (const [attribute, type] of Object.entries(entity.attributes)) {
      if (!type) throw new Error(`Attribute ${name}.${attribute} has no type`);
    }
  }
  return entities;
}

module.exports = { MANIFEST_PATH, parseEntities, readManifest, readEntities };
