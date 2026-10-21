import { createHash } from 'crypto';
import { isValidADFDocument, textToADF, stripCrossReferenceFromADF } from '../../utils/adf.js';

const MAX_CANONICAL_DEPTH = 20;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  return value.replace(/\r\n?/g, '\n');
}

function normalizeNameCollection(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && typeof item.name === 'string') return item.name;
      return null;
    })
    .filter(item => typeof item === 'string' && item.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

function normalizeIdentifier(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.accountId === 'string' && value.accountId) return value.accountId;
  return null;
}

function normalizeAdfNode(node, depth = 0) {
  if (typeof node === 'string') {
    return node.replace(/\r\n?/g, '\n');
  }
  if (depth > MAX_CANONICAL_DEPTH || node === null || typeof node !== 'object') {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(child => normalizeAdfNode(child, depth + 1));
  }

  const normalized = {};
  if (typeof node.type === 'string') normalized.type = node.type;
  if (typeof node.text === 'string') normalized.text = node.text.replace(/\r\n?/g, '\n');
  if (Array.isArray(node.marks)) {
    const marks = node.marks
      .map(mark => normalizeAdfNode(mark, depth + 1))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (marks.length > 0) normalized.marks = marks;
  }
  if (isPlainObject(node.attrs)) {
    const attrs = {};
    const linkLikeNode = ['inlineCard', 'blockCard', 'embedCard'].includes(node.type);
    for (const key of Object.keys(node.attrs).sort()) {
      // `href` is user-authored synchronized link content (for example a link
      // mark). Preserve it. `url` is preserved only for explicitly link-like
      // nodes; media/image URLs are volatile display or download locations.
      if (key === 'url' && !linkLikeNode) continue;
      let value = normalizeAdfNode(node.attrs[key], depth + 1);
      if (typeof value === 'string' && (key === 'href' || key === 'url')) {
        value = value.trim();
      }
      if (value !== undefined) attrs[key] = value;
    }
    if (Object.keys(attrs).length > 0) normalized.attrs = attrs;
  }
  if (Array.isArray(node.content)) {
    normalized.content = node.content
      .map(child => normalizeAdfNode(child, depth + 1))
      .filter(child => child !== null && child !== undefined);
  }
  return normalized;
}

function emptyAdf() {
  return { type: 'doc', content: [] };
}


export const UNSUPPORTED_DESCRIPTION_TYPE = 'unsupported-description';

/**
 * Canonical ADF used only for hashing. Generated cross-reference boilerplate is
 * removed so connector-owned description rewrites do not change the hash.
 * Mark order, keys and media display URLs are normalized deterministically.
 */
export function normalizeDescriptionForHash(value) {
  let adf;
  if (value === null || value === undefined || value === '') {
    adf = emptyAdf();
  } else if (typeof value === 'string') {
    adf = textToADF(value);
  } else if (isValidADFDocument(value)) {
    adf = stripCrossReferenceFromADF(value);
  } else {
    // Explicit sentinel: malformed non-empty content must never collide with a
    // genuinely empty description. The original value is not retained.
    adf = { type: UNSUPPORTED_DESCRIPTION_TYPE };
  }
  return normalizeAdfNode(adf);
}

function canonicalizeValue(value, depth = 0) {
  if (depth > MAX_CANONICAL_DEPTH) return '[depth-limit]';
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) {
    return value.map(item => canonicalizeValue(item, depth + 1));
  }
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (['self', 'iconUrl', 'avatarUrls', 'expand'].includes(key)) continue;
      const normalized = canonicalizeValue(value[key], depth + 1);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  }
  return String(value);
}

function normalizeCustomFieldIdList(options) {
  const ids = new Set();
  if (Array.isArray(options.customFieldIds)) {
    options.customFieldIds.filter(id => typeof id === 'string' && id).forEach(id => ids.add(id));
  }
  if (options.fieldMappings && typeof options.fieldMappings === 'object') {
    for (const [key, mapping] of Object.entries(options.fieldMappings)) {
      if (typeof key === 'string' && key.startsWith('customfield_')) ids.add(key);
      const value = typeof mapping === 'string' ? mapping : mapping?.remoteId;
      if (typeof value === 'string' && value.startsWith('customfield_')) ids.add(value);
    }
  }
  return Array.from(ids).sort();
}


/**
 * Deterministic, content-free representation of synchronized issue fields.
 * This value is intended for hashing/tests only and must never be logged or
 * persisted. The input object is never mutated.
 */
export function buildNormalizedSynchronizedFields(fields, options = {}) {
  const source = isPlainObject(fields) ? fields : {};
  const normalized = {
    summary: normalizeText(source.summary),
    description: normalizeDescriptionForHash(source.description),
    priority: isPlainObject(source.priority) ? normalizeText(source.priority.name) : null,
    labels: Array.isArray(source.labels)
      ? source.labels.filter(label => typeof label === 'string').sort((a, b) => a.localeCompare(b))
      : [],
    dueDate: typeof source.duedate === 'string' && source.duedate ? source.duedate : null,
    components: normalizeNameCollection(source.components),
    fixVersions: normalizeNameCollection(source.fixVersions),
    affectsVersions: normalizeNameCollection(source.versions),
    timeTracking: isPlainObject(source.timetracking)
      ? canonicalizeValue(source.timetracking)
      : null,
    assignee: normalizeIdentifier(source.assignee),
    reporter: normalizeIdentifier(source.reporter),
    parent: source.parent && typeof source.parent.key === 'string' ? source.parent.key : null,
    status: options.includeStatus === false
      ? null
      : (isPlainObject(source.status) ? normalizeText(source.status.name) : null),
    issueType: isPlainObject(source.issuetype) ? normalizeText(source.issuetype.name) : null,
    custom: {}
  };

  for (const fieldId of normalizeCustomFieldIdList(options)) {
    normalized.custom[fieldId] = canonicalizeValue(source[fieldId]);
  }

  return normalized;
}

/**
 * SHA-256 over the canonical representation. Returns only the digest; the
 * canonical value is never logged or stored in KVS.
 */
export function hashSynchronizedFields(fields, options = {}) {
  const canonical = buildNormalizedSynchronizedFields(fields, options);
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}
