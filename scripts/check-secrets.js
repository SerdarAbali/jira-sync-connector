#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FORBIDDEN_PATH_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)logs?[^/]*\.txt$/i,
  /(^|\/)(latest-sync|scr[^/]*)\.log$/i,
  /(^|\/)[^/]*\.diff(\.txt)?$/i,
  /(^|\/)BATCH_\d+_[^/]*_REPORT\.md$/i
];

const SECRET_PATTERNS = [
  { name: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'jira-api-token', pattern: /\bATATT[A-Za-z0-9_-]{20,}\b/ },
  { name: 'github-token', pattern: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: 'aws-access-key', pattern: /\bAKIA[A-Z0-9]{16}\b/ },
  { name: 'openai-key', pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'authorization-header', pattern: /Authorization\s*[:=]\s*['"]?(?:Basic|Bearer)\s+[A-Za-z0-9+/=._-]{20,}/i },
  { name: 'generated-webhook-url', pattern: /https:\/\/[a-z0-9-]+\.webtrigger\.atlassian-dev\.net\/[A-Za-z0-9_-]+\/(?!abcdefghijklmnop(?:[^A-Za-z0-9_-]|$))[A-Za-z0-9_-]{16,}/i },
  { name: 'generated-callback-url', pattern: /https:\/\/[a-z0-9-]+\.atlassian-dev\.net\/[A-Za-z0-9_-]+\/(?!abcdefghijklmnop(?:[^A-Za-z0-9_-]|$))[A-Za-z0-9_-]{16,}/i }
];

function isForbiddenPath(filePath) {
  if (/\.env(?:\.[^/]*)?\.example$/i.test(filePath)) return false;
  return FORBIDDEN_PATH_PATTERNS.some(pattern => pattern.test(filePath));
}

const MAX_TEXT_BYTES = 1024 * 1024;
const BINARY_SAMPLE_BYTES = 8192;
const TEXT_CHUNK_BYTES = 1024 * 1024;
const CHUNK_OVERLAP_BYTES = 1024;

function scanText(text) {
  return SECRET_PATTERNS.filter(entry => entry.pattern.test(text)).map(entry => entry.name);
}

function listTrackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  return output.split('\0').filter(Boolean);
}

function isProbablyBinary(buffer) {
  return buffer.includes(0);
}

function readSample(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(BINARY_SAMPLE_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, BINARY_SAMPLE_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function scanLargeText(filePath) {
  const issues = new Set();
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(TEXT_CHUNK_BYTES);
    let offset = 0;
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, TEXT_CHUNK_BYTES, offset);
      if (bytesRead === 0) break;
      for (const issue of scanText(buffer.subarray(0, bytesRead).toString('utf8'))) {
        issues.add(issue);
      }
      if (bytesRead < TEXT_CHUNK_BYTES) break;
      offset += TEXT_CHUNK_BYTES - CHUNK_OVERLAP_BYTES;
    }
  } finally {
    fs.closeSync(fd);
  }
  return Array.from(issues);
}

/**
 * Scan one tracked file. Large text is scanned in bounded overlapping chunks;
 * binary files are skipped safely. Findings never include matched content.
 */
function scanFile(root, relative) {
  const absolute = path.join(root, relative);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return [];
  }
  if (!stat.isFile()) return [];

  if (stat.size > MAX_TEXT_BYTES) {
    if (isProbablyBinary(readSample(absolute))) return [];
    return scanLargeText(absolute).map(issue => ({ file: relative, issue }));
  }

  const buffer = fs.readFileSync(absolute);
  if (isProbablyBinary(buffer)) return [];
  return scanText(buffer.toString('utf8')).map(issue => ({ file: relative, issue }));
}

function formatFinding(finding) {
  return `${finding.file}: ${finding.issue}`;
}

function scanRepository(root = process.cwd()) {
  const findings = [];
  for (const relative of listTrackedFiles()) {
    if (isForbiddenPath(relative)) {
      findings.push({ file: relative, issue: 'forbidden-path' });
      continue;
    }
    findings.push(...scanFile(root, relative));
  }
  return findings;
}

if (require.main === module) {
  const findings = scanRepository();
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`[secret-scan] ${formatFinding(finding)}`);
    }
    process.exit(1);
  }
  console.log('[secret-scan] No forbidden credentials, callback URLs, environment files, logs or audit artifacts found.');
}

module.exports = {
  isForbiddenPath,
  scanText,
  scanFile,
  scanRepository,
  listTrackedFiles,
  formatFinding,
  isProbablyBinary,
  MAX_TEXT_BYTES
};
