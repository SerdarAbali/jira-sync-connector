import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const WIZARD_PATH = path.join(ROOT, 'static/admin-page/src/components/GuidedSetupWizard.jsx');
const APP_PATH = path.join(ROOT, 'static/admin-page/src/App.jsx');
const RESOLVER_PATH = path.join(ROOT, 'src/resolvers/setup.js');
const wizard = fs.readFileSync(WIZARD_PATH, 'utf8');
const app = fs.readFileSync(APP_PATH, 'utf8');
const resolver = fs.readFileSync(RESOLVER_PATH, 'utf8');

describe('guided setup admin UI', () => {
  test('renders all nine steps and preserves the existing administration tabs', () => {
    for (const label of [
      '1. Remote Jira connection',
      '2. Source scope',
      '3. Direction',
      '4. Mappings',
      '5. Features',
      '6. Webhook',
      '7. Communication preflight',
      '8. Initial synchronization',
      '9. Review and activation'
    ]) {
      expect(wizard).toContain(label);
    }

    for (const tab of [
      'Sync Activity',
      'Configuration',
      'Guided Setup',
      'Mappings',
      'Diagnostics',
      'Security & Info'
    ]) {
      expect(app).toContain(`<Tab>${tab}</Tab>`);
    }
    expect(app).toContain('<GuidedSetupWizard');
    expect(app).toContain('selected={activeTab}');
    expect(app).toContain('onOpenAdministration={() => setActiveTab(1)}');
    expect(app).toContain('setActiveTab(2);');
  });

  test('reuses existing organization, mapping, feature, webhook and initial-sync operations', () => {
    for (const invoker of [
      "invoke('replaceOrganizationToken'",
      "invoke('updateOrganization'",
      "invoke('fetchLocalProjects'",
      "invoke('getUserMappings'",
      "invoke('getFieldMappings'",
      "invoke('getStatusMappings'",
      "invoke('getIssueTypeMappings'",
      "invoke('getProjectMappings'",
      "invoke('getSyncOptions'",
      "invoke('saveSyncOptions'",
      "invoke('rotateWebhookSecret'",
      "invoke('runHealthCheck'"
    ]) {
      expect(wizard).toContain(invoker);
    }
    expect(wizard).toContain("import InitialSyncPanel from './InitialSyncPanel'");
    expect(wizard).toContain('<InitialSyncPanel selectedOrg={org} showMessage={showMessage} />');
  });

  test('never redisplays stored credentials and displays the callback URL only from local one-time state', () => {
    expect(wizard).toContain('type="password"');
    expect(wizard).toContain('data-testid="setup-api-token"');
    expect(wizard).toContain("setApiToken('')");
    expect(wizard).not.toMatch(/value=\{[^}]*remoteApiToken/);
    expect(wizard).not.toMatch(/org\??\.remoteApiToken/);
    expect(wizard).not.toMatch(/localStorage|sessionStorage/);
    expect(wizard).toContain('const [callbackUrl, setCallbackUrl] = useState(null);');
    expect(wizard).toContain('setCallbackUrl(result.callbackUrl || null);');
    expect(wizard).toContain('setCallbackUrl(null);');
    expect(wizard).not.toMatch(/setCallbackSecret|webhookSecret/);
  });

  test('existing organizations are not forced through setup', () => {
    expect(wizard).toContain('Validate Existing Setup');
    expect(wizard).toContain('Open Current Administration');
    expect(wizard).toContain('Start Guided Setup');
    expect(wizard).toContain('Existing organizations remain fully usable');
    expect(wizard).toContain('onOpenMappings');
    expect(wizard).toContain('Open Existing Mapping Editor');
  });

  test('no duplicate direction or operating-mode model is added', () => {
    expect(wizard).not.toMatch(/operatingMode|syncMode|setupMode|one_way|two_way/i);
    expect(wizard).toContain("{ label: 'One-Way (Push Only)', value: 'push' }");
    expect(wizard).toContain("{ label: 'Two-Way (Bidirectional)', value: 'bidirectional' }");
    expect(wizard).not.toContain('directionMode');
    expect(wizard).not.toContain('setupDirection');
  });

  test('communication preflight is explicitly read-only and never claims real synchronization success', () => {
    expect(wizard).toContain('read-only');
    expect(wizard).toContain('connectivity/readiness preflight');
    expect(wizard).toContain('End-to-end synchronization: not tested.');
    expect(wizard).toContain('A → B connectivity/readiness preflight');
    expect(wizard).toContain('B → A connectivity/readiness preflight');
    expect(wizard).not.toMatch(/synchronization (?:passed|verified)/i);
    expect(wizard).not.toContain('A → B (source to target)');
    expect(wizard).not.toContain('B → A (target to source)');
    expect(wizard).toContain('Run Read-Only Connectivity/Readiness Preflight');
  });

  test('webhook event list contains Jira system link names and no obsolete link aliases', () => {
    expect(wizard).toContain('requiredWebhookEvents');
    expect(wizard).not.toContain('jira:issue_link_created');
    expect(wizard).not.toContain('jira:issue_link_deleted');
  });

  test('activation surfaces the step that requires revalidation', () => {
    expect(wizard).toContain('requiresRevalidation');
    expect(wizard).toContain('Revalidation step:');
  });

  test('never invokes the destructive system test and keeps global pause available', () => {
    expect(wizard).not.toContain('runSystemTest');
    expect(wizard).not.toContain('systemTest');
    expect(resolver).not.toContain('runSystemTest');
    expect(app).toContain("invoke('pausePilot'");
    expect(app).toContain('Pause Synchronization');
  });

  test('review activation presents only safe metadata fields', () => {
    expect(wizard).toContain('setupStatus');
    expect(wizard).toContain('setupVersion');
    expect(wizard).toContain('setupCompletedAt');
    expect(wizard).toContain('Wizard metadata never contains API tokens, webhook secrets, Jira issue descriptions or other issue content.');
  });
});
