const mockStore = new Map();

const { MAX_AUDIT_LOG_ENTRIES } = require('../src/constants.js');

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  const fetchMock = jest.fn();
  return {
    __esModule: true,
    default: { asApp: () => ({ requestJira }) },
    route: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
    fetch: fetchMock
  };
});

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(async key => (mockStore.has(key) ? mockStore.get(key) : null)),
  set: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  del: jest.fn(async key => { mockStore.delete(key); })
}));

jest.mock('../src/services/storage/mappings.js', () => ({
  getOrganizationsWithTokens: jest.fn(),
  getRemoteKey: jest.fn()
}));

jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn()
}));

import fs from 'fs';
import path from 'path';
import {
  redactForLog,
  redactSecrets,
  sanitizeAuditEntry,
  sanitizeErrorEntry,
  sanitizeCredentialUrl,
  sanitizeLogText,
  safeErrorSummary,
  boundHistory
} from '../src/utils/redaction.js';
import logger from '../src/utils/logger.js';
import { logAuditEntry, trackWebhookSync } from '../src/services/storage/stats.js';
import { defineAuditResolvers } from '../src/resolvers/audit.js';
import { defineDiagnosticsResolvers } from '../src/resolvers/diagnostics.js';
import { defineStatsResolvers } from '../src/resolvers/stats.js';
import { SyncResult } from '../src/services/sync/sync-result.js';
import { formatHttpFailure } from '../src/utils/http-error.js';
import { getOrganizationsWithTokens, getRemoteKey } from '../src/services/storage/mappings.js';
import { getFullIssue } from '../src/services/jira/local-client.js';
import api, { fetch } from '@forge/api';

const mockFetch = fetch;
const mockRequestJira = api.asApp().requestJira;

const ROOT = path.resolve(__dirname, '..');

function defineResolvers(definition) {
  const definitions = {};
  definition({ define: (name, fn) => { definitions[name] = fn; } });
  return definitions;
}

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
});

describe('Batch 5 recursive redaction', () => {
  test('removes tokens, secrets, authorization headers and personal/content fields recursively', () => {
    const result = redactForLog({
      orgId: 'org-1',
      localKey: 'LOCAL-1',
      token: 'super-secret-token',
      nested: {
        authorization: 'Basic abcdef',
        summary: 'Private summary',
        description: { content: 'Private description' },
        comment: 'Private comment',
        assignee: { accountId: 'account-123', displayName: 'Jane Doe' },
        safeCount: 3
      },
      fields: { summary: 'content' },
      payload: { body: 'content' }
    });
    const serialized = JSON.stringify(result);
    expect(result.orgId).toBe('org-1');
    expect(result.localKey).toBe('LOCAL-1');
    expect(result.nested.safeCount).toBe(3);
    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).not.toContain('Basic abcdef');
    expect(serialized).not.toContain('Private summary');
    expect(serialized).not.toContain('Private comment');
    expect(serialized).not.toContain('Jane Doe');
    expect(serialized).not.toContain('account-123');
    expect(serialized).not.toContain('content');
  });

  test('redacts credential-bearing URLs while preserving ordinary URLs', () => {
    expect(sanitizeCredentialUrl('https://user:pass@example.test/issue/LOCAL-1'))
      .toBe('https://example.test/[REDACTED]');
    expect(sanitizeCredentialUrl('https://example.test/path?token=abc123&x=1'))
      .toBe('https://example.test/[REDACTED]');
    expect(sanitizeCredentialUrl('https://example.test/ordinary/path'))
      .toBe('https://example.test/ordinary/path');
    expect(sanitizeLogText('Authorization: Bearer abc.def.ghi'))
      .not.toContain('abc.def.ghi');
  });

  test('redacts credential-bearing webtrigger URLs', () => {
    const value = 'https://abc.webtrigger.atlassian-dev.net/org-1/abcdefghijklmnop';
    expect(sanitizeCredentialUrl(value)).toBe('https://abc.webtrigger.atlassian-dev.net/[REDACTED]');
  });

  test('bounds arrays/objects and does not mutate input', () => {
    const input = {
      labels: Array.from({ length: 40 }, (_, i) => `label-${i}`),
      nested: { secret: 'value', keep: 'ok' },
      summary: 'private'
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    const result = redactForLog(input);
    expect(input).toEqual(snapshot);
    expect(result.labels).toHaveLength(20);
    expect(result.nested.secret).toBeUndefined();
    expect(result.summary).toBeUndefined();
  });

  test('redactSecrets sanitizes credentials without removing configuration content', () => {
    const result = redactSecrets({
      remoteUrl: 'https://user:pass@example.test',
      remoteApiToken: 'secret',
      remoteProjectKey: 'PROJECT'
    });
    expect(result.remoteApiToken).toBeUndefined();
    expect(result.remoteUrl).toBe('https://example.test/[REDACTED]');
    expect(result.remoteProjectKey).toBe('PROJECT');
  });

  test('safeErrorSummary suppresses structured response bodies', () => {
    expect(safeErrorSummary('{"errors":{"summary":"secret"}}')).toBe('operation_failed');
    expect(safeErrorSummary('[large body]')).toBe('operation_failed');
    expect(safeErrorSummary('HTTP 500')).toBe('HTTP 500');
  });
});


describe('Batch 5 safe logger and audit boundary', () => {
  test('logger output contains no tokens or user content', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('Sync failed', {
      orgId: 'org-1',
      token: 'secret-token',
      payload: { summary: 'Private summary', body: 'Private comment' },
      response: { errors: { description: 'Private description' } },
      statusCode: 500
    });
    const output = spy.mock.calls[0][0];
    expect(output).not.toContain('secret-token');
    expect(output).not.toContain('Private summary');
    expect(output).not.toContain('Private comment');
    expect(output).not.toContain('Private description');
    expect(JSON.parse(output)).toEqual(expect.objectContaining({ level: 'INFO', orgId: 'org-1', statusCode: 500 }));
    spy.mockRestore();
  });

  test('audit entries are sanitized at the storage boundary', async () => {
    await logAuditEntry({
      action: 'update',
      sourceIssue: 'LOCAL-1',
      targetIssue: 'REMOTE-1',
      orgId: 'org-1',
      orgName: 'Secret Org',
      reason: 'Customer Acme reported a private issue',
      success: false,
      errors: ['HTTP 500 {"summary":"private summary"}'],
      details: { summary: 'private summary', token: 'secret' },
      remoteApiToken: 'secret-token'
    });
    const stored = mockStore.get('auditLog')[0];
    const serialized = JSON.stringify(stored);
    expect(stored).toEqual(expect.objectContaining({
      action: 'update',
      sourceIssue: 'LOCAL-1',
      targetIssue: 'REMOTE-1',
      orgId: 'org-1',
      success: false,
      errorCount: 1,
      errors: ['operation_failed']
    }));
    expect(serialized).not.toContain('private summary');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('Secret Org');
    expect(serialized).not.toContain('Customer Acme');
    expect(stored.orgName).toBeUndefined();
    expect(stored.reason).toBeUndefined();
    expect(stored.details).toBeUndefined();
  });

  test('audit history is bounded', async () => {
    mockStore.set('auditLog', Array.from({ length: 80 }, (_, i) => ({ action: 'update', sourceIssue: `LOCAL-${i}` })));
    await logAuditEntry({ action: 'update', sourceIssue: 'LOCAL-NEW', success: true });
    const stored = mockStore.get('auditLog');
    expect(stored.length).toBe(Math.min(81, MAX_AUDIT_LOG_ENTRIES));
    expect(stored[0].sourceIssue).toBe('LOCAL-NEW');
  });

  test('getAuditLog sanitizes legacy stored records', async () => {
    mockStore.set('auditLog', [{
      action: 'update',
      sourceIssue: 'LOCAL-1',
      errors: ['{"summary":"legacy private"}'],
      details: { summary: 'legacy private' },
      remoteApiToken: 'legacy-secret'
    }]);
    const resolvers = defineResolvers(defineAuditResolvers);
    const result = await resolvers.getAuditLog();
    expect(JSON.stringify(result)).not.toContain('legacy private');
    expect(JSON.stringify(result)).not.toContain('legacy-secret');
    expect(result[0].errorCount).toBe(1);
  });

  test('webhook error history is sanitized and bounded', async () => {
    mockStore.set('webhookSyncStats', {
      totalSyncs: 0,
      issuesCreated: 0,
      issuesUpdated: 0,
      commentsSynced: 0,
      issuesSkipped: 0,
      loopsPrevented: 0,
      errors: Array.from({ length: 80 }, () => ({ error: 'old' })),
      lastSync: null,
      byOrg: {}
    });
    await trackWebhookSync(
      'update',
      false,
      'HTTP 500 {"summary":"private summary"}',
      'org-1',
      'LOCAL-1',
      {
        errorStack: 'stack with secret-token',
        errorDetails: 'private description',
        fieldsUpdated: { summary: 'private summary' },
        reason: 'remote_rejected'
      }
    );
    const stored = mockStore.get('webhookSyncStats');
    expect(stored.errors).toHaveLength(50);
    const serialized = JSON.stringify(stored.errors);
    expect(serialized).not.toContain('private summary');
    expect(serialized).not.toContain('private description');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('errorStack');
    expect(stored.errors[0]).toEqual(expect.objectContaining({
      operation: 'update',
      details: { reason: 'remote_rejected' }
    }));
  });

  test('bounded history helper caps arbitrary arrays', () => {
    expect(boundHistory(Array.from({ length: 120 }, (_, i) => i), 50)).toHaveLength(50);
    expect(boundHistory('not-an-array', 50)).toEqual([]);
  });

  test('sanitizeErrorEntry keeps safe metadata only', () => {
    const safe = sanitizeErrorEntry({
      error: '{"errors":{"summary":"private"}}',
      orgId: 'org-1',
      issueKey: 'LOCAL-1',
      operation: 'update',
      details: {
        reason: 'remote_rejected',
        statusCode: 500,
        fieldsUpdated: { summary: 'private' },
        errorStack: 'secret'
      }
    });
    expect(safe.error).toBe('operation_failed');
    expect(safe.details).toEqual({ reason: 'remote_rejected', statusCode: 500 });
  });
});


describe('Batch 5 diagnostics and static privacy checks', () => {
  const ORG = {
    id: 'org-1',
    name: 'Private Org Name',
    remoteUrl: 'https://remote.example.invalid',
    remoteEmail: 'private@example.invalid',
    remoteApiToken: 'private-token',
    remoteProjectKey: 'PRIVATE'
  };

  function response(body, ok = true, status = 200) {
    return { ok, status, json: async () => body, text: async () => '' };
  }

  test('health check returns counts/status without names, credentials, stacks or complete records', async () => {
    getOrganizationsWithTokens.mockResolvedValue([ORG]);
    mockFetch.mockImplementation(async (url) => {
      if (url.includes('/myself')) return response({ displayName: 'Private User', emailAddress: 'private@example.invalid' });
      if (url.includes('/project/')) return response({ key: 'PRIVATE' });
      if (url.includes('/mypermissions')) {
        return response({ permissions: {
          CREATE_ISSUES: { havePermission: true },
          EDIT_ISSUES: { havePermission: true },
          DELETE_ISSUES: { havePermission: true }
        } });
      }
      return response({}, false, 404);
    });
    mockRequestJira.mockResolvedValue(response({ permissions: { CREATE_ISSUES: { havePermission: true } } }));

    const resolvers = defineResolvers(defineDiagnosticsResolvers);
    const result = await resolvers.runHealthCheck({ payload: { orgId: 'org-1' } });
    const serialized = JSON.stringify(result);
    expect(result.success).toBe(true);
    expect(serialized).not.toContain('Private User');
    expect(serialized).not.toContain('private@example.invalid');
    expect(serialized).not.toContain('private-token');
    expect(serialized).not.toContain('Private Org Name');
    expect(serialized).not.toContain('PRIVATE');
    expect(serialized).not.toContain('stack');
  });

  test('verifyIssueSync returns safe mismatch/count data only', async () => {
    getOrganizationsWithTokens.mockResolvedValue([ORG]);
    getRemoteKey.mockResolvedValue('REMOTE-1');
    getFullIssue.mockResolvedValue({
      key: 'LOCAL-1',
      fields: {
        summary: 'Private local summary',
        status: { name: 'Private Local Status' },
        attachment: [{ filename: 'private-file.pdf', size: 10 }],
        comment: { comments: [{ body: 'private comment' }] }
      }
    });
    mockFetch.mockResolvedValue(response({
      key: 'REMOTE-1',
      fields: {
        summary: 'Different private summary',
        status: { name: 'Private Remote Status' },
        attachment: [],
        comment: { comments: [] }
      }
    }));

    const resolvers = defineResolvers(defineDiagnosticsResolvers);
    const result = await resolvers.verifyIssueSync({ payload: { orgId: 'org-1', issueKey: 'LOCAL-1' } });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Private local summary');
    expect(serialized).not.toContain('Different private summary');
    expect(serialized).not.toContain('private-file.pdf');
    expect(serialized).not.toContain('Private Local Status');
    expect(serialized).not.toContain('Private Remote Status');
    expect(serialized).not.toContain('private comment');
    expect(result.discrepancies).toEqual(expect.arrayContaining(['Summary mismatch', 'Attachment count mismatch']));
    expect(result.details.status).toEqual({ match: false });
    expect(result.details.attachments).toEqual({ local: 1, remote: 0 });
  });

  test('frontend contains no console logging', () => {
    const files = [
      'static/admin-page/src/App.jsx',
      'static/admin-page/src/components/ErrorBoundary.jsx'
    ];
    for (const relative of files) {
      const content = fs.readFileSync(path.join(ROOT, relative), 'utf8');
      expect(content).not.toMatch(/console\.(?:log|warn|error|debug)/);
    }
  });

  test('raw event/payload/field-value logs are absent from backend hotspots', () => {
    const files = [
      'src/triggers/link.js',
      'src/triggers/link-deleted.js',
      'src/triggers/issue.js',
      'src/services/sync/incoming-sync.js',
      'src/services/sync/issue-sync.js',
      'src/resolvers/data.js'
    ];
    for (const relative of files) {
      const content = fs.readFileSync(path.join(ROOT, relative), 'utf8');
      expect(content).not.toMatch(/console\.[a-z]+\([^;]*JSON\.stringify\((?:event|payload|remoteIssue|updateData|requestBody)/s);
      expect(content).not.toMatch(/console\.[a-z]+\([^;]*fromString/s);
      expect(content).not.toMatch(/console\.[a-z]+\([^;]*raw value/s);
    }
  });

  test('transition logs use proper messages, not literal LOG_EMOJI placeholders', () => {
    const content = fs.readFileSync(path.join(ROOT, 'src/services/sync/transition-sync.js'), 'utf8');
    expect(content).not.toContain("'${LOG_EMOJI.STATUS}");
    expect(content).toContain('Checking remote status transition');
    expect(content).toContain('Checking local status transition');
  });

  test('committed runtime log files are removed and ignored', () => {
    expect(fs.existsSync(path.join(ROOT, 'logs.txt'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'logs20.txt'))).toBe(false);
    const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toContain('logs*.txt');
    expect(gitignore).toContain('*.log');
  });

describe('Batch 5 response-body containment', () => {
  const body = '{"summary":"Private summary","description":"Private description","email":"private@example.test","token":"secret-token"}';

  test('safe HTTP failures preserve status without response-body text', () => {
    expect(formatHttpFailure(400)).toBe('validation_failed (HTTP 400)');
    expect(formatHttpFailure(403)).toBe('forbidden (HTTP 403)');
    expect(formatHttpFailure(429)).toBe('rate_limited (HTTP 429)');
    expect(formatHttpFailure(503)).toBe('temporary_failure (HTTP 503)');
    expect(formatHttpFailure(undefined)).toBe('remote_write_failed');
  });

  test('SyncResult cannot retain Jira response bodies', () => {
    const result = new SyncResult('update');
    result.addError(body);
    result.addLinkFailure('LOCAL-1', body);
    result.addTransitionFailure('Status', body);
    result.addAttachmentFailure('private-file.pdf', body);
    const serialized = JSON.stringify([result.errors, result.warnings, result.details]);
    expect(serialized).not.toContain('Private summary');
    expect(serialized).not.toContain('Private description');
    expect(serialized).not.toContain('private@example.test');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('private-file.pdf');
    expect(result.errors[0]).toBe('operation_failed');
    expect(serialized).toContain('operation_failed');
  });

  test('scheduled and webhook stats resolvers sanitize legacy response-body errors', async () => {
    mockStore.set('scheduledSyncStats', {
      lastRun: null,
      issuesChecked: 0,
      issuesCreated: 0,
      issuesUpdated: 0,
      issuesSkipped: 0,
      errors: [body],
      events: []
    });
    mockStore.set('webhookSyncStats', {
      totalSyncs: 1,
      issuesCreated: 0,
      issuesUpdated: 1,
      commentsSynced: 0,
      issuesSkipped: 0,
      loopsPrevented: 0,
      errors: [{ error: body, orgId: 'org-1', issueKey: 'LOCAL-1', operation: 'update' }],
      lastSync: null,
      byOrg: {}
    });
    const resolvers = defineResolvers(defineStatsResolvers);
    const scheduled = await resolvers.getScheduledSyncStats();
    const webhook = await resolvers.getWebhookSyncStats();
    const serialized = JSON.stringify([scheduled, webhook]);
    expect(serialized).not.toContain('Private summary');
    expect(serialized).not.toContain('Private description');
    expect(serialized).not.toContain('private@example.test');
    expect(serialized).not.toContain('secret-token');
    expect(webhook.errors[0].error).toBe('operation_failed');
    expect(scheduled.errors[0]).toBe('operation_failed');
  });
});

});
