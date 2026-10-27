import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';
import Button from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import { token } from '@atlaskit/tokens';
import Field, { fieldLabelStyle } from '../dashboard/Field.jsx';

/**
 * Controlled restore panel for an already previewed recovery snapshot.
 *
 * It is intentionally separate from the read-only export/preview component:
 * planning, approval and batches are writes to Forge storage, while the
 * snapshot preview must remain a component that never invokes a mutating
 * resolver. The panel never changes the pause state and never restores
 * synchronization authorization.
 */

const monoStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '12px',
  wordBreak: 'break-all'
};

export const RESTORE_SCOPE_TEXT =
  'Restore only missing mappings and succeeded create-ledger rows from this file. Each step requires the pause to remain ON and an explicit, digest-bound approval. No Jira issue is created, updated or deleted, and synchronization authorization is never restored automatically.';

export default function RecoveryRestore({
  orgId = null,
  paused = false,
  previewContent = null,
  preview = null,
  showMessage
}) {
  const [plan, setPlan] = useState(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    setPlan(null);
    setConfirmation('');
    setBusy(null);
    setError(null);
    setMessage(null);
    setResult(null);
  }, [orgId, previewContent]);

  const planRestore = useCallback(async () => {
    if (!orgId || !previewContent || busy) return;
    setBusy('plan');
    setError(null);
    setMessage(null);
    setResult(null);
    try {
      const response = await invoke('planRecoveryRestore', { orgId, content: previewContent });
      if (!response?.success) {
        setPlan(null);
        setError(response?.error || 'The restore plan could not be created.');
        return;
      }
      setPlan(response);
      setConfirmation('');
      setMessage('A bounded restore plan was created. Nothing has been written to mappings, ledger rows or Jira.');
    } catch {
      setPlan(null);
      setError('The restore plan could not be created. Nothing was written.');
    } finally {
      setBusy(null);
    }
  }, [orgId, previewContent, busy]);

  const approveRestore = useCallback(async () => {
    if (!orgId || !plan || busy) return;
    setBusy('approve');
    setError(null);
    setMessage(null);
    try {
      const response = await invoke('approveRecoveryRestore', {
        orgId,
        digest: plan.digest,
        confirmation
      });
      if (!response?.success) {
        setError(response?.error || 'The restore plan was not approved.');
        return;
      }
      setPlan(current => ({ ...current, ...response, status: response.status }));
      setMessage('Plan approved. Synchronization authorization is restore-in-progress; the pause was not changed.');
    } catch {
      setError('The restore plan was not approved. Nothing was written.');
    } finally {
      setBusy(null);
    }
  }, [orgId, plan, confirmation, busy]);

  const applyRestore = useCallback(async () => {
    if (!orgId || !plan || busy) return;
    setBusy('apply');
    setError(null);
    setMessage(null);
    try {
      const response = await invoke('applyRecoveryRestore', {
        orgId,
        digest: plan.digest,
        batchSize: 10
      });
      if (!response?.success) {
        setError(response?.error || 'The restore batch could not be completed.');
        return;
      }
      setPlan(current => ({ ...current, ...response, status: response.status }));
      setResult(response);
      setMessage(response.status === 'completed'
        ? 'Restore completed. The pause remains ON and synchronization authorization is blocked until it is explicitly re-established.'
        : 'Batch completed. Review the remaining count and run another batch.');
      if (typeof showMessage === 'function') {
        showMessage('Recovery restore batch completed', 'success');
      }
    } catch {
      setError('The restore batch could not be completed. Completed items remain durable.');
    } finally {
      setBusy(null);
    }
  }, [orgId, plan, busy, showMessage]);

  const cancelRestore = useCallback(async () => {
    if (!orgId || !plan || busy) return;
    setBusy('cancel');
    setError(null);
    setMessage(null);
    try {
      const response = await invoke('cancelRecoveryRestore', { orgId });
      if (!response?.success) {
        setError(response?.error || 'The restore plan could not be cancelled.');
        return;
      }
      setPlan(null);
      setConfirmation('');
      setResult(null);
      setMessage('Restore plan cancelled. The pause remains ON and synchronization stays blocked.');
    } catch {
      setError('The restore plan could not be cancelled.');
    } finally {
      setBusy(null);
    }
  }, [orgId, plan, busy]);

  const canPlan = Boolean(orgId) && paused && Boolean(previewContent)
    && Number(preview?.counts?.restorablePairs || 0) > 0 && !busy;
  const canApprove = Boolean(plan) && paused && plan.status === 'pending'
    && confirmation === plan.approvalPhrase && !busy;
  const canApply = Boolean(plan) && paused
    && ['approved', 'running', 'needs-attention'].includes(plan.status)
    && !busy;
  const canCancel = Boolean(plan) && paused
    && !['completed', 'cancelled'].includes(plan.status)
    && !busy;

  return (
    <div
      style={{
        marginTop: token('space.300', '24px'),
        paddingTop: token('space.300', '24px'),
        borderTop: `1px solid ${token('color.border', '#DFE1E6')}`
      }}
    >
      <h3 style={{ margin: 0, marginBottom: token('space.100', '8px'), fontSize: '16px', fontWeight: 600 }}>
        Controlled restore
      </h3>
      <p style={{ marginTop: 0, marginBottom: token('space.200', '16px'), fontSize: '13px', color: token('color.text.subtle', '#6B778C') }}>
        {RESTORE_SCOPE_TEXT}
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: token('space.150', '12px') }}>
        <Button isDisabled={!canPlan} isLoading={busy === 'plan'} onClick={planRestore}>
          Create bounded restore plan
        </Button>
        {plan && (
          <Button
            appearance="subtle"
            isDisabled={!canCancel}
            isLoading={busy === 'cancel'}
            onClick={cancelRestore}
          >
            Cancel plan
          </Button>
        )}
      </div>

      {error && (
        <div style={{ marginTop: token('space.200', '16px') }}>
          <SectionMessage appearance="error" title="Restore not applied">
            <p style={{ margin: 0 }}>{error}</p>
          </SectionMessage>
        </div>
      )}

      {message && (
        <p style={{ marginTop: token('space.200', '16px'), marginBottom: 0, fontSize: '12px' }}>
          {message}
        </p>
      )}


      {plan && (
        <div style={{ marginTop: token('space.200', '16px'), display: 'flex', flexDirection: 'column', gap: token('space.150', '12px') }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.300', '24px') }}>
            <Field label="Plan status" value={plan.status || 'pending'} />
            <Field label="Pairs in plan" value={plan.counts?.selectedPairs ?? 0} />
            <Field label="Witness confirmed" value={plan.counts?.witnessConfirmed ?? 0} />
            <Field label="Witness absent (approved from file)" value={plan.counts?.witnessAbsent ?? 0} />
            <Field label="Ledger rows in plan" value={plan.counts?.ledgerRows ?? 0} />
            <Field label="Excluded pairs" value={plan.counts?.excludedPairs ?? 0} />
          </div>

          <div>
            <div style={fieldLabelStyle}>Plan digest</div>
            <div style={monoStyle}>{plan.digest}</div>
          </div>

          <div>
            <div style={fieldLabelStyle}>Exact approval phrase</div>
            <div style={monoStyle}>{plan.approvalPhrase}</div>
          </div>

          {plan.excluded?.length > 0 && (
            <div>
              <div style={fieldLabelStyle}>Excluded from this plan</div>
              <ul style={{ margin: 0, paddingLeft: token('space.300', '24px'), ...monoStyle }}>
                {plan.excluded.slice(0, 10).map((entry) => (
                  <li key={`${entry.localKey}-${entry.remoteKey}`}>
                    {entry.localKey} to {entry.remoteKey}: {entry.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plan.status === 'pending' && (
            <div>
              <label htmlFor="restore-confirmation" style={fieldLabelStyle}>
                Type the exact approval phrase to arm restore
              </label>
              <input
                id="restore-confirmation"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                disabled={Boolean(busy)}
                style={{ width: '100%', maxWidth: '720px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }}
              />
            </div>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.150', '12px') }}>
            {plan.status === 'pending' && (
              <Button
                appearance="primary"
                isDisabled={!canApprove}
                isLoading={busy === 'approve'}
                onClick={approveRestore}
              >
                Approve restore plan
              </Button>
            )}
            {['approved', 'running', 'needs-attention'].includes(plan.status) && (
              <Button
                appearance="primary"
                isDisabled={!canApply}
                isLoading={busy === 'apply'}
                onClick={applyRestore}
              >
                Apply next batch
              </Button>
            )}
          </div>

          {result && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.300', '24px') }}>
              <Field label="Processed" value={result.processed ?? 0} />
              <Field label="Mappings written" value={result.mappingWrites ?? 0} />
              <Field label="Ledger rows written" value={result.ledgerWrites ?? 0} />
              <Field label="Remaining" value={result.remaining ?? 0} />
              <Field label="Jira writes" value={result.jiraWrites ?? 0} />
            </div>
          )}

          {plan.status === 'completed' && (
            <SectionMessage appearance="success" title="Restore complete">
              <p style={{ margin: 0 }}>
                The pause remains ON and synchronization authorization is blocked. Re-authorize synchronization
                explicitly only after reviewing the restored mappings and ledger.
              </p>
            </SectionMessage>
          )}

          {plan.status === 'needs-attention' && (
            <SectionMessage appearance="warning" title="Restore needs attention">
              <p style={{ margin: 0 }}>
                At least one item conflicted and was not written. Review the plan status before re-planning.
              </p>
            </SectionMessage>
          )}
        </div>
      )}
    </div>
  );
}

