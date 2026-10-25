'use strict';

/**
 * Opt-in write-mode settings for the staging E2E runner.
 *
 * The read-only preflight deliberately owns no mutation capability. This module
 * is the single place that decides whether a run may mutate Jira, and it only
 * answers "yes" when the operator proved intent twice: with the --write flag on
 * the command line *and* with the exact confirmation value in the environment.
 */

const fs = require('fs');
const path = require('path');

const E2E_WRITE_CONFIRMATION = 'I_UNDERSTAND_DISPOSABLE_STAGING';
const EVIDENCE_MAX_BYTES = 256 * 1024;
const MAX_MUTATIONS_PER_RUN = 60;

// Required for the write scenarios only. Deliberately narrower than the
// preflight default (no attachment or link permissions are needed).
const E2E_REQUIRED_PERMISSIONS = [
  'BROWSE_PROJECTS',
  'CREATE_ISSUES',
  'EDIT_ISSUES',
  'ADD_COMMENTS',
  'TRANSITION_ISSUES',
  'DELETE_ISSUES',
];

const ARGUMENT_SPEC = [
  // --plan is the most restricted selector: it previews the scenario list from
  // the readiness bundle without contacting either Jira site. It therefore
  // conflicts with --write and never authorizes a mutation.
  { name: '--plan', key: 'plan', takesValue: false },
  { name: '--write', key: 'write', takesValue: false },
  { name: '--dry-run', key: 'dryRun', takesValue: false },
  { name: '--env-file', key: 'envFile', takesValue: true },
  { name: '--json', key: 'json', takesValue: false },
  { name: '--no-report', key: 'writeReport', takesValue: false },
  { name: '--help', key: 'help', takesValue: false },
];

function planIssue(code, message, action, field) {
  return { code, message, action: action || null, field: field || null };
}

function parseE2EArguments(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const parsed = {
    plan: false,
    write: false,
    dryRun: false,
    envFile: null,
    json: false,
    writeReport: true,
    help: false,
  };
  const issues = [];

  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    const equalsIndex = raw.indexOf('=');
    const name = equalsIndex > 0 ? raw.slice(0, equalsIndex) : raw;
    const inlineValue = equalsIndex > 0 ? raw.slice(equalsIndex + 1) : null;
    const spec = ARGUMENT_SPEC.find((entry) => entry.name === name);

    if (!spec) {
      issues.push(
        planIssue(
          'unknown-argument',
          `Unknown argument: ${name}`,
          'Run with --help to list the supported arguments.',
          name
        )
      );
      continue;
    }

    let value = inlineValue;
    if (spec.takesValue) {
      if (value === null) {
        index += 1;
        value = index < args.length ? args[index] : null;
      }
      if (value === null || value === '' || String(value).startsWith('--')) {
        issues.push(
          planIssue(
            'missing-argument-value',
            `${name} requires a value.`,
            `Pass ${name} <path>.`,
            name
          )
        );
        continue;
      }
      parsed[spec.key] = String(value);
      continue;
    }

    if (inlineValue !== null) {
      issues.push(
        planIssue(
          'unexpected-argument-value',
          `${name} does not accept a value.`,
          `Remove the value from ${name}.`,
          name
        )
      );
      continue;
    }

    if (spec.key === 'writeReport') {
      parsed.writeReport = false;
    } else {
      parsed[spec.key] = true;
    }
  }

  if (parsed.write && parsed.dryRun) {
    issues.push(
      planIssue(
        'conflicting-arguments',
        '--write and --dry-run cannot be combined.',
        'Choose either --write (mutations allowed) or --dry-run (checks only).',
        null
      )
    );
  }

  if (parsed.plan && parsed.write) {
    issues.push(
      planIssue(
        'conflicting-arguments',
        '--plan and --write cannot be combined.',
        'Use --plan to preview the scenarios, then run --write in a separate invocation.',
        null
      )
    );
  }

  return { args: parsed, issues };
}

function resolveEvidencePath(rawValue, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const cwd = path.resolve(options.cwd || process.cwd());
  const artifactsRoot = path.join(cwd, 'artifacts');
  const issues = [];

  const value = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!value) {
    issues.push(
      planIssue(
        'evidence-not-configured',
        'STAGING_E2E_EVIDENCE_FILE is not configured.',
        'Export the connector readiness bundle to artifacts/staging-e2e/readiness.json and set STAGING_E2E_EVIDENCE_FILE to that relative path.'
      )
    );
    return { path: null, label: null, issues };
  }

  if (path.isAbsolute(value)) {
    issues.push(
      planIssue(
        'evidence-path-absolute',
        'STAGING_E2E_EVIDENCE_FILE must be a relative path.',
        'Place the readiness bundle under artifacts/staging-e2e/ and use a relative path.',
        'STAGING_E2E_EVIDENCE_FILE'
      )
    );
    return { path: null, label: null, issues };
  }

  const resolved = path.resolve(cwd, value);
  const relative = path.relative(artifactsRoot, resolved);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    issues.push(
      planIssue(
        'evidence-path-outside-artifacts',
        'STAGING_E2E_EVIDENCE_FILE must resolve inside the private artifacts/ directory.',
        'Move the readiness bundle under artifacts/staging-e2e/ and reference it relatively.',
        'STAGING_E2E_EVIDENCE_FILE'
      )
    );
    return { path: null, label: null, issues };
  }

  let stat;
  try {
    stat = fsImpl.lstatSync(resolved);
  } catch (error) {
    issues.push(
      planIssue(
        'evidence-missing',
        `The readiness bundle "${value}" does not exist.`,
        'Export the readiness bundle before running the E2E runner.',
        'STAGING_E2E_EVIDENCE_FILE'
      )
    );
    return { path: null, label: null, issues };
  }

  if (stat.isSymbolicLink()) {
    issues.push(
      planIssue(
        'evidence-symlink',
        'The readiness bundle path is a symbolic link.',
        'Write the readiness bundle as a regular file inside artifacts/staging-e2e/.',
        'STAGING_E2E_EVIDENCE_FILE'
      )
    );
    return { path: null, label: null, issues };
  }

  if (!stat.isFile()) {
    issues.push(
      planIssue(
        'evidence-not-file',
        'The readiness bundle path is not a regular file.',
        'Point STAGING_E2E_EVIDENCE_FILE at a JSON file.',
        'STAGING_E2E_EVIDENCE_FILE'
      )
    );
    return { path: null, label: null, issues };
  }

  if (stat.size > EVIDENCE_MAX_BYTES) {
    issues.push(
      planIssue(
        'evidence-too-large',
        'The readiness bundle is larger than the 256 KiB limit.',
        'Export only the readiness fields documented in docs/STAGING_E2E.md.',
        'STAGING_E2E_EVIDENCE_FILE'
      )
    );
    return { path: null, label: null, issues };
  }

  return { path: resolved, label: value, issues };
}

function buildE2EPlan(options = {}) {
  const config = options.config || {};
  const e2e = config.e2e || {};
  const env = options.env || {};
  const cwd = path.resolve(options.cwd || process.cwd());
  const fsImpl = options.fsImpl || fs;
  const parsedArgs = Array.isArray(options.argv)
    ? parseE2EArguments(options.argv)
    : { args: { ...(options.args || {}) }, issues: [] };
  const args = parsedArgs.args;
  const issues = [...parsedArgs.issues];

  const confirmation = typeof e2e.writeMode === 'string' ? e2e.writeMode : '';
  const confirmationMatches = confirmation === E2E_WRITE_CONFIRMATION;

  if (args.write && !confirmationMatches) {
    issues.push(
      planIssue(
        'write-not-authorized',
        '--write was requested without a matching write confirmation.',
        `Set STAGING_E2E_WRITE_MODE=${E2E_WRITE_CONFIRMATION} in the environment file before using --write.`,
        'STAGING_E2E_WRITE_MODE'
      )
    );
  }

  if (!args.write && confirmation && !confirmationMatches) {
    issues.push(
      planIssue(
        'write-confirmation-invalid',
        'STAGING_E2E_WRITE_MODE is set to an unexpected value.',
        `Remove it for dry runs, or set it to ${E2E_WRITE_CONFIRMATION} when you intend to write.`,
        'STAGING_E2E_WRITE_MODE'
      )
    );
  }

  const mode = args.write && confirmationMatches && !args.dryRun ? 'write' : 'dry-run';
  const evidence = resolveEvidencePath(e2e.evidenceFile, { cwd, fsImpl });
  issues.push(...evidence.issues);

  const explicitPair =
    e2e.localProject || e2e.remoteProject
      ? { local: e2e.localProject || null, remote: e2e.remoteProject || null }
      : null;

  if (explicitPair && (!explicitPair.local || !explicitPair.remote)) {
    issues.push(
      planIssue(
        'project-selection-incomplete',
        'STAGING_E2E_LOCAL_PROJECT and STAGING_E2E_REMOTE_PROJECT must be set together.',
        'Set both selectors, or neither to let the readiness mapping choose the only staging pair.',
        'STAGING_E2E_LOCAL_PROJECT'
      )
    );
  }

  return {
    mode,
    writeAuthorized: mode === 'write',
    issues,
    args,
    env,
    settings: {
      mode,
      cwd,
      confirmations: {
        required: E2E_WRITE_CONFIRMATION,
        matched: confirmationMatches,
        flag: args.write === true,
      },
      planOnly: args.plan === true,
      evidencePath: evidence.path,
      evidenceLabel: evidence.label,
      environment: e2e.environment,
      forgeInstallationId: e2e.forgeInstallationId,
      forgeEnvironmentId: e2e.forgeEnvironmentId,
      issueType: e2e.issueType,
      selectors: explicitPair,
      evidenceMaxAgeMs: e2e.evidenceMaxAgeMs,
      syncTimeoutMs: e2e.syncTimeoutMs,
      pollIntervalMs: e2e.pollIntervalMs,
      pollMaxIntervalMs: e2e.pollMaxIntervalMs,
      maxPolls: e2e.maxPolls,
      duplicateSettleMs: e2e.duplicateSettleMs,
      cleanup: e2e.cleanup !== false,
      requiredPermissions: [...E2E_REQUIRED_PERMISSIONS],
      maxMutations: MAX_MUTATIONS_PER_RUN,
      reportDir: e2e.reportDir || path.join(cwd, 'artifacts/staging-e2e'),
      reportDirLabel: e2e.reportDirLabel || 'artifacts/staging-e2e',
      json: args.json === true,
      writeReport: args.writeReport !== false,
      help: args.help === true,
    },
  };
}

module.exports = {
  E2E_REQUIRED_PERMISSIONS,
  E2E_WRITE_CONFIRMATION,
  EVIDENCE_MAX_BYTES,
  MAX_MUTATIONS_PER_RUN,
  buildE2EPlan,
  parseE2EArguments,
  resolveEvidencePath,
};
