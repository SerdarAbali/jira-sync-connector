const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_DIR = path.join(ROOT, 'static/admin-page');
const WORKFLOW_PATH = path.join(ROOT, '.github/workflows/ci.yml');

function workflowSteps() {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  return workflow
    .split(/\r?\n(?=      - name:)/)
    .map(step => step.trim());
}

function adminSteps() {
  return workflowSteps().filter(step => step.includes('working-directory: static/admin-page'));
}

function adminInstallStep() {
  return adminSteps().find(step => /^\s*run:\s*npm ci\s*$/m.test(step));
}

describe('Batch 9 deterministic admin installation', () => {
  test('the scoped admin install policy is committed with only legacy peer resolution', () => {
    const npmrcPath = path.join(ADMIN_DIR, '.npmrc');
    expect(fs.existsSync(npmrcPath)).toBe(true);

    const lines = fs.readFileSync(npmrcPath, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    expect(lines).toEqual(['legacy-peer-deps=true']);

    const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    expect(ignore).not.toContain('static/admin-page/.npmrc');
  });

  test('CI installs admin dependencies with plain npm ci in the scoped directory', () => {
    const install = adminInstallStep();
    expect(install).toBeDefined();
    expect(install).toContain('working-directory: static/admin-page');
    expect(install).not.toContain('--legacy-peer-deps');
  });

  test('CI remains lockfile-reproducible and downloads no packages dynamically', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    expect(workflow).toContain('static/admin-page/package-lock.json');
    expect(workflow).not.toMatch(/\bnpm (install|i|update|upgrade|add)\b/);
    expect(workflow).not.toMatch(/\bnpx\b/);
    expect(workflow).not.toMatch(/--force\b/);

    const build = adminSteps().find(step => step.includes('run: npm run build'));
    expect(build).toBeDefined();
    expect(build).not.toContain('npm install');
    expect(build).not.toContain('--force');
  });
});
