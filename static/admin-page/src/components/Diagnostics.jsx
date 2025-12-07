import React, { useState } from 'react';
import { invoke } from '@forge/bridge';
import Button, { LoadingButton } from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import Spinner from '@atlaskit/spinner';
import TextField from '@atlaskit/textfield';
import { token } from '@atlaskit/tokens';
import CheckCircleIcon from '@atlaskit/icon/glyph/check-circle';
import ErrorIcon from '@atlaskit/icon/glyph/error';
import WarningIcon from '@atlaskit/icon/glyph/warning';

const Diagnostics = ({ selectedOrgId }) => {
  const [loading, setLoading] = useState(false);
  const [testType, setTestType] = useState(null); // 'health' or 'system'
  const [results, setResults] = useState(null);
  const [logs, setLogs] = useState([]);
  
  // Issue lookup state
  const [issueKey, setIssueKey] = useState('');
  const [issueLookupLoading, setIssueLookupLoading] = useState(false);
  const [issueMapping, setIssueMapping] = useState(null);
  const [forceSyncLoading, setForceSyncLoading] = useState(false);
  const [verifySyncLoading, setVerifySyncLoading] = useState(false);
  const [verificationResult, setVerificationResult] = useState(null);

  const runHealthCheck = async () => {
    if (!selectedOrgId) return;
    setLoading(true);
    setTestType('health');
    setResults(null);
    setLogs([]);

    try {
      const res = await invoke('runHealthCheck', { orgId: selectedOrgId });
      setResults(res);
    } catch (error) {
      setResults({ success: false, steps: [{ name: 'Invocation Error', status: 'error', message: error.message }] });
    } finally {
      setLoading(false);
    }
  };

  const runSystemTest = async () => {
    if (!selectedOrgId) return;
    if (!confirm('WARNING: This will create and delete a real issue in your Jira project. Do you want to proceed?')) return;

    setLoading(true);
    setTestType('system');
    setResults(null);
    setLogs([]);

    try {
      const res = await invoke('runSystemTest', { orgId: selectedOrgId });
      setResults(res);
      if (res.logs) setLogs(res.logs);
    } catch (error) {
      setResults({ success: false, error: error.message });
    } finally {
      setLoading(false);
    }
  };

  const checkIssueMapping = async () => {
    if (!selectedOrgId || !issueKey.trim()) return;
    setIssueLookupLoading(true);
    setIssueMapping(null);
    setVerificationResult(null);
    
    try {
      const res = await invoke('checkIssueMapping', { orgId: selectedOrgId, issueKey: issueKey.trim().toUpperCase() });
      setIssueMapping(res);
    } catch (error) {
      setIssueMapping({ error: error.message });
    } finally {
      setIssueLookupLoading(false);
    }
  };

  const verifyIssueSync = async () => {
    if (!selectedOrgId || !issueKey.trim()) return;
    setVerifySyncLoading(true);
    setVerificationResult(null);
    
    try {
      const res = await invoke('verifyIssueSync', { orgId: selectedOrgId, issueKey: issueKey.trim().toUpperCase() });
      setVerificationResult(res);
    } catch (error) {
      setVerificationResult({ error: error.message });
    } finally {
      setVerifySyncLoading(false);
    }
  };

  const forceSyncIssue = async () => {
    if (!selectedOrgId || !issueKey.trim()) return;
    if (!confirm(`This will remove any existing mapping for ${issueKey} and force sync it to the remote. Proceed?`)) return;
    
    setForceSyncLoading(true);
    
    try {
      const res = await invoke('forceSyncIssue', { orgId: selectedOrgId, issueKey: issueKey.trim().toUpperCase() });
      setIssueMapping(res);
    } catch (error) {
      setIssueMapping({ error: error.message });
    } finally {
      setForceSyncLoading(false);
    }
  };

  const getIcon = (status) => {
    switch (status) {
      case 'success': return <CheckCircleIcon primaryColor={token('color.icon.success', '#36B37E')} />;
      case 'error': return <ErrorIcon primaryColor={token('color.icon.danger', '#FF5630')} />;
      case 'warning': return <WarningIcon primaryColor={token('color.icon.warning', '#FFAB00')} />;
      default: return null;
    }
  };

  if (!selectedOrgId) {
    return <SectionMessage appearance="warning">Please select an organization to run diagnostics.</SectionMessage>;
  }

  return (
    <div style={{ padding: '20px' }}>
      <h3>Diagnostics & Health Check</h3>
      <p style={{ marginBottom: '20px' }}>Run checks to verify connectivity, permissions, and sync functionality.</p>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
        <LoadingButton 
          appearance="primary" 
          isLoading={loading && testType === 'health'} 
          onClick={runHealthCheck}
        >
          Run Health Check (Safe)
        </LoadingButton>
        
        <LoadingButton 
          appearance="danger" 
          isLoading={loading && testType === 'system'} 
          onClick={runSystemTest}
        >
          Run Full System Test (Creates Data)
        </LoadingButton>
      </div>

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '20px 0' }}>
          <Spinner size="medium" />
          <span>Running diagnostics... please wait...</span>
        </div>
      )}

      {results && testType === 'health' && (
        <div style={{ border: `1px solid ${token('color.border', '#ccc')}`, borderRadius: '8px', overflow: 'hidden' }}>
          {results.steps.map((step, i) => (
            <div key={i} style={{ 
              display: 'flex', 
              alignItems: 'center', 
              padding: '12px', 
              borderBottom: `1px solid ${token('color.border', '#eee')}`,
              background: step.status === 'error' ? token('color.background.danger.subtle', '#FFEBE6') : 'transparent'
            }}>
              <div style={{ marginRight: '10px' }}>{getIcon(step.status)}</div>
              <div style={{ flex: 1 }}>
                <strong>{step.name}</strong>
                <div style={{ fontSize: '12px', color: token('color.text.subtle', '#666') }}>{step.message}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {testType === 'system' && (
        <div>
          {results && (
            <SectionMessage appearance={results.success ? 'success' : 'error'}>
              {results.success ? 'System Test Passed! Issue created, synced, and deleted.' : `System Test Failed: ${results.error}`}
            </SectionMessage>
          )}
          
          {logs.length > 0 && (
            <div style={{ 
              marginTop: '20px', 
              background: '#f4f5f7', 
              padding: '15px', 
              borderRadius: '4px', 
              fontFamily: 'monospace', 
              fontSize: '12px' 
            }}>
              {logs.map((log, i) => <div key={i}>{log}</div>)}
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: '40px', borderTop: `1px solid ${token('color.border', '#eee')}`, paddingTop: '20px' }}>
        <h3>Issue Troubleshooting</h3>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', marginBottom: '20px' }}>
          <div style={{ flex: 1 }}>
            <label htmlFor="issue-key">Issue Key</label>
            <TextField 
              id="issue-key" 
              value={issueKey} 
              onChange={(e) => setIssueKey(e.target.value)} 
              placeholder="e.g. SCRUM-123" 
            />
          </div>
          <LoadingButton isLoading={issueLookupLoading} onClick={checkIssueMapping}>Check Mapping</LoadingButton>
          <LoadingButton isLoading={verifySyncLoading} onClick={verifyIssueSync}>Verify Sync</LoadingButton>
          <LoadingButton appearance="warning" isLoading={forceSyncLoading} onClick={forceSyncIssue}>Force Sync</LoadingButton>
        </div>

        {issueMapping && (
          <SectionMessage appearance={issueMapping.error ? 'error' : 'info'}>
            {issueMapping.error ? issueMapping.error : (
              <div>
                <p><strong>Local Key:</strong> {issueMapping.localKey}</p>
                <p><strong>Remote Key:</strong> {issueMapping.remoteKey || 'Not mapped'}</p>
                {issueMapping.remoteKey && <p><strong>Remote URL:</strong> <a href={issueMapping.remoteUrl} target="_blank" rel="noreferrer">{issueMapping.remoteUrl}</a></p>}
              </div>
            )}
          </SectionMessage>
        )}

        {verificationResult && (
          <div style={{ marginTop: '20px', padding: '15px', border: `1px solid ${token('color.border', '#ccc')}`, borderRadius: '8px' }}>
            <h4>Verification Results</h4>
            {verificationResult.error ? (
              <SectionMessage appearance="error">{verificationResult.error}</SectionMessage>
            ) : (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: '10px' }}>
                  <div style={{ marginRight: '10px' }}>{getIcon(verificationResult.discrepancies.length === 0 ? 'success' : 'warning')}</div>
                  <strong>{verificationResult.discrepancies.length === 0 ? 'Sync Verified - 100% Match' : 'Discrepancies Found'}</strong>
                </div>
                
                {verificationResult.discrepancies.length > 0 && (
                  <ul style={{ color: token('color.text.danger', '#DE350B') }}>
                    {verificationResult.discrepancies.map((d, i) => <li key={i}>{d}</li>)}
                  </ul>
                )}

                <div style={{ marginTop: '10px', fontSize: '12px', color: token('color.text.subtle', '#666') }}>
                  <p>Attachments: Local ({verificationResult.details?.attachments?.local}) / Remote ({verificationResult.details?.attachments?.remote})</p>
                  <p>Comments: Local ({verificationResult.details?.comments?.local}) / Remote ({verificationResult.details?.comments?.remote})</p>
                  <p>Status: {verificationResult.details?.status?.local} → {verificationResult.details?.status?.remote}</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default Diagnostics;
