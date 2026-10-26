import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';
import Button from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import Spinner from '@atlaskit/spinner';
import Lozenge from '@atlaskit/lozenge';
import { token } from '@atlaskit/tokens';

/**
 * Read-only view of the connector's existing audit log, filtered to
 * maintenance property writes.
 *
 * It reads the same `auditLog` the connector already writes and exposes only the
 * sanitized identifier fields. It never shows request bodies, headers, tokens,
 * issue keys, descriptions, comments or permit capabilities, and it has no
 * control that can change or clear anything.
 */

export const WITNESS_AUDIT_ACTION = 'pair_witness_property_write';

export const WITNESS_AUDIT_SCOPE_TEXT =
  'These are the connector\'s own audit records for maintenance property writes. Only identifiers are stored: organization, site, stable issue id, pair id, permit id, outcome and HTTP status.';

export const WITNESS_AUDIT_EMPTY_TEXT =
  'No maintenance property-write records exist yet. Entries appear after an approved batch runs.';

export const WITNESS_AUDIT_UNAVAILABLE_TEXT =
  'The audit log could not be read as a record list, so nothing is shown.';

export const WITNESS_AUDIT_READ_FAILED_TEXT =
  'The audit log could not be read. Nothing was changed.';

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
  fontSize: '11px',
  verticalAlign: 'top',
  wordBreak: 'break-word'
};

const monoCellStyle = {
  ...cellStyle,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
};

const COLUMNS = [
  'Timestamp',
  'Outcome',
  'Organization',
  'Site',
  'Issue ID',
  'Pair UUID',
  'Permit ID',
  'Status / reason'
];

/**
 * Filters the raw audit log to maintenance-write records and maps them to the
 * display shape. Unknown or absent fields become an explicit dash rather than
 * being guessed from a neighbouring value.
 */
export function witnessAuditRows(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => entry && typeof entry === 'object' && entry.action === WITNESS_AUDIT_ACTION)
    .map((entry) => ({
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '—',
      outcome: typeof entry.outcome === 'string' ? entry.outcome : '—',
      orgId: typeof entry.orgId === 'string' ? entry.orgId : '—',
      site: typeof entry.site === 'string' ? entry.site : '—',
      issueId: typeof entry.issueId === 'string' ? entry.issueId : '—',
      pairId: typeof entry.pairId === 'string' ? entry.pairId : '—',
      permitId: typeof entry.permitId === 'string' ? entry.permitId : '—',
      statusReason: [
        entry.statusCode === undefined || entry.statusCode === null
          ? null
          : String(entry.statusCode),
        typeof entry.reason === 'string' ? entry.reason : null
      ].filter(Boolean).join(' · ') || '—'
    }));
}

const OUTCOME_APPEARANCE = {
  succeeded: 'success',
  attempted: 'inprogress',
  failed: 'removed',
  refused: 'moved'
};

export function WitnessAuditLog({ showMessage }) {
  const [state, setState] = useState('loading');
  const [rows, setRows] = useState([]);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const response = await invoke('getAuditLog');
      if (!Array.isArray(response)) {
        setRows([]);
        setState('unavailable');
        return;
      }
      const mapped = witnessAuditRows(response);
      setRows(mapped);
      setState(mapped.length === 0 ? 'empty' : 'ready');
    } catch {
      setRows([]);
      setState('error');
      if (typeof showMessage === 'function') {
        showMessage('error', WITNESS_AUDIT_READ_FAILED_TEXT);
      }
    }
  }, [showMessage]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div style={surfaceCard()} data-testid="witness-audit-log">
      <div style={{ display: 'flex', alignItems: 'center', gap: token('space.150', '12px'), marginBottom: token('space.100', '8px') }}>
        <h3 style={{ margin: 0, fontSize: '16px' }}>Maintenance write audit</h3>
        <Lozenge appearance="default">Read-only</Lozenge>
      </div>

      <p style={{ marginTop: 0, marginBottom: token('space.200', '16px'), fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
        {WITNESS_AUDIT_SCOPE_TEXT}
      </p>

      <div style={{ display: 'flex', gap: token('space.150', '12px'), alignItems: 'center', marginBottom: token('space.200', '16px') }}>
        <Button appearance="default" isDisabled={state === 'loading'} onClick={load}>
          Refresh audit records
        </Button>
        {state === 'loading' && <Spinner size="small" />}
        {state === 'ready' && (
          <span style={{ fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
            {`${rows.length} record(s)`}
          </span>
        )}
      </div>

      {state === 'error' && (
        <SectionMessage appearance="error" title="Audit log unavailable">
          <p style={{ margin: 0 }}>{WITNESS_AUDIT_READ_FAILED_TEXT}</p>
        </SectionMessage>
      )}

      {state === 'unavailable' && (
        <SectionMessage appearance="warning" title="Audit log not readable">
          <p style={{ margin: 0 }}>{WITNESS_AUDIT_UNAVAILABLE_TEXT}</p>
        </SectionMessage>
      )}

      {state === 'empty' && (
        <p style={{ margin: 0, fontSize: '13px' }}>{WITNESS_AUDIT_EMPTY_TEXT}</p>
      )}

      {state === 'ready' && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <th key={column} style={{ ...cellStyle, textAlign: 'left' }}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.timestamp}-${row.issueId}-${row.outcome}-${index}`}>
                <td style={cellStyle}>{row.timestamp}</td>
                <td style={cellStyle}>
                  <Lozenge appearance={OUTCOME_APPEARANCE[row.outcome] || 'default'}>
                    {row.outcome}
                  </Lozenge>
                </td>
                <td style={cellStyle}>{row.orgId}</td>
                <td style={cellStyle}>{row.site}</td>
                <td style={monoCellStyle}>{row.issueId}</td>
                <td style={monoCellStyle}>{row.pairId}</td>
                <td style={monoCellStyle}>{row.permitId}</td>
                <td style={cellStyle}>{row.statusReason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default WitnessAuditLog;

