import { surfaceCard } from '../dashboard/presentation';
import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';
import Button from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import Spinner from '@atlaskit/spinner';
import TextField from '@atlaskit/textfield';
import Checkbox from '@atlaskit/checkbox';
import Lozenge from '@atlaskit/lozenge';
import Select from '@atlaskit/select';
import ModalDialog, { ModalTransition, ModalHeader, ModalTitle, ModalBody, ModalFooter } from '@atlaskit/modal-dialog';
import { token } from '@atlaskit/tokens';

const ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-[0-9]+$/;

const summaryLabelStyle = {
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: token('color.text.subtle', '#6B778C')
};

export const CREATE_DIRECTION_OPTIONS = [
  { label: 'Local → remote (local issue was created remotely)', value: 'local-to-remote' },
  { label: 'Remote → local (remote issue was created locally)', value: 'remote-to-local' }
];

const STATE_APPEARANCE = {
  unknown: 'moved',
  succeeded: 'success',
  pending: 'default',
  failed_definitive: 'removed'
};

const STATE_LABEL = {
  unknown: 'Outcome unknown',
  succeeded: 'Succeeded',
  pending: 'Pending',
  failed_definitive: 'Rejected'
};

export const CREATE_RECONCILIATION_REASON_TEXT = {
  CREATE_RECONCILIATION_REQUIRED:
    'The create request was submitted but its outcome was never recorded. Verify in Jira whether the issue exists, then supply its exact key.',
  CREATE_SUCCEEDED_MAPPING_MISSING:
    'The ledger recorded a successful create but the mapping is missing or different. Confirm the recorded issue key to repair the mapping.',
  CREATE_ALREADY_RECONCILED:
    'The ledger and the active mapping already agree. Nothing needs to be reconciled.',
  CREATE_IN_PROGRESS:
    'A create attempt still owns the ledger for this issue. Wait for it to resolve; a stale attempt becomes an unknown outcome and can then be reconciled.',
  CREATE_RETRY_ALLOWED:
    'The create was rejected before or by Jira, so no ambiguous outcome exists. Retry the synchronization instead of reconciling.',
  CREATE_OPERATION_NOT_FOUND:
    'This connector never recorded a create attempt for this issue. Pairs created before the ledger existed cannot be repaired here.',
  CREATE_STATE_INVALID:
    'The ledger state is not recognized. Do not reconcile; report the issue key to an administrator.'
};

export const CREATE_RECONCILIATION_ERROR_TEXT = {
  MAPPING_CONFLICT:
    'The source or destination issue is already mapped to a different issue. Resolve that mapping first; nothing was changed.',
  CREATE_TARGET_MISMATCH:
    'The ledger is already reconciled to a different issue key. Look up the ledger again before retrying.',
  TARGET_ISSUE_NOT_FOUND:
    'The destination issue could not be read with the configured credentials. Check the key and the destination project.',
  TARGET_PROJECT_MISMATCH:
    'The destination issue is not in the project configured for this organization. Nothing was changed.',
  TARGET_PROJECT_NOT_CONFIGURED:
    'No destination project is configured for this organization. Nothing was changed.',
  SOURCE_ISSUE_NOT_FOUND:
    'The source issue could not be read. Nothing was changed.',
  CREATE_STATE_INVALID:
    'The ledger state does not allow reconciliation. Nothing was changed.',
  CREATE_ATTEMPT_STALE:
    'The ledger changed while reconciling. Look up the ledger again.',
  CREATE_OPERATION_NOT_FOUND:
    'No create operation exists for this organization and source issue. Nothing was changed.',
  CREATE_OPERATION_STORAGE_ERROR:
    'The ledger could not be updated. Nothing was changed; retry the lookup.',
  FORBIDDEN:
    'Jira administrator permission is required for this action.',
  INVALID_RECONCILIATION_REQUEST:
    'The organization, direction, source key and an explicit destination key are required.',
  ORGANIZATION_NOT_FOUND:
    'The selected organization no longer exists.',
  RECONCILIATION_FAILED:
    'Reconciliation failed unexpectedly. Nothing was created or deleted.'
};

export const isExplicitCreateTargetKey = value =>
  typeof value === 'string' && ISSUE_KEY_PATTERN.test(value.trim());

const lookupErrorText = code => {
  if (code === 'FORBIDDEN') return CREATE_RECONCILIATION_ERROR_TEXT.FORBIDDEN;
  if (code === 'ORGANIZATION_NOT_FOUND') return CREATE_RECONCILIATION_ERROR_TEXT.ORGANIZATION_NOT_FOUND;
  if (code === 'INVALID_CREATE_LOOKUP_REQUEST') {
    return 'Enter a valid organization, direction and source issue key.';
  }
  return 'The create ledger could not be read. Nothing was changed.';
};

const IssueCreateRecovery = ({ selectedOrg, showMessage }) => {
  const orgId = selectedOrg?.id || null;
  const [direction, setDirection] = useState(CREATE_DIRECTION_OPTIONS[0].value);
  const [sourceKey, setSourceKey] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lookupKey, setLookupKey] = useState('');
  const [destinationKey, setDestinationKey] = useState('');
  const [verified, setVerified] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [actionError, setActionError] = useState('');
  const [reconciling, setReconciling] = useState(false);

  const lookUp = useCallback(async key => {
    const lookupSource = (key || '').trim();
    if (!orgId || !lookupSource) return;
    setLoading(true);
    setError('');
    setActionError('');
    try {
      const response = await invoke('getIssueCreateOperationStatus', {
        orgId,
        direction,
        sourceKey: lookupSource
      });
      if (!response?.success) {
        setResult(null);
        setLookupKey('');
        setError(lookupErrorText(response?.code));
        return;
      }
      setResult(response);
      setLookupKey(lookupSource);
      setDestinationKey(response.reconciliation?.recordedTargetKey || '');
      setVerified(false);
    } catch {
      setResult(null);
      setLookupKey('');
      setError('The create ledger could not be read. Nothing was changed.');
    } finally {
      setLoading(false);
    }
  }, [orgId, direction]);

  useEffect(() => {
    setResult(null);
    setLookupKey('');
    setDestinationKey('');
    setVerified(false);
    setError('');
    setActionError('');
  }, [orgId, direction]);

  const destinationKeyValid = isExplicitCreateTargetKey(destinationKey);
  const canReconcile = Boolean(
    result?.reconciliation?.applicable
    && destinationKeyValid
    && verified
    && !reconciling
  );

  const reconcile = async () => {
    if (!result || !canReconcile) return;
    setReconciling(true);
    setActionError('');
    try {
      const response = await invoke('reconcileIssueCreate', {
        orgId,
        direction,
        sourceKey: result.sourceKey,
        jiraIssueKey: destinationKey.trim()
      });
      if (!response?.success) {
        setActionError(
          CREATE_RECONCILIATION_ERROR_TEXT[response?.code]
          || 'Reconciliation failed. Nothing was created or deleted.'
        );
        return;
      }
      setConfirmOpen(false);
      showMessage?.(
        response.message || 'Create operation reconciled without creating or deleting any issue.',
        'success'
      );
      await lookUp(result.sourceKey);
    } catch {
      setActionError('Reconciliation failed. Nothing was created or deleted.');
    } finally {
      setReconciling(false);
    }
  };

  if (!orgId) {
    return (
      <SectionMessage appearance="information" title="Ambiguous Issue Create Recovery">
        <p style={{ margin: 0 }}>Select an organization to inspect its issue create ledger.</p>
      </SectionMessage>
    );
  }

  const operation = result?.operation || null;
  const reconciliation = result?.reconciliation || null;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: token('space.200', '16px'),
      marginBottom: token('space.300', '24px')
    }}>
      <div style={surfaceCard({ display: 'flex', flexDirection: 'column', gap: token('space.200', '16px') })}>
        <div>
          <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>Ambiguous Issue Create Recovery</h3>
          <p style={{ margin: `${token('space.100', '8px')} 0 0`, fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
            Reads the persisted create ledger for one explicitly supplied issue key. Reading changes nothing.
            Reconciling repairs the mapping only: it never creates or deletes a Jira issue and never retries the create.
          </p>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.200', '16px'), alignItems: 'flex-end' }}>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, minWidth: 'min(320px, 100%)', maxWidth: '100%', flex: '1 1 220px' }}>
            Direction
            <Select
              inputId="create-recovery-direction"
              options={CREATE_DIRECTION_OPTIONS}
              value={CREATE_DIRECTION_OPTIONS.find(option => option.value === direction) || null}
              onChange={option => setDirection(option?.value || CREATE_DIRECTION_OPTIONS[0].value)}
              isDisabled={loading || reconciling}
            />
          </label>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, minWidth: 'min(220px, 100%)', maxWidth: '100%', flex: '1 1 220px' }}>
            Source issue key
            <TextField
              value={sourceKey}
              placeholder="e.g. PROJ-123"
              onChange={event => setSourceKey(event.target.value)}
              isDisabled={loading || reconciling}
            />
          </label>
          <Button
            appearance="primary"
            isLoading={loading}
            isDisabled={loading || reconciling || !sourceKey.trim()}
            onClick={() => lookUp(sourceKey)}
          >
            Look up create ledger
          </Button>
        </div>

        {error && (
          <SectionMessage appearance="error" title="Ledger lookup failed">
            <p style={{ margin: 0 }}>{error}</p>
          </SectionMessage>
        )}

        {loading && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: token('space.200', '16px') }}>
            <Spinner size="medium" />
          </div>
        )}

        {!loading && result && result.exists === false && (
          <SectionMessage appearance="warning" title="No create operation recorded">
            <p style={{ margin: 0 }}>
              {CREATE_RECONCILIATION_REASON_TEXT.CREATE_OPERATION_NOT_FOUND}
            </p>
            <p style={{ margin: `${token('space.100', '8px')} 0 0`, fontSize: '12px' }}>
              Source mapping: {result.mapping?.sourceMappedKey
                ? `${result.sourceKey} is already mapped to ${result.mapping.sourceMappedKey}`
                : `${result.sourceKey} is not mapped`}.
            </p>
          </SectionMessage>
        )}

        {!loading && result && result.exists && operation && reconciliation && (
          <>
            <div className="workflow-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: token('space.150', '12px') }}>
              <div>
                <div style={summaryLabelStyle}>Operation state</div>
                <div style={{ marginTop: '4px' }}>
                  <Lozenge appearance={STATE_APPEARANCE[operation.state] || 'default'}>
                    {STATE_LABEL[operation.state] || operation.state}
                  </Lozenge>
                </div>
              </div>
              <div>
                <div style={summaryLabelStyle}>Attempt</div>
                <div style={{ marginTop: '4px' }}>{operation.attempt ?? '—'}</div>
              </div>
              <div>
                <div style={summaryLabelStyle}>Create submission marker</div>
                <div style={{ marginTop: '4px' }}>{operation.submissionStarted ? 'Present' : 'Absent'}</div>
                {operation.state === 'unknown' && (
                  <div style={{ marginTop: '4px', fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
                    Absence is not proof the remote create was never sent.
                  </div>
                )}
              </div>
              <div>
                <div style={summaryLabelStyle}>Recorded destination key</div>
                <div style={{ marginTop: '4px' }}>{operation.targetKey || '—'}</div>
              </div>
              <div>
                <div style={summaryLabelStyle}>Source mapping</div>
                <div style={{ marginTop: '4px' }}>
                  {result.mapping?.sourceMappedKey
                    ? `Mapped to ${result.mapping.sourceMappedKey}`
                    : 'Not mapped'}
                </div>
              </div>
              <div>
                <div style={summaryLabelStyle}>Reconciliation applicable</div>
                <div style={{ marginTop: '4px' }}>{reconciliation.applicable ? 'Yes' : 'No'}</div>
              </div>
            </div>

            <SectionMessage
              appearance={reconciliation.applicable ? 'warning' : 'information'}
              title={reconciliation.applicable ? 'Reconciliation is available' : 'Reconciliation is not available'}
            >
              <p style={{ margin: 0 }}>
                {CREATE_RECONCILIATION_REASON_TEXT[reconciliation.reason]
                  || CREATE_RECONCILIATION_REASON_TEXT.CREATE_STATE_INVALID}
              </p>
            </SectionMessage>

            {reconciliation.applicable && (
              <div key={lookupKey} style={{ display: 'flex', flexDirection: 'column', gap: token('space.150', '12px') }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, maxWidth: '320px' }}>
                  Destination issue key (must be entered or confirmed explicitly)
                  <TextField
                    value={destinationKey}
                    placeholder="e.g. REMOTE-456"
                    onChange={event => setDestinationKey(event.target.value)}
                    isDisabled={reconciling}
                  />
                </label>
                {destinationKey.trim().length > 0 && !destinationKeyValid && (
                  <p style={{ margin: 0, fontSize: '12px', color: token('color.text.danger', '#DE350B') }}>
                    Enter a complete issue key such as PROJ-123.
                  </p>
                )}
                <Checkbox
                  label="I verified this destination issue directly in Jira and understand that reconciliation only repairs the mapping."
                  isChecked={verified}
                  onChange={() => setVerified(current => !current)}
                  isDisabled={reconciling}
                />
                <div>
                  <Button
                    appearance="warning"
                    isDisabled={!canReconcile}
                    isLoading={reconciling}
                    onClick={() => setConfirmOpen(true)}
                  >
                    Reconcile mapping for this create
                  </Button>
                </div>
              </div>
            )}

            {actionError && (
              <SectionMessage appearance="error" title="Reconciliation failed">
                <p style={{ margin: 0 }}>{actionError}</p>
              </SectionMessage>
            )}
          </>
        )}
      </div>

      <ModalTransition>
        {confirmOpen && result && (
          <ModalDialog onClose={() => setConfirmOpen(false)}>
            <ModalHeader><ModalTitle>Repair the create mapping?</ModalTitle></ModalHeader>
            <ModalBody>
              <p style={{ marginTop: 0 }}>
                The ledger for {result.sourceKey}
                ({direction === 'local-to-remote' ? 'local → remote' : 'remote → local'})
                will be marked successful for the explicitly supplied issue
                {' '}<strong>{destinationKey.trim()}</strong>.
              </p>
              <p>
                Reconciliation only repairs the mapping. It does not create, update or delete any Jira issue,
                and it does not retry the create request.
              </p>
              <p style={{ fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
                Confirm only after verifying the destination issue independently in Jira.
              </p>
            </ModalBody>
            <ModalFooter>
              <Button appearance="subtle" onClick={() => setConfirmOpen(false)}>Cancel</Button>
              <Button
                appearance="primary"
                isLoading={reconciling}
                isDisabled={!canReconcile}
                onClick={reconcile}
              >
                Reconcile mapping
              </Button>
            </ModalFooter>
          </ModalDialog>
        )}
      </ModalTransition>
    </div>
  );
};

export default IssueCreateRecovery;

