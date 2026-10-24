/** @jest-environment node */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const yaml = require('js-yaml');
const { isNeutral, scanRepository } = require('../scripts/check-neutrality.js');

const ROOT = path.resolve(__dirname, '..');
const restricted = ['co', 'dex'].join('');
let root;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const write = (file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'engineering-safety-'));
  git('init', '-q');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('restricted names and internal attribution fail; ordinary engineering prose passes', () => {
  expect(isNeutral(Buffer.from(restricted.toUpperCase()))).toBe(false);
  expect(isNeutral(Buffer.from(['system', 'prompt'].join(' ')))).toBe(false);
  expect(isNeutral(Buffer.from(['co-authored', 'by'].join('-')))).toBe(false);
  expect(isNeutral(Buffer.from('Authorization model; prompt return; Atlassian Forge.'))).toBe(true);
});

test('index scanning cannot be bypassed by cleaning the working copy', () => {
  write('AGENTS.md', restricted);
  git('add', 'AGENTS.md');
  write('AGENTS.md', 'Engineering requirements');
  expect(scanRepository(root, '--staged')).toEqual(['AGENTS.md']);
  expect(scanRepository(root)).toEqual([]);
});

test('committed scanning reads HEAD, independently of index and working copy', () => {
  write('docs/requirements.md', restricted);
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  write('docs/requirements.md', 'Requirements');
  git('add', '.');
  expect(scanRepository(root, '--committed')).toEqual(['docs/requirements.md']);
  expect(scanRepository(root, '--staged')).toEqual([]);
});

test('only content is scanned, with bounded dependency, generated and binary exclusions', () => {
  write(`${restricted}.md`, 'Requirements');
  write('AGENTS.md', 'Requirements');
  write('node_modules/dependency/index.js', restricted);
  write('dist/output.js', restricted);
  write('package-lock.json', restricted);
  write('image.bin', Buffer.from([0, 1, 2]));
  write('docs/requirements.md', restricted);
  expect(scanRepository(root)).toEqual(['docs/requirements.md']);
});

test('CLI fails on findings or invalid mode and does not print matching text', () => {
  write('requirements.md', restricted);
  const script = path.join(ROOT, 'scripts/check-neutrality.js');
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('requirements.md');
  expect(result.stderr).not.toContain(restricted);
  expect(spawnSync(process.execPath, [script, '--invalid'], { cwd: root }).status).toBe(1);
});

test('CI retains deterministic gates and full Jest includes both guarantee suites', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8'));
  expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push']);
  const steps = workflow.jobs.test.steps;
  const commands = steps.map(step => step.run).filter(Boolean);
  expect(commands.filter(command => command.startsWith('npm test')))
    .toEqual(['npm test -- --runInBand']);
  for (const command of ['npm run lint', 'npm run check:secrets',
    'npm run check:forge:offline', 'npm run check:neutrality -- --committed',
    'npm audit --omit=dev', 'npm audit --omit=dev --audit-level=high', 'npm run build']) {
    expect(commands).toContain(command);
  }
  expect(steps.every(step => !step['continue-on-error'] && !step.if)).toBe(true);
  const config = require('../jest.config.js');
  expect(config.testMatch).toBeUndefined();
  expect(config.testRegex).toBeUndefined();
  expect(config.testPathIgnorePatterns).toBeUndefined();
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  expect(pkg.scripts.test).toBe('jest');
  for (const file of ['package1-outbound-scope.test.js', 'package1-outbound-guarantee.test.js']) {
    expect(fs.existsSync(path.join(ROOT, 'tests', file))).toBe(true);
    expect(pkg.scripts['test:guarantees']).toContain(`tests/${file}`);
  }
});
