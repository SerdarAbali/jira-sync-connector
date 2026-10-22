jest.mock('@forge/api', () => ({
  __esModule: true,
  default: { asApp: () => ({ requestJira: jest.fn() }) },
  route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
  fetch: jest.fn()
}));

import { fetch } from '@forge/api';
import {
  buildCanonicalAttachmentUrl,
  normalizeJiraOrigin,
  extractAttachmentIdFromUrl
} from '../src/utils/attachment-url.js';
import { downloadRemoteAttachment } from '../src/services/jira/remote-client.js';

const mockFetch = fetch;
const CONFIG = {
  remoteUrl: 'https://jira.example',
  remoteEmail: 'sync@example.com',
  remoteApiToken: 'remote-token'
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: async () => Buffer.from('file')
  });
});

describe('Batch 8 canonical attachment URL', () => {
  test('builds the attachment URL only from the configured origin and numeric ID', () => {
    expect(buildCanonicalAttachmentUrl({
      jiraOrigin: 'https://jira.example/some/base/path',
      attachmentId: '12345'
    })).toBe('https://jira.example/rest/api/3/attachment/content/12345');
    expect(normalizeJiraOrigin('https://jira.example/some/base/path'))
      .toBe('https://jira.example');
    expect(() => normalizeJiraOrigin('https://jira.example.evil.test@evil.example/path'))
      .toThrow('Invalid Jira attachment reference');
  });

  test.each([
    ['http://jira.example', '42'],
    ['https://user:pass@jira.example', '42'],
    ['https://jira.example', '../admin'],
    ['https://jira.example', '42?redirect=https://evil.example'],
    ['https://jira.example', 'https://evil.example/42'],
    ['https://jira.example', '0']
  ])('rejects an unsafe origin or attachment ID (%s, %s)', (jiraOrigin, attachmentId) => {
    expect(() => buildCanonicalAttachmentUrl({ jiraOrigin, attachmentId }))
      .toThrow();
  });

  test('downloads only the canonical URL with the configured Jira credentials', async () => {
    const result = await downloadRemoteAttachment(42, CONFIG);

    expect(result).toEqual(Buffer.from('file'));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://jira.example/rest/api/3/attachment/content/42',
      expect.objectContaining({ method: 'GET' })
    );
  });

  test('an invalid attachment ID never reaches the network', async () => {
    await expect(downloadRemoteAttachment('42/../../admin', CONFIG)).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('extracts only a numeric attachment ID and rejects non-canonical paths', () => {
    expect(extractAttachmentIdFromUrl('https://evil.example/rest/api/3/attachment/content/42'))
      .toBe('42');
    expect(() => extractAttachmentIdFromUrl('https://evil.example/steal')).toThrow();
    expect(() => extractAttachmentIdFromUrl('http://evil.example/rest/api/3/attachment/content/42')).toThrow();
  });
});
