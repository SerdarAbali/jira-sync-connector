#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

// Digests keep restricted branding vocabulary out of repository prose.
const RESTRICTED_TOKENS = new Set([
  '7d3194f79e645c42e4396dda38be04766810ec6a00d00aced3ffc2a0a1f1a9ef',
  '60965168ce762e949600281ba6d01fee136e5b6e8257b1f216f9025ed324474c',
  '57de4cf40144bdf7d00010f2f5557a7d642c2b9705309bfade167dd313e2ca93',
  'c70eca6b0f88f44d81a41311647e50fda1ac454ec04ffd442b0eb4743a993131',
  'c857d09db23e6822e3600bc06ad8d58f92ed62bc8efd81c753f77048662cb97d',
  '5d72436256ada53828b51895a94bb8489e9f1ac4fe937a8024ef1594e7045ff6',
  '3ea125d0bff386e6754b3782b300016fc79a9cf8f8669c0a5c3db64467ddb681',
  '053ea4804ef1bb33d4a3d6fb024a614b6d257cebc2bc7cd915da9c9522f37ffc',
  'fc5a1047f5919892fcdf8aa79ea5d6bb6531b5c176939ef0110906cb225941c1',
  '6f7ac1823da81d2e52d1a1549ee69c85bbf8bb56d06682849e7c09da2785ce3b',
  '920510199770f4d65cb8aaa2cd12bdb2b8c37f5b3907c50a734a0e3409da2823',
  'a39a7ffad4a3013f29da97b84f264337f234c1cf9b3c40c7c30c677a8a18609a',
]);
const EXCLUDED_PATH = /(^|\/)(node_modules|vendor|dist|build|coverage|\.git|\.forge|\.parcel-cache)(\/|$)|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.min\.(js|css)$|\.map$/;
const INTERNAL_TEXT = /\b(?:system\s+prompt|developer\s+message|conversation\s+transcript|as\s+an\s+ai|generated\s+by\s+(?:an?\s+)?(?:ai|language\s+model)|co-authored[-]by)\b/i;

function isNeutral(buffer) {
  if (buffer.includes(0)) return true;
  const text = buffer.toString('utf8');
  if (INTERNAL_TEXT.test(text)) return false;
  return !(text.toLowerCase().match(/[a-z]+/g) || []).some(token =>
    RESTRICTED_TOKENS.has(createHash('sha256').update(token).digest('hex')));
}

function scanRepository(root = process.cwd(), mode = '--worktree') {
  if (!['--worktree', '--staged', '--committed'].includes(mode)) {
    throw new Error('Use --worktree, --staged or --committed');
  }
  const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const files = git(mode === '--committed'
    ? ['ls-tree', '-r', '--name-only', '-z', 'HEAD']
    : ['ls-files', '--cached', ...(mode === '--worktree' ? ['--others', '--exclude-standard'] : []), '-z'])
    .toString('utf8').split('\0').filter(Boolean);
  const findings = [];
  for (const file of new Set(files)) {
    if (EXCLUDED_PATH.test(file)) continue;
    let buffer;
    if (mode === '--worktree') {
      const absolute = path.join(root, file);
      if (!fs.existsSync(absolute) || !fs.lstatSync(absolute).isFile()) continue;
      buffer = fs.readFileSync(absolute);
    } else {
      // Read Git blobs, never the working copy; staged and committed checks differ.
      const entry = git(mode === '--committed'
        ? ['ls-tree', '-z', 'HEAD', '--', file]
        : ['ls-files', '--stage', '-z', '--', file]).toString('utf8');
      if (!/^100(?:644|755) /.test(entry)) continue;
      buffer = git(['show', mode === '--committed' ? `HEAD:${file}` : `:${file}`]);
    }
    if (!isNeutral(buffer)) findings.push(file);
  }
  return findings;
}

if (require.main === module) {
  try {
    const findings = scanRepository(process.cwd(), process.argv[2] || '--worktree');
    for (const file of findings) console.error(`[neutrality] ${file}: restricted repository text`);
    if (findings.length) process.exitCode = 1;
    else console.log('[neutrality] Repository text passed the bounded vocabulary and attribution check.');
  } catch (error) {
    console.error('[neutrality] Unable to verify repository text:', error.message);
    process.exitCode = 1;
  }
}

module.exports = { isNeutral, scanRepository };
