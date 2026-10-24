#!/usr/bin/env node
'use strict';

const { runCli } = require('./lib/e2e-cli');
const { safeErrorMessage } = require('./lib/redact');

/**
 * Thin process wrapper: it owns signal handling and the process exit code so
 * the CLI module itself stays awaitable and testable without a child process.
 *
 * An in-flight run is never abandoned mid-request: Jira requests are bounded by
 * STAGING_REQUEST_TIMEOUT_MS and scenario polling by STAGING_E2E_SYNC_TIMEOUT_MS
 * and STAGING_E2E_MAX_POLLS. A signal records the interruption, lets the runner
 * finish the current step (including fixture cleanup), and then exits with the
 * error code so an interrupted run can never be read as a pass.
 */
async function main() {
  let controller = null;
  const forward = (signal) => {
    if (controller) {
      controller.interrupt(signal);
      return;
    }
    process.stderr.write(`Interrupted by ${signal} before the run started.\n`);
    process.exitCode = 2;
  };

  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));

  try {
    const result = await runCli({
      cwd: process.cwd(),
      env: process.env,
      argv: process.argv.slice(2),
      onReady: (ready) => {
        controller = ready;
      },
    });
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`Staging E2E error: ${safeErrorMessage(error)}\n`);
    process.exitCode = 2;
  }
}

main();
