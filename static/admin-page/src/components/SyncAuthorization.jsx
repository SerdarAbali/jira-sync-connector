import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';
import Button from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import Spinner from '@atlaskit/spinner';
import Lozenge from '@atlaskit/lozenge';
import Textfield from '@atlaskit/textfield';
import { token } from '@atlaskit/tokens';

/**
 * Installation-wide synchronization authorization.
 *
 * Read-only status plus one explicit, auditable authorization action. The action
 * writes a single connector storage record and never touches Jira, so it cannot
 * create, update or delete an issue. It also never changes the emergency pause.
 */

const surfaceCard = (overrides = {}) => ({
  background: token('color.background.neutral', '#FFFFFF'),
  borderRadius: token('border.radius', '8px'),
  border: `1px solid ${token('color.border', '#DFE1E6')}`,
  padding: token('space.300', '24px'),
  marginBottom: token('space.200', '16px'),
  ...overrides
});

const labelStyle = {
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: token('color.text.subtle', '#6B778C')
};

const monoStyle = { fontFamily: 'monospace', fontSize: '12px', wordBreak: 'break-all' };

export const SYNC_AUTHORIZATION_SCOPE_TEXT =
  'Synchronization authorization is installation-wide. Until it is explicitly granted, every Jira write is refused, independently of the emergency pause. Authorizing writes one connector storage record and never modifies a Jira issue.';

export const SYNC_AUTHORIZATION_PAUSE_TEXT =
  'Authorization does not resume synchronization. A paused connector stays paused until an administrator resumes it separately.';

const REASON_TEXT = {
  SYNC_AUTHORIZATION_MISSING: 'No authorization record exists for this installation.',
  SYNC_AUTHORIZATION_UNREADABLE: 'The authorization record could not be read.',
  SYNC_AUTHORIZATION_MALFORMED: 'The stored record was not written by this connector.',
  SYNC_AUTHORIZATION_IDENTITY_UNAVAILABLE: 'The installation identity could not be read.',
  SYNC_AUTHORIZATION_INSTALLATION_MISMATCH: 'The record belongs to a different installation or environment.',
  SYNC_RESTORE_IN_PROGRESS: 'A restore is in progress; writes stay blocked until it is verified.',
  SYNC_AUTHORIZATION_BLOCKED: 'Synchronization is explicitly blocked.',
  SYNC_AUTHORIZATION_NO_ORGANIZATIONS: 'No organization is configured.',
  SYNC_AUTHORIZATION_ORGANIZATIONS_UNVERIFIED: 'At least one configured organization was not covered.',
  SYNC_AUTHORIZATION_ORGANIZATION_SET_CHANGED: 'An organization was added or removed after authorization.',
  SYNC_AUTHORIZATION_CONFIRMATION_REQUIRED: 'The confirmation text did not match.',
  SYNC_AUTHORIZATION_INVALID_STATE: 'The requested state is not valid.'
};

export function authorizationReasonText(reason) {
  return REASON_TEXT[reason] || reason || 'Unknown reason';
}

const Field = ({ label, value }) => (
  <div>
    <div style={labelStyle}>{label}</div>
    <div style={{ fontSize: '13px' }}>{value}</div>
  </div>
);

const SyncAuthorization = ({ showMessage }) => {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [confirmation, setConfirmation] = useState('');
  const [authorizing, setAuthorizing] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await invoke('getSyncAuthorizationStatus');
      if (!response?.success) {
        setError(response?.error || 'The authorization status could not be read.');
        setStatus(null);
        return;
      }
      setError(null);
      setStatus(response);
    } catch {
      setError('The authorization status could not be read.');
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const expectedPhrase = status?.confirmationPhrase || '';
  const matches = expectedPhrase !== '' && confirmation === expectedPhrase;
  const canAuthorize = Boolean(matches) && !authorizing;

  const authorize = useCallback(async () => {
    if (!canAuthorize) return;
    setAuthorizing(true);
    try {
      const response = await invoke('authorizeSynchronization', { confirmation });
      if (!response?.success) {
        setError(response?.error || 'Synchronization was not authorized.');
        return;
      }
      setConfirmation('');
      setError(null);
      if (typeof showMessage === 'function') {
        showMessage('Synchronization authorized for this installation', 'success');
      }
      await load();
    } catch {
      setError('Synchronization was not authorized. Nothing was written.');
    } finally {
      setAuthorizing(false);
    }
  }, [canAuthorize, confirmation, load, showMessage]);

  const authorized = status?.authorized === true;

  return (
    <div style={surfaceCard()} data-testid="sync-authorization">
      <div style={{ display: 'flex', alignItems: 'center', gap: token('space.100', '8px'), marginBottom: token('space.200', '16px') }}>
        <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>Synchronization authorization</h3>
        {loading
          ? <Spinner size="small" />
          : (
            <Lozenge appearance={authorized ? 'success' : 'moved'}>
              {authorized ? 'Writes authorized' : 'Writes blocked'}
            </Lozenge>
          )}
      </div>

      <p style={{ marginTop: 0, marginBottom: token('space.200', '16px'), fontSize: '13px', color: token('color.text.subtle', '#6B778C') }}>
        {SYNC_AUTHORIZATION_SCOPE_TEXT}
      </p>

      {error && (
        <div style={{ marginBottom: token('space.200', '16px') }}>
          <SectionMessage appearance="error" title="Authorization status unavailable">
            <p style={{ margin: 0 }}>{error}</p>
          </SectionMessage>
        </div>
      )}

      {status && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.300', '24px'), marginBottom: token('space.200', '16px') }}>
          <Field label="State" value={status.state || 'missing'} />
          <Field label="Reason" value={status.reason ? authorizationReasonText(status.reason) : 'None'} />
          <Field label="Authorized at" value={status.authorizedAt || 'Not authorized'} />
          <Field label="Authorized by" value={status.authorizedBy || 'None'} />
          <Field label="Basis" value={status.basis || 'None'} />
          <Field
            label="Covered organizations"
            value={(status.authorizedOrganizationIds || []).join(', ') || 'None'}
          />
          <Field
            label="Configured organizations"
            value={(status.configuredOrganizationIds || []).join(', ') || 'None'}
          />
        </div>
      )}

      {status && (status.uncoveredOrganizationIds || []).length > 0 && (
        <div style={{ marginBottom: token('space.200', '16px') }}>
          <SectionMessage appearance="warning" title="Not every organization is covered">
            <p style={{ margin: 0 }}>
              {`Configured but not authorized: ${status.uncoveredOrganizationIds.join(', ')}. Writes stay blocked until every configured organization is covered by one authorization.`}
            </p>
          </SectionMessage>
        </div>
      )}

      {status && (status.organizationSetDelta?.removed || []).length > 0 && (
        <div style={{ marginBottom: token('space.200', '16px') }}>
          <SectionMessage appearance="warning" title="The authorized organization set changed">
            <p style={{ margin: 0 }}>
              {`Authorized but no longer configured: ${status.organizationSetDelta.removed.join(', ')}. The authorization requires the exact current set, so writes stay blocked until the installation is authorized again.`}
            </p>
          </SectionMessage>
        </div>
      )}

      {status && !authorized && expectedPhrase !== '' && (
        <div>
          <p style={{ marginTop: 0, marginBottom: token('space.100', '8px'), fontSize: '13px' }}>
            Type the exact phrase below to authorize this installation. The server rejects anything else.
          </p>
          <div style={{ ...monoStyle, marginBottom: token('space.150', '12px') }}>{expectedPhrase}</div>
          <div style={{ maxWidth: '520px', marginBottom: token('space.150', '12px') }}>
            <Textfield
              aria-label="Authorization confirmation"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              isDisabled={authorizing}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: token('space.150', '12px') }}>
            <Button appearance="primary" isDisabled={!canAuthorize} isLoading={authorizing} onClick={authorize}>
              Authorize synchronization
            </Button>
            {authorizing && <Spinner size="small" />}
          </div>
          <p style={{ marginTop: token('space.150', '12px'), marginBottom: 0, fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
            {SYNC_AUTHORIZATION_PAUSE_TEXT}
          </p>
        </div>
      )}

      {status && !authorized && expectedPhrase === '' && (
        <p style={{ margin: 0, fontSize: '12px' }}>
          Add at least one organization before synchronization can be authorized.
        </p>
      )}

      {status && authorized && (
        <p style={{ margin: 0, fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
          Jira writes are still subject to the emergency pause above.
        </p>
      )}
    </div>
  );
};

export default SyncAuthorization;
