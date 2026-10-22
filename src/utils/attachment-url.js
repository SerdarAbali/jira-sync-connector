const ATTACHMENT_ID_PATTERN = /^[1-9][0-9]{0,63}$/;
const ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-[0-9]{1,19}$/;
const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f]/g; // eslint-disable-line no-control-regex
const MAX_SAFE_FILENAME_BYTES = 200;


export class AttachmentUrlError extends Error {
  constructor(code) {
    super('Invalid Jira attachment reference');
    this.name = 'AttachmentUrlError';
    this.code = code;
  }
}

export function validateAttachmentId(attachmentId) {
  const normalized = typeof attachmentId === 'number' && Number.isSafeInteger(attachmentId)
    ? String(attachmentId)
    : attachmentId;

  if (typeof normalized !== 'string' || !ATTACHMENT_ID_PATTERN.test(normalized)) {
    throw new AttachmentUrlError('INVALID_ATTACHMENT_ID');
  }
  return normalized;
}

export function isValidAttachmentId(attachmentId) {
  try {
    validateAttachmentId(attachmentId);
    return true;
  } catch {
    return false;
  }
}

export function isValidIssueKey(issueKey) {
  return typeof issueKey === 'string'
    && issueKey.length <= 100
    && ISSUE_KEY_PATTERN.test(issueKey);
}

export function validateIssueKey(issueKey) {
  if (!isValidIssueKey(issueKey)) {
    throw new AttachmentUrlError('INVALID_ISSUE_KEY');
  }
  return issueKey;
}

export function normalizeJiraOrigin(jiraOrigin) {
  if (typeof jiraOrigin !== 'string' || jiraOrigin.trim().length === 0) {
    throw new AttachmentUrlError('INVALID_JIRA_ORIGIN');
  }

  let parsed;
  try {
    parsed = new URL(jiraOrigin);
  } catch {
    throw new AttachmentUrlError('INVALID_JIRA_ORIGIN');
  }

  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new AttachmentUrlError('INVALID_JIRA_ORIGIN');
  }

  return parsed.origin;
}

/**
 * Build a URL under the configured Jira origin. The supplied path is reduced to
 * a validated relative Jira REST path, so neither an attachment ID nor a caller
 * can introduce a host, scheme, credentials or query string.
 */
export function buildCanonicalJiraApiUrl({ jiraOrigin, path, query = null }) {
  const origin = normalizeJiraOrigin(jiraOrigin);
  if (typeof path !== 'string' || !path.startsWith('/rest/api/3/') || /[?#\\]/.test(path)) {
    throw new AttachmentUrlError('INVALID_JIRA_API_PATH');
  }

  const url = new URL(`${origin}${path}`);
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key)) {
        throw new AttachmentUrlError('INVALID_JIRA_API_QUERY');
      }
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Build the only attachment download URL the app may use. The origin always
 * comes from validated configuration; an attachment ID never contributes a
 * host, scheme, or path. `redirect=false` makes Jira return the bytes directly,
 * so credentials never follow a redirect to a media host.
 */
export function buildCanonicalAttachmentUrl({ jiraOrigin, attachmentId, redirect = false }) {
  const id = validateAttachmentId(attachmentId);
  return buildCanonicalJiraApiUrl({
    jiraOrigin,
    path: `/rest/api/3/attachment/content/${id}`,
    query: redirect === true ? null : { redirect: 'false' }
  });
}

export function buildAttachmentMetadataUrl({ jiraOrigin, attachmentId }) {
  const id = validateAttachmentId(attachmentId);
  return buildCanonicalJiraApiUrl({
    jiraOrigin,
    path: `/rest/api/3/attachment/${id}`
  });
}

export function buildAttachmentSettingsUrl({ jiraOrigin }) {
  return buildCanonicalJiraApiUrl({
    jiraOrigin,
    path: '/rest/api/3/attachment/meta'
  });
}

export function buildAttachmentDeleteUrl({ jiraOrigin, attachmentId }) {
  const id = validateAttachmentId(attachmentId);
  return buildCanonicalJiraApiUrl({
    jiraOrigin,
    path: `/rest/api/3/attachment/${id}`
  });
}

export function buildAttachmentUploadUrl({ jiraOrigin, issueKey }) {
  const key = validateIssueKey(issueKey);
  return buildCanonicalJiraApiUrl({
    jiraOrigin,
    path: `/rest/api/3/issue/${key}/attachments`
  });
}

export function extractAttachmentIdFromUrl(attachmentUrl) {
  if (typeof attachmentUrl !== 'string') {
    throw new AttachmentUrlError('INVALID_ATTACHMENT_URL');
  }

  let parsed;
  try {
    parsed = new URL(attachmentUrl);
  } catch {
    throw new AttachmentUrlError('INVALID_ATTACHMENT_URL');
  }

  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new AttachmentUrlError('INVALID_ATTACHMENT_URL');
  }

  const match = parsed.pathname.match(/\/rest\/api\/3\/attachment\/content\/([^/]+)$/);
  if (!match) {
    throw new AttachmentUrlError('INVALID_ATTACHMENT_URL');
  }
  return validateAttachmentId(match[1]);
}

/**
 * Normalize an attachment filename without allowing path traversal, header
 * injection, control characters, empty names, reserved dot names or oversized
 * values. Safe names (including spaces and Unicode) are preserved.
 */
export function sanitizeAttachmentFilename(filename) {
  if (typeof filename !== 'string') {
    return { ok: false, code: 'ATTACHMENT_FILENAME_REJECTED' };
  }

  const name = filename
    .replace(/[\\/]+/g, '_')
    .replace(UNSAFE_FILENAME_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+$/, '');

  if (!name) {
    return { ok: false, code: 'ATTACHMENT_FILENAME_REJECTED' };
  }

  if (Buffer.byteLength(name, 'utf8') > MAX_SAFE_FILENAME_BYTES) {
    return { ok: false, code: 'ATTACHMENT_FILENAME_TOO_LONG' };
  }

  return { ok: true, filename: name };
}

export function normalizeAttachmentMimeType(mimeType) {
  if (typeof mimeType !== 'string') {
    return 'application/octet-stream';
  }
  const normalized = mimeType.split(';', 1)[0].trim().toLowerCase();
  return MIME_TYPE_PATTERN.test(normalized) ? normalized : 'application/octet-stream';
}
