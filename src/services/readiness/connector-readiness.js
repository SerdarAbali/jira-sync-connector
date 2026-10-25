import api, { getAppContext, route } from '@forge/api';
import * as kvsStore from '../storage/kvs.js';
import { getPilotPause } from '../sync/pilot-pause.js';
import { readIssueLeaseMigrationState } from '../sync/lease-migration.js';
import { getAuthenticatedWebhookReceipt } from '../storage/webhook-receipt.js';
import { safeErrorForLog } from '../../utils/redaction.js';

/**
 * Installation-scoped readiness for the staging E2E runner and for the
 * administrator's F07 review.
 *
 * Only identity, configuration flags and receipt timestamps leave this module.
 * API tokens, signing secrets and authorization material are read solely to
 * prove presence and are never copied into the result.
 */
export const READINESS_SOURCE = 'authenticated-connector';
export const READINESS_VERSION = 1;

const PROJECT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,49}$/;
const MAX_MAPPINGS = 100;
const APP_ARI_PREFIX = 'ari:cloud:ecosystem::app/';
const APP_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

const defaultDeps = {
  getAppContext,
  requestJira: (request) => api.asApp().requestJira(request),
  getPilotPause,
  readIssueLeaseMigrationState,
  getStored: (key) => kvsStore.get(key),
  getSecret: (key) => kvsStore.getSecret(key),
  getAuthenticatedWebhookReceipt,
  now: () => Date.now()
};

function unavailable(code, message, details = {}) {
  return { success: false, status: 'unavailable', code, error: message, ...details };
}

function projectKey(value) {
  return typeof value === 'string' && PROJECT_KEY_PATTERN.test(value) ? value : null;
}

function safeSyncDirection(value) {
  return value === 'push' || value === 'bidirectional' ? value : null;
}

function safeTimestamp(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function appAriFromId(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (APP_UUID_PATTERN.test(candidate)) return `${APP_ARI_PREFIX}${candidate}`;
  if (candidate.startsWith(APP_ARI_PREFIX)) {
    const uuid = candidate.slice(APP_ARI_PREFIX.length);
    return APP_UUID_PATTERN.test(uuid) ? candidate : null;
  }
  return null;
}

/**
 * Normalizes the supported Forge SDK contract: `getAppContext().appAri` is an
 * AppAri object whose `appId` is the application UUID and whose toString()
 * returns the complete `ari:cloud:ecosystem::app/<uuid>` value. The two must
 * agree; a bare UUID or a complete ARI is accepted for deterministic tests and
 * older callers, but always normalized to the canonical ARI and UUID pair.
 */
function normalizeAppIdentity(context) {
  const source = context?.appAri;
  let appId = null;
  let appAri = null;

  if (typeof source === 'string') {
    appAri = appAriFromId(source);
    appId = appAri ? appAri.slice(APP_ARI_PREFIX.length) : null;
    return { appId, appAri };
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { appId: null, appAri: null };
  }

  const candidate = typeof source.appId === 'string' ? source.appId.trim() : null;
  if (candidate && APP_UUID_PATTERN.test(candidate)) {
    appId = candidate;
    appAri = `${APP_ARI_PREFIX}${candidate}`;
    const hasCustomDescription = typeof source.toString === 'function'
      && source.toString !== Object.prototype.toString;
    if (hasCustomDescription) {
      let described = null;
      try {
        described = source.toString();
      } catch {
        described = null;
      }
      if (described !== appAri) {
        return { appId: null, appAri: null };
      }
    }
    return { appId, appAri };
  }

  appAri = appAriFromId(candidate);
  appId = appAri ? appAri.slice(APP_ARI_PREFIX.length) : null;
  if (appAri && typeof source.toString === 'function'
    && source.toString !== Object.prototype.toString) {
    let described = null;
    try {
      described = source.toString();
    } catch {
      described = null;
    }
    if (described !== appAri) {
      return { appId: null, appAri: null };
    }
  }
  return { appId, appAri };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function timestampMs(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function syncCommentsFrom(stored) {
  // Mirrors the configuration default: an absent preference keeps comment
  // synchronization enabled. A stored value that is not a boolean is malformed
  // and must fail closed rather than enabling synchronization.
  if (stored === null || stored === undefined) return { value: true, valid: true };
  if (!isPlainObject(stored)) return { value: null, valid: false };
  if (!Object.prototype.hasOwnProperty.call(stored, 'syncComments')) {
    return { value: true, valid: true };
  }
  if (typeof stored.syncComments !== 'boolean') return { value: null, valid: false };
  return { value: stored.syncComments, valid: true };
}

function rotationFrom(metadata) {
  if (metadata === null || metadata === undefined) return { rotatedAt: null, valid: true };
  if (!isPlainObject(metadata)) return { rotatedAt: null, valid: false };
  if (metadata.rotatedAt === undefined || metadata.rotatedAt === null) {
    return { rotatedAt: null, valid: true };
  }
  const rotatedAt = safeTimestamp(metadata.rotatedAt);
  return { rotatedAt, valid: rotatedAt !== null };
}

function collectProjectPairs(org, mappings) {
  const pairs = [];
  if (mappings && typeof mappings === 'object' && !Array.isArray(mappings)) {
    for (const [local, remote] of Object.entries(mappings)) {
      const localKey = projectKey(local);
      const remoteKey = projectKey(remote);
      if (localKey && remoteKey) pairs.push({ localKey, remoteKey });
    }
  }

  if (pairs.length === 0) {
    const remoteKey = projectKey(org.remoteProjectKey);
    const allowed = Array.isArray(org.allowedProjects) ? org.allowedProjects : [];
    if (remoteKey) {
      allowed.forEach((local) => {
        const localKey = projectKey(local);
        if (localKey) pairs.push({ localKey, remoteKey });
      });
    }
  }

  const seen = new Set();
  return pairs.filter((pair) => {
    const id = `${pair.localKey}->${pair.remoteKey}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).slice(0, MAX_MAPPINGS);
}

async function readSiteHost(deps) {
  const response = await deps.requestJira(route`/rest/api/3/serverInfo`);
  if (!response || response.ok !== true) {
    return { host: null, reason: 'site-info-unavailable' };
  }
  const body = await response.json();
  const baseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl : null;
  if (!baseUrl) return { host: null, reason: 'site-info-malformed' };
  try {
    return { host: new URL(baseUrl).hostname.toLowerCase(), reason: null };
  } catch {
    return { host: null, reason: 'site-info-malformed' };
  }
}

async function readOrganization(org, deps) {
  const id = typeof org?.id === 'string' && org.id ? org.id : null;
  const syncDirection = safeSyncDirection(org?.syncDirection);
  const [mappings, options, signingSecret, metadata, receipt] = await Promise.all([
    deps.getStored(id ? `projectMappings:${id}` : 'projectMappings'),
    deps.getStored(id ? `syncOptions:${id}` : 'syncOptions'),
    id ? deps.getSecret(`secret:${id}:webhookSigningSecret`) : Promise.resolve(null),
    id ? deps.getStored(`webhookSigningSecretMeta:${id}`) : Promise.resolve(null),
    id ? deps.getAuthenticatedWebhookReceipt(id) : Promise.resolve(null)
  ]);

  const comments = syncCommentsFrom(options);
  const rotation = rotationFrom(metadata);
  const receiptAt = safeTimestamp(receipt?.receivedAt);
  const receiptMs = timestampMs(receiptAt);
  const rotatedMs = timestampMs(rotation.rotatedAt);
  // Mirrors the setup validator's freshness rule: a receipt recorded before
  // the latest signing-key rotation does not prove the current secret works.
  const receiptsAfterLatestRotation = receiptMs !== null && rotatedMs !== null
    ? receiptMs >= rotatedMs
    : null;

  return {
    summary: {
      orgId: id,
      syncDirection,
      syncComments: comments.value,
      syncCommentsValid: comments.valid,
      webhookConfigured: !!signingSecret,
      webhookLastRotatedAt: rotation.rotatedAt,
      webhookRotationMetadataValid: rotation.valid,
      webhookLastReceiptAt: receiptAt,
      webhookLastReceiptEvent: typeof receipt?.event === 'string' ? receipt.event : null,
      webhookReceiptsAfterLatestRotation: receiptsAfterLatestRotation
    },
    pairs: collectProjectPairs(org || {}, mappings)
  };
}

function aggregateWebhook(organizations) {
  // Only bidirectional organizations depend on the signed webhook. A missing
  // secret or receipt for any of them keeps the aggregate negative, and the
  // oldest receipt is used so one fresh receipt cannot mask a stale one.
  const required = organizations.filter((org) => org.syncDirection === 'bidirectional');
  if (required.length === 0) {
    return {
      configured: false,
      lastReceiptAt: null,
      lastRotatedAt: null,
      receiptsAfterLatestRotation: null,
      rotationMetadataValid: true,
      requiredForAnyOrganization: false
    };
  }
  const receipts = required
    .map((org) => org.webhookLastReceiptAt)
    .filter((value) => typeof value === 'string')
    .sort();
  const rotations = required
    .map((org) => org.webhookLastRotatedAt)
    .filter((value) => typeof value === 'string')
    .sort();
  const configured = required.every((org) => org.webhookConfigured === true);
  const receiptsAfterLatestRotation = required.some(
    (org) => org.webhookReceiptsAfterLatestRotation === false
  )
    ? false
    : configured && receipts.length === required.length
      ? true
      : null;
  return {
    configured,
    lastReceiptAt: configured && receipts.length === required.length ? receipts[0] : null,
    lastRotatedAt: rotations.length > 0 ? rotations[rotations.length - 1] : null,
    receiptsAfterLatestRotation,
    rotationMetadataValid: required.every(
      (org) => org.webhookRotationMetadataValid === true
    ),
    requiredForAnyOrganization: true
  };
}

function buildChecks({ identity, site, pause, f07, mappings, organizations, webhook }) {
  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });

  add(
    'identity-binding',
    identity.bound ? 'pass' : 'block',
    identity.bound
      ? 'Forge application, environment and installation identity are available.'
      : 'Forge identity is incomplete; installation-scoped facts cannot be bound.'
  );
  add(
    'site-installation',
    site.host ? 'pass' : 'block',
    site.host
      ? 'The app is executing on a Jira Cloud site resolved from serverInfo.'
      : 'The local Jira site could not be resolved from serverInfo.'
  );
  add(
    'pause-state',
    pause.readable && pause.paused === false ? 'pass' : pause.readable ? 'block' : 'unknown',
    pause.readable
      ? (pause.paused ? 'Jira writes are paused.' : 'Pause state is active (writes allowed).')
      : 'Pause state could not be read.'
  );

  if (!f07.readable) {
    add('f07-migration', 'unknown', 'F07 migration state could not be read.');
  } else if (f07.valid) {
    add('f07-migration', 'pass', 'F07 migration is entity-active with legacy leases disabled.');
  } else {
    add('f07-migration', 'unknown', `F07 migration is not active: ${f07.reasons.join(', ')}.`);
  }

  add(
    'project-mapping',
    mappings.length > 0 ? 'pass' : 'block',
    mappings.length > 0
      ? `${mappings.length} configured project mapping(s) found.`
      : 'No configured project mapping was found.'
  );

  if (organizations.length === 0) {
    add('feature-flags', 'unknown', 'Comment synchronization cannot be attributed without an organization.');
  } else if (organizations.every((org) => typeof org.syncComments === 'boolean')) {
    add('feature-flags', 'pass', 'Comment synchronization is configured for every organization.');
  } else {
    add('feature-flags', 'unknown', 'Comment synchronization state is incomplete.');
  }

  if (webhook.requiredForAnyOrganization) {
    let webhookStatus = 'pass';
    let detail = 'Signed webhook is configured for every bidirectional organization and authenticated receipts exist.';
    if (!webhook.configured) {
      webhookStatus = 'block';
      detail = 'A bidirectional organization has no configured signed webhook.';
    } else if (webhook.rotationMetadataValid !== true) {
      webhookStatus = 'block';
      detail = 'Stored signing-key rotation metadata is malformed, so webhook delivery cannot be certified.';
    } else if (webhook.receiptsAfterLatestRotation === false) {
      webhookStatus = 'block';
      detail = 'The authenticated webhook receipt predates the latest signing-key rotation.';
    } else if (!webhook.lastReceiptAt) {
      webhookStatus = 'block';
      detail = 'A signed webhook is configured but no authenticated receipt was recorded.';
    }
    add('webhook', webhookStatus, detail);
  } else {
    add('webhook', 'pass', 'No bidirectional organization requires a signed webhook.');
  }

  return checks;
}

function statusFromChecks(checks) {
  if (checks.some((entry) => entry.status === 'block')) return 'blocked';
  if (checks.some((entry) => entry.status === 'unknown')) return 'unknown';
  return 'verified';
}

/**
 * Reads and evaluates connector readiness. Dependencies are injectable so the
 * authorization/identity boundary and every fail-closed path can be verified
 * without Forge.
 */
export async function buildConnectorReadiness(options = {}) {
  const deps = { ...defaultDeps, ...(options.deps || {}) };
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();

  let context;
  try {
    context = deps.getAppContext();
  } catch (error) {
    console.warn('Connector readiness identity unavailable', safeErrorForLog(error));
    return unavailable('READINESS_IDENTITY_UNAVAILABLE', 'Forge application context is unavailable.');
  }

  const appIdentity = normalizeAppIdentity(context);
  const environmentId = typeof context?.environmentAri?.environmentId === 'string'
    && IDENTITY_ID_PATTERN.test(context.environmentAri.environmentId)
    ? context.environmentAri.environmentId
    : null;
  const installationId = typeof context?.installationAri?.installationId === 'string'
    && IDENTITY_ID_PATTERN.test(context.installationAri.installationId)
    ? context.installationAri.installationId
    : null;
  const environmentType = typeof context?.environmentType === 'string' ? context.environmentType : null;
  const appVersion = typeof context?.appVersion === 'string' ? context.appVersion : null;
  const cloudIds = Array.isArray(context?.installation?.contexts)
    ? context.installation.contexts
      .map((entry) => (typeof entry?.cloudId === 'string' ? entry.cloudId : null))
      .filter(Boolean)
    : [];
  const identity = {
    appId: appIdentity.appId,
    appAri: appIdentity.appAri,
    appVersion,
    environmentId,
    environmentType,
    installationId,
    cloudIds,
    bound: !!(appIdentity.appId && appIdentity.appAri && environmentId && installationId && environmentType)
  };

  let site;
  try {
    site = await readSiteHost(deps);
  } catch (error) {
    console.warn('Connector readiness site lookup failed', safeErrorForLog(error));
    site = { host: null, reason: 'site-info-unavailable' };
  }

  let pauseState;
  try {
    const stored = await deps.getPilotPause();
    pauseState = {
      readable: true,
      paused: stored?.paused === true,
      pausedAt: typeof stored?.pausedAt === 'string' ? stored.pausedAt : null,
      reasonCode: typeof stored?.reasonCode === 'string' ? stored.reasonCode : null
    };
  } catch (error) {
    console.warn('Connector readiness pause read failed', safeErrorForLog(error));
    pauseState = { readable: false, paused: null, pausedAt: null, reasonCode: null };
  }

  let f07;
  try {
    f07 = await deps.readIssueLeaseMigrationState(nowMs);
  } catch (error) {
    console.warn('Connector readiness F07 read failed', safeErrorForLog(error));
    f07 = null;
  }
  if (!f07 || typeof f07 !== 'object' || Array.isArray(f07)) {
    f07 = {
      readable: false,
      present: null,
      valid: false,
      active: false,
      phase: null,
      state: null,
      reasons: ['migration-unreadable']
    };
  }

  let organizations = [];
  let mappings = [];
  let invalidConfiguration = [];
  let storageFailed = false;
  try {
    const stored = await deps.getStored('organizations');
    const orgs = Array.isArray(stored) ? stored : [];
    const evaluated = await Promise.all(orgs.map((org) => readOrganization(org, deps)));

    evaluated.forEach((entry) => {
      entry.pairs.forEach((pair) => {
        mappings.push({
          orgId: entry.summary.orgId,
          syncDirection: entry.summary.syncDirection,
          syncComments: entry.summary.syncComments,
          localProjectKey: pair.localKey,
          remoteProjectKey: pair.remoteKey
        });
      });
    });
    organizations = evaluated.map((entry) => entry.summary);
    invalidConfiguration = evaluated
      .filter((entry) => entry.summary.syncCommentsValid !== true)
      .map((entry) => entry.summary.orgId);
  } catch (error) {
    console.warn('Connector readiness configuration read failed', safeErrorForLog(error));
    storageFailed = true;
    organizations = [];
    mappings = [];
  }

  if (storageFailed) {
    return unavailable(
      'READINESS_STORAGE_UNAVAILABLE',
      'Installation configuration could not be read.',
      { capturedAt: nowIso, identity }
    );
  }

  if (invalidConfiguration.length > 0) {
    // Malformed stored configuration must never be normalized into an enabled
    // feature or a verified readiness result.
    return unavailable(
      'READINESS_CONFIGURATION_INVALID',
      'Stored comment-synchronization configuration is malformed.',
      { capturedAt: nowIso, identity, invalidOrganizations: invalidConfiguration }
    );
  }

  const webhook = aggregateWebhook(organizations);
  const checks = buildChecks({
    identity,
    site,
    pause: pauseState,
    f07,
    mappings,
    organizations,
    webhook
  });

  return {
    success: true,
    version: READINESS_VERSION,
    source: READINESS_SOURCE,
    capturedAt: nowIso,
    status: statusFromChecks(checks),
    appId: appIdentity.appId,
    appAri: appIdentity.appAri,
    appVersion,
    environment: environmentType,
    environmentId,
    installationId,
    cloudIds,
    installedSites: site.host ? [site.host] : [],
    paused: pauseState.paused,
    pause: pauseState,
    f07: f07.state,
    f07Status: {
      readable: f07.readable,
      present: f07.present,
      active: f07.active,
      valid: f07.valid,
      phase: f07.phase,
      reasons: f07.reasons
    },
    mappings,
    organizations,
    webhook,
    checks
  };
}
