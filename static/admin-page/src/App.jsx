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
    remoteProjectKey: ''
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const [configOpen, setConfigOpen] = useState(true);
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

  const [dataLoading, setDataLoading] = useState(false);

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
          background: message.includes('Error') ? '#ffebe6' : '#e3fcef',
          borderRadius: '3px'
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