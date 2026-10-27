import { surfaceCard } from '../dashboard/presentation';
import React, { useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';
import Button from '@atlaskit/button';
import Checkbox from '@atlaskit/checkbox';
import SectionMessage from '@atlaskit/section-message';
import Lozenge from '@atlaskit/lozenge';
import { token } from '@atlaskit/tokens';

const metricCard = (color) => ({
  padding: token('space.150', '12px'),
  borderRadius: token('border.radius', '8px'),
  background: token('color.background.neutral.subtle', '#F4F5F7'),
  borderLeft: `3px solid ${color}`
});

const STATE_APPEARANCE = {
  running: 'inprogress',
  paused: 'moved',
  completed: 'success',
  cancelled: 'default',
  failed: 'removed',
  idle: 'default'
};

const KeyGroup = ({ title, group, appearance = 'default' }) => {
  if (!group || group.count === 0) return null;
  const keys = Array.isArray(group.issueKeys) ? group.issueKeys : [];
  const visibleKeys = keys.slice(0, 200);
  const reasons = group.reasons && typeof group.reasons === 'object'
    ? Object.entries(group.reasons)
    : [];

  return (
    <div style={{ marginTop: token('space.200', '16px') }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: token('space.100', '8px'), marginBottom: token('space.100', '8px') }}>
        <Lozenge appearance={appearance}>{group.count}</Lozenge>
        <strong style={{ fontSize: '13px' }}>{title}</strong>
      </div>
      {reasons.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.100', '8px'), marginBottom: token('space.100', '8px') }}>
          {reasons.map(([reason, count]) => (
            <code key={reason} style={{ fontSize: '11px', padding: '2px 6px', background: '#F4F5F7', borderRadius: '4px' }}>
              {reason}: {count}
            </code>
          ))}
        </div>
      )}
      {visibleKeys.length > 0 && (
        <div style={{
          maxHeight: '140px',
          overflow: 'auto',
          fontSize: '12px',
          fontFamily: 'monospace',
          color: token('color.text.subtle', '#6B778C'),
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word'
        }}>
          {visibleKeys.join(', ')}
          {keys.length > visibleKeys.length ? ` … +${keys.length - visibleKeys.length} more` : ''}
        </div>
      )}
    </div>
  );
};

const InitialSyncPanel = ({ selectedOrg, showMessage }) => {
  const orgId = selectedOrg?.id || null;
  const [preview, setPreview] = useState(null);
  const [status, setStatus] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState('');
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState('');

  const loadStatus = async () => {
    if (!orgId) return;
    setStatusLoading(true);
    try {
      const result = await invoke('getInitialSyncStatus', { orgId });
      if (result?.success) {
        setStatus(result.status || null);
      } else {
        setError(result?.error || 'Unable to load initial-sync status.');
      }
    } catch {
      setError('Unable to load initial-sync status.');
    } finally {
      setStatusLoading(false);
    }
  };

  useEffect(() => {
    setPreview(null);
    setApproved(false);
    setError('');
    loadStatus();
  }, [orgId]);

  useEffect(() => {
    if (!status || status.state !== 'running') return undefined;
    const timer = setTimeout(() => loadStatus(), 3000);
    return () => clearTimeout(timer);
  }, [status?.state, status?.updatedAt, orgId]);

  const handlePreview = async () => {
    if (!orgId) return;
    setPreviewLoading(true);
    setApproved(false);
    setError('');
    try {
      const result = await invoke('previewInitialSync', { orgId });
      if (result?.success) {
        setPreview(result.preview);
        showMessage?.('Initial-sync preview completed. No Jira writes were performed.', 'success');
      } else {
        setError(result?.error || 'Initial-sync preview failed.');
      }
    } catch {
      setError('Initial-sync preview failed.');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleStart = async () => {
    if (!orgId || !preview || !approved) return;
    setActionLoading('start');
    setError('');
    try {
      const result = await invoke('startInitialSync', {
        orgId,
        approved: true,
        previewChecksum: preview.previewChecksum,
        configurationChecksum: preview.configurationChecksum
      });
      if (result?.success) {
        setStatus(result.job);
        setPreview(null);
        setApproved(false);
        showMessage?.('Initial sync started. Progress is persisted after each confirmed issue.', 'success');
      } else {
        setError(result?.error || 'Initial sync could not be started.');
        if (result?.code === 'PREVIEW_CHECKSUM_MISMATCH'
            || result?.code === 'CONFIGURATION_CHECKSUM_MISMATCH') {
          setApproved(false);
        }
      }
    } catch {
      setError('Initial sync could not be started.');
    } finally {
      setActionLoading('');
    }
  };

  const handleControl = async (action) => {
    if (!orgId) return;
    setActionLoading(action);
    setError('');
    try {
      const resolver = action === 'pause'
        ? 'pauseInitialSync'
        : action === 'resume'
          ? 'resumeInitialSync'
          : 'cancelInitialSync';
      const result = await invoke(resolver, { orgId });
      if (result?.success) {
        setStatus(result.job);
        showMessage?.(
          action === 'pause'
            ? 'Initial sync paused at the last confirmed item.'
            : action === 'resume'
              ? 'Initial sync resumed from the persisted cursor.'
              : 'Initial sync cancelled. Completed Jira writes were not reversed.',
          'success'
        );
      } else {
        setError(result?.error || `Unable to ${action} initial sync.`);
      }
    } catch {
      setError(`Unable to ${action} initial sync.`);
    } finally {
      setActionLoading('');
    }
  };

  const counts = preview?.counts || null;
  const zeroEligibleWork = Boolean(preview) && counts?.eligible === 0;
  const jobCounts = status?.counts || null;
  const progress = status?.progress || null;
  const progressPercent = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.processed / progress.total) * 100))
    : 0;
  const activeJob = status && (status.state === 'running' || status.state === 'paused');

  return (
    <div style={surfaceCard()} data-testid="initial-sync-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: token('space.200', '16px'), flexWrap: 'wrap' }}>
        <div>
          <h4 style={{ margin: 0 }}>Initial Sync Backfill</h4>
          <p style={{ margin: '4px 0 0 0', color: '#6B778C', fontSize: '13px' }}>
            Preview existing {selectedOrg?.name || 'organization'} issues, then run a bounded, resumable backfill through the issue-create ledger.
          </p>
        </div>
        {status && <Lozenge appearance={STATE_APPEARANCE[status.state] || 'default'} isBold>{String(status.state || 'idle').toUpperCase()}</Lozenge>}
      </div>

      <SectionMessage appearance="warning">
        <p style={{ margin: 0, fontSize: '13px' }}>
          Preview is read-only and shows issue keys only. Starting requires administrator approval bound to the exact project, JQL, mappings, options and classification checksum. Summary matching, mapping deletion, issue recreation and delete propagation are not used.
        </p>
      </SectionMessage>

      {!orgId && (
        <p style={{ fontSize: '13px', color: '#6B778C' }}>Select an organization to preview initial sync.</p>
      )}

      {orgId && (
        <div style={{ display: 'flex', gap: token('space.150', '12px'), flexWrap: 'wrap', marginTop: token('space.200', '16px') }}>
          <Button
            appearance="subtle"
            onClick={handlePreview}
            isLoading={previewLoading}
            isDisabled={previewLoading || actionLoading !== '' || !!activeJob}
          >
            Preview Scope
          </Button>
          {!zeroEligibleWork && (
            <Button
              appearance="primary"
              onClick={handleStart}
              isLoading={actionLoading === 'start'}
              isDisabled={!preview || !approved || actionLoading !== '' || !!activeJob}
            >
              Start Approved Initial Sync
            </Button>
          )}
          <Button appearance="subtle" onClick={loadStatus} isLoading={statusLoading}>
            Refresh Status
          </Button>
        </div>
      )}

      {error && (
        <div style={{ marginTop: token('space.200', '16px') }}>
          <SectionMessage appearance="error">
            <p style={{ margin: 0, fontSize: '13px' }}>{error}</p>
          </SectionMessage>
        </div>
      )}

      {counts && (
        <div style={{ marginTop: token('space.200', '16px') }}>
          <h5 style={{ margin: '0 0 8px 0' }}>Read-only Preview</h5>
          <div className="workflow-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: token('space.150', '12px') }}>
            <div style={metricCard('#0052CC')}><strong>{counts.eligible}</strong><div style={{ fontSize: '12px' }}>Eligible</div></div>
            <div style={metricCard('#00875A')}><strong>{counts.alreadyMapped}</strong><div style={{ fontSize: '12px' }}>Already mapped</div></div>
            <div style={metricCard('#FF991F')}><strong>{counts.blockedByValidation}</strong><div style={{ fontSize: '12px' }}>Blocked by validation</div></div>
            <div style={metricCard('#DE350B')}><strong>{counts.mappingConflicts}</strong><div style={{ fontSize: '12px' }}>Mapping conflicts</div></div>
          </div>
          <p style={{ margin: '8px 0 0 0', fontSize: '12px', color: '#6B778C' }}>
            Preview checksum: <code>{preview.previewChecksum}</code>
          </p>
          <KeyGroup title="Eligible issue keys" group={preview.classification.eligible} appearance="inprogress" />
          <KeyGroup title="Already mapped issue keys" group={preview.classification.alreadyMapped} appearance="success" />
          <KeyGroup title="Blocked issue keys" group={preview.classification.blockedByValidation} appearance="moved" />
          <KeyGroup title="Mapping-conflict issue keys" group={preview.classification.mappingConflicts} appearance="removed" />
          <div style={{ marginTop: token('space.200', '16px') }}>
            {zeroEligibleWork ? (
              <SectionMessage appearance="info">
                <p style={{ margin: 0, fontSize: '13px' }}>
                  No eligible issues were found. No issues will be created, and there is nothing to approve or start.
                </p>
              </SectionMessage>
            ) : (
              <Checkbox
                label="I approve this exact previewed scope. I understand this creates issues that are not yet mapped."
                isChecked={approved}
                onChange={(event) => setApproved(event.target.checked)}
              />
            )}
          </div>
        </div>
      )}

      {status && status.state !== 'idle' && (
        <div style={{ marginTop: token('space.300', '24px'), borderTop: `1px solid ${token('color.border', '#DFE1E6')}`, paddingTop: token('space.200', '16px') }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: token('space.150', '12px'), flexWrap: 'wrap' }}>
            <div>
              <h5 style={{ margin: 0 }}>Persistent Job Progress</h5>
              <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: '#6B778C' }}>
                {progress ? `${progress.processed} of ${progress.total} eligible issues processed` : 'No progress recorded'}
                {status.lastConfirmedKey ? ` • Last confirmed: ${status.lastConfirmedKey}` : ''}
              </p>
            </div>
            {status.reasonCode && <code style={{ fontSize: '11px' }}>{status.reasonCode}</code>}
          </div>
          <div style={{ height: '8px', background: '#DFE1E6', borderRadius: '4px', overflow: 'hidden', marginTop: token('space.150', '12px') }}>
            <div style={{ width: `${progressPercent}%`, height: '100%', background: '#0052CC', transition: 'width 0.3s ease' }} />
          </div>
          <div className="workflow-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: token('space.150', '12px'), marginTop: token('space.200', '16px') }}>
            <div style={metricCard('#00875A')}><strong>{jobCounts?.created || 0}</strong><div style={{ fontSize: '12px' }}>Created</div></div>
            <div style={metricCard('#36B37E')}><strong>{jobCounts?.alreadyMapped || 0}</strong><div style={{ fontSize: '12px' }}>Already mapped</div></div>
            <div style={metricCard('#6B778C')}><strong>{jobCounts?.skipped || 0}</strong><div style={{ fontSize: '12px' }}>Skipped</div></div>
            <div style={metricCard('#DE350B')}><strong>{jobCounts?.mappingConflicts || 0}</strong><div style={{ fontSize: '12px' }}>Conflicts</div></div>
            <div style={metricCard('#FF991F')}><strong>{jobCounts?.reconciliationRequired || 0}</strong><div style={{ fontSize: '12px' }}>Reconciliation required</div></div>
            <div style={metricCard('#DE350B')}><strong>{jobCounts?.failed || 0}</strong><div style={{ fontSize: '12px' }}>Failed</div></div>
            <div style={metricCard('#6B778C')}><strong>{jobCounts?.cancelled || 0}</strong><div style={{ fontSize: '12px' }}>Cancelled / not started</div></div>
          </div>

          <div style={{ display: 'flex', gap: token('space.150', '12px'), flexWrap: 'wrap', marginTop: token('space.200', '16px') }}>
            <Button
              appearance="subtle"
              onClick={() => handleControl('pause')}
              isLoading={actionLoading === 'pause'}
              isDisabled={status.state !== 'running' || actionLoading !== ''}
            >
              Pause
            </Button>
            <Button
              appearance="subtle"
              onClick={() => handleControl('resume')}
              isLoading={actionLoading === 'resume'}
              isDisabled={status.state !== 'paused' || actionLoading !== ''}
            >
              Resume
            </Button>
            <Button
              appearance="danger"
              onClick={() => handleControl('cancel')}
              isLoading={actionLoading === 'cancel'}
              isDisabled={!activeJob || actionLoading !== ''}
            >
              Cancel
            </Button>
          </div>
          <p style={{ margin: '8px 0 0 0', fontSize: '12px', color: '#6B778C' }}>
            Global Pause blocks every new Jira write. Pausing here preserves the cursor. Cancellation stops new work but never reverses completed Jira writes.
          </p>
        </div>
      )}
    </div>
  );
};

export default InitialSyncPanel;
