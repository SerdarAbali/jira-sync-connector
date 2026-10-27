import fs from 'fs';
import path from 'path';

const APP_PATH = path.join(process.cwd(), 'static/admin-page/src/App.jsx');
const source = fs.readFileSync(path.join(process.cwd(), 'static/admin-page/src/hooks/useAdminController.js'), 'utf8') + fs.readFileSync(APP_PATH, 'utf8');

function componentScope(name) {
  return fs.readFileSync(path.join(process.cwd(), 'static/admin-page/src/components', `${name === 'SyncActivityPanel' ? 'SyncOperations' : name}.jsx`), 'utf8');
}

describe('Batch 3 frontend webhook-rotation scope', () => {
  const configuration = componentScope('ConfigurationPanel');
  const syncActivity = componentScope('SyncActivityPanel');

  test('rotation state and handler are defined in ConfigurationPanel', () => {
    for (const identifier of [
      'rotatingWebhookSecret',
      'rotatedWebhookSigningSecret',
      'handleRotateWebhookSecret',
      'selectedOrg',
      'onRefreshOrganizations',
      'notify'
    ]) {
      expect(configuration).toContain(identifier);
    }
  });

  test('rotation state and handler are not left in SyncActivityPanel', () => {
    expect(syncActivity).not.toContain('rotatingWebhookSecret');
    expect(syncActivity).not.toContain('rotatedWebhookSigningSecret');
    expect(syncActivity).not.toContain('handleRotateWebhookSecret');
  });

  test('ConfigurationPanel receives organization refresh and notification callbacks', () => {
    const page = fs.readFileSync(path.join(process.cwd(), 'static/admin-page/src/dashboard/OrganizationsPage.jsx'), 'utf8');
    const start = page.indexOf('<ConfigurationPanel');
    const end = page.indexOf('/>', start);
    const usage = page.slice(start, end);

    expect(usage).toContain('onRefreshOrganizations={c.loadOrganizations}');
    expect(usage).toContain('notify={c.showMessage}');
  });

  test('callback URL is one-time, cleared on org change/dismiss, and not logged or persisted', () => {
    expect(configuration).toContain('setRotatedWebhookSigningSecret(result.secret)');
    expect(configuration).toContain('setRotatedWebhookSigningSecret(null)');
    expect(configuration).toContain('[selectedOrg?.id]');
    expect(configuration).not.toMatch(/console\.(log|warn|error)\([^)]*rotatedWebhookSigningSecret/);
    expect(configuration).not.toContain('localStorage');
    expect(configuration).not.toContain('sessionStorage');
  });

  test('one-time signing secret is displayed separately from the reusable URL', () => {
    expect(configuration).toContain('selectedOrg.incomingWebhookUrl');
    expect(configuration).toContain('result.secret');
  });

  test('no unsupported custom-header instructions remain in the UI', () => {
    expect(source).not.toContain('X-Jira-Sync');
  });
});

describe('Batch 3 frontend organization-load error handling', () => {
  const start = source.indexOf('const loadOrganizations = async');
  const end = source.indexOf('const loadOrgData = async', start);
  const loadOrganizations = source.slice(start, end);

  test('distinguishes array, forbidden, malformed and invocation failure states', () => {
    expect(loadOrganizations).toContain('Array.isArray(orgs)');
    expect(loadOrganizations).toContain("orgs.code === 'FORBIDDEN'");
    expect(loadOrganizations).toContain('Jira administrator permission is required to load connector configuration.');
    expect(loadOrganizations).toContain('Unable to load connector organizations.');
    expect(loadOrganizations).toContain("status: 'loaded'");
    expect(loadOrganizations).toContain("status: 'error'");
    expect(loadOrganizations).not.toContain('setOrganizations(orgs || [])');
  });

  test('does not show the first-organization prompt after a failed load', () => {
    expect(source).toContain("c.organizationsLoadState.status === 'error'");
    expect(source).toContain("c.organizationsLoadState.status === 'error'");
  });
});
