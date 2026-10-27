import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';
import Button from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import TextField from '@atlaskit/textfield';
import { token } from '@atlaskit/tokens';
import Field, { fieldLabelStyle } from '../dashboard/Field.jsx';

/**
 * Explicit sprint mapping and synchronization panel.
 *
 * A sprint pair is never inferred. The administrator supplies both sprint ids,
 * verifies the identities, previews the membership additions, and applies the
 * digest-bound preview. The panel never creates a sprint or removes membership.
 */
export const SPRINT_SYNC_SCOPE_TEXT =
  'Sprint synchronization is opt-in and Off by default. It only adds mapped counterpart issues to explicitly verified sprint mappings while synchronization is paused and authorized. It never creates sprints, matches by sprint name, or removes existing membership.';

const monoStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '12px',
  wordBreak: 'break-all'
};

export default function SprintSyncPanel({ orgId, enabled, showMessage }) {
  const [mappings, setMappings] = useState([]);
  const [localSprintId, setLocalSprintId] = useState('');
  const [remoteSprintId, setRemoteSprintId] = useState('');
  const [mappingConfirmation, setMappingConfirmation] = useState('');
  const [plan, setPlan] = useState(null);
  const [applyConfirmation, setApplyConfirmation] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  const loadStatus = useCallback(async () => {
    if (!orgId || !enabled) return;
    try {
      const response = await invoke('getSprintSyncStatus', { orgId });
      if (response?.success) setMappings(response.mappings || []);
    } catch {
      // The panel remains usable; status reload is advisory.
    }
  }, [orgId, enabled]);

  useEffect(() => {
    setPlan(null);
    setLocalSprintId('');
    setRemoteSprintId('');
    setMappingConfirmation('');
    setApplyConfirmation('');
    setError(null);
    setMessage(null);
    loadStatus();
  }, [orgId, enabled, loadStatus]);

  const saveMapping = useCallback(async () => {
    if (!orgId || !localSprintId.trim() || !remoteSprintId.trim() || busy) return;
    setBusy('mapping');
    setError(null);
    setMessage(null);
    try {
      const response = await invoke('saveSprintMapping', {
        orgId,
        localSprintId: localSprintId.trim(),
        remoteSprintId: remoteSprintId.trim(),
        confirmation: mappingConfirmation
      });
      if (!response?.success) {
        setError(response?.error || 'The sprint mapping could not be verified.');
        return;
      }
      setMessage('Sprint identities were verified and the mapping was saved. No issue membership was changed.');
      setMappingConfirmation('');
      await loadStatus();
    } catch {
      setError('The sprint mapping could not be verified. Nothing was changed in Jira.');
    } finally {
      setBusy(null);
    }
  }, [orgId, localSprintId, remoteSprintId, mappingConfirmation, busy, loadStatus]);

  const preview = useCallback(async () => {
    if (!orgId || !localSprintId.trim() || !remoteSprintId.trim() || busy) return;
    setBusy('preview');
    setError(null);
    setMessage(null);
    setPlan(null);
    try {
      const response = await invoke('previewSprintSync', {
        orgId,
        localSprintId: localSprintId.trim(),
        remoteSprintId: remoteSprintId.trim()
      });
      if (!response?.success) {
        setError(response?.error || 'Sprint synchronization could not be previewed.');
        return;
      }
      setPlan(response);
      setApplyConfirmation('');
      setMessage(response.status === 'ready'
        ? 'Preview ready. Review the additions and type the exact confirmation phrase.'
        : `Preview status: ${response.status}.`);
    } catch {
      setError('Sprint synchronization could not be previewed. Nothing was written.');
    } finally {
      setBusy(null);
    }
  }, [orgId, localSprintId, remoteSprintId, busy]);

  const apply = useCallback(async () => {
    if (!orgId || !plan || busy) return;
    setBusy('apply');
    setError(null);
    setMessage(null);
    try {
      const response = await invoke('applySprintSync', {
        orgId,
        localSprintId: plan.mapping.localSprintId,
        remoteSprintId: plan.mapping.remoteSprintId,
        digest: plan.digest,
        confirmation: applyConfirmation
      });
      if (!response?.success) {
        setError(response?.error || 'Sprint synchronization was not applied.');
        return;
      }
      setMessage(response.message || 'Sprint synchronization completed.');
      setPlan(null);
      setApplyConfirmation('');
      if (typeof showMessage === 'function') {
        showMessage('Sprint synchronization completed', 'success');
      }
    } catch {
      setError('Sprint synchronization was not applied. A partial result may need a fresh preview.');
    } finally {
      setBusy(null);
    }
  }, [orgId, plan, applyConfirmation, busy, showMessage]);

  if (!enabled) return null;

  const mappingPhrase = localSprintId.trim() && remoteSprintId.trim()
    ? `MAP SPRINT ${orgId} ${localSprintId.trim()} ${remoteSprintId.trim()}`
    : '';
  const canApprove = Boolean(plan?.status === 'ready')
    && applyConfirmation === plan?.confirmationPhrase
    && !busy;

  return (
    <div style={{
      marginTop: token('space.300', '24px'),
      paddingTop: token('space.300', '24px'),
      borderTop: `1px solid ${token('color.border', '#DFE1E6')}`,
      display: 'flex',
      flexDirection: 'column',
      gap: token('space.150', '12px')
    }}>
      <h5 style={{ margin: 0 }}>Sprint synchronization</h5>
      <p style={{ margin: 0, fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
        {SPRINT_SYNC_SCOPE_TEXT}
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.150', '12px'), alignItems: 'flex-end' }}>
        <label style={{ flex: '1 1 180px', minWidth: 0 }}>
          <span style={fieldLabelStyle}>Local sprint id</span>
          <TextField
            value={localSprintId}
            onChange={(event) => setLocalSprintId(event.target.value)}
            placeholder="e.g. 42"
            isDisabled={Boolean(busy)}
          />
        </label>
        <label style={{ flex: '1 1 180px', minWidth: 0 }}>
          <span style={fieldLabelStyle}>Remote sprint id</span>
          <TextField
            value={remoteSprintId}
            onChange={(event) => setRemoteSprintId(event.target.value)}
            placeholder="e.g. 84"
            isDisabled={Boolean(busy)}
          />
        </label>
      </div>

      {mappingPhrase && (
        <div>
          <div style={fieldLabelStyle}>Exact mapping confirmation</div>
          <div style={monoStyle}>{mappingPhrase}</div>
          <TextField
            value={mappingConfirmation}
            onChange={(event) => setMappingConfirmation(event.target.value)}
            placeholder="Type the phrase above"
            isDisabled={Boolean(busy)}
            style={{ marginTop: '6px', maxWidth: '720px' }}
          />
          <div style={{ marginTop: token('space.100', '8px') }}>
            <Button
              isDisabled={Boolean(busy) || mappingConfirmation !== mappingPhrase}
              isLoading={busy === 'mapping'}
              onClick={saveMapping}
            >
              Verify and save sprint mapping
            </Button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.150', '12px') }}>
        <Button isDisabled={Boolean(busy) || !localSprintId.trim() || !remoteSprintId.trim()} isLoading={busy === 'preview'} onClick={preview}>
          Preview sprint synchronization
        </Button>
      </div>


      {mappings.length > 0 && (
        <div>
          <div style={fieldLabelStyle}>Verified mappings</div>
          <ul style={{ margin: 0, paddingLeft: token('space.300', '24px'), ...monoStyle }}>
            {mappings.map((mapping) => (
              <li key={`${mapping.localSprintId}-${mapping.remoteSprintId}`}>
                local {mapping.localSprintId} ↔ remote {mapping.remoteSprintId}
                {mapping.localName || mapping.remoteName
                  ? ` (${mapping.localName || 'unnamed'} / ${mapping.remoteName || 'unnamed'})`
                  : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <SectionMessage appearance="error" title="Sprint operation not applied">
          <p style={{ margin: 0 }}>{error}</p>
        </SectionMessage>
      )}
      {message && <p style={{ margin: 0, fontSize: '12px' }}>{message}</p>}

      {plan && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: token('space.150', '12px') }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.300', '24px') }}>
            <Field label="Preview status" value={plan.status} />
            <Field label="Remote issues to add" value={plan.counts?.remoteToAdd ?? 0} />
            <Field label="Local issues to add" value={plan.counts?.localToAdd ?? 0} />
            <Field label="Already present" value={plan.counts?.alreadyPresent ?? 0} />
            <Field label="Unmapped" value={plan.counts?.unmapped ?? 0} />
          </div>
          {plan.blockedReasons?.length > 0 && (
            <SectionMessage appearance="warning" title="Sprint synchronization blocked">
              <p style={{ margin: 0 }}>{plan.blockedReasons.join(', ')}</p>
            </SectionMessage>
          )}
          {plan.status === 'ready' && (
            <>
              <div>
                <div style={fieldLabelStyle}>Exact apply confirmation</div>
                <div style={monoStyle}>{plan.confirmationPhrase}</div>
                <TextField
                  value={applyConfirmation}
                  onChange={(event) => setApplyConfirmation(event.target.value)}
                  placeholder="Type the phrase above"
                  isDisabled={Boolean(busy)}
                  style={{ marginTop: '6px', maxWidth: '720px' }}
                />
              </div>
              <div>
                <Button
                  appearance="primary"
                  isDisabled={!canApprove}
                  isLoading={busy === 'apply'}
                  onClick={apply}
                >
                  Apply sprint additions
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

