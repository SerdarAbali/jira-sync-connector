const ATTACHMENT_ID_PATTERN = /^[1-9][0-9]{0,63}$/;

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
 * Build the only attachment download URL the app may use. The origin always
 * comes from validated configuration; an attachment ID never contributes a
 * host, scheme, or path.
 */
export function buildCanonicalAttachmentUrl({ jiraOrigin, attachmentId }) {
  const origin = normalizeJiraOrigin(jiraOrigin);
  const id = validateAttachmentId(attachmentId);
  return `${origin}/rest/api/3/attachment/content/${id}`;
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
