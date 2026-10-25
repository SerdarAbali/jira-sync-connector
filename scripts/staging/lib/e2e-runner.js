'use strict';

/**
 * Write-enabled staging E2E runner.
 *
 * Every mutation is gated behind three independent conditions: an authorized
 * --write confirmation, a validated connector readiness attestation, and live
 * read-only Jira prerequisite checks. Assertions are made against the
 * destination site, never against the connector's own bookkeeping, and only
 * run-owned fixtures are ever deleted.
 */

const crypto = require('crypto');

const {
  JiraWriteClient,
  adfToText,
  buildMarkerJql,
  matchingIssues,
  pollUntil,
  summarizeIssue,
  textToAdf,
} = require('./e2e-api');
const { EXPECTED_APP_ID, loadEvidence, validateReadiness } = require('./e2e-evidence');
const {
  AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE,
  readForgeAdminReadiness,
} = require('./forge-admin-readiness');
const { collectCredentialSecrets, redactText } = require('./redact');

const REPORT_KIND = 'jira-sync-staging-e2e';
const REPORT_SCHEMA_VERSION = '1.0';
const E2E_EXIT_CODES = { PASS: 0, FAIL: 1, ERROR: 2, INTERRUPTED: 2, BLOCKED: 3 };
const MARKER_PREFIX = 'staging-e2e';
const IDENTITY_FIELDS = ['summary', 'status', 'issuetype', 'description', 'created', 'updated'];
const CLEANUP_INCOMPLETE_STATUSES = new Set([
  'failed',
  'retained-unowned-children',
  'retained-uncertain',
]);

function iso(ms) {
  return new Date(ms).toISOString();
}

function createRunId(nowMs, random = crypto.randomBytes) {
  const stamp = iso(nowMs).replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const suffix = random(3).toString('hex');
  return `${MARKER_PREFIX}-${stamp.toLowerCase()}-${suffix}`;
}

function createMarker(runId, label, random = crypto.randomBytes) {
  const suffix = random(2).toString('hex');
  return `${runId}-${label}-${suffix}`.toLowerCase();
}

function assertion(id, status, detail, evidence) {
  return {
    id,
    status,
    detail,
    evidence: evidence === undefined ? null : evidence,
  };
}

function scenarioResult(definition) {
  return {
    id: definition.id,
    direction: definition.direction,
    required: definition.required === true,
    status: 'skipped',
    reason: null,
    assertions: [],
    durationMs: 0,
  };
}

function buildScenarioDefinitions(readiness) {
  const bidirectional = readiness.summary?.selected?.syncDirection === 'bidirectional';
  const syncComments = readiness.summary?.syncComments === true;
  return [
    {
      id: 'local-issue-created-and-synced',
      direction: 'local-to-remote',
      required: true,
    },
    {
      id: 'field-update-propagates',
      direction: 'local-to-remote',
      required: true,
    },
    {
      id: 'status-transition-propagates',
      direction: 'local-to-remote',
      required: true,
    },
    {
      id: 'public-comment-propagates',
      direction: 'local-to-remote',
      required: syncComments,
    },
    {
      id: 'remote-issue-created-and-synced',
      direction: 'remote-to-local',
      required: bidirectional,
    },
    {
      id: 'remote-public-comment-propagates',
      direction: 'remote-to-local',
      required: bidirectional && syncComments,
    },
    {
      id: 'no-duplicate-counterparts',
      direction: 'both',
      required: true,
    },
  ];
}

function scenarioById(results, id) {
  return results.find((entry) => entry.id === id);
}

function markSkipped(results, ids, reason) {
  ids.forEach((id) => {
    const entry = scenarioById(results, id);
    if (entry && entry.status === 'skipped' && !entry.reason) {
      entry.reason = reason;
    }
  });
}

function markUnknown(results, ids, reason) {
  ids.forEach((id) => {
    const entry = scenarioById(results, id);
    if (entry && entry.status === 'skipped') {
      entry.status = 'unknown';
      entry.reason = reason;
    }
  });
}

function redactError(error, secrets = []) {
  if (!error) {
    return { code: 'unknown-error', message: 'Unknown failure.', status: null };
  }
  const message = typeof error.message === 'string' ? error.message : 'Unknown failure.';
  return {
    code: typeof error.code === 'string' ? error.code : 'unknown-error',
    message: redactText(message, secrets).slice(0, 300),
    status: Number.isInteger(error.status) ? error.status : null,
    outcomeUnknown: error.outcomeUnknown === true,
  };
}

function interruptionError() {
  const error = new Error('The run was interrupted by an operator signal.');
  error.code = 'run-interrupted';
  error.interrupted = true;
  return error;
}

function isInterrupted(ctx) {
  return typeof ctx.interrupted === 'function' ? ctx.interrupted() === true : false;
}

/**
 * Guards a mutation boundary. Once an interruption is recorded no new scenario
 * write may start; only already-started work and bounded run-owned cleanup may
 * finish.
 */
function assertNotInterrupted(ctx) {
  if (isInterrupted(ctx)) {
    throw interruptionError();
  }
}

function makeSiteClient(role, config, settings, options) {
  const site = config[role];
  return new JiraWriteClient({
    site,
    label: role,
    email: site.email,
    apiToken: site.apiToken,
    allowedProjectKeys: site.stagingProjects,
    maxMutations: settings.maxMutations,
    maxRetries: config.maxRetries,
    retryMaxWaitMs: config.retryMaxWaitMs,
    timeoutMs: config.requestTimeoutMs,
    request: options.request,
    now: options.now,
    sleep: options.sleep,
    // The client re-checks the same predicate before every attempt, so an
    // interruption also stops transport retries that the run loop cannot see.
    isInterrupted: options.isInterrupted,
  });
}

function pickIssueType(issueTypes, name) {
  const wanted = String(name || '').trim().toLowerCase();
  return (Array.isArray(issueTypes) ? issueTypes : []).find(
    (entry) =>
      entry &&
      entry.subtask !== true &&
      typeof entry.name === 'string' &&
      entry.name.trim().toLowerCase() === wanted
  );
}

function statusNamesFromProjectStatuses(entries, issueTypeName) {
  const match = (Array.isArray(entries) ? entries : []).find(
    (entry) =>
      typeof entry?.name === 'string' &&
      entry.name.toLowerCase() === String(issueTypeName).toLowerCase()
  );
  const statuses = Array.isArray(match?.statuses) ? match.statuses : [];
  return statuses
    .filter((entry) => typeof entry?.name === 'string')
    .map((entry) => entry.name);
}

function siteUrlLabel(site) {
  return site && site.host ? site.host : 'unconfigured';
}

function boundedList(values, limit = 12) {
  const list = Array.isArray(values) ? values : [];
  const shown = list.slice(0, limit);
  return list.length > limit ? `${shown.join(', ')} (+${list.length - limit} more)` : shown.join(', ');
}

async function checkIdentity(ctx, role) {
  const client = ctx.clients[role];
  const body = await client.getMyself();
  const accountId = typeof body?.accountId === 'string' ? body.accountId : null;
  const active = body?.active !== false;
  return {
    id: `${role}.identity`,
    scope: role,
    status: accountId && active ? 'pass' : 'fail',
    detail: accountId && active
      ? `Authenticated as an active account on ${siteUrlLabel(ctx.config[role])}.`
      : 'The credential did not resolve to an active Jira account.',
    evidence: {
      accountId,
      displayName: typeof body?.displayName === 'string' ? body.displayName : null,
      active,
      host: siteUrlLabel(ctx.config[role]),
    },
  };
}

async function checkProjectAccess(ctx, role, projectKey) {
  const client = ctx.clients[role];
  const body = await client.getProject(projectKey);
  const matches = typeof body?.key === 'string' && body.key.toUpperCase() === projectKey.toUpperCase();
  return {
    id: `${role}.project-access`,
    scope: role,
    status: matches ? 'pass' : 'fail',
    detail: matches
      ? `The ${role} credential can read project ${projectKey}.`
      : `The ${role} credential could not read project ${projectKey}.`,
    evidence: {
      requestedProject: projectKey,
      resolvedKey: typeof body?.key === 'string' ? body.key : null,
      projectId: typeof body?.id === 'string' ? body.id : null,
      projectTypeKey: typeof body?.projectTypeKey === 'string' ? body.projectTypeKey : null,
    },
  };
}

async function checkPermissions(ctx, role, projectKey, permissions) {
  const client = ctx.clients[role];
  const granted = await client.getPermissions(projectKey, permissions);
  const missing = permissions.filter((name) => granted?.[name]?.havePermission !== true);
  return {
    id: `${role}.permissions`,
    scope: role,
    status: missing.length === 0 ? 'pass' : 'fail',
    detail: missing.length === 0
      ? `All ${permissions.length} required permissions are granted on ${projectKey}.`
      : `Missing permission(s) on ${projectKey}: ${missing.join(', ')}.`,
    evidence: {
      projectKey,
      required: permissions,
      missing,
    },
  };
}

async function checkIssueType(ctx, role, projectKey) {
  const client = ctx.clients[role];
  const page = await client.getCreateMetaIssueTypes(projectKey);
  const issueTypes = Array.isArray(page.issueTypes) ? page.issueTypes : [];
  const match = pickIssueType(issueTypes, ctx.settings.issueType);
  if (match && page.complete) {
    ctx.issueTypes[role] = { id: String(match.id), name: match.name };
  }
  if (!page.complete) {
    return {
      id: `${role}.issue-type`,
      scope: role,
      status: 'unknown',
      detail: `The creatable issue types for ${projectKey} could not be read completely (${page.reason}).`,
      evidence: {
        projectKey,
        requested: ctx.settings.issueType,
        pagination: { reason: page.reason, detail: page.detail },
      },
    };
  }
  const available = issueTypes
    .filter((entry) => entry && entry.subtask !== true)
    .map((entry) => entry.name)
    .filter((name) => typeof name === 'string');
  return {
    id: `${role}.issue-type`,
    scope: role,
    status: match ? 'pass' : 'fail',
    detail: match
      ? `Issue type "${match.name}" is creatable in ${projectKey}.`
      : `Issue type "${ctx.settings.issueType}" is not creatable in ${projectKey}. Available: ${boundedList(available)}.`,
    evidence: {
      projectKey,
      requested: ctx.settings.issueType,
      resolved: match ? { id: String(match.id), name: match.name } : null,
      available: available.slice(0, 25),
    },
  };
}

function remotePermissionSet(settings, syncDirection) {
  if (syncDirection === 'bidirectional') {
    return settings.requiredPermissions;
  }
  return ['BROWSE_PROJECTS', 'DELETE_ISSUES'];
}

async function runPrerequisites(ctx) {
  const { settings, config } = ctx;
  const localKey = ctx.pair.localProjectKey;
  const remoteKey = ctx.pair.remoteProjectKey;
  const syncDirection = ctx.pair.syncDirection;
  const checks = [];

  checks.push(await checkIdentity(ctx, 'local'));
  checks.push(await checkIdentity(ctx, 'remote'));
  checks.push(await checkProjectAccess(ctx, 'local', localKey));
  checks.push(await checkProjectAccess(ctx, 'remote', remoteKey));
  checks.push(
    await checkPermissions(ctx, 'local', localKey, settings.requiredPermissions)
  );

  const remotePermissions = remotePermissionSet(settings, syncDirection);
  checks.push(await checkPermissions(ctx, 'remote', remoteKey, remotePermissions));
  checks.push(await checkIssueType(ctx, 'local', localKey));

  if (syncDirection === 'bidirectional') {
    checks.push(await checkIssueType(ctx, 'remote', remoteKey));
  } else if (config.remote?.stagingProjects?.length) {
    checks.push({
      id: 'remote.issue-type',
      scope: 'remote',
      status: 'skipped',
      detail: 'Reverse-direction scenarios are disabled for push-only synchronization.',
      evidence: { projectKey: remoteKey, syncDirection },
    });
  }

  checks.forEach((entry) => {
    if (entry.status !== 'skipped') {
      ctx.prerequisites.push(entry);
    }
  });

  const incomplete = checks.filter((entry) => entry.status === 'unknown');
  return {
    ok: checks.every((entry) => entry.status !== 'fail'),
    complete: incomplete.length === 0,
    incomplete: incomplete.map((entry) => entry.id),
  };
}


function runnerError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function finalizeScenario(entry) {
  const failures = entry.assertions.filter((item) => item.status === 'fail');
  const unknowns = entry.assertions.filter((item) => item.status === 'unknown');
  if (failures.length > 0) {
    entry.status = 'fail';
    entry.reason = entry.reason || failures[0].detail;
  } else if (unknowns.length > 0) {
    entry.status = 'unknown';
    entry.reason = entry.reason || unknowns[0].detail;
  } else if (entry.assertions.length === 0) {
    entry.status = 'unknown';
    entry.reason = entry.reason || 'No assertion was evaluated.';
  } else {
    entry.status = 'pass';
    entry.reason = null;
  }
  return entry;
}

function registerFixture(ctx, fixture) {
  const entry = {
    flow: fixture.flow,
    role: fixture.role,
    key: fixture.key,
    marker: fixture.marker,
    ownership: 'run',
    recoveredFromAmbiguousResponse: fixture.recovered === true,
    cleanup: { status: 'pending', detail: null },
  };
  ctx.fixtures.push(entry);
  return entry;
}

async function searchMarker(ctx, role, projectKey, marker) {
  const client = ctx.clients[role];
  const jql = buildMarkerJql(projectKey, marker);
  const page = await client.searchIssues(jql);
  return {
    matches: page.complete ? matchingIssues(page.issues, marker) : [],
    complete: page.complete === true,
    reason: page.reason || null,
    detail: page.detail || null,
    scanned: Array.isArray(page.issues) ? page.issues.length : 0,
  };
}

async function waitForMarker(ctx, role, projectKey, marker, describe) {
  return pollUntil({
    check: () => searchMarker(ctx, role, projectKey, marker),
    isDone: (result) => result.complete === true && result.matches.length > 0,
    isAborted: () => isInterrupted(ctx),
    timeoutMs: ctx.settings.syncTimeoutMs,
    maxAttempts: ctx.settings.maxPolls,
    initialDelayMs: ctx.settings.pollIntervalMs,
    maxDelayMs: ctx.settings.pollMaxIntervalMs,
    now: ctx.now,
    sleep: ctx.sleep,
    describe,
  });
}

async function recoverFixture(ctx, role, projectKey, marker, flow) {
  const wait = await pollUntil({
    check: () => searchMarker(ctx, role, projectKey, marker),
    isDone: (result) => result.complete === true && result.matches.length > 0,
    isAborted: () => isInterrupted(ctx),
    timeoutMs: Math.min(ctx.settings.syncTimeoutMs, 30000),
    maxAttempts: Math.min(ctx.settings.maxPolls, 15),
    initialDelayMs: ctx.settings.pollIntervalMs,
    maxDelayMs: ctx.settings.pollMaxIntervalMs,
    now: ctx.now,
    sleep: ctx.sleep,
    describe: `a ${role} ${flow} fixture whose summary contains ${marker}`,
  });
  if (wait.aborted) {
    throw interruptionError();
  }
  return wait.ok && wait.value.matches.length === 1 ? wait.value.matches[0] : null;
}

async function createFixtureIssue(ctx, role, input) {
  const client = ctx.clients[role];
  const projectKey = input.projectKey;
  try {
    const created = await client.createIssue(input);
    if (!created || typeof created.key !== 'string' || !created.key) {
      throw runnerError(
        'create-response-invalid',
        'Jira accepted the create request but returned no issue key.',
        { outcomeUnknown: true }
      );
    }
    return { key: created.key, id: typeof created.id === 'string' ? created.id : null, recovered: false };
  } catch (error) {
    if (error.outcomeUnknown !== true) {
      throw error;
    }
    const recovered = await recoverFixture(ctx, role, projectKey, input.marker, input.flow);
    if (!recovered) {
      throw error;
    }
    return { key: recovered.key, id: recovered.id || null, recovered: true };
  }
}

function makeFlowContext(ctx, options) {
  return {
    flow: options.flow,
    marker: options.marker,
    direction: options.direction,
    sourceRole: options.sourceRole,
    destinationRole: options.destinationRole,
    sourceProject: options.sourceProject,
    destinationProject: options.destinationProject,
    source: { key: null, issue: null },
    destination: { key: null, issue: null },
  };
}

async function assertCounterpart(ctx, flowContext, scenario) {
  const { destinationRole, destinationProject, marker } = flowContext;
  const wait = await waitForMarker(
    ctx,
    destinationRole,
    destinationProject,
    marker,
    `the ${destinationRole} counterpart for ${marker}`
  );

  if (wait.aborted) {
    scenario.assertions.push(
      assertion(
        'counterpart-exists',
        'unknown',
        'The run was interrupted before a destination counterpart could be confirmed.',
        { destinationRole, projectKey: destinationProject, marker, aborted: true }
      )
    );
    throw interruptionError();
  }

  const result = wait.value || { matches: [], complete: false };
  const matches = result.complete ? result.matches : [];
  const counterpart = matches[0] || null;
  if (counterpart) {
    flowContext.destination.key = counterpart.key;
    flowContext.destination.issue = counterpart;
    registerFixture(ctx, {
      flow: flowContext.flow,
      role: destinationRole,
      key: counterpart.key,
      marker,
    });
  }

  scenario.assertions.push(
    assertion(
      'counterpart-exists',
      counterpart ? 'pass' : result.complete ? 'fail' : 'unknown',
      counterpart
        ? `The ${destinationRole} site contains issue ${counterpart.key} for marker ${marker}.`
        : result.complete
          ? `No ${destinationRole} issue contained marker ${marker} within ${ctx.settings.syncTimeoutMs} ms (${wait.attempts} polls).`
          : `The ${destinationRole} search for marker ${marker} was incomplete (${result.reason}), so a counterpart cannot be confirmed or ruled out.`,
      {
        destinationRole,
        projectKey: destinationProject,
        marker,
        polls: wait.attempts,
        elapsedMs: wait.elapsedMs,
        timedOut: wait.timedOut,
        pagination: result.complete ? null : { reason: result.reason, detail: result.detail },
        matches: matches.map((entry) => entry.key),
      }
    )
  );

  return counterpart;
}


async function propagateFieldUpdate(ctx, flow, scenario, baselineText) {
  assertNotInterrupted(ctx);
  const token = `field-update-${flow.marker}`;
  const updatedText = `${baselineText}\n${token}`;

  try {
    await ctx.clients[flow.sourceRole].updateIssueDescription(
      flow.source.key,
      textToAdf(updatedText)
    );
  } catch (error) {
    const failure = redactError(error, ctx.secrets);
    scenario.assertions.push(
      assertion('source-description-updated', 'fail', failure.message, failure)
    );
    return;
  }

  scenario.assertions.push(
    assertion(
      'source-description-updated',
      'pass',
      `Updated the description on ${flow.sourceRole} issue ${flow.source.key}.`,
      { sourceRole: flow.sourceRole, issueKey: flow.source.key, marker: token }
    )
  );

  const wait = await pollUntil({
    check: async () => {
      const body = await ctx.clients[flow.destinationRole].getIssue(
        flow.destination.key,
        IDENTITY_FIELDS
      );
      return summarizeIssue(body);
    },
    isDone: (issue) =>
      typeof issue?.descriptionText === 'string' && issue.descriptionText.includes(token),
    isAborted: () => isInterrupted(ctx),
    timeoutMs: ctx.settings.syncTimeoutMs,
    maxAttempts: ctx.settings.maxPolls,
    initialDelayMs: ctx.settings.pollIntervalMs,
    maxDelayMs: ctx.settings.pollMaxIntervalMs,
    now: ctx.now,
    sleep: ctx.sleep,
    describe: `the ${flow.destinationRole} description to contain ${token}`,
  });

  if (wait.aborted) {
    scenario.assertions.push(
      assertion(
        'destination-description-updated',
        'unknown',
        'The run was interrupted while waiting for the destination description update.',
        { destinationRole: flow.destinationRole, issueKey: flow.destination.key, marker: token }
      )
    );
    throw interruptionError();
  }

  const observed = wait.value || null;
  scenario.assertions.push(
    assertion(
      'destination-description-updated',
      wait.ok ? 'pass' : 'fail',
      wait.ok
        ? `The ${flow.destinationRole} description on ${flow.destination.key} contains the update token.`
        : `The ${flow.destinationRole} description on ${flow.destination.key} did not contain the update token within ${ctx.settings.syncTimeoutMs} ms (${wait.attempts} polls).`,
      {
        destinationRole: flow.destinationRole,
        issueKey: flow.destination.key,
        marker: token,
        polls: wait.attempts,
        elapsedMs: wait.elapsedMs,
        timedOut: wait.timedOut,
        observedDescriptionLength: observed?.descriptionText
          ? observed.descriptionText.length
          : null,
      }
    )
  );

  const summaryPreserved =
    Boolean(observed) && observed.summary === flow.source.issue?.summary;
  scenario.assertions.push(
    assertion(
      'destination-summary-preserved',
      summaryPreserved ? 'pass' : 'fail',
      summaryPreserved
        ? 'The update did not alter the destination summary.'
        : 'The destination summary changed or became unreadable during the field-update scenario.',
      {
        destinationSummary: observed ? observed.summary : null,
        sourceSummary: flow.source.issue ? flow.source.issue.summary : null,
      }
    )
  );
}


async function propagateTransition(ctx, flow, scenario) {
  assertNotInterrupted(ctx);
  const sourceClient = ctx.clients[flow.sourceRole];
  const destinationClient = ctx.clients[flow.destinationRole];

  const destinationBefore = summarizeIssue(
    await destinationClient.getIssue(flow.destination.key, IDENTITY_FIELDS)
  );
  const sourceTransitions = await sourceClient.getTransitions(flow.source.key);
  const destinationTransitions = await destinationClient.getTransitions(flow.destination.key);

  const destinationTargets = new Set(
    destinationTransitions
      .map((entry) => entry?.to?.name)
      .filter((name) => typeof name === 'string')
  );
  const candidates = sourceTransitions.filter((entry) => {
    const target = entry?.to?.name;
    return (
      typeof target === 'string' &&
      destinationTargets.has(target) &&
      target !== destinationBefore.statusName
    );
  });
  const chosen = candidates[0] || null;

  scenario.assertions.push(
    assertion(
      'shared-transition-target',
      chosen ? 'pass' : 'unknown',
      chosen
        ? `Both workflows can reach status "${chosen.to.name}".`
        : 'No source transition targets a status name that the destination can also reach.',
      {
        sourceStatus: flow.source.issue ? flow.source.issue.statusName : null,
        destinationStatus: destinationBefore.statusName,
        sourceTargets: sourceTransitions
          .map((entry) => entry?.to?.name)
          .filter((name) => typeof name === 'string')
          .slice(0, 15),
        destinationTargets: [...destinationTargets].slice(0, 15),
      }
    )
  );

  if (!chosen) {
    return;
  }

  try {
    await sourceClient.transitionIssue(flow.source.key, chosen.id);
  } catch (error) {
    const failure = redactError(error, ctx.secrets);
    scenario.assertions.push(
      assertion('source-transition-applied', 'fail', failure.message, failure)
    );
    return;
  }

  scenario.assertions.push(
    assertion(
      'source-transition-applied',
      'pass',
      `Applied transition "${chosen.name}" to ${flow.sourceRole} issue ${flow.source.key}.`,
      {
        sourceRole: flow.sourceRole,
        issueKey: flow.source.key,
        transitionId: String(chosen.id),
        transitionName: typeof chosen.name === 'string' ? chosen.name : null,
        targetStatus: chosen.to.name,
      }
    )
  );

  const wait = await pollUntil({
    check: async () => {
      const body = await destinationClient.getIssue(flow.destination.key, IDENTITY_FIELDS);
      return summarizeIssue(body);
    },
    isDone: (issue) => issue?.statusName === chosen.to.name,
    isAborted: () => isInterrupted(ctx),
    timeoutMs: ctx.settings.syncTimeoutMs,
    maxAttempts: ctx.settings.maxPolls,
    initialDelayMs: ctx.settings.pollIntervalMs,
    maxDelayMs: ctx.settings.pollMaxIntervalMs,
    now: ctx.now,
    sleep: ctx.sleep,
    describe: `the ${flow.destinationRole} status to become ${chosen.to.name}`,
  });

  if (wait.aborted) {
    scenario.assertions.push(
      assertion(
        'destination-status-matched',
        'unknown',
        'The run was interrupted while waiting for the destination status change.',
        {
          destinationRole: flow.destinationRole,
          issueKey: flow.destination.key,
          expectedStatus: chosen.to.name,
        }
      )
    );
    throw interruptionError();
  }

  const observedStatus = wait.value ? wait.value.statusName : null;
  const changed =
    typeof observedStatus === 'string' && observedStatus !== destinationBefore.statusName;

  scenario.assertions.push(
    assertion(
      'destination-status-matched',
      wait.ok ? 'pass' : 'fail',
      wait.ok
        ? `The ${flow.destinationRole} issue reached status "${chosen.to.name}".`
        : `The ${flow.destinationRole} issue is "${observedStatus}" instead of "${chosen.to.name}" after ${wait.attempts} polls.`,
      {
        destinationRole: flow.destinationRole,
        issueKey: flow.destination.key,
        expectedStatus: chosen.to.name,
        observedStatus,
        previousStatus: destinationBefore.statusName,
        polls: wait.attempts,
        elapsedMs: wait.elapsedMs,
        timedOut: wait.timedOut,
      }
    )
  );

  scenario.assertions.push(
    assertion(
      'destination-status-changed',
      changed ? 'pass' : 'fail',
      changed
        ? 'The destination status changed during the scenario.'
        : 'The destination status did not change, so the transition was not observed.',
      { previousStatus: destinationBefore.statusName, observedStatus }
    )
  );
}


async function propagateComment(ctx, flow, scenario) {
  assertNotInterrupted(ctx);
  const token = `comment-${flow.marker}`;
  // The token is embedded in the body so a copied comment is unambiguous.
  const bodyText = `Staging E2E public comment for ${flow.marker} [${token}]`;

  try {
    await ctx.clients[flow.sourceRole].addComment(flow.source.key, textToAdf(bodyText));
  } catch (error) {
    const failure = redactError(error, ctx.secrets);
    scenario.assertions.push(assertion('source-comment-created', 'fail', failure.message, failure));
    return;
  }

  scenario.assertions.push(
    assertion(
      'source-comment-created',
      'pass',
      `Added a public comment to ${flow.sourceRole} issue ${flow.source.key}.`,
      { sourceRole: flow.sourceRole, issueKey: flow.source.key, marker: token }
    )
  );

  const containsToken = (comment) =>
    adfToText(comment?.body).toLowerCase().includes(token.toLowerCase());

  const wait = await pollUntil({
    check: async () => ctx.clients[flow.destinationRole].getComments(flow.destination.key),
    isDone: (page) =>
      page?.complete === true &&
      Array.isArray(page.comments) &&
      page.comments.some(containsToken),
    isAborted: () => isInterrupted(ctx),
    timeoutMs: ctx.settings.syncTimeoutMs,
    maxAttempts: ctx.settings.maxPolls,
    initialDelayMs: ctx.settings.pollIntervalMs,
    maxDelayMs: ctx.settings.pollMaxIntervalMs,
    now: ctx.now,
    sleep: ctx.sleep,
    describe: `the ${flow.destinationRole} comment containing ${token}`,
  });

  if (wait.aborted) {
    scenario.assertions.push(
      assertion(
        'destination-comment-synced',
        'unknown',
        'The run was interrupted while waiting for the destination comment.',
        { destinationRole: flow.destinationRole, issueKey: flow.destination.key, marker: token }
      )
    );
    throw interruptionError();
  }

  const page = wait.value || { comments: [], complete: false, reason: 'pagination-metadata-inconsistent' };
  const comments = Array.isArray(page.comments) ? page.comments : [];
  const matches = comments.filter(containsToken);
  const restricted = matches.filter(
    (comment) => comment?.visibility && Object.keys(comment.visibility).length > 0
  );
  const complete = page.complete === true;

  scenario.assertions.push(
    assertion(
      'destination-comment-synced',
      complete && wait.ok ? 'pass' : complete ? 'fail' : 'unknown',
      complete
        ? wait.ok
          ? `The ${flow.destinationRole} issue ${flow.destination.key} has a comment carrying the marker.`
          : `No ${flow.destinationRole} comment carried the marker within ${ctx.settings.syncTimeoutMs} ms (${wait.attempts} polls).`
        : `The comment page for ${flow.destination.key} was incomplete (${page.reason}), so the marker cannot be confirmed or ruled out.`,
      {
        destinationRole: flow.destinationRole,
        issueKey: flow.destination.key,
        marker: token,
        matches: matches.length,
        totalComments: comments.length,
        polls: wait.attempts,
        elapsedMs: wait.elapsedMs,
        timedOut: wait.timedOut,
        pagination: complete ? null : { reason: page.reason, detail: page.detail || null },
      }
    )
  );

  scenario.assertions.push(
    assertion(
      'destination-comment-unique',
      !complete ? 'unknown' : matches.length === 1 ? 'pass' : 'fail',
      !complete
        ? 'Comment uniqueness cannot be established from an incomplete comment page.'
        : matches.length === 1
          ? 'Exactly one destination comment carries the marker.'
          : `Expected exactly one destination comment with the marker, observed ${matches.length}.`,
      { marker: token, matches: matches.length, complete }
    )
  );

  let visibilityStatus = 'fail';
  let visibilityDetail = 'No destination comment was available to inspect for visibility.';
  if (!complete) {
    visibilityStatus = 'unknown';
    visibilityDetail = 'Comment visibility cannot be established from an incomplete comment page.';
  } else if (matches.length > 0 && restricted.length === 0) {
    visibilityStatus = 'pass';
    visibilityDetail = 'The synchronized comment has no visibility restriction.';
  } else if (restricted.length > 0) {
    visibilityDetail = 'The synchronized comment carries a visibility restriction.';
  }
  scenario.assertions.push(
    assertion('destination-comment-is-public', visibilityStatus, visibilityDetail, {
      restrictedMatches: restricted.length,
      visibility: restricted.map((comment) => comment.visibility || null).slice(0, 3),
      complete,
    })
  );
}


function scenarioTiming(ctx, scenario, startedAt) {
  scenario.durationMs = ctx.now() - startedAt;
}

function applyStepFailure(ctx, scenario, error) {
  const failure = redactError(error, ctx.secrets);
  scenario.assertions.push(assertion('step-error', 'unknown', failure.message, failure));
}

async function runFlow(ctx, options) {
  const marker = createMarker(ctx.runId, options.flowName, ctx.random);
  const flow = makeFlowContext(ctx, {
    flow: options.flowName,
    marker,
    direction: options.direction,
    sourceRole: options.sourceRole,
    destinationRole: options.destinationRole,
    sourceProject: options.sourceProject,
    destinationProject: options.destinationProject,
  });
  const startedAt = ctx.now();
  const baselineText = `Staging E2E ${options.flowName} baseline ${marker}`;
  const createdScenario = scenarioById(ctx.results, options.createdScenario);
  const sourceClient = ctx.clients[options.sourceRole];

  let created;
  try {
    created = await createFixtureIssue(ctx, options.sourceRole, {
      projectKey: flow.sourceProject,
      issueTypeId: ctx.issueTypes[options.sourceRole].id,
      summary: `[staging-e2e] ${marker}`,
      description: textToAdf(baselineText),
      marker,
      flow: options.flowName,
    });
  } catch (error) {
    const failure = redactError(error);
    createdScenario.assertions.push(
      assertion('source-create', 'fail', failure.message, failure)
    );
    finalizeScenario(createdScenario);
    scenarioTiming(ctx, createdScenario, startedAt);
    markUnknown(ctx.results, options.dependentScenarios, 'The run fixture could not be created.');
    return { flow, failure };
  }

  flow.source.key = created.key;
  registerFixture(ctx, {
    flow: options.flowName,
    role: options.sourceRole,
    key: created.key,
    marker,
    recovered: created.recovered,
  });

  createdScenario.assertions.push(
    assertion(
      'source-create',
      'pass',
      created.recovered
        ? `Recovered ${options.sourceRole} issue ${created.key} after an ambiguous create response.`
        : `Created ${options.sourceRole} issue ${created.key}.`,
      {
        sourceRole: options.sourceRole,
        issueKey: created.key,
        marker,
        recoveredFromAmbiguousResponse: created.recovered,
      }
    )
  );

  if (isInterrupted(ctx)) {
    const failure = redactError(interruptionError(), ctx.secrets);
    createdScenario.assertions.push(
      assertion(
        'run-interrupted',
        'unknown',
        `The run was interrupted after creating ${options.sourceRole} issue ${created.key}; no further write was started.`,
        { sourceRole: options.sourceRole, issueKey: created.key, code: failure.code }
      )
    );
    finalizeScenario(createdScenario);
    scenarioTiming(ctx, createdScenario, startedAt);
    markSkipped(
      ctx.results,
      ctx.results.map((entry) => entry.id),
      'Interrupted before this scenario started.'
    );
    return { flow, failure, interrupted: true };
  }

  let sourceIssue;
  try {
    sourceIssue = summarizeIssue(await sourceClient.getIssue(created.key, IDENTITY_FIELDS));
  } catch (error) {
    const failure = redactError(error);
    createdScenario.assertions.push(
      assertion('source-readable', 'fail', failure.message, failure)
    );
    finalizeScenario(createdScenario);
    scenarioTiming(ctx, createdScenario, startedAt);
    markUnknown(ctx.results, options.dependentScenarios, 'The run fixture could not be re-read.');
    return { flow, failure };
  }

  flow.source.issue = sourceIssue;
  createdScenario.assertions.push(
    assertion(
      'source-readable',
      sourceIssue.key === created.key ? 'pass' : 'fail',
      `Read back ${options.sourceRole} issue ${sourceIssue.key || created.key}.`,
      { issueKey: sourceIssue.key, status: sourceIssue.statusName, summary: sourceIssue.summary }
    )
  );

  let counterpart = null;
  try {
    counterpart = await assertCounterpart(ctx, flow, createdScenario);
  } catch (error) {
    const failure = redactError(error);
    createdScenario.assertions.push(
      assertion('counterpart-exists', 'unknown', failure.message, failure)
    );
  }
  if (counterpart) {
    const summaryMatches = counterpart.summary === sourceIssue.summary;
    createdScenario.assertions.push(
      assertion(
        'summary-mirrored',
        summaryMatches ? 'pass' : 'fail',
        summaryMatches
          ? 'The destination summary matches the source summary.'
          : 'The destination summary differs from the source summary.',
        { sourceSummary: sourceIssue.summary, destinationSummary: counterpart.summary }
      )
    );

    const projectMatches =
      typeof counterpart.projectKey === 'string' &&
      counterpart.projectKey.toUpperCase() === flow.destinationProject.toUpperCase();
    createdScenario.assertions.push(
      assertion(
        'destination-project-matches',
        projectMatches ? 'pass' : 'fail',
        projectMatches
          ? `The counterpart lives in ${flow.destinationProject}.`
          : `The counterpart lives in ${counterpart.projectKey || 'an unknown project'}.`,
        { expectedProject: flow.destinationProject, observedProject: counterpart.projectKey }
      )
    );

    createdScenario.assertions.push(
      assertion(
        'destination-issue-type-present',
        counterpart.issueTypeName ? 'pass' : 'unknown',
        counterpart.issueTypeName
          ? `The counterpart uses issue type "${counterpart.issueTypeName}".`
          : 'The destination issue type could not be read.',
        {
          issueTypeId: counterpart.issueTypeId,
          issueTypeName: counterpart.issueTypeName,
          expectedSourceType: ctx.issueTypes[options.sourceRole].name,
        }
      )
    );
  }

  finalizeScenario(createdScenario);


  if (!counterpart) {
    markUnknown(ctx.results, options.dependentScenarios, 'No destination counterpart was found.');
    scenarioTiming(ctx, createdScenario, startedAt);
    return { flow, failure: null };
  }

  const stepIds = [
    ['field-update-propagates', options.fieldUpdate === true],
    ['status-transition-propagates', options.transition === true],
    [
      options.flowName === 'forward'
        ? 'public-comment-propagates'
        : 'remote-public-comment-propagates',
      options.comment === true,
    ],
  ];

  for (const [id, enabled] of stepIds) {
    const scenario = scenarioById(ctx.results, id);
    if (!scenario || !enabled || scenario.status !== 'skipped') {
      continue;
    }
    if (isInterrupted(ctx)) {
      markSkipped(
        ctx.results,
        ctx.results.map((entry) => entry.id),
        'Interrupted before this scenario started.'
      );
      break;
    }
    const stepStartedAt = ctx.now();
    try {
      if (id === 'field-update-propagates') {
        await propagateFieldUpdate(ctx, flow, scenario, baselineText);
      } else if (id === 'status-transition-propagates') {
        await propagateTransition(ctx, flow, scenario);
      } else {
        await propagateComment(ctx, flow, scenario);
      }
      finalizeScenario(scenario);
    } catch (error) {
      applyStepFailure(ctx, scenario, error);
      scenario.status = 'unknown';
      scenario.reason = redactError(error, ctx.secrets).message;
      if (error && error.interrupted) {
        markSkipped(
          ctx.results,
          ctx.results.map((entry) => entry.id),
          'Interrupted before this scenario started.'
        );
        scenarioTiming(ctx, scenario, stepStartedAt);
        break;
      }
    }
    scenarioTiming(ctx, scenario, stepStartedAt);
  }

  scenarioTiming(ctx, createdScenario, startedAt);
  return { flow, failure: null };
}

async function runDuplicateChecks(ctx, flows) {
  const scenario = scenarioById(ctx.results, 'no-duplicate-counterparts');
  const startedAt = ctx.now();
  const settleMs = ctx.settings.duplicateSettleMs;
  if (settleMs > 0) {
    await ctx.sleep(settleMs);
  }

  for (const flow of flows) {
    if (isInterrupted(ctx)) {
      markSkipped(
        ctx.results,
        ['no-duplicate-counterparts'],
        'Interrupted before this scenario started.'
      );
      break;
    }
    if (!flow || !flow.destination.key) {
      scenario.assertions.push(
        assertion(
          `${flow ? flow.flow : 'unknown'}-single-counterpart`,
          'unknown',
          'No destination counterpart exists, so duplication could not be evaluated.',
          { flow: flow ? flow.flow : null, marker: flow ? flow.marker : null }
        )
      );
      continue;
    }

    let result;
    try {
      result = await searchMarker(
        ctx,
        flow.destinationRole,
        flow.destinationProject,
        flow.marker
      );
    } catch (error) {
      const failure = redactError(error, ctx.secrets);
      scenario.assertions.push(
        assertion(
          `${flow.flow}-single-counterpart`,
          'unknown',
          failure.message,
          failure
        )
      );
      continue;
    }

    if (!result.complete) {
      scenario.assertions.push(
        assertion(
          `${flow.flow}-single-counterpart`,
          'unknown',
          `The duplicate check for marker ${flow.marker} was incomplete (${result.reason}); uniqueness cannot be established from partial search results.`,
          {
            flow: flow.flow,
            destinationRole: flow.destinationRole,
            projectKey: flow.destinationProject,
            marker: flow.marker,
            expectedKey: flow.destination.key,
            pagination: { reason: result.reason, detail: result.detail },
            scannedIssues: result.scanned,
            settleMs,
          }
        )
      );
      continue;
    }

    const matches = result.matches;
    const uniqueKeys = [...new Set(matches.map((entry) => entry.key))];
    const matchesFixture = uniqueKeys.some((key) => key === flow.destination.key);
    const single = uniqueKeys.length === 1 && matchesFixture;

    scenario.assertions.push(
      assertion(
        `${flow.flow}-single-counterpart`,
        single ? 'pass' : 'fail',
        single
          ? `Exactly one ${flow.destinationRole} issue carries marker ${flow.marker}.`
          : `Expected exactly one ${flow.destinationRole} issue for marker ${flow.marker}, observed ${uniqueKeys.length}.`,
        {
          flow: flow.flow,
          destinationRole: flow.destinationRole,
          projectKey: flow.destinationProject,
          marker: flow.marker,
          expectedKey: flow.destination.key,
          observedKeys: uniqueKeys.slice(0, 10),
          observedCount: uniqueKeys.length,
          settleMs,
        }
      )
    );
  }

  finalizeScenario(scenario);
  scenarioTiming(ctx, scenario, startedAt);
  return scenario;
}


async function runFlowGuarded(ctx, options) {
  if (isInterrupted(ctx)) {
    markSkipped(
      ctx.results,
      ctx.results.map((entry) => entry.id),
      'Interrupted before this scenario started.'
    );
    return { flow: null, failure: redactError(interruptionError(), ctx.secrets), interrupted: true };
  }
  try {
    return await runFlow(ctx, options);
  } catch (error) {
    const failure = redactError(error, ctx.secrets);
    const createdScenario = scenarioById(ctx.results, options.createdScenario);
    if (createdScenario) {
      createdScenario.assertions.push(
        assertion(error && error.interrupted ? 'run-interrupted' : 'flow-error', 'unknown', failure.message, failure)
      );
      finalizeScenario(createdScenario);
      createdScenario.status = 'unknown';
      createdScenario.reason = failure.message;
    }
    if (error && error.interrupted) {
      markSkipped(
        ctx.results,
        ctx.results.map((entry) => entry.id),
        'Interrupted before this scenario started.'
      );
      return { flow: null, failure, interrupted: true };
    }
    markUnknown(ctx.results, options.dependentScenarios, failure.message);
    return { flow: null, failure };
  }
}

function blockAllScenarios(ctx, reason) {
  ctx.results.forEach((entry) => {
    if (entry.status === 'skipped' && !entry.reason) {
      entry.reason = reason;
    }
  });
}

/**
 * Acquires connector readiness for a run.
 *
 * There is no argument that can supply it. A caller-provided object with
 * `url()`/`evaluate()` members (or a bare callback) is indistinguishable from a
 * fabricated one, so it is not accepted at all; the acquisition call below
 * always fails with `AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE` until a real
 * authenticated browser adapter exists. The failure is recorded and the run
 * stays blocked instead of silently continuing as verified.
 */
async function acquireConnectorReadiness() {
  try {
    return { readiness: await readForgeAdminReadiness(), failure: null };
  } catch (error) {
    return {
      readiness: null,
      failure: {
        code: typeof error?.code === 'string'
          ? error.code
          : AUTHENTICATED_CONNECTOR_ADAPTER_UNAVAILABLE,
      },
    };
  }
}


function evaluateReadiness(ctx, options) {
  let document = null;
  const loadIssues = [];

  if (options.evidence && typeof options.evidence === 'object') {
    document = options.evidence;
    ctx.evidenceLoaded = true;
  } else if (ctx.settings.evidencePath) {
    const loaded = loadEvidence(ctx.settings.evidencePath);
    document = loaded.document;
    ctx.evidenceLoaded = document !== null;
    loadIssues.push(...loaded.issues);
  }

  const evaluated = validateReadiness({
    document,
    config: ctx.config,
    settings: ctx.settings,
    now: ctx.now,
    readiness: options.readiness,
    readinessFailure: options.readinessFailure,
  });

  if (loadIssues.length > 0) {
    evaluated.reasons.unshift(...loadIssues);
  }
  ctx.evidenceLoadIssues = loadIssues;
  return evaluated;
}

async function runE2E(options = {}) {
  const config = options.config || {};
  const plan = options.plan || {};
  const settings = { ...(plan.settings || {}) };
  const now = options.now || (() => Date.now());
  const sleep =
    options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random || crypto.randomBytes;
  const startedAtMs = now();
  const runId = options.runId || createRunId(startedAtMs, random);
  const interruptPredicate =
    typeof options.interrupted === 'function' ? options.interrupted : () => false;
  // A standard AbortSignal is honoured in addition to the predicate, so an
  // embedder can cancel the run without inventing a second mechanism.
  const abortSignal =
    options.signal && typeof options.signal.aborted === 'boolean' ? options.signal : null;

  const ctx = {
    config,
    plan: { ...plan, settings },
    settings,
    runId,
    now,
    sleep,
    random,
    clients: {},
    issueTypes: {},
    results: [],
    prerequisites: [],
    fixtures: [],
    pair: null,
    readiness: null,
    evidenceLoaded: false,
    evidenceLoadIssues: [],
    planIssues: Array.isArray(plan.issues) ? plan.issues : [],
    configIssues: Array.isArray(options.configIssues) ? options.configIssues : [],
    warnings: [],
    secrets: collectCredentialSecrets(config),
    interrupted: () =>
      (abortSignal ? abortSignal.aborted : false) || interruptPredicate() === true,
    interruptionSignal:
      typeof options.interruptionSignal === 'function' ? options.interruptionSignal : () => null,
  };

  ctx.results = buildScenarioDefinitions({
    summary: { selected: { syncDirection: 'bidirectional' }, syncComments: true },
  }).map(scenarioResult);

  const readinessAcquisition = await acquireConnectorReadiness();
  ctx.readiness = evaluateReadiness(ctx, {
    evidence: options.evidence,
    readiness: readinessAcquisition.readiness,
    readinessFailure: readinessAcquisition.failure,
  });

  const finish = (status, reason) => {
    const report = buildReport(ctx, {
      status,
      reason,
      startedAtMs,
      finishedAtMs: now(),
    });
    return { report, status, exitCode: report.summary.exitCode };
  };

  const blockedReason = (() => {
    const first = ctx.configIssues[0] || ctx.planIssues[0];
    if (!first) {
      return null;
    }
    return `Blocked before any mutation: ${first.message}`;
  })();

  if (blockedReason) {
    blockAllScenarios(ctx, blockedReason);
    return finish('blocked', blockedReason);
  }

  if (isInterrupted(ctx)) {
    const reason = 'Interrupted before the run started; no Jira request was made.';
    blockAllScenarios(ctx, reason);
    return finish('interrupted', reason);
  }

  // A blocked readiness status always stops the run. UNKNOWN readiness is
  // acceptable for the read-only dry run, but write-enabled synchronization
  // testing requires verified connector evidence.
  if (ctx.readiness.status === 'blocked') {
    const failing = ctx.readiness.reasons.filter((entry) => entry.severity === 'block');
    const reason = failing.length > 0
      ? `Connector readiness is blocked: ${failing[0].message}`
      : 'Connector readiness is blocked, so no mutation is allowed.';
    blockAllScenarios(ctx, reason);
    return finish('blocked', reason);
  }

  if (ctx.readiness.status !== 'verified' && settings.mode === 'write') {
    const failing = ctx.readiness.reasons.filter((entry) => entry.severity !== 'info');
    const reason = failing.length > 0
      ? `Connector readiness is ${ctx.readiness.status}: ${failing[0].message}`
      : `Connector readiness is ${ctx.readiness.status}, so no mutation is allowed.`;
    blockAllScenarios(ctx, reason);
    return finish('blocked', reason);
  }

  ctx.pair = ctx.readiness.summary.selected || null;
  if (!ctx.pair) {
    const reason = 'Connector readiness did not select a staging project pair.';
    blockAllScenarios(ctx, reason);
    return finish('blocked', reason);
  }

  ctx.results = buildScenarioDefinitions(ctx.readiness).map(scenarioResult);
  return runAuthorizedE2E(ctx, options, { finish, startedAtMs });
}

async function cleanupFixtures(ctx) {
  if (!ctx.settings.cleanup) {
    ctx.fixtures.forEach((fixture) => {
      fixture.cleanup = {
        status: 'retained',
        detail: 'STAGING_E2E_CLEANUP is disabled; the fixture was left in place.',
      };
    });
    return;
  }

  // Delete destination counterparts first: a bidirectional delete would
  // otherwise remove them first and turn the local delete into a no-op.
  const ordered = [...ctx.fixtures].reverse();
  for (const fixture of ordered) {
    if (fixture.cleanup.status !== 'pending') {
      continue;
    }
    await deleteOwnedFixture(ctx, fixture);
  }
}

function fixtureOwned(ctx, key) {
  return ctx.fixtures.some((entry) => entry.key === key && entry.ownership === 'run');
}

/**
 * Deletes one run-owned fixture, never with `deleteSubtasks`. Children are only
 * removed when each of them is itself a run-owned fixture; otherwise the parent
 * is retained and the unowned children are reported.
 */
async function deleteOwnedFixture(ctx, fixture) {
  const client = ctx.clients[fixture.role];
  if (!client) {
    fixture.cleanup = {
      status: 'failed',
      detail: `No Jira client is available to delete ${fixture.key}.`,
    };
    return;
  }

  let children;
  try {
    const observed = await client.getIssueSubtasks(fixture.key);
    if (observed && observed.known === false) {
      fixture.cleanup = {
        status: 'retained-uncertain',
        detail: `The subtasks of ${fixture.key} could not be enumerated, so the issue was retained.`,
      };
      return;
    }
    children = (observed && Array.isArray(observed.subtasks) ? observed.subtasks : []).map(
      (entry) => entry.key
    );
  } catch (error) {
    fixture.cleanup = {
      status: 'retained-uncertain',
      detail: redactError(error, ctx.secrets).message.slice(0, 200),
    };
    return;
  }

  if (children.length > 0) {
    const unowned = children.filter((key) => !fixtureOwned(ctx, key));
    if (unowned.length > 0) {
      fixture.cleanup = {
        status: 'retained-unowned-children',
        detail: `Retained ${fixture.key}: subtask(s) ${unowned.join(', ')} are not run-owned.`,
        retainedChildren: unowned,
      };
      return;
    }
    for (const childKey of children) {
      const child = ctx.fixtures.find((entry) => entry.key === childKey);
      if (!child || child.cleanup.status !== 'pending') {
        continue;
      }
      await deleteSingle(ctx, child);
    }
    const blockingChild = children
      .map((key) => ctx.fixtures.find((entry) => entry.key === key))
      .find((entry) => entry && entry.cleanup.status !== 'deleted' && entry.cleanup.status !== 'already-absent');
    if (blockingChild) {
      fixture.cleanup = {
        status: 'retained-uncertain',
        detail: `Retained ${fixture.key}: run-owned child ${blockingChild.key} could not be deleted.`,
        retainedChildren: [blockingChild.key],
      };
      return;
    }
  }

  await deleteSingle(ctx, fixture);
}

async function deleteSingle(ctx, fixture) {
  try {
    const outcome = await ctx.clients[fixture.role].deleteIssue(fixture.key, {
      force: true,
      // Cleanup of a run-owned fixture stays permitted after an interruption;
      // it is bounded by this call and never cascades to subtasks.
      allowInterrupted: true,
    });

    fixture.cleanup = outcome.absent
      ? {
          status: 'already-absent',
          detail: `${fixture.role} issue ${fixture.key} was already absent.`,
        }
      : {
          status: 'deleted',
          detail: `Deleted run-owned ${fixture.role} issue ${fixture.key}.`,
        };
  } catch (error) {
    fixture.cleanup = {
      status: 'failed',
      detail: redactError(error, ctx.secrets).message.slice(0, 200),
    };
  }
}

function countScenarios(results) {
  const counts = { total: results.length, pass: 0, fail: 0, unknown: 0, skipped: 0 };
  results.forEach((entry) => {
    counts[entry.status] = (counts[entry.status] || 0) + 1;
  });
  return counts;
}

function collectMutations(ctx) {
  const operations = [];
  ['local', 'remote'].forEach((role) => {
    const client = ctx.clients[role];
    if (!client) {
      return;
    }
    client.mutationLog.forEach((entry) => {
      operations.push({ site: role, method: entry.method, endpoint: entry.endpoint, at: entry.at });
    });
  });
  return {
    attempted: operations.length,
    budget: ctx.settings.maxMutations,
    operations,
  };
}

function buildNextActions(ctx, status) {
  const actions = [];
  if (status === 'interrupted') {
    actions.push(
      'Review the recorded fixtures and mutations before the next run; only run-owned fixtures were cleaned up.'
    );
    ctx.results
      .filter((entry) => entry.status === 'unknown')
      .forEach((entry) => actions.push(`Re-run ${entry.id}: it was not completed.`));
  }
  if (status === 'blocked') {
    const blocking = (ctx.readiness?.reasons || []).filter((entry) => entry.severity !== 'info');
    blocking.forEach((entry) => {
      if (entry.action) {
        actions.push(entry.action);
      }
    });
    ctx.prerequisites
      .filter((entry) => entry.status === 'fail')
      .forEach((entry) => actions.push(`Resolve ${entry.id}: ${entry.detail}`));
    (ctx.planIssues || []).forEach((entry) => {
      if (entry.action) {
        actions.push(entry.action);
      }
    });
  }

  const failing = ctx.results.filter((entry) => entry.status === 'fail');
  failing.forEach((entry) => {
    actions.push(`Investigate ${entry.id}: ${entry.reason || 'an assertion failed'}`);
  });

  ctx.fixtures
    .filter((fixture) => fixture.cleanup.status === 'failed')
    .forEach((fixture) =>
      actions.push(`Delete run-owned ${fixture.role} issue ${fixture.key} manually.`)
    );

  ctx.fixtures
    .filter((fixture) => fixture.cleanup.status === 'retained-unowned-children')
    .forEach((fixture) =>
      actions.push(
        `Review the subtask(s) on run-owned ${fixture.role} issue ${fixture.key} ` +
          `(${(fixture.cleanup.retainedChildren || []).join(', ')}) and delete the issue manually once its children are handled.`
      )
    );

  ctx.fixtures
    .filter((fixture) => fixture.cleanup.status === 'retained-uncertain')
    .forEach((fixture) =>
      actions.push(`Verify and delete run-owned ${fixture.role} issue ${fixture.key} manually.`)
    );

  return [...new Set(actions)].slice(0, 12);
}

function summarize(ctx, status, extra = {}) {
  const counts = countScenarios(ctx.results);
  const required = ctx.results.filter((entry) => entry.required === true);
  const requiredFailures = required.filter((entry) => entry.status !== 'pass');
  const cleanupFailures = ctx.fixtures.filter((fixture) =>
    CLEANUP_INCOMPLETE_STATUSES.has(fixture.cleanup.status)
  );
  const e2eVerified =
    status === 'pass' &&
    ctx.settings.mode === 'write' &&
    ctx.readiness?.status === 'verified' &&
    requiredFailures.length === 0;

  return {
    status,
    exitCode:
      status === 'pass'
        ? E2E_EXIT_CODES.PASS
        : status === 'blocked'
          ? E2E_EXIT_CODES.BLOCKED
          : status === 'error' || status === 'interrupted'
            ? E2E_EXIT_CODES.ERROR
            : E2E_EXIT_CODES.FAIL,
    e2eVerified,
    writeVerified: ctx.settings.mode === 'write' && e2eVerified,
    verificationScope: ctx.settings.mode === 'write' ? 'live-write' : 'dry-run',
    reason: extra.reason || null,
    counts,
    requiredFailures: requiredFailures.map((entry) => ({
      id: entry.id,
      status: entry.status,
      reason: entry.reason,
    })),
    cleanupFailures: cleanupFailures.map((fixture) => ({
      role: fixture.role,
      key: fixture.key,
      status: fixture.cleanup.status,
      detail: fixture.cleanup.detail,
      retainedChildren: fixture.cleanup.retainedChildren || [],
    })),
  };
}

async function runAuthorizedE2E(ctx, options, controls) {
  const { finish } = controls;
  const settings = ctx.settings;
  const pair = ctx.pair;

  try {
    ctx.clients.local = makeSiteClient('local', ctx.config, settings, {
      request: options.request,
      now: ctx.now,
      sleep: ctx.sleep,
      isInterrupted: () => isInterrupted(ctx),
    });
    ctx.clients.remote = makeSiteClient('remote', ctx.config, settings, {
      request: options.request,
      now: ctx.now,
      sleep: ctx.sleep,
      isInterrupted: () => isInterrupted(ctx),
    });
  } catch (error) {
    const reason = `Blocked before any mutation: ${redactError(error, ctx.secrets).message}`;
    blockAllScenarios(ctx, reason);
    return finish('blocked', reason);
  }

  let prerequisites = { ok: false, complete: false, incomplete: [] };
  try {
    prerequisites = await runPrerequisites(ctx);
  } catch (error) {
    const failure = redactError(error, ctx.secrets);
    ctx.prerequisites.push({
      id: 'prerequisites.request',
      scope: 'run',
      status: 'fail',
      detail: failure.message,
      evidence: failure,
    });
  }

  if (!prerequisites.ok) {
    const failing = ctx.prerequisites.filter((entry) => entry.status === 'fail');
    const reason = failing.length > 0
      ? `Blocked before any mutation: prerequisite ${failing[0].id} failed (${failing[0].detail})`
      : 'Blocked before any mutation: the read-only prerequisite checks did not pass.';
    blockAllScenarios(ctx, reason);
    return finish('blocked', reason);
  }

  if (!prerequisites.complete && settings.mode === 'write') {
    const reason = `Blocked before any mutation: prerequisite ${prerequisites.incomplete[0]} could not be verified completely.`;
    blockAllScenarios(ctx, reason);
    return finish('blocked', reason);
  }

  if (settings.mode !== 'write') {
    markSkipped(
      ctx.results,
      ctx.results.map((entry) => entry.id),
      'Dry run: no Jira mutation was sent.'
    );
    if (!prerequisites.complete) {
      ctx.warnings.push(
        `Prerequisite(s) ${prerequisites.incomplete.join(', ')} could not be verified completely; this dry run does not certify them.`
      );
    }
    if (ctx.readiness.status !== 'verified') {
      ctx.warnings.push(
        'Connector readiness is unverified: installation, pause, F07 migration, mapping and signed-webhook delivery are operator claims only.'
      );
    }
    return finish(
      'pass',
      'Dry run completed: read-only Jira prerequisites passed and no mutation was sent. Connector readiness is reported separately.'
    );
  }

  if (ctx.plan.writeAuthorized !== true) {
    const reason = 'Blocked before any mutation: write mode was not authorized for this run.';
    blockAllScenarios(ctx, reason);
    return finish('blocked', reason);
  }

  const hasComments = ctx.readiness.summary.syncComments === true;
  if (!hasComments) {
    markSkipped(
      ctx.results,
      ['public-comment-propagates', 'remote-public-comment-propagates'],
      'Comment synchronization is disabled in the connector configuration.'
    );
  }

  const flows = [];
  let status = 'pass';
  let reason = null;

  try {
    const forward = await runFlowGuarded(ctx, {
      flowName: 'forward',
      direction: 'local-to-remote',
      sourceRole: 'local',
      destinationRole: 'remote',
      sourceProject: pair.localProjectKey,
      destinationProject: pair.remoteProjectKey,
      createdScenario: 'local-issue-created-and-synced',
      dependentScenarios: [
        'field-update-propagates',
        'status-transition-propagates',
        'public-comment-propagates',
      ],
      fieldUpdate: true,
      transition: true,
      comment: hasComments,
    });
    if (forward.flow && forward.flow.source.key) {
      flows.push(forward.flow);
    }

    if (pair.syncDirection === 'bidirectional') {
      const reverse = await runFlowGuarded(ctx, {
        flowName: 'reverse',
        direction: 'remote-to-local',
        sourceRole: 'remote',
        destinationRole: 'local',
        sourceProject: pair.remoteProjectKey,
        destinationProject: pair.localProjectKey,
        createdScenario: 'remote-issue-created-and-synced',
        dependentScenarios: ['remote-public-comment-propagates'],
        fieldUpdate: false,
        transition: false,
        comment: hasComments,
      });
      if (reverse.flow && reverse.flow.source.key) {
        flows.push(reverse.flow);
      }
    } else {
      markSkipped(
        ctx.results,
        ['remote-issue-created-and-synced', 'remote-public-comment-propagates'],
        'Reverse-direction scenarios are disabled for push-only synchronization.'
      );
    }

    await runDuplicateChecks(ctx, flows);
  } catch (error) {
    const failure = redactError(error, ctx.secrets);
    status = error && error.interrupted ? 'interrupted' : 'error';
    reason =
      status === 'interrupted'
        ? `Interrupted: ${failure.message}`
        : `The run aborted unexpectedly: ${failure.message}`;
  }

  if (isInterrupted(ctx)) {
    status = 'interrupted';
    reason =
      reason || 'Interrupted by an operator signal; no further scenario write was started.';
  }

  try {
    // Cleanup stays bounded and run-owned: it never searches, never creates and
    // never cascades to children the run does not own.
    await cleanupFixtures(ctx);
  } catch (error) {
    ctx.warnings.push(`Cleanup did not complete: ${redactError(error, ctx.secrets).message}`);
  }

  if (status === 'pass') {
    const unverified = ctx.results.filter((entry) => entry.required && entry.status !== 'pass');
    if (unverified.length > 0) {
      status = 'fail';
      reason = `Required scenario ${unverified[0].id} did not pass: ${unverified[0].reason || 'no assertion detail'}.`;
    }
  }

  const cleanupIncomplete = ctx.fixtures.filter((fixture) =>
    CLEANUP_INCOMPLETE_STATUSES.has(fixture.cleanup.status)
  );
  if (status === 'pass' && cleanupIncomplete.length > 0) {
    status = 'fail';
    const first = cleanupIncomplete[0];
    reason =
      first.cleanup.status === 'retained-unowned-children'
        ? `Run-owned ${first.role} issue ${first.key} was retained because it has subtask(s) the run does not own: ${(first.cleanup.retainedChildren || []).join(', ')}.`
        : `Run-owned ${first.role} issue ${first.key} could not be deleted.`;
  }

  return finish(status, reason);
}

function siteReport(ctx, role) {
  const site = ctx.config[role] || {};
  const pair = ctx.pair || {};
  return {
    role,
    host: site.host || null,
    projectKey: role === 'local' ? pair.localProjectKey || null : pair.remoteProjectKey || null,
  };
}

function buildReport(ctx, options) {
  const finishedAtMs = options.finishedAtMs;
  const summary = summarize(ctx, options.status, options);
  return {
    kind: REPORT_KIND,
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId: ctx.runId,
    startedAt: iso(options.startedAtMs),
    finishedAt: iso(finishedAtMs),
    generatedAt: iso(finishedAtMs),
    durationMs: finishedAtMs - options.startedAtMs,
    environment: ctx.settings.environment || null,
    interruption: {
      interrupted: options.status === 'interrupted' || isInterrupted(ctx),
      recordedDuringRun: isInterrupted(ctx),
      signal: ctx.interruptionSignal ? ctx.interruptionSignal() : null,
    },
    mode: {
      mode: ctx.settings.mode,
      writeAuthorized: ctx.plan?.writeAuthorized === true,
      dryRun: ctx.settings.mode !== 'write',
      confirmations: {
        flag: Boolean(ctx.plan?.settings?.confirmations?.flag),
        matched: Boolean(ctx.plan?.settings?.confirmations?.matched),
      },
    },
    config: {
      local: siteReport(ctx, 'local'),
      remote: siteReport(ctx, 'remote'),
      syncDirection: ctx.pair ? ctx.pair.syncDirection : null,
      issueType: ctx.settings.issueType || null,
      syncTimeoutMs: ctx.settings.syncTimeoutMs || null,
      pollIntervalMs: ctx.settings.pollIntervalMs || null,
      pollMaxIntervalMs: ctx.settings.pollMaxIntervalMs || null,
      maxPolls: ctx.settings.maxPolls || null,
      duplicateSettleMs: ctx.settings.duplicateSettleMs || null,
      cleanupEnabled: ctx.settings.cleanup !== false,
      maxMutations: ctx.settings.maxMutations || null,
      evidence: {
        label: ctx.settings.evidenceLabel || null,
        loaded: ctx.evidenceLoaded === true,
        basis: ctx.readiness ? ctx.readiness.summary.readinessBasis : null,
        verified: ctx.readiness ? ctx.readiness.summary.attestation.verified === true : false,
      },
    },
    readiness: {
      status: ctx.readiness ? ctx.readiness.status : 'unknown',
      checks: ctx.readiness ? ctx.readiness.checks : [],
      reasons: ctx.readiness ? ctx.readiness.reasons : [],
      summary: ctx.readiness ? ctx.readiness.summary : null,
    },
    prerequisites: ctx.prerequisites,
    scenarios: ctx.results,
    fixtures: ctx.fixtures,
    mutations: collectMutations(ctx),
    summary,
    nextActions: buildNextActions(ctx, options.status),
    warnings: ctx.warnings,
  };
}
module.exports = {
  E2E_EXIT_CODES,
  REPORT_KIND,
  REPORT_SCHEMA_VERSION,
  acquireConnectorReadiness,
  buildScenarioDefinitions,
  cleanupFixtures,
  createMarker,
  createRunId,
  runE2E,
};
