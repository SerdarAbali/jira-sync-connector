'use strict';

/**
 * Persistence and formatting for staging E2E reports.
 *
 * The E2E report is deliberately separate from the preflight report: it has a
 * different shape (scenarios, assertions, mutations, cleanup) and is written
 * into its own artifacts directory so a preflight reader can never mistake a
 * write run for a read-only one.
 */

const fs = require('fs');
const path = require('path');

const { resolveReportDirectoryForWrite } = require('./paths');
const { containsCredentialMaterial } = require('./redact');

const E2E_REPORT_KIND = 'jira-sync-staging-e2e';
const E2E_REPORT_SCHEMA_VERSION = '1.0';
const E2E_LATEST_REPORT_NAME = 'latest-e2e.json';
const E2E_PLAN_REPORT_KIND = 'jira-sync-staging-e2e-plan';
const E2E_PLAN_LATEST_NAME = 'latest-plan.json';
const MAX_E2E_REPORT_BYTES = 4 * 1024 * 1024;

const SUMMARY_STATUSES = new Set(['pass', 'fail', 'blocked', 'error', 'interrupted']);
const PLAN_STATUSES = new Set(['pass', 'blocked', 'interrupted']);
const SCENARIO_STATUSES = new Set(['pass', 'fail', 'unknown', 'skipped']);
const ASSERTION_STATUSES = new Set(['pass', 'fail', 'unknown', 'skip']);
const CLEANUP_STATUSES = new Set([
  'pending',
  'deleted',
  'already-absent',
  'retained',
  'retained-unowned-children',
  'retained-uncertain',
  'failed',
]);
const READINESS_STATUSES = new Set(['verified', 'unknown', 'blocked']);
const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|authorization|cookie|credential|api[_-]?key|bearer)/i;
const SECRET_VALUE_PATTERN = /^Basic\s+[A-Za-z0-9+/=]{8,}$/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message) {
  throw new Error(`Invalid staging E2E report: ${message}`);
}

function requireString(value, field, options = {}) {
  if (typeof value !== 'string' || value.length === 0) {
    invalid(`${field} must be a non-empty string.`);
  }
  if (options.max && value.length > options.max) {
    invalid(`${field} is too long.`);
  }
  if (options.pattern && !options.pattern.test(value)) {
    invalid(`${field} has an unexpected format.`);
  }
}

function isoTimestamp(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && /^\d{4}-\d{2}-\d{2}T/.test(value);
}

function assertNoSecrets(value, location = 'report') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecrets(entry, `${location}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) {
    if (typeof value === 'string' && SECRET_VALUE_PATTERN.test(value)) {
      invalid(`${location} looks like an authorization header.`);
    }
    return;
  }
  Object.entries(value).forEach(([key, entry]) => {
    if (SECRET_KEY_PATTERN.test(key)) {
      invalid(`${location}.${key} looks like credential material.`);
    }
    if (typeof entry === 'string' && SECRET_VALUE_PATTERN.test(entry)) {
      invalid(`${location}.${key} looks like an authorization header.`);
    }
    assertNoSecrets(entry, `${location}.${key}`);
  });
}

function validateAssertions(assertions, scenarioId) {
  if (!Array.isArray(assertions)) {
    invalid(`scenario ${scenarioId} has no assertions array.`);
  }
  assertions.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      invalid(`scenario ${scenarioId} assertion ${index} is not an object.`);
    }
    requireString(entry.id, `scenario ${scenarioId} assertion ${index} id`, { max: 80 });
    if (!ASSERTION_STATUSES.has(entry.status)) {
      invalid(`scenario ${scenarioId} assertion ${index} has an unexpected status.`);
    }
    requireString(entry.detail, `scenario ${scenarioId} assertion ${index} detail`, {
      max: 2000,
    });
  });
}

function validateScenarios(scenarios) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    invalid('scenarios must be a non-empty array.');
  }
  const ids = new Set();
  scenarios.forEach((entry) => {
    if (!isPlainObject(entry)) {
      invalid('each scenario must be an object.');
    }
    requireString(entry.id, 'scenario id', { max: 80 });
    if (ids.has(entry.id)) {
      invalid(`scenario ${entry.id} is duplicated.`);
    }
    ids.add(entry.id);
    if (!SCENARIO_STATUSES.has(entry.status)) {
      invalid(`scenario ${entry.id} has an unexpected status.`);
    }
    if (typeof entry.required !== 'boolean') {
      invalid(`scenario ${entry.id} must declare required.`);
    }
    validateAssertions(entry.assertions, entry.id);
    if (entry.status === 'skipped' && typeof entry.reason !== 'string') {
      invalid(`scenario ${entry.id} was skipped without a reason.`);
    }
  });
}

function validatePrerequisites(prerequisites) {
  if (!Array.isArray(prerequisites)) {
    invalid('prerequisites must be an array.');
  }
  prerequisites.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      invalid(`prerequisite ${index} must be an object.`);
    }
    requireString(entry.id, `prerequisite ${index} id`, { max: 80 });
    if (!['pass', 'fail', 'unknown'].includes(entry.status)) {
      invalid(`prerequisite ${entry.id} has an unexpected status.`);
    }
    requireString(entry.detail, `prerequisite ${entry.id} detail`, { max: 2000 });
  });
}

function validateFixtures(fixtures) {
  if (!Array.isArray(fixtures)) {
    invalid('fixtures must be an array.');
  }
  fixtures.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      invalid(`fixture ${index} must be an object.`);
    }
    requireString(entry.role, `fixture ${index} role`, { max: 20 });
    requireString(entry.key, `fixture ${index} key`, {
      pattern: /^[A-Za-z][A-Za-z0-9_]{0,63}-\d{1,12}$/,
    });
    if (entry.ownership !== 'run') {
      invalid(`fixture ${entry.key} is not run-owned and must not appear in the report.`);
    }
    if (!isPlainObject(entry.cleanup) || !CLEANUP_STATUSES.has(entry.cleanup.status)) {
      invalid(`fixture ${entry.key} has an unexpected cleanup status.`);
    }
  });
}

function validateSummary(summary, report) {
  if (!isPlainObject(summary)) {
    invalid('summary must be an object.');
  }
  if (!SUMMARY_STATUSES.has(summary.status)) {
    invalid('summary.status is unexpected.');
  }
  if (![0, 1, 2, 3].includes(summary.exitCode)) {
    invalid('summary.exitCode is unexpected.');
  }
  if (typeof summary.e2eVerified !== 'boolean') {
    invalid('summary.e2eVerified must be a boolean.');
  }
  if (summary.e2eVerified && summary.status !== 'pass') {
    invalid('a run that did not pass cannot be verified.');
  }
  if (summary.e2eVerified && report.mode.mode !== 'write') {
    invalid('a dry run cannot claim E2E verification.');
  }
  if (summary.e2eVerified && report.readiness.status !== 'verified') {
    invalid('E2E verification requires a verified readiness attestation.');
  }
  if (summary.status === 'interrupted' && summary.exitCode !== 2) {
    invalid('an interrupted run must exit with code 2.');
  }
  if (summary.status === 'interrupted' && summary.e2eVerified) {
    invalid('an interrupted run cannot be verified.');
  }
  if (!isPlainObject(summary.counts) || !Number.isSafeInteger(summary.counts.total)) {
    invalid('summary.counts is incomplete.');
  }
  const failing = report.scenarios.filter((entry) => entry.required && entry.status !== 'pass');
  if (summary.e2eVerified && failing.length > 0) {
    invalid('a run with failing required scenarios cannot be verified.');
  }
  const failedCleanup = report.fixtures.filter((entry) => entry.cleanup.status === 'failed');
  if (summary.e2eVerified && failedCleanup.length > 0) {
    invalid('a run that left fixtures behind cannot be verified.');
  }
}


function validateMode(mode) {
  if (!isPlainObject(mode)) {
    invalid('mode must be an object.');
  }
  if (!['dry-run', 'write'].includes(mode.mode)) {
    invalid('mode.mode must be "dry-run" or "write".');
  }
  if (typeof mode.writeAuthorized !== 'boolean') {
    invalid('mode.writeAuthorized must be a boolean.');
  }
  if (mode.writeAuthorized && mode.mode !== 'write') {
    invalid('mode.writeAuthorized is inconsistent with mode.mode.');
  }
}

function validateReport(report) {
  if (!isPlainObject(report)) {
    invalid('the report must be an object.');
  }
  if (report.kind !== E2E_REPORT_KIND) {
    invalid(`kind must be "${E2E_REPORT_KIND}".`);
  }
  if (report.schemaVersion !== E2E_REPORT_SCHEMA_VERSION) {
    invalid(`schemaVersion must be "${E2E_REPORT_SCHEMA_VERSION}".`);
  }
  requireString(report.runId, 'runId', { max: 120, pattern: /^[A-Za-z0-9._-]+$/ });
  if (!isoTimestamp(report.startedAt) || !isoTimestamp(report.finishedAt)) {
    invalid('startedAt and finishedAt must be ISO-8601 timestamps.');
  }
  validateMode(report.mode);
  if (!isPlainObject(report.readiness) || !READINESS_STATUSES.has(report.readiness.status)) {
    invalid('readiness.status is unexpected.');
  }
  validateScenarios(report.scenarios);
  validatePrerequisites(report.prerequisites);
  validateFixtures(report.fixtures);
  validateSummary(report.summary, report);
  assertNoSecrets(report);
  return report;
}


function safeRunId(runId) {
  const value = typeof runId === 'string' ? runId : '';
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '');
  return sanitized || `run-${Date.now().toString(36)}`;
}

function ensurePrivateDirectory(dir) {
  let stat = null;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  if (stat) {
    if (stat.isSymbolicLink()) {
      throw new Error('The E2E report directory must not be a symbolic link.');
    }
    if (!stat.isDirectory()) {
      throw new Error('The E2E report directory path is not a directory.');
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error(
        `E2E report directory permissions are too broad; restrict them with: chmod 700 ${dir}`
      );
    }
  } else {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  if (process.platform !== 'win32') {
    fs.chmodSync(dir, 0o700);
  }
}

function writePrivateFile(filePath, text) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, text, 'utf8');
      if (process.platform !== 'win32') {
        fs.fchmodSync(descriptor, 0o600);
      }
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

function writeE2EReport(options = {}) {
  const report = options.report;
  validateReport(report);

  const secrets = Array.isArray(options.secrets) ? options.secrets : [];
  const cwd = options.cwd || process.cwd();
  const requestedDir = options.dir
    ? path.resolve(cwd, options.dir)
    : path.join(cwd, 'artifacts', 'staging-e2e');
  const dir = resolveReportDirectoryForWrite(requestedDir, { cwd });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_E2E_REPORT_BYTES) {
    throw new Error('The E2E report is too large to persist.');
  }
  if (containsCredentialMaterial(text, secrets)) {
    throw new Error(
      'The E2E report still contains credential material after redaction and was not written.'
    );
  }

  ensurePrivateDirectory(dir);
  const runPath = path.join(dir, `${safeRunId(report.runId)}.json`);
  const latestPath = path.join(dir, E2E_LATEST_REPORT_NAME);
  writePrivateFile(runPath, text);
  writePrivateFile(latestPath, text);

  return { dir, runPath, latestPath };
}

/**
 * Plan reports describe what a run *would* do. They are persisted separately
 * from run reports so a plan can never be read as evidence that a scenario
 * passed: the kind differs, the mode is `plan`, and write authorization is
 * always false.
 */
function validatePlanReport(report) {
  if (!isPlainObject(report)) {
    invalid('the plan report must be an object.');
  }
  if (report.kind !== E2E_PLAN_REPORT_KIND) {
    invalid(`kind must be "${E2E_PLAN_REPORT_KIND}".`);
  }
  if (report.schemaVersion !== E2E_REPORT_SCHEMA_VERSION) {
    invalid(`schemaVersion must be "${E2E_REPORT_SCHEMA_VERSION}".`);
  }
  requireString(report.runId, 'runId', { max: 120, pattern: /^[A-Za-z0-9._-]+$/ });
  if (!isoTimestamp(report.generatedAt)) {
    invalid('generatedAt must be an ISO-8601 timestamp.');
  }
  const mode = report.mode;
  if (!isPlainObject(mode)) {
    invalid('mode must be an object.');
  }
  if (mode.mode !== 'plan') {
    invalid('mode.mode must be "plan".');
  }
  if (mode.writeAuthorized !== false) {
    invalid('a plan report cannot authorize a write.');
  }
  if (mode.dryRun !== true) {
    invalid('a plan report is always a dry run.');
  }
  if (!isPlainObject(report.config)) {
    invalid('config must be an object.');
  }
  ['local', 'remote'].forEach((role) => {
    if (!isPlainObject(report.config[role])) {
      invalid(`config.${role} must be an object.`);
    }
  });
  if (!isPlainObject(report.readiness) || !READINESS_STATUSES.has(report.readiness.status)) {
    invalid('readiness.status is unexpected.');
  }
  if (!Array.isArray(report.scenarios) || report.scenarios.length === 0) {
    invalid('scenarios must be a non-empty array.');
  }
  report.scenarios.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      invalid(`scenario ${index} is not an object.`);
    }
    requireString(entry.id, `scenario ${index} id`, { max: 80 });
    requireString(entry.direction, `scenario ${index} direction`, { max: 40 });
    if (typeof entry.required !== 'boolean') {
      invalid(`scenario ${index} required must be a boolean.`);
    }
  });
  if (!isPlainObject(report.plan) || !Array.isArray(report.plan.issues)) {
    invalid('plan.issues must be an array.');
  }
  report.plan.issues.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      invalid(`plan issue ${index} is not an object.`);
    }
    requireString(entry.code, `plan issue ${index} code`, { max: 80 });
    requireString(entry.message, `plan issue ${index} message`, { max: 2000 });
  });
  const summary = report.summary;
  if (!isPlainObject(summary)) {
    invalid('summary must be an object.');
  }
  if (!PLAN_STATUSES.has(summary.status)) {
    invalid('summary.status is unexpected.');
  }
  if (![0, 2, 3].includes(summary.exitCode)) {
    invalid('summary.exitCode is unexpected.');
  }
  if (summary.status === 'interrupted' && summary.exitCode !== 2) {
    invalid('an interrupted plan must exit with code 2.');
  }
  if (summary.reason !== null && typeof summary.reason !== 'string') {
    invalid('summary.reason must be a string or null.');
  }
  if (!isPlainObject(summary.counts) || !Number.isSafeInteger(summary.counts.total)) {
    invalid('summary.counts is incomplete.');
  }
  if (summary.status === 'pass' && report.readiness.status !== 'verified') {
    invalid('a plan cannot pass without a verified readiness attestation.');
  }
  if (summary.status === 'pass' && report.plan.issues.length > 0) {
    invalid('a plan with blocking issues cannot pass.');
  }
  assertNoSecrets(report);
  return report;
}

function writeE2EPlanReport(options = {}) {
  const report = options.report;
  validatePlanReport(report);

  const cwd = options.cwd || process.cwd();
  const requestedDir = options.dir
    ? path.resolve(cwd, options.dir)
    : path.join(cwd, 'artifacts', 'staging-e2e');
  const dir = resolveReportDirectoryForWrite(requestedDir, { cwd });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_E2E_REPORT_BYTES) {
    throw new Error('The E2E plan report is too large to persist.');
  }

  ensurePrivateDirectory(dir);
  const runPath = path.join(dir, `${safeRunId(report.runId)}-plan.json`);
  const latestPath = path.join(dir, E2E_PLAN_LATEST_NAME);
  writePrivateFile(runPath, text);
  writePrivateFile(latestPath, text);

  return { dir, runPath, latestPath };
}


const STATUS_MARKERS = {
  pass: 'PASS',
  fail: 'FAIL',
  unknown: 'UNKN',
  skipped: 'SKIP',
  blocked: 'BLKD',
  interrupted: 'INTERRUPTED',
};

function formatReadinessLine(report) {
  const readiness = report.readiness || {};
  const basis = readiness.summary && readiness.summary.readinessBasis;
  const suffix = basis ? `, ${basis}` : '';
  return `Connector readiness: ${readiness.status || 'unknown'}${suffix}`;
}

function formatSitesLine(report) {
  const config = report.config || {};
  const local = config.local || {};
  const remote = config.remote || {};
  return `Sites: local ${local.host || 'unconfigured'}/${local.projectKey || '?'} -> remote ${remote.host || 'unconfigured'}/${remote.projectKey || '?'} (${config.syncDirection || 'unknown'})`;
}

function formatScenarioLine(scenario) {
  const marker = STATUS_MARKERS[scenario.status] || scenario.status.toUpperCase();
  const required = scenario.required ? '' : ' [optional]';
  const reason = scenario.reason ? ` - ${scenario.reason}` : '';
  return `  [${marker}] ${scenario.id}${required}${reason}`;
}

function formatE2ETerminalReport(report) {
  const summary = report.summary || {};
  const lines = [];
  const modeLabel = report.mode && report.mode.mode === 'write' ? 'write mode' : 'dry run';
  lines.push(`Staging E2E ${String(summary.status || 'unknown').toUpperCase()} (${modeLabel})`);
  lines.push(`Run: ${report.runId}`);
  lines.push(formatSitesLine(report));
  lines.push(formatReadinessLine(report));

  const blocking = (report.readiness && report.readiness.reasons ? report.readiness.reasons : [])
    .filter((entry) => entry.severity !== 'info')
    .slice(0, 5);
  blocking.forEach((entry) => lines.push(`  readiness: ${entry.message}`));

  const failingPrerequisites = (report.prerequisites || []).filter(
    (entry) => entry.status === 'fail'
  );
  if (failingPrerequisites.length > 0) {
    lines.push('Prerequisites:');
    failingPrerequisites.forEach((entry) =>
      lines.push(`  [FAIL] ${entry.id} - ${entry.detail}`)
    );
  }

  if (report.scenarios && report.scenarios.length > 0) {
    lines.push('Scenarios:');
    report.scenarios.forEach((entry) => lines.push(formatScenarioLine(entry)));
  }

  if (report.mutations) {
    lines.push(
      `Mutations: ${report.mutations.attempted} of ${report.mutations.budget} budget used`
    );
  }

  if (report.fixtures && report.fixtures.length > 0) {
    const grouped = {};
    report.fixtures.forEach((fixture) => {
      const status = fixture.cleanup ? fixture.cleanup.status : 'unknown';
      grouped[status] = (grouped[status] || 0) + 1;
    });
    const detail = Object.keys(grouped)
      .sort()
      .map((status) => `${grouped[status]} ${status}`)
      .join(', ');
    lines.push(`Run-owned fixtures: ${detail}`);
  }

  if (summary.reason) {
    lines.push(`Reason: ${summary.reason}`);
  }

  if (Array.isArray(report.nextActions) && report.nextActions.length > 0) {
    lines.push('Next actions:');
    report.nextActions.slice(0, 8).forEach((action) => lines.push(`  - ${action}`));
  }

  return lines.join('\n');
}

function formatE2EPlanTerminal(report) {
  const summary = report.summary || {};
  const readiness = report.readiness || {};
  const plan = report.plan || {};
  const scenarios = Array.isArray(report.scenarios) ? report.scenarios : [];
  const required = scenarios.filter((entry) => entry.required === true).length;
  const lines = [];

  lines.push(
    `Staging E2E plan ${String(summary.status || 'unknown').toUpperCase()} (no Jira requests, no mutations)`
  );
  lines.push(`Run: ${report.runId}`);
  lines.push(formatSitesLine(report));
  lines.push(formatReadinessLine(report));
  lines.push(
    `Mode: plan only; mutations will not be attempted (budget ${plan.maxMutations === undefined ? '?' : plan.maxMutations})`
  );

  const blocking = (readiness.reasons || [])
    .filter((entry) => entry.severity !== 'info')
    .slice(0, 5);
  blocking.forEach((entry) => lines.push(`  readiness: ${entry.message}`));

  const issues = Array.isArray(plan.issues) ? plan.issues : [];
  if (issues.length > 0) {
    lines.push('Blocking configuration:');
    issues.slice(0, 8).forEach((entry) => {
      const action = entry.action ? ` - ${entry.action}` : '';
      lines.push(`  [BLOCK] ${entry.code}: ${entry.message}${action}`);
    });
  }

  lines.push(`Scenarios (${scenarios.length} proposed, ${required} required):`);
  scenarios.forEach((entry) => {
    const marker = entry.required ? 'required' : 'optional';
    lines.push(`  [PLAN] ${entry.id} (${marker}, ${entry.direction})`);
  });

  if (summary.reason) {
    lines.push(`Reason: ${summary.reason}`);
  }

  if (Array.isArray(report.nextActions) && report.nextActions.length > 0) {
    lines.push('Next actions:');
    report.nextActions.slice(0, 8).forEach((action) => lines.push(`  - ${action}`));
  }

  if (plan.writeRequested) {
    lines.push(
      `Write mode was requested but a plan never writes; rerun with --write and the ${plan.confirmationRequired} confirmation.`
    );
  } else {
    lines.push(
      `Write mode is opt-in: rerun with --write and ${plan.confirmationRequired || 'the write confirmation'} after this plan passes.`
    );
  }

  return lines.join('\n');
}

module.exports = {
  E2E_LATEST_REPORT_NAME,
  E2E_PLAN_LATEST_NAME,
  E2E_PLAN_REPORT_KIND,
  E2E_REPORT_KIND,
  E2E_REPORT_SCHEMA_VERSION,
  formatE2EPlanTerminal,
  formatE2ETerminalReport,
  validatePlanReport,
  validateReport,
  writeE2EPlanReport,
  writeE2EReport,
};
