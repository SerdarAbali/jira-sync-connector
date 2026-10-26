// The synchronization authorization gate has its own suite; this suite tests another behaviour.
jest.mock('../src/services/sync/sync-authorization.js', () => require('./helpers/authorized-sync-authorization.js'));

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  const fetch = jest.fn();
  return {
    __esModule: true,
    default: { asApp: () => ({ requestJira }) },
    route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch
  };
});

import api, { fetch } from '@forge/api';
import {
  ATTACHMENT_CLIENT_CODES,
  ATTACHMENT_SOURCE,
  deleteAttachmentContent,
  downloadAttachmentContent,
  getAttachmentMetadata,
  readResponseBytesBounded,
  uploadAttachmentContent
} from '../src/services/jira/attachment-client.js';

const mockRequestJira = api.asApp().requestJira;
const mockFetch = fetch;

const CONFIG = {
  remoteUrl: 'https://jira.example/base/path',
  remoteEmail: 'sync@example.com',
  remoteApiToken: 'secret-token'
};

function jsonResponse(data, { status = 200, url = 'https://jira.example/rest/api/3/attachment/42' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    json: async () => data
  };
}

function bodyResponse(bytes, { url = 'https://jira.example/rest/api/3/attachment/content/42?redirect=false' } = {}) {
  return {
    ok: true,
    status: 200,
    url,
    arrayBuffer: async () => Uint8Array.from(bytes).buffer
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Canonical Jira attachment client', () => {
  test('metadata is fetched from the configured origin and validated ID', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      id: 42,
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      size: 4
    }));

    const metadata = await getAttachmentMetadata({
      source: ATTACHMENT_SOURCE.REMOTE,
      attachmentId: '42',
      config: CONFIG
    });

    expect(metadata).toEqual(expect.objectContaining({
      id: '42',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      size: 4
    }));
    expect(mockFetch).toHaveBeenCalledWith(
      'https://jira.example/rest/api/3/attachment/42',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from('sync@example.com:secret-token').toString('base64')}`
        })
      })
    );
  });

  test('content uses redirect=false and never exposes credentials in the URL', async () => {
    mockFetch.mockResolvedValue(bodyResponse(Buffer.from('data')));

    const result = await downloadAttachmentContent({
      source: ATTACHMENT_SOURCE.REMOTE,
      attachmentId: '42',
      config: CONFIG,
      maxBytes: 10
    });

    expect(result).toEqual(Buffer.from('data'));
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://jira.example/rest/api/3/attachment/content/42?redirect=false'
    );
    expect(mockFetch.mock.calls[0][0]).not.toContain('secret-token');
    expect(mockFetch.mock.calls[0][1]).toEqual(expect.objectContaining({
      redirect: 'error',
      headers: expect.objectContaining({
        Authorization: expect.stringContaining('Basic ')
      })
    }));
  });

  test('a response from a different origin is rejected', async () => {
    mockFetch.mockResolvedValue(bodyResponse(Buffer.from('data'), {
      url: 'https://media.example/rest/api/3/attachment/content/42'
    }));

    await expect(downloadAttachmentContent({
      source: ATTACHMENT_SOURCE.REMOTE,
      attachmentId: '42',
      config: CONFIG,
      maxBytes: 10
    })).rejects.toMatchObject({
      code: ATTACHMENT_CLIENT_CODES.DOWNLOAD_CROSS_ORIGIN
    });
  });

  test('actual streamed bytes over the limit cancel the download', async () => {
    const cancel = jest.fn();
    const reader = {
      read: jest.fn()
        .mockResolvedValueOnce({ done: false, value: Buffer.alloc(6) })
        .mockResolvedValueOnce({ done: false, value: Buffer.alloc(6) }),
      cancel,
      releaseLock: jest.fn()
    };

    await expect(readResponseBytesBounded({
      headers: { get: () => null },
      body: { getReader: () => reader }
    }, 10)).rejects.toMatchObject({
      code: ATTACHMENT_CLIENT_CODES.ACTUAL_SIZE_EXCEEDED
    });

    expect(cancel).toHaveBeenCalled();
  });

  test('declared content length over the limit is rejected before reading', async () => {
    const getReader = jest.fn();
    await expect(readResponseBytesBounded({
      headers: { get: () => '11' },
      body: { getReader }
    }, 10)).rejects.toMatchObject({
      code: ATTACHMENT_CLIENT_CODES.ACTUAL_SIZE_EXCEEDED
    });
    expect(getReader).not.toHaveBeenCalled();
  });

  test('upload stays on the configured origin and preserves a safe filename and MIME type', async () => {
    mockFetch.mockResolvedValue(jsonResponse([{ id: '77' }], {
      status: 200,
      url: 'https://jira.example/rest/api/3/issue/REMOTE-1/attachments'
    }));

    const result = await uploadAttachmentContent({
      source: ATTACHMENT_SOURCE.REMOTE,
      issueKey: 'REMOTE-1',
      filename: 'report 2026.pdf',
      mimeType: 'application/pdf',
      fileBuffer: Buffer.from('file'),
      config: CONFIG,
      maxBytes: 10
    });

    expect(result).toEqual({ id: '77' });
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://jira.example/rest/api/3/issue/REMOTE-1/attachments'
    );
    const body = mockFetch.mock.calls[0][1].body.toString('utf8');
    expect(body).toContain('filename="report 2026.pdf"');
    expect(body).toContain('Content-Type: application/pdf');
    expect(body).toContain('file');
  });

  test('a malformed upload success is ambiguous and never retried', async () => {
    mockFetch.mockResolvedValue(jsonResponse([{ noId: true }], { status: 200 }));

    await expect(uploadAttachmentContent({
      source: ATTACHMENT_SOURCE.REMOTE,
      issueKey: 'REMOTE-1',
      filename: 'file.txt',
      mimeType: 'text/plain',
      fileBuffer: Buffer.from('file'),
      config: CONFIG,
      maxBytes: 10
    })).rejects.toMatchObject({
      code: ATTACHMENT_CLIENT_CODES.UPLOAD_MALFORMED_RESPONSE,
      ambiguous: true
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('a rate-limited upload is ambiguous and never retried', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429, url: 'https://jira.example/' });

    await expect(uploadAttachmentContent({
      source: ATTACHMENT_SOURCE.REMOTE,
      issueKey: 'REMOTE-1',
      filename: 'file.txt',
      mimeType: 'text/plain',
      fileBuffer: Buffer.from('file'),
      config: CONFIG,
      maxBytes: 10
    })).rejects.toMatchObject({
      code: ATTACHMENT_CLIENT_CODES.UPLOAD_OUTCOME_UNKNOWN,
      ambiguous: true
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('deletion treats 404 as already deleted', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      url: 'https://jira.example/rest/api/3/attachment/42'
    });

    await expect(deleteAttachmentContent({
      source: ATTACHMENT_SOURCE.REMOTE,
      attachmentId: '42',
      config: CONFIG
    })).resolves.toEqual({ deleted: true, alreadyDeleted: true });
    expect(mockFetch.mock.calls[0][0]).toBe('https://jira.example/rest/api/3/attachment/42');
  });
});
