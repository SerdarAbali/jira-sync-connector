'use strict';

/**
 * Connector readiness gate for the write-enabled staging E2E runner.
 *
 * Trust model:
 * - A readiness bundle written by an operator is a *claim*. Jira REST cannot
 *   prove that the connector is installed, paused, migrated to F07, mapped or
 *   receiving signed webhooks, and this repository exposes no supported
 *   authenticated connector interface for those facts. Claims therefore never
 *   produce a verified readiness status.
 * - `verification` is the seam for such an interface. Only an object whose
 *   `source` is `authenticated-connector` is accepted, and its facts are
 *   validated with the same rules as claims. The CLI exposes no flag,
 *   environment variable or file that can supply verification.
 * - Without verification every connector fact is UNKNOWN, which blocks
 *   write-enabled synchronization testing while still allowing a read-only dry
 *   run and a plan preview.
 */

const fs = require('fs');

const EVIDENCE_KIND = 'jira-sync-connector-readiness';
const EVIDENCE_SCHEMA_VERSION = '1.0';
// Must stay in sync with manifest.yml app.id (asserted by tests).
const EXPECTED_APP_ID = 'ari:cloud:ecosystem::app/362d8e6b-b68c-4403-8020-d32ddcc02716';
// Mirrors LEGACY_LEASE_DRAIN_MS in src/services/sync/lease-migration.js.
const LEGACY_LEASE_DRAIN_MS = 1140000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const ALLOWED_DIRECTIONS = ['push', 'bidirectional'];
const VERIFICATION_SOURCE = 'authenticated-connector';
const READINESS_BASIS = {
  VERIFIED: 'authenticated-connector',
  CLAIMS: 'unverified-claims',
};

const CREDENTIAL_KEY_PATTERN = /(token|secret|password|authorization|apikey|api_key)/i;
const CREDENTIAL_VALUE_PATTERN = /^(ATATT|ATCTT)|Bearer\s+[A-Za-z0-9._-]{8,}/;

function reason(severity, code, message, action) {
  return { severity, code, message, action: action || null };
}

function check(id, status, detail) {
  return { id, status, detail };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseTimestamp(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function containsCredentialMaterial(value, depth = 0) {
  if (depth > 6) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsCredentialMaterial(entry, depth + 1));
  }
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.entries(value).some(([key, entry]) => {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      return true;
    }
    if (typeof entry === 'string' && CREDENTIAL_VALUE_PATTERN.test(entry.trim())) {
      return true;
    }
    return containsCredentialMaterial(entry, depth + 1);
  });
}

function loadEvidence(documentPath) {
  let text;
  try {
    text = fs.readFileSync(documentPath, 'utf8');
  } catch (error) {
    return {
      document: null,
      issues: [
        reason(
          'unknown',
          'evidence-unreadable',
          'The readiness bundle could not be read.',
          'Verify the file exists and is readable by the current user.'
        ),
      ],
    };
  }

  try {
    return { document: JSON.parse(text), issues: [] };
  } catch (error) {
    return {
      document: null,
      issues: [
        reason(
          'unknown',
          'evidence-invalid-json',
          'The readiness bundle is not valid JSON.',
          'Re-export the readiness bundle with the documented shape.'
        ),
      ],
    };
  }
}

/**
 * Normalises both shapes into one mapping list: the claim document nests
 * mappings under organizations, an authenticated verification returns a flat
 * `mappings` array.
 */
function normalizeMappings(input) {
  const mappings = [];
  (Array.isArray(input) ? input : []).forEach((entry) => {
    if (!isPlainObject(entry)) {
      return;
    }
    const common = {
      orgId: typeof entry.orgId === 'string' ? entry.orgId : null,
      syncDirection: entry.syncDirection,
    };
    if (Array.isArray(entry.projectMappings)) {
      const syncComments = isPlainObject(entry.features) ? entry.features.syncComments : undefined;
      entry.projectMappings.forEach((mapping) => {
        if (!isPlainObject(mapping)) {
          return;
        }
        mappings.push({
          ...common,
          syncComments,
          localProjectKey: mapping.localProjectKey,
          remoteProjectKey: mapping.remoteProjectKey,
        });
      });
      return;
    }
    mappings.push({
      ...common,
      syncComments: entry.syncComments,
      localProjectKey: entry.localProjectKey,
      remoteProjectKey: entry.remoteProjectKey,
    });
  });
  return mappings;
}

function selectProjectPair(mappings, config, selectors) {
  const localInventory = (config.local?.stagingProjects || []).map((key) => key.toUpperCase());
  const remoteInventory = (config.remote?.stagingProjects || []).map((key) => key.toUpperCase());
  const candidates = [];
  const outOfScope = [];

  normalizeMappings(mappings).forEach((mapping) => {
    const localKey = typeof mapping.localProjectKey === 'string'
      ? mapping.localProjectKey.trim().toUpperCase()
      : '';
    const remoteKey = typeof mapping.remoteProjectKey === 'string'
      ? mapping.remoteProjectKey.trim().toUpperCase()
      : '';
    if (!localKey || !remoteKey) {
      return;
    }
    if (selectors && selectors.local && localKey !== selectors.local.toUpperCase()) {
      return;
    }
    if (selectors && selectors.remote && remoteKey !== selectors.remote.toUpperCase()) {
      return;
    }
    const entry = {
      orgId: mapping.orgId,
      syncDirection: mapping.syncDirection,
      localProjectKey: localKey,
      remoteProjectKey: remoteKey,
      syncComments: mapping.syncComments,
    };
    if (!localInventory.includes(localKey)) {
      return;
    }
    if (!remoteInventory.includes(remoteKey)) {
      outOfScope.push(entry);
      return;
    }
    candidates.push(entry);
  });

  return { candidates, outOfScope };
}

function finalizeReadiness(checks, reasons, summary) {
  const blocking = reasons.some((entry) => entry.severity === 'block');
  const unknown = reasons.some((entry) => entry.severity === 'unknown');
  const status = blocking ? 'blocked' : unknown ? 'unknown' : 'verified';
  const verified = status === 'verified';
  return {
    status,
    checks,
    reasons,
    summary: {
      ...summary,
      readinessBasis: summary.readinessBasis || READINESS_BASIS.CLAIMS,
      remoteInstallationRequired: false,
      attestation: {
        verified,
        note: verified
          ? 'Readiness was read from an authenticated connector interface and cross-checked against read-only Jira APIs.'
          : 'Readiness is operator-claimed and unverified; write-enabled synchronization testing is blocked.',
        ...summary.attestation,
      },
    },
  };
}

/**
 * Accepts only an authenticated connector interface as a trustworthy source of
 * connector facts. Anything else is reported and ignored, so the run falls
 * back to unverified claims.
 */
function readVerification(verification, options = {}) {
  const now = options.now;
  const settings = options.settings || {};
  if (verification === undefined || verification === null) {
    return { facts: null, issues: [] };
  }
  const unsupported = (message) =>
    reason(
      'unknown',
      'readiness-verification-unsupported',
      message,
      'Supply connector facts only through a supported authenticated connector interface.'
    );

  if (!isPlainObject(verification) || verification.source !== VERIFICATION_SOURCE) {
    return {
      facts: null,
      issues: [
        unsupported(
          'Connector readiness verification did not come from an authenticated connector interface.'
        ),
      ],
    };
  }

  const capturedAtMs = parseTimestamp(verification.capturedAt);
  const maxAgeMs = Number.isSafeInteger(settings.evidenceMaxAgeMs)
    ? settings.evidenceMaxAgeMs
    : 15 * 60 * 1000;
  if (capturedAtMs === null) {
    return {
      facts: null,
      issues: [
        reason(
          'unknown',
          'readiness-verification-invalid',
          'The connector verification has no valid capturedAt timestamp.',
          'Re-read readiness from the authenticated connector interface.'
        ),
      ],
    };
  }
  if (capturedAtMs > now + MAX_CLOCK_SKEW_MS) {
    return {
      facts: null,
      issues: [
        reason(
          'unknown',
          'readiness-verification-invalid',
          'The connector verification is dated in the future.',
          'Correct host clock skew and re-read readiness from the connector.'
        ),
      ],
    };
  }
  if (now - capturedAtMs > maxAgeMs) {
    return {
      facts: null,
      issues: [
        reason(
          'unknown',
          'readiness-verification-stale',
          'The connector verification is older than the configured freshness window.',
          'Re-read readiness from the authenticated connector interface immediately before the run.'
        ),
      ],
    };
  }
  if (!Array.isArray(verification.installedSites) || !Array.isArray(verification.mappings)) {
    return {
      facts: null,
      issues: [
        reason(
          'unknown',
          'readiness-verification-invalid',
          'The connector verification does not describe installations and mappings.',
          'Return installedSites and mappings from the authenticated connector interface.'
        ),
      ],
    };
  }

  return {
    facts: {
      capturedAt: verification.capturedAt,
      appId: typeof verification.appId === 'string' ? verification.appId : null,
      environment: typeof verification.environment === 'string' ? verification.environment : null,
      installedSites: verification.installedSites.filter((entry) => typeof entry === 'string'),
      paused: typeof verification.paused === 'boolean' ? verification.paused : null,
      f07: isPlainObject(verification.f07) ? verification.f07 : null,
      mappings: normalizeMappings(verification.mappings),
      webhook: {
        configured:
          typeof verification.webhook?.configured === 'boolean'
            ? verification.webhook.configured
            : null,
        lastReceiptAt:
          typeof verification.webhook?.lastReceiptAt === 'string'
            ? verification.webhook.lastReceiptAt
            : null,
      },
    },
    issues: [],
  };
}

/**
 * Presents authenticated facts in the same shape the claim validation already
 * consumes, so both sources are validated by one set of rules.
 */
function documentFromVerification(facts) {
  return {
    kind: EVIDENCE_KIND,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    generatedAt: facts.capturedAt,
    source: VERIFICATION_SOURCE,
    capturedBy: null,
    connector: {
      appId: facts.appId,
      installationStatus: facts.installedSites.length > 0 ? 'installed' : null,
      installedSites: facts.installedSites,
      environment: facts.environment,
    },
    pause: { paused: facts.paused },
    f07: facts.f07,
    organizations: facts.mappings.map((mapping) => ({
      orgId: mapping.orgId,
      syncDirection: mapping.syncDirection,
      features: { syncComments: mapping.syncComments },
      projectMappings: [
        {
          localProjectKey: mapping.localProjectKey,
          remoteProjectKey: mapping.remoteProjectKey,
        },
      ],
    })),
    webhook: {
      configured: facts.webhook.configured,
      lastReceipt: { receivedAt: facts.webhook.lastReceiptAt },
    },
  };
}

// Connector facts that an operator-written file cannot establish. Jira REST
// cannot observe any of them, so a claim is never promoted to a pass.
const UNVERIFIED_FACTS = [
  { id: 'connector-installation', code: 'connector-installation-unverified', field: 'the local installation' },
  { id: 'connector-app', code: 'connector-app-unverified', field: 'the app id' },
  { id: 'connector-environment', code: 'connector-environment-unverified', field: 'the environment' },
  { id: 'pause-state', code: 'pause-state-unverified', field: 'the pause state' },
  { id: 'f07-migration', code: 'f07-unverified', field: 'the F07 migration state' },
  { id: 'project-mapping', code: 'project-mapping-unverified', field: 'the project mapping' },
  { id: 'feature-flags', code: 'feature-flags-unverified', field: 'the comment feature flag' },
  { id: 'webhook', code: 'webhook-unverified', field: 'signed-webhook delivery' },
];

/**
 * Downgrades every claim-derived pass to UNKNOWN and records why. Without an
 * authenticated interface there is no fact to verify, so nothing may pass.
 */
function downgradeClaims(checks, reasons) {
  UNVERIFIED_FACTS.forEach((fact) => {
    const entry = checks.find((item) => item.id === fact.id);
    if (!entry || entry.status !== 'pass') {
      return;
    }
    entry.status = 'unknown';
    entry.detail = `${entry.detail} This is an operator claim, not verified evidence.`;
    reasons.push(
      reason(
        'unknown',
        fact.code,
        `The readiness bundle claims a value for ${fact.field}, but no authenticated connector interface can verify it.`,
        'Keep the run read-only until the connector exposes authenticated readiness evidence.'
      )
    );
  });

  reasons.push(
    reason(
      'unknown',
      'readiness-unverified',
      'Connector installation, pause state, F07 migration, project mapping and signed-webhook delivery are unverified operator claims.',
      'Write-enabled synchronization testing requires an authenticated connector readiness interface; see docs/STAGING_E2E.md.'
    )
  );
}

function validateReadiness(options = {}) {
  const config = options.config || {};
  const settings = options.settings || {};
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const verification = readVerification(options.verification, { now, settings });
  const basis = verification.facts ? READINESS_BASIS.VERIFIED : READINESS_BASIS.CLAIMS;
  // An authenticated verification is authoritative; the claim document is then
  // only a carrier and its claims are not used.
  const document = verification.facts
    ? documentFromVerification(verification.facts)
    : options.document;
  const checks = [];
  const reasons = [...verification.issues];
  const summary = {
    environment: settings.environment || null,
    generatedAt: null,
    ageMs: null,
    appId: null,
    installedSites: [],
    paused: null,
    f07: null,
    webhook: null,
    selected: null,
    syncComments: null,
    readinessBasis: basis,
    verification: verification.facts
      ? { source: VERIFICATION_SOURCE, capturedAt: verification.facts.capturedAt }
      : null,
    attestation: {
      source: null,
      capturedBy: null,
    },
  };

  if (!isPlainObject(document)) {
    checks.push(check('evidence-document', 'unknown', 'No readiness document was loaded.'));
    reasons.push(
      reason(
        'unknown',
        'evidence-missing',
        'No connector readiness bundle is available.',
        'Export the connector readiness evidence described in docs/STAGING_E2E.md.'
      )
    );
    return finalizeReadiness(checks, reasons, summary);
  }

  if (document.kind !== EVIDENCE_KIND) {
    checks.push(check('evidence-document', 'unknown', 'Unexpected evidence kind.'));
    reasons.push(
      reason(
        'unknown',
        'evidence-kind-unsupported',
        'The readiness bundle does not describe the Jira sync connector.',
        `Export a bundle with kind "${EVIDENCE_KIND}".`
      )
    );
    return finalizeReadiness(checks, reasons, summary);
  }

  if (document.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    checks.push(check('evidence-document', 'unknown', 'Unsupported evidence schema.'));
    reasons.push(
      reason(
        'unknown',
        'evidence-schema-unsupported',
        `The readiness bundle schema version is not ${EVIDENCE_SCHEMA_VERSION}.`,
        'Re-export the readiness bundle using the documented schema.'
      )
    );
    return finalizeReadiness(checks, reasons, summary);
  }

  const generatedAtMs = parseTimestamp(document.generatedAt);
  summary.generatedAt = typeof document.generatedAt === 'string' ? document.generatedAt : null;
  summary.attestation.source = typeof document.source === 'string' ? document.source : null;
  summary.attestation.capturedBy = typeof document.capturedBy === 'string' ? document.capturedBy : null;

  if (generatedAtMs === null) {
    checks.push(check('evidence-document', 'unknown', 'generatedAt is not a timestamp.'));
    reasons.push(
      reason(
        'unknown',
        'evidence-timestamp-invalid',
        'The readiness bundle has no valid generatedAt timestamp.',
        'Export the bundle with an ISO-8601 generatedAt value.'
      )
    );
  } else {
    const ageMs = now - generatedAtMs;
    summary.ageMs = ageMs;
    const maxAgeMs = Number.isSafeInteger(settings.evidenceMaxAgeMs)
      ? settings.evidenceMaxAgeMs
      : 15 * 60 * 1000;
    if (ageMs < -MAX_CLOCK_SKEW_MS) {
      checks.push(check('evidence-freshness', 'unknown', 'Evidence is dated in the future.'));
      reasons.push(
        reason(
          'unknown',
          'evidence-from-future',
          'The readiness bundle is dated in the future, so its freshness cannot be established.',
          'Regenerate the bundle on a host with a synchronized clock.'
        )
      );
    } else if (ageMs > maxAgeMs) {
      checks.push(
        check('evidence-freshness', 'unknown', `Evidence is ${Math.round(ageMs / 1000)}s old.`)
      );
      reasons.push(
        reason(
          'unknown',
          'evidence-stale',
          'The readiness bundle is older than the configured freshness window.',
          'Re-export the readiness bundle immediately before the E2E run.'
        )
      );
    } else {
      checks.push(check('evidence-freshness', 'pass', `Evidence is ${Math.round(ageMs / 1000)}s old.`));
    }
  }

  if (containsCredentialMaterial(document)) {
    checks.push(check('evidence-redaction', 'block', 'Credential-shaped fields are present.'));
    reasons.push(
      reason(
        'block',
        'evidence-contains-credentials',
        'The readiness bundle contains credential-shaped keys or values.',
        'Re-export the bundle without tokens, secrets, or authorization headers, then rotate anything that was included.'
      )
    );
  } else {
    checks.push(check('evidence-redaction', 'pass', 'No credential-shaped fields detected.'));
  }

  const connector = isPlainObject(document.connector) ? document.connector : null;
  const localHost = String(config.local?.host || '').toLowerCase();
  // The connector is installed on the local Jira site only. The remote site is
  // reached over Jira REST and its webhook readiness is checked separately, so a
  // missing remote Forge installation is never a blocker.
  const installedSites = Array.isArray(connector?.installedSites)
    ? connector.installedSites
        .filter((entry) => typeof entry === 'string')
        .map((entry) => entry.trim().toLowerCase())
    : [];
  summary.installedSites = installedSites;
  summary.appId = typeof connector?.appId === 'string' ? connector.appId : null;

  if (!connector || connector.installationStatus !== 'installed') {
    checks.push(check('connector-installation', 'block', 'Connector is not reported as installed.'));
    reasons.push(
      reason(
        'block',
        'connector-not-installed',
        'The readiness bundle does not report the connector as installed.',
        'Install the connector in the staging environment and re-export the evidence.'
      )
    );
  } else if (!localHost || !installedSites.includes(localHost)) {
    checks.push(check('connector-installation', 'block', 'The local site has no connector installation.'));
    reasons.push(
      reason(
        'block',
        'connector-site-not-installed',
        'The connector is not reported as installed on the local staging site.',
        'Install the connector on the local staging site, or correct connector.installedSites in the readiness bundle.'
      )
    );
  } else {
    checks.push(
      check(
        'connector-installation',
        'pass',
        `Connector is installed on the local staging site ${localHost}; a remote Forge installation is not required.`
      )
    );
  }

  if (summary.appId !== EXPECTED_APP_ID) {
    checks.push(check('connector-app', 'block', 'Attested app ID does not match this connector.'));
    reasons.push(
      reason(
        'block',
        'connector-app-mismatch',
        'The readiness bundle was produced by a different Forge app.',
        'Export readiness evidence from the connector app ID declared in manifest.yml.'
      )
    );
  } else {
    checks.push(check('connector-app', 'pass', 'Attested app ID matches manifest.yml.'));
  }

  const connectorEnvironment = typeof connector?.environment === 'string'
    ? connector.environment.trim().toLowerCase()
    : null;
  if (!settings.environment || connectorEnvironment !== String(settings.environment).toLowerCase()) {
    checks.push(check('connector-environment', 'block', 'Attested environment does not match the run.'));
    reasons.push(
      reason(
        'block',
        'connector-environment-mismatch',
        `The connector is reported as "${connectorEnvironment || 'unknown'}" while this run targets "${settings.environment}".`,
        'Confirm the Forge environment under test, then set STAGING_E2E_ENVIRONMENT accordingly.'
      )
    );
  } else {
    checks.push(check('connector-environment', 'pass', `Connector environment is ${connectorEnvironment}.`));
  }


  const pause = isPlainObject(document.pause) ? document.pause : null;
  summary.paused = typeof pause?.paused === 'boolean' ? pause.paused : null;
  if (typeof pause?.paused !== 'boolean') {
    checks.push(check('pause-state', 'unknown', 'Pause state is missing from the evidence.'));
    reasons.push(
      reason(
        'unknown',
        'pause-state-unknown',
        'The readiness bundle does not state whether synchronization is paused.',
        'Export pause state from the connector admin page and re-run.'
      )
    );
  } else if (pause.paused) {
    checks.push(check('pause-state', 'block', 'The connector is paused.'));
    reasons.push(
      reason(
        'block',
        'pause-active',
        'Synchronization is paused, so no write can propagate.',
        'Resume synchronization in the connector admin page, wait for the queue to drain, then re-export readiness evidence.'
      )
    );
  } else {
    checks.push(check('pause-state', 'pass', 'Synchronization is reported as active.'));
  }

  const f07 = isPlainObject(document.f07) ? document.f07 : null;
  summary.f07 = f07
    ? {
        phase: typeof f07.phase === 'string' ? f07.phase : null,
        legacyDisabled: f07.legacyDisabled === true,
        disabledAt: Number.isSafeInteger(f07.disabledAt) ? f07.disabledAt : null,
        activatedAt: Number.isSafeInteger(f07.activatedAt) ? f07.activatedAt : null,
      }
    : null;

  if (
    !f07 ||
    f07.version !== 1 ||
    f07.phase !== 'entity-active' ||
    f07.legacyDisabled !== true ||
    !Number.isSafeInteger(f07.disabledAt) ||
    !Number.isSafeInteger(f07.activatedAt)
  ) {
    checks.push(check('f07-migration', 'unknown', 'F07 migration state is missing or not entity-active.'));
    reasons.push(
      reason(
        'unknown',
        'f07-not-verified',
        'F07 issue-lease migration is not reported as complete with legacy leases disabled.',
        'Complete the F07 migration, confirm legacy leases are disabled, then re-export readiness evidence.'
      )
    );
  } else if (f07.disabledAt < 0 || f07.activatedAt < f07.disabledAt + LEGACY_LEASE_DRAIN_MS) {
    checks.push(check('f07-migration', 'block', 'F07 drain window was not respected.'));
    reasons.push(
      reason(
        'block',
        'f07-drain-incomplete',
        'The F07 activation timestamp does not honor the legacy lease drain window.',
        'Wait for the configured drain window before activating entity leases.'
      )
    );
  } else if (f07.activatedAt > now + MAX_CLOCK_SKEW_MS) {
    checks.push(check('f07-migration', 'block', 'F07 activation is dated in the future.'));
    reasons.push(
      reason(
        'block',
        'f07-clock-skew',
        'The F07 activation timestamp is in the future.',
        'Correct host clock skew and re-export readiness evidence.'
      )
    );
  } else {
    checks.push(check('f07-migration', 'pass', 'F07 migration is entity-active with legacy leases disabled.'));
  }

  const organizations = Array.isArray(document.organizations) ? document.organizations : null;
  const selection = selectProjectPair(organizations, config, settings.selectors || null);
  let selected = null;

  if (!organizations || organizations.length === 0) {
    checks.push(check('project-mapping', 'block', 'No organization mappings are present.'));
    reasons.push(
      reason(
        'block',
        'project-mapping-missing',
        'The readiness bundle does not describe a project mapping.',
        'Export the configured project mappings from the connector admin page.'
      )
    );
  } else if (selection.candidates.length === 0 && selection.outOfScope.length > 0) {
    checks.push(check('project-mapping', 'block', 'Mapping target is outside the staging inventory.'));
    reasons.push(
      reason(
        'block',
        'project-mapping-out-of-scope',
        'The connector maps a staging project to a project outside the configured staging inventory.',
        'Correct the project inventory or the connector mapping before running write scenarios.'
      )
    );
  } else if (selection.candidates.length === 0) {
    checks.push(check('project-mapping', 'block', 'No staging project pair is mapped.'));
    reasons.push(
      reason(
        'block',
        'project-mapping-missing',
        'No mapped local/remote staging project pair was found in the readiness bundle.',
        'Configure the connector mapping for the staging projects, or set STAGING_E2E_LOCAL_PROJECT and STAGING_E2E_REMOTE_PROJECT to an existing pair.'
      )
    );
  } else if (selection.candidates.length > 1) {
    checks.push(check('project-mapping', 'block', 'More than one staging project pair is mapped.'));
    reasons.push(
      reason(
        'block',
        'project-mapping-ambiguous',
        `${selection.candidates.length} staging project pairs are mapped in the readiness bundle.`,
        'Set STAGING_E2E_LOCAL_PROJECT and STAGING_E2E_REMOTE_PROJECT to select exactly one pair.'
      )
    );
  } else {
    selected = selection.candidates[0];
    if (!ALLOWED_DIRECTIONS.includes(selected.syncDirection)) {
      checks.push(check('project-mapping', 'block', 'Sync direction is missing or unsupported.'));
      reasons.push(
        reason(
          'block',
          'sync-direction-invalid',
          'The mapped organization does not declare a supported sync direction.',
          'Set the connector sync direction to "push" or "bidirectional" and re-export readiness evidence.'
        )
      );
    } else {
      checks.push(
        check(
          'project-mapping',
          'pass',
          `Mapped ${selected.localProjectKey} to ${selected.remoteProjectKey} (${selected.syncDirection}).`
        )
      );
    }
  }

  summary.selected = selected
    ? {
        orgId: selected.orgId,
        syncDirection: selected.syncDirection,
        localProjectKey: selected.localProjectKey,
        remoteProjectKey: selected.remoteProjectKey,
      }
    : null;


  const syncComments = selected ? selected.syncComments : undefined;
  summary.syncComments = typeof syncComments === 'boolean' ? syncComments : null;
  if (!selected || typeof syncComments !== 'boolean') {
    checks.push(check('feature-flags', 'unknown', 'Comment synchronization state is not attested.'));
    reasons.push(
      reason(
        'unknown',
        'feature-flags-unknown',
        'The readiness bundle does not state whether comment synchronization is enabled.',
        'Export the connector feature flags and re-run.'
      )
    );
  } else {
    checks.push(
      check(
        'feature-flags',
        'pass',
        `Comment synchronization is ${syncComments ? 'enabled' : 'disabled'}.`
      )
    );
  }

  const webhook = isPlainObject(document.webhook) ? document.webhook : null;
  const receiptMs = parseTimestamp(webhook?.lastReceipt?.receivedAt);
  summary.webhook = {
    required: selected ? selected.syncDirection === 'bidirectional' : null,
    configured: typeof webhook?.configured === 'boolean' ? webhook.configured : null,
    lastReceiptAt: typeof webhook?.lastReceipt?.receivedAt === 'string'
      ? webhook.lastReceipt.receivedAt
      : null,
    lastReceiptAgeMs: receiptMs === null ? null : now - receiptMs,
  };

  if (!selected) {
    checks.push(check('webhook', 'unknown', 'Webhook readiness cannot be evaluated without a mapping.'));
  } else if (selected.syncDirection !== 'bidirectional') {
    checks.push(check('webhook', 'pass', 'Webhook delivery is not required for push-only synchronization.'));
  } else if (webhook?.configured !== true) {
    checks.push(check('webhook', 'block', 'The signed webhook is not configured.'));
    reasons.push(
      reason(
        'block',
        'webhook-not-configured',
        'Bidirectional synchronization requires a configured signed webhook.',
        'Configure the webhook in the connector admin page and re-export readiness evidence.'
      )
    );
  } else if (receiptMs === null) {
    checks.push(check('webhook', 'unknown', 'No authenticated webhook receipt is attested.'));
    reasons.push(
      reason(
        'unknown',
        'webhook-receipt-missing',
        'The readiness bundle has no authenticated webhook receipt.',
        'Trigger a harmless remote update and export the recorded webhook receipt.'
      )
    );
  } else {
    const maxAgeMs = Number.isSafeInteger(settings.evidenceMaxAgeMs)
      ? settings.evidenceMaxAgeMs
      : 15 * 60 * 1000;
    if (receiptMs > now + MAX_CLOCK_SKEW_MS) {
      checks.push(check('webhook', 'unknown', 'The webhook receipt is dated in the future.'));
      reasons.push(
        reason(
          'unknown',
          'webhook-receipt-invalid',
          'The authenticated webhook receipt timestamp is in the future.',
          'Regenerate the receipt on a host with a synchronized clock.'
        )
      );
    } else if (now - receiptMs > maxAgeMs) {
      checks.push(check('webhook', 'unknown', 'The webhook receipt is stale.'));
      reasons.push(
        reason(
          'unknown',
          'webhook-receipt-stale',
          'The authenticated webhook receipt is older than the freshness window.',
          'Re-export readiness evidence immediately before the E2E run.'
        )
      );
    } else {
      checks.push(check('webhook', 'pass', 'A recent authenticated webhook receipt is attested.'));
    }
  }

  if (basis === READINESS_BASIS.CLAIMS) {
    downgradeClaims(checks, reasons);
    summary.attestation = {
      ...summary.attestation,
      note: 'Readiness is operator-claimed. No authenticated connector interface is available to verify installation, pause, F07 migration, mapping or signed-webhook delivery.',
    };
  } else {
    summary.attestation = {
      ...summary.attestation,
      source: VERIFICATION_SOURCE,
      note: 'Readiness was read from an authenticated connector interface and cross-checked against read-only Jira APIs.',
    };
  }

  return finalizeReadiness(checks, reasons, summary);
}

module.exports = {
  EVIDENCE_KIND,
  EVIDENCE_SCHEMA_VERSION,
  EXPECTED_APP_ID,
  LEGACY_LEASE_DRAIN_MS,
  MAX_CLOCK_SKEW_MS,
  READINESS_BASIS,
  VERIFICATION_SOURCE,
  loadEvidence,
  normalizeMappings,
  selectProjectPair,
  validateReadiness,
};
