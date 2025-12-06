import React, { useState } from 'react';
import { invoke } from '@forge/bridge';
import Button, { LoadingButton } from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import Spinner from '@atlaskit/spinner';
import { token } from '@atlaskit/tokens';
import CheckCircleIcon from '@atlaskit/icon/glyph/check-circle';
import ErrorIcon from '@atlaskit/icon/glyph/error';
import WarningIcon from '@atlaskit/icon/glyph/warning';

const Diagnostics = ({ selectedOrgId }) => {
  const [loading, setLoading] = useState(false);
  const [testType, setTestType] = useState(null); // 'health' or 'system'
  const [results, setResults] = useState(null);
  const [logs, setLogs] = useState([]);

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
    if (!confirm('⚠️ WARNING: This will create and delete a real issue in your Jira project. Do you want to proceed?')) return;

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
    </div>
  );
};

export default Diagnostics;
