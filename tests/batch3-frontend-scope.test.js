import fs from 'fs';
import path from 'path';

const APP_PATH = path.join(process.cwd(), 'static/admin-page/src/App.jsx');
const source = fs.readFileSync(APP_PATH, 'utf8');

function componentScope(name) {
  const start = source.indexOf(`const ${name} = (`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf('\nconst ', start + 1);
  return source.slice(start, end > start ? end : source.length);
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
    const start = source.indexOf('<ConfigurationPanel');
    const end = source.indexOf('/>', start);
    const usage = source.slice(start, end);

    expect(usage).toContain('onRefreshOrganizations={loadOrganizations}');
    expect(usage).toContain('notify={showMessage}');
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
    expect(source).toContain("organizationsLoadState.status === 'loaded' ? (");
    expect(source).toContain("organizationsLoadState.status === 'error' && (");
  });
});
