import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@forge/bridge';
import Button, { LoadingButton } from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import { token } from '@atlaskit/tokens';

export const DIAGNOSTIC_REPORT_CATEGORIES = Object.freeze([
  'Installation and application version',
  'Organization, direction, project and JQL scope',
  'Emergency Pause and synchronization authorization',
  'Mapping and configuration counts',
  'Recent synchronization activity',
  'Retained webhook and scheduled errors',
  'Recorded API usage and rate-limit observations',
  'Issue-create ledger health',
  'Pairing-witness and recovery attention states',
  'Bounded maintenance audit entries'
]);

export const DIAGNOSTIC_REPORT_WARNING =
  'Even after sanitization, diagnostic reports may still contain organization names, Jira hostnames, project keys and operational identifiers. Review the preview before external sharing and use only the approved customer-support channel. Credentials, Jira content and issue records are excluded.';

function safeFileName(report) {
  const orgId = String(report?.scope?.organizationId || 'organization').replace(/[^A-Za-z0-9_-]/g, '');
  const timestamp = String(report?.generatedAt || '').replace(/[^0-9TZ]/g, '');
  return `syncapp-diagnostic-${orgId || 'organization'}-${timestamp || 'report'}.json`;
}

function downloadReport(report) {
  if (typeof Blob !== 'function' || typeof URL === 'undefined'
      || typeof URL.createObjectURL !== 'function') return;
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeFileName(report);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

const DiagnosticReportPanel = ({ selectedOrgId }) => {
  const [generating, setGenerating] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const requestRef = useRef(0);
  const organizationRef = useRef(selectedOrgId);

  useEffect(() => {
    organizationRef.current = selectedOrgId;
    requestRef.current += 1;
    setReport(null);
    setError(null);
    setGenerating(false);
  }, [selectedOrgId]);

  const generate = async () => {
    if (!selectedOrgId) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    const requestedOrgId = selectedOrgId;
    setGenerating(true);
    setReport(null);
    setError(null);
    try {
      const response = await invoke('exportDiagnosticReport', { orgId: requestedOrgId });
      if (requestRef.current !== requestId || organizationRef.current !== requestedOrgId) return;
      if (!response?.success || !response.report) {
        setError(response?.code || 'DIAGNOSTIC_REPORT_FAILED');
        return;
      }
      setReport(response.report);
    } catch {
      if (requestRef.current === requestId && organizationRef.current === requestedOrgId) {
        setError('DIAGNOSTIC_REPORT_FAILED');
      }
    } finally {
      if (requestRef.current === requestId && organizationRef.current === requestedOrgId) {
        setGenerating(false);
      }
    }
  };

  if (!selectedOrgId) {
    return (
      <div className="dashboard-panel diagnostic-report-panel">
        <h3>Export Diagnostic Report</h3>
        <SectionMessage appearance="warning">
          Select an organization before generating a diagnostic report.
        </SectionMessage>
      </div>
    );
  }

  return (
    <div className="dashboard-panel diagnostic-report-panel">
      <h3>Export Diagnostic Report</h3>
      <p style={{ marginBottom: token('space.150', '12px') }}>
        Generate a bounded, sanitized JSON report from records already retained by
        the connector. The report is generated only when you click the button.
      </p>
      <SectionMessage appearance="warning" title="Review before sharing">
        {DIAGNOSTIC_REPORT_WARNING}
      </SectionMessage>
      <div className="diagnostic-report-categories">
        <strong>Evidence included</strong>
        <ul>
          {DIAGNOSTIC_REPORT_CATEGORIES.map(category => <li key={category}>{category}</li>)}
        </ul>
      </div>
      <div className="diagnostic-actions">
        <LoadingButton
          appearance="primary"
          isLoading={generating}
          onClick={generate}
          isDisabled={!selectedOrgId}
        >
          Generate diagnostic report
        </LoadingButton>
        {report && (
          <Button onClick={() => downloadReport(report)}>
            Download JSON
          </Button>
        )}
      </div>
      {error && (
        <SectionMessage appearance="error" title="Report unavailable">
          {error} No report was created or written.
        </SectionMessage>
      )}
      {report && (
        <div className="diagnostic-report-preview">
          <div className="diagnostic-report-meta">
            <strong>{report.schema}</strong> · version {report.schemaVersion} · {report.diagnosticStatus}
          </div>
          <pre aria-label="Diagnostic report preview">{JSON.stringify(report, null, 2)}</pre>
        </div>
      )}
    </div>
  );
};

export default DiagnosticReportPanel;
