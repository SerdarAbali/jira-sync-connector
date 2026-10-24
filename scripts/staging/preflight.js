#!/usr/bin/env node
'use strict';

const {
  EXIT_CODES,
  runPreflight,
} = require('./lib/preflight');
const { loadConfig } = require('./lib/config');
const { formatTerminalReport, writeReport } = require('./lib/report');
const { safeErrorMessage } = require('./lib/redact');

const USAGE = `Usage: node scripts/staging/preflight.js [options]

Runs a read-only Jira Cloud staging preflight. Credentials are read from the
process environment or a mode-600 environment file.

Options:
  --env-file <path>  Read configuration from this environment file.
  --json             Print the machine-readable report to stdout.
  --no-report        Do not persist the report.
  --help             Show this help.
`;

function parseArgs(argv) {
  const options = { json: false, writeReport: true, envFile: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
    } else if (argument === '--no-report') {
      options.writeReport = false;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--env-file') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--env-file requires a path.');
      }
      options.envFile = value;
      index += 1;
    } else if (argument.startsWith('--env-file=')) {
      const value = argument.slice('--env-file='.length);
      if (!value) {
        throw new Error('--env-file requires a path.');
      }
      options.envFile = value;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    process.exitCode = EXIT_CODES.ERROR;
    return;
  }

  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  try {
    const loaded = loadConfig({
      cwd: process.cwd(),
      env: process.env,
      envFile: options.envFile,
    });
    const report = await runPreflight({
      config: loaded.config,
      issues: loaded.issues,
    });

    let written = null;
    if (options.writeReport) {
      try {
        written = writeReport({ dir: loaded.config.reportDir, report });
      } catch (error) {
        process.stderr.write(
          `Could not write the preflight report: ${safeErrorMessage(error)}\n`
        );
        process.exitCode = EXIT_CODES.ERROR;
        if (options.json) {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        }
        return;
      }
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatTerminalReport(report)}\n`);
      if (written) {
        process.stdout.write(`Report: ${written.runPath}\n`);
        process.stdout.write(`Latest: ${written.latestPath}\n`);
      }
    }

    process.exitCode = report.summary.exitCode;
  } catch (error) {
    process.stderr.write(
      `Staging preflight error: ${safeErrorMessage(error)}\n`
    );
    process.exitCode = EXIT_CODES.ERROR;
  }
}

main();
