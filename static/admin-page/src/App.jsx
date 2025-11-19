import React, { useState, useEffect } from 'react';
import { render } from 'react-dom';
import { invoke } from '@forge/bridge';
import Button from '@atlaskit/button';
import Form, { Field } from '@atlaskit/form';
import TextField from '@atlaskit/textfield';
import '@atlaskit/css-reset';

const sectionStyle = {
  marginTop: '30px',
  padding: '20px',
  background: 'white',
  borderRadius: '3px',
  border: '1px solid #dfe1e6'
};

const collapsibleHeaderStyle = {
  padding: '12px 16px',
  background: '#f4f5f7',
  borderRadius: '3px',
  cursor: 'pointer',
  fontWeight: 600,
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center'
};

const selectStyle = {
  width: '100%',
  padding: '8px',
  borderRadius: '3px',
  border: '2px solid #dfe1e6',
  fontSize: '14px',
  marginBottom: '10px'
};

const mappingItemStyle = {
  padding: '12px',
  background: '#f4f5f7',
  borderRadius: '3px',
  marginBottom: '8px',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center'
};

function App() {
  const [config, setConfig] = useState({
    remoteUrl: '',
    remoteEmail: '',
    remoteApiToken: '',
    remoteProjectKey: '',
    allowedProjects: []
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const [configOpen, setConfigOpen] = useState(true);
  const [syncHealthOpen, setSyncHealthOpen] = useState(false);
  const [projectFilterOpen, setProjectFilterOpen] = useState(false);
  const [userMappingOpen, setUserMappingOpen] = useState(false);
  const [fieldMappingOpen, setFieldMappingOpen] = useState(false);
  const [statusMappingOpen, setStatusMappingOpen] = useState(false);

  const [userMappings, setUserMappings] = useState({});
  const [fieldMappings, setFieldMappings] = useState({});
  const [statusMappings, setStatusMappings] = useState({});

  const [newUserRemote, setNewUserRemote] = useState('');
  const [newUserLocal, setNewUserLocal] = useState('');
  const [newFieldRemote, setNewFieldRemote] = useState('');
  const [newFieldLocal, setNewFieldLocal] = useState('');
  const [newStatusRemote, setNewStatusRemote] = useState('');
  const [newStatusLocal, setNewStatusLocal] = useState('');

  const [remoteUsers, setRemoteUsers] = useState([]);
  const [localUsers, setLocalUsers] = useState([]);
  const [remoteFields, setRemoteFields] = useState([]);
  const [localFields, setLocalFields] = useState([]);
  const [remoteStatuses, setRemoteStatuses] = useState([]);
  const [localStatuses, setLocalStatuses] = useState([]);
  const [localProjects, setLocalProjects] = useState([]);

  const [dataLoading, setDataLoading] = useState(false);
  const [scheduledStats, setScheduledStats] = useState(null);
  const [webhookStats, setWebhookStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);

  useEffect(() => {
    loadConfiguration();
    loadAllMappings();
  }, []);

  const loadConfiguration = async () => {
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

  const loadAllMappings = async () => {
    try {
      const userMappingData = await invoke('getUserMappings');
      if (userMappingData && userMappingData.mappings) {
        setUserMappings(userMappingData.mappings);
      }

      const fieldMappingData = await invoke('getFieldMappings');
      if (fieldMappingData) {
        setFieldMappings(fieldMappingData);
      }

      const statusMappingData = await invoke('getStatusMappings');
      if (statusMappingData) {
        setStatusMappings(statusMappingData);
      }
    } catch (error) {
      console.error('Error loading mappings:', error);
    }
  };

  const loadRemoteData = async () => {
    if (!config.remoteUrl || !config.remoteEmail || !config.remoteApiToken || !config.remoteProjectKey) {
      setMessage('Please save remote configuration first');
      setTimeout(() => setMessage(''), 3000);
      return;
    }

    setDataLoading(true);
    setMessage('Loading remote data...');

    try {
      const data = await invoke('fetchRemoteData');
      
      if (data.users) {
        setRemoteUsers(data.users);
        if (data.users.length > 0) setNewUserRemote(data.users[0].accountId);
      }
      if (data.fields) {
        setRemoteFields(data.fields);
        if (data.fields.length > 0) setNewFieldRemote(data.fields[0].id);
      }
      if (data.statuses) {
        setRemoteStatuses(data.statuses);
        if (data.statuses.length > 0) setNewStatusRemote(data.statuses[0].id);
      }
      
      setMessage('Remote data loaded successfully!');
    } catch (error) {
      setMessage('Error loading remote data: ' + error.message);
      console.error(error);
    } finally {
      setDataLoading(false);
      setTimeout(() => setMessage(''), 3000);
    }
  };

  const loadLocalData = async () => {
    setDataLoading(true);
    setMessage('Loading local data...');

    try {
      const data = await invoke('fetchLocalData');

      if (data.users) {
        setLocalUsers(data.users);
        if (data.users.length > 0) setNewUserLocal(data.users[0].accountId);
      }
      if (data.fields) {
        setLocalFields(data.fields);
        if (data.fields.length > 0) setNewFieldLocal(data.fields[0].id);
      }
      if (data.statuses) {
        setLocalStatuses(data.statuses);
        if (data.statuses.length > 0) setNewStatusLocal(data.statuses[0].id);
      }

      setMessage('Local data loaded successfully!');
    } catch (error) {
      setMessage('Error loading local data: ' + error.message);
      console.error(error);
    } finally {
      setDataLoading(false);
      setTimeout(() => setMessage(''), 3000);
    }
  };

  const loadLocalProjects = async () => {
    setDataLoading(true);
    setMessage('Loading local projects...');

    try {
      const data = await invoke('fetchLocalProjects');

      if (data.projects) {
        setLocalProjects(data.projects);
        setMessage(`Loaded ${data.projects.length} project(s) successfully!`);
      }
    } catch (error) {
      setMessage('Error loading local projects: ' + error.message);
      console.error(error);
    } finally {
      setDataLoading(false);
      setTimeout(() => setMessage(''), 3000);
    }
  };

  const toggleProjectSelection = (projectKey) => {
    console.log('Toggling project:', projectKey);
    setConfig(prev => {
      const currentProjects = prev.allowedProjects || [];
      const isSelected = currentProjects.includes(projectKey);
      const newProjects = isSelected
        ? currentProjects.filter(p => p !== projectKey)
        : [...currentProjects, projectKey];

      console.log('Previous projects:', currentProjects);
      console.log('New projects:', newProjects);

      return {
        ...prev,
        allowedProjects: newProjects
      };
    });
  };

  const loadSyncStats = async () => {
    setStatsLoading(true);
    try {
      const [scheduled, webhook] = await Promise.all([
        invoke('getScheduledSyncStats'),
        invoke('getWebhookSyncStats')
      ]);
      setScheduledStats(scheduled);
      setWebhookStats(webhook);
    } catch (error) {
      console.error('Error loading sync stats:', error);
      setMessage('Error loading sync stats: ' + error.message);
      setTimeout(() => setMessage(''), 3000);
    } finally {
      setStatsLoading(false);
    }
  };

  const handleSaveProjectFilter = async () => {
    setSaving(true);
    setMessage('');
    try {
      await invoke('saveConfig', { config });
      setMessage('Project filter saved successfully!');
    } catch (error) {
      setMessage('Error saving project filter: ' + error.message);
    } finally {
      setSaving(false);
      setTimeout(() => setMessage(''), 3000);
    }
  };

  const validateConfig = (data) => {
    const errors = [];

    // Validate remote URL
    if (!data.remoteUrl || data.remoteUrl.trim() === '') {
      errors.push('Remote Jira URL is required');
    } else {
      try {
        const url = new URL(data.remoteUrl);
        if (!url.protocol.startsWith('http')) {
          errors.push('Remote URL must use http:// or https://');
        }
        if (!url.hostname.includes('atlassian.net')) {
          errors.push('Remote URL must be an Atlassian domain (*.atlassian.net)');
        }
      } catch (e) {
        errors.push('Remote URL is not a valid URL');
      }
    }

    // Validate email
    if (!data.remoteEmail || data.remoteEmail.trim() === '') {
      errors.push('Admin email is required');
    } else {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(data.remoteEmail)) {
        errors.push('Admin email is not valid');
      }
    }

    // Validate API token
    if (!data.remoteApiToken || data.remoteApiToken.trim() === '') {
      errors.push('API token is required');
    } else if (data.remoteApiToken.length < 20) {
      errors.push('API token appears to be invalid (too short)');
    }

    // Validate project key
    if (!data.remoteProjectKey || data.remoteProjectKey.trim() === '') {
      errors.push('Project key is required');
    } else {
      const projectKeyRegex = /^[A-Z][A-Z0-9_]*$/;
      if (!projectKeyRegex.test(data.remoteProjectKey)) {
        errors.push('Project key must be uppercase letters, numbers, and underscores (e.g., SCRUM)');
      }
    }

    return errors;
  };

  const handleSubmit = async (data) => {
    setSaving(true);
    setMessage('');

    // Validate input
    const validationErrors = validateConfig(data);
    if (validationErrors.length > 0) {
      setMessage('Validation errors:\n' + validationErrors.join('\n'));
      setSaving(false);
      setTimeout(() => setMessage(''), 5000);
      return;
    }

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

  const addUserMapping = () => {
    if (newUserRemote && newUserLocal) {
      const remoteUser = remoteUsers.find(u => u.accountId === newUserRemote);
      const localUser = localUsers.find(u => u.accountId === newUserLocal);
      
      setUserMappings(prev => ({
        ...prev,
        [newUserRemote]: {
          localId: newUserLocal,
          remoteName: remoteUser?.displayName || newUserRemote,
          localName: localUser?.displayName || newUserLocal
        }
      }));
      setNewUserRemote('');
      setNewUserLocal('');
    }
  };

  const addFieldMapping = () => {
    if (newFieldRemote && newFieldLocal) {
      const remoteField = remoteFields.find(f => f.id === newFieldRemote);
      const localField = localFields.find(f => f.id === newFieldLocal);
      
      setFieldMappings(prev => ({
        ...prev,
        [newFieldRemote]: {
          localId: newFieldLocal,
          remoteName: remoteField?.name || newFieldRemote,
          localName: localField?.name || newFieldLocal
        }
      }));
      setNewFieldRemote('');
      setNewFieldLocal('');
    }
  };

  const addStatusMapping = () => {
    if (newStatusRemote && newStatusLocal) {
      const remoteStatus = remoteStatuses.find(s => s.id === newStatusRemote);
      const localStatus = localStatuses.find(s => s.id === newStatusLocal);
      
      setStatusMappings(prev => ({
        ...prev,
        [newStatusRemote]: {
          localId: newStatusLocal,
          remoteName: remoteStatus?.name || newStatusRemote,
          localName: localStatus?.name || newStatusLocal
        }
      }));
      setNewStatusRemote('');
      setNewStatusLocal('');
    }
  };

  const deleteUserMapping = (remoteId) => {
    setUserMappings(prev => {
      const updated = { ...prev };
      delete updated[remoteId];
      return updated;
    });
  };

  const deleteFieldMapping = (remoteId) => {
    setFieldMappings(prev => {
      const updated = { ...prev };
      delete updated[remoteId];
      return updated;
    });
  };

  const deleteStatusMapping = (remoteId) => {
    setStatusMappings(prev => {
      const updated = { ...prev };
      delete updated[remoteId];
      return updated;
    });
  };

  const handleSaveUserMappings = async () => {
    setSaving(true);
    setMessage('');
    try {
      await invoke('saveUserMappings', {
        mappings: userMappings,
        config: { autoMapUsers: false, fallbackUser: 'unassigned' }
      });
      setMessage('User mappings saved successfully!');
    } catch (error) {
      setMessage('Error saving user mappings: ' + error.message);
    } finally {
      setSaving(false);
      setTimeout(() => setMessage(''), 3000);
    }
  };

  const handleSaveFieldMappings = async () => {
    setSaving(true);
    setMessage('');
    try {
      await invoke('saveFieldMappings', {
        mappings: fieldMappings
      });
      setMessage('Field mappings saved successfully!');
    } catch (error) {
      setMessage('Error saving field mappings: ' + error.message);
    } finally {
      setSaving(false);
      setTimeout(() => setMessage(''), 3000);
    }
  };

  const handleSaveStatusMappings = async () => {
    setSaving(true);
    setMessage('');
    try {
      await invoke('saveStatusMappings', {
        mappings: statusMappings
      });
      setMessage('Status mappings saved successfully!');
    } catch (error) {
      setMessage('Error saving status mappings: ' + error.message);
    } finally {
      setSaving(false);
      setTimeout(() => setMessage(''), 3000);
    }
  };

  if (loading) {
    return <div style={{ padding: '20px' }}>Loading...</div>;
  }

  return (
    <div style={{ padding: '20px', maxWidth: '800px' }}>
      <h1>Sync Connector Configuration</h1>
      <p>Configure the remote Jira instance to sync with:</p>
      
      <div style={sectionStyle}>
        <div 
          style={collapsibleHeaderStyle}
          onClick={() => setConfigOpen(!configOpen)}
        >
          <span>Remote Jira Configuration</span>
          <span>{configOpen ? '▼' : '▶'}</span>
        </div>

        {configOpen && (
          <div style={{ marginTop: '16px' }}>
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

            <div style={{ marginTop: '30px', padding: '15px', background: '#f4f5f7', borderRadius: '3px' }}>
              <h4 style={{ marginTop: 0 }}>How to get API Token:</h4>
              <ol style={{ marginBottom: 0 }}>
                <li>Go to: <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer">https://id.atlassian.com/manage-profile/security/api-tokens</a></li>
                <li>Click "Create API token"</li>
                <li>Name it "Jira Sync" and copy the token</li>
                <li>Paste it in the field above</li>
              </ol>
            </div>
          </div>
        )}
      </div>

      {message && (
        <div style={{
          marginTop: '20px',
          padding: '10px',
          background: message.includes('Error') || message.includes('Validation') ? '#ffebe6' : '#e3fcef',
          borderRadius: '3px',
          whiteSpace: 'pre-line'
        }}>
          {message}
        </div>
      )}

      <div style={{ marginTop: '20px', display: 'flex', gap: '10px' }}>
        <Button appearance="primary" onClick={loadRemoteData} isLoading={dataLoading}>
          Load Remote Data
        </Button>
        <Button appearance="primary" onClick={loadLocalData} isLoading={dataLoading}>
          Load Local Data
        </Button>
      </div>

      <div style={sectionStyle}>
        <div
          style={collapsibleHeaderStyle}
          onClick={() => setSyncHealthOpen(!syncHealthOpen)}
        >
          <span>Sync Health & Statistics</span>
          <span>{syncHealthOpen ? '▼' : '▶'}</span>
        </div>

        {syncHealthOpen && (
          <div style={{ marginTop: '16px' }}>
            <p style={{ marginBottom: '16px', color: '#6B778C' }}>
              View synchronization statistics and health metrics.
            </p>

            <Button appearance="primary" onClick={loadSyncStats} isLoading={statsLoading} style={{ marginBottom: '16px' }}>
              Refresh Stats
            </Button>

            {webhookStats && (
              <div style={{ marginBottom: '24px' }}>
                <h3 style={{ marginTop: 0, marginBottom: '16px', color: '#172B4D' }}>Real-time Webhook Syncs</h3>

                {webhookStats.lastSync ? (
                  <div style={{ padding: '16px', background: '#f4f5f7', borderRadius: '3px', marginBottom: '16px' }}>
                    <p style={{ margin: '4px 0' }}>
                      <strong>Last Activity:</strong> {new Date(webhookStats.lastSync).toLocaleString()}
                    </p>
                    <p style={{ margin: '4px 0' }}>
                      <strong>Total Syncs:</strong> {webhookStats.totalSyncs || 0}
                    </p>
                  </div>
                ) : (
                  <div style={{ padding: '16px', background: '#fff4e6', borderRadius: '3px', marginBottom: '16px' }}>
                    <p style={{ margin: 0 }}>No webhook syncs have occurred yet.</p>
                  </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', marginBottom: '16px' }}>
                  <div style={{ padding: '16px', background: '#e3fcef', borderRadius: '3px' }}>
                    <h4 style={{ marginTop: 0, fontSize: '14px', color: '#00875A' }}>Issues Created</h4>
                    <p style={{ fontSize: '28px', fontWeight: 'bold', margin: 0 }}>{webhookStats.issuesCreated || 0}</p>
                  </div>

                  <div style={{ padding: '16px', background: '#e3fcef', borderRadius: '3px' }}>
                    <h4 style={{ marginTop: 0, fontSize: '14px', color: '#00875A' }}>Issues Updated</h4>
                    <p style={{ fontSize: '28px', fontWeight: 'bold', margin: 0 }}>{webhookStats.issuesUpdated || 0}</p>
                  </div>

                  <div style={{ padding: '16px', background: '#deebff', borderRadius: '3px' }}>
                    <h4 style={{ marginTop: 0, fontSize: '14px', color: '#0052CC' }}>Comments Synced</h4>
                    <p style={{ fontSize: '28px', fontWeight: 'bold', margin: 0 }}>{webhookStats.commentsSynced || 0}</p>
                  </div>
                </div>

                {webhookStats.errors && webhookStats.errors.length > 0 && (
                  <div style={{ padding: '16px', background: '#ffebe6', borderRadius: '3px', marginBottom: '16px' }}>
                    <h4 style={{ marginTop: 0, color: '#DE350B' }}>Recent Webhook Errors ({webhookStats.errors.length})</h4>
                    <ul style={{ margin: 0, paddingLeft: '20px' }}>
                      {webhookStats.errors.slice(0, 5).map((err, index) => (
                        <li key={index} style={{ fontSize: '13px', marginBottom: '4px' }}>
                          <strong>{new Date(err.timestamp).toLocaleTimeString()}:</strong> {err.error}
                        </li>
                      ))}
                    </ul>
                    {webhookStats.errors.length > 5 && (
                      <p style={{ fontSize: '12px', color: '#6B778C', marginTop: '8px', marginBottom: 0 }}>
                        ... and {webhookStats.errors.length - 5} more errors
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {scheduledStats && (
              <div>
                <h3 style={{ marginTop: 0, marginBottom: '16px', color: '#172B4D' }}>Scheduled Bulk Syncs (Hourly)</h3>

                {scheduledStats.lastRun ? (
                  <div style={{ padding: '16px', background: '#f4f5f7', borderRadius: '3px', marginBottom: '16px' }}>
                    <p style={{ margin: '4px 0' }}>
                      <strong>Last Run:</strong> {new Date(scheduledStats.lastRun).toLocaleString()}
                    </p>
                    <p style={{ margin: '4px 0' }}>
                      <strong>Time Ago:</strong> {Math.round((Date.now() - new Date(scheduledStats.lastRun).getTime()) / 1000 / 60)} minutes ago
                    </p>
                  </div>
                ) : (
                  <div style={{ padding: '16px', background: '#fff4e6', borderRadius: '3px', marginBottom: '16px' }}>
                    <p style={{ margin: 0 }}>No scheduled sync has run yet. First run will occur within 1 hour of deployment.</p>
                  </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
                  <div style={{ padding: '16px', background: '#e3fcef', borderRadius: '3px' }}>
                    <h4 style={{ marginTop: 0, fontSize: '14px', color: '#00875A' }}>Issues Checked</h4>
                    <p style={{ fontSize: '28px', fontWeight: 'bold', margin: 0 }}>{scheduledStats.issuesChecked || 0}</p>
                  </div>

                  <div style={{ padding: '16px', background: '#e3fcef', borderRadius: '3px' }}>
                    <h4 style={{ marginTop: 0, fontSize: '14px', color: '#00875A' }}>Issues Created</h4>
                    <p style={{ fontSize: '28px', fontWeight: 'bold', margin: 0 }}>{scheduledStats.issuesCreated || 0}</p>
                  </div>

                  <div style={{ padding: '16px', background: '#e3fcef', borderRadius: '3px' }}>
                    <h4 style={{ marginTop: 0, fontSize: '14px', color: '#00875A' }}>Issues Updated</h4>
                    <p style={{ fontSize: '28px', fontWeight: 'bold', margin: 0 }}>{scheduledStats.issuesUpdated || 0}</p>
                  </div>

                  <div style={{ padding: '16px', background: '#fff4e6', borderRadius: '3px' }}>
                    <h4 style={{ marginTop: 0, fontSize: '14px', color: '#FF8B00' }}>Issues Skipped</h4>
                    <p style={{ fontSize: '28px', fontWeight: 'bold', margin: 0 }}>{scheduledStats.issuesSkipped || 0}</p>
                  </div>
                </div>

                {scheduledStats.errors && scheduledStats.errors.length > 0 && (
                  <div style={{ padding: '16px', background: '#ffebe6', borderRadius: '3px', marginBottom: '16px' }}>
                    <h4 style={{ marginTop: 0, color: '#DE350B' }}>Recent Scheduled Sync Errors ({scheduledStats.errors.length})</h4>
                    <ul style={{ margin: 0, paddingLeft: '20px' }}>
                      {scheduledStats.errors.slice(0, 5).map((error, index) => (
                        <li key={index} style={{ fontSize: '13px', marginBottom: '4px' }}>{error}</li>
                      ))}
                    </ul>
                    {scheduledStats.errors.length > 5 && (
                      <p style={{ fontSize: '12px', color: '#6B778C', marginTop: '8px', marginBottom: 0 }}>
                        ... and {scheduledStats.errors.length - 5} more errors
                      </p>
                    )}
                  </div>
                )}

                <div style={{ marginTop: '16px', padding: '12px', background: '#f4f5f7', borderRadius: '3px' }}>
                  <p style={{ fontSize: '12px', color: '#6B778C', margin: 0 }}>
                    <strong>Success Rate:</strong> {scheduledStats.issuesChecked > 0
                      ? `${Math.round(((scheduledStats.issuesCreated + scheduledStats.issuesUpdated) / scheduledStats.issuesChecked) * 100)}%`
                      : 'N/A'}
                  </p>
                </div>
              </div>
            )}

            {(!webhookStats && !scheduledStats) && !statsLoading && (
              <div style={{ padding: '16px', background: '#f4f5f7', borderRadius: '3px' }}>
                <p style={{ margin: 0, color: '#6B778C' }}>Click "Refresh Stats" to load sync statistics.</p>
              </div>
            )}
          </div>
        )}
      </div>

      <div style={sectionStyle}>
        <div
          style={collapsibleHeaderStyle}
          onClick={() => setProjectFilterOpen(!projectFilterOpen)}
        >
          <span>Project Filter ({config.allowedProjects?.length || 0} selected)</span>
          <span>{projectFilterOpen ? '▼' : '▶'}</span>
        </div>

        {projectFilterOpen && (
          <div style={{ marginTop: '16px' }}>
            <p style={{ marginBottom: '16px', color: '#6B778C' }}>
              Select which projects to sync. If no projects are selected, all projects will be synced (backward compatible).
            </p>

            {config.allowedProjects && config.allowedProjects.length > 0 && localProjects.length === 0 && (
              <div style={{ marginBottom: '16px', padding: '12px', background: '#e3fcef', borderRadius: '3px' }}>
                <h4 style={{ marginTop: 0 }}>Currently Selected Projects:</h4>
                <ul style={{ marginBottom: 0 }}>
                  {config.allowedProjects.map(projectKey => (
                    <li key={projectKey}><strong>{projectKey}</strong></li>
                  ))}
                </ul>
                <p style={{ color: '#6B778C', fontSize: '12px', marginTop: '8px', marginBottom: 0 }}>
                  Click "Load Projects" below to see all available projects and modify selection
                </p>
              </div>
            )}

            <Button appearance="primary" onClick={loadLocalProjects} isLoading={dataLoading} style={{ marginBottom: '16px' }}>
              Load Projects
            </Button>

            {localProjects.length > 0 && (
              <>
                <h4>Available Projects</h4>
                <div style={{ marginBottom: '16px' }}>
                  {localProjects.map(project => {
                    const isSelected = config.allowedProjects?.includes(project.key);
                    return (
                      <div
                        key={project.key}
                        style={{
                          padding: '12px',
                          background: isSelected ? '#e3fcef' : '#f4f5f7',
                          borderRadius: '3px',
                          marginBottom: '8px',
                          display: 'flex',
                          alignItems: 'center',
                          cursor: 'pointer',
                          border: isSelected ? '2px solid #00875A' : '2px solid transparent'
                        }}
                        onClick={() => toggleProjectSelection(project.key)}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected || false}
                          readOnly
                          style={{ marginRight: '12px', cursor: 'pointer', pointerEvents: 'none' }}
                        />
                        <div>
                          <strong>{project.key}</strong> - {project.name}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <Button appearance="primary" onClick={handleSaveProjectFilter} isLoading={saving}>
                  Save Project Filter
                </Button>
              </>
            )}

            {localProjects.length === 0 && (!config.allowedProjects || config.allowedProjects.length === 0) && (
              <p style={{ color: '#6B778C', fontStyle: 'italic' }}>
                Click "Load Projects" to see available projects
              </p>
            )}
          </div>
        )}
      </div>

      <div style={sectionStyle}>
        <div
          style={collapsibleHeaderStyle}
          onClick={() => setUserMappingOpen(!userMappingOpen)}
        >
          <span>User Mapping ({Object.keys(userMappings).length})</span>
          <span>{userMappingOpen ? '▼' : '▶'}</span>
        </div>

        {userMappingOpen && (
          <div style={{ marginTop: '16px' }}>
            <h4>Add User Mapping</h4>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', marginBottom: '4px', fontWeight: 600 }}>
                Remote User
              </label>
              <select
                value={newUserRemote}
                onChange={(e) => setNewUserRemote(e.target.value)}
                style={selectStyle}
              >
                <option value="">Select remote user...</option>
                {remoteUsers.map(user => (
                  <option key={user.accountId} value={user.accountId}>
                    {user.displayName}{user.emailAddress ? ` (${user.emailAddress})` : ''}
                  </option>
                ))}
              </select>

              <label style={{ display: 'block', marginBottom: '4px', fontWeight: 600 }}>
                Local User
              </label>
              <select
                value={newUserLocal}
                onChange={(e) => setNewUserLocal(e.target.value)}
                style={selectStyle}
              >
                <option value="">Select local user...</option>
                {localUsers.map(user => (
                  <option key={user.accountId} value={user.accountId}>
                    {user.displayName}{user.emailAddress ? ` (${user.emailAddress})` : ''}
                  </option>
                ))}
              </select>

              <Button appearance="primary" onClick={addUserMapping}>
                Add Mapping
              </Button>
            </div>

            <h4>Current Mappings</h4>
            {Object.keys(userMappings).length === 0 && (
              <p style={{ color: '#6B778C', fontStyle: 'italic' }}>No user mappings yet</p>
            )}
            {Object.entries(userMappings).map(([remoteId, mapping]) => {
              const localId = typeof mapping === 'string' ? mapping : mapping.localId;
              const remoteName = typeof mapping === 'object' ? mapping.remoteName : remoteId;
              const localName = typeof mapping === 'object' ? mapping.localName : localId;
              
              return (
                <div key={remoteId} style={mappingItemStyle}>
                  <span>
                    <strong>{remoteName}</strong> → {localName}
                  </span>
                  <Button appearance="subtle" onClick={() => deleteUserMapping(remoteId)}>
                    Delete
                  </Button>
                </div>
              );
            })}

            <div style={{ marginTop: '16px' }}>
              <Button appearance="primary" onClick={handleSaveUserMappings} isLoading={saving}>
                Save User Mappings
              </Button>
            </div>
          </div>
        )}
      </div>

      <div style={sectionStyle}>
        <div 
          style={collapsibleHeaderStyle}
          onClick={() => setFieldMappingOpen(!fieldMappingOpen)}
        >
          <span>Field Mapping ({Object.keys(fieldMappings).length})</span>
          <span>{fieldMappingOpen ? '▼' : '▶'}</span>
        </div>

        {fieldMappingOpen && (
          <div style={{ marginTop: '16px' }}>
            <h4>Add Field Mapping</h4>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', marginBottom: '4px', fontWeight: 600 }}>
                Remote Field
              </label>
              <select
                value={newFieldRemote}
                onChange={(e) => setNewFieldRemote(e.target.value)}
                style={selectStyle}
              >
                <option value="">Select remote field...</option>
                {remoteFields.map(field => (
                  <option key={field.id} value={field.id}>
                    {field.name} ({field.id})
                  </option>
                ))}
              </select>

              <label style={{ display: 'block', marginBottom: '4px', fontWeight: 600 }}>
                Local Field
              </label>
              <select
                value={newFieldLocal}
                onChange={(e) => setNewFieldLocal(e.target.value)}
                style={selectStyle}
              >
                <option value="">Select local field...</option>
                {localFields.map(field => (
                  <option key={field.id} value={field.id}>
                    {field.name} ({field.id})
                  </option>
                ))}
              </select>

              <Button appearance="primary" onClick={addFieldMapping}>
                Add Mapping
              </Button>
            </div>

            <h4>Current Mappings</h4>
            {Object.keys(fieldMappings).length === 0 && (
              <p style={{ color: '#6B778C', fontStyle: 'italic' }}>No field mappings yet</p>
            )}
            {Object.entries(fieldMappings).map(([remoteId, mapping]) => {
              const localId = typeof mapping === 'string' ? mapping : mapping.localId;
              const remoteName = typeof mapping === 'object' ? mapping.remoteName : remoteId;
              const localName = typeof mapping === 'object' ? mapping.localName : localId;
              
              return (
                <div key={remoteId} style={mappingItemStyle}>
                  <span>
                    <strong>{remoteName}</strong> → {localName}
                  </span>
                  <Button appearance="subtle" onClick={() => deleteFieldMapping(remoteId)}>
                    Delete
                  </Button>
                </div>
              );
            })}

            <div style={{ marginTop: '16px' }}>
              <Button appearance="primary" onClick={handleSaveFieldMappings} isLoading={saving}>
                Save Field Mappings
              </Button>
            </div>
          </div>
        )}
      </div>

      <div style={sectionStyle}>
        <div 
          style={collapsibleHeaderStyle}
          onClick={() => setStatusMappingOpen(!statusMappingOpen)}
        >
          <span>Status Mapping ({Object.keys(statusMappings).length})</span>
          <span>{statusMappingOpen ? '▼' : '▶'}</span>
        </div>

        {statusMappingOpen && (
          <div style={{ marginTop: '16px' }}>
            <h4>Add Status Mapping</h4>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', marginBottom: '4px', fontWeight: 600 }}>
                Remote Status
              </label>
              <select
                value={newStatusRemote}
                onChange={(e) => setNewStatusRemote(e.target.value)}
                style={selectStyle}
              >
                <option value="">Select remote status...</option>
                {remoteStatuses.map(status => (
                  <option key={status.id} value={status.id}>
                    {status.name}
                  </option>
                ))}
              </select>

              <label style={{ display: 'block', marginBottom: '4px', fontWeight: 600 }}>
                Local Status
              </label>
              <select
                value={newStatusLocal}
                onChange={(e) => setNewStatusLocal(e.target.value)}
                style={selectStyle}
              >
                <option value="">Select local status...</option>
                {localStatuses.map(status => (
                  <option key={status.id} value={status.id}>
                    {status.name}
                  </option>
                ))}
              </select>

              <Button appearance="primary" onClick={addStatusMapping}>
                Add Mapping
              </Button>
            </div>

            <h4>Current Mappings</h4>
            {Object.keys(statusMappings).length === 0 && (
              <p style={{ color: '#6B778C', fontStyle: 'italic' }}>No status mappings yet</p>
            )}
            {Object.entries(statusMappings).map(([remoteId, mapping]) => {
              const localId = typeof mapping === 'string' ? mapping : mapping.localId;
              const remoteName = typeof mapping === 'object' ? mapping.remoteName : remoteId;
              const localName = typeof mapping === 'object' ? mapping.localName : localId;
              
              return (
                <div key={remoteId} style={mappingItemStyle}>
                  <span>
                    <strong>{remoteName}</strong> → {localName}
                  </span>
                  <Button appearance="subtle" onClick={() => deleteStatusMapping(remoteId)}>
                    Delete
                  </Button>
                </div>
              );
            })}

            <div style={{ marginTop: '16px' }}>
              <Button appearance="primary" onClick={handleSaveStatusMappings} isLoading={saving}>
                Save Status Mappings
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

render(<App />, document.getElementById('root'));