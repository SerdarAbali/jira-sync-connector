'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  CHECK_DEFINITIONS,
  EXIT_CODES,
  KIND,
  SCHEMA_VERSION,
} = require('./preflight');
const { resolveReportDirectoryForWrite } = require('./paths');

const LATEST_REPORT_NAME = 'latest.json';
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const CHECK_STATUSES = ['pass', 'fail', 'skipped', 'unknown'];
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CHECK_TITLES = new Map(CHECK_DEFINITIONS);
const REQUIRED_CHECK_IDS = CHECK_DEFINITIONS.map(([id]) => id);

function invalidReport(message) {
  throw new Error(`Invalid preflight report: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value) {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string')
  );
}

function validateSite(site, role) {
  if (!isPlainObject(site) || site.role !== role) {
    invalidReport(`the ${role} site summary is malformed.`);
  }
  if (site.host !== null && typeof site.host !== 'string') {
    invalidReport(`the ${role} site host is malformed.`);
  }
  if (site.configuredEmail !== null && typeof site.configuredEmail !== 'string') {
    invalidReport(`the ${role} configured identity is malformed.`);
  }
  if (site.identity !== null && !isPlainObject(site.identity)) {
    invalidReport(`the ${role} identity summary is malformed.`);
  }
  if (
    !isStringArray(site.stagingProjects) ||
    !isStringArray(site.nonStagingProjects)
  ) {
    invalidReport(`the ${role} project inventory is malformed.`);
  }
}

function validateChecks(checks) {
  if (!Array.isArray(checks)) {
    invalidReport('the checks list is missing.');
  }

  const seen = new Set();
  const counts = { pass: 0, fail: 0, skipped: 0, unknown: 0 };
  const failed = [];

  checks.forEach((entry) => {
    if (!isPlainObject(entry) || typeof entry.id !== 'string') {
      invalidReport('a check entry is malformed.');
    }
    if (!REQUIRED_CHECK_IDS.includes(entry.id)) {
      invalidReport(`check "${entry.id}" is not part of the report schema.`);
    }
    if (seen.has(entry.id)) {
      invalidReport(`check "${entry.id}" appears more than once.`);
    }
    seen.add(entry.id);

    if (entry.title !== CHECK_TITLES.get(entry.id)) {
      invalidReport(`check "${entry.id}" has an unexpected title.`);
    }
    if (!CHECK_STATUSES.includes(entry.status)) {
      invalidReport(`check "${entry.id}" has an invalid status.`);
    }
    if (entry.detail !== null && typeof entry.detail !== 'string') {
      invalidReport(`check "${entry.id}" has malformed detail.`);
    }
    if (entry.evidence !== null && !isPlainObject(entry.evidence)) {
      invalidReport(`check "${entry.id}" has malformed evidence.`);
    }

    counts[entry.status] += 1;
    if (entry.status === 'fail') {
      failed.push(entry.id);
    }
  });

  REQUIRED_CHECK_IDS.forEach((id) => {
    if (!seen.has(id)) {
      invalidReport(`required check "${id}" is missing.`);
    }
  });

  return { counts, failed };
}

function expectedIsolationDigest(local, remote) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        local: local ? local.evidenceDigest : null,
        remote: remote ? remote.evidenceDigest : null,
      })
    )
    .digest('hex')}`;
}

function validateIsolation(isolation, checksById) {
  if (!isPlainObject(isolation)) {
    invalidReport('the isolation section is missing.');
  }
  if (isolation.verified !== false) {
    invalidReport(
      'operational isolation cannot be marked verified from project classification.'
    );
  }
  if (typeof isolation.classificationVerified !== 'boolean') {
    invalidReport('the project-classification result is malformed.');
  }
  if (
    typeof isolation.evidenceDigest !== 'string' ||
    !DIGEST_PATTERN.test(isolation.evidenceDigest)
  ) {
    invalidReport('the classification evidence digest is malformed.');
  }
  if (
    !isPlainObject(isolation.operationalIsolation) ||
    isolation.operationalIsolation.status !== 'unknown' ||
    typeof isolation.operationalIsolation.reason !== 'string' ||
    !isolation.operationalIsolation.reason.trim()
  ) {
    invalidReport('operational isolation must remain explicitly unknown.');
  }

  ['local', 'remote'].forEach((role) => {
    const result = isolation[role];
    if (result === null) {
      return;
    }
    if (!isPlainObject(result) || result.role !== role) {
      invalidReport(`the ${role} classification evidence is malformed.`);
    }
    if (typeof result.classificationVerified !== 'boolean') {
      invalidReport(`the ${role} classification result is malformed.`);
    }
    if (result.verified !== undefined) {
      invalidReport(
        `the ${role} classification evidence uses an ambiguous verified flag.`
      );
    }
    if (
      typeof result.evidenceDigest !== 'string' ||
      !DIGEST_PATTERN.test(result.evidenceDigest)
    ) {
      invalidReport(`the ${role} classification digest is malformed.`);
    }
  });

  if (
    isolation.evidenceDigest !==
    expectedIsolationDigest(isolation.local, isolation.remote)
  ) {
    invalidReport('the combined classification digest is inconsistent.');
  }

  if (isolation.classificationVerified) {
    if (
      !isolation.local ||
      !isolation.remote ||
      isolation.local.classificationVerified !== true ||
      isolation.remote.classificationVerified !== true
    ) {
      invalidReport('the project-classification result is inconsistent.');
    }
    if (checksById.get('isolation').status !== 'unknown') {
      invalidReport(
        'the isolation check must remain unknown after project classification.'
      );
    }
  } else if (checksById.get('isolation').status === 'unknown') {
    invalidReport(
      'the isolation check cannot be unknown without a classification result.'
    );
  }

  if (checksById.get('isolation').status === 'pass') {
    invalidReport(
      'operational isolation cannot pass without development-side evidence.'
    );
  }
}

function validateReport(report) {
  if (!isPlainObject(report)) {
    invalidReport('the report must be a JSON object.');
  }
  if (report.kind !== KIND) {
    invalidReport('the file is not a Jira Sync staging preflight report.');
  }
  if (report.schemaVersion !== SCHEMA_VERSION) {
    invalidReport('the schema version is not supported.');
  }
  if (report.mode !== 'read-only') {
    invalidReport('the report mode is not read-only.');
  }
  if (typeof report.runId !== 'string' || !report.runId.trim()) {
    invalidReport('the run identifier is missing.');
  }
  if (
    typeof report.generatedAt !== 'string' ||
    !ISO_TIMESTAMP.test(report.generatedAt) ||
    Number.isNaN(Date.parse(report.generatedAt))
  ) {
    invalidReport('the generation timestamp is malformed.');
  }
  if (!isPlainObject(report.configuration)) {
    invalidReport('the configuration section is missing.');
  }
  if (
    report.configuration.envFile !== null &&
    typeof report.configuration.envFile !== 'string'
  ) {
    invalidReport('the configuration file label is malformed.');
  }
  if (
    !['process', 'file', 'file+process', 'none'].includes(
      report.configuration.envSource
    ) ||
    !Array.isArray(report.configuration.issues)
  ) {
    invalidReport('the configuration source or issue list is malformed.');
  }
  if (!isPlainObject(report.sites)) {
    invalidReport('the site summaries are missing.');
  }
  validateSite(report.sites.local, 'local');
  validateSite(report.sites.remote, 'remote');
  if (!isStringArray(report.nextActions)) {
    invalidReport('the next-actions list is malformed.');
  }
  if (
    !isPlainObject(report.forge) ||
    report.forge.status !== 'unknown' ||
    typeof report.forge.reason !== 'string'
  ) {
    invalidReport('the Forge state must remain explicitly unknown.');
  }
  if (
    !isPlainObject(report.f07) ||
    report.f07.status !== 'unknown' ||
    typeof report.f07.reason !== 'string'
  ) {
    invalidReport('the F07 state must remain explicitly unknown.');
  }

  const { counts, failed } = validateChecks(report.checks);
  const checksById = new Map(report.checks.map((entry) => [entry.id, entry]));
  if (checksById.get('forge-staging-installation').status !== 'unknown') {
    invalidReport('the Forge installation check must remain unknown.');
  }
  if (checksById.get('f07-migration-state').status !== 'unknown') {
    invalidReport('the F07 migration check must remain unknown.');
  }

  validateIsolation(report.isolation, checksById);
  return validateSummary(report, counts, failed);
}

function validateSummary(report, counts, failed) {
  if (!isPlainObject(report.summary)) {
    invalidReport('the summary is missing.');
  }
  const summary = report.summary;
  if (summary.status !== 'pass' && summary.status !== 'fail') {
    invalidReport('the summary status is invalid.');
  }
  if (
    !Number.isSafeInteger(summary.exitCode) ||
    ![EXIT_CODES.PASS, EXIT_CODES.FAIL].includes(summary.exitCode)
  ) {
    invalidReport('the persisted exit code is not supported.');
  }
  if (summary.certification !== 'withheld') {
    invalidReport('certification must remain withheld.');
  }
  if (typeof summary.message !== 'string' || !summary.message.trim()) {
    invalidReport('the summary message is missing.');
  }
  if (!isPlainObject(summary.checks)) {
    invalidReport('the summary check counts are missing.');
  }
  const countKeys = Object.keys(summary.checks).sort();
  if (countKeys.join(',') !== [...CHECK_STATUSES].sort().join(',')) {
    invalidReport('the summary check counts have unexpected keys.');
  }
  if (
    CHECK_STATUSES.some(
      (status) =>
        !Number.isSafeInteger(summary.checks[status]) ||
        summary.checks[status] < 0
    )
  ) {
    invalidReport('the summary check counts are malformed.');
  }
  if (
    CHECK_STATUSES.some(
      (status) => summary.checks[status] !== counts[status]
    ) ||
    CHECK_STATUSES.reduce(
      (total, status) => total + summary.checks[status],
      0
    ) !== report.checks.length
  ) {
    invalidReport('the summary check counts do not match the checks.');
  }
  if (!isStringArray(summary.failedChecks)) {
    invalidReport('the summary failed-check list is malformed.');
  }
  if (
    new Set(summary.failedChecks).size !== summary.failedChecks.length ||
    summary.failedChecks.length !== failed.length ||
    summary.failedChecks.some((id, index) => id !== failed[index])
  ) {
    invalidReport('the summary failed-check list does not match the checks.');
  }

  const expectedStatus = failed.length > 0 ? 'fail' : 'pass';
  const expectedExit =
    failed.length > 0 ? EXIT_CODES.FAIL : EXIT_CODES.PASS;
  if (summary.status !== expectedStatus) {
    invalidReport('the summary status contradicts the individual checks.');
  }
  if (summary.exitCode !== expectedExit) {
    invalidReport('the summary exit code contradicts the individual checks.');
  }

  return report;
}

function latestReportPath(dir) {
  return path.join(dir, LATEST_REPORT_NAME);
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
      throw new Error('The report directory must not be a symbolic link.');
    }
    if (!stat.isDirectory()) {
      throw new Error('The report directory path is not a directory.');
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error(
        `Report directory permissions are too broad; restrict them with: chmod 700 ${dir}`
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
  const temporaryPath =
    `${filePath}.${process.pid}.${Date.now()}.tmp`;
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

function safeRunId(runId) {
  const value = typeof runId === 'string' ? runId : '';
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '');
  return sanitized || `run-${Date.now().toString(36)}`;
}

function writeReport(options = {}) {
  const report = options.report;
  if (!report || typeof report !== 'object') {
    throw new Error('A preflight report object is required.');
  }
  validateReport(report);

  const cwd = options.cwd || process.cwd();
  const requestedDir = options.dir
    ? path.resolve(cwd, options.dir)
    : path.join(cwd, 'artifacts', 'staging-preflight');
  const dir = resolveReportDirectoryForWrite(requestedDir, { cwd });

  ensurePrivateDirectory(dir);
  const runPath = path.join(dir, `${safeRunId(report.runId)}.json`);
  const latestPath = latestReportPath(dir);
  const text = `${JSON.stringify(report, null, 2)}\n`;

  writePrivateFile(runPath, text);
  writePrivateFile(latestPath, text);

  return { dir, runPath, latestPath };
}

function readReport(filePath) {
  const resolved = path.resolve(filePath);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    throw new Error('The preflight report does not exist.');
  }
  if (!stat.isFile()) {
    throw new Error('The preflight report path is not a regular file.');
  }
  if (stat.size > MAX_REPORT_BYTES) {
    throw new Error('The preflight report is too large to read safely.');
  }

  const text = fs.readFileSync(resolved, 'utf8');
  let report;
  try {
    report = JSON.parse(text);
  } catch (error) {
    throw new Error('The preflight report must contain valid JSON.');
  }

  if (!report || typeof report !== 'object' || report.kind !== KIND) {
    throw new Error('The file is not a Jira Sync staging preflight report.');
  }
  if (report.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('The preflight report schema version is not supported.');
  }

  return validateReport(report);
}

function formatTerminalReport(report) {
  validateReport(report);

  const status = report.summary.status;
  const lines = [
    'Jira Sync staging preflight (read-only)',
    `Run: ${report.runId || 'unknown'}`,
    `Generated: ${report.generatedAt || 'unknown'}`,
    '',
  ];

  (Array.isArray(report.checks) ? report.checks : []).forEach((entry) => {
    lines.push(
      `[${String(entry.status || 'unknown').toUpperCase()}] ${entry.title || entry.id}`
    );
    if (entry.detail) {
      lines.push(`  ${entry.detail}`);
    }
  });

  lines.push('');
  if (status === 'pass') {
    lines.push('PREFLIGHT PASSED');
  } else if (status === 'error') {
    lines.push('PREFLIGHT ERROR');
  } else {
    lines.push('PREFLIGHT FAILED');
  }
  lines.push('CERTIFICATION WITHHELD');
  lines.push(
    `Isolation evidence: ${
      report.isolation && report.isolation.evidenceDigest
        ? report.isolation.evidenceDigest
        : 'not evaluated'
    }`
  );
  lines.push(
    'Forge staging installation: unknown. F07 migration state: unknown. Operational development/staging isolation: unknown.'
  );

  if (Array.isArray(report.nextActions) && report.nextActions.length > 0) {
    lines.push('');
    lines.push('Next actions:');
    report.nextActions.forEach((action) => {
      lines.push(`- ${action}`);
    });
  }

  return lines.join('\n');
}

module.exports = {
  LATEST_REPORT_NAME,
  MAX_REPORT_BYTES,
  formatTerminalReport,
  latestReportPath,
  readReport,
  validateReport,
  writeReport,
};
