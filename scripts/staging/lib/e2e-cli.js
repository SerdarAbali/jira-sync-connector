#!/usr/bin/env node
'use strict';

/**
 * Operator-facing entry point for the staging E2E runner.
 *
 * The CLI is intentionally thin: it resolves configuration with the same
 * loader the preflight uses, asks `buildE2EPlan` whether a mutation is
 * authorized, and delegates every Jira interaction to `runE2E`. It never
 * constructs a Jira client, never relaxes a host allow-list, and never writes
 * credentials to stdout, stderr, or the report.
 *
 * Modes:
 *   --plan      Offline preview: readiness checks plus the proposed scenario
 *               list. No Jira request is made and no issue is created.
 *   --dry-run   Live read-only verification of identity, access, permissions
 *               and issue types, then the scenarios are skipped. Default.
 *   --write     Mutating run. Requires BOTH `--write` and
 *               STAGING_E2E_WRITE_MODE=I_UNDERSTAND_DISPOSABLE_STAGING.
 */

const crypto = require('crypto');
const path = require('path');

const { loadConfig } = require('./config');
const {
  E2E_WRITE_CONFIRMATION,
  MAX_MUTATIONS_PER_RUN,
  buildE2EPlan,
  parseE2EArguments,
} = require('./e2e-config');
const { loadEvidence, validateReadiness } = require('./e2e-evidence');
const {
  E2E_EXIT_CODES,
  acquireConnectorReadiness,
  buildScenarioDefinitions,
  createRunId,
  runE2E,
} = require('./e2e-runner');
const {
  E2E_PLAN_REPORT_KIND,
  E2E_REPORT_SCHEMA_VERSION,
  formatE2EPlanTerminal,
  formatE2ETerminalReport,
  writeE2EPlanReport,
  writeE2EReport,
} = require('./e2e-report');
const { safeErrorMessage, collectCredentialSecrets, containsCredentialMaterial, redactObject, redactText } = require('./redact');

const USAGE = `Usage: node scripts/staging/e2e.js [options]

Runs the opt-in Jira staging E2E suite for the configured local and remote
staging sites. The default is a read-only dry run.

Options:
  --plan             Print the proposed scenarios from the readiness bundle
                     without contacting Jira. Never mutates.
  --dry-run          Verify readiness and read-only Jira prerequisites, then
                     skip every scenario. Never mutates. This is the default.
  --write            Run the mutating scenarios. Requires the exact
                     STAGING_E2E_WRITE_MODE confirmation as well, and verified
                     connector readiness. Connector readiness exported by an
                     operator is a claim, so write mode is currently blocked
                     until an authenticated connector interface exists.
  --env-file <path>  Read configuration from this environment file.
  --json             Print the machine-readable report to stdout.
  --no-report        Do not persist the report.
  --help             Show this help.

Exit codes:
  0  pass         Every read-only check (and scenario, for writes) passed.
  1  fail         A required assertion failed or a fixture could not be removed.
  2  error        The run could not start, the report was invalid, or the run
                  was interrupted; an interrupted report says INTERRUPTED.
  3  blocked      A mandatory prerequisite (credentials, local Forge
                  installation, F07 readiness, verified connector readiness,
                  evidence) is missing.
`;

function toLines(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function formatIssue(entry) {
  const field = entry.field ? ` (${entry.field})` : '';
  const action = entry.action ? ` ${entry.action}` : '';
  return `  [BLOCK] ${entry.code}${field}: ${entry.message}${action}`;
}

function collectNextActions(entries, limit = 8) {
  const actions = [];
  entries.forEach((entry) => {
    if (entry && typeof entry.action === 'string' && entry.action.trim() !== '') {
      actions.push(entry.action.trim());
    }
  });
  return [...new Set(actions)].slice(0, limit);
}

/**
 * Applies redaction to everything that leaves the process and refuses output
 * that still carries credential material. Returning the sanitized object keeps
 * the terminal, `--json` and the persisted report byte-identical.
 */
function sanitizeReport(report, secrets) {
  const safe = redactObject(report, secrets);
  if (containsCredentialMaterial(JSON.stringify(safe), secrets)) {
    throw new Error(
      'The staging E2E report still contains credential material after redaction; nothing was written.'
    );
  }
  return safe;
}

function planSiteEntry(role, config, readiness, selectors) {
  const selected = readiness.summary ? readiness.summary.selected : null;
  const fallback = selectors ? selectors[role] : null;
  return {
    role,
    host: (config[role] && config[role].host) || null,
    projectKey: selected
      ? role === 'local'
        ? selected.localProjectKey
        : selected.remoteProjectKey
      : fallback || null,
  };
}

/**
 * Builds the plan preview document. It intentionally reuses the runner's
 * readiness evaluation so a plan and a later dry run cannot disagree about
 * connector state.
 */
function buildPlanDocument(options) {
  const { config, settings, loaded, plan, runId, nowMs } = options;
  const configIssues = Array.isArray(loaded.issues) ? loaded.issues : [];
  const planIssues = Array.isArray(plan.issues) ? plan.issues : [];
  const evidenceLoad = [];

  let document = null;
  if (options.evidence && typeof options.evidence === 'object') {
    document = options.evidence;
  } else if (settings.evidencePath) {
    const loadedEvidence = loadEvidence(settings.evidencePath);
    document = loadedEvidence.document;
    evidenceLoad.push(...loadedEvidence.issues);
  }

  const readiness = validateReadiness({
    document,
    config,
    settings,
    now: () => nowMs,
    readiness: options.readiness,
    readinessFailure: options.readinessFailure,
  });
  if (evidenceLoad.length > 0) {
    readiness.reasons.unshift(...evidenceLoad);
  }

  const blockingReasons = readiness.reasons.filter((entry) => entry.severity !== 'info');
  const issues = [...configIssues, ...planIssues];
  const scenarios = buildScenarioDefinitions(readiness).map((entry) => ({
    id: entry.id,
    direction: entry.direction,
    required: entry.required === true,
  }));

  const blocked = issues.length > 0 || readiness.status !== 'verified';
  const interrupted = options.interrupted === true;
  const selected = readiness.summary ? readiness.summary.selected : null;
  let reason = null;
  if (interrupted) {
    reason = `Interrupted${options.signal ? ` by ${options.signal}` : ''} before the plan completed; no Jira request was made.`;
  } else if (blocked) {
    const firstIssue = issues[0];
    reason = firstIssue
      ? `Blocked before any mutation: ${firstIssue.message}`
      : `Connector readiness is ${readiness.status}: ${
          blockingReasons[0]
            ? blockingReasons[0].message
            : 'no verified attestation is available.'
        }`;
  } else {
    reason = 'Plan only: readiness is verified and no Jira request was made.';
  }

  const selectors = settings.selectors || null;

  return {
    kind: E2E_PLAN_REPORT_KIND,
    schemaVersion: E2E_REPORT_SCHEMA_VERSION,
    runId,
    generatedAt: new Date(nowMs).toISOString(),
    environment: settings.environment || null,
    mode: {
      mode: 'plan',
      writeAuthorized: false,
      dryRun: true,
      confirmations: {
        flag: plan.args.write === true,
        matched: Boolean(settings.confirmations && settings.confirmations.matched),
      },
    },
    config: {
      local: planSiteEntry('local', config, readiness, selectors),
      remote: planSiteEntry('remote', config, readiness, selectors),
      syncDirection: selected ? selected.syncDirection : null,
      issueType: settings.issueType || null,
      selectors,
      evidenceLabel: settings.evidenceLabel || null,
      reportDirLabel: settings.reportDirLabel || null,
    },
    readiness: {
      status: readiness.status,
      checks: readiness.checks,
      reasons: readiness.reasons,
      summary: readiness.summary,
    },
    plan: {
      writeRequested: plan.args.write === true,
      confirmationRequired: `STAGING_E2E_WRITE_MODE=${E2E_WRITE_CONFIRMATION}`,
      cleanupEnabled: settings.cleanup !== false,
      maxMutations: settings.maxMutations || MAX_MUTATIONS_PER_RUN,
      issues: issues.map((entry) => ({
        code: typeof entry.code === 'string' ? entry.code : 'configuration',
        message: entry.message,
        action: entry.action || null,
      })),
    },
    scenarios,
    summary: {
      status: interrupted ? 'interrupted' : blocked ? 'blocked' : 'pass',
      exitCode: interrupted
        ? E2E_EXIT_CODES.ERROR
        : blocked
          ? E2E_EXIT_CODES.BLOCKED
          : E2E_EXIT_CODES.PASS,
      reason,
      counts: {
        total: scenarios.length,
        required: scenarios.filter((entry) => entry.required).length,
        planned: scenarios.length,
      },
    },
    nextActions: blocked && !interrupted
      ? collectNextActions(issues.length > 0 ? issues : blockingReasons, 8)
      : [],
  };
}

async function runPlanMode(context) {
  const { config, settings, loaded, plan, stdout, stderr, now, random, state } = context;
  const runId = context.runId || createRunId(now(), random);
  const secrets = context.secrets || [];
  const acquisition = await acquireConnectorReadiness();
  const built = buildPlanDocument({
    config,
    settings,
    loaded,
    plan,
    runId,
    nowMs: now(),
    evidence: context.evidence,
    readiness: acquisition.readiness,
    readinessFailure: acquisition.failure,
    interrupted: Boolean(state.interrupted),
    signal: state.interrupted,
  });

  let report;
  try {
    report = sanitizeReport(built, secrets);
  } catch (error) {
    stderr(`Staging E2E error: ${safeErrorMessage(error, secrets)}\n`);
    return {
      exitCode: E2E_EXIT_CODES.ERROR,
      status: 'error',
      mode: 'plan',
      report: null,
      paths: null,
      plan,
      interrupted: Boolean(state.interrupted),
    };
  }

  let paths = null;
  let writeFailed = null;
  if (settings.writeReport) {
    try {
      paths = context.writeE2EPlanReport({
        report,
        dir: settings.reportDir,
        cwd: context.cwd,
      });
    } catch (error) {
      writeFailed = safeErrorMessage(error, secrets);
    }
  }

  if (settings.json) {
    stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    stdout(`${formatE2EPlanTerminal(report)}\n`);
    if (paths) {
      stdout(`Plan report: ${paths.runPath}\n`);
      stdout(`Latest plan: ${paths.latestPath}\n`);
    }
  }

  if (writeFailed) {
    stderr(`Could not write the staging E2E plan report: ${writeFailed}\n`);
  }

  if (writeFailed) {
    return {
      exitCode: E2E_EXIT_CODES.ERROR,
      status: 'error',
      mode: 'plan',
      report,
      paths,
      plan,
      interrupted: Boolean(state.interrupted),
      reportError: writeFailed,
    };
  }

  return {
    exitCode: report.summary.exitCode,
    status: report.summary.status,
    mode: 'plan',
    report,
    paths,
    plan,
    interrupted: Boolean(state.interrupted),
  };
}

async function runRunMode(context) {
  const { config, settings, loaded, plan, stdout, stderr, state } = context;

  if (plan.args.write === true && plan.writeAuthorized !== true) {
    stderr(
      'Write mode refused: --write requires STAGING_E2E_WRITE_MODE=' +
        `${E2E_WRITE_CONFIRMATION}. The run is recorded as blocked and no Jira request is made.\n`
    );
  }

  const secrets = context.secrets || [];

  let result;
  try {
    result = await context.runE2E({
      config,
      plan,
      evidence: context.evidence,
      interrupted: () => state.interrupted !== null,
      interruptionSignal: () => state.interrupted,
      configIssues: Array.isArray(loaded.issues) ? loaded.issues : [],
      request: context.request,
      now: context.now,
      sleep: context.sleep,
      random: context.random,
      runId: context.runId,
    });
  } catch (error) {
    stderr(`Staging E2E error: ${safeErrorMessage(error, secrets)}\n`);
    return {
      exitCode: E2E_EXIT_CODES.ERROR,
      status: 'error',
      mode: settings.mode,
      report: null,
      paths: null,
      plan,
    };
  }

  const raw = result.report;
  let report;
  try {
    report = sanitizeReport(raw, secrets);
  } catch (error) {
    stderr(`Staging E2E error: ${safeErrorMessage(error, secrets)}\n`);
    return {
      exitCode: E2E_EXIT_CODES.ERROR,
      status: result.status,
      mode: settings.mode,
      report: null,
      paths: null,
      plan,
      interrupted: Boolean(state.interrupted),
    };
  }

  // The terminal output, the persisted report and the exit code must agree. A
  // runner that returned PASS after a recorded interruption cannot be presented
  // as a pass, so the interruption wins before anything is written or printed.
  if (state.interrupted && report.summary.status !== 'interrupted') {
    stderr(
      `Interrupted by ${state.interrupted}; the run is recorded as interrupted and not as a pass.\n`
    );
    report = {
      ...report,
      interruption: {
        ...(report.interruption || {}),
        interrupted: true,
        recordedDuringRun: true,
        signal: state.interrupted,
      },
      summary: {
        ...report.summary,
        status: 'interrupted',
        exitCode: E2E_EXIT_CODES.ERROR,
        e2eVerified: false,
        writeVerified: false,
        reason:
          report.summary.reason ||
          `Interrupted by ${state.interrupted}; no further scenario write was started.`,
      },
    };
  }

  let paths = null;
  let writeFailed = null;

  if (settings.writeReport) {
    try {
      paths = context.writeE2EReport({
        report,
        dir: settings.reportDir,
        cwd: context.cwd,
        secrets,
      });
    } catch (error) {
      writeFailed = safeErrorMessage(error, secrets);
    }
  }

  if (settings.json) {
    stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    stdout(`${formatE2ETerminalReport(report)}\n`);
    if (paths) {
      stdout(`Report: ${paths.runPath}\n`);
      stdout(`Latest: ${paths.latestPath}\n`);
    }
  }

  if (writeFailed) {
    stderr(`Could not write the staging E2E report: ${writeFailed}\n`);
    return {
      exitCode: E2E_EXIT_CODES.ERROR,
      status: report.summary.status,
      mode: settings.mode,
      report,
      paths,
      plan,
      interrupted: Boolean(state.interrupted),
      reportError: writeFailed,
    };
  }

  return {
    exitCode: report.summary.exitCode,
    status: report.summary.status,
    mode: settings.mode,
    report,
    paths,
    plan,
    interrupted: Boolean(state.interrupted),
  };
}

async function runCli(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const env = options.env || {};
  const argv = Array.isArray(options.argv) ? options.argv : [];
  const stdout = options.stdout || ((text) => process.stdout.write(text));
  const stderr = options.stderr || ((text) => process.stderr.write(text));
  const now = options.now || (() => Date.now());
  const random = options.random || crypto.randomBytes;
  const state = { interrupted: null };

  const controller = {
    interrupt(signal) {
      if (state.interrupted) {
        return state.interrupted;
      }
      state.interrupted = signal || 'SIGINT';
      stderr(
        `Interrupted by ${state.interrupted}. Finishing the current step and recording what completed; ` +
          'no new scenario will be started.\n'
      );
      return state.interrupted;
    },
  };
  if (typeof options.onReady === 'function') {
    options.onReady(controller);
  }

  // Argument problems are reported before any credential file is read so an
  // invalid invocation can never look like a configuration failure.
  const parsed = parseE2EArguments(argv);
  if (parsed.issues.length > 0) {
    stderr(`${parsed.issues.map(formatIssue).join('\n')}\n\n${USAGE}`);
    return {
      exitCode: E2E_EXIT_CODES.ERROR,
      status: 'error',
      mode: 'error',
      report: null,
      paths: null,
    };
  }

  if (parsed.args.help) {
    stdout(toLines(USAGE));
    return {
      exitCode: E2E_EXIT_CODES.PASS,
      status: 'help',
      mode: 'help',
      report: null,
      paths: null,
    };
  }

  let loaded;
  try {
    loaded = (options.loadConfig || loadConfig)({
      cwd,
      env,
      envFile: parsed.args.envFile,
    });
  } catch (error) {
    stderr(`Staging E2E error: ${safeErrorMessage(error)}\n`);
    return {
      exitCode: E2E_EXIT_CODES.ERROR,
      status: 'error',
      mode: 'error',
      report: null,
      paths: null,
    };
  }

  const secrets = collectCredentialSecrets(loaded.config);
  const emitOut = (text) => stdout(redactText(text, secrets));
  const emitErr = (text) => stderr(redactText(text, secrets));

  const context = {
    cwd,
    env,
    stdout: emitOut,
    stderr: emitErr,
    secrets,
    now,
    random,
    state,
    runId: options.runId,
    evidence: options.evidence,
    request: options.request,
    sleep: options.sleep,
    runE2E: options.runE2E || runE2E,
    writeE2EReport: options.writeE2EReport || writeE2EReport,
    writeE2EPlanReport: options.writeE2EPlanReport || writeE2EPlanReport,
    config: loaded.config,
    loaded,
  };

  try {
    context.plan = buildE2EPlan({
      argv,
      config: loaded.config,
      env,
      cwd,
      ...(options.fsImpl ? { fsImpl: options.fsImpl } : {}),
    });
  } catch (error) {
    stderr(`Staging E2E error: ${safeErrorMessage(error)}\n`);
    return {
      exitCode: E2E_EXIT_CODES.ERROR,
      status: 'error',
      mode: 'error',
      report: null,
      paths: null,
    };
  }

  context.settings = context.plan.settings;

  const result = context.settings.planOnly
    ? await runPlanMode(context)
    : await runRunMode(context);

  return { ...result, interrupted: Boolean(state.interrupted) };
}

module.exports = {
  USAGE,
  buildPlanDocument,
  runCli,
};
