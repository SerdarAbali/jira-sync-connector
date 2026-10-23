import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  isForbiddenPath,
  scanText,
  scanFile,
  formatFinding,
  MAX_TEXT_BYTES
} from '../scripts/check-secrets.js';

const ROOT = path.resolve(__dirname, '..');

describe('Batch 6 CI and dependency reproducibility', () => {
  test('CI runs on pushes and pull requests with read-only repository permissions', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toMatch(/on:\s*\n\s*push:/);
    expect(workflow).toMatch(/\n\s*pull_request:/);
    expect(workflow).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    expect(workflow).not.toMatch(/contents:\s*write|packages:\s*write|id-token:\s*write/i);
  });

  test('CI performs locked installs, tests, lint, audits, Forge lint, secret scan and UI build', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toContain('npm ci');
    expect(workflow).not.toContain('npm ci --legacy-peer-deps');
    expect(workflow).toContain('npm test -- --runInBand');
    expect(workflow).toContain('npm run lint');
    expect(workflow).toContain('npm audit --omit=dev');
    expect(workflow).toContain('npm run check:secrets');
    expect(workflow).toContain('./node_modules/.bin/forge settings set usage-analytics false');
    expect(workflow).toContain('npm run check:forge:offline');
    expect(workflow).toContain('working-directory: static/admin-page');
    expect(workflow).toContain('npm run build');
    expect(workflow).not.toMatch(/forge deploy|forge install|FORGE_(API|APP)|JIRA_TOKEN/i);
  });

  test('admin UI has a committed lockfile and is not gitignored', () => {
    const lockPath = path.join(ROOT, 'static/admin-page/package-lock.json');
    expect(fs.existsSync(lockPath)).toBe(true);
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    expect(lock.lockfileVersion).toBeGreaterThanOrEqual(2);
    const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    expect(ignore).not.toContain('static/admin-page/package-lock.json');
  });

  test('secret scanner blocks env, logs, audit reports/diffs and credential artifacts', () => {
    expect(isForbiddenPath('.env')).toBe(true);
    expect(isForbiddenPath('.env.local')).toBe(true);
    expect(isForbiddenPath('.env.test.example')).toBe(false);
    expect(isForbiddenPath('logs.txt')).toBe(true);
    expect(isForbiddenPath('runtime/latest-sync.log')).toBe(true);
    expect(isForbiddenPath('BATCH_5_LOGGING.diff')).toBe(true);
    expect(isForbiddenPath('BATCH_5_LOGGING_REPORT.md')).toBe(true);
    expect(isForbiddenPath('src/index.js')).toBe(false);
  });

  test('secret scanner detects obvious tokens, authorization headers and generated callback URLs', () => {
    expect(scanText('ATATT' + 'abcdefghijklmnopqrstuvwxyz')).toContain('jira-api-token');
    expect(scanText('Authorization: Bearer ' + 'abcdefghijklmnopqrstuvwxyz123456')).toContain('authorization-header');
    expect(scanText('https://abc.webtrigger.atlassian-dev.net/org-1/' + '0123456789abcdef0123456789abcdef'))
      .toContain('generated-webhook-url');
    expect(scanText('token = "short-placeholder"')).toEqual([]);
  });

  test('package scripts include local secret scan and Forge CLI', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['check:secrets']).toBe('node scripts/check-secrets.js');
    expect(pkg.scripts['check:forge']).toBe('forge lint');
    expect(pkg.scripts['check:forge:offline']).toBe('node scripts/check-forge-offline.js');
    expect(pkg.scripts.test).toBe('jest');
    expect(pkg.devDependencies['@forge/cli']).toBe('14.2.0');
  });

  test('CI uses the lockfile-installed Forge lint and never downloads it dynamically', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toContain('npm run check:forge:offline');
    expect(workflow).not.toContain('npm run check:forge\n');
    expect(workflow).not.toContain('npx --yes');
    expect(workflow).not.toContain('npx @forge/cli');
  });

  test('oversized tracked text is scanned and cannot bypass detection', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch6-text-'));
    try {
      const secret = 'ATATT' + 'abcdefghijklmnopqrstuvwxyz';
      fs.writeFileSync(
        path.join(dir, 'oversized.txt'),
        'A'.repeat(MAX_TEXT_BYTES + 1) + '\n' + secret
      );
      const findings = scanFile(dir, 'oversized.txt');
      expect(findings).toEqual([{ file: 'oversized.txt', issue: 'jira-api-token' }]);
      expect(formatFinding(findings[0])).toBe('oversized.txt: jira-api-token');
      expect(formatFinding(findings[0])).not.toContain(secret);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('oversized binary files are handled safely', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch6-binary-'));
    try {
      const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1, 0x41);
      buffer[0] = 0;
      fs.writeFileSync(path.join(dir, 'oversized.bin'), buffer);
      expect(scanFile(dir, 'oversized.bin')).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('findings print only filename and category', () => {
    const formatted = formatFinding({ file: 'src/example.js', issue: 'jira-api-token' });
    expect(formatted).toBe('src/example.js: jira-api-token');
    expect(formatted).not.toMatch(/ATATT|[A-Za-z0-9_-]{32,}/);
  });
});
