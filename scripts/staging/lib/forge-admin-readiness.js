'use strict';

/**
 * Authenticated connector-readiness channel.
 *
 * STATUS: the acquisition path is DISABLED and fails closed.
 *
 * The only supported source of connector facts is an authenticated Forge admin
 * browser adapter: a real browser session that is signed in to the local staging
 * site, navigates to the connector admin page and performs the `ADMIN_READ`
 * resolver invocation through `@forge/bridge`. No such adapter is implemented in
 * this repository, so `readForgeAdminReadiness()` performs no invocation and
 * always rejects with `AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE`.
 *
 * There is deliberately no argument that can change that outcome. A
 * caller-supplied object with `url()`/`evaluate()` members, a bare `evaluate`
 * callback, a JSON document, a facts object or a `source` field is not a browser
 * session and cannot be authenticated: any such object can fabricate every fact
 * the runner asks for. The previous page-handle argument was exactly that
 * bypass and is therefore removed rather than validated more strictly.
 *
 * Future adapter interface (documented, not implemented):
 *
 *   // scripts/staging/lib/forge-admin-browser-adapter.js (does not exist yet)
 *   async function createForgeAdminBrowserAdapter({ browser, siteHost, adminUrl })
 *     -> { readConnectorReadiness(): Promise<unknown> }
 *
 * The adapter is responsible for the authenticated browser session, for
 * restricting navigation to `siteHost` and for invoking
 * `window.__syncConnectorReadinessInvoke()` (see `READINESS_EXPRESSION`) exactly
 * once. Its raw payload must then be passed through `bindReadinessResponse()`,
 * which validates the response contract and binds the expected app ARI/UUID,
 * installation id, environment id and environment type. Only after that adapter
 * exists may a caller treat connector readiness as verified.
 *
 * Until then the exported `normalizeReadinessResponse()` and
 * `bindReadinessResponse()` are pure validation building blocks: neither one
 * authenticates anything, and no exported function returns verified readiness.
 */

const READINESS_RESOLVER = 'getConnectorReadiness';
const AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE =
  'AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE';
const READINESS_VERSION = 1;
const READINESS_EXPRESSION = 'window.__syncConnectorReadinessInvoke()';
const APP_ARI_PREFIX = 'ari:cloud:ecosystem::app/';
const APP_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const PROJECT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,49}$/;
const HOST_PATTERN = /^[a-z0-9.-]{1,253}$/;
const SENSITIVE_KEY_PATTERN = /(token|secret|password|credential|authorization|cookie|api[-_]?key|private[-_]?key)/i;
const CREDENTIAL_VALUE_PATTERN = /^(ATATT|ATCTT|ATBB)[A-Za-z0-9_-]{10,}|^(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]{8,}/;
const MAX_SCAN_DEPTH = 4;
const MAX_SITES = 50;
const MAX_MAPPINGS = 100;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function timestampMs(value) {
  return isTimestamp(value) ? Date.parse(value) : null;
}

function invalidResponse(message) {
  return codedError('READINESS_RESPONSE_INVALID', message);
}

function assertNoSensitiveFields(value, depth = 0) {
  if (depth > MAX_SCAN_DEPTH || value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (CREDENTIAL_VALUE_PATTERN.test(value)) {
      throw codedError(
        'READINESS_RESPONSE_CONTAINS_SECRETS',
        'The readiness response contains credential material and was rejected.'
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => assertNoSensitiveFields(entry, depth + 1));
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      throw codedError(
        'READINESS_RESPONSE_CONTAINS_SECRETS',
        'The readiness response contains credential-shaped fields and was rejected.'
      );
    }
    assertNoSensitiveFields(entry, depth + 1);
  }
}

function canonicalAppAri(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (APP_UUID_PATTERN.test(candidate)) return `${APP_ARI_PREFIX}${candidate}`;
  if (candidate.startsWith(APP_ARI_PREFIX)) {
    const uuid = candidate.slice(APP_ARI_PREFIX.length);
    return APP_UUID_PATTERN.test(uuid) ? candidate : null;
  }
  return null;
}

function normalizeAppIdentity(raw) {
  const fromAri = raw.appAri === undefined ? null : canonicalAppAri(raw.appAri);
  const fromId = raw.appId === undefined ? null : canonicalAppAri(raw.appId);
  if (raw.appAri !== undefined && !fromAri) {
    throw invalidResponse('The readiness response has an invalid Forge application ARI.');
  }
  if (raw.appId !== undefined && !fromId) {
    throw invalidResponse('The readiness response has an invalid Forge application id.');
  }
  if (fromAri && fromId && fromAri !== fromId) {
    throw invalidResponse('The readiness response app ARI and app id disagree.');
  }
  const appAri = fromAri || fromId;
  if (!appAri) {
    throw invalidResponse('The readiness response has no Forge application identity.');
  }
  return { appAri, appId: appAri.slice(APP_ARI_PREFIX.length) };
}

function normalizeF07(f07) {
  if (f07 === null || f07 === undefined) return null;
  if (!isPlainObject(f07)) {
    throw invalidResponse('The readiness response has a malformed F07 record.');
  }
  if (!Number.isSafeInteger(f07.version)
    || typeof f07.phase !== 'string'
    || typeof f07.legacyDisabled !== 'boolean'
    || !Number.isSafeInteger(f07.disabledAt)
    || !Number.isSafeInteger(f07.activatedAt)) {
    throw invalidResponse('The readiness response has an incomplete F07 record.');
  }
  return {
    version: f07.version,
    phase: f07.phase,
    legacyDisabled: f07.legacyDisabled,
    disabledAt: f07.disabledAt,
    activatedAt: f07.activatedAt,
  };
}

function normalizeMappings(mappings) {
  if (!Array.isArray(mappings) || mappings.length > MAX_MAPPINGS) {
    throw invalidResponse('The readiness response has a malformed mapping list.');
  }
  return mappings.map((entry) => {
    if (!isPlainObject(entry)
      || typeof entry.orgId !== 'string' || !entry.orgId
      || (entry.syncDirection !== 'push' && entry.syncDirection !== 'bidirectional')
      || typeof entry.syncComments !== 'boolean'
      || typeof entry.localProjectKey !== 'string'
      || !PROJECT_KEY_PATTERN.test(entry.localProjectKey)
      || typeof entry.remoteProjectKey !== 'string'
      || !PROJECT_KEY_PATTERN.test(entry.remoteProjectKey)) {
      throw invalidResponse('The readiness response has a malformed project mapping.');
    }
    return {
      orgId: entry.orgId,
      syncDirection: entry.syncDirection,
      syncComments: entry.syncComments,
      localProjectKey: entry.localProjectKey,
      remoteProjectKey: entry.remoteProjectKey,
    };
  });
}

function normalizeWebhook(webhook) {
  if (!isPlainObject(webhook) || typeof webhook.configured !== 'boolean') {
    throw invalidResponse('The readiness response has a malformed webhook record.');
  }
  const lastReceiptAt = webhook.lastReceiptAt === undefined || webhook.lastReceiptAt === null
    ? null
    : webhook.lastReceiptAt;
  const lastRotatedAt = webhook.lastRotatedAt === undefined || webhook.lastRotatedAt === null
    ? null
    : webhook.lastRotatedAt;
  if (lastReceiptAt !== null && !isTimestamp(lastReceiptAt)) {
    throw invalidResponse('The readiness response has an invalid webhook receipt timestamp.');
  }
  if (lastRotatedAt !== null && !isTimestamp(lastRotatedAt)) {
    throw invalidResponse('The readiness response has invalid signing-key rotation metadata.');
  }
  const rotationMetadataValid = webhook.rotationMetadataValid === undefined
    ? true
    : webhook.rotationMetadataValid;
  if (typeof rotationMetadataValid !== 'boolean') {
    throw invalidResponse('The readiness response has malformed rotation validity metadata.');
  }
  let receiptsAfterLatestRotation = webhook.receiptsAfterLatestRotation === undefined
    ? null
    : webhook.receiptsAfterLatestRotation;
  if (receiptsAfterLatestRotation !== null && typeof receiptsAfterLatestRotation !== 'boolean') {
    throw invalidResponse('The readiness response has malformed receipt freshness metadata.');
  }
  if (receiptsAfterLatestRotation !== null && (lastReceiptAt === null || lastRotatedAt === null)) {
    throw invalidResponse('The readiness response claims rotation freshness without both timestamps.');
  }
  if (lastReceiptAt !== null && lastRotatedAt !== null) {
    const derived = timestampMs(lastReceiptAt) >= timestampMs(lastRotatedAt);
    if (receiptsAfterLatestRotation !== null && receiptsAfterLatestRotation !== derived) {
      throw invalidResponse('The readiness response contradicts its own rotation timestamps.');
    }
    receiptsAfterLatestRotation = derived;
  }
  return {
    configured: webhook.configured,
    lastReceiptAt,
    lastRotatedAt,
    receiptsAfterLatestRotation,
    rotationMetadataValid,
  };
}

/**
 * Validates the shape of an admin resolver response and returns only the
 * documented facts. This function is not an authentication mechanism and cannot
 * turn a document, a facts object or a callback result into readiness evidence.
 */
function normalizeReadinessResponse(raw) {
  if (!isPlainObject(raw)) {
    throw invalidResponse('The connector readiness response is not an object.');
  }
  if (raw.success !== true) {
    throw invalidResponse('The connector readiness response did not succeed.');
  }
  if (raw.version !== READINESS_VERSION) {
    throw invalidResponse('The connector readiness response version is unsupported.');
  }
  if (!isTimestamp(raw.capturedAt)) {
    throw invalidResponse('The connector readiness response has no valid capture time.');
  }
  const appIdentity = normalizeAppIdentity(raw);
  if (typeof raw.installationId !== 'string' || !INSTALLATION_ID_PATTERN.test(raw.installationId)) {
    throw invalidResponse('The connector readiness response has no valid installation identity.');
  }
  if (typeof raw.environmentId !== 'string' || !INSTALLATION_ID_PATTERN.test(raw.environmentId)) {
    throw invalidResponse('The connector readiness response has no valid environment identity.');
  }
  if (typeof raw.environment !== 'string' || !raw.environment) {
    throw invalidResponse('The connector readiness response has no environment type.');
  }

  if (!Array.isArray(raw.installedSites)
    || raw.installedSites.length > MAX_SITES
    || raw.installedSites.some((entry) => typeof entry !== 'string')) {
    throw invalidResponse('The connector readiness response has malformed installed sites.');
  }
  const installedSites = raw.installedSites.map((entry) => entry.trim().toLowerCase());
  if (installedSites.some((entry) => !HOST_PATTERN.test(entry))) {
    throw invalidResponse('The connector readiness response has malformed installed sites.');
  }
  if (typeof raw.paused !== 'boolean') {
    throw invalidResponse('The connector readiness response has no boolean pause state.');
  }

  assertNoSensitiveFields(raw);

  return {
    capturedAt: raw.capturedAt,
    appAri: appIdentity.appAri,
    appId: appIdentity.appId,
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : null,
    environment: raw.environment,
    environmentId: raw.environmentId,
    installationId: raw.installationId,
    installedSites: [...new Set(installedSites)],
    paused: raw.paused,
    f07: normalizeF07(raw.f07),
    mappings: normalizeMappings(raw.mappings),
    webhook: normalizeWebhook(raw.webhook),
  };
}


function normalizeExpectedIdentity(expected) {
  const bindingError = () => codedError(
    'READINESS_BINDING_REQUIRED',
    'Connector readiness must be bound to the expected app, environment and installation identity.'
  );
  if (!isPlainObject(expected)) throw bindingError();

  const fromAri = expected.appAri === undefined ? null : canonicalAppAri(expected.appAri);
  const fromId = expected.appId === undefined ? null : canonicalAppAri(expected.appId);
  if (expected.appAri !== undefined && !fromAri) throw bindingError();
  if (expected.appId !== undefined && !fromId) throw bindingError();
  if (fromAri && fromId && fromAri !== fromId) throw bindingError();
  const appAri = fromAri || fromId;

  const installationId = typeof expected.installationId === 'string'
    && INSTALLATION_ID_PATTERN.test(expected.installationId)
    ? expected.installationId
    : null;
  const environmentId = typeof expected.environmentId === 'string'
    && INSTALLATION_ID_PATTERN.test(expected.environmentId)
    ? expected.environmentId
    : null;
  const environmentType = typeof expected.environmentType === 'string'
    && expected.environmentType.trim()
    ? expected.environmentType.trim()
    : null;
  const siteHost = typeof expected.siteHost === 'string'
    ? expected.siteHost.trim().toLowerCase()
    : null;

  if (!appAri || !installationId || !environmentId || !environmentType
    || !siteHost || !HOST_PATTERN.test(siteHost)) {
    throw bindingError();
  }
  return {
    appAri,
    appId: appAri.slice(APP_ARI_PREFIX.length),
    installationId,
    environmentId,
    environmentType,
    siteHost,
  };
}

/**
 * Binds a raw admin resolver response to the expected app, environment and
 * installation identity.
 *
 * This is the payload half of the (not yet implemented) browser adapter
 * contract: `createForgeAdminBrowserAdapter(...).readConnectorReadiness()` must
 * return a raw payload, and only the adapter's caller may bind it. Calling this
 * function yourself with your own object authenticates nothing.
 */
function bindReadinessResponse(raw, expected) {
  const identity = normalizeExpectedIdentity(expected);
  const facts = normalizeReadinessResponse(raw);

  if (facts.appAri !== identity.appAri) {
    throw codedError(
      'READINESS_APP_MISMATCH',
      'The readiness response came from a different Forge application.'
    );
  }
  if (facts.installationId !== identity.installationId) {
    throw codedError(
      'READINESS_INSTALLATION_MISMATCH',
      'The readiness response came from a different Forge installation.'
    );
  }
  if (facts.environmentId !== identity.environmentId) {
    throw codedError(
      'READINESS_ENVIRONMENT_ID_MISMATCH',
      'The readiness response came from a different Forge environment.'
    );
  }
  if (facts.environment.toLowerCase() !== identity.environmentType.toLowerCase()) {
    throw codedError(
      'READINESS_ENVIRONMENT_MISMATCH',
      'The readiness response came from a different Forge environment type.'
    );
  }

  return facts;
}

/**
 * Connector readiness acquisition. Permanently unavailable in this repository:
 * no authenticated browser adapter exists, so there is no way to perform the
 * `ADMIN_READ` invocation and every call rejects.
 *
 * The function intentionally takes NO page, no `evaluate` callback, no expected
 * identity from the caller's object graph and no environment switch: a
 * caller-provided object cannot be authenticated, because it can return any
 * payload including one that matches every expectation. Only an implementation
 * that owns a real signed-in browser session may resolve this, and that
 * implementation is the future adapter described in the module header.
 */
async function readForgeAdminReadiness() {
  throw codedError(
    AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE,
    'Authenticated connector readiness is unavailable: no authenticated Forge '
      + 'admin browser adapter is implemented, so connector facts cannot be '
      + 'verified and writes stay blocked.'
  );
}

module.exports = {
  READINESS_RESOLVER,
  READINESS_EXPRESSION,
  AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE,
  bindReadinessResponse,
  normalizeReadinessResponse,
  normalizeExpectedIdentity,
  readForgeAdminReadiness,
};
