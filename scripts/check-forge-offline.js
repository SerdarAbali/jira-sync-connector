#!/usr/bin/env node

/**
 * Deterministic Forge lint for unauthenticated CI runners.
 *
 * The Forge CLI's `forge lint` command requires an Atlassian login even though
 * its client-side checks run locally. This script invokes the same @forge/lint
 * package, with the same source tree and manifest, without the CLI's login and
 * analytics preconditions. The authenticated `npm run check:forge` remains the
 * full release gate.
 */

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

// Resolve the linter through the pinned Forge CLI so the check uses the exact
// @forge/lint and @forge/manifest versions installed by the lockfile.
const forgeCliRequire = createRequire(require.resolve('@forge/cli/package.json'));
const { lint, problemCount } = forgeCliRequire('@forge/lint');
const { ManifestParserBuilder } = forgeCliRequire('@forge/manifest');

const ROOT = process.cwd();
const SOURCE_DIRECTORY = path.join(ROOT, 'src');
const MANIFEST_PATH = path.join(ROOT, 'manifest.yml');

function collectSourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (/\.(jsx?|tsx?)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function logger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
    verbose() {}
  };
}

function statsigService() {
  return {
    getDeprecatedRuntimes: async () => [],
    checkGate: async () => false,
    getDynamicConfig: async () => null
  };
}

function printItem(result, item, level) {
  const relativePath = path.relative(ROOT, result.file) || result.file;
  const location = item.line ? `:${item.line}:${item.column}` : '';
  console.error(`[forge-lint] ${relativePath}${location} ${level}: ${item.message}`);
}

async function main() {
  const manifest = new ManifestParserBuilder()
    .withInterpolators()
    .build()
    .parseManifest({
      content: fs.readFileSync(MANIFEST_PATH, 'utf8'),
      filePath: 'manifest.yml'
    });

  const results = await lint(
    collectSourceFiles(SOURCE_DIRECTORY),
    manifest,
    'development',
    logger(),
    statsigService(),
    { linter: { mode: 'client-side' } }
  );

  const counts = problemCount(results);
  for (const result of results) {
    for (const item of result.errors) printItem(result, item, 'error');
    for (const item of result.approvals) printItem(result, item, 'approval required');
    for (const item of result.warnings) printItem(result, item, 'warning');
  }

  if (counts.errors > 0 || counts.approvals > 0) {
    console.error(
      `[forge-lint] Failed with ${counts.errors} error(s), `
      + `${counts.approvals} approval(s), and ${counts.warnings} warning(s).`
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[forge-lint] No issues found (${counts.warnings} warning(s)). `
    + 'Authenticated `npm run check:forge` remains the release gate.'
  );
}

main().catch((error) => {
  console.error('[forge-lint] Unable to run Forge lint:', error?.message || error);
  process.exitCode = 1;
});
