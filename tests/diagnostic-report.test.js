import {
  buildDiagnosticReport,
  DIAGNOSTIC_REPORT_SCHEMA,
  DIAGNOSTIC_SAMPLE_LIMIT,
  DIAGNOSTIC_HISTORY_LIMIT,
  DiagnosticReportError
} from '../src/services/diagnostics/diagnostic-report.js';
import { RESOLVER_POLICIES } from '../src/resolvers/authorization-policy.js';
import { defineDiagnosticsResolvers } from '../src/resolvers/diagnostics.js';

const NOW = Date.parse('2026-10-27T12:00:00.000Z');

function queryRows(store, prefix, limit = 1000) {
  return Array.from(store.entries())
    .filter(([key]) => key.startsWith(prefix))
    .slice(0, limit)
    .map(([key, value]) => ({ key, value }));
}

function fakeDeps(overrides = {}) {
  const store = new Map(Object.entries(overrides.store || {}));
  const secrets = new Map(Object.entries(overrides.secrets || {}));
  return {
    getStored: async key => store.get(key) ?? null,
    getSecret: async key => secrets.get(key) ?? null,
    queryPageByPrefix: undefined,
    queryByPrefix: async (prefix, limit) => queryRows(store, prefix, limit),
    getAppContext: () => ({
      appVersion: '2.2.1',
      environmentType: 'production',
      appAri: { appId: '11111111-1111-4111-8111-111111111111' },
      environmentAri: { environmentId: 'env-secret-id' },
      installationAri: { installationId: 'installation-secret-id' },
      installation: { contexts: [{ cloudId: 'cloud-secret-id' }] }
    }),
    getPilotPause: async () => ({ paused: true, pausedAt: '2026-10-27T10:00:00.000Z', reasonCode: 'MAINTENANCE', pausedBy: 'private-account-id' }),
    readSyncAuthorizationStatus: async () => ({
      authorized: false,
      state: 'blocked',
      reason: 'SYNC_AUTHORIZATION_MISSING',
      configuredOrganizationIds: ['org-1'],
      uncoveredOrganizationIds: ['org-1'],
      organizationSetDelta: { added: ['org-1'], removed: [] }
    }),
    listReconciliationAttention: async () => ([
      { localKey: 'ACME-1', remoteKey: 'ACME-9', state: 'open', reasonCode: 'RECONCILE_FAILED', attempts: 3, acknowledgedAt: null },
      { localKey: 'ACME-2', remoteKey: null, state: 'resolved', reasonCode: 'RESOLVED', attempts: 1 }
    ]),
    now: () => NOW,
    ...overrides.deps
  };
}

function populated(overrides = {}) {
  const store = {
    organizations: [
      {
        id: 'org-1', name: 'Acme Support', remoteUrl: 'https://acme.atlassian.net/path?token=secret',
        remoteEmail: 'private@example.invalid', remoteApiToken: 'super-secret-token',
        remoteProjectKey: 'ACME', allowedProjects: ['ACME', 'OPS'],
        jqlFilter: 'project = ACME AND assignee = "private@example.invalid"',
        syncDirection: 'bidirectional', createdAt: '2026-01-01T00:00:00.000Z'
      },
      { id: 'org-2', name: 'Other Tenant', remoteUrl: 'https://other.atlassian.net', allowedProjects: ['OTHER'] }
    ],
    'syncOptions:org-1': { syncComments: true, syncLinks: false, syncSprints: false, rawSecret: 'ignore-me' },
    'scheduledSyncConfig': { enabled: true, intervalMinutes: 60, syncScope: 'recent', lastRun: '2026-10-27T11:00:00.000Z', secret: 'ignore-me' },
    'projectMappings:org-1': { ACME: 'ACME', OPS: 'OPS' },
    'fieldMappings:org-1': { summary: { remote: 'summary', email: 'private@example.invalid' } },
    'userMappings:org-1': { 'account-secret': 'private@example.invalid' },
    'statusMappings:org-1': { Todo: 'To Do' },
    'issueTypeMappings:org-1': { Bug: 'Bug' },
    'org-1:local-to-remote:ACME-1': 'ACME-9',
    'org-1:remote-to-local:ACME-9': 'ACME-1',
    'org-1:local-to-remote:ACME-2': 'ACME-10',
    'org-1:remote-to-local:ACME-10': 'ACME-2',
    'org-2:local-to-remote:OTHER-1': 'OTHER-9',
    'mapping-meta:org-1:ACME-1': { localKey: 'ACME-1', remoteKey: 'ACME-9' },
    'mapping-repair:org-1:ACME-1:ACME-9': { localKey: 'ACME-1', remoteKey: 'ACME-9', reason: 'partial' },
    'issue-create-op:org-1:local-to-remote:ACME-1': {
      state: 'succeeded', direction: 'local-to-remote', sourceKey: 'ACME-1', targetKey: 'ACME-9',
      updatedAt: '2026-10-27T09:00:00.000Z', description: 'private description'
    },
    'issue-create-op:org-1:remote-to-local:ACME-10': {
      state: 'unknown', direction: 'remote-to-local', sourceKey: 'ACME-10', targetKey: 'ACME-2',
      updatedAt: '2026-10-27T09:30:00.000Z'
    },
    'issue-create-op:org-2:local-to-remote:OTHER-1': { state: 'succeeded', direction: 'local-to-remote' },
    'webhookSyncStats': {
      byOrg: {
        'org-1': { totalSyncs: 5, issuesCreated: 1, issuesUpdated: 2, commentsSynced: 3, issuesSkipped: 1, loopsPrevented: 0, lastSync: '2026-10-27T11:30:00.000Z', lastSuccessfulJiraWrite: '2026-10-27T11:29:00.000Z' },
        'org-2': { totalSyncs: 99 }
      },
      errors: Array.from({ length: 15 }, (_, index) => ({
        timestamp: '2026-10-27T11:00:00.000Z', orgId: 'org-1', issueKey: `ACME-${index + 1}`,
        operation: 'update', error: 'private@example.invalid token=super-secret-token',
        details: { statusCode: 429, reason: 'RATE_LIMITED', email: 'private@example.invalid' }
      })).concat([{ orgId: 'org-2', issueKey: 'OTHER-1', error: 'other tenant' }])
    },
    'scheduledSyncStats': {
      lastRun: '2026-10-27T11:45:00.000Z', issuesChecked: 20, issuesCreated: 2, issuesUpdated: 3,
      issuesAlreadyCurrent: 10, issuesSkipped: 4, issuesFailed: 1,
      errors: ['ACME-1: private description', 'ACME-2: token=super-secret-token'],
      events: [{ issueKey: 'ACME-1', orgName: 'Acme Support', message: 'private' }]
    },
    'apiUsageStats': {
      totalCalls: 100, successfulCalls: 95, failedCalls: 5, rateLimitHits: 2,
      lastRateLimitHit: '2026-10-27T10:30:00.000Z', callsThisHour: 20, callsThisMinute: 2,
      byOrg: { 'org-1': { calls: 30, rateLimits: 2 }, 'org-2': { calls: 70 } },
      byEndpoint: { issues: { calls: 60, rateLimits: 1 }, comments: { calls: 40, rateLimits: 1 }, unexpected: { calls: 1 } },
      history: Array.from({ length: 10 }, (_, index) => ({ hour: `2026-10-27T0${index}`, calls: index, rateLimits: 0 })),
      successRate: 99, estimatedRemainingQuota: 999999, quotaUsagePercent: 99, private: 'ignore-me'
    },
    'pairWitnessPlan:org-1': {
      version: 1, status: 'needs-attention', expiresAt: NOW + 60000, batches: 2,
      items: [
        { localKey: 'ACME-1', remoteKey: 'ACME-9', pairId: 'pair-secret', state: 'pending', attempts: 1 },
        { localKey: 'ACME-2', remoteKey: 'ACME-10', pairId: 'pair-secret-2', state: 'verified', attempts: 1 }
      ],
      selection: { issueKeys: ['ACME-1'] }, approvedBy: 'account-secret'
    },
    'auditLog': Array.from({ length: 15 }, () => ({
      timestamp: '2026-10-27T10:00:00.000Z', orgId: 'org-1', action: 'pair_witness_property_write',
      outcome: 'succeeded', source: 'test', site: 'acme.atlassian.net', statusCode: 200,
      success: true, issueId: 'account-secret', pairId: 'pair-secret', permitId: 'permit-secret'
    })).concat([{ orgId: 'org-1', action: 'create', success: true, issueKey: 'ACME-1' }])
  };
  return fakeDeps({
    store,
    secrets: { 'secret:org-1:token': 'super-secret-token', 'secret:org-1:webhookSigningSecret': 'secret-signing' },
    ...overrides
  });
}


describe('diagnostic report', () => {
  test('is schema-versioned, organization-scoped and explicitly allowlisted', async () => {
    const report = await buildDiagnosticReport({ orgId: 'org-1', deps: populated() });
    expect(report.schema).toBe(DIAGNOSTIC_REPORT_SCHEMA);
    expect(report.schemaVersion).toBe(1);
    expect(report.generatedAt).toBe('2026-10-27T12:00:00.000Z');
    expect(report.scope).toEqual({
      selection: 'explicit-organization', organizationId: 'org-1',
      organizationName: 'Acme Support'
    });
    expect(report.evidence.organization).toMatchObject({
      syncDirection: 'bidirectional', remoteHost: 'acme.atlassian.net',
      remoteProjectKey: 'ACME', allowedProjectCount: 2,
      credentialConfigured: true, webhookConfigured: true,
      mappingConfiguration: { projectMappings: 2, userMappings: 1, fieldMappings: 1 }
    });
    expect(report.evidence.organization.jql).toMatchObject({ configured: true });
    expect(report.evidence.organization.jql.digest).toMatch(/^sha256:/);
    expect(report.evidence.mappings).toMatchObject({
      localToRemoteCount: 2, remoteToLocalCount: 2, metadataCount: 1,
      repairCount: 1, truncated: false
    });
    expect(report.evidence.issueCreateLedger).toMatchObject({
      total: 2, states: { succeeded: 1, unknown: 1 }
    });
    expect(report.evidence.safety.pause).toMatchObject({ paused: true, reasonCode: 'MAINTENANCE' });
    expect(report.evidence.safety.syncAuthorization).toMatchObject({
      authorized: false, reason: 'SYNC_AUTHORIZATION_MISSING'
    });
    expect(report.evidence.recoveryAttention).toMatchObject({
      total: 2, open: 1, resolved: 1, reasonCounts: { RECONCILE_FAILED: 1, RESOLVED: 1 }
    });
    expect(report.evidence.pairingWitness).toMatchObject({
      planPresent: true, status: 'needs-attention', pairCount: 2,
      states: { pending: 1, verified: 1 }, remaining: 1
    });
    expect(report.statusCodes).toEqual(expect.arrayContaining([
      'PAUSE_ACTIVE', 'SYNC_AUTHORIZATION_MISSING', 'MAPPING_REPAIR_RECORDS_PRESENT',
      'ISSUE_CREATE_ATTENTION_REQUIRED', 'RECONCILIATION_ATTENTION_OPEN'
    ]));
    expect(report.diagnosticStatus).not.toBe('ok');
  });

  test('excludes secrets, contact data, issue records and raw Jira content', async () => {
    const report = await buildDiagnosticReport({ orgId: 'org-1', deps: populated() });
    const serialized = JSON.stringify(report);
    for (const forbidden of [
      'super-secret-token', 'secret-signing', 'private@example.invalid',
      'private-account-id', 'ACME-1', 'ACME-9', 'OTHER-1', 'OTHER-9',
      'installation-secret-id', 'cloud-secret-id', 'env-secret-id',
      'private description', 'pair-secret', 'permit-secret', 'account-secret',
      'ignore-me', 'successRate', 'estimatedRemainingQuota', 'quotaUsagePercent'
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toContain('private description');
    expect(serialized).not.toContain('comment body');
    expect(serialized).not.toContain('emailAddress');
    expect(report.evidence.errors.samples.length).toBeLessThanOrEqual(DIAGNOSTIC_SAMPLE_LIMIT);
  });

  test('does not read another organization into the selected report', async () => {
    const report = await buildDiagnosticReport({ orgId: 'org-1', deps: populated() });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('Other Tenant');
    expect(serialized).not.toContain('OTHER');
    expect(report.scope.organizationId).toBe('org-1');
  });


  test('marks missing telemetry instead of inventing zeros or percentages', async () => {
    const deps = fakeDeps({ store: { organizations: [{ id: 'org-1', allowedProjects: ['ACME'] }] } });
    const report = await buildDiagnosticReport({ orgId: 'org-1', deps });
    expect(report.evidence.synchronizationActivity.webhook).toMatchObject({
      available: false, code: 'DIAGNOSTIC_TELEMETRY_NOT_RECORDED'
    });
    expect(report.evidence.rateLimits).toMatchObject({ available: false });
    expect(report.evidence.pairingWitness).toMatchObject({ available: true, planPresent: false });
    expect(report.evidence.errors).toBeDefined();
    expect(report.evidence.organization.jql).toEqual({ configured: false, length: 0, digest: null });
    expect(JSON.stringify(report)).not.toContain('successRate');
    expect(JSON.stringify(report)).not.toContain('remainingQuota');
  });

  test('bounds retained samples and report size', async () => {
    const report = await buildDiagnosticReport({ orgId: 'org-1', deps: populated() });
    expect(report.evidence.errors.samples.length).toBeLessThanOrEqual(DIAGNOSTIC_SAMPLE_LIMIT);
    expect(report.evidence.rateLimits.history.length).toBeLessThanOrEqual(DIAGNOSTIC_HISTORY_LIMIT);
    expect(report.evidence.maintenanceAudit.samples.length).toBeLessThanOrEqual(DIAGNOSTIC_SAMPLE_LIMIT);
    expect(Buffer.byteLength(JSON.stringify(report), 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(report.bounds).toMatchObject({ errorSamples: 10, historySamples: 6, maxBytes: 64 * 1024 });
  });

  test('is read-only and rejects missing or invalid organization selection', async () => {
    const writes = [];
    const deps = populated({
      deps: {
        set: async (...args) => { writes.push(args); },
        del: async (...args) => { writes.push(args); }
      }
    });
    await buildDiagnosticReport({ orgId: 'org-1', deps });
    expect(writes).toEqual([]);
    await expect(buildDiagnosticReport({ deps })).rejects.toMatchObject({
      name: 'DiagnosticReportError', code: 'DIAGNOSTIC_ORGANIZATION_REQUIRED'
    });
    await expect(buildDiagnosticReport({ orgId: 'org-2/other', deps })).rejects.toBeInstanceOf(DiagnosticReportError);
    await expect(buildDiagnosticReport({ orgId: 'org-9', deps })).rejects.toMatchObject({
      code: 'DIAGNOSTIC_ORGANIZATION_NOT_FOUND'
    });
  });

  test('is explicitly registered as an administrator read', () => {
    expect(RESOLVER_POLICIES.exportDiagnosticReport).toBe('ADMIN_READ');
  });

  test('resolver returns a stable error before reading anything when no organization is supplied', async () => {
    const definitions = {};
    defineDiagnosticsResolvers({ define: (name, fn) => { definitions[name] = fn; } });
    await expect(definitions.exportDiagnosticReport({ payload: {} })).resolves.toMatchObject({
      success: false, code: 'DIAGNOSTIC_ORGANIZATION_REQUIRED'
    });
  });
});

