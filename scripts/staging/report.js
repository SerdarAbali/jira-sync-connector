#!/usr/bin/env node
'use strict';

const path = require('path');

const { EXIT_CODES } = require('./lib/preflight');
const {
  formatTerminalReport,
  latestReportPath,
  readReport,
} = require('./lib/report');
const { safeErrorMessage } = require('./lib/redact');

const USAGE = `Usage: node scripts/staging/report.js [options]

Renders a persisted staging preflight report.

Options:
  --input <path>  Report file to render (default: artifacts/staging-preflight/latest.json).
  --json          Print the machine-readable report to stdout.
  --help          Show this help.
`;

function parseArgs(argv) {
  const options = { input: null, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--input') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--input requires a path.');
      }
      options.input = value;
      index += 1;
    } else if (argument.startsWith('--input=')) {
      const value = argument.slice('--input='.length);
      if (!value) {
        throw new Error('--input requires a path.');
      }
      options.input = value;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function main() {
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

  const cwd = process.cwd();
  const input = options.input
    ? path.resolve(cwd, options.input)
    : latestReportPath(path.join(cwd, 'artifacts', 'staging-preflight'));

  let report;
  try {
    report = readReport(input);
  } catch (error) {
    process.stderr.write(
      `Cannot read report: ${safeErrorMessage(error)}\n`
    );
    process.exitCode = EXIT_CODES.ERROR;
    return;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatTerminalReport(report)}\n`);
  }

  const reportedExitCode =
    report.summary && Number.isInteger(report.summary.exitCode)
      ? report.summary.exitCode
      : null;
  process.exitCode = [EXIT_CODES.PASS, EXIT_CODES.FAIL, EXIT_CODES.ERROR].includes(
    reportedExitCode
  )
    ? reportedExitCode
    : EXIT_CODES.ERROR;
}

main();
