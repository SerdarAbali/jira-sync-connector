import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';
import Button from '@atlaskit/button';
import Checkbox from '@atlaskit/checkbox';
import Select from '@atlaskit/select';
import SectionMessage from '@atlaskit/section-message';
import Spinner from '@atlaskit/spinner';
import Lozenge from '@atlaskit/lozenge';
import { token } from '@atlaskit/tokens';

const surfaceCard = (overrides = {}) => ({
  background: token('color.background.neutral', '#FFFFFF'),
  borderRadius: token('border.radius', '8px'),
  border: `1px solid ${token('color.border', '#DFE1E6')}`,
  padding: token('space.300', '24px'),
  ...overrides
});

const metricCard = (color) => ({
  padding: token('space.150', '12px'),
  borderRadius: token('border.radius', '8px'),
  background: token('color.background.neutral.subtle', '#F4F5F7'),
  borderLeft: `3px solid ${color}`
});

const INTERVAL_OPTIONS = [
  { label: 'Every hour', value: 60 },
  { label: 'Every 3 hours', value: 180 },
  { label: 'Every 6 hours', value: 360 },
  { label: 'Every 12 hours', value: 720 },
  { label: 'Every 24 hours', value: 1440 }
];

const THRESHOLD_OPTIONS = [1, 2, 3, 4, 5].map(value => ({
  label: `${value} failed run${value === 1 ? '' : 's'}`,
  value
}));

const formatDateTimeEuro = (timestamp) => {
  if (!timestamp) return 'Not yet';
  try {
    return new Intl.DateTimeFormat('fi-FI', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: 'Europe/Helsinki'
    }).format(new Date(timestamp));
  } catch {
    return timestamp;
  }
};

const attentionAppearance = (record) => {
  if (record?.state === 'resolved') return 'success';
  if (record?.acknowledgedAt) return 'default';
  return 'moved';
};

const attentionLabel = (record) => {
  if (record?.state === 'resolved') return 'RESOLVED';
  if (record?.acknowledgedAt) return 'OPEN / ACKNOWLEDGED';
  return 'OPEN';
};

const RecurringReconciliation = ({ selectedOrg, showMessage, onSettingsSaved }) => {
  const orgId = selectedOrg?.id || null;
  const [status, setStatus] = useState(null);
  const [draft, setDraft] = useState({
    recurringReconciliationEnabled: false,
    reconciliationIntervalMinutes: 60,
    reconciliationCommentOnReview: true,
    reconciliationFailureThreshold: 3
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionKey, setActionKey] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError('');
    try {
      const result = await invoke('getRecurringReconciliationStatus', { orgId });
      if (result?.success) {
        setStatus(result);
        setDraft(result.settings);
      } else {
        setError(result?.code || 'Recurring reconciliation status could not be loaded.');
      }
    } catch {
      setError('Recurring reconciliation status could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    setStatus(null);
    setError('');
    load();
  }, [load]);

  useEffect(() => {
    if (!status?.activeJob) return undefined;
    const timer = setTimeout(() => load(), 5000);
    return () => clearTimeout(timer);
  }, [status?.activeJob?.updatedAt, status?.activeJob?.state, load]);

  const handleSave = async () => {
    if (!orgId) return;
    setSaving(true);
    setError('');
    try {
      const result = await invoke('saveRecurringReconciliationSettings', {
        orgId,
        settings: draft
      });
      if (result?.success) {
        setDraft(result.settings);
        onSettingsSaved?.(result.settings);
        showMessage?.(
          result.settings.recurringReconciliationEnabled
            ? 'Recurring source reconciliation enabled. The next hourly heartbeat will evaluate the due run.'
            : 'Recurring source reconciliation disabled. Any active run was cancelled.',
          'success'
        );
        await load();
      } else {
        setError(result?.error || result?.code || 'Settings could not be saved.');
      }
    } catch {
      setError('Settings could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const runAction = async (resolver, record) => {
    if (!orgId || !record) return;
    const key = `${resolver}:${record.localKey}`;
    setActionKey(key);
    setError('');
    try {
      const result = await invoke(resolver, {
        orgId,
        localKey: record.localKey
      });
      if (result?.success) {
        showMessage?.(
          resolver === 'resolveRecurringReconciliationAttention'
            ? 'Attention resolved after fresh local and remote health checks confirmed synchronization.'
            : 'Notifications muted. The technical issue remains open and visible.',
          'success'
        );
        await load();
      } else {
        setError(result?.code || 'Reconciliation attention action failed.');
      }
    } catch {
      setError('Reconciliation attention action failed.');
    } finally {
      setActionKey('');
    }
  };

  if (!orgId) {
    return (
      <SectionMessage appearance="information" title="Recurring Source Reconciliation">
        <p style={{ margin: 0 }}>
          Select an organization to configure opt-in recurring local-to-remote source reconciliation.
        </p>
      </SectionMessage>
    );
  }

  const attention = Array.isArray(status?.attention) ? status.attention : [];
  const summary = status?.attentionSummary || {};
  const job = status?.lastJob;
  const schedule = status?.schedule;

  return (
    <div style={surfaceCard()} data-testid="recurring-reconciliation-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: token('space.200', '16px'), flexWrap: 'wrap' }}>
        <div>
          <h4 style={{ margin: 0 }}>Recurring Source Reconciliation</h4>
          <p style={{ margin: '4px 0 0 0', color: token('color.text.subtle', '#6B778C'), fontSize: '13px' }}>
            Opt-in recurring local-to-remote source reconciliation for {selectedOrg?.name || 'this organization'}.
          </p>
        </div>
        <Lozenge appearance={status?.settings?.recurringReconciliationEnabled ? 'success' : 'default'} isBold>
          {status?.settings?.recurringReconciliationEnabled ? 'ENABLED' : 'OFF'}
        </Lozenge>
      </div>

      <div style={{ marginTop: token('space.200', '16px') }}>
        <SectionMessage appearance="warning">
          <p style={{ margin: 0, fontSize: '13px' }}>
            This optional recurring run updates outdated mapped counterparts and creates remote counterparts for local
            issues that are still unmapped. Remote Jira is never scanned, and this is not full bidirectional reconciliation.
            It looks only at the local projects and JQL configured for this organization. Mapped issues are never sent to
            the create path. The existing hourly recovery heartbeat schedules work; a new run cannot be enqueued until
            the active run reaches a terminal state.
          </p>
        </SectionMessage>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: token('space.200', '16px'), marginTop: token('space.200', '16px') }}>
        <div>
          <Checkbox
            label="Enable recurring local-to-remote source reconciliation"
            isChecked={draft.recurringReconciliationEnabled}
            onChange={(event) => setDraft(current => ({
              ...current,
              recurringReconciliationEnabled: event.target.checked
            }))}
          />
          <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
            Default is off. Existing installations receive no recurring writes until an administrator opts in.
          </p>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
            Minimum interval
          </label>
          <Select
            options={INTERVAL_OPTIONS}
            value={INTERVAL_OPTIONS.find(option => option.value === draft.reconciliationIntervalMinutes) || null}
            onChange={(option) => setDraft(current => ({
              ...current,
              reconciliationIntervalMinutes: option?.value || 60
            }))}
            isDisabled={!draft.recurringReconciliationEnabled}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
            Review comment threshold
          </label>
          <Select
            options={THRESHOLD_OPTIONS}
            value={THRESHOLD_OPTIONS.find(option => option.value === draft.reconciliationFailureThreshold) || null}
            onChange={(option) => setDraft(current => ({
              ...current,
              reconciliationFailureThreshold: option?.value || 3
            }))}
            isDisabled={!draft.recurringReconciliationEnabled}
          />
        </div>
      </div>

      <div style={{ marginTop: token('space.150', '12px') }}>
        <Checkbox
          label="Add one connector-generated review comment when the failure threshold is reached"
          isChecked={draft.reconciliationCommentOnReview}
          isDisabled={!draft.recurringReconciliationEnabled}
          onChange={(event) => setDraft(current => ({
            ...current,
            reconciliationCommentOnReview: event.target.checked
          }))}
        />
        <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
          The generated comment is marker-filtered and never copied to the remote organization. Acknowledged
          records suppress further notifications.
        </p>
      </div>

      <div style={{ display: 'flex', gap: token('space.150', '12px'), marginTop: token('space.200', '16px'), flexWrap: 'wrap' }}>
        <Button appearance="primary" onClick={handleSave} isLoading={saving} isDisabled={saving || loading}>
          Save Reconciliation Settings
        </Button>
        <Button appearance="subtle" onClick={load} isLoading={loading}>
          Refresh
        </Button>
      </div>

      {error && (
        <div style={{ marginTop: token('space.200', '16px') }}>
          <SectionMessage appearance="error">
            <p style={{ margin: 0, fontSize: '13px' }}>{error}</p>
          </SectionMessage>
        </div>
      )}

      {loading && !status && (
        <div style={{ display: 'flex', alignItems: 'center', gap: token('space.100', '8px'), marginTop: token('space.200', '16px') }}>
          <Spinner size="small" />
          <span style={{ fontSize: '13px' }}>Loading reconciliation status…</span>
        </div>
      )}


      {status && (
        <div style={{ marginTop: token('space.300', '24px'), borderTop: `1px solid ${token('color.border', '#DFE1E6')}`, paddingTop: token('space.200', '16px') }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: token('space.150', '12px'), flexWrap: 'wrap' }}>
            <div>
              <h5 style={{ margin: 0 }}>Schedule and Last Completed Run</h5>
              <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
                Next reconciliation run: {schedule?.nextRunAt ? formatDateTimeEuro(schedule.nextRunAt) : (schedule?.isDue ? 'Due on the next hourly heartbeat' : 'Not scheduled')}
                {' • '}Last completed reconciliation run: {formatDateTimeEuro(schedule?.lastCompletedAt)}
              </p>
            </div>
            {job && <Lozenge appearance={job.state === 'completed' ? 'success' : job.state === 'failed' ? 'removed' : job.state === 'running' || job.state === 'queued' ? 'inprogress' : 'default'}>
              {String(job.state || 'idle').toUpperCase()}
            </Lozenge>}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: token('space.150', '12px'), marginTop: token('space.150', '12px') }}>
            <div style={metricCard('#00875A')}><strong>{job?.counts?.created || 0}</strong><div style={{ fontSize: '12px' }}>Created by this run</div></div>
            <div style={metricCard('#36B37E')}><strong>{job?.counts?.updated || 0}</strong><div style={{ fontSize: '12px' }}>Mapped issues updated</div></div>
            <div style={metricCard('#36B37E')}><strong>{job?.counts?.alreadyMapped || 0}</strong><div style={{ fontSize: '12px' }}>Already mapped</div></div>
            <div style={metricCard('#FF991F')}><strong>{job?.counts?.skipped || 0}</strong><div style={{ fontSize: '12px' }}>Skipped</div></div>
            <div style={metricCard('#DE350B')}><strong>{job?.counts?.failed || 0}</strong><div style={{ fontSize: '12px' }}>Failed</div></div>
            <div style={metricCard('#6554C0')}><strong>{summary.open || 0}</strong><div style={{ fontSize: '12px' }}>Open attention</div></div>
            <div style={metricCard('#DE350B')}><strong>{summary.notificationRequired || 0}</strong><div style={{ fontSize: '12px' }}>Notifications due</div></div>
          </div>

          {job?.reasonCode && (
            <p style={{ margin: '8px 0 0 0', fontSize: '12px' }}>
              Reason: <code>{job.reasonCode}</code>
              {job.lastAttemptedKey ? ` • Last attempted: ${job.lastAttemptedKey}` : ''}
            </p>
          )}
          <p style={{ margin: '8px 0 0 0', fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
            nextRunAt is written only when the run completes, fails definitively, or is cancelled. Queue enqueue
            failures and global-pause deferrals never advance it, so the next hourly heartbeat remains due.
          </p>
        </div>
      )}


      <div style={{ marginTop: token('space.300', '24px'), borderTop: `1px solid ${token('color.border', '#DFE1E6')}`, paddingTop: token('space.200', '16px') }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: token('space.150', '12px'), flexWrap: 'wrap' }}>
          <div>
            <h5 style={{ margin: 0 }}>Attention Records</h5>
            <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
              Resolve performs a fresh local and remote health check and confirms both mapping directions.
              Acknowledge only mutes notifications; the technical record stays open.
            </p>
          </div>
          <Lozenge appearance={summary.notificationRequired > 0 ? 'removed' : 'default'}>
            {summary.notificationRequired || 0} NOTIFY
          </Lozenge>
        </div>

        {attention.length === 0 && (
          <p style={{ margin: '12px 0 0 0', fontSize: '13px', color: token('color.text.subtle', '#6B778C') }}>
            No reconciliation attention records for this organization.
          </p>
        )}

        {attention.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: token('space.100', '8px'), marginTop: token('space.150', '12px') }}>
            {attention.map(record => (
              <div key={record.localKey} style={{ padding: token('space.150', '12px'), border: `1px solid ${token('color.border', '#DFE1E6')}`, borderRadius: token('border.radius', '8px') }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: token('space.100', '8px'), flexWrap: 'wrap' }}>
                  <div>
                    <strong style={{ fontSize: '13px' }}>{record.localKey}</strong>
                    {record.remoteKey ? <span style={{ fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}> → {record.remoteKey}</span> : null}
                    <span style={{ marginLeft: token('space.100', '8px') }}><Lozenge appearance={attentionAppearance(record)}>{attentionLabel(record)}</Lozenge></span>
                  </div>
                  <code style={{ fontSize: '11px' }}>{record.reasonCode}</code>
                </div>
                <p style={{ margin: '6px 0 0 0', fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
                  {record.attempts} attempt(s) • First seen {formatDateTimeEuro(record.firstSeenAt)} • Last seen {formatDateTimeEuro(record.lastSeenAt)}
                  {record.acknowledgedAt ? ` • Acknowledged ${formatDateTimeEuro(record.acknowledgedAt)}` : ''}
                </p>
                {record.state !== 'resolved' && (
                  <div style={{ display: 'flex', gap: token('space.100', '8px'), marginTop: token('space.100', '8px'), flexWrap: 'wrap' }}>
                    <Button
                      appearance="subtle"
                      onClick={() => runAction('resolveRecurringReconciliationAttention', record)}
                      isLoading={actionKey === `resolveRecurringReconciliationAttention:${record.localKey}`}
                      isDisabled={actionKey !== ''}
                    >
                      Resolve after Health Check
                    </Button>
                    <Button
                      appearance="subtle"
                      onClick={() => runAction('acknowledgeRecurringReconciliationAttention', record)}
                      isLoading={actionKey === `acknowledgeRecurringReconciliationAttention:${record.localKey}`}
                      isDisabled={actionKey !== '' || Boolean(record.acknowledgedAt)}
                    >
                      Acknowledge Notifications
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default RecurringReconciliation;
