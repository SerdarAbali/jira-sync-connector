import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';
import Button from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import Spinner from '@atlaskit/spinner';
import Lozenge from '@atlaskit/lozenge';
import { token } from '@atlaskit/tokens';

/**
 * Compact export surface for one organization's mapping and create-ledger
 * recovery snapshot. It is deliberately read-only: it downloads a file and
 * displays what the file contains. It never restores, adopts mappings or
 * changes the pause state.
 */

const surfaceCard = (overrides = {}) => ({
  background: token('color.background.neutral', '#FFFFFF'),
  borderRadius: token('border.radius', '8px'),
  border: `1px solid ${token('color.border', '#DFE1E6')}`,
  padding: token('space.300', '24px'),
  ...overrides
});

const summaryLabelStyle = {
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: token('color.text.subtle', '#6B778C')
};

const monoStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '12px',
  wordBreak: 'break-all'
};

export const SNAPSHOT_PAUSE_REQUIRED_TEXT =
  'Pause synchronization to export a recovery snapshot. The export reads storage only and never changes the pause state itself.';

export const SNAPSHOT_SCOPE_TEXT =
  'This file is a mapping and create-operation ledger recovery snapshot for one organization. It is not a complete Forge installation backup: installation configuration, credentials, secrets, comments, issue descriptions and attachment content are not included.';

export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function downloadSnapshot(result) {
  const blob = new Blob([result.content], { type: result.contentType || 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = result.fileName || 'recovery-snapshot.ndjson';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

const SummaryItem = ({ label, value }) => (
  <div>
    <div style={summaryLabelStyle}>{label}</div>
    <div style={{ fontSize: '13px' }}>{value}</div>
  </div>
);

const RecoverySnapshot = ({ selectedOrg, showMessage }) => {
  const orgId = selectedOrg?.id || null;
  const [pause, setPause] = useState({ readable: true, paused: null });
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(null);
    setPause({ readable: true, paused: null });

    invoke('getPilotStatus')
      .then(status => {
        if (cancelled) return;
        setPause({
          readable: status?.success !== false,
          paused: status?.paused === true
        });
      })
      .catch(() => {
        if (!cancelled) setPause({ readable: false, paused: null });
      });

    return () => { cancelled = true; };
  }, [orgId]);

  const exportSnapshot = useCallback(async () => {
    if (!orgId || exporting) return;
    setExporting(true);
    setError(null);

    try {
      const response = await invoke('exportRecoverySnapshot', { orgId });
      if (!response?.success || typeof response.content !== 'string') {
        setResult(null);
        setError(response?.error || 'The recovery snapshot could not be exported.');
        return;
      }

      downloadSnapshot(response);
      setResult(response);
      if (typeof showMessage === 'function') {
        showMessage('Recovery snapshot downloaded', 'success');
      }
    } catch (invokeError) {
      setResult(null);
      setError('The recovery snapshot could not be exported. Nothing was written.');
    } finally {
      setExporting(false);
    }
  }, [exporting, orgId, showMessage]);

  const paused = pause.paused === true;
  const canExport = Boolean(orgId) && paused && !exporting;

  return (
    <div style={surfaceCard({ marginBottom: token('space.200', '16px') })}>
      <div style={{ display: 'flex', alignItems: 'center', gap: token('space.100', '8px'), marginBottom: token('space.200', '16px') }}>
        <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>Export Integration Recovery Snapshot</h3>
        {pause.paused === null ? null : (
          <Lozenge appearance={paused ? 'moved' : 'success'}>
            {paused ? 'Writes paused' : 'Writes active'}
          </Lozenge>
        )}
      </div>

      <p style={{ marginTop: 0, marginBottom: token('space.200', '16px'), fontSize: '13px', color: token('color.text.subtle', '#6B778C') }}>
        {SNAPSHOT_SCOPE_TEXT}
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.300', '24px'), marginBottom: token('space.200', '16px') }}>
        <SummaryItem label="Organization" value={selectedOrg?.name || 'Not selected'} />
        <SummaryItem label="Organization id" value={orgId || 'Not selected'} />
        <SummaryItem label="Remote host" value={result?.organization?.remoteHost || 'Shown after export'} />
      </div>

      {!orgId && (
        <p style={{ marginBottom: token('space.200', '16px'), fontSize: '12px' }}>
          Select one organization before exporting.
        </p>
      )}

      {orgId && !pause.readable && (
        <SectionMessage appearance="warning" title="Pause state could not be read">
          <p style={{ margin: 0 }}>
            The export requires the emergency pause. Its current state could not be read, so
            exporting is disabled here. The server refuses the export in the same situation.
          </p>
        </SectionMessage>
      )}

      {orgId && pause.readable && pause.paused === false && (
        <SectionMessage appearance="warning" title="Pause required">
          <p style={{ margin: 0 }}>{SNAPSHOT_PAUSE_REQUIRED_TEXT}</p>
        </SectionMessage>
      )}

      <div style={{ marginTop: token('space.200', '16px'), display: 'flex', alignItems: 'center', gap: token('space.150', '12px') }}>
        <Button appearance="primary" isDisabled={!canExport} isLoading={exporting} onClick={exportSnapshot}>
          Export and download snapshot
        </Button>
        {exporting && <Spinner size="small" />}
      </div>

      {error && (
        <div style={{ marginTop: token('space.200', '16px') }}>
          <SectionMessage appearance="error" title="Snapshot not exported">
            <p style={{ margin: 0 }}>{error}</p>
          </SectionMessage>
        </div>
      )}

      {result && (
        <div style={{ marginTop: token('space.200', '16px'), display: 'flex', flexDirection: 'column', gap: token('space.150', '12px') }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.300', '24px') }}>
            <SummaryItem label="Issue pairs" value={result.counts?.pairs ?? 0} />
            <SummaryItem label="Create ledger records" value={result.counts?.ledger ?? 0} />
            <SummaryItem label="Total records" value={result.counts?.total ?? 0} />
            <SummaryItem label="File size" value={formatBytes(result.bytes)} />
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.300', '24px') }}>
            <SummaryItem label="App id" value={result.identity?.appId || 'unavailable'} />
            <SummaryItem label="Environment" value={result.identity?.environmentType || 'unavailable'} />
            <SummaryItem label="Installation id" value={result.identity?.installationId || 'unavailable'} />
            <SummaryItem label="Site" value={result.identity?.siteHost || 'unavailable'} />
          </div>

          <div>
            <div style={summaryLabelStyle}>
              Checksum (sha256, detects corruption only — not a signature)
            </div>
            <div style={monoStyle}>{result.checksum}</div>
          </div>

          <p style={{ margin: 0, fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
            Exported {result.exportedAt} while writes were paused. Keep the file outside this
            installation; Forge storage does not hold a second copy.
          </p>
        </div>
      )}
    </div>
  );
};

export default RecoverySnapshot;
