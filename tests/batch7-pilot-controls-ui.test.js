import fs from 'fs';
import path from 'path';

const APP_PATH = path.join(process.cwd(), 'static/admin-page/src/App.jsx');
const RECOVERY_PATH = path.join(process.cwd(), 'docs/OPERATIONS.md');
const source = fs.readFileSync(APP_PATH, 'utf8');
const recovery = fs.readFileSync(RECOVERY_PATH, 'utf8');

function componentScope(name) {
  const start = source.indexOf(`const ${name} = (`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf('\nconst ', start + 1);
  return source.slice(start, end > start ? end : source.length);
}

describe('Batch 7 pilot pause UI controls', () => {
  const syncActivity = componentScope('SyncActivityPanel');

  test('the status panel exposes Pause and Resume controls', () => {
    expect(syncActivity).toContain('Synchronization Write Control');
    expect(syncActivity).toContain('Write Status');
    expect(syncActivity).toContain('Pause Synchronization');
    expect(syncActivity).toContain('Resume Synchronization');
    expect(syncActivity).toContain('pilotConfirmAction');
    expect(syncActivity).toContain('Pause Synchronization?');
    expect(syncActivity).toContain('Resume Synchronization?');
    expect(syncActivity).not.toMatch(/Corporate Pilot|Pilot Status|Pilot Controls|Pause Jira Writes|Resume Jira Writes/);
  });

  test('controls require confirmation and use the fixed emergency_stop reason code', () => {
    expect(syncActivity).toContain("invoke('pausePilot', { reasonCode: 'emergency_stop' })");
    expect(syncActivity).toContain("invoke('resumePilot')");
    expect(syncActivity).toContain('onClick={executePilotAction}');
    expect(syncActivity).toContain('pilotConfirmAction === \'pause\'');
  });

  test('successful actions refresh status and loading blocks repeated clicks', () => {
    expect(syncActivity).toContain('await loadStats();');
    expect(syncActivity).toContain('pilotActionLoading');
    expect(syncActivity).toContain('isDisabled={pilotActionLoading || syncStats.pilot.paused}');
    expect(syncActivity).toContain('isDisabled={pilotActionLoading || !syncStats.pilot.paused}');
    expect(syncActivity).toContain('isDisabled={pilotActionLoading}');
  });

  test('no duplicate operating-mode or direction control is added', () => {
    expect(source).not.toContain('setPilotMode');
    expect(source).not.toContain('one_way');
    expect(source).not.toContain('pilotMode');
    expect(source).not.toContain('operatingMode');
    expect(syncActivity).not.toContain('Operating Mode');
    expect(syncActivity).not.toContain('Pilot Mode');
  });
});

describe('Batch 7 recovery documentation warning', () => {
  test('warns that older versions do not enforce pilotPause', () => {
    expect(recovery).toContain('do not read or enforce the `pilotPause` key');
    expect(recovery).toContain('removes pause enforcement');
    expect(recovery).toContain('can allow Jira writes to resume');
  });

  test('forbids rollback during an active emergency and requires a verified alternative', () => {
    expect(recovery).toContain('Do not roll back while emergency write blocking is required');
    expect(recovery).toContain('Keep the pause-capable version deployed for the entire active incident');
    expect(recovery).toContain('Do not use an application rollback as an emergency stop');
    expect(recovery).toContain('another verified method');
    expect(recovery).not.toContain('If emergency write blocking is still required, keep the current version');
  });
});
