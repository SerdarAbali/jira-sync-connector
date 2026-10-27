import React, { useEffect, useMemo, useState } from 'react';
import { invoke } from '@forge/bridge';
import Button from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import Spinner from '@atlaskit/spinner';
import Textfield from '@atlaskit/textfield';
import { token } from '@atlaskit/tokens';
import { surfaceCard } from '../dashboard/presentation';
import Field, { fieldLabelStyle } from '../dashboard/Field.jsx';

/**
 * Witnessed Pair Adoption.
 *
 * A narrow recovery panel: verify one explicitly supplied pair, then restore its
 * missing Forge mapping through the existing ADMIN_WRITE resolver. It never runs
 * a write on mount, never previews automatically, and never reuses a preview
 * after the organization or either issue key changes.
 */

export const ADOPTION_INTRO_TEXT =
  'Use this only when both Jira issues still carry a matching pairing witness but the Forge mapping was lost. Verification is read-only; adoption writes one mapping and no Jira issue.';

export const ADOPTION_PAUSE_TEXT =
  'Synchronization must be paused. The preview reports the pause state; adoption is refused if it is off or unreadable.';

export const ADOPTION_STALE_TEXT =
  'Organization or issue keys changed. Verify the pair again before adopting.';

const monoStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '12px',
  wordBreak: 'break-all'
};

export function pairAdoptionFingerprint({ orgId, localKey, remoteKey } = {}) {
  return [orgId || '', localKey || '', remoteKey || ''].join('|');
}

const WitnessedPairAdoption = ({ selectedOrg, showMessage }) => {
  const orgId = selectedOrg?.id || null;
  const [localKey, setLocalKey] = useState('');
  const [remoteKey, setRemoteKey] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewFingerprint, setPreviewFingerprint] = useState(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null);

  const fingerprint = useMemo(
    () => pairAdoptionFingerprint({ orgId, localKey, remoteKey }),
    [orgId, localKey, remoteKey]
  );
  const stale = Boolean(preview && previewFingerprint !== fingerprint);
  const phraseMatches = Boolean(
    preview?.confirmationPhrase && confirmation === preview.confirmationPhrase
  );
  const canVerify = Boolean(orgId && localKey.trim() && remoteKey.trim() && !busy);
  const canAdopt = Boolean(
    preview?.success === true
    && preview.ready === true
    && phraseMatches
    && !stale
    && !busy
  );

  const resetEvidence = () => {
    setPreview(null);
    setPreviewFingerprint(null);
    setConfirmation('');
    setOutcome(null);
  };

  const changeLocal = (value) => {
    setLocalKey(value);
    resetEvidence();
  };
  const changeRemote = (value) => {
    setRemoteKey(value);
    resetEvidence();
  };

  // A different organization invalidates every part of the previous evidence.
  useEffect(() => {
    setPreview(null);
    setPreviewFingerprint(null);
    setConfirmation('');
    setOutcome(null);
  }, [orgId]);

  const verify = async () => {
    if (!canVerify) return;
    setBusy(true);
    setOutcome(null);
    setPreview(null);
    setPreviewFingerprint(null);
    setConfirmation('');
    try {
      const response = await invoke('previewWitnessedPairAdoption', {
        orgId,
        localKey: localKey.trim(),
        remoteKey: remoteKey.trim()
      });
      setPreview(response || null);
      setPreviewFingerprint(fingerprint);
      if (response?.success === false && response?.message && showMessage) {
        showMessage('error', response.message);
      }
    } catch {
      setPreview(null);
      setOutcome({
        appearance: 'error',
        title: 'Preview failed',
        text: 'The pair could not be verified. Nothing was written.'
      });
    } finally {
      setBusy(false);
    }
  };

  const adopt = async () => {
    if (!canAdopt) return;
    setBusy(true);
    setOutcome(null);
    try {
      const response = await invoke('adoptWitnessedPair', {
        orgId,
        localKey: localKey.trim(),
        remoteKey: remoteKey.trim(),
        pairId: preview.pairId,
        confirmation
      });
      if (response?.success === true) {
        setOutcome({
          appearance: 'success',
          title: 'Mapping restored',
          text: response.message || 'The verified pair mapping was restored.'
        });
        // A used approval is never reusable.
        setPreview(null);
        setPreviewFingerprint(null);
        setConfirmation('');
      } else {
        setOutcome({
          appearance: 'error',
          title: 'Adoption refused',
          text: response?.message || response?.error || 'The mapping was not changed.'
        });
      }
    } catch {
      setOutcome({
        appearance: 'error',
        title: 'Adoption failed',
        text: 'The mapping was not changed.'
      });
    } finally {
      setBusy(false);
    }
  };

  if (!selectedOrg) {
    return (
      <div style={surfaceCard()}>
        <h3 style={{ marginTop: 0 }}>Witnessed Pair Adoption</h3>
        <p style={{ color: token('color.text.subtle', '#6B778C') }}>
          Select an organization to verify a witnessed pair.
        </p>
      </div>
    );
  }


  return (
    <div style={surfaceCard()}>
      <h3 style={{ marginTop: 0 }}>Witnessed Pair Adoption</h3>
      <p style={{ maxWidth: 760 }}>{ADOPTION_INTRO_TEXT}</p>
      <p style={{ maxWidth: 760, color: token('color.text.subtle', '#6B778C') }}>{ADOPTION_PAUSE_TEXT}</p>

      <div style={{ display: 'grid', gap: token('space.100', '8px'), maxWidth: 520 }}>
        <label style={fieldLabelStyle} htmlFor="witness-adoption-local">Local issue key</label>
        <Textfield
          id="witness-adoption-local"
          aria-label="Witness adoption local issue key"
          value={localKey}
          isDisabled={busy}
          onChange={(event) => changeLocal(event.target.value)}
        />
        <label style={fieldLabelStyle} htmlFor="witness-adoption-remote">Remote issue key</label>
        <Textfield
          id="witness-adoption-remote"
          aria-label="Witness adoption remote issue key"
          value={remoteKey}
          isDisabled={busy}
          onChange={(event) => changeRemote(event.target.value)}
        />
        <div>
          <Button appearance="primary" isDisabled={!canVerify} onClick={verify}>
            Verify witnesses
          </Button>
          {busy ? <Spinner size="small" /> : null}
        </div>
      </div>

      {stale ? (
        <SectionMessage appearance="warning" title="Preview is stale">
          <p>{ADOPTION_STALE_TEXT}</p>
        </SectionMessage>
      ) : null}

      {preview && preview.success === false ? (
        <SectionMessage appearance="error" title="Pair not adoptable">
          <p>{preview.message || 'The pair could not be verified.'}</p>
          {preview.code ? <p style={monoStyle}>{preview.code}</p> : null}
        </SectionMessage>
      ) : null}

      {preview && preview.success === true ? (
        <div style={{ marginTop: token('space.200', '16px'), display: 'grid', gap: token('space.100', '8px') }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: token('space.100', '8px') }}>
            <Field label="Pair id" value={<span style={monoStyle}>{preview.pairId}</span>} />
            <Field label="Local issue" value={`${preview.localKey} · ${preview.localIssueId}`} />
            <Field label="Remote issue" value={`${preview.remoteKey} · ${preview.remoteIssueId}`} />
            <Field label="Local witness" value={`${preview.localWitness?.class || 'unknown'} · ${preview.localWitness?.state || 'unknown'}`} />
            <Field label="Remote witness" value={`${preview.remoteWitness?.class || 'unknown'} · ${preview.remoteWitness?.state || 'unknown'}`} />
            <Field label="Mapping" value={preview.mapping?.state || 'unknown'} />
            <Field
              label="Pause"
              value={preview.pause?.readable === false
                ? 'unreadable'
                : (preview.pause?.paused ? 'on' : 'off')}
            />
          </div>

          {preview.conflicts?.length > 0 ? (
            <SectionMessage appearance="warning" title="Conflicts and missing prerequisites">
              <ul>
                {preview.conflicts.map((conflict) => <li key={conflict} style={monoStyle}>{conflict}</li>)}
              </ul>
            </SectionMessage>
          ) : null}

          {preview.alreadyMapped ? (
            <SectionMessage appearance="info" title="Already mapped">
              <p>This pair already has a mapping. Nothing needs to be written.</p>
            </SectionMessage>
          ) : null}

          {preview.mapping?.state !== 'conflict' && !preview.alreadyMapped ? (
            <div style={{ display: 'grid', gap: token('space.100', '8px'), maxWidth: 760 }}>
              <div style={fieldLabelStyle}>Required confirmation phrase</div>
              <code style={monoStyle} aria-label="Witness adoption confirmation phrase">
                {preview.confirmationPhrase}
              </code>
              <Textfield
                aria-label="Witness adoption confirmation"
                value={confirmation}
                isDisabled={busy || !preview.ready}
                onChange={(event) => setConfirmation(event.target.value)}
              />
              {!preview.ready ? (
                <p style={{ color: token('color.text.subtle', '#6B778C') }}>
                  Adoption is disabled until every reported prerequisite is cleared.
                </p>
              ) : null}
              <div>
                <Button
                  appearance="danger"
                  isDisabled={!canAdopt}
                  onClick={adopt}
                >
                  Adopt verified mapping
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {outcome ? (
        <SectionMessage appearance={outcome.appearance} title={outcome.title}>
          <p>{outcome.text}</p>
        </SectionMessage>
      ) : null}
    </div>
  );
};

export default WitnessedPairAdoption;

