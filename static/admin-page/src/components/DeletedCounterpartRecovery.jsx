import { surfaceCard } from '../dashboard/presentation';
import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';
import Button from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import Spinner from '@atlaskit/spinner';
import TextField from '@atlaskit/textfield';
import Lozenge from '@atlaskit/lozenge';
import ModalDialog, { ModalTransition, ModalHeader, ModalTitle, ModalBody, ModalFooter } from '@atlaskit/modal-dialog';
import { token } from '@atlaskit/tokens';

const STATUS_APPEARANCE = {
  confirmed_deleted: 'removed',
  unavailable: 'moved',
  access_problem: 'moved',
  temporary_failure: 'default'
};

const DeletedCounterpartRecovery = ({ selectedOrg, showMessage }) => {
  const orgId = selectedOrg?.id || null;
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [actionKey, setActionKey] = useState('');
  const [error, setError] = useState('');
  const [confirmAction, setConfirmAction] = useState(null);
  const [remapItem, setRemapItem] = useState(null);
  const [newLocalKey, setNewLocalKey] = useState('');
  const [newRemoteKey, setNewRemoteKey] = useState('');

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError('');
    try {
      const result = await invoke('getDeletedCounterparts', { orgId });
      if (result?.success) setItems(Array.isArray(result.items) ? result.items : []);
      else setError(result?.code || 'Recovery records could not be loaded.');
    } catch {
      setError('Recovery records could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  const runAction = async (name, item, payload = {}) => {
    if (!item) return;
    const key = `${name}:${item.localKey}:${item.remoteKey}`;
    setActionKey(key);
    setError('');
    try {
      const result = await invoke(name, {
        orgId,
        localKey: item.localKey,
        remoteKey: item.remoteKey,
        ...payload
      });
      if (result?.success) {
        const message = name === 'probeDeletedCounterpart'
          ? `Probe complete: deleted side ${result.deletedProbe?.status || 'unknown'}, survivor ${result.survivorProbe?.status || 'unknown'}.`
          : 'Deleted counterpart recovery record updated.';
        showMessage?.(message, 'success');
        setConfirmAction(null);
        setRemapItem(null);
        if (name !== 'probeDeletedCounterpart') await load();
      } else {
        setError(result?.code || result?.error || 'Recovery action failed.');
      }
    } catch {
      setError('Recovery action failed.');
    } finally {
      setActionKey('');
    }
  };

  if (!orgId) {
    return (
      <SectionMessage appearance="information" title="Deleted Counterpart Recovery">
        <p style={{ margin: 0 }}>Select an organization to review counterpart recovery records.</p>
      </SectionMessage>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: token('space.200', '16px') }}>
      <div style={surfaceCard({ display: 'flex', justifyContent: 'space-between', gap: token('space.200', '16px') })}>
        <div>
          <h3 style={{ margin: '0 0 6px 0', fontSize: '16px' }}>Deleted Counterpart Recovery</h3>
          <p style={{ margin: 0, fontSize: '13px', color: token('color.text.subtle', '#6B778C') }}>
            This list uses safe metadata only. No Jira issue is deleted. Ending a pair atomically removes both active lookup directions and preserves the old keys, organization, end time and administrator.
          </p>
        </div>
        <Button appearance="subtle" onClick={load} isLoading={loading}>Refresh</Button>
      </div>

      {error && (
        <SectionMessage appearance="error" title="Recovery action failed">
          <p style={{ margin: 0 }}>{error}</p>
        </SectionMessage>
      )}

      {loading ? <Spinner /> : null}

      {!loading && items.length === 0 && (
        <SectionMessage appearance="success" title="No deleted counterparts">
          <p style={{ margin: 0 }}>No active counterpart recovery records exist for this organization.</p>
        </SectionMessage>
      )}

      {items.map(item => (
        <div key={`${item.localKey}:${item.remoteKey}`} style={surfaceCard({ display: 'flex', flexDirection: 'column', gap: token('space.150', '12px') })}>
          <div style={{ display: 'flex', alignItems: 'center', gap: token('space.100', '8px'), flexWrap: 'wrap' }}>
            <Lozenge appearance={STATUS_APPEARANCE[item.status] || 'default'}>{item.status}</Lozenge>
            <strong style={{ fontSize: '14px' }}>{item.localKey} ↔ {item.remoteKey}</strong>
            <span style={{ fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
              {item.deletedSide === 'local' ? 'Local issue deleted' : item.deletedSide === 'remote' ? 'Remote issue deleted' : 'Availability problem'}
            </span>
          </div>
          <div style={{ fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
            Direction: {item.syncDirection}. Replacement allowed: {item.replacementAllowed ? 'Yes' : 'No'}. Automatic replacement: {item.automaticReplacementEnabled ? 'On' : 'Off'}.
            {item.firstDetectedAt ? ` First detected: ${item.firstDetectedAt}.` : ''}
          </div>
          <div style={{ display: 'flex', gap: token('space.100', '8px'), flexWrap: 'wrap' }}>
            <Button
              appearance="subtle"
              onClick={() => runAction('probeDeletedCounterpart', item)}
              isLoading={actionKey === `probeDeletedCounterpart:${item.localKey}:${item.remoteKey}`}
            >
              Probe
            </Button>
            {item.status === 'confirmed_deleted' && (
              <Button
                appearance="primary"
                isDisabled={!item.replacementAllowed}
                onClick={() => setConfirmAction({ type: 'replaceDeletedCounterpart', item })}
              >
                Recreate Counterpart
              </Button>
            )}
            <Button appearance="subtle" onClick={() => {
              setRemapItem(item);
              setNewLocalKey(item.localKey);
              setNewRemoteKey(item.remoteKey);
            }}>
              Remap
            </Button>
            <Button appearance="danger" onClick={() => setConfirmAction({ type: 'endDeletedCounterpartSync', item })}>
              End Sync
            </Button>
            {item.status !== 'confirmed_deleted' && (
              <Button appearance="subtle" onClick={() => setConfirmAction({ type: 'dismissDeletedCounterpart', item })}>
                Mark Resolved
              </Button>
            )}
          </div>
        </div>
      ))}

      <ModalTransition>
        {confirmAction && (
          <ModalDialog onClose={() => setConfirmAction(null)}>
            <ModalHeader>
              <ModalTitle>
                {confirmAction.type === 'endDeletedCounterpartSync'
                  ? 'End synchronization for this pair?'
                  : confirmAction.type === 'replaceDeletedCounterpart'
                    ? 'Recreate the deleted counterpart?'
                    : 'Mark this recovery record resolved?'}
              </ModalTitle>
            </ModalHeader>
            <ModalBody>
              <p>
                {confirmAction.type === 'endDeletedCounterpartSync'
                  ? 'Both active lookup directions will be removed in one transaction. The old local key, remote key, organization, end time and administrator are preserved in safe history. No Jira issue is deleted.'
                  : confirmAction.type === 'replaceDeletedCounterpart'
                    ? 'A replacement issue will be created through the existing controlled create ledger. One Jira issue may be created; no Jira issue is deleted.'
                    : 'The status record will be dismissed without changing the mapping. Confirmed deletions cannot be dismissed.'}
              </p>
              <p style={{ fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
                {confirmAction.item?.localKey} ↔ {confirmAction.item?.remoteKey}
              </p>
            </ModalBody>
            <ModalFooter>
              <Button appearance="subtle" onClick={() => setConfirmAction(null)}>Cancel</Button>
              <Button
                appearance={confirmAction.type === 'endDeletedCounterpartSync' ? 'danger' : 'primary'}
                isLoading={actionKey.startsWith(`${confirmAction.type}:`)}
                onClick={() => runAction(confirmAction.type, confirmAction.item)}
              >
                Confirm
              </Button>
            </ModalFooter>
          </ModalDialog>
        )}
      </ModalTransition>

      <ModalTransition>
        {remapItem && (
          <ModalDialog onClose={() => setRemapItem(null)}>
            <ModalHeader><ModalTitle>Remap counterpart pair</ModalTitle></ModalHeader>
            <ModalBody>
              <p>Both changed sides must be reachable before the active mapping is replaced.</p>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                Local issue key
                <TextField value={newLocalKey} onChange={event => setNewLocalKey(event.target.value)} />
              </label>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginTop: '12px' }}>
                Remote issue key
                <TextField value={newRemoteKey} onChange={event => setNewRemoteKey(event.target.value)} />
              </label>
            </ModalBody>
            <ModalFooter>
              <Button appearance="subtle" onClick={() => setRemapItem(null)}>Cancel</Button>
              <Button
                appearance="primary"
                isLoading={actionKey.startsWith('remapDeletedCounterpart:')}
                onClick={() => runAction('remapDeletedCounterpart', remapItem, {
                  newLocalKey,
                  newRemoteKey
                })}
              >
                Remap
              </Button>
            </ModalFooter>
          </ModalDialog>
        )}
      </ModalTransition>
    </div>
  );
};

export default DeletedCounterpartRecovery;
