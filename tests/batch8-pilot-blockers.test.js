// The synchronization authorization gate has its own suite; this suite tests another behaviour.
jest.mock('../src/services/sync/sync-authorization.js', () => require('./helpers/authorized-sync-authorization.js'));

const mockStore = new Map();
const mockSecretStore = new Map();

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  const fetchMock = jest.fn();
  return {
    __esModule: true,
    default: {
      asApp: () => ({ requestJira }),
      asUser: () => ({ requestJira })
    },
    route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch: fetchMock
  };
});

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
  setWithTtl: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  getSecret: jest.fn(async key => (mockSecretStore.has(key) ? mockSecretStore.get(key) : null)),
  setSecret: jest.fn(async (key, value) => { mockSecretStore.set(key, value); })
}));

jest.mock('../src/services/storage/mappings.js', () => ({
  getRemoteKey: jest.fn(async () => null),
  getLocalKey: jest.fn(async () => null),
  getAllRemoteKeys: jest.fn(async () => []),
  storeMapping: jest.fn(async () => ({ idempotent: false })),
  ensureMappingPair: jest.fn(),
  getOrganizationsWithTokens: jest.fn(async () => []),
  setLastSyncedLocalUpdated: jest.fn(),
  storeAttachmentMapping: jest.fn(),
  removeAttachmentMapping: jest.fn(),
  getAttachmentMapping: jest.fn(async () => null),
  storeLinkMapping: jest.fn(),
  removeLinkMapping: jest.fn(),
  getLinkMapping: jest.fn(async () => null),
  getLocalCommentId: jest.fn(),
  getRemoteCommentId: jest.fn(async () => null),
  storeCommentMapping: jest.fn()
}));

jest.mock('../src/services/storage/flags.js', () => ({
  markSyncing: jest.fn(),
  clearSyncFlag: jest.fn(),
  isSyncing: jest.fn(async () => false),
  findPendingLinksToIssue: jest.fn(async () => []),
  removePendingLink: jest.fn(),
  storePendingLink: jest.fn(),
  enqueuePendingChildIssue: jest.fn(),
  consumePendingChildIssues: jest.fn(async () => [])
}));

jest.mock('../src/services/storage/stats.js', () => ({
  logAuditEntry: jest.fn(async () => undefined),
  trackWebhookSync: jest.fn(async () => undefined),
  trackApiCall: jest.fn()
}));

jest.mock('../src/services/storage/rejected-fields.js', () => ({
  recordRejectedFields: jest.fn(async () => undefined),
  getRejectedFields: jest.fn(async () => []),
  clearRejectedField: jest.fn()
}));

jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn(),
  getFullComment: jest.fn(),
  getOrgName: jest.fn(async () => 'Local Org'),
  updateLocalIssueDescription: jest.fn(),
  uploadAttachment: jest.fn(),
  downloadAttachment: jest.fn(async () => Buffer.from('file'))
}));

jest.mock('../src/services/jira/remote-client.js', () => ({
  getRemoteIssue: jest.fn(),
  getRemoteComment: jest.fn(),
  uploadAttachment: jest.fn(),
  downloadRemoteAttachment: jest.fn(),
  getRemoteIssueAttachments: jest.fn(async () => [])
}));

jest.mock('../src/services/sync/issue-sync.js', () => ({
  createIssueForOrg: jest.fn(),
  updateIssueForOrg: jest.fn()
}));

jest.mock('../src/services/sync/transition-sync.js', () => ({
  transitionLocalIssue: jest.fn(async () => false),
  transitionRemoteIssue: jest.fn(async () => false)
}));

import api, { fetch } from '@forge/api';
import { defineDataResolvers } from '../src/resolvers/data.js';
import { defineConfigResolvers } from '../src/resolvers/config.js';
import { processIncomingWebhook } from './helpers/signed-webhook.js';
import { syncAttachments, getAttachmentSyncPolicy } from '../src/services/sync/attachment-sync.js';
import {
  beginIssueCreateOperation,
  markIssueCreateSubmissionStarted,
  buildIssueCreateOperationKey,
  ISSUE_CREATE_DIRECTIONS,
  ISSUE_CREATE_STATES
} from '../src/services/sync/issue-create-operation.js';
import { getFullIssue, downloadAttachment } from '../src/services/jira/local-client.js';
import {
  getRemoteIssue,
  getRemoteIssueAttachments,
  uploadAttachment,
  downloadRemoteAttachment
} from '../src/services/jira/remote-client.js';
import { getRemoteKey, getLocalKey, storeMapping } from '../src/services/storage/mappings.js';
import { RESOLVER_POLICIES } from '../src/resolvers/authorization-policy.js';
import { createAuthorizedHandler, forbiddenResponse } from '../src/resolvers/authorization.js';

const mockFetch = fetch;
const mockRequestJira = api.asApp().requestJira;

const ORG = {
  id: 'org-1',
  name: 'Target Org',
  remoteUrl: 'https://remote.example',
  remoteEmail: 'sync@example.com',
  remoteProjectKey: 'REMOTE',
  allowedProjects: ['LOCAL'],
  syncDirection: 'bidirectional'
};

function defineResolvers() {
  const definitions = {};
  defineDataResolvers({ define: (name, fn) => { definitions[name] = fn; } });
  return definitions;
}

function seedOrg() {
  mockStore.set('organizations', [ORG]);
  mockStore.set('projectMappings:org-1', { LOCAL: 'REMOTE' });
  mockSecretStore.set('secret:org-1:token', 'remote-token');
  mockSecretStore.set('secret:org-1:webhookSigningSecret', 'abcdefghijklmnop');
}

function sourceIssue() {
  return {
    key: 'LOCAL-1',
    fields: {
      project: { key: 'LOCAL' },
      summary: 'Source issue',
      issuetype: { name: 'Task' }
    }
  };
}

function localOperationKey() {
  return buildIssueCreateOperationKey({
    orgId: 'org-1',
    direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
    sourceKey: 'LOCAL-1'
  });
}

async function seedAmbiguousOperation() {
  const claim = await beginIssueCreateOperation({
    orgId: 'org-1',
    direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
    sourceKey: 'LOCAL-1'
  });
  await markIssueCreateSubmissionStarted(claim.operation);
  return claim.operation;
}

beforeEach(() => {
  mockStore.clear();
  mockSecretStore.clear();
  jest.clearAllMocks();
  mockFetch.mockReset();
  mockRequestJira.mockReset();
  getFullIssue.mockResolvedValue(sourceIssue());
  getRemoteKey.mockResolvedValue(null);
  getLocalKey.mockResolvedValue(null);
  getRemoteIssueAttachments.mockResolvedValue([]);
});


describe('Batch 8 force-recreate removal', () => {
  test('importIssues rejects forceRecreate without reading, deleting, or creating anything', async () => {
    seedOrg();
    const definitions = defineResolvers();
    const before = new Map(mockStore);

    const result = await definitions.importIssues({
      payload: {
        orgId: 'org-1',
        issueKeys: ['LOCAL-1'],
        options: { forceRecreate: true }
      }
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      code: 'FORCE_RECREATE_DISABLED'
    }));
    expect(result.results).toEqual({
      processed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: []
    });
    expect(getFullIssue).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockRequestJira).not.toHaveBeenCalled();
    expect(storeMapping).not.toHaveBeenCalled();
    expect(mockStore).toEqual(before);
  });
});

describe('Batch 8 explicit-key create reconciliation', () => {
  test.each([null, '', 'invalid-key'])('rejects explicit invalid routing %p without resolving the ledger', async mapping => {
    seedOrg();
    await seedAmbiguousOperation();
    mockStore.set('projectMappings:org-1', { LOCAL: mapping });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ fields: { project: { key: 'REMOTE' } } }) });
    const result = await defineResolvers().reconcileIssueCreate({ payload: {
      orgId: 'org-1', direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
      sourceKey: 'LOCAL-1', jiraIssueKey: 'REMOTE-9'
    } });
    expect(result.success).toBe(false);
    expect(storeMapping).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockStore.get(localOperationKey()).state).toBe(ISSUE_CREATE_STATES.PENDING);
  });

  test('requires an explicit Jira key and ignores summary matching', async () => {
    seedOrg();
    await seedAmbiguousOperation();
    const definitions = defineResolvers();

    const result = await definitions.reconcileIssueCreate({
      payload: {
        orgId: 'org-1',
        direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
        sourceKey: 'LOCAL-1',
        summary: 'Source issue'
      }
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      code: 'INVALID_RECONCILIATION_REQUEST'
    }));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockStore.get(localOperationKey()).state).toBe(ISSUE_CREATE_STATES.PENDING);
    expect(storeMapping).not.toHaveBeenCalled();
  });

  test.each([undefined, { LOCAL: 'REMOTE' }])('resolves with valid or intentionally absent routing %p', async projectMappings => {
    seedOrg();
    if (projectMappings) mockStore.set('projectMappings:org-1', projectMappings);
    const operation = await seedAmbiguousOperation();
    const definitions = defineResolvers();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ fields: { project: { key: 'REMOTE' } } })
    });

    const result = await definitions.reconcileIssueCreate({
      payload: {
        orgId: 'org-1',
        direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
        sourceKey: 'LOCAL-1',
        jiraIssueKey: 'REMOTE-9'
      }
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      sourceKey: 'LOCAL-1',
      targetKey: 'REMOTE-9',
      projectKey: 'REMOTE'
    }));
    expect(JSON.stringify(result)).not.toContain(operation.attemptToken);
    expect(result).not.toHaveProperty('attemptToken');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/rest/api/3/issue/REMOTE-9?fields=project'),
      expect.objectContaining({ method: 'GET' })
    );
    expect(mockFetch.mock.calls.some(([, options]) => ['POST', 'DELETE'].includes(options?.method))).toBe(false);
    expect(mockRequestJira).not.toHaveBeenCalled();
    expect(storeMapping).toHaveBeenCalledWith('LOCAL-1', 'REMOTE-9', 'org-1');
    expect(mockStore.get(localOperationKey())).toEqual(expect.objectContaining({
      state: ISSUE_CREATE_STATES.SUCCEEDED,
      targetKey: 'REMOTE-9'
    }));
  });

  test('rejects an explicit issue outside the configured target project', async () => {
    seedOrg();
    await seedAmbiguousOperation();
    const definitions = defineResolvers();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ fields: { project: { key: 'OTHER' } } })
    });

    const result = await definitions.reconcileIssueCreate({
      payload: {
        orgId: 'org-1',
        direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
        sourceKey: 'LOCAL-1',
        jiraIssueKey: 'OTHER-9'
      }
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      code: 'TARGET_PROJECT_MISMATCH'
    }));
    expect(storeMapping).not.toHaveBeenCalled();
    expect(mockStore.get(localOperationKey()).state).not.toBe(ISSUE_CREATE_STATES.SUCCEEDED);
  });

  test('rejects reconciliation when the source already maps to another issue', async () => {
    seedOrg();
    await seedAmbiguousOperation();
    getRemoteKey.mockResolvedValue('REMOTE-OLD');
    const definitions = defineResolvers();

    const result = await definitions.reconcileIssueCreate({
      payload: {
        orgId: 'org-1',
        direction: ISSUE_CREATE_DIRECTIONS.LOCAL_TO_REMOTE,
        sourceKey: 'LOCAL-1',
        jiraIssueKey: 'REMOTE-9'
      }
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      code: 'MAPPING_CONFLICT'
    }));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(storeMapping).not.toHaveBeenCalled();
  });

  test('reconciles a remote-to-local create using the explicit local issue key', async () => {
    seedOrg();
    await beginIssueCreateOperation({
      orgId: 'org-1',
      direction: ISSUE_CREATE_DIRECTIONS.REMOTE_TO_LOCAL,
      sourceKey: 'REMOTE-1'
    });
    const definitions = defineResolvers();
    mockRequestJira.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ fields: { project: { key: 'LOCAL' } } })
    });

    const result = await definitions.reconcileIssueCreate({
      payload: {
        orgId: 'org-1',
        direction: ISSUE_CREATE_DIRECTIONS.REMOTE_TO_LOCAL,
        sourceKey: 'REMOTE-1',
        jiraIssueKey: 'LOCAL-9'
      }
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      sourceKey: 'REMOTE-1',
      targetKey: 'LOCAL-9',
      projectKey: 'LOCAL'
    }));
    expect(mockRequestJira).toHaveBeenCalledWith(
      expect.stringContaining('/rest/api/3/issue/LOCAL-9?fields=project')
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(storeMapping).toHaveBeenCalledWith('LOCAL-9', 'REMOTE-1', 'org-1');
  });

  test('is registered as an administrator-only write operation', async () => {
    expect(RESOLVER_POLICIES.reconcileIssueCreate).toBe('ADMIN_WRITE');

    const implementation = jest.fn(async () => ({ success: true }));
    const denied = createAuthorizedHandler('reconcileIssueCreate', implementation, {
      checkPermission: jest.fn(async () => false),
      recordAudit: jest.fn(async () => undefined)
    });
    await expect(denied({ context: { accountId: 'user-1' }, payload: {} }))
      .resolves.toEqual(forbiddenResponse());
    expect(implementation).not.toHaveBeenCalled();

    const allowed = createAuthorizedHandler('reconcileIssueCreate', implementation, {
      checkPermission: jest.fn(async () => true),
      recordAudit: jest.fn(async () => undefined)
    });
    await expect(allowed({ context: { accountId: 'admin-1' }, payload: {} }))
      .resolves.toEqual({ success: true });
    expect(implementation).toHaveBeenCalledTimes(1);
  });
});


describe('Batch 8 backend attachment default-off policy', () => {
  test('syncAttachments defaults off and performs no download or upload', async () => {
    const issue = {
      key: 'LOCAL-1',
      fields: {
        attachment: [{ id: '42', filename: 'secret.txt', content: 'https://evil.example/file' }]
      }
    };
    const syncResult = { addWarning: jest.fn() };

    const result = await syncAttachments(
      'LOCAL-1',
      'REMOTE-1',
      issue,
      { ...ORG, remoteApiToken: 'remote-token' },
      syncResult,
      'org-1'
    );

    expect(result).toEqual({});
    expect(getAttachmentSyncPolicy()).toEqual(expect.objectContaining({
      enabled: false,
      code: 'ATTACHMENT_SYNC_DISABLED'
    }));
    expect(getRemoteIssueAttachments).not.toHaveBeenCalled();
    expect(downloadAttachment).not.toHaveBeenCalled();
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  test('a mapped attachment webhook uses only canonical Jira URLs', async () => {
    seedOrg();
    mockStore.set('syncOptions:org-1', { syncAttachments: true });
    getLocalKey.mockResolvedValue('LOCAL-1');
    getFullIssue.mockResolvedValue({
      key: 'LOCAL-1',
      fields: { project: { key: 'LOCAL' } }
    });

    mockRequestJira.mockImplementation(async (path, options = {}) => {
      if (String(path).includes('/attachment/meta')) {
        return { ok: true, status: 200, json: async () => ({ enabled: true, uploadLimit: 1000 }) };
      }
      if (String(path).includes('/issue/LOCAL-1/attachments')
          && String(options.method).toUpperCase() === 'POST') {
        expect(options.body.toString('utf8')).toContain('actual.pdf');
        expect(options.body.toString('utf8')).not.toContain('evil.example');
        return { ok: true, status: 200, json: async () => [{ id: '99' }] };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    mockFetch.mockImplementation(async url => {
      const target = String(url);
      expect(target.startsWith('https://remote.example/')).toBe(true);
      expect(target).not.toContain('evil.example');
      if (target.includes('/attachment/meta')) {
        return { ok: true, status: 200, json: async () => ({ enabled: true, uploadLimit: 1000 }) };
      }
      if (target.includes('/attachment/content/42')) {
        return {
          ok: true,
          status: 200,
          url: target,
          arrayBuffer: async () => Uint8Array.from(Buffer.from('data')).buffer
        };
      }
      if (target.includes('/attachment/42')) {
        return {
          ok: true,
          status: 200,
          url: target,
          json: async () => ({
            id: 42,
            filename: 'actual.pdf',
            mimeType: 'application/pdf',
            size: 4
          })
        };
      }
      throw new Error(`unexpected URL ${target}`);
    });

    const result = await processIncomingWebhook({
      webhookEvent: 'attachment_created',
      timestamp: 1780000090000,
      issue: { key: 'REMOTE-1', fields: {} },
      attachment: {
        id: '42',
        filename: 'evil.exe',
        size: 999999,
        content: 'https://evil.example/steal'
      }
    }, { orgId: 'org-1', signingSecret: 'abcdefghijklmnop' });

    expect(result).toEqual({
      status: 200,
      body: { message: 'Processed', code: 'ATTACHMENT_SYNCED' }
    });
    expect(mockFetch).toHaveBeenCalled();
    expect(uploadAttachment).not.toHaveBeenCalled();
  });
  test('an unmapped attachment webhook never fetches its supplied URL', async () => {

    seedOrg();

    const result = await processIncomingWebhook({
      webhookEvent: 'attachment_created',
      timestamp: 1780000000000,
      issue: { key: 'REMOTE-1', fields: {} },
      attachment: {
        id: '42',
        filename: 'secret.txt',
        content: 'https://evil.example/steal'
      }
    }, { orgId: 'org-1', signingSecret: 'abcdefghijklmnop' });

    expect(result).toEqual({
      status: 200,
      body: { message: 'Processed', code: 'ATTACHMENT_ISSUE_NOT_MAPPED' }
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockRequestJira).not.toHaveBeenCalled();
    expect(downloadRemoteAttachment).not.toHaveBeenCalled();
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(getRemoteIssue).not.toHaveBeenCalled();
  });
});


describe('Batch 8 remote-to-local webhook create', () => {
  function remoteIssue() {
    return {
      key: 'REMOTE-1',
      fields: {
        summary: 'Remote issue',
        description: null,
        project: { key: 'REMOTE' },
        issuetype: { name: 'Task', id: '1' },
        status: { name: 'To Do' },
        updated: '2026-10-22T09:00:00.000Z',
        labels: []
      }
    };
  }

  test('creates once and stores the local-to-remote mapping', async () => {
    seedOrg();
    getRemoteIssue.mockResolvedValue(remoteIssue());
    mockRequestJira.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ key: 'LOCAL-9' })
    });

    const result = await processIncomingWebhook({
      webhookEvent: 'jira:issue_created',
      timestamp: 1780000001000,
      issue: remoteIssue()
    }, { orgId: 'org-1', signingSecret: 'abcdefghijklmnop' });

    expect(result).toEqual({ status: 200, body: { message: 'Processed' } });
    expect(mockRequestJira).toHaveBeenCalledTimes(1);
    expect(mockRequestJira).toHaveBeenCalledWith(
      expect.stringContaining('/rest/api/3/issue'),
      expect.objectContaining({ method: 'POST' })
    );
    expect(storeMapping).toHaveBeenCalledWith('LOCAL-9', 'REMOTE-1', 'org-1');
  });

  test('an unknown remote-to-local create result is not retried by a later webhook', async () => {
    seedOrg();
    getRemoteIssue.mockResolvedValue(remoteIssue());
    mockRequestJira.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'upstream unavailable'
    });

    const first = await processIncomingWebhook({
      webhookEvent: 'jira:issue_created',
      timestamp: 1780000002000,
      issue: remoteIssue()
    }, { orgId: 'org-1', signingSecret: 'abcdefghijklmnop' });
    const second = await processIncomingWebhook({
      webhookEvent: 'jira:issue_created',
      timestamp: 1780000003000,
      issue: remoteIssue()
    }, { orgId: 'org-1', signingSecret: 'abcdefghijklmnop' });

    expect(first.status).toBe(500);
    expect(second).toEqual({
      status: 200,
      body: { message: 'Processed', code: 'CREATE_RECONCILIATION_REQUIRED' }
    });
    expect(mockRequestJira).toHaveBeenCalledTimes(1);
    expect(storeMapping).not.toHaveBeenCalled();
  });
});


describe('Batch 8 attachment sync-option preservation', () => {
  test('saveSyncOptions stores an explicitly enabled attachment toggle', async () => {
    const definitions = {};
    defineConfigResolvers({ define: (name, fn) => { definitions[name] = fn; } });

    const saved = await definitions.saveSyncOptions({
      payload: {
        orgId: 'org-1',
        options: {
          syncAttachments: true,
          propagateAttachmentDeletions: true,
          maxAttachmentSizeBytes: 2097152,
          syncComments: false
        }
      }
    });

    expect(saved).toEqual(expect.objectContaining({
      success: true,
      attachmentSync: {
        enabled: true,
        propagateDeletions: true,
        maxAttachmentSizeBytes: 2097152
      }
    }));
    expect(mockStore.get('syncOptions:org-1')).toEqual(expect.objectContaining({
      syncAttachments: true,
      propagateAttachmentDeletions: true,
      maxAttachmentSizeBytes: 2097152,
      syncComments: false
    }));

    const readBack = await definitions.getSyncOptions({ payload: { orgId: 'org-1' } });
    expect(readBack.syncAttachments).toBe(true);
    expect(readBack.propagateAttachmentDeletions).toBe(true);
  });

  test('getSyncOptions preserves a legacy stored attachment preference', async () => {
    const definitions = {};
    defineConfigResolvers({ define: (name, fn) => { definitions[name] = fn; } });
    mockStore.set('syncOptions:org-1', { syncAttachments: true, syncComments: true });

    const options = await definitions.getSyncOptions({ payload: { orgId: 'org-1' } });

    expect(options.syncAttachments).toBe(true);
    expect(options.propagateAttachmentDeletions).toBe(false);
  });

  test('new organizations default attachment options to Off', async () => {
    const definitions = {};
    defineConfigResolvers({ define: (name, fn) => { definitions[name] = fn; } });

    const options = await definitions.getSyncOptions({ payload: { orgId: 'org-new' } });

    expect(options.syncAttachments).toBe(false);
    expect(options.propagateAttachmentDeletions).toBe(false);
  });
});


describe('Batch 8 admin UI attachment controls', () => {
  const source = require('fs').readFileSync(
    require('path').join(process.cwd(), 'static/admin-page/src/App.jsx'),
    'utf8'
  );

  test('force re-create is removed and replaced with an explicit warning', () => {
    expect(source).not.toContain('forceRecreate');
    expect(source).not.toContain('Force re-create remote issues');
    expect(source).toContain('Force re-create is disabled. Imports never delete mappings or create replacement issues.');
  });

  test('attachment sync and deletion propagation are restored and default off', () => {
    expect(source).toContain("label: 'Synchronize attachments'");
    expect(source).toContain('label="Propagate attachment deletions"');
    expect(source).toContain('syncAttachments: false');
    expect(source).toContain('propagateAttachmentDeletions: false');
    expect(source).toContain('Jira malware scanning is not performed by this connector.');
  });
});

