import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const CONFIG = fs.readFileSync(
  path.join(ROOT, 'static/admin-page/src/components/ConfigurationPanel.jsx'),
  'utf8'
);
const PANEL = fs.readFileSync(
  path.join(ROOT, 'static/admin-page/src/components/SprintSyncPanel.jsx'),
  'utf8'
);

describe('sprint sync UI wiring', () => {
  test('shows the opt-in Sync Sprints checkbox beside the existing options', () => {
    expect(CONFIG).toContain("key: 'syncSprints'");
    expect(CONFIG).toContain('Sync Sprints');
    expect(CONFIG).toContain('<SprintSyncPanel');
    expect(CONFIG).toContain('syncOptions.syncSprints === true');
  });

  test('uses explicit mapping, preview and apply endpoints only', () => {
    expect(PANEL).toContain("invoke('getSprintSyncStatus'");
    expect(PANEL).toContain("invoke('saveSprintMapping'");
    expect(PANEL).toContain("invoke('previewSprintSync'");
    expect(PANEL).toContain("invoke('applySprintSync'");
    expect(PANEL).not.toContain("invoke('createSprint");
    expect(PANEL).not.toContain("invoke('remove");
    expect(PANEL).toContain('never creates sprints');
    expect(PANEL).toContain('removes existing membership');
  });

  test('clears a previous preview and confirmation when the organization changes', () => {
    expect(PANEL).toContain('setPlan(null)');
    expect(PANEL).toContain('setMappingConfirmation(\'\')');
    expect(PANEL).toContain('setApplyConfirmation(\'\')');
    expect(PANEL).toContain('}, [orgId, enabled, loadStatus]);');
  });

  test('does not claim automatic synchronization', () => {
    expect(PANEL).toContain('Preview sprint synchronization');
    expect(PANEL).toContain('Apply sprint additions');
    expect(PANEL).not.toContain('automatic sprint synchronization');
    expect(PANEL).not.toContain('invoke(\'syncSprints');
  });

  test('requires the exact digest phrase before applying', () => {
    expect(PANEL).toContain('applyConfirmation === plan?.confirmationPhrase');
    expect(PANEL).toContain('digest: plan.digest');
  });
});
