import fs from 'fs';
import path from 'path';

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  const fetchMock = jest.fn();
  return {
    __esModule: true,
    default: {
      asApp: () => ({ requestJira }),
      asUser: () => ({ requestJira })
    },
    route: (strings, ...values) =>
      strings.reduce((out, part, index) => out + part + (values[index] ?? ''), ''),
    fetch: fetchMock,
    __requestJira: requestJira,
    __fetch: fetchMock
  };
});

jest.mock('../src/services/storage/kvs.js', () => {
  const store = new Map();
  return {
    __store: store,
    get: jest.fn(async key => (store.has(key) ? store.get(key) : null)),
    set: jest.fn(async (key, value) => { store.set(key, value); }),
    del: jest.fn(async key => { store.delete(key); }),
    getSecret: jest.fn(async key => (store.has(key) ? store.get(key) : null)),
    setSecret: jest.fn(async (key, value) => { store.set(key, value); }),
    deleteSecret: jest.fn(async key => { store.delete(key); })
  };
});

jest.mock('../src/services/sync/initial-sync.js', () => ({
  previewInitialSync: jest.fn()
}));

import {
  handleSetupWizardAction,
  setupWizardProgressKey,
  setupWizardMetadataKey,
  SETUP_WIZARD_VERSION,
  SETUP_WIZARD_REQUIRED_WEBHOOK_EVENTS
} from '../src/services/setup/setup-wizard.js';
import { KNOWN_WEBHOOK_EVENTS } from '../src/webtriggers/incoming-webhook.js';
import { previewInitialSync } from '../src/services/sync/initial-sync.js';
import * as kvsStore from '../src/services/storage/kvs.js';
import { RESOLVER_POLICIES } from '../src/resolvers/authorization-policy.js';
import {
  recordAuthenticatedWebhookReceipt,
  webhookReceiptKey
} from '../src/services/storage/webhook-receipt.js';
import { __fetch as mockFetch, __requestJira as mockRequestJira } from '@forge/api';

const mockStore = kvsStore.__store;
const API_TOKEN = 'wizard-private-api-token';
const WEBHOOK_SECRET = 'wizard-private-webhook-secret';
const SECRET_ISSUE_TEXT = 'PRIVATE_JIRA_ISSUE_CONTENT';

const ORG = {
  id: 'org-1',
  name: 'Target Org',
  remoteUrl: 'https://target.example',
  remoteEmail: 'sync@example.com',
  remoteProjectKey: 'REMOTE',
  allowedProjects: ['LOCAL'],
  jqlFilter: 'labels = setup',
  syncDirection: 'push'
};

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body
  };
}

function preview(counts = {}, checksums = {}) {
  return {
    success: true,
    preview: {
      counts: {
        eligible: 4,
        alreadyMapped: 2,
        blockedByValidation: 1,
        mappingConflicts: 1,
        ...counts
      },
      previewChecksum: checksums.previewChecksum || 'preview-checksum',
      configurationChecksum: checksums.configurationChecksum || 'configuration-checksum'
    }
  };
}

function seedOrg(overrides = {}) {
  mockStore.set('organizations', [{ ...ORG, ...overrides }]);
  mockStore.set('secret:org-1:token', API_TOKEN);
  mockStore.set('projectMappings:org-1', { LOCAL: 'REMOTE' });
  mockStore.set('userMappings:org-1', {
    'remote-user-1': { localId: 'local-user-1', localName: 'Local User', remoteName: 'Remote User' }
  });
  mockStore.set('fieldMappings:org-1', {
    customfield_10001: { localId: 'customfield_20001', localName: 'Local Field', remoteName: 'Remote Field' }
  });
  mockStore.set('statusMappings:org-1', {
    'remote-status-1': { localId: 'local-status-1', localName: 'To Do', remoteName: 'To Do' }
  });
  mockStore.set('issueTypeMappings:org-1', {
    'remote-type-1': { localId: 'local-type-1', localName: 'Task', remoteName: 'Task' }
  });
  mockStore.set('syncOptions:org-1', {
    syncComments: true,
    syncAttachments: true,
    propagateAttachmentDeletions: false,
    syncLinks: true,
    syncCrossReference: true,
    maxAttachmentSizeBytes: 5242880
  });
}

function call(action, payload = {}) {
  return handleSetupWizardAction({ action, orgId: 'org-1', ...payload });
}

async function saveStep(step, data = {}) {
  return call('save-step', { step, data });
}

async function runThrough(lastStep) {
  const sequence = [
    ['connection', {}],
    ['scope', {}],
    ['direction', {}],
    ['mappings', {}],
    ['features', {}],
    ['webhook', {}],
    ['communication', { approved: true }],
    ['initial-sync', { choice: 'previewed' }]
  ];
  for (const [step, data] of sequence) {
    const result = await saveStep(step, data);
    expect(result.success).toBe(true);
    if (step === lastStep) return result;
  }
  throw new Error(`Unknown test step ${lastStep}`);
}

async function activationAttempt(mutate) {
  await call('start');
  await runThrough('initial-sync');
  const before = JSON.stringify(mockStore.get(setupWizardProgressKey('org-1')));
  if (mutate) await mutate();
  const result = await call('complete', { approved: true });
  const after = JSON.stringify(mockStore.get(setupWizardProgressKey('org-1')));
  return { result, before, after };
}

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
  mockRequestJira.mockReset();
  mockFetch.mockReset();

  seedOrg();
  previewInitialSync.mockResolvedValue(preview());

  mockFetch.mockImplementation(async (url) => {
    if (String(url).endsWith('/rest/api/3/myself')) {
      return jsonResponse({ displayName: 'Remote Admin', emailAddress: 'remote@example.com' });
    }
    if (String(url).includes('/rest/api/3/project/')) {
      return jsonResponse({ key: 'REMOTE' });
    }
    if (String(url).includes('/rest/api/3/mypermissions')) {
      return jsonResponse({
        permissions: {
          CREATE_ISSUES: { havePermission: true },
          EDIT_ISSUES: { havePermission: true }
        }
      });
    }
    return jsonResponse({}, false, 404);
  });
  mockRequestJira.mockResolvedValue(jsonResponse({
    permissions: {
      CREATE_ISSUES: { havePermission: true },
      EDIT_ISSUES: { havePermission: true }
    }
  }));
});
describe('guided setup step ordering and resumable progress', () => {
  test('requires prior steps and cannot jump to a later validation', async () => {
    await call('start');

    const scopeFirst = await saveStep('scope');
    expect(scopeFirst.success).toBe(false);
    expect(scopeFirst.code).toBe('STEP_ORDER_VIOLATION');

    const directionFirst = await saveStep('direction');
    expect(directionFirst.success).toBe(false);
    expect(directionFirst.code).toBe('STEP_ORDER_VIOLATION');

    const mappingsFirst = await saveStep('mappings');
    expect(mappingsFirst.success).toBe(false);
    expect(mappingsFirst.code).toBe('STEP_ORDER_VIOLATION');
  });

  test('saves safe progress and resumes after a fresh load', async () => {
    await call('start');
    const connection = await saveStep('connection');
    expect(connection.success).toBe(true);
    expect(connection.state.completedSteps).toEqual(['connection']);
    expect(connection.state.currentStep).toBe('scope');

    const resumed = await call('load');
    expect(resumed.success).toBe(true);
    expect(resumed.state.completedSteps).toEqual(['connection']);
    expect(resumed.state.currentStep).toBe('scope');
    expect(resumed.steps.find(step => step.key === 'connection').completed).toBe(true);
  });
});

describe('guided setup dependency invalidation', () => {
  test('changing connection invalidates every dependent later validation', async () => {
    await call('start');
    await runThrough('direction');

    const revalidated = await saveStep('connection');
    expect(revalidated.success).toBe(true);
    expect(revalidated.state.completedSteps).toEqual(['connection']);
    expect(revalidated.state.currentStep).toBe('scope');
  });

  test('changing scope invalidates only dependent validations', async () => {
    await call('start');
    await runThrough('webhook');

    const revalidated = await saveStep('scope');
    expect(revalidated.success).toBe(true);
    expect(revalidated.state.completedSteps).toEqual([
      'connection',
      'scope',
      'direction',
      'features',
      'webhook'
    ]);
    expect(revalidated.state.currentStep).toBe('mappings');
    expect(revalidated.state.validations.mappings).toBeUndefined();
    expect(revalidated.state.validations.communication).toBeUndefined();
    expect(revalidated.state.validations['initial-sync']).toBeUndefined();
  });
});

describe('guided setup credential handling', () => {
  test('never returns, stores or accepts credentials in wizard state', async () => {
    await call('start');
    const result = await saveStep('connection', {
      remoteApiToken: 'CLIENT_SUPPLIED_SECRET_MUST_BE_IGNORED',
      token: 'CLIENT_SUPPLIED_SECRET_MUST_BE_IGNORED'
    });

    expect(result.success).toBe(true);
    const stored = JSON.stringify(mockStore.get(setupWizardProgressKey('org-1')));
    const returned = JSON.stringify(result);
    expect(stored).not.toContain(API_TOKEN);
    expect(stored).not.toContain('CLIENT_SUPPLIED_SECRET_MUST_BE_IGNORED');
    expect(returned).not.toContain(API_TOKEN);
    expect(returned).not.toContain('CLIENT_SUPPLIED_SECRET_MUST_BE_IGNORED');
    expect(result.state.orgId).toBe('org-1');
  });

  test('webhook receipts contain no credential or Jira issue content', async () => {
    await recordAuthenticatedWebhookReceipt('org-1', 'jira:issue_updated');
    const stored = mockStore.get(webhookReceiptKey('org-1'));
    const serialized = JSON.stringify(stored);
    expect(stored.receivedAt).toBeTruthy();
    expect(serialized).not.toContain(WEBHOOK_SECRET);
    expect(serialized).not.toContain(API_TOKEN);
    expect(serialized).not.toContain(SECRET_ISSUE_TEXT);
  });
});

describe('guided setup webhook event allowlist', () => {
  test('displayed Jira system-webhook events match the active inbound allowlist', () => {
    const expected = [
      'jira:issue_created',
      'jira:issue_updated',
      'jira:issue_deleted',
      'comment_created',
      'issuelink_created',
      'issuelink_deleted',
      'attachment_created',
      'attachment_deleted'
    ];
    expect(SETUP_WIZARD_REQUIRED_WEBHOOK_EVENTS).toEqual(expected);
    for (const event of SETUP_WIZARD_REQUIRED_WEBHOOK_EVENTS) {
      expect(KNOWN_WEBHOOK_EVENTS.has(event)).toBe(true);
    }
  });

  test('obsolete jira:issue_link_* event names are absent from the displayed list', () => {
    expect(SETUP_WIZARD_REQUIRED_WEBHOOK_EVENTS).not.toContain('jira:issue_link_created');
    expect(SETUP_WIZARD_REQUIRED_WEBHOOK_EVENTS).not.toContain('jira:issue_link_deleted');
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/services/setup/setup-wizard.js'),
      'utf8'
    );
    expect(source).not.toContain('jira:issue_link_created');
    expect(source).not.toContain('jira:issue_link_deleted');
  });
});

describe('guided setup direction and webhook gating', () => {
  test('push mode completes webhook validation as not required', async () => {
    await call('start');
    const result = await runThrough('webhook');

    expect(result.validation.status).toBe('skipped');
    expect(result.validation.summary).toMatchObject({
      required: false,
      verified: true
    });
  });

  test('bidirectional mode requires a fresh authenticated webhook event', async () => {
    mockStore.set('organizations', [{ ...ORG, syncDirection: 'bidirectional' }]);
    await call('start');
    await runThrough('features');

    const missing = await saveStep('webhook');
    expect(missing.success).toBe(false);
    expect(missing.code).toBe('SETUP_VALIDATION_FAILED');
    expect(missing.errors.join(' ')).toContain('No authenticated webhook event');

    mockStore.set('secret:org-1:incomingSecret', WEBHOOK_SECRET);
    mockStore.set('webhookReceipt:org-1', {
      event: 'jira:issue_updated',
      receivedAt: new Date().toISOString()
    });
    const verified = await saveStep('webhook');
    expect(verified.success).toBe(true);
    expect(verified.validation.status).toBe('passed');
    expect(verified.validation.summary.verified).toBe(true);
  });

  test('an event older than the latest credential rotation does not verify', async () => {
    mockStore.set('organizations', [{ ...ORG, syncDirection: 'bidirectional' }]);
    mockStore.set('secret:org-1:incomingSecret', WEBHOOK_SECRET);
    mockStore.set('webhookSecretMeta:org-1', {
      rotatedAt: '2026-02-01T00:00:00.000Z'
    });
    mockStore.set('webhookReceipt:org-1', {
      event: 'jira:issue_updated',
      receivedAt: '2026-01-01T00:00:00.000Z'
    });
    await call('start');
    await runThrough('features');

    const result = await saveStep('webhook');
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toContain('has not received an authenticated event');
  });
});

describe('guided setup mapping and feature validation', () => {
  test('separates optional mapping warnings from required mapping errors', async () => {
    await call('start');
    await runThrough('direction');

    for (const key of [
      'userMappings:org-1',
      'fieldMappings:org-1',
      'statusMappings:org-1',
      'issueTypeMappings:org-1'
    ]) {
      mockStore.delete(key);
    }
    const warningsOnly = await saveStep('mappings');
    expect(warningsOnly.success).toBe(true);
    expect(warningsOnly.validation.errors).toEqual([]);
    expect(warningsOnly.validation.warnings.length).toBeGreaterThan(0);

    mockStore.set('fieldMappings:org-1', {
      customfield_10001: { localName: 'Missing local ID' }
    });
    const invalid = await saveStep('mappings');
    expect(invalid.success).toBe(false);
    expect(invalid.validation.errors).toEqual([
      'Field mappings contains an entry without a local destination ID.'
    ]);
  });

  test('required destination mapping is enforced without creating a new mapping model', async () => {
    await call('start');
    await runThrough('direction');

    mockStore.set('organizations', [{ ...ORG, remoteProjectKey: '' }]);
    mockStore.delete('projectMappings:org-1');

    const result = await saveStep('mappings');
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toContain('No destination project is configured');
    expect(mockStore.has('priorityMappings:org-1')).toBe(false);
    expect(mockStore.has('setupMappings:org-1')).toBe(false);
  });

  test('uses the existing sync options, with attachment deletion separately default Off', async () => {
    await call('start');
    await runThrough('mappings');

    mockStore.set('syncOptions:org-1', {
      syncComments: false,
      syncAttachments: true,
      syncLinks: false,
      syncCrossReference: false,
      maxAttachmentSizeBytes: 1048576
    });
    const result = await saveStep('features');
    expect(result.success).toBe(true);
    expect(result.validation.summary).toMatchObject({
      syncComments: false,
      syncAttachments: true,
      syncLinks: false,
      syncCrossReference: false,
      propagateAttachmentDeletions: false,
      maxAttachmentSizeBytes: 1048576
    });
    expect(mockStore.has('setupFeatures:org-1')).toBe(false);
  });
});

describe('guided setup initial synchronization reuse', () => {
  test('records read-only preview counts without starting a job', async () => {
    await call('start');
    await runThrough('communication');

    const result = await saveStep('initial-sync', { choice: 'previewed' });
    expect(result.success).toBe(true);
    expect(result.validation.summary).toMatchObject({
      choice: 'previewed',
      counts: {
        eligible: 4,
        alreadyMapped: 2,
        blockedByValidation: 1,
        mappingConflicts: 1
      },
      previewChecksum: 'preview-checksum',
      configurationChecksum: 'configuration-checksum'
    });
    expect(previewInitialSync).toHaveBeenCalledWith({ orgId: 'org-1' });
  });

  test('deferring initial sync requires explicit acknowledgement', async () => {
    await call('start');
    await runThrough('communication');

    const missingAcknowledgement = await saveStep('initial-sync', { choice: 'deferred' });
    expect(missingAcknowledgement.success).toBe(false);
    expect(missingAcknowledgement.errors.join(' ')).toContain('Acknowledge');

    const deferred = await saveStep('initial-sync', {
      choice: 'deferred',
      acknowledged: true
    });
    expect(deferred.success).toBe(true);
    expect(deferred.validation.summary.choice).toBe('deferred');
  });
});

describe('guided setup activation and existing organizations', () => {
  test('activation stores exactly safe setup metadata and removes progress', async () => {
    await call('start');
    await runThrough('initial-sync');

    const result = await call('complete', { approved: true });
    expect(result.success).toBe(true);
    expect(result.metadata).toEqual({
      setupStatus: 'completed',
      setupVersion: SETUP_WIZARD_VERSION,
      setupCompletedAt: expect.any(String)
    });
    expect(Object.keys(mockStore.get(setupWizardMetadataKey('org-1'))).sort()).toEqual([
      'setupCompletedAt',
      'setupStatus',
      'setupVersion'
    ]);
    expect(mockStore.has(setupWizardProgressKey('org-1'))).toBe(false);
    const serialized = JSON.stringify(mockStore.get(setupWizardMetadataKey('org-1')));
    expect(serialized).not.toContain(API_TOKEN);
    expect(serialized).not.toContain(SECRET_ISSUE_TEXT);
  });

  test('activation requires explicit approval', async () => {
    await call('start');
    await runThrough('initial-sync');

    const result = await call('complete', { approved: false });
    expect(result.success).toBe(false);
    expect(result.code).toBe('SETUP_APPROVAL_REQUIRED');
    expect(mockStore.has(setupWizardMetadataKey('org-1'))).toBe(false);
  });

  test('administration changes after validation block activation without overwriting progress', async () => {
    const { result, before, after } = await activationAttempt(() => {
      mockStore.set('organizations', [{ ...ORG, remoteProjectKey: 'OTHER' }]);
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('SETUP_STALE_CONNECTION');
    expect(result.step).toBe('connection');
    expect(result.requiresRevalidation).toBe('connection');
    expect(before).toBe(after);
    expect(mockStore.has(setupWizardMetadataKey('org-1'))).toBe(false);
  });

  test('changed scope blocks activation', async () => {
    const { result, before, after } = await activationAttempt(() => {
      mockStore.set('organizations', [{ ...ORG, allowedProjects: ['OTHER'] }]);
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('SETUP_STALE_SCOPE');
    expect(result.requiresRevalidation).toBe('scope');
    expect(before).toBe(after);
    expect(mockStore.has(setupWizardMetadataKey('org-1'))).toBe(false);
  });

  test('changed direction blocks activation', async () => {
    const { result, before, after } = await activationAttempt(() => {
      mockStore.set('organizations', [{ ...ORG, syncDirection: 'bidirectional' }]);
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('SETUP_STALE_DIRECTION');
    expect(result.requiresRevalidation).toBe('direction');
    expect(before).toBe(after);
    expect(mockStore.has(setupWizardMetadataKey('org-1'))).toBe(false);
  });

  test('changed mappings block activation', async () => {
    const { result, before, after } = await activationAttempt(() => {
      mockStore.set('fieldMappings:org-1', {
        customfield_10001: { localId: 'customfield_20002', localName: 'Local Field', remoteName: 'Remote Field' }
      });
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('SETUP_STALE_MAPPINGS');
    expect(result.requiresRevalidation).toBe('mappings');
    expect(before).toBe(after);
    expect(mockStore.has(setupWizardMetadataKey('org-1'))).toBe(false);
  });

  test('changed features block activation', async () => {
    const { result, before, after } = await activationAttempt(() => {
      mockStore.set('syncOptions:org-1', {
        syncComments: false,
        syncAttachments: true,
        propagateAttachmentDeletions: false,
        syncLinks: true,
        syncCrossReference: true,
        maxAttachmentSizeBytes: 5242880
      });
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('SETUP_STALE_FEATURES');
    expect(result.requiresRevalidation).toBe('features');
    expect(before).toBe(after);
    expect(mockStore.has(setupWizardMetadataKey('org-1'))).toBe(false);
  });

  test('changed initial-sync preview checksum blocks activation', async () => {
    const { result, before, after } = await activationAttempt(() => {
      previewInitialSync.mockResolvedValue(preview({}, {
        previewChecksum: 'changed-preview-checksum'
      }));
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('SETUP_STALE_INITIAL_SYNC');
    expect(result.requiresRevalidation).toBe('initial-sync');
    expect(before).toBe(after);
    expect(mockStore.has(setupWizardMetadataKey('org-1'))).toBe(false);
  });

  test('changed initial-sync configuration checksum blocks activation', async () => {
    const { result, before, after } = await activationAttempt(() => {
      previewInitialSync.mockResolvedValue(preview({}, {
        configurationChecksum: 'changed-configuration-checksum'
      }));
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('SETUP_STALE_INITIAL_SYNC');
    expect(result.requiresRevalidation).toBe('initial-sync');
    expect(before).toBe(after);
    expect(mockStore.has(setupWizardMetadataKey('org-1'))).toBe(false);
  });

  test('webhook changes block activation when the current webhook is no longer verified', async () => {
    mockStore.set('organizations', [{ ...ORG, syncDirection: 'bidirectional' }]);
    mockStore.set('secret:org-1:incomingSecret', WEBHOOK_SECRET);
    mockStore.set('webhookReceipt:org-1', {
      event: 'jira:issue_updated',
      receivedAt: new Date().toISOString()
    });
    await call('start');
    await runThrough('initial-sync');
    const before = JSON.stringify(mockStore.get(setupWizardProgressKey('org-1')));
    mockStore.delete('secret:org-1:incomingSecret');

    const result = await call('complete', { approved: true });
    expect(result.success).toBe(false);
    expect(result.code).toBe('SETUP_STALE_WEBHOOK');
    expect(result.requiresRevalidation).toBe('webhook');
    expect(JSON.stringify(mockStore.get(setupWizardProgressKey('org-1')))).toBe(before);
    expect(mockStore.has(setupWizardMetadataKey('org-1'))).toBe(false);
  });

  test('existing organizations can be validated without starting or writing wizard state', async () => {
    kvsStore.set.mockClear();
    const result = await call('validate-existing');

    expect(result.success).toBe(true);
    expect(result.writesPerformed).toBe(0);
    expect(result.steps.connection.status).toBe('passed');
    expect(result.steps.scope.status).toBe('passed');
    expect(result.steps.webhook.status).toBe('skipped');
    expect(kvsStore.set).not.toHaveBeenCalled();
    expect(mockStore.has(setupWizardProgressKey('org-1'))).toBe(false);
    expect(mockStore.has(setupWizardMetadataKey('org-1'))).toBe(false);
  });
  test('read-only preflight never claims real synchronization success and performs no Jira writes or deletes', async () => {
    await call('start');
    await runThrough('webhook');

    const notApproved = await saveStep('communication', { approved: false });
    expect(notApproved.success).toBe(false);
    expect(notApproved.errors.join(' ')).toContain('Explicit administrator approval');

    const approved = await saveStep('communication', { approved: true });
    expect(approved.success).toBe(true);
    expect(approved.validation.summary).toMatchObject({
      approved: true,
      preflightOnly: true,
      readOnly: true,
      endToEndSynchronizationVerified: false,
      writesPerformed: 0,
      deletionPerformed: false,
      destructiveSystemTestUsed: false,
      issuesCreated: [],
      aToB: { status: 'ready' },
      bToA: { status: 'skipped' }
    });
    for (const [, options] of mockFetch.mock.calls) {
      expect(options.method).toBe('GET');
    }
  });
});

describe('guided setup source safety guarantees', () => {
  const root = process.cwd();
  const source = fs.readFileSync(
    path.join(root, 'src/services/setup/setup-wizard.js'),
    'utf8'
  );
  const resolver = fs.readFileSync(
    path.join(root, 'src/resolvers/setup.js'),
    'utf8'
  );
  const incomingSync = fs.readFileSync(
    path.join(root, 'src/services/sync/incoming-sync.js'),
    'utf8'
  );

  test('reuses the safe initial-sync workflow and never starts or tests destructively', () => {
    expect(source).toContain("from '../sync/initial-sync.js'");
    expect(source).toContain('previewInitialSync');
    expect(source).not.toContain('startInitialSync');
    expect(source).not.toContain('runSystemTest');
    expect(source).not.toContain('SYSTEM_TEST');
    expect(source).not.toContain('createRemoteIssue');
    expect(resolver).not.toContain('runSystemTest');
  });

  test('does not add another operating-mode or direction model', () => {
    expect(source).not.toMatch(/operatingMode|syncMode|setupMode|one_way|two_way/i);
    expect(source).toContain("return value === 'bidirectional' ? 'bidirectional' : 'push';");
    expect(source).not.toContain('directionMappings');
    expect(source).not.toContain('setupDirection:');
  });

  test('the authenticated webhook path records a non-sensitive receipt', () => {
    expect(incomingSync).toContain('recordAuthenticatedWebhookReceipt(orgId, webhookEvent)');
    expect(incomingSync).toContain("from '../storage/webhook-receipt.js'");
  });

  test('the wizard resolver has an explicit admin policy', () => {
    expect(RESOLVER_POLICIES.setupWizard).toBe('ADMIN_WRITE');
  });
});
