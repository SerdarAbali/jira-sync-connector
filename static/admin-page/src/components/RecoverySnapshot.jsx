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

export const SNAPSHOT_PREVIEW_TEXT =
  'Preview compares a previously exported file with current storage. It only reads: no mapping, create-ledger, manifest or restore-plan write is made, and no Jira issue is read or modified.';

export const SNAPSHOT_PREVIEW_PAUSE_TEXT =
  'Preview requires the same emergency pause as the export.';

export const SNAPSHOT_PREVIEW_MAX_BYTES = 3 * 1024 * 1024;

const PREVIEW_REASON_TEXT = {
  'remote-key-differs': 'stored remote key differs',
  'remote-key-already-mapped': 'remote key already mapped to another local issue',
  'directed-mapping-differs': 'a directed lookup points at another issue',
  'ledger-target-differs-from-pair': 'ledger target contradicts the exported pair',
  'ledger-state-differs': 'stored ledger state differs',
  'mapping-ended': 'pair was ended by an administrator',
  'mapping-repair': 'partial mapping write needs repair',
  'counterpart-deleted': 'counterpart is recorded as deleted',
  'counterpart-archived': 'counterpart record is archived',
  'counterpart-unreadable': 'counterpart record is unreadable'
};

export const RECOVERABILITY_REASON_TEXT = {
  'v1-insufficient-evidence': 'This is a version 1 file, so it has no directional, ended, repair or counterpart evidence.',
  'different-installation': 'The file belongs to a different installation or environment.',
  'directional-evidence-incomplete': 'At least one exported pair is missing a directed lookup.',
  'directional-evidence-conflicting': 'At least one pair has two directed lookups that disagree.',
  'evidence-conflicting': 'The file carries recovery records that contradict each other.'
};

export function previewReasonText(reason) {
  return PREVIEW_REASON_TEXT[reason] || reason || 'unspecified';
}

export function previewIdentityText(classification) {
  if (classification === 'same-installation') return 'Same installation';
  if (classification === 'different-installation') return 'Different installation of the same app';
  return 'Not comparable';
}

/**
 * Reads a selected file as UTF-8 text. `Blob.text()` is used when available and
 * FileReader otherwise; both paths are local to the browser.
 */
export async function readFileText(file) {
  if (file && typeof file.text === 'function') {
    return await file.text();
  }
  if (typeof FileReader === 'function') {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('File could not be read'));
      reader.readAsText(file);
    });
  }
  throw new Error('File reading is unavailable');
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
  const [previewFile, setPreviewFile] = useState(null);
  const [previewContent, setPreviewContent] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(null);
    setPause({ readable: true, paused: null });
    setPreviewFile(null);
    setPreviewContent(null);
    setPreview(null);
    setPreviewError(null);

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

  const selectPreviewFile = useCallback(async (event) => {
    const file = event?.target?.files?.[0] || null;
    setPreview(null);
    setPreviewError(null);
    setPreviewContent(null);
    setPreviewFile(null);
    if (!file) return;

    if (Number(file.size) > SNAPSHOT_PREVIEW_MAX_BYTES) {
      setPreviewError('The selected file is larger than the 3 MB preview budget.');
      return;
    }

    try {
      const text = await readFileText(file);
      setPreviewContent(text);
      setPreviewFile({
        name: file.name || 'recovery-snapshot.ndjson',
        size: Number.isFinite(Number(file.size)) ? Number(file.size) : text.length
      });
    } catch {
      setPreviewError('The selected file could not be read.');
    }
  }, []);

  const previewSnapshot = useCallback(async () => {
    if (!orgId || !previewContent || previewing) return;
    setPreviewing(true);
    setPreviewError(null);

    try {
      const response = await invoke('previewRecoverySnapshot', { orgId, content: previewContent });
      if (!response?.success) {
        setPreview(null);
        setPreviewError(response?.error || 'The snapshot could not be previewed.');
        return;
      }
      setPreview(response);
    } catch (invokeError) {
      setPreview(null);
      setPreviewError('The snapshot could not be previewed. Nothing was written.');
    } finally {
      setPreviewing(false);
    }
  }, [orgId, previewContent, previewing]);

  const canPreview = Boolean(orgId) && paused && Boolean(previewContent) && !previewing;
  const pairCounts = preview?.counts?.pairs || {};
  const ledgerCounts = preview?.counts?.ledger || {};
  const conflictSamples = preview
    ? [
      ...(preview.samples?.pairs?.conflicting || []).map(
        (entry) => `Pair ${entry.localKey} to ${entry.remoteKey}: ${previewReasonText(entry.reason)}`
      ),
      ...(preview.samples?.pairs?.blocked || []).map(
        (entry) => `Pair ${entry.localKey} to ${entry.remoteKey}: ${previewReasonText(entry.reason)}`
      ),
      ...(preview.samples?.ledger?.conflicting || []).map(
        (entry) => `Ledger ${entry.direction} ${entry.sourceKey}: ${previewReasonText(entry.reason)}`
      )
    ]
    : [];

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

      <div
        style={{
          marginTop: token('space.300', '24px'),
          paddingTop: token('space.300', '24px'),
          borderTop: `1px solid ${token('color.border', '#DFE1E6')}`
        }}
      >
        <h3 style={{ margin: 0, marginBottom: token('space.100', '8px'), fontSize: '16px', fontWeight: 600 }}>
          Preview restore from a snapshot file
        </h3>

        <p style={{ marginTop: 0, marginBottom: token('space.200', '16px'), fontSize: '13px', color: token('color.text.subtle', '#6B778C') }}>
          {SNAPSHOT_PREVIEW_TEXT}
        </p>

        <input
          type="file"
          accept=".ndjson,.json,.txt,application/x-ndjson"
          onChange={selectPreviewFile}
          disabled={!orgId || previewing}
          aria-label="Recovery snapshot file"
          style={{ marginBottom: token('space.150', '12px'), fontSize: '13px' }}
        />

        {previewFile && (
          <p style={{ marginTop: 0, marginBottom: token('space.150', '12px'), fontSize: '12px', ...monoStyle }}>
            {previewFile.name} ({formatBytes(previewFile.size)})
          </p>
        )}

        {orgId && pause.readable && pause.paused === false && (
          <p style={{ marginTop: 0, marginBottom: token('space.150', '12px'), fontSize: '12px' }}>
            {SNAPSHOT_PREVIEW_PAUSE_TEXT}
          </p>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: token('space.150', '12px') }}>
          <Button isDisabled={!canPreview} isLoading={previewing} onClick={previewSnapshot}>
            Preview restore (read-only)
          </Button>
          {previewing && <Spinner size="small" />}
        </div>

        {previewError && (
          <div style={{ marginTop: token('space.200', '16px') }}>
            <SectionMessage appearance="error" title="Snapshot not previewed">
              <p style={{ margin: 0 }}>{previewError}</p>
            </SectionMessage>
          </div>
        )}

        {preview && (
          <div style={{ marginTop: token('space.200', '16px'), display: 'flex', flexDirection: 'column', gap: token('space.150', '12px') }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.300', '24px') }}>
              <SummaryItem
                label="Installation identity"
                value={previewIdentityText(preview.identity?.classification)}
              />
              <SummaryItem
                label="Organization routing"
                value={preview.organization?.match
                  ? 'Matches the selected organization'
                  : `Differs: ${(preview.organization?.differences || []).join(', ')}`}
              />
              <SummaryItem
                label="File checksum"
                value={preview.checksum?.verified ? 'Verified (sha256)' : 'Not verified'}
              />
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.300', '24px') }}>
              <SummaryItem label="Pairs already present" value={pairCounts['already-present-consistent'] ?? 0} />
              <SummaryItem label="Pairs missing" value={pairCounts['missing-potentially-restorable'] ?? 0} />
              <SummaryItem label="Pairs conflicting" value={pairCounts.conflicting ?? 0} />
              <SummaryItem label="Pairs blocked" value={pairCounts['blocked-by-existing-record'] ?? 0} />
              <SummaryItem label="Pairs incomplete directional" value={pairCounts['incomplete-directional'] ?? 0} />
              <SummaryItem label="Pairs restorable here" value={preview.counts?.restorablePairs ?? 0} />
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.300', '24px') }}>
              <SummaryItem label="Ended mappings in file" value={preview.evidence?.ended ?? 0} />
              <SummaryItem label="Repair markers in file" value={preview.evidence?.repaired ?? 0} />
              <SummaryItem label="Deleted counterparts in file" value={preview.evidence?.counterpartBlocking ?? 0} />
              <SummaryItem label="Archived counterparts in file" value={preview.evidence?.counterpartArchived ?? 0} />
            </div>

            {preview.recoverability && !preview.recoverability.recoverable && (
              <SectionMessage appearance="warning" title="Not sufficient for recovery after storage loss">
                <ul style={{ margin: 0, paddingLeft: token('space.300', '24px') }}>
                  {preview.recoverability.reasons.map((reason) => (
                    <li key={reason}>{RECOVERABILITY_REASON_TEXT[reason] || reason}</li>
                  ))}
                </ul>
              </SectionMessage>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.300', '24px') }}>
              <SummaryItem label="Ledger rows already present" value={ledgerCounts['already-present-consistent'] ?? 0} />
              <SummaryItem label="Ledger rows missing" value={ledgerCounts.missing ?? 0} />
              <SummaryItem label="Ledger rows conflicting" value={ledgerCounts.conflicting ?? 0} />
            </div>

            {preview.identity?.crossInstallation && (
              <SectionMessage appearance="warning" title="Different installation">
                <p style={{ margin: 0 }}>
                  This file was exported from another installation of the same app. Its records are
                  shown for comparison only and are not restorable here.
                </p>
              </SectionMessage>
            )}

            {conflictSamples.length > 0 && (
              <div>
                <div style={summaryLabelStyle}>Conflicts and blocks (sample)</div>
                <ul style={{ margin: 0, paddingLeft: token('space.300', '24px'), ...monoStyle }}>
                  {conflictSamples.map((line) => <li key={line}>{line}</li>)}
                </ul>
              </div>
            )}

            <p style={{ margin: 0, fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
              Preview only. Nothing was written to Forge storage, Jira or the pause state.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default RecoverySnapshot;
