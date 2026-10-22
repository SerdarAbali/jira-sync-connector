import { randomBytes } from 'crypto';
import api, { fetch, route } from '@forge/api';
import {
  buildAttachmentDeleteUrl,
  buildAttachmentMetadataUrl,
  buildAttachmentSettingsUrl,
  buildAttachmentUploadUrl,
  buildCanonicalAttachmentUrl,
  isValidAttachmentId,
  normalizeJiraOrigin,
  validateAttachmentId,
  validateIssueKey
} from '../../utils/attachment-url.js';

export const ATTACHMENT_SOURCE = Object.freeze({
  LOCAL: 'local',
  REMOTE: 'remote'
});

export const ATTACHMENT_CLIENT_CODES = Object.freeze({
  INVALID_SOURCE: 'ATTACHMENT_SOURCE_INVALID',
  INVALID_CONFIG: 'ATTACHMENT_CONFIG_INVALID',
  INVALID_ID: 'INVALID_ATTACHMENT_ID',
  SETTINGS_UNAVAILABLE: 'ATTACHMENT_SETTINGS_UNAVAILABLE',
  SETTINGS_DISABLED: 'ATTACHMENT_SETTINGS_DISABLED',
  METADATA_UNAVAILABLE: 'ATTACHMENT_METADATA_UNAVAILABLE',
  METADATA_INVALID: 'ATTACHMENT_METADATA_INVALID',
  NOT_FOUND: 'ATTACHMENT_NOT_FOUND',
  PERMISSION_DENIED: 'ATTACHMENT_PERMISSION_DENIED',
  DOWNLOAD_UNAVAILABLE: 'ATTACHMENT_DOWNLOAD_UNAVAILABLE',
  DOWNLOAD_CROSS_ORIGIN: 'ATTACHMENT_CROSS_ORIGIN_REDIRECT',
  ACTUAL_SIZE_EXCEEDED: 'ATTACHMENT_ACTUAL_SIZE_EXCEEDED',
  UPLOAD_OUTCOME_UNKNOWN: 'ATTACHMENT_UPLOAD_OUTCOME_UNKNOWN',
  UPLOAD_REJECTED: 'ATTACHMENT_UPLOAD_REJECTED',
  UPLOAD_TOO_LARGE: 'ATTACHMENT_UPLOAD_TOO_LARGE',
  UPLOAD_MALFORMED_RESPONSE: 'ATTACHMENT_UPLOAD_MALFORMED_RESPONSE',
  DELETE_OUTCOME_UNKNOWN: 'ATTACHMENT_DELETE_OUTCOME_UNKNOWN',
  DELETE_REJECTED: 'ATTACHMENT_DELETE_REJECTED'
});

export class AttachmentClientError extends Error {
  constructor(code, { status = null, ambiguous = false } = {}) {
    super('Jira attachment operation could not be completed');
    this.name = 'AttachmentClientError';
    this.code = code;
    this.status = status;
    this.ambiguous = ambiguous;
  }
}

function isRemote(source) {
  return source === ATTACHMENT_SOURCE.REMOTE;
}

function isLocal(source) {
  return source === ATTACHMENT_SOURCE.LOCAL;
}

function requireSource(source) {
  if (!isRemote(source) && !isLocal(source)) {
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.INVALID_SOURCE);
  }
}

function remoteAuth(config) {
  if (!config
      || typeof config.remoteUrl !== 'string'
      || typeof config.remoteEmail !== 'string'
      || typeof config.remoteApiToken !== 'string'
      || !config.remoteEmail
      || !config.remoteApiToken) {
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.INVALID_CONFIG);
  }
  return Buffer.from(`${config.remoteEmail}:${config.remoteApiToken}`).toString('base64');
}

function remoteOrigin(config) {
  try {
    return normalizeJiraOrigin(config?.remoteUrl);
  } catch {
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.INVALID_CONFIG);
  }
}

function safeStatus(response) {
  const status = Number(response?.status);
  return Number.isInteger(status) ? status : null;
}

function isDefinitiveRejection(status) {
  return Number.isInteger(status)
    && status >= 400
    && status < 500
    && status !== 408
    && status !== 425
    && status !== 429;
}

function permissionCode(status) {
  return status === 401 || status === 403
    ? ATTACHMENT_CLIENT_CODES.PERMISSION_DENIED
    : null;
}

function ensureSameOrigin(response, expectedOrigin) {
  const responseUrl = response?.url;
  if (!responseUrl) return;
  let origin;
  try {
    origin = new URL(responseUrl).origin;
  } catch {
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.DOWNLOAD_CROSS_ORIGIN);
  }
  if (origin !== expectedOrigin) {
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.DOWNLOAD_CROSS_ORIGIN);
  }
}

async function requestRemote(url, config, options = {}) {
  const auth = remoteAuth(config);
  return await fetch(url, {
    ...options,
    redirect: 'error',
    headers: {
      Authorization: `Basic ${auth}`,
      ...(options.headers || {})
    }
  });
}

async function requestLocal(pathOrRoute, options = {}) {
  return await api.asApp().requestJira(pathOrRoute, options);
}

function readContentLength(response) {
  const value = response?.headers?.get?.('content-length');
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Read at most `maxBytes` from a Fetch Response. When a stream is available the
 * reader stops as soon as the real byte count exceeds the limit, so a false or
 * absent metadata size cannot force an unbounded download.
 */
export async function readResponseBytesBounded(response, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.SETTINGS_UNAVAILABLE);
  }

  const declaredLength = readContentLength(response);
  if (declaredLength !== null && declaredLength > maxBytes) {
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.ACTUAL_SIZE_EXCEEDED);
  }

  const body = response?.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || typeof value.byteLength !== 'number') {
          throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.DOWNLOAD_UNAVAILABLE);
        }
        total += value.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel('attachment-size-limit');
          } catch {
            // The over-limit condition is the authoritative outcome.
          }
          throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.ACTUAL_SIZE_EXCEEDED);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // No-op for already-cancelled streams.
      }
    }
    return Buffer.concat(chunks, total);
  }

  if (typeof response?.arrayBuffer !== 'function') {
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.DOWNLOAD_UNAVAILABLE);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.ACTUAL_SIZE_EXCEEDED);
  }
  return bytes;
}

async function parseJsonResponse(response) {
  if (typeof response?.json !== 'function') {
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.METADATA_INVALID);
  }
  try {
    return await response.json();
  } catch {
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.METADATA_INVALID);
  }
}

export async function getAttachmentSettings({ source, config = null }) {
  requireSource(source);
  try {
    const response = isRemote(source)
      ? await requestRemote(
        buildAttachmentSettingsUrl({ jiraOrigin: remoteOrigin(config) }),
        config,
        { method: 'GET', headers: { Accept: 'application/json' } }
      )
      : await requestLocal(route`/rest/api/3/attachment/meta`, {
        method: 'GET',
        headers: { Accept: 'application/json' }
      });

    if (!response?.ok) {
      throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.SETTINGS_UNAVAILABLE, {
        status: safeStatus(response)
      });
    }
    const data = await parseJsonResponse(response);
    if (!data || typeof data.enabled !== 'boolean'
        || !Number.isSafeInteger(data.uploadLimit)
        || data.uploadLimit <= 0) {
      throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.SETTINGS_UNAVAILABLE);
    }
    if (data.enabled !== true) {
      throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.SETTINGS_DISABLED);
    }
    return { enabled: true, uploadLimit: data.uploadLimit };
  } catch (error) {
    if (error instanceof AttachmentClientError) throw error;
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.SETTINGS_UNAVAILABLE);
  }
}

export async function getAttachmentMetadata({ source, attachmentId, config = null }) {
  requireSource(source);
  const id = validateAttachmentId(attachmentId);

  let response;
  try {
    response = isRemote(source)
      ? await requestRemote(
        buildAttachmentMetadataUrl({ jiraOrigin: remoteOrigin(config), attachmentId: id }),
        config,
        { method: 'GET', headers: { Accept: 'application/json' } }
      )
      : await requestLocal(route`/rest/api/3/attachment/${id}`, {
        method: 'GET',
        headers: { Accept: 'application/json' }
      });
  } catch (error) {
    if (error instanceof AttachmentClientError) throw error;
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.METADATA_UNAVAILABLE);
  }

  if (!response?.ok) {
    const status = safeStatus(response);
    if (status === 404) {
      throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.NOT_FOUND, { status });
    }
    const permission = permissionCode(status);
    if (permission) throw new AttachmentClientError(permission, { status });
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.METADATA_UNAVAILABLE, { status });
  }

  const data = await parseJsonResponse(response);
  const metadataId = data?.id === undefined || data?.id === null ? null : String(data.id);
  if (!metadataId || !isValidAttachmentId(metadataId) || metadataId !== id
      || typeof data?.filename !== 'string'
      || !Number.isSafeInteger(data?.size)
      || data.size < 0
      || (data?.mimeType !== undefined && typeof data.mimeType !== 'string')) {
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.METADATA_INVALID);
  }

  return {
    id: metadataId,
    filename: data.filename,
    mimeType: typeof data.mimeType === 'string' ? data.mimeType : '',
    size: data.size,
    created: typeof data.created === 'string' ? data.created : null
  };
}

export async function downloadAttachmentContent({
  source,
  attachmentId,
  config = null,
  maxBytes
}) {
  requireSource(source);
  const id = validateAttachmentId(attachmentId);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.SETTINGS_UNAVAILABLE);
  }

  let response;
  const origin = isRemote(source) ? remoteOrigin(config) : null;
  try {
    response = isRemote(source)
      ? await requestRemote(
        buildCanonicalAttachmentUrl({ jiraOrigin: origin, attachmentId: id, redirect: false }),
        config,
        { method: 'GET', headers: { Accept: '*/*' } }
      )
      : await requestLocal(route`/rest/api/3/attachment/content/${id}?redirect=false`, {
        method: 'GET',
        headers: { Accept: '*/*' }
      });
    if (response?.ok && origin) {
      ensureSameOrigin(response, origin);
    }
  } catch (error) {
    if (error instanceof AttachmentClientError) throw error;
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.DOWNLOAD_UNAVAILABLE);
  }

  if (!response?.ok) {
    const status = safeStatus(response);
    if (status === 404) {
      throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.NOT_FOUND, { status });
    }
    const permission = permissionCode(status);
    if (permission) throw new AttachmentClientError(permission, { status });
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.DOWNLOAD_UNAVAILABLE, { status });
  }
  if (response.status !== undefined && ![200, 206].includes(Number(response.status))) {
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.DOWNLOAD_UNAVAILABLE, {
      status: safeStatus(response)
    });
  }

  try {
    return await readResponseBytesBounded(response, maxBytes);
  } catch (error) {
    if (error instanceof AttachmentClientError) throw error;
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.DOWNLOAD_UNAVAILABLE);
  }
}


function buildMultipartBody(filename, mimeType, fileBuffer) {
  const boundary = `----ForgeAttachmentBoundary${randomBytes(16).toString('hex')}`;
  const safeFilename = filename.replace(/["\r\n]/g, '_');
  const header = Buffer.from(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="file"; filename="${safeFilename}"\r\n`
    + `Content-Type: ${mimeType}\r\n\r\n`,
    'utf8'
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    boundary,
    body: Buffer.concat([header, fileBuffer, footer])
  };
}

export async function uploadAttachmentContent({
  source,
  issueKey,
  filename,
  mimeType,
  fileBuffer,
  config = null,
  maxBytes
}) {
  requireSource(source);
  const key = validateIssueKey(issueKey);
  if (typeof filename !== 'string' || !filename
      || typeof mimeType !== 'string' || !mimeType
      || !Buffer.isBuffer(fileBuffer)
      || !Number.isSafeInteger(maxBytes) || maxBytes <= 0
      || /[\r\n]/.test(filename)) {
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.UPLOAD_REJECTED);
  }
  if (fileBuffer.byteLength > maxBytes) {
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.UPLOAD_TOO_LARGE);
  }

  const { boundary, body } = buildMultipartBody(filename, mimeType, fileBuffer);
  const options = {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'X-Atlassian-Token': 'no-check'
    },
    body
  };

  let response;
  try {
    const origin = isRemote(source) ? remoteOrigin(config) : null;
    response = isRemote(source)
      ? await requestRemote(buildAttachmentUploadUrl({ jiraOrigin: origin, issueKey: key }), config, options)
      : await requestLocal(route`/rest/api/3/issue/${key}/attachments`, options);
  } catch (error) {
    if (error instanceof AttachmentClientError) throw error;
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.UPLOAD_OUTCOME_UNKNOWN, {
      ambiguous: true
    });
  }

  const status = safeStatus(response);
  if (!response?.ok) {
    if (status === 413) {
      throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.UPLOAD_TOO_LARGE, { status });
    }
    const permission = permissionCode(status);
    if (permission) throw new AttachmentClientError(permission, { status });
    if (isDefinitiveRejection(status)) {
      throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.UPLOAD_REJECTED, { status });
    }
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.UPLOAD_OUTCOME_UNKNOWN, {
      status,
      ambiguous: true
    });
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.UPLOAD_MALFORMED_RESPONSE, {
      status,
      ambiguous: true
    });
  }
  const uploaded = Array.isArray(result) ? result[0] : null;
  const uploadedId = uploaded?.id === undefined || uploaded?.id === null
    ? null
    : String(uploaded.id);
  if (!uploadedId || !isValidAttachmentId(uploadedId)) {
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.UPLOAD_MALFORMED_RESPONSE, {
      status,
      ambiguous: true
    });
  }

  return { id: uploadedId };
}

export async function deleteAttachmentContent({
  source,
  attachmentId,
  config = null
}) {
  requireSource(source);
  const id = validateAttachmentId(attachmentId);

  let response;
  try {
    const origin = isRemote(source) ? remoteOrigin(config) : null;
    response = isRemote(source)
      ? await requestRemote(
        buildAttachmentDeleteUrl({ jiraOrigin: origin, attachmentId: id }),
        config,
        { method: 'DELETE', headers: { Accept: 'application/json' } }
      )
      : await requestLocal(route`/rest/api/3/attachment/${id}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' }
      });
  } catch (error) {
    if (error instanceof AttachmentClientError) throw error;
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.DELETE_OUTCOME_UNKNOWN, {
      ambiguous: true
    });
  }

  const status = safeStatus(response);
  if (status === 204 || status === 200 || status === 404) {
    return { deleted: true, alreadyDeleted: status === 404 };
  }
  if (!response?.ok) {
    const permission = permissionCode(status);
    if (permission) throw new AttachmentClientError(permission, { status });
    if (isDefinitiveRejection(status)) {
      throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.DELETE_REJECTED, { status });
    }
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.DELETE_OUTCOME_UNKNOWN, {
      status,
      ambiguous: true
    });
  }
  return { deleted: true, alreadyDeleted: false };
}

export async function getIssueAttachments({ source, issueKey, config = null }) {
  requireSource(source);
  const key = validateIssueKey(issueKey);

  let response;
  try {
    if (isRemote(source)) {
      const origin = remoteOrigin(config);
      const url = new URL(`${origin}/rest/api/3/issue/${key}`);
      url.searchParams.set('fields', 'attachment');
      response = await requestRemote(url.toString(), config, {
        method: 'GET',
        headers: { Accept: 'application/json' }
      });
    } else {
      response = await requestLocal(route`/rest/api/3/issue/${key}?fields=attachment`, {
        method: 'GET',
        headers: { Accept: 'application/json' }
      });
    }
  } catch (error) {
    if (error instanceof AttachmentClientError) throw error;
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.METADATA_UNAVAILABLE);
  }

  if (!response?.ok) {
    throw new AttachmentClientError(ATTACHMENT_CLIENT_CODES.METADATA_UNAVAILABLE, {
      status: safeStatus(response)
    });
  }
  const data = await parseJsonResponse(response);
  const attachments = data?.fields?.attachment;
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments
    .filter(item => item && isValidAttachmentId(item.id))
    .map(item => ({
      id: String(item.id),
      size: Number.isSafeInteger(item.size) ? item.size : null
    }));
}
