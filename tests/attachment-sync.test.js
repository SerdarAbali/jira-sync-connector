const mockStore = new Map();
const mockMappings = new Map();
const mockIssueMaps = new Map();
const mockQueuePush = jest.fn();

jest.mock('@forge/api', () => ({
  __esModule: true,
  default: { asApp: () => ({ requestJira: jest.fn() }) },
  route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
  fetch: jest.fn()
}));

jest.mock('@forge/events', () => ({
  Queue: jest.fn(() => ({ push: mockQueuePush }))
}));

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(async key => (mockStore.has(key) ? mockStore.get(key) : null)),
  set: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  del: jest.fn(async key => { mockStore.delete(key); }),
  createIfNotExists: jest.fn(async (key, value) => {
    if (mockStore.has(key)) {
      const error = new Error('key already exists');
      error.code = 'KEY_ALREADY_EXISTS';
      throw error;
    }
    mockStore.set(key, value);
  }),
  setIfNotExists: jest.fn(async (key, value) => {
    if (mockStore.has(key)) {
      const error = new Error('key already exists');
      error.code = 'KEY_ALREADY_EXISTS';
      throw error;
    }
    mockStore.set(key, value);
  }),
  getSecret: jest.fn(async () => null)
}));

jest.mock('../src/services/storage/mappings.js', () => ({
  getAttachmentMapping: jest.fn(),
  storeAttachmentMapping: jest.fn(),
  removeAttachmentMapping: jest.fn(),
  storeAttachmentMappingHistory: jest.fn(),
  getRemoteKey: jest.fn(),
  getLocalKey: jest.fn()
}));

jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn()
}));

jest.mock('../src/services/jira/remote-client.js', () => ({
  getRemoteIssue: jest.fn()
}));

jest.mock('../src/services/jira/attachment-client.js', () => {
  const actual = jest.requireActual('../src/services/jira/attachment-client.js');
  return {
    ...actual,
    getAttachmentSettings: jest.fn(),
    getAttachmentMetadata: jest.fn(),
    downloadAttachmentContent: jest.fn(),
    uploadAttachmentContent: jest.fn(),
    deleteAttachmentContent: jest.fn(),
    getIssueAttachments: jest.fn()
  };
});

import * as mappings from '../src/services/storage/mappings.js';
import * as kvsStore from '../src/services/storage/kvs.js';
import { getFullIssue } from '../src/services/jira/local-client.js';
import {
  ATTACHMENT_CLIENT_CODES,
  AttachmentClientError,
  deleteAttachmentContent,
  downloadAttachmentContent,
  getAttachmentMetadata,
  getAttachmentSettings,
  getIssueAttachments,
  uploadAttachmentContent
} from '../src/services/jira/attachment-client.js';
import {
  beginAttachmentDeletionOperation,
  beginAttachmentUploadOperation,
  getAttachmentOperation,
  markAttachmentDeletionSubmissionStarted,
  markAttachmentSubmissionStarted,
  markAttachmentUploadUnknown
} from '../src/services/sync/attachment-operation.js';
import {
  ATTACHMENT_SYNC_CODES,
  getAttachmentSyncPolicy,
  propagateAttachmentDeletion,
  reconcileAttachmentOperation,
  syncAttachments,
  syncRemoteAttachmentsToLocal
} from '../src/services/sync/attachment-sync.js';
import { RESOLVER_POLICIES } from '../src/resolvers/authorization-policy.js';

const ORG = {
  id: 'org-1',
  name: 'Remote Org',
  remoteUrl: 'https://remote.example',
  remoteEmail: 'sync@example.com',
  remoteApiToken: 'remote-secret-token',
  remoteProjectKey: 'REMOTE',
  allowedProjects: ['LOCAL'],
  syncDirection: 'bidirectional'
};

const LOCAL_ISSUE = {
  key: 'LOCAL-1',
  fields: {
    project: { key: 'LOCAL' },
    attachment: [{ id: '42', filename: 'untrusted.txt', content: 'https://evil.example/steal', size: 4 }]
  }
};

const REMOTE_ISSUE = {
  key: 'REMOTE-1',
  fields: {
    project: { key: 'REMOTE' },
    attachment: [{ id: '42', filename: 'untrusted.txt', content: 'https://evil.example/steal', size: 4 }]
  }
};

const OPTIONS = {
  syncAttachments: true,
  propagateAttachmentDeletions: false,
  maxAttachmentSizeBytes: null
};

function mappingKey(id, orgId, direction) {
  return `${orgId || 'legacy'}:${direction}:${id}`;
}

function rememberPair(localKey, remoteKey, orgId = 'org-1') {
  mockIssueMaps.set(`local:${orgId}:${localKey}`, remoteKey);
  mockIssueMaps.set(`remote:${orgId}:${remoteKey}`, localKey);
}

function attachmentMeta(overrides = {}) {
  return {
    id: '42',
    filename: 'report 2026.pdf',
    mimeType: 'application/pdf',
    size: 4,
    ...overrides
  };
}

beforeEach(() => {
  mockStore.clear();
  mockStore.set('organizations', [{ id: ORG.id, syncDirection: ORG.syncDirection, allowedProjects: ORG.allowedProjects }]);
  mockMappings.clear();
  mockIssueMaps.clear();
  jest.clearAllMocks();

  mappings.getRemoteKey.mockImplementation(async (localKey, orgId) =>
    mockIssueMaps.get(`local:${orgId}:${localKey}`) || null);
  mappings.getLocalKey.mockImplementation(async (remoteKey, orgId) =>
    mockIssueMaps.get(`remote:${orgId}:${remoteKey}`) || null);
  mappings.getAttachmentMapping.mockImplementation(async (id, orgId, direction) =>
    mockMappings.get(mappingKey(id, orgId, direction)) || null);
  mappings.storeAttachmentMapping.mockImplementation(async (id, destinationId, orgId, direction) => {
    mockMappings.set(mappingKey(id, orgId, direction), String(destinationId));
  });
  mappings.removeAttachmentMapping.mockImplementation(async (id, orgId, direction) => {
    mockMappings.delete(mappingKey(id, orgId, direction));
  });

  getAttachmentSettings.mockResolvedValue({ enabled: true, uploadLimit: 1000 });
  getAttachmentMetadata.mockResolvedValue(attachmentMeta());
  downloadAttachmentContent.mockResolvedValue(Buffer.from('data'));
  uploadAttachmentContent.mockResolvedValue({ id: '77' });
  deleteAttachmentContent.mockResolvedValue({ deleted: true, alreadyDeleted: false });
  getIssueAttachments.mockResolvedValue([]);
  getFullIssue.mockResolvedValue(LOCAL_ISSUE);
});

describe('Secure attachment synchronization', () => {
  test('small attachment synchronizes from A to B', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');

    const result = await syncAttachments(
      'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
      { syncOptions: OPTIONS }
    );

    expect(result).toEqual({ 42: '77' });
    expect(getAttachmentMetadata).toHaveBeenCalledWith(expect.objectContaining({
      source: 'local',
      attachmentId: '42'
    }));
    expect(downloadAttachmentContent).toHaveBeenCalledWith(expect.objectContaining({
      source: 'local',
      attachmentId: '42',
      maxBytes: 1000
    }));
    expect(uploadAttachmentContent).toHaveBeenCalledWith(expect.objectContaining({
      source: 'remote',
      issueKey: 'REMOTE-1',
      filename: 'report 2026.pdf',
      mimeType: 'application/pdf'
    }));
    expect(mockMappings.get('org-1:local-to-remote:42')).toBe('77');
  });

  test('small attachment synchronizes from B to A in bidirectional mode', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');

    const result = await syncRemoteAttachmentsToLocal(
      'REMOTE-1', 'LOCAL-1', REMOTE_ISSUE, ORG, null, 'org-1',
      { syncOptions: OPTIONS }
    );

    expect(result).toEqual({ 42: '77' });
    expect(getFullIssue).toHaveBeenCalledWith('LOCAL-1');
    expect(getAttachmentMetadata).toHaveBeenCalledWith(expect.objectContaining({ source: 'remote' }));
    expect(uploadAttachmentContent).toHaveBeenCalledWith(expect.objectContaining({
      source: 'local',
      issueKey: 'LOCAL-1'
    }));
    expect(mockMappings.get('org-1:remote-to-local:42')).toBe('77');
  });

  test('push mode blocks B to A attachment writes', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');
    const pushOrg = { ...ORG, syncDirection: 'push' };

    const result = await syncRemoteAttachmentsToLocal(
      'REMOTE-1', 'LOCAL-1', REMOTE_ISSUE, pushOrg, null, 'org-1',
      { syncOptions: OPTIONS }
    );

    expect(result).toEqual({});
    expect(getAttachmentSettings).not.toHaveBeenCalled();
    expect(downloadAttachmentContent).not.toHaveBeenCalled();
    expect(uploadAttachmentContent).not.toHaveBeenCalled();
  });

  test('webhook-provided filenames, sizes and content URLs are ignored', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');

    await syncAttachments(
      'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
      { syncOptions: OPTIONS, attachmentIds: ['42'] }
    );

    expect(getAttachmentMetadata).toHaveBeenCalledWith({
      source: 'local',
      attachmentId: '42',
      config: ORG
    });
    expect(downloadAttachmentContent.mock.calls[0][0].attachmentId).toBe('42');
    expect(JSON.stringify(downloadAttachmentContent.mock.calls)).not.toContain('evil.example');
    expect(uploadAttachmentContent.mock.calls[0][0].filename).toBe('report 2026.pdf');
  });

  test('malformed IDs never reach metadata or content APIs', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');

    const result = await syncAttachments(
      'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
      { syncOptions: OPTIONS, attachmentIds: ['../42', '42?x=1', '0'] }
    );

    expect(result).toEqual({});
    expect(getAttachmentMetadata).not.toHaveBeenCalled();
    expect(downloadAttachmentContent).not.toHaveBeenCalled();
    expect(uploadAttachmentContent).not.toHaveBeenCalled();
  });

  test('metadata oversize is rejected before download, including a lower organization limit', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');
    getAttachmentMetadata.mockResolvedValue(attachmentMeta({ size: 3 }));

    await syncAttachments(
      'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
      { syncOptions: { ...OPTIONS, maxAttachmentSizeBytes: 2 } }
    );

    expect(downloadAttachmentContent).not.toHaveBeenCalled();
    expect(uploadAttachmentContent).not.toHaveBeenCalled();
    const operation = await getAttachmentOperation({
      orgId: 'org-1',
      direction: 'local-to-remote',
      sourceAttachmentId: '42'
    });
    expect(operation.state).toBe('failed_definitive');
    expect(operation.failureCode).toBe(ATTACHMENT_SYNC_CODES.SIZE_REJECTED);
  });

  test('actual downloaded bytes over the limit abort before upload', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');
    downloadAttachmentContent.mockRejectedValue(new AttachmentClientError(
      ATTACHMENT_CLIENT_CODES.ACTUAL_SIZE_EXCEEDED
    ));

    await syncAttachments(
      'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
      { syncOptions: OPTIONS }
    );

    expect(uploadAttachmentContent).not.toHaveBeenCalled();
    expect(mockMappings.has('org-1:local-to-remote:42')).toBe(false);
  });

  test('safe filenames are preserved and MIME metadata is normalized', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');
    getAttachmentMetadata.mockResolvedValue(attachmentMeta({
      filename: 'report 2026.pdf',
      mimeType: 'Application/PDF; charset=binary'
    }));

    await syncAttachments(
      'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
      { syncOptions: OPTIONS }
    );

    expect(uploadAttachmentContent).toHaveBeenCalledWith(expect.objectContaining({
      filename: 'report 2026.pdf',
      mimeType: 'application/pdf'
    }));
  });

  test('unsafe filenames are sanitized without path separators or control characters', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');
    getAttachmentMetadata.mockResolvedValue(attachmentMeta({
      filename: '../../secret\r\nname.txt'
    }));

    await syncAttachments(
      'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
      { syncOptions: OPTIONS }
    );

    const uploadedName = uploadAttachmentContent.mock.calls[0][0].filename;
    expect(uploadedName).toBe('.._.._secretname.txt');
    expect(uploadedName).not.toContain('/');
    expect(uploadedName).not.toContain('\\');
    expect(uploadedName).not.toContain('\r');
    expect(uploadedName).not.toContain('\n');
  });

  test('empty or oversized filenames are rejected before content download', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');
    getAttachmentMetadata.mockResolvedValue(attachmentMeta({ filename: '...' }));

    await syncAttachments(
      'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
      { syncOptions: OPTIONS }
    );

    expect(downloadAttachmentContent).not.toHaveBeenCalled();
    expect(uploadAttachmentContent).not.toHaveBeenCalled();

    jest.clearAllMocks();
    rememberPair('LOCAL-1', 'REMOTE-1');
    getAttachmentSettings.mockResolvedValue({ enabled: true, uploadLimit: 1000 });
    getAttachmentMetadata.mockResolvedValue(attachmentMeta({ filename: 'a'.repeat(201) }));

    await syncAttachments(
      'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
      { syncOptions: OPTIONS }
    );

    expect(downloadAttachmentContent).not.toHaveBeenCalled();
    expect(uploadAttachmentContent).not.toHaveBeenCalled();
  });

  test('duplicate events and an existing mapping result in one upload', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');

    await syncAttachments(
      'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
      { syncOptions: OPTIONS }
    );
    await syncAttachments(
      'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
      { syncOptions: OPTIONS }
    );

    expect(uploadAttachmentContent).toHaveBeenCalledTimes(1);
  });

  test('a destination attachment created by the connector is not uploaded back', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');

    await syncAttachments(
      'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
      { syncOptions: OPTIONS }
    );
    expect(uploadAttachmentContent).toHaveBeenCalledTimes(1);

    const remoteEchoIssue = {
      key: 'REMOTE-1',
      fields: {
        project: { key: 'REMOTE' },
        attachment: [{ id: '77', filename: 'echo.pdf', content: 'https://evil.example/echo', size: 4 }]
      }
    };

    const result = await syncRemoteAttachmentsToLocal(
      'REMOTE-1', 'LOCAL-1', remoteEchoIssue, ORG, null, 'org-1',
      { syncOptions: OPTIONS, attachmentIds: ['77'] }
    );

    expect(result).toEqual({});
    expect(uploadAttachmentContent).toHaveBeenCalledTimes(1);
    expect(getAttachmentMetadata).toHaveBeenCalledTimes(1);
  });

  test('an ambiguous upload is not retried automatically', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');
    uploadAttachmentContent.mockRejectedValue(new AttachmentClientError(
      ATTACHMENT_CLIENT_CODES.UPLOAD_OUTCOME_UNKNOWN,
      { ambiguous: true }
    ));

    await syncAttachments(
      'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
      { syncOptions: OPTIONS }
    );
    await syncAttachments(
      'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
      { syncOptions: OPTIONS }
    );

    expect(uploadAttachmentContent).toHaveBeenCalledTimes(1);
    const operation = await getAttachmentOperation({
      orgId: 'org-1',
      direction: 'local-to-remote',
      sourceAttachmentId: '42'
    });
    expect(operation.state).toBe('unknown');
    expect(operation.reconciliationRequired).toBe(true);
  });

  test('an upload crash before POST leaves no write boundary and retries safely', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');
    const startedAt = Date.now() - 10 * 60 * 1000;
    await beginAttachmentUploadOperation({
      orgId: 'org-1',
      direction: 'local-to-remote',
      sourceAttachmentId: '42',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      now: startedAt
    });

    const pending = await getAttachmentOperation({
      orgId: 'org-1',
      direction: 'local-to-remote',
      sourceAttachmentId: '42'
    });
    expect(pending.writeStartedAt).toBeUndefined();

    const result = await syncAttachments(
      'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
      { syncOptions: OPTIONS }
    );

    expect(result).toEqual({ 42: '77' });
    expect(uploadAttachmentContent).toHaveBeenCalledTimes(1);
  });

  test('metadata and download complete before any upload write-start marker', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');
    let stateAtMetadata = null;
    let stateAtDownload = null;
    getAttachmentMetadata.mockImplementation(async () => {
      stateAtMetadata = await getAttachmentOperation({
        orgId: 'org-1',
        direction: 'local-to-remote',
        sourceAttachmentId: '42'
      });
      return attachmentMeta();
    });
    downloadAttachmentContent.mockImplementation(async () => {
      stateAtDownload = await getAttachmentOperation({
        orgId: 'org-1',
        direction: 'local-to-remote',
        sourceAttachmentId: '42'
      });
      return Buffer.from('data');
    });

    await syncAttachments(
      'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
      { syncOptions: OPTIONS }
    );

    expect(stateAtMetadata.state).toBe('pending');
    expect(stateAtMetadata.writeStartedAt).toBeUndefined();
    expect(stateAtDownload.state).toBe('pending');
    expect(stateAtDownload.writeStartedAt).toBeUndefined();
    expect(uploadAttachmentContent).toHaveBeenCalledTimes(1);
  });


  test('the upload POST follows the persisted write-start marker', async () => {

    rememberPair('LOCAL-1', 'REMOTE-1');
    let stateAtPost = null;
    uploadAttachmentContent.mockImplementation(async () => {
      stateAtPost = await getAttachmentOperation({
        orgId: 'org-1',
        direction: 'local-to-remote',
        sourceAttachmentId: '42'
      });
      return { id: '77' };
    });

    await syncAttachments(
      'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
      { syncOptions: OPTIONS }
    );

    expect(stateAtPost.state).toBe('pending');
    expect(stateAtPost.writeStartedAt).toBeTruthy();
    expect(uploadAttachmentContent).toHaveBeenCalledTimes(1);
  });

  test('an accepted upload without persisted success cannot issue another POST', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');
    const claim = await beginAttachmentUploadOperation({
      orgId: 'org-1',
      direction: 'local-to-remote',
      sourceAttachmentId: '42',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1'
    });
    await markAttachmentSubmissionStarted(claim.operation);

    const result = await syncAttachments(
      'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
      { syncOptions: OPTIONS }
    );

    expect(result).toEqual({});
    expect(uploadAttachmentContent).not.toHaveBeenCalled();
    const operation = await getAttachmentOperation({
      orgId: 'org-1',
      direction: 'local-to-remote',
      sourceAttachmentId: '42'
    });
    expect(operation.state).toBe('pending');
    expect(operation.writeStartedAt).toBeTruthy();
    expect(mockMappings.has('org-1:local-to-remote:42')).toBe(false);
  });

  test('a failed success update after Jira accepts the upload still blocks a second POST', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');
    const originalSet = kvsStore.set.getMockImplementation();
    kvsStore.set.mockImplementation(async (key, value) => {
      if (String(key).startsWith('attachment-operation:') && value?.state === 'succeeded') {
        throw new Error('operation storage unavailable');
      }
      return originalSet(key, value);
    });

    try {
      await syncAttachments(
        'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
        { syncOptions: OPTIONS }
      );
      expect(uploadAttachmentContent).toHaveBeenCalledTimes(1);

      await syncAttachments(
        'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
        { syncOptions: OPTIONS }
      );
      expect(uploadAttachmentContent).toHaveBeenCalledTimes(1);
    } finally {
      kvsStore.set.mockImplementation(originalSet);
    }
  });



  test('global Pause blocks attachment download and upload', async () => {

    rememberPair('LOCAL-1', 'REMOTE-1');
    mockStore.set('pilotPause', { paused: true, reasonCode: 'maintenance' });

    await syncAttachments(
      'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
      { syncOptions: OPTIONS }
    );

    expect(downloadAttachmentContent).not.toHaveBeenCalled();
    expect(uploadAttachmentContent).not.toHaveBeenCalled();
  });

  test('unmapped issues perform no metadata, content or upload work', async () => {
    const result = await syncAttachments(
      'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
      { syncOptions: OPTIONS }
    );

    expect(result).toEqual({});
    expect(getAttachmentSettings).not.toHaveBeenCalled();
    expect(getAttachmentMetadata).not.toHaveBeenCalled();
    expect(downloadAttachmentContent).not.toHaveBeenCalled();
    expect(uploadAttachmentContent).not.toHaveBeenCalled();
  });

  test('bounded invocations enqueue only IDs and issue keys for the remainder', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');
    const ids = Array.from({ length: 12 }, (_, index) => String(100 + index));

    await syncAttachments(
      'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
      { syncOptions: OPTIONS, attachmentIds: ids }
    );

    expect(uploadAttachmentContent).toHaveBeenCalledTimes(3);
    expect(mockQueuePush).toHaveBeenCalledTimes(1);
    expect(mockQueuePush.mock.calls[0][0].body).toEqual({
      orgId: 'org-1',
      direction: 'local-to-remote',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      attachmentIds: ['103', '104', '105', '106', '107', '108', '109', '110', '111']
    });
  });
});

describe('Attachment deletion propagation', () => {
  test('deletion propagation defaults Off and retains the counterpart mapping', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');
    mockMappings.set('org-1:local-to-remote:42', '84');

    const result = await propagateAttachmentDeletion({
      direction: 'local-to-remote',
      sourceAttachmentId: '42',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      config: ORG,
      orgId: 'org-1',
      syncOptions: OPTIONS
    });

    expect(result).toEqual({ status: ATTACHMENT_SYNC_CODES.DELETE_DISABLED });
    expect(deleteAttachmentContent).not.toHaveBeenCalled();
    expect(mappings.removeAttachmentMapping).not.toHaveBeenCalled();
    expect(mockMappings.get('org-1:local-to-remote:42')).toBe('84');
  });

  test('enabled deletion removes only the explicitly mapped counterpart attachment', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');
    mockMappings.set('org-1:local-to-remote:42', '84');

    const result = await propagateAttachmentDeletion({
      direction: 'local-to-remote',
      sourceAttachmentId: '42',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      config: ORG,
      orgId: 'org-1',
      syncOptions: { ...OPTIONS, propagateAttachmentDeletions: true }
    });

    expect(result).toEqual({ status: ATTACHMENT_SYNC_CODES.DELETE_COMPLETE });
    expect(deleteAttachmentContent).toHaveBeenCalledWith({
      source: 'remote',
      attachmentId: '84',
      config: ORG
    });
    expect(mappings.removeAttachmentMapping).toHaveBeenCalledWith(
      '42', 'org-1', 'local-to-remote'
    );
    expect(mappings.storeAttachmentMappingHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAttachmentId: '42',
        destinationAttachmentId: '84',
        outcome: 'deleted'
      })
    );
  });

  test('a 404 deletion is idempotent and removes the mapping', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');
    mockMappings.set('org-1:local-to-remote:42', '84');
    deleteAttachmentContent.mockResolvedValue({ deleted: true, alreadyDeleted: true });

    const result = await propagateAttachmentDeletion({
      direction: 'local-to-remote',
      sourceAttachmentId: '42',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      config: ORG,
      orgId: 'org-1',
      syncOptions: { ...OPTIONS, propagateAttachmentDeletions: true }
    });

    expect(result).toEqual({ status: ATTACHMENT_SYNC_CODES.DELETE_ALREADY_COMPLETE });
    expect(mappings.removeAttachmentMapping).toHaveBeenCalled();
  });

  test('a deletion write-start without a recorded result cannot issue another DELETE', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');
    mockMappings.set('org-1:local-to-remote:42', '84');
    const claim = await beginAttachmentDeletionOperation({
      orgId: 'org-1',
      direction: 'local-to-remote',
      sourceAttachmentId: '42',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      mappedDestinationAttachmentId: '84'
    });
    expect(claim.allowed).toBe(true);
    await markAttachmentDeletionSubmissionStarted(claim.operation);

    const result = await propagateAttachmentDeletion({
      direction: 'local-to-remote',
      sourceAttachmentId: '42',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      config: ORG,
      orgId: 'org-1',
      syncOptions: { ...OPTIONS, propagateAttachmentDeletions: true }
    });

    expect(result).toEqual({ status: ATTACHMENT_SYNC_CODES.DELETE_RECONCILIATION_REQUIRED });
    expect(deleteAttachmentContent).not.toHaveBeenCalled();
    expect(mockMappings.get('org-1:local-to-remote:42')).toBe('84');
  });


  test('push mode blocks remote-to-local deletion propagation', async () => {

    rememberPair('LOCAL-1', 'REMOTE-1');
    mockMappings.set('org-1:remote-to-local:42', '84');

    const result = await propagateAttachmentDeletion({
      direction: 'remote-to-local',
      sourceAttachmentId: '42',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1',
      config: { ...ORG, syncDirection: 'push' },
      orgId: 'org-1',
      syncOptions: { ...OPTIONS, propagateAttachmentDeletions: true }
    });

    expect(result).toEqual({ status: ATTACHMENT_SYNC_CODES.DELETE_DISABLED });
    expect(deleteAttachmentContent).not.toHaveBeenCalled();
  });
});

describe('Attachment reconciliation and data minimization', () => {
  test('admin reconciliation records an explicit destination without upload or deletion', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');
    const claim = await beginAttachmentUploadOperation({
      orgId: 'org-1',
      direction: 'local-to-remote',
      sourceAttachmentId: '42',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1'
    });
    await markAttachmentSubmissionStarted(claim.operation);
    await markAttachmentUploadUnknown(claim.operation);

    getIssueAttachments.mockResolvedValue([{ id: '84', size: 4 }]);
    getAttachmentMetadata.mockImplementation(async ({ attachmentId }) => attachmentMeta({
      id: String(attachmentId),
      filename: attachmentId === '42' ? 'private-name.pdf' : 'counterpart.pdf',
      size: 4,
      mimeType: 'application/pdf'
    }));

    const result = await reconcileAttachmentOperation({
      orgId: 'org-1',
      direction: 'local-to-remote',
      sourceAttachmentId: '42',
      destinationAttachmentId: '84',
      config: ORG
    });

    expect(result.success).toBe(true);
    expect(result.operation.state).toBe('succeeded');
    expect(uploadAttachmentContent).not.toHaveBeenCalled();
    expect(deleteAttachmentContent).not.toHaveBeenCalled();
    expect(mockMappings.get('org-1:local-to-remote:42')).toBe('84');
    expect(JSON.stringify(result)).not.toContain('remote-secret-token');
    expect(JSON.stringify(result)).not.toContain('private-name.pdf');
    expect(JSON.stringify(result)).not.toContain('https://');
    expect(JSON.stringify(result)).not.toContain('attemptToken');
  });

  test('reconciliation rejects metadata that does not match the source', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');
    const claim = await beginAttachmentUploadOperation({
      orgId: 'org-1',
      direction: 'local-to-remote',
      sourceAttachmentId: '42',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1'
    });
    await markAttachmentUploadUnknown(claim.operation);
    getIssueAttachments.mockResolvedValue([{ id: '84', size: 9 }]);
    getAttachmentMetadata.mockImplementation(async ({ attachmentId }) => attachmentMeta({
      id: String(attachmentId),
      size: attachmentId === '42' ? 4 : 9
    }));

    const result = await reconcileAttachmentOperation({
      orgId: 'org-1',
      direction: 'local-to-remote',
      sourceAttachmentId: '42',
      destinationAttachmentId: '84',
      config: ORG
    });

    expect(result).toEqual({ success: false, code: 'ATTACHMENT_METADATA_MISMATCH' });
    expect(mockMappings.has('org-1:local-to-remote:42')).toBe(false);
  });

  test('attachment content, filenames, URLs and credentials never enter KVS or logs', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');
    getAttachmentMetadata.mockResolvedValue(attachmentMeta({ filename: 'private-name.pdf' }));
    downloadAttachmentContent.mockResolvedValue(Buffer.from('TOP-SECRET-CONTENT'));
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await syncAttachments(
        'LOCAL-1', 'REMOTE-1', LOCAL_ISSUE, ORG, null, 'org-1', false,
        { syncOptions: OPTIONS }
      );
    } finally {
      const output = JSON.stringify([
        logSpy.mock.calls,
        warnSpy.mock.calls,
        errorSpy.mock.calls,
        [...mockStore.entries()]
      ]);
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();

      expect(output).not.toContain('TOP-SECRET-CONTENT');
      expect(output).not.toContain('private-name.pdf');
      expect(output).not.toContain('remote-secret-token');
      expect(output).not.toContain('https://');
    }
  });

  test('the attachment policy remains default Off until explicitly enabled', () => {
    expect(getAttachmentSyncPolicy()).toEqual(expect.objectContaining({ enabled: false }));
    expect(getAttachmentSyncPolicy(OPTIONS)).toEqual(expect.objectContaining({
      enabled: true,
      propagateDeletions: false
    }));
    expect(getAttachmentSyncPolicy({ ...OPTIONS, propagateAttachmentDeletions: true }))
      .toEqual(expect.objectContaining({ enabled: true, propagateDeletions: true }));
    expect(RESOLVER_POLICIES.reconcileAttachment).toBe('ADMIN_WRITE');
  });
});

describe('F03 current inbound attachment scope', () => {
  test('upload rechecks current config after download without marking an ambiguous write', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');
    downloadAttachmentContent.mockImplementation(async () => {
      mockStore.set('organizations', [{ id: 'org-1', syncDirection: 'bidirectional', allowedProjects: [] }]);
      return Buffer.from('data');
    });
    await expect(syncRemoteAttachmentsToLocal('REMOTE-1', 'LOCAL-1', REMOTE_ISSUE, ORG, null, 'org-1', { syncOptions: OPTIONS }))
      .rejects.toMatchObject({ code: 'INBOUND_SCOPE_BLOCKED' });
    expect(uploadAttachmentContent).not.toHaveBeenCalled();
    expect(Array.from(mockStore.values()).some(record => record?.state === 'unknown')).toBe(false);
  });

  test('deletion checks current destination project and retains mapping', async () => {
    rememberPair('LOCAL-1', 'REMOTE-1');
    mockMappings.set(mappingKey('42', 'org-1', 'remote-to-local'), '77');
    getFullIssue.mockResolvedValue({ key: 'LOCAL-1', fields: { project: { key: 'OTHER' } } });
    await expect(propagateAttachmentDeletion({ direction: 'remote-to-local', sourceAttachmentId: '42', localKey: 'LOCAL-1',
      remoteKey: 'REMOTE-1', config: ORG, orgId: 'org-1', syncOptions: { ...OPTIONS, propagateAttachmentDeletions: true } }))
      .rejects.toMatchObject({ code: 'INBOUND_SCOPE_BLOCKED' });
    expect(deleteAttachmentContent).not.toHaveBeenCalled();
    expect(mockMappings.get(mappingKey('42', 'org-1', 'remote-to-local'))).toBe('77');
  });
});
