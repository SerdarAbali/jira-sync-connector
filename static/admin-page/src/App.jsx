import React, { useState, useEffect } from 'react';
import { render } from 'react-dom';
import { invoke } from '@forge/bridge';
import Button from '@atlaskit/button';
import Form, { Field } from '@atlaskit/form';
import TextField from '@atlaskit/textfield';
import '@atlaskit/css-reset';

function App() {
  const [config, setConfig] = useState({
    remoteUrl: '',
    remoteEmail: '',
    remoteApiToken: '',
    remoteProjectKey: ''
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const savedConfig = await invoke('getConfig');
      if (savedConfig) {
        setConfig(savedConfig);
      }
    } catch (error) {
      console.error('Error loading config:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (data) => {
    setSaving(true);
    setMessage('');
    try {
      await invoke('saveConfig', { config: data });
      setMessage('Configuration saved successfully!');
      setConfig(data);
    } catch (error) {
      setMessage('Error saving configuration: ' + error.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ padding: '20px' }}>Loading...</div>;
  }

  return (
    <div style={{ padding: '20px', maxWidth: '600px' }}>
      <h1>Sync Connector Configuration</h1>
      <p>Configure the remote Jira instance to sync with:</p>
      
      <Form onSubmit={handleSubmit}>
        {({ formProps }) => (
          <form {...formProps}>
            <Field name="remoteUrl" defaultValue={config.remoteUrl} isRequired label="Remote Jira URL">
              {({ fieldProps }) => (
                <TextField {...fieldProps} placeholder="https://yourorg.atlassian.net" />
              )}
            </Field>

            <Field name="remoteEmail" defaultValue={config.remoteEmail} isRequired label="Remote Admin Email">
              {({ fieldProps }) => (
                <TextField {...fieldProps} placeholder="admin@example.com" />
              )}
            </Field>

            <Field name="remoteApiToken" defaultValue={config.remoteApiToken} isRequired label="Remote API Token">
              {({ fieldProps }) => (
                <TextField {...fieldProps} type="password" placeholder="API token from id.atlassian.com" />
              )}
            </Field>

            <Field name="remoteProjectKey" defaultValue={config.remoteProjectKey} isRequired label="Remote Project Key">
              {({ fieldProps }) => (
                <TextField {...fieldProps} placeholder="PROJ" />
              )}
            </Field>

            <Button type="submit" appearance="primary" isLoading={saving}>
              Save Configuration
            </Button>
          </form>
        )}
      </Form>

      {message && (
        <div style={{ 
          marginTop: '20px', 
          padding: '10px', 
          background: message.includes('Error') ? '#ffebe6' : '#e3fcef',
          borderRadius: '3px'
        }}>
          {message}
        </div>
      )}

      <div style={{ marginTop: '30px', padding: '15px', background: '#f4f5f7', borderRadius: '3px' }}>
        <h3>How to get API Token:</h3>
        <ol>
          <li>Go to: <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank">https://id.atlassian.com/manage-profile/security/api-tokens</a></li>
          <li>Click "Create API token"</li>
          <li>Name it "Jira Sync" and copy the token</li>
          <li>Paste it in the field above</li>
        </ol>
      </div>
    </div>
  );
}

render(<App />, document.getElementById('root'));