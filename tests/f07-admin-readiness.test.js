/**
 * Targeted regression coverage for the read-only connector readiness resolver
 * and the F07 migration-state evaluator.
 *
 * Every dependency is injectable, so the tests exercise production code without
 * Forge, Jira or a live installation. No request leaves the process.
 */
const {
  READINESS_SOURCE,
  buildConnectorReadiness
} = require('../src/services/readiness/connector-readiness');
const {
  LEGACY_LEASE_DRAIN_MS,
  evaluateIssueLeaseMigrationState
} = require('../src/services/sync/lease-migration');

const APP_ARI = 'ari:cloud:ecosystem::app/362d8e6b-b68c-4403-8020-d32ddcc02716';
const APP_UUID = '362d8e6b-b68c-4403-8020-d32ddcc02716';
const ENVIRONMENT_ID = 'c2d7a8e4-2f1b-4a6e-9d3d-0f7e7a0b1234';
const INSTALLATION_ID = '974910c5-2861-4d40-a7eb-37802842d0a0';
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const ISO = new Date(NOW - 60000).toISOString();
const FAKE_SIGNING_SECRET = 'fake-signing-secret-value';
const FAKE_API_TOKEN = 'fake-api-token-value';

function activeState(overrides = {}) {
  return {
    version: 1,
    phase: 'entity-active',
    legacyDisabled: true,
    disabledAt: NOW - 5_000_000,
    activatedAt: NOW - 1_000_000,
    ...overrides
  };
}

function identity(overrides = {}) {
  return {
    // Shape returned by @forge/api getAppContext(): AppAri exposes the app UUID
    // in `appId`, while toString()/toJSON() describe the complete ARI.
    appAri: {
      appId: APP_UUID,
      toString: () => APP_ARI,
      toJSON: () => APP_ARI
    },
    appVersion: '3.0.0',
    environmentAri: { environmentId: ENVIRONMENT_ID },
    environmentType: 'staging',
    installationAri: { installationId: INSTALLATION_ID },
    installation: { contexts: [{ cloudId: 'cloud-1' }] },
    ...overrides
  };
}

function baseStore(overrides = {}) {
  return {
    organizations: [
      {
        id: 'org-1',
        remoteProjectKey: 'RSTG',
        allowedProjects: ['STG'],
        syncDirection: 'bidirectional',
        remoteApiToken: FAKE_API_TOKEN
      }
    ],
    'projectMappings:org-1': { STG: 'RSTG' },
    'syncOptions:org-1': { syncComments: true },
    'webhookSigningSecretMeta:org-1': { rotatedAt: ISO },
    ...overrides
  };
}

function readinessDeps(overrides = {}) {
  const store = overrides.store || baseStore();
  return {
    getAppContext: overrides.getAppContext || (() => identity(overrides.identity)),
    requestJira: overrides.requestJira
      || (async () => ({ ok: true, json: async () => ({ baseUrl: 'https://localstaging.atlassian.net' }) })),
    getPilotPause: overrides.getPilotPause || (async () => ({ paused: false })),
    readIssueLeaseMigrationState: overrides.readIssueLeaseMigrationState
      || (async () => ({
        readable: true,
        present: true,
        valid: true,
        active: true,
        phase: 'entity-active',
        state: activeState(),
        reasons: []
      })),
    getStored: async (key) => (key in store ? store[key] : null),
    getSecret: overrides.getSecret || (async () => FAKE_SIGNING_SECRET),
    getAuthenticatedWebhookReceipt: overrides.getAuthenticatedWebhookReceipt
      || (async () => ({ event: 'jira:issue_updated', receivedAt: ISO })),
    now: () => NOW
  };
}

function collectKeys(value, keys = []) {
  if (!value || typeof value !== 'object') return keys;
  Object.entries(value).forEach(([key, entry]) => {
    keys.push(key);
    collectKeys(entry, keys);
  });
  return keys;
}

describe('F07 migration state evaluation', () => {
  it('accepts exactly the documented active state with a complete drain window', () => {
    const result = evaluateIssueLeaseMigrationState(activeState(), NOW);
    expect(result).toMatchObject({ present: true, valid: true, active: true, phase: 'entity-active' });
    expect(result.reasons).toEqual([]);
  });

  it('reports a missing control record as absent and inactive', () => {
    const result = evaluateIssueLeaseMigrationState(null, NOW);
    expect(result).toMatchObject({ present: false, valid: false, active: false, state: null });
    expect(result.reasons).toEqual(['migration-missing']);
  });

  it('treats a malformed record as invalid instead of guessing its intent', () => {
    expect(evaluateIssueLeaseMigrationState('entity-active', NOW)).toMatchObject({
      present: true,
      valid: false,
      state: null
    });
    expect(evaluateIssueLeaseMigrationState({ version: 2, phase: 'entity-active' }, NOW).reasons)
      .toContain('migration-version-unsupported');
  });

  it('rejects an incomplete drain window, future activation and unretired legacy writers', () => {
    const incomplete = evaluateIssueLeaseMigrationState(activeState({
      activatedAt: NOW - 5_000_000 + LEGACY_LEASE_DRAIN_MS - 1
    }), NOW);
    expect(incomplete.valid).toBe(false);
    expect(incomplete.reasons).toContain('migration-drain-incomplete');

    const future = evaluateIssueLeaseMigrationState(activeState({
      disabledAt: NOW - LEGACY_LEASE_DRAIN_MS,
      activatedAt: NOW + 1000
    }), NOW);
    expect(future.valid).toBe(false);
    expect(future.reasons).toContain('migration-activated-in-future');

    const unretired = evaluateIssueLeaseMigrationState(activeState({ legacyDisabled: false }), NOW);
    expect(unretired.valid).toBe(false);
    expect(unretired.reasons).toContain('migration-legacy-writers-not-retired');
  });

  it('never returns undocumented stored fields', () => {
    const result = evaluateIssueLeaseMigrationState(
      activeState({ leaseToken: 'should-not-leak', secret: 'should-not-leak' }),
      NOW
    );
    expect(result.valid).toBe(true);
    expect(Object.keys(result.state).sort()).toEqual([
      'activatedAt',
      'disabledAt',
      'legacyDisabled',
      'phase',
      'version'
    ]);
  });

describe('connector readiness', () => {
  it('returns installation-bound, unpaused readiness with mapping, comments and webhook receipts', async () => {
    const readiness = await buildConnectorReadiness({ deps: readinessDeps() });

    expect(readiness.success).toBe(true);
    expect(readiness.source).toBe(READINESS_SOURCE);
    expect(readiness.status).toBe('verified');
    expect(readiness.capturedAt).toBe(new Date(NOW).toISOString());
    expect(readiness).toMatchObject({
      appId: APP_UUID,
      appAri: APP_ARI,
      appVersion: '3.0.0',
      environment: 'staging',
      environmentId: ENVIRONMENT_ID,
      installationId: INSTALLATION_ID,
      installedSites: ['localstaging.atlassian.net'],
      paused: false,
      f07: activeState(),
      f07Status: { valid: true, active: true, phase: 'entity-active' }
    });
    expect(readiness.mappings).toEqual([{
      orgId: 'org-1',
      syncDirection: 'bidirectional',
      syncComments: true,
      localProjectKey: 'STG',
      remoteProjectKey: 'RSTG'
    }]);
    expect(readiness.webhook).toMatchObject({ configured: true, lastReceiptAt: ISO });
  });

  it('fails closed when Forge identity is unavailable', async () => {
    const readiness = await buildConnectorReadiness({
      deps: readinessDeps({ getAppContext: () => { throw new Error('no runtime'); } })
    });
    expect(readiness.success).toBe(false);
    expect(readiness.code).toBe('READINESS_IDENTITY_UNAVAILABLE');
  });

  it('blocks readiness when installation identity is incomplete', async () => {
    const readiness = await buildConnectorReadiness({
      deps: readinessDeps({ identity: { installationAri: undefined } })
    });
    expect(readiness.success).toBe(true);
    expect(readiness.status).toBe('blocked');
    expect(readiness.installationId).toBeNull();
    expect(readiness.checks).toContainEqual(expect.objectContaining({
      id: 'identity-binding',
      status: 'block'
    }));
  });

  it('blocks readiness when the local Jira site cannot be resolved', async () => {
    const readiness = await buildConnectorReadiness({
      deps: readinessDeps({ requestJira: async () => ({ ok: false, status: 502 }) })
    });
    expect(readiness.installedSites).toEqual([]);
    expect(readiness.status).toBe('blocked');
    expect(readiness.checks).toContainEqual(expect.objectContaining({
      id: 'site-installation',
      status: 'block'
    }));
  });

  it('reports Pause without exposing any write authorization', async () => {
    const readiness = await buildConnectorReadiness({
      deps: readinessDeps({
        getPilotPause: async () => ({ paused: true, pausedAt: ISO, reasonCode: 'CHANGE_FREEZE' })
      })
    });
    expect(readiness.paused).toBe(true);
    expect(readiness.pause).toMatchObject({ paused: true, reasonCode: 'CHANGE_FREEZE' });
    expect(readiness.status).toBe('blocked');
    expect(readiness.checks).toContainEqual(expect.objectContaining({ id: 'pause-state', status: 'block' }));
  });

  it('keeps an unreadable pause state unknown instead of treating it as active', async () => {
    const readiness = await buildConnectorReadiness({
      deps: readinessDeps({ getPilotPause: async () => { throw new Error('storage down'); } })
    });
    expect(readiness.paused).toBeNull();
    expect(readiness.pause.readable).toBe(false);
    expect(readiness.status).not.toBe('verified');
    expect(readiness.checks).toContainEqual(expect.objectContaining({ id: 'pause-state', status: 'unknown' }));
  });
});


describe('connector readiness fail-closed paths', () => {
  it('reports missing and incomplete F07 migration state without inventing a pass', async () => {
    const missing = await buildConnectorReadiness({
      deps: readinessDeps({
        readIssueLeaseMigrationState: async () => ({
          readable: true,
          present: false,
          valid: false,
          active: false,
          phase: null,
          state: null,
          reasons: ['migration-missing']
        })
      })
    });
    expect(missing.f07).toBeNull();
    expect(missing.f07Status).toMatchObject({ valid: false, active: false, reasons: ['migration-missing'] });
    expect(missing.status).toBe('unknown');

    const unreadable = await buildConnectorReadiness({
      deps: readinessDeps({ readIssueLeaseMigrationState: async () => { throw new Error('storage down'); } })
    });
    expect(unreadable.f07Status.reasons).toEqual(['migration-unreadable']);
    expect(unreadable.status).not.toBe('verified');
  });

  it('fails closed when installation configuration storage is unavailable', async () => {
    const deps = readinessDeps();
    deps.getStored = async () => { throw new Error('storage down'); };
    const readiness = await buildConnectorReadiness({ deps });
    expect(readiness.success).toBe(false);
    expect(readiness.code).toBe('READINESS_STORAGE_UNAVAILABLE');
    expect(readiness.mappings).toBeUndefined();
  });

  it('requires a signed webhook for bidirectional organizations and uses the oldest receipt', async () => {
    const store = baseStore({
      organizations: [
        { id: 'org-1', remoteProjectKey: 'RSTG', allowedProjects: ['STG'], syncDirection: 'bidirectional' },
        { id: 'org-2', remoteProjectKey: 'R2', allowedProjects: ['L2'], syncDirection: 'bidirectional' }
      ],
      'projectMappings:org-2': { L2: 'R2' },
      'syncOptions:org-2': { syncComments: false }
    });
    const receipts = {
      'org-1': { receivedAt: new Date(NOW - 1000).toISOString(), event: 'a' },
      'org-2': { receivedAt: new Date(NOW - 900000).toISOString(), event: 'b' }
    };
    const readiness = await buildConnectorReadiness({
      deps: readinessDeps({
        store,
        getSecret: async (key) => (key.includes('org-2') ? null : FAKE_SIGNING_SECRET),
        getAuthenticatedWebhookReceipt: async (orgId) => receipts[orgId] || null
      })
    });

    expect(readiness.webhook.configured).toBe(false);
    expect(readiness.webhook.lastReceiptAt).toBeNull();
    expect(readiness.checks).toContainEqual(expect.objectContaining({ id: 'webhook', status: 'block' }));

    const configured = await buildConnectorReadiness({
      deps: readinessDeps({
        store,
        getAuthenticatedWebhookReceipt: async (orgId) => receipts[orgId] || null
      })
    });
    expect(configured.webhook.configured).toBe(true);
    expect(configured.webhook.lastReceiptAt).toBe(new Date(NOW - 900000).toISOString());
  });

  it('does not certify a webhook receipt that predates the signing-key rotation', async () => {
    const rotatedAfterReceipt = new Date(NOW - 1000).toISOString();
    const readiness = await buildConnectorReadiness({
      deps: readinessDeps({
        store: baseStore({
          'webhookSigningSecretMeta:org-1': { rotatedAt: rotatedAfterReceipt }
        }),
        getAuthenticatedWebhookReceipt: async () => ({
          event: 'jira:issue_updated',
          receivedAt: ISO
        })
      })
    });

    expect(readiness.success).toBe(true);
    expect(readiness.status).toBe('blocked');
    expect(readiness.webhook).toMatchObject({
      configured: true,
      lastReceiptAt: ISO,
      lastRotatedAt: rotatedAfterReceipt,
      receiptsAfterLatestRotation: false
    });
    expect(readiness.checks).toContainEqual(expect.objectContaining({ id: 'webhook', status: 'block' }));
  });

  it('fails closed when signing-key rotation metadata is malformed', async () => {
    const readiness = await buildConnectorReadiness({
      deps: readinessDeps({
        store: baseStore({
          'webhookSigningSecretMeta:org-1': { rotatedAt: 'not-a-timestamp' }
        })
      })
    });

    expect(readiness.success).toBe(true);
    expect(readiness.status).toBe('blocked');
    expect(readiness.webhook).toMatchObject({
      configured: true,
      lastRotatedAt: null,
      rotationMetadataValid: false
    });
    expect(readiness.checks).toContainEqual(expect.objectContaining({ id: 'webhook', status: 'block' }));
  });

  it('fails closed when stored comment-sync configuration is malformed', async () => {
    const invalid = await buildConnectorReadiness({
      deps: readinessDeps({
        store: baseStore({ 'syncOptions:org-1': { syncComments: 'invalid' } })
      })
    });
    expect(invalid.success).toBe(false);
    expect(invalid.status).toBe('unavailable');
    expect(invalid.code).toBe('READINESS_CONFIGURATION_INVALID');
    expect(invalid.mappings).toBeUndefined();
    expect(invalid.organizations).toBeUndefined();

    const nonObject = await buildConnectorReadiness({
      deps: readinessDeps({
        store: baseStore({ 'syncOptions:org-1': 'enabled' })
      })
    });
    expect(nonObject.success).toBe(false);
    expect(nonObject.code).toBe('READINESS_CONFIGURATION_INVALID');
  });

  it('keeps the documented comment-sync default for an absent preference', async () => {
    const store = baseStore();
    delete store['syncOptions:org-1'];
    const readiness = await buildConnectorReadiness({ deps: readinessDeps({ store }) });

    expect(readiness.success).toBe(true);
    expect(readiness.status).toBe('verified');
    expect(readiness.mappings).toEqual([
      expect.objectContaining({ orgId: 'org-1', syncComments: true })
    ]);
    expect(readiness.checks).toContainEqual(expect.objectContaining({ id: 'feature-flags', status: 'pass' }));
  });

  it('does not require a signed webhook for a push-only organization', async () => {
    const readiness = await buildConnectorReadiness({
      deps: readinessDeps({
        store: baseStore({
          organizations: [
            { id: 'org-1', remoteProjectKey: 'RSTG', allowedProjects: ['STG'], syncDirection: 'push' }
          ]
        }),
        getSecret: async () => null
      })
    });
    expect(readiness.webhook).toMatchObject({ requiredForAnyOrganization: false });
    expect(readiness.checks).toContainEqual(expect.objectContaining({ id: 'webhook', status: 'pass' }));
  });

  it('never returns tokens, signing secrets or credential-shaped fields', async () => {
    const readiness = await buildConnectorReadiness({ deps: readinessDeps() });
    const serialized = JSON.stringify(readiness);
    expect(serialized).not.toContain(FAKE_SIGNING_SECRET);
    expect(serialized).not.toContain(FAKE_API_TOKEN);
    expect(collectKeys(readiness).filter((key) => /secret|token|authorization|credential/i.test(key)))
      .toEqual([]);
  });
});

});
