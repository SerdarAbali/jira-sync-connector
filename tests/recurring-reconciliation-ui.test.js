import fs from 'fs';
import path from 'path';

const APP_PATH = path.join(process.cwd(), 'static/admin-page/src/App.jsx');
const PANEL_PATH = path.join(
  process.cwd(),
  'static/admin-page/src/components/RecurringReconciliation.jsx'
);
const MANIFEST_PATH = path.join(process.cwd(), 'manifest.yml');
const DOC_PATH = path.join(process.cwd(), 'RECURRING_RECONCILIATION.md');

const app = fs.readFileSync(APP_PATH, 'utf8');
const panel = fs.readFileSync(PANEL_PATH, 'utf8');
const manifest = fs.readFileSync(MANIFEST_PATH, 'utf8');
const documentation = fs.readFileSync(DOC_PATH, 'utf8');

describe('Recurring reconciliation admin UI', () => {
  test('is rendered for the selected organization from Sync Activity', () => {
    expect(app).toContain("import RecurringReconciliation from './components/RecurringReconciliation'");
    expect(app).toContain('<RecurringReconciliation');
    expect(app).toContain('selectedOrg={selectedOrg}');
    expect(app).toContain('showMessage={showMessage}');
    expect(app).toContain('onSettingsSaved={() => setSchedulerRefreshToken(token => token + 1)}');
  });

  test('labels the feature as local-to-remote only and not bidirectional', () => {
    expect(panel).toContain('local-to-remote source reconciliation');
    expect(panel).toContain('Remote Jira is never scanned');
    expect(panel).toContain('not full bidirectional reconciliation');
    expect(panel).toContain('updates outdated mapped counterparts');
    expect(panel).toContain('Mapped issues are never sent to');
    expect(panel).toContain('the create path');
    expect(panel).toContain('Mapped issues updated');
    expect(panel).toContain('Default is off');
  });

  test('offers opt-in settings and the separate Resolve/Acknowledge controls', () => {
    expect(panel).toContain("invoke('saveRecurringReconciliationSettings'");
    expect(panel).toContain('recurringReconciliationEnabled');
    expect(panel).toContain('reconciliationIntervalMinutes');
    expect(panel).toContain('reconciliationCommentOnReview');
    expect(panel).toContain('reconciliationFailureThreshold');
    expect(panel).toContain('Resolve after Health Check');
    expect(panel).toContain('Acknowledge Notifications');
    expect(panel).toContain("runAction('resolveRecurringReconciliationAttention'");
    expect(panel).toContain("runAction('acknowledgeRecurringReconciliationAttention'");
  });

  test('explains strict post-run scheduling semantics', () => {
    expect(panel).toContain('nextRunAt is written only when the run completes');
    expect(panel).toContain('global-pause deferrals never advance it');
    expect(panel).toContain('existing hourly recovery heartbeat');
  });

  test('adds no new queue, trigger, function or permission scope', () => {
    expect(manifest).not.toContain('reconciliation-queue');
    expect(manifest).not.toContain('reconciliation-trigger');
    expect(manifest).not.toContain('reconciliation-fn');
    expect(manifest).toContain('key: initial-sync-recovery');
  });
});

describe('Recurring reconciliation documentation', () => {
  test('documents the feature boundary, scheduling and semantics', () => {
    expect(documentation).toContain('local-to-remote source reconciliation');
    expect(documentation).toContain('full bidirectional reconciliation');
    expect(documentation).toContain('nextRunAt');
    expect(documentation).toContain('never written when a job is enqueued');
    expect(documentation).toContain('updates outdated mapped counterparts');
    expect(documentation).toContain('never sent to the create path');
    expect(documentation).toContain('Acknowledge Notifications');
    expect(documentation).toContain('Resolve after Health Check');
    expect(documentation).toContain('marker');
  });
});
