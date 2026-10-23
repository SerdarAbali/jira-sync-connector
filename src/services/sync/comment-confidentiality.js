const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * A successful Jira REST read is required: webhook omissions are not evidence
 * of unrestricted visibility. Group/role visibility and JSM public/internal
 * status are independent. No cross-site visibility mapping is supported.
 *
 * Missing visibility on an authoritative comment is Jira's unrestricted form,
 * JSM needs explicit public evidence; Software/Business may instead use freshly
 * verified project context. Unknown project types never grant disclosure.
 * Return codes only; never include comment content or restriction names.
 */
export function getCommentConfidentiality(comment, { authoritative = false, expectedId = null, projectTypeKey = null } = {}) {
  const denied = code => ({ allowed: false, code });
  if (!record(comment)) return denied('COMMENT_VISIBILITY_UNKNOWN');
  if (owns(comment, 'visibility')) {
    return denied(record(comment.visibility) && ['group', 'role'].includes(comment.visibility.type)
      ? 'COMMENT_RESTRICTED' : 'COMMENT_VISIBILITY_UNKNOWN');
  }

  const publicSignals = [];
  for (const key of ['jsdPublic', 'public', 'internal']) {
    if (!owns(comment, key)) continue;
    if (typeof comment[key] !== 'boolean') return denied('COMMENT_VISIBILITY_UNKNOWN');
    publicSignals.push(key === 'internal' ? !comment[key] : comment[key]);
  }
  if (owns(comment, 'properties')) {
    if (!Array.isArray(comment.properties)) return denied('COMMENT_VISIBILITY_UNKNOWN');
    for (const property of comment.properties) {
      if (!record(property) || typeof property.key !== 'string') return denied('COMMENT_VISIBILITY_UNKNOWN');
      if (!['sd.public.comment', 'sd.allow.public.comment'].includes(property.key)) continue;
      const key = property.key === 'sd.public.comment' ? 'internal' : 'allow';
      if (!record(property.value) || !owns(property.value, key)) return denied('COMMENT_VISIBILITY_UNKNOWN');
      const value = property.value[key];
      if (![true, false, 'true', 'false'].includes(value)) return denied('COMMENT_VISIBILITY_UNKNOWN');
      const enabled = value === true || value === 'true';
      publicSignals.push(key === 'internal' ? !enabled : enabled);
    }
  }
  if (publicSignals.includes(false)) return denied('COMMENT_RESTRICTED');
  const id = comment.id;
  if (!authoritative || (!publicSignals.length && !['software', 'business'].includes(projectTypeKey))
      || !((typeof id === 'string' && id.trim()) || (Number.isSafeInteger(id) && id > 0))
      || (expectedId !== null && String(id) !== String(expectedId))) {
    return denied('COMMENT_VISIBILITY_UNKNOWN');
  }
  return { allowed: true, code: 'COMMENT_UNRESTRICTED' };
}

/** Verify every known ancestor; an unsafe parent blocks the entire reply. */
export async function verifyCommentThread(comment, { expectedId, readParent, projectType, parentIdFor = commentParentId, knownAncestry = new Map() }) {
  const seen = new Set();
  const ancestry = new Map();
  let current = comment;
  let expected = expectedId;
  let parent = null;
  for (let depth = 0; depth < 8; depth++) {
    const knownParent = knownAncestry.get(String(current?.id));
    if (knownParent) current = withParentHints(current, { parentId: knownParent });
    let policy = getCommentConfidentiality(current, { authoritative: true, expectedId: expected });
    if (!policy.allowed && policy.code === 'COMMENT_VISIBILITY_UNKNOWN' && current) {
      policy = getCommentConfidentiality(current, {
        authoritative: true, expectedId: expected, projectTypeKey: await projectType()
      });
    }
    if (!policy.allowed) return { ...policy, parent: null };
    if (seen.has(String(current.id))) return { allowed: false, code: 'COMMENT_VISIBILITY_UNKNOWN', parent: null };
    seen.add(String(current.id));
    const parentId = parentIdFor(current);
    ancestry.set(String(current.id), parentId);
    if (!parentId) return { allowed: true, code: 'COMMENT_UNRESTRICTED', parent, ancestry };
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(parentId)) {
      return { allowed: false, code: 'COMMENT_VISIBILITY_UNKNOWN', parent: null };
    }
    expected = parentId;
    try {
      current = await readParent(parentId);
    } catch (error) {
      if (error?.code === 'COMMENT_VERIFICATION_DEFERRED') {
        error.parentId = parentIdFor(comment);
        error.ancestry = Array.from(ancestry);
      }
      throw error;
    }
    if (depth === 0) parent = current;
  }
  return { allowed: false, code: 'COMMENT_VISIBILITY_UNKNOWN', parent: null };
}

// Absence is null; malformed or conflicting evidence is an invalid sentinel.
// Legacy aliases/properties are conservative hints, not a Jira schema guarantee.
export function commentParentId(comment) {
  if (!record(comment)) return null;
  const ids = [];
  let invalid = false;
  const add = value => {
    if ((typeof value !== 'string' && typeof value !== 'number')
        || (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0))
        || !/^(?:[1-9][0-9]*|[A-Za-z][A-Za-z0-9_-]{0,99})$/.test(String(value))) invalid = true;
    else ids.push(String(value));
  };
  const parentObject = value => {
    if (!record(value) || (!owns(value, 'id') && !owns(value, 'commentId'))) { invalid = true; return; }
    for (const key of ['id', 'commentId']) if (owns(value, key)) add(value[key]);
  };
  const direct = value => {
    for (const key of ['parentId', 'parentCommentId', 'parentCommentID', 'jsdParentId', 'jsdParentID']) {
      if (owns(value, key)) add(value[key]);
    }
    if (owns(value, 'parent')) parentObject(value.parent);
  };
  direct(comment);
  const nested = (value, depth = 0) => {
    if (depth > 8) { invalid = true; return; }
    if (typeof value !== 'object' || value === null) { add(value); return; }
    const before = ids.length;
    for (const [key, child] of Object.entries(value)) {
      if (['parentId', 'parentCommentId', 'parentCommentID', 'commentId', 'id'].includes(key)) add(child);
      else if (key === 'parent') parentObject(child);
      else nested(child, depth + 1);
    }
    if (ids.length === before) invalid = true;
  };
  for (const property of Array.isArray(comment.properties) ? comment.properties : []) {
    if (/parent|thread/i.test(property?.key || '')) nested(property.value);
    else if (record(property?.value)) direct(property.value);
  }
  if (invalid || new Set(ids).size > 1) return '!unverifiable';
  return ids[0] || null;
}

export function withParentHints(comment, hints) {
  if (!record(comment)) return comment;
  const actual = commentParentId(comment);
  const hint = commentParentId(hints);
  if (actual === '!unverifiable' || hint === '!unverifiable' || (actual && hint && actual !== hint)) {
    return { ...comment, parentId: '!unverifiable' };
  }
  return !actual && hint ? { ...comment, parentId: hint } : comment;
}

/** A final read never trusts comment-list or earlier verification metadata. */
export async function verifyFreshCommentThread({ readComment, expectedId, readParent, projectType, hints, knownAncestry }) {
  const comment = withParentHints(await readComment(), hints);
  return { comment, ...await verifyCommentThread(comment, { expectedId, readParent, projectType, knownAncestry }) };
}
