/** @jest-environment node */
'use strict';

/** Offline negative controls: caller-created pages, facts and files never gain
 * authentication. The real acquisition path is covered separately with the
 * browser transport mocked at its dependency boundary.
 */
jest.mock('../scripts/staging/lib/forge-admin-browser-adapter', () => ({
  ...jest.requireActual('../scripts/staging/lib/forge-admin-browser-adapter'),
  readInstalledStagingReadiness: jest.fn(async () => {
    throw Object.assign(new Error('No browser in offline tests'), { code: 'AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE' });
  }),
}));
const fs = require('fs');
const path = require('path');

const {
  EVIDENCE_KIND,
  EVIDENCE_SCHEMA_VERSION,
  EXPECTED_APP_ID,
  validateReadiness,
} = require('../scripts/staging/lib/e2e-evidence');
const channel = require('../scripts/staging/lib/forge-admin-readiness');

const {
  AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE,
  READINESS_RESOLVER,
  bindReadinessResponse,
  normalizeReadinessResponse,
  readForgeAdminReadiness,
} = channel;

const LIB_DIR = path.join(__dirname, '..', 'scripts', 'staging', 'lib');
const APP_ARI = EXPECTED_APP_ID;
const APP_ID = APP_ARI.slice('ari:cloud:ecosystem::app/'.length);
const OTHER_APP_ARI = 'ari:cloud:ecosystem::app/11111111-2222-4333-8444-555555555555';
const INSTALLATION_ID = '974910c5-2861-4d40-a7eb-37802842d0a0';
const OTHER_INSTALLATION_ID = '35d70d16-0a94-4f5f-9a7d-4e6b7f7f1c11';
const ENVIRONMENT_ID = 'c2d7a8e4-2f1b-4a6e-9d3d-0f7e7a0b1234';
const OTHER_ENVIRONMENT_ID = 'e7b1c9f0-6a2d-4c8e-8b3f-5d4e3c2b1a09';

const LOCAL_HOST = 'localstaging.atlassian.net';
const REMOTE_HOST = 'remotestaging.atlassian.net';
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const RECENT = new Date(NOW - 30000).toISOString();
const ROTATED_AFTER_RECEIPT = new Date(NOW - 10000).toISOString();

const CONFIG = {
  local: { host: LOCAL_HOST, stagingProjects: ['STG'] },
  remote: { host: REMOTE_HOST, stagingProjects: ['RSTG'] },
};
const SETTINGS = {
  environment: 'staging',
  evidenceMaxAgeMs: 15 * 60 * 1000,
  selectors: {},
  forgeInstallationId: INSTALLATION_ID,
  forgeEnvironmentId: ENVIRONMENT_ID,
};

function connectorResponse(overrides = {}) {
  return {
    success: true,
    version: 1,
    source: 'authenticated-connector',
    capturedAt: RECENT,
    appAri: APP_ARI,
    appId: APP_ID,
    appVersion: '3.0.0',
    environment: 'staging',
    environmentId: ENVIRONMENT_ID,
    installationId: INSTALLATION_ID,
    installedSites: [LOCAL_HOST],
    paused: false,
    f07: {
      version: 1,
      phase: 'entity-active',
      legacyDisabled: true,
      disabledAt: NOW - 5_000_000,
      activatedAt: NOW - 1_000_000,
    },
    mappings: [
      {
        orgId: 'org-staging',
        syncDirection: 'bidirectional',
        syncComments: true,
        localProjectKey: 'STG',
        remoteProjectKey: 'RSTG',
      },
    ],
    webhook: {
      configured: true,
      lastReceiptAt: RECENT,
      lastRotatedAt: RECENT,
      receiptsAfterLatestRotation: true,
    },
    ...overrides,
  };
}

function evidenceDocument(overrides = {}) {
  return {
    kind: EVIDENCE_KIND,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    generatedAt: RECENT,
    source: 'operator-export',
    capturedBy: 'operator',
    connector: {
      appId: APP_ARI,
      installationStatus: 'installed',
      installedSites: [LOCAL_HOST, REMOTE_HOST],
      environment: 'staging',
    },
    pause: { paused: false },
    f07: {
      version: 1,
      phase: 'entity-active',
      legacyDisabled: true,
      disabledAt: NOW - 5_000_000,
      activatedAt: NOW - 1_000_000,
    },
    organizations: [
      {
        orgId: 'org-staging',
        syncDirection: 'push',
        features: { syncComments: false },
        projectMappings: [{ localProjectKey: 'STG', remoteProjectKey: 'RSTG' }],
      },
    ],
    webhook: {
      configured: false,
      lastReceipt: { receivedAt: RECENT },
    },
    ...overrides,
  };
}

function expected(overrides = {}) {
  return {
    appAri: APP_ARI,
    appId: APP_ID,
    environmentType: 'staging',
    siteHost: LOCAL_HOST,
    installationId: INSTALLATION_ID,
    environmentId: ENVIRONMENT_ID,
    ...overrides,
  };
}

function pageFor(raw = connectorResponse()) {
  return {
    url: () => `https://${LOCAL_HOST}/jira/apps/${APP_ID}/admin`,
    evaluate: jest.fn(async () => raw),
  };
}

function evaluate(readiness, options = {}) {
  return validateReadiness({
    document: null,
    settings: SETTINGS,
    config: CONFIG,
    now: () => NOW,
    readiness,
    ...options,
  });
}

function readLib(file) {
  return fs.readFileSync(path.join(LIB_DIR, file), 'utf8');
}

async function expectUnavailable(promise) {
  await expect(promise).rejects.toMatchObject({
    code: AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE,
  });
}


describe('readiness acquisition rejects caller inputs', () => {
  it('rejects a caller-created page object that returns matching facts', async () => {
    const page = pageFor();
    await expectUnavailable(
      readForgeAdminReadiness({ page, expected: expected(), now: () => NOW })
    );
    // The bypass is gone, not merely narrowed: the object is never invoked.
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('rejects a caller-created page on the wrong host the same way', async () => {
    const page = {
      url: () => `https://${REMOTE_HOST}/jira/apps/${APP_ID}/admin`,
      evaluate: jest.fn(async () => connectorResponse()),
    };
    await expectUnavailable(readForgeAdminReadiness({ page, expected: expected() }));
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('rejects a bare evaluate callback', async () => {
    const evaluateCallback = jest.fn(async () => connectorResponse());
    await expectUnavailable(
      readForgeAdminReadiness({ page: { evaluate: evaluateCallback }, expected: expected() })
    );
    expect(evaluateCallback).not.toHaveBeenCalled();
  });

  it('rejects a bare invoke callback and a nested page shim', async () => {
    const invoke = jest.fn(async () => connectorResponse());
    await expectUnavailable(readForgeAdminReadiness({ invoke, expected: expected() }));
    await expectUnavailable(
      readForgeAdminReadiness({ page: { page: pageFor() }, expected: expected() })
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects forged facts, a source claim and a pasted observation shape', async () => {
    const forgedFacts = connectorResponse();
    await expectUnavailable(
      readForgeAdminReadiness({ readiness: forgedFacts, expected: expected() })
    );
    await expectUnavailable(
      readForgeAdminReadiness({
        readiness: { ...forgedFacts, source: 'authenticated-connector' },
        expected: expected(),
      })
    );
    await expectUnavailable(
      readForgeAdminReadiness({
        facts: forgedFacts,
        invocation: { resolver: READINESS_RESOLVER, pageHost: LOCAL_HOST },
        expected: expected(),
      })
    );
  });

  it('fails closed when its internally owned browser is unavailable', async () => {
    await expectUnavailable(readForgeAdminReadiness());
    await expectUnavailable(readForgeAdminReadiness({}));
    await expectUnavailable(readForgeAdminReadiness({ expected: expected() }));
  });

  it('cannot be switched on through the environment', async () => {
    const keys = [
      'STAGING_E2E_ALLOW_UNVERIFIED_READINESS',
      'STAGING_E2E_READINESS_PAGE',
      'STAGING_E2E_READINESS_FACTS',
    ];
    const before = keys.map((key) => [key, process.env[key]]);
    process.env.STAGING_E2E_ALLOW_UNVERIFIED_READINESS = '1';
    process.env.STAGING_E2E_READINESS_PAGE = `https://${LOCAL_HOST}/jira/apps/${APP_ID}/admin`;
    process.env.STAGING_E2E_READINESS_FACTS = JSON.stringify(connectorResponse());
    try {
      await expectUnavailable(
        readForgeAdminReadiness({ page: pageFor(), expected: expected() })
      );
    } finally {
      before.forEach(([key, value]) => {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      });
    }
  });

  it('publishes no observation, sealing or page-invoking surface', () => {
    expect(Object.keys(channel).sort()).toEqual([
      'AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE',
      'READINESS_EXPRESSION',
      'READINESS_RESOLVER',
      'bindReadinessResponse',
      'isAuthenticatedReadiness',
      'normalizeExpectedIdentity',
      'normalizeReadinessResponse',
      'readForgeAdminReadiness',
    ]);
    expect(channel.isReadinessObservation).toBeUndefined();
    expect(typeof AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE).toBe('string');
    // Acquisition takes no parameters, so no caller object can reach it.
    expect(readForgeAdminReadiness.length).toBe(0);

    const source = readLib('forge-admin-readiness.js');
    expect(source).not.toMatch(/\.evaluate\s*\(/);
    expect(source).not.toContain('pageHost(page');
    expect(source).not.toContain('asObservation');
  });

  it('accepts no readiness argument anywhere in the runner or CLI', () => {
    ['e2e-runner.js', 'e2e-cli.js', 'e2e-evidence.js'].forEach((file) => {
      const source = readLib(file);
      expect(source).not.toContain('readinessPage');
      expect(source).not.toContain('isReadinessObservation');
      expect(source).not.toMatch(/readForgeAdminReadiness\(\s*\{/);
    });
  });
});

describe('payload binding contract (future adapter)', () => {
  it('binds a well-formed response to the expected identity', () => {
    const facts = bindReadinessResponse(connectorResponse(), expected());

    expect(facts).toMatchObject({
      appAri: APP_ARI,
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      environmentId: ENVIRONMENT_ID,
      environment: 'staging',
      paused: false,
    });
    expect(facts.installedSites).toEqual([LOCAL_HOST]);
    expect(facts.mappings).toHaveLength(1);
    expect(facts.webhook.receiptsAfterLatestRotation).toBe(true);
  });

  it.each([
    ['no identity', undefined],
    ['an empty identity', {}],
    ['a missing installation id', { ...expected(), installationId: undefined }],
    ['a missing environment id', { ...expected(), environmentId: undefined }],
    ['a missing environment type', { ...expected(), environmentType: undefined }],
    ['a missing site host', { ...expected(), siteHost: undefined }],
    ['a malformed site host', { ...expected(), siteHost: 'https://not-a-host/path' }],
    ['a malformed installation id', { ...expected(), installationId: 'short' }],
    ['a malformed app ari', { ...expected(), appAri: 'ari:cloud:ecosystem::app/not-a-uuid' }],
  ])('refuses to bind without %s', (_label, identity) => {
    expect(() => bindReadinessResponse(connectorResponse(), identity))
      .toThrow(expect.objectContaining({ code: 'READINESS_BINDING_REQUIRED' }));
  });

  it.each([
    [
      'app',
      { appAri: OTHER_APP_ARI, appId: OTHER_APP_ARI.slice('ari:cloud:ecosystem::app/'.length) },
      'READINESS_APP_MISMATCH',
    ],
    ['installation', { installationId: OTHER_INSTALLATION_ID }, 'READINESS_INSTALLATION_MISMATCH'],
    ['environment id', { environmentId: OTHER_ENVIRONMENT_ID }, 'READINESS_ENVIRONMENT_ID_MISMATCH'],
    ['environment type', { environment: 'production' }, 'READINESS_ENVIRONMENT_MISMATCH'],
  ])('rejects a response from a different %s', (_label, overrides, code) => {
    expect(() => bindReadinessResponse(connectorResponse(overrides), expected()))
      .toThrow(expect.objectContaining({ code }));
  });

  it.each([
    ['not an object', 'nope'],
    ['a failed response', connectorResponse({ success: false })],
    ['an unsupported version', connectorResponse({ version: 2 })],
    ['no capture time', connectorResponse({ capturedAt: 'not-a-time' })],
    ['an invalid app id', connectorResponse({ appAri: undefined, appId: 'not-a-uuid' })],
    ['disagreeing app identities', connectorResponse({ appAri: OTHER_APP_ARI, appId: APP_ID })],
    ['no app identity', connectorResponse({ appAri: undefined, appId: undefined })],
    ['a malformed installation id', connectorResponse({ installationId: 'nope' })],
    ['a malformed environment id', connectorResponse({ environmentId: '' })],
    ['no environment type', connectorResponse({ environment: '' })],
    ['malformed installed sites', connectorResponse({ installedSites: LOCAL_HOST })],
    ['an invalid installed site', connectorResponse({ installedSites: ['not a host'] })],
    ['a non-boolean pause state', connectorResponse({ paused: 'false' })],
    ['an incomplete F07 record', connectorResponse({ f07: { version: 1, phase: 'entity-active' } })],
    ['a malformed mapping direction', connectorResponse({
      mappings: [{ ...connectorResponse().mappings[0], syncDirection: 'pull' }],
    })],
    ['a malformed project key', connectorResponse({
      mappings: [{ ...connectorResponse().mappings[0], localProjectKey: 'not a key' }],
    })],
    ['a missing webhook record', connectorResponse({ webhook: undefined })],
    ['an invalid receipt timestamp', connectorResponse({
      webhook: { configured: true, lastReceiptAt: 'yesterday', lastRotatedAt: RECENT },
    })],
    ['an invalid rotation timestamp', connectorResponse({
      webhook: { configured: true, lastReceiptAt: RECENT, lastRotatedAt: 'not-a-time' },
    })],
  ])('rejects a response with %s', (_label, raw) => {
    expect(() => bindReadinessResponse(raw, expected()))
      .toThrow(expect.objectContaining({ code: 'READINESS_RESPONSE_INVALID' }));
  });

  it('rejects credential-shaped response material', () => {
    expect(() => bindReadinessResponse(
      connectorResponse({ apiToken: ['ATATT', '3xFfGF0-not-a-real-token-value'].join('') }),
      expected()
    )).toThrow(expect.objectContaining({ code: 'READINESS_RESPONSE_CONTAINS_SECRETS' }));
    expect(() => bindReadinessResponse(
      connectorResponse({ webhook: { configured: true, secret: 'value' } }),
      expected()
    )).toThrow(expect.objectContaining({ code: 'READINESS_RESPONSE_CONTAINS_SECRETS' }));
  });
});

describe('claims-only readiness gate', () => {
  it('reports every supplied readiness value as unsupported, never verified', () => {
    const facts = connectorResponse();
    const normalized = bindReadinessResponse(facts, expected());
    const supplied = [
      pageFor(facts),
      { evaluate: async () => facts },
      facts,
      normalized,
      { facts, invocation: { resolver: READINESS_RESOLVER, pageHost: LOCAL_HOST } },
      { status: 'verified', readinessBasis: 'authenticated-connector' },
      'verified',
    ];

    supplied.forEach((value) => {
      const result = evaluate(value);
      expect(result.status).toBe('unknown');
      expect(result.summary.readinessBasis).toBe('unverified-claims');
      expect(result.summary.verification).toBeNull();
      expect(result.reasons.map((entry) => entry.code))
        .toContain('readiness-verification-unsupported');
      expect(result.summary.paused).toBeNull();
      expect(result.summary.f07).toBeNull();
      expect(result.summary.webhook).toBeNull();
      expect(result.summary.selected).toBeNull();
    });
  });

  it('reports the adapter failure as unknown with a stable reason code', () => {
    const result = evaluate(undefined, {
      readinessFailure: { code: AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE },
    });
    const codes = result.reasons.map((entry) => entry.code);

    expect(result.status).toBe('unknown');
    expect(codes).toContain('authenticated-connector-adapter-unavailable');
    expect(codes).not.toContain('readiness-verification-failed');
    const adapterReason = result.reasons
      .find((entry) => entry.code === 'authenticated-connector-adapter-unavailable');
    expect(adapterReason.message).toContain(AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE);
  });

  it('keeps an operator-written document as unverified claims', () => {
    const result = evaluate(undefined, { document: evidenceDocument() });
    const codes = result.reasons.map((entry) => entry.code);

    expect(result.status).toBe('unknown');
    expect(result.summary.readinessBasis).toBe('unverified-claims');
    expect(result.summary.verification).toBeNull();
    expect(result.summary.attestation.verified).toBe(false);
    expect(codes).toContain('readiness-unverified');
    expect(codes).toContain('connector-installation-unverified');
    // The document claims a pass for paused/f07; every claim is downgraded.
    const claimed = result.checks.filter((entry) => entry.id === 'pause-state');
    expect(claimed.length).toBeGreaterThan(0);
    claimed.forEach((entry) => expect(entry.status).not.toBe('pass'));
    expect(codes).not.toContain('readiness-verification-unsupported');
  });

  it('does not ask for verification when nothing was supplied', () => {
    const result = evaluate(undefined);
    expect(result.status).toBe('unknown');
    expect(result.reasons.map((entry) => entry.code))
      .not.toContain('readiness-verification-unsupported');
  });
});

describe('no automated path to F07 activation', () => {
  it('exposes no activation entry point to E2E tooling', () => {
    const files = [
      'forge-admin-readiness.js',
      'e2e-evidence.js',
      'e2e-cli.js',
      'e2e-runner.js',
    ];
    files.forEach((file) => {
      const source = readLib(file);
      expect(source).not.toContain('activateIssueLeaseMigration');
      expect(source).not.toContain('ACTIVATE_ISSUE_LEASES');
    });
  });
});
