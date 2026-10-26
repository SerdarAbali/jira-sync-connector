import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';
import Button from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import Spinner from '@atlaskit/spinner';
import Lozenge from '@atlaskit/lozenge';
import Textfield from '@atlaskit/textfield';
import { token } from '@atlaskit/tokens';

/**
 * Read-only pairing-witness migration preview.
 *
 * The panel runs one read-only resolver and reports what it found. It has no
 * apply, approve or migrate control: Phase 1 ships the inspection only, and the
 * preview never writes a Jira property, creates an issue or changes the pause.
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

const cellStyle = {
  padding: token('space.075', '6px'),
  borderBottom: `1px solid ${token('color.border', '#DFE1E6')}`,
  fontSize: '12px',
  verticalAlign: 'top'
};

const monoStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '12px',
  wordBreak: 'break-all'
};

export const PAIR_WITNESS_READ_ONLY_TEXT =
  'Read-only preview. It writes no issue property, creates no issue and changes no mapping, ledger row or pause state.';

export const PAIR_WITNESS_SCOPE_TEXT =
  'A pairing witness is a small versioned value stored as a Jira issue property on both issues of a synchronized pair. This preview reports which existing pairs already carry one on both sides, which carry none, and which cannot be verified. Every Jira request it makes is a read.';

export const PAIR_WITNESS_NO_APPLY_TEXT =
  'No migration action is available in this build: there is no approval or apply step, and nothing here can write a witness.';

export const PAIR_WITNESS_PAUSE_TEXT =
  'The preview requires the emergency pause, exactly as the recovery snapshot export and preview do. It never changes the pause state itself.';

const CLASS_TEXT = {
  'ready-to-witness': 'No witness on either issue',
  'partially-witnessed': 'Witness on one issue only',
  'already-witnessed': 'Witness on both issues',
  'witness-conflict': 'Witness contradicts storage or this installation',
  'witness-ended': 'Witness records an ended pair',
  'witness-pending-create': 'Witness records an unfinished create',
  'witness-inaccessible': 'Witness not readable (permissions or app access)',
  'witness-unverifiable': 'Witness not verifiable (rate limit, error or malformed answer)',
  'counterpart-missing': 'A counterpart issue no longer exists',
  'counterpart-inaccessible': 'A counterpart issue is not accessible',
  unverified: 'Storage or Jira could not be read completely',
  'mapping-mismatch': 'Mapping metadata and directed lookups disagree',
  'duplicate-destination': 'Two local issues claim the same remote issue',
  'create-in-doubt': 'Create ledger row is still pending or unknown',
  'pair-ended': 'Pair was ended by an administrator',
  'repair-required': 'Mapping repair record is present'
};

export function pairClassText(value) {
  return CLASS_TEXT[value] || value || 'Unknown';
}

export function pairWitnessFindingText(finding) {
  if (!finding) return 'Unknown finding';
  const pair = [finding.localKey, finding.remoteKey].filter(Boolean).join(' ↔ ');
  const detail = finding.detail ? ` (${finding.detail})` : '';
  return `${pairClassText(finding.code)}${pair ? `: ${pair}` : ''}${detail}`;
}

const Field = ({ label, value }) => (
  <div>
    <div style={labelStyle}>{label}</div>
    <div style={{ fontSize: '13px' }}>{value}</div>
  </div>
);

const PairWitnessMigration = ({ selectedOrg, showMessage }) => {
  const orgId = selectedOrg?.id || null;
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  useEffect(() => {
    reset();
  }, [orgId, reset]);

  const runPreview = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const response = await invoke('previewPairWitnessMigration', { orgId });
      if (!response?.success) {
        setError(response?.error || 'The pairing-witness preview could not be completed.');
        setResult(null);
        if (typeof showMessage === 'function') {
          showMessage('error', response?.error || 'Pairing-witness preview failed');
        }
        return;
      }
      setResult(response);
    } catch {
      setError('The pairing-witness preview could not be completed.');
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [orgId, showMessage]);

  const counts = result?.counts || {};
  const cost = result?.cost || {};

  return (
    <div style={surfaceCard()}>
      <div style={{ display: 'flex', alignItems: 'center', gap: token('space.150', '12px'), marginBottom: token('space.100', '8px') }}>
        <h3 style={{ margin: 0, fontSize: '16px' }}>Pairing witness preview</h3>
        <Lozenge appearance="default">Read-only</Lozenge>
      </div>

      <p style={{ marginTop: 0, marginBottom: token('space.200', '16px'), fontSize: '13px', color: token('color.text.subtle', '#6B778C') }}>
        {PAIR_WITNESS_SCOPE_TEXT}
      </p>

      <div style={{ marginBottom: token('space.200', '16px') }}>
        <SectionMessage appearance="information" title="This preview cannot change anything">
          <p style={{ margin: 0 }}>{PAIR_WITNESS_READ_ONLY_TEXT}</p>
          <p style={{ margin: 0 }}>{PAIR_WITNESS_NO_APPLY_TEXT}</p>
        </SectionMessage>
      </div>

      <Field label="Organization" value={selectedOrg?.name || 'Not selected'} />

      <div style={{ display: 'flex', alignItems: 'center', gap: token('space.150', '12px'), marginTop: token('space.150', '12px'), marginBottom: token('space.200', '16px') }}>
        <Button appearance="default" isDisabled={!orgId || loading} isLoading={loading} onClick={runPreview}>
          Run read-only preview
        </Button>
        {loading && <Spinner size="small" />}
        {!orgId && (
          <span style={{ fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
            Select an organization to preview.
          </span>
        )}
      </div>

      {error && (
        <div style={{ marginBottom: token('space.200', '16px') }}>
          <SectionMessage appearance="error" title="Preview unavailable">
            <p style={{ margin: 0 }}>{error}</p>
          </SectionMessage>
        </div>
      )}

      {result && (
        <div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.300', '24px'), marginBottom: token('space.200', '16px') }}>
            <Field label="Pairs scanned" value={counts.pairsScanned ?? 0} />
            <Field label="Ready to witness" value={counts.readyToWitness ?? 0} />
            <Field label="Already witnessed" value={counts.alreadyWitnessed ?? 0} />
            <Field label="Partially witnessed" value={counts.partiallyWitnessed ?? 0} />
            <Field label="Conflicting" value={counts.witnessConflict ?? 0} />
            <Field
              label="Inaccessible"
              value={(counts.witnessInaccessible ?? 0) + (counts.counterpartInaccessible ?? 0)}
            />
            <Field
              label="Unverifiable"
              value={(counts.witnessUnverifiable ?? 0) + (counts.unverified ?? 0)}
            />
            <Field label="Ended" value={(counts.witnessEnded ?? 0) + (counts.pairEnded ?? 0)} />
            <Field label="Missing counterpart" value={counts.counterpartMissing ?? 0} />
            <Field label="Duplicate destination" value={counts.duplicateDestination ?? 0} />
            <Field label="Key drift" value={counts.keyDrift ?? 0} />
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.300', '24px'), marginBottom: token('space.200', '16px') }}>
            <Field label="Jira reads" value={cost.jiraReads ?? 0} />
            <Field label="Property writes performed" value={cost.witnessWritesPerformed ?? 0} />
            <Field label="Issues created" value={cost.jiraIssuesCreated ?? 0} />
            <Field label="Writes a later migration would need" value={cost.witnessWritesProjected ?? 0} />
          </div>


          {result.limits?.truncated && (
            <div style={{ marginBottom: token('space.200', '16px') }}>
              <SectionMessage appearance="warning" title="Preview truncated">
                <p style={{ margin: 0 }}>
                  {`Only ${result.limits.pairsListed} of the organization's pairs were inspected. Run the preview again with a higher pair limit to see the rest.`}
                </p>
              </SectionMessage>
            </div>
          )}

          {Array.isArray(result.duplicates) && result.duplicates.length > 0 && (
            <div style={{ marginBottom: token('space.200', '16px') }}>
              <SectionMessage appearance="warning" title="Two local issues claim the same remote issue">
                <ul style={{ margin: 0, paddingLeft: token('space.200', '16px') }}>
                  {result.duplicates.map((entry) => (
                    <li key={entry.remoteKey}>
                      {`${entry.remoteKey} ← ${entry.localKeys.join(', ')}`}
                    </li>
                  ))}
                </ul>
              </SectionMessage>
            </div>
          )}

          <div style={{ marginBottom: token('space.200', '16px') }}>
            <div style={labelStyle}>Findings</div>
            {(result.findings || []).length === 0
              ? (
                <p style={{ margin: 0, fontSize: '13px' }}>
                  Every inspected pair is either already witnessed on both issues or has a pairing witness on neither issue yet.
                </p>
              )
              : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{ ...cellStyle, textAlign: 'left' }}>Finding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(result.findings || []).map((finding, index) => (
                      <tr key={`${finding.code}-${finding.localKey || 'none'}-${finding.remoteKey || 'none'}-${index}`}>
                        <td style={cellStyle}>{pairWitnessFindingText(finding)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            {(result.omittedFindings ?? 0) > 0 && (
              <p style={{ margin: 0, fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
                {`${result.omittedFindings} further finding(s) are not listed.`}
              </p>
            )}
          </div>

          <div>
            <div style={labelStyle}>Limitations</div>
            <ul style={{ margin: 0, paddingLeft: token('space.200', '16px'), fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
              {(result.limitations || []).map((line) => <li key={line}>{line}</li>)}
            </ul>
          </div>
        </div>
      )}

      <p style={{ marginTop: token('space.200', '16px'), marginBottom: 0, fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
        {PAIR_WITNESS_PAUSE_TEXT}
      </p>

      <WitnessMigrationControls orgId={orgId} showMessage={showMessage} />
    </div>
  );
};

/**
 * Plan, approve and run the witness migration.
 *
 * Every control here is a request, not an authority: the server recomputes the
 * plan, requires the exact phrase, enforces the maintenance permit at the Jira
 * transport for every single property write, and refuses everything while the
 * connector is not paused. Disabling a button here changes nothing about what the
 * backend permits.
 */
export const WITNESS_APPROVAL_TEXT =
  'Approval freezes a plan the server recomputed from live storage and Jira. Typing the phrase authorizes exactly that plan; the server rejects anything else.';

export const WITNESS_APPLY_TEXT =
  'Each run writes at most ten pairs, reads both properties back, and only then records progress. A failed pair is reported and never rolled back or deleted.';

export const WITNESS_TIMING_NOTE =
  'Measured inside the Forge invocation. These are not browser round-trip times, and they contain no issue content.';

export const WITNESS_SELECTION_TEXT =
  'Enter one pair per line as LOCAL-KEY REMOTE-KEY. Only those pairs are planned; an empty or malformed entry cannot build a plan.';

export const WITNESS_SELECTION_REQUIRED_TEXT =
  'At least one pair is required in this scope. Build plan stays disabled until a valid pair is entered.';

export const WITNESS_ORGANIZATION_WARNING =
  'Every eligible pair in this organization will be included in the plan, and each pair needs two property writes. Choose this deliberately; to limit the migration, use Selected pairs.';

/**
 * Parses the pair-selection box.
 *
 * Blank means "not supplied" (whole organization). Anything else must resolve to
 * complete `localKey remoteKey` pairs; a malformed line is reported rather than
 * guessed, and the server refuses an empty list outright.
 */
export function parsePairSelection(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw === '') return { pairs: undefined, error: null, blank: true };

  const pairs = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const parts = trimmed.split(/[,=]|->|→|\s+/).map((part) => part.trim()).filter(Boolean);
    if (parts.length !== 2) {
      return {
        pairs: null,
        error: `Could not read "${trimmed}". Use one pair per line as LOCAL-1 REMOTE-1.`,
        blank: false
      };
    }
    pairs.push({ localKey: parts[0], remoteKey: parts[1] });
  }
  if (pairs.length === 0) return { pairs: undefined, error: null, blank: true };
  return { pairs, error: null, blank: false };
}

export function WitnessMigrationControls({ orgId, showMessage }) {
  const [status, setStatus] = useState(null);
  const [plan, setPlan] = useState(null);
  const [confirmation, setConfirmation] = useState('');
  const [selectionText, setSelectionText] = useState('');
  const [scopeMode, setScopeMode] = useState('selected');
  const [lastBatch, setLastBatch] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const fail = useCallback((message) => {
    setError(message || 'The request was refused.');
    if (typeof showMessage === 'function') {
      showMessage('error', message || 'Witness migration refused');
    }
  }, [showMessage]);

  const refresh = useCallback(async () => {
    if (!orgId) return;
    try {
      const response = await invoke('getPairWitnessMigrationStatus', { orgId });
      if (response?.success) setStatus(response);
    } catch {
      setStatus(null);
    }
  }, [orgId]);

  useEffect(() => {
    setPlan(null);
    setConfirmation('');
    setError(null);
    refresh();
  }, [orgId, refresh]);

  const run = useCallback(async (action, payload) => {
    if (!orgId || busy) return null;
    setBusy(true);
    setError(null);
    try {
      const response = await invoke(action, { orgId, ...payload });
      if (!response?.success) {
        fail(response?.error);
        return null;
      }
      await refresh();
      return response;
    } catch {
      fail('The request could not be completed.');
      return null;
    } finally {
      setBusy(false);
    }
  }, [busy, fail, orgId, refresh]);

  const buildPlan = useCallback(async () => {
    const selection = parsePairSelection(selectionText);
    if (scopeMode === 'selected') {
      if (selection.error) {
        fail(selection.error);
        return;
      }
      if (!selection.pairs || selection.pairs.length === 0) {
        fail('Select at least one pair, or switch the scope to Entire organization.');
        return;
      }
      const response = await run('planPairWitnessMigration', { pairs: selection.pairs });
      if (response?.plan) setPlan(response.plan);
      return;
    }
    // Entire organization is only reachable through the explicit mode choice:
    // the selection is omitted, which is the backend's whole-organization call.
    const response = await run('planPairWitnessMigration', {});
    if (response?.plan) setPlan(response.plan);
  }, [fail, run, scopeMode, selectionText]);

  const approve = useCallback(async () => {
    const selection = parsePairSelection(selectionText);
    if (scopeMode === 'selected') {
      if (selection.error) {
        fail(selection.error);
        return;
      }
      if (!selection.pairs || selection.pairs.length === 0) {
        fail('Select at least one pair, or switch the scope to Entire organization.');
        return;
      }
    }
    // Approval rebuilds the plan server-side with the same scope, so the phrase
    // can only match the exact set the administrator is looking at.
    const response = await run(
      'approvePairWitnessMigration',
      scopeMode === 'selected'
        ? { confirmation, pairs: selection.pairs }
        : { confirmation }
    );
    if (response) {
      setConfirmation('');
      setPlan(null);
    }
  }, [confirmation, fail, run, scopeMode, selectionText]);

  const applyBatch = useCallback(async () => {
    const response = await run('applyPairWitnessMigration', {});
    if (!response) return;
    setLastBatch(response);
    if (typeof showMessage === 'function') {
      const timings = response.timings;
      const detail = timings
        ? ` · ${Math.round(timings.batchMs)} ms (local PUT ${Math.round(timings.totals?.localPutMs ?? 0)} ms, remote PUT ${Math.round(timings.totals?.remotePutMs ?? 0)} ms)`
        : '';
      showMessage(
        response.remaining > 0 ? 'info' : 'success',
        `Witness batch: ${response.writesPerformed} write(s), ${response.remaining} pair(s) remaining${detail}`
      );
    }
  }, [run, showMessage]);

  const cancel = useCallback(async () => {
    await run('cancelPairWitnessMigration', {});
  }, [run]);

  const expectedPhrase = plan?.approvalPhrase || '';
  const phraseMatches = expectedPhrase !== '' && confirmation === expectedPhrase;
  const planStatus = status?.plan?.status || null;
  const remaining = status?.plan?.remaining ?? 0;
  const canApply = planStatus === 'approved' || planStatus === 'running';

  const parsed = parsePairSelection(selectionText);
  const hasPairs = Boolean(parsed.pairs && parsed.pairs.length > 0);
  // Selected-pairs mode never falls back to the whole organization: a blank or
  // malformed selection simply cannot build a plan.
  const canBuild = Boolean(orgId) && !busy
    && (scopeMode === 'organization' || (parsed.error === null && hasPairs));
  const canApprove = phraseMatches && !busy && canBuild;

  return (
    <div
      style={{ ...surfaceCard(), marginTop: token('space.200', '16px') }}
      data-testid="pair-witness-migration"
    >
      <h3 style={{ margin: 0, fontSize: '16px' }}>Witness migration</h3>
      <p style={{
        marginTop: token('space.100', '8px'),
        marginBottom: token('space.200', '16px'),
        fontSize: '13px',
        color: token('color.text.subtle', '#6B778C')
      }}>
        {WITNESS_APPROVAL_TEXT}
      </p>

      {error && (
        <div style={{ marginBottom: token('space.200', '16px') }}>
          <SectionMessage appearance="error" title="Refused">
            <p style={{ margin: 0 }}>{error}</p>
          </SectionMessage>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.300', '24px'), marginBottom: token('space.200', '16px') }}>
        <Field label="Plan status" value={planStatus || 'None'} />
        <Field label="Pairs remaining" value={remaining} />
        <Field label="Batches run" value={status?.plan?.batches ?? 0} />
        <Field label="Plan expires" value={status?.plan?.expiresAt || 'Not approved'} />
        <Field label="Permit" value={status?.permit ? status.permit.permitId : 'None'} />
        <Field
          label="Plan scope"
          value={status?.plan
            ? (status.plan.selectionMode === 'explicit' ? 'Selected pairs' : 'Whole organization')
            : 'None'}
        />
      </div>

      <div style={{ marginBottom: token('space.200', '16px') }}>
        <div style={labelStyle}>Scope</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.100', '8px'), margin: '6px 0 8px 0' }}>
          <Button
            appearance={scopeMode === 'selected' ? 'primary' : 'default'}
            aria-pressed={scopeMode === 'selected'}
            isDisabled={busy}
            onClick={() => setScopeMode('selected')}
          >
            Selected pairs
          </Button>
          <Button
            appearance={scopeMode === 'organization' ? 'primary' : 'default'}
            aria-pressed={scopeMode === 'organization'}
            isDisabled={busy}
            onClick={() => setScopeMode('organization')}
          >
            Entire organization
          </Button>
        </div>

        {scopeMode === 'organization' ? (
          <SectionMessage appearance="warning" title="Entire organization selected">
            <p style={{ margin: 0 }}>{WITNESS_ORGANIZATION_WARNING}</p>
          </SectionMessage>
        ) : (
          <div>
            <p style={{ margin: '0 0 8px 0', fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
              {WITNESS_SELECTION_TEXT}
            </p>
            <div style={{ maxWidth: '520px', marginBottom: token('space.100', '8px') }}>
              <textarea
                aria-label="Witness migration pair selection"
                value={selectionText}
                onChange={(event) => setSelectionText(event.target.value)}
                disabled={busy}
                rows={3}
                placeholder={'MOB-8 VMOB-13\nMOB-9 VMOB-14'}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: '12px',
                  padding: token('space.075', '6px'),
                  border: `1px solid ${token('color.border', '#DFE1E6')}`,
                  borderRadius: token('border.radius.100', '3px'),
                  resize: 'vertical'
                }}
              />
            </div>
            {parsed.error ? (
              <p style={{ margin: 0, fontSize: '12px', color: token('color.text.danger', '#DE350B') }}>
                {parsed.error}
              </p>
            ) : (hasPairs ? null : (
              <p style={{ margin: 0, fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
                {WITNESS_SELECTION_REQUIRED_TEXT}
              </p>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.150', '12px'), marginBottom: token('space.200', '16px') }}>
        <Button appearance="default" isDisabled={!canBuild} onClick={buildPlan}>
          Build plan
        </Button>
        <Button appearance="default" isDisabled={!orgId || busy || !canApply} onClick={applyBatch}>
          Run next batch
        </Button>
        <Button appearance="subtle" isDisabled={!orgId || busy || !planStatus} onClick={cancel}>
          Cancel migration
        </Button>
      </div>

      {plan && (
        <div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.300', '24px'), marginBottom: token('space.150', '12px') }}>
            <Field label="Writable pairs" value={plan.counts?.writablePairs ?? 0} />
            <Field label="Verify only" value={plan.counts?.verifyOnlyPairs ?? 0} />
            <Field label="Excluded" value={plan.counts?.excludedPairs ?? 0} />
            <Field label="Writes required" value={plan.counts?.writesRequired ?? 0} />
            <Field
              label="Plan scope"
              value={plan.selectionMode === 'explicit'
                ? `Selected pairs (${(plan.selection || []).length})`
                : 'Entire organization'}
            />
          </div>

          <div style={{ marginBottom: token('space.150', '12px') }}>
            <div style={labelStyle}>Plan digest</div>
            <div style={monoStyle}>{plan.digest}</div>
          </div>

          {Array.isArray(plan.items) && plan.items.length > 0 && (
            <div style={{ marginBottom: token('space.150', '12px') }}>
              <div style={labelStyle}>Planned pairs</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ ...cellStyle, textAlign: 'left' }}>Local key / id</th>
                    <th style={{ ...cellStyle, textAlign: 'left' }}>Remote key / id</th>
                    <th style={{ ...cellStyle, textAlign: 'left' }}>Pair UUID</th>
                    <th style={{ ...cellStyle, textAlign: 'left' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.items.map((entry) => (
                    <tr key={entry.pairId}>
                      <td style={cellStyle}>{`${entry.localKey} / ${entry.localIssueId}`}</td>
                      <td style={cellStyle}>{`${entry.remoteKey} / ${entry.remoteIssueId}`}</td>
                      <td style={{ ...cellStyle, ...monoStyle }}>{entry.pairId}</td>
                      <td style={cellStyle}>{entry.action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {Array.isArray(plan.excluded) && plan.excluded.length > 0 && (
            <div style={{ marginBottom: token('space.150', '12px') }}>
              <div style={labelStyle}>Excluded pairs</div>
              <ul style={{ margin: 0, paddingLeft: token('space.200', '16px'), fontSize: '12px' }}>
                {plan.excluded.map((entry) => (
                  <li key={`${entry.localKey}-${entry.remoteKey}`}>
                    {`${entry.localKey} ↔ ${entry.remoteKey}: ${entry.reason}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p style={{ marginTop: 0, marginBottom: token('space.100', '8px'), fontSize: '13px' }}>
            Type the exact phrase to approve this plan.
          </p>
          <div style={{ ...monoStyle, marginBottom: token('space.150', '12px') }}>{expectedPhrase}</div>
          <div style={{ maxWidth: '520px', marginBottom: token('space.150', '12px') }}>
            <Textfield
              aria-label="Witness migration confirmation"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              isDisabled={busy}
            />
          </div>
          <Button appearance="primary" isDisabled={!canApprove} onClick={approve}>
            Approve witness plan
          </Button>
        </div>
      )}

      <p style={{
        marginTop: token('space.200', '16px'),
        marginBottom: 0,
        fontSize: '12px',
        color: token('color.text.subtle', '#6B778C')
      }}>
        {WITNESS_APPLY_TEXT}
      </p>

      {lastBatch?.timings && (
        <div style={{ marginTop: token('space.200', '16px') }}>
          <div style={labelStyle}>
            {`Last batch timings (${Math.round(lastBatch.timings.batchMs)} ms total, invocation-side)`}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...cellStyle, textAlign: 'left' }}>Pair</th>
                <th style={{ ...cellStyle, textAlign: 'left' }}>State</th>
                <th style={{ ...cellStyle, textAlign: 'left' }}>Local PUT / verify</th>
                <th style={{ ...cellStyle, textAlign: 'left' }}>Remote PUT / verify</th>
                <th style={{ ...cellStyle, textAlign: 'left' }}>Pair total</th>
              </tr>
            </thead>
            <tbody>
              {(lastBatch.timings.pairs || []).map((pair) => (
                <tr key={pair.seq}>
                  <td style={cellStyle}>{`#${pair.seq}`}</td>
                  <td style={cellStyle}>{pair.state}</td>
                  <td style={cellStyle}>{`${pair.localPutMs} / ${pair.localVerifyMs} ms`}</td>
                  <td style={cellStyle}>{`${pair.remotePutMs} / ${pair.remoteVerifyMs} ms`}</td>
                  <td style={cellStyle}>{`${pair.totalMs} ms`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ margin: '4px 0 0 0', fontSize: '11px', color: token('color.text.subtle', '#6B778C') }}>
            {WITNESS_TIMING_NOTE}
          </p>
        </div>
      )}
    </div>
  );
}

export default PairWitnessMigration;

