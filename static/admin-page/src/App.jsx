import React, { useState, useEffect } from 'react';
import { render } from 'react-dom';
import { invoke } from '@forge/bridge';
import Button from '@atlaskit/button';
import Form, { Field } from '@atlaskit/form';
import TextField from '@atlaskit/textfield';
import Tabs, { Tab, TabList, TabPanel } from '@atlaskit/tabs';
import Select from '@atlaskit/select';
import Spinner from '@atlaskit/spinner';
import SectionMessage from '@atlaskit/section-message';
import '@atlaskit/css-reset';
import ErrorBoundary from './components/ErrorBoundary';

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
  const [organizations, setOrganizations] = useState([]);
  const [selectedOrgId, setSelectedOrgId] = useState(null);
  const [showAddOrgForm, setShowAddOrgForm] = useState(false);
  const [editingOrg, setEditingOrg] = useState(null);

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

  const [manualSyncOpen, setManualSyncOpen] = useState(false);
  const [manualIssueKey, setManualIssueKey] = useState('');
  const [manualSyncLoading, setManualSyncLoading] = useState(false);

  const [syncOptionsOpen, setSyncOptionsOpen] = useState(false);
  const [syncOptions, setSyncOptions] = useState({
    syncComments: true,
    syncAttachments: true,
    syncLinks: true,
    syncSprints: false
  });

  const [auditLogOpen, setAuditLogOpen] = useState(false);
  const [auditLog, setAuditLog] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);

  const [scheduledSyncOpen, setScheduledSyncOpen] = useState(false);
  const [scheduledSyncConfig, setScheduledSyncConfig] = useState({
    enabled: false,
    intervalMinutes: 60,
    lastRun: null,
    syncScope: 'recent'
  });

  const [pendingLinksLoading, setPendingLinksLoading] = useState(false);

  const [dataLoaded, setDataLoaded] = useState({
    remote: false,
    local: false
  });

  const [expandedSections, setExpandedSections] = useState({
    users: true,
    fields: false,
    statuses: false
  });

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  useEffect(() => {
    loadOrganizations();
    loadConfiguration();
    loadScheduledSyncConfig();
  }, []);

  useEffect(() => {
    if (selectedOrgId) {
      loadAllMappingsForOrg(selectedOrgId);
      setDataLoaded({ remote: false, local: false });
    }
  }, [selectedOrgId]);

  const loadOrganizations = async () => {
    try {
      const orgs = await invoke('getOrganizations');
      setOrganizations(orgs || []);
      if (orgs && orgs.length > 0 && !selectedOrgId) {
        setSelectedOrgId(orgs[0].id);
      }
    } catch (error) {
      console.error('Error loading organizations:', error);
    }
  };

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

  const loadAllMappingsForOrg = async (orgId) => {
    if (!orgId) return;

    try {
      const userMappingData = await invoke('getUserMappings', { orgId });
      if (userMappingData && userMappingData.mappings) {
        setUserMappings(userMappingData.mappings);
      }

      const fieldMappingData = await invoke('getFieldMappings', { orgId });
      if (fieldMappingData) {
        setFieldMappings(fieldMappingData);
      }

      const statusMappingData = await invoke('getStatusMappings', { orgId });
      if (statusMappingData) {
        setStatusMappings(statusMappingData);
      }

      const syncOptionsData = await invoke('getSyncOptions', { orgId });
      if (syncOptionsData) {
        setSyncOptions(syncOptionsData);
      }
    } catch (error) {
      console.error('Error loading mappings:', error);
    }
  };

  const loadScheduledSyncConfig = async () => {
    try {
      const config = await invoke('getScheduledSyncConfig');
      if (config) {
        setScheduledSyncConfig(config);
      }
    } catch (error) {
      console.error('Error loading scheduled sync config:', error);
    }
  };

  const handleAddOrganization = async (data) => {
    setSaving(true);
    setMessage('');

    try {
      const result = await invoke('addOrganization', {
        name: data.name,
        remoteUrl: data.remoteUrl,
        remoteEmail: data.remoteEmail,
        remoteApiToken: data.remoteApiToken,
        remoteProjectKey: data.remoteProjectKey,
        allowedProjects: []
      });

      if (result.success) {
        setMessage(`Organization "${data.name}" added successfully!`);
        await loadOrganizations();
        setShowAddOrgForm(false);
        setSelectedOrgId(result.organization.id);
      } else {
        setMessage(`Error: ${result.error}`);
      }
      setTimeout(() => setMessage(''), 3000);
    } catch (error) {
      setMessage('Error adding organization: ' + error.message);
      setTimeout(() => setMessage(''), 3000);
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateOrganization = async (data) => {
    if (!editingOrg) return;

    setSaving(true);
    setMessage('');

    try {
      const result = await invoke('updateOrganization', {
        id: editingOrg.id,
        name: data.name,
        remoteUrl: data.remoteUrl,
        remoteEmail: data.remoteEmail,
        remoteApiToken: data.remoteApiToken,
        remoteProjectKey: data.remoteProjectKey,
        allowedProjects: editingOrg.allowedProjects || []
      });

      if (result.success) {
        setMessage(`Organization "${data.name}" updated successfully!`);
        await loadOrganizations();
        setEditingOrg(null);
      } else {
        setMessage(`Error: ${result.error}`);
      }
      setTimeout(() => setMessage(''), 3000);
    } catch (error) {
      setMessage('Error updating organization: ' + error.message);
      setTimeout(() => setMessage(''), 3000);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteOrganization = async (orgId) => {
    if (!confirm('Are you sure you want to delete this organization? Mappings will be preserved.')) {
      return;
    }

    setSaving(true);
    setMessage('');

    try {
      const result = await invoke('deleteOrganization', { id: orgId });
      if (result.success) {
        setMessage('Organization deleted successfully!');
        await loadOrganizations();
        if (selectedOrgId === orgId) {
          setSelectedOrgId(organizations[0]?.id || null);
        }
      } else {
        setMessage(`Error: ${result.error}`);
      }
      setTimeout(() => setMessage(''), 3000);
    } catch (error) {
      setMessage('Error deleting organization: ' + error.message);
      setTimeout(() => setMessage(''), 3000);
    } finally {
      setSaving(false);
    }
  };

  const loadRemoteData = async () => {
    if (!selectedOrgId) {
      setMessage('Please select an organization first');
      setTimeout(() => setMessage(''), 3000);
      return;
    }

    const selectedOrg = organizations.find(o => o.id === selectedOrgId);
    if (!selectedOrg || !selectedOrg.remoteUrl || !selectedOrg.remoteEmail || !selectedOrg.remoteApiToken || !selectedOrg.remoteProjectKey) {
      setMessage('Please configure the selected organization first');
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
      setDataLoaded(prev => ({ ...prev, remote: true }));
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
      setDataLoaded(prev => ({ ...prev, local: true }));
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
    if (!selectedOrgId) return;

    setOrganizations(orgs => {
      return orgs.map(org => {
        if (org.id !== selectedOrgId) return org;

        const currentProjects = org.allowedProjects || [];
        const isSelected = currentProjects.includes(projectKey);
        const newProjects = isSelected
          ? currentProjects.filter(p => p !== projectKey)
          : [...currentProjects, projectKey];

        return {
          ...org,
          allowedProjects: newProjects
        };
      });
    });
  };

  const handleSaveProjectFilter = async () => {
    if (!selectedOrgId) return;

    const selectedOrg = organizations.find(o => o.id === selectedOrgId);
    if (!selectedOrg) return;

    setSaving(true);
    setMessage('');
    try {
      const result = await invoke('updateOrganization', {
        id: selectedOrg.id,
        name: selectedOrg.name,
        remoteUrl: selectedOrg.remoteUrl,
        remoteEmail: selectedOrg.remoteEmail,
        remoteApiToken: selectedOrg.remoteApiToken,
        remoteProjectKey: selectedOrg.remoteProjectKey,
        allowedProjects: selectedOrg.allowedProjects || []
      });

      if (result.success) {
        setMessage('Project filter saved successfully!');
      } else {
        setMessage(`Error: ${result.error}`);
      }
    } catch (error) {
      setMessage('Error saving project filter: ' + error.message);
    } finally {
      setSaving(false);
      setTimeout(() => setMessage(''), 3000);
    }
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

  const handleManualSync = async () => {
    if (!manualIssueKey.trim()) {
      setMessage('Please enter an issue key');
      setTimeout(() => setMessage(''), 3000);
      return;
    }

    setManualSyncLoading(true);
    setMessage('');

    try {
      const result = await invoke('forceSyncIssue', { issueKey: manualIssueKey.trim() });
      if (result.success) {
        setMessage(result.message);
        setManualIssueKey('');
        await loadSyncStats();
      } else {
        setMessage(`Error: ${result.error}`);
      }
      setTimeout(() => setMessage(''), 5000);
    } catch (error) {
      console.error('Error during manual sync:', error);
      setMessage('Error: ' + error.message);
      setTimeout(() => setMessage(''), 5000);
    } finally {
      setManualSyncLoading(false);
    }
  };

  const handleSaveUserMappings = async () => {
    if (!selectedOrgId) {
      setMessage('Please select an organization');
      setTimeout(() => setMessage(''), 3000);
      return;
    }

    setSaving(true);
    setMessage('');
    try {
      await invoke('saveUserMappings', {
        orgId: selectedOrgId,
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
    if (!selectedOrgId) {
      setMessage('Please select an organization');
      setTimeout(() => setMessage(''), 3000);
      return;
    }

    setSaving(true);
    setMessage('');
    try {
      await invoke('saveFieldMappings', {
        orgId: selectedOrgId,
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
    if (!selectedOrgId) {
      setMessage('Please select an organization');
      setTimeout(() => setMessage(''), 3000);
      return;
    }

    setSaving(true);
    setMessage('');
    try {
      await invoke('saveStatusMappings', {
        orgId: selectedOrgId,
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

  const handleSaveSyncOptions = async () => {
    if (!selectedOrgId) {
      setMessage('Please select an organization');
      setTimeout(() => setMessage(''), 3000);
      return;
    }

    setSaving(true);
    setMessage('');
    try {
      const result = await invoke('saveSyncOptions', { orgId: selectedOrgId, options: syncOptions });
      if (result.success) {
        setMessage('Sync options saved successfully!');
      } else {
        setMessage(`Error: ${result.error}`);
      }
      setTimeout(() => setMessage(''), 3000);
    } catch (error) {
      console.error('Error saving sync options:', error);
      setMessage('Error: ' + error.message);
      setTimeout(() => setMessage(''), 3000);
    } finally {
      setSaving(false);
    }
  };

  const handleRetryPendingLinks = async () => {
    setPendingLinksLoading(true);
    setMessage('');

    try {
      const result = await invoke('retryPendingLinks');
      if (result.success) {
        setMessage(result.message);
        await loadSyncStats();
      } else {
        setMessage(`Error: ${result.error}`);
      }
      setTimeout(() => setMessage(''), 5000);
    } catch (error) {
      console.error('Error retrying pending links:', error);
      setMessage('Error: ' + error.message);
      setTimeout(() => setMessage(''), 5000);
    } finally {
      setPendingLinksLoading(false);
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

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '200px' }}>
        <Spinner size="large" />
      </div>
    );
  }

  const selectedOrg = organizations.find(o => o.id === selectedOrgId);

  return (
    <div style={{ padding: '20px' }}>
      <h1>Multi-Organization Sync Connector</h1>
      <p>Configure multiple target Jira organizations to sync from this instance (Org A → Org B, C, D...)</p>

      {message && (
        <SectionMessage 
          appearance={message.includes('Error') || message.includes('❌') ? 'error' : 'success'}
        >
          <p style={{ whiteSpace: 'pre-line' }}>{message}</p>
        </SectionMessage>
      )}

      <div style={{ marginTop: '20px', padding: '16px', background: '#deebff', borderRadius: '3px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label style={{ fontWeight: 600, marginRight: '10px', display: 'block', marginBottom: '8px' }}>Selected Organization:</label>
            <Select
              inputId="org-select"
              className="single-select"
              classNamePrefix="react-select"
              options={organizations.map(org => ({
                label: `${org.name} (${org.remoteUrl})`,
                value: org.id
              }))}
              value={selectedOrg ? { label: `${selectedOrg.name} (${selectedOrg.remoteUrl})`, value: selectedOrg.id } : null}
              onChange={(option) => setSelectedOrgId(option?.value || null)}
              placeholder="-- Select Organization --"
              isClearable
            />
          </div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            {selectedOrg && (
              <>
                <Button appearance="default" onClick={() => setEditingOrg(selectedOrg)}>
                  Edit
                </Button>
                <Button appearance="danger" onClick={() => handleDeleteOrganization(selectedOrgId)}>
                  Delete
                </Button>
              </>
            )}
            <Button appearance="primary" onClick={() => setShowAddOrgForm(true)}>
              Add Organization
            </Button>
          </div>
        </div>

        {selectedOrg && (
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', paddingTop: '12px', marginTop: '12px', borderTop: '1px solid #0052CC', flexWrap: 'wrap' }}>
            <Button appearance="primary" onClick={loadRemoteData} isLoading={dataLoading}>
              Load Remote Data
            </Button>
            {dataLoaded.remote && <span style={{ color: '#00875A', fontSize: '14px', fontWeight: 600 }}>✓ Loaded</span>}
            
            <Button appearance="primary" onClick={loadLocalData} isLoading={dataLoading}>
              Load Local Data
            </Button>
            {dataLoaded.local && <span style={{ color: '#00875A', fontSize: '14px', fontWeight: 600 }}>✓ Loaded</span>}
          </div>
        )}
      </div>

      {(showAddOrgForm || editingOrg) && (
        <div style={{ ...sectionStyle, background: '#fffae6', border: '2px solid #FF991F' }}>
          <h3>{editingOrg ? `Edit Organization: ${editingOrg.name}` : 'Add New Organization'}</h3>
          <Form onSubmit={editingOrg ? handleUpdateOrganization : handleAddOrganization}>
            {({ formProps }) => (
              <form {...formProps}>
                <Field
                  name="name"
                  defaultValue={editingOrg?.name || ''}
                  isRequired
                  label="Organization Name"
                >
                  {({ fieldProps }) => (
                    <TextField {...fieldProps} placeholder="e.g., Production Org, Staging Org" />
                  )}
                </Field>
                <Field
                  name="remoteUrl"
                  defaultValue={editingOrg?.remoteUrl || ''}
                  isRequired
                  label="Remote Jira URL"
                >
                  {({ fieldProps }) => (
                    <TextField {...fieldProps} placeholder="https://yourorg.atlassian.net" />
                  )}
                </Field>
                <Field
                  name="remoteEmail"
                  defaultValue={editingOrg?.remoteEmail || ''}
                  isRequired
                  label="Remote Admin Email"
                >
                  {({ fieldProps }) => (
                    <TextField {...fieldProps} placeholder="admin@example.com" />
                  )}
                </Field>
                <Field
                  name="remoteApiToken"
                  defaultValue={editingOrg?.remoteApiToken || ''}
                  isRequired
                  label="Remote API Token"
                >
                  {({ fieldProps }) => (
                    <TextField {...fieldProps} type="password" placeholder="API token" />
                  )}
                </Field>
                <Field
                  name="remoteProjectKey"
                  defaultValue={editingOrg?.remoteProjectKey || ''}
                  isRequired
                  label="Remote Project Key"
                >
                  {({ fieldProps }) => (
                    <TextField {...fieldProps} placeholder="PROJ" />
                  )}
                </Field>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <Button type="submit" appearance="primary" isLoading={saving}>
                    {editingOrg ? 'Update Organization' : 'Add Organization'}
                  </Button>
                  <Button
                    appearance="subtle"
                    onClick={() => {
                      setShowAddOrgForm(false);
                      setEditingOrg(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}
          </Form>
        </div>
      )}

      {!selectedOrgId && organizations.length === 0 && !showAddOrgForm && (
        <div style={{ marginTop: '20px', padding: '20px', background: '#fff4e6', borderRadius: '3px', textAlign: 'center' }}>
          <h3>Welcome! Get Started</h3>
          <p>You haven't configured any organizations yet. Click "Add Organization" above to get started.</p>
        </div>
      )}

      {selectedOrgId && selectedOrg && (
        <>
          <Tabs id="admin-tabs" style={{ marginTop: '30px' }}>
            <TabList>
              <Tab>Project Filter</Tab>
              <Tab>Mappings</Tab>
              <Tab>Sync Controls</Tab>
              <Tab>Health & Stats</Tab>
            </TabList>

            <TabPanel>
              <div style={{ padding: '20px', background: 'white', borderRadius: '3px', border: '1px solid #dfe1e6', marginTop: '16px' }}>
                <h3>Project Filter for {selectedOrg.name} ({selectedOrg.allowedProjects?.length || 0} selected)</h3>
                <p style={{ marginBottom: '16px', color: '#6B778C' }}>
                  Select which projects to sync to {selectedOrg.name}. If no projects are selected, all projects will be synced.
                </p>

                <Button appearance="primary" onClick={loadLocalProjects} isLoading={dataLoading} style={{ marginBottom: '16px' }}>
                  Load Projects
                </Button>

                {localProjects.length > 0 && (
                  <>
                    <h4>Available Projects</h4>
                    <div style={{ marginBottom: '16px' }}>
                      {localProjects.map(project => {
                        const isSelected = selectedOrg.allowedProjects?.includes(project.key);
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
              </div>
            </TabPanel>

            <TabPanel>
              {!dataLoaded.remote || !dataLoaded.local ? (
                <SectionMessage 
                  appearance="warning" 
                  title="Data Not Loaded"
                  style={{ marginTop: '16px' }}
                >
                  <p>Please load both Remote and Local data first before creating mappings.</p>
                  <p style={{ fontSize: '13px', color: '#6B778C' }}>
                    Missing: {!dataLoaded.remote && 'Remote Data'} {!dataLoaded.remote && !dataLoaded.local && ' & '} {!dataLoaded.local && 'Local Data'}
                  </p>
                  <p style={{ fontSize: '13px', color: '#6B778C', marginTop: '12px' }}>
                    Use the "Load Remote Data" and "Load Local Data" buttons in the organization selector above.
                  </p>
                </SectionMessage>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', marginTop: '16px' }}>
                  {/* User Mappings Section */}
                  <div style={{ padding: '20px', background: 'white', borderRadius: '3px', border: '1px solid #dfe1e6', width: '100%' }}>
                    <div 
                      style={{
                        ...collapsibleHeaderStyle,
                        borderBottom: expandedSections.users ? '1px solid #DFE1E6' : 'none',
                        marginBottom: expandedSections.users ? '16px' : 0,
                        marginTop: 0
                      }}
                      onClick={() => toggleSection('users')}
                    >
                      <h3 style={{ margin: 0 }}>User Mapping ({Object.keys(userMappings).length})</h3>
                      <span style={{ fontSize: '18px' }}>{expandedSections.users ? '▼' : '▶'}</span>
                    </div>
                    
                    {expandedSections.users && (
                      <div>
                        <h4>Add User Mapping</h4>
                        <div style={{ marginBottom: '16px' }}>
                          <label style={{ display: 'block', marginBottom: '4px', fontWeight: 600 }}>
                            Remote User ({selectedOrg.name})
                          </label>
                          <Select
                            options={remoteUsers.map(user => ({
                              label: `${user.displayName}${user.emailAddress ? ` (${user.emailAddress})` : ''}`,
                              value: user.accountId
                            }))}
                            value={remoteUsers.find(u => u.accountId === newUserRemote) ? {
                              label: `${remoteUsers.find(u => u.accountId === newUserRemote).displayName}`,
                              value: newUserRemote
                            } : null}
                            onChange={(option) => setNewUserRemote(option?.value || '')}
                            placeholder={remoteUsers.length === 0 ? 'Load remote data first' : 'Select remote user...'}
                            isClearable
                            styles={{ container: base => ({ ...base, marginBottom: '10px' }) }}
                          />

                          <label style={{ display: 'block', marginBottom: '4px', fontWeight: 600 }}>
                            Local User
                          </label>
                          <Select
                            options={localUsers.map(user => ({
                              label: `${user.displayName}${user.emailAddress ? ` (${user.emailAddress})` : ''}`,
                              value: user.accountId
                            }))}
                            value={localUsers.find(u => u.accountId === newUserLocal) ? {
                              label: `${localUsers.find(u => u.accountId === newUserLocal).displayName}`,
                              value: newUserLocal
                            } : null}
                            onChange={(option) => setNewUserLocal(option?.value || '')}
                            placeholder={localUsers.length === 0 ? 'Load local data first' : 'Select local user...'}
                            isClearable
                            styles={{ container: base => ({ ...base, marginBottom: '10px' }) }}
                          />

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

                  {/* Field Mappings Section */}
                  <div style={{ padding: '20px', background: 'white', borderRadius: '3px', border: '1px solid #dfe1e6', width: '100%' }}>
                    <div 
                      style={{
                        ...collapsibleHeaderStyle,
                        borderBottom: expandedSections.fields ? '1px solid #DFE1E6' : 'none',
                        marginBottom: expandedSections.fields ? '16px' : 0,
                        marginTop: 0
                      }}
                      onClick={() => toggleSection('fields')}
                    >
                      <h3 style={{ margin: 0 }}>Field Mapping ({Object.keys(fieldMappings).length})</h3>
                      <span style={{ fontSize: '18px' }}>{expandedSections.fields ? '▼' : '▶'}</span>
                    </div>
                    
                    {expandedSections.fields && (
                      <div>
                        <h4>Add Field Mapping</h4>
                        <div style={{ marginBottom: '16px' }}>
                          <label style={{ display: 'block', marginBottom: '4px', fontWeight: 600 }}>
                            Remote Field
                          </label>
                          <Select
                            options={remoteFields.map(field => ({
                              label: `${field.name} (${field.id})`,
                              value: field.id
                            }))}
                            value={remoteFields.find(f => f.id === newFieldRemote) ? {
                              label: `${remoteFields.find(f => f.id === newFieldRemote).name}`,
                              value: newFieldRemote
                            } : null}
                            onChange={(option) => setNewFieldRemote(option?.value || '')}
                            placeholder={remoteFields.length === 0 ? 'Load remote data first' : 'Select remote field...'}
                            isClearable
                            styles={{ container: base => ({ ...base, marginBottom: '10px' }) }}
                          />

                          <label style={{ display: 'block', marginBottom: '4px', fontWeight: 600 }}>
                            Local Field
                          </label>
                          <Select
                            options={localFields.map(field => ({
                              label: `${field.name} (${field.id})`,
                              value: field.id
                            }))}
                            value={localFields.find(f => f.id === newFieldLocal) ? {
                              label: `${localFields.find(f => f.id === newFieldLocal).name}`,
                              value: newFieldLocal
                            } : null}
                            onChange={(option) => setNewFieldLocal(option?.value || '')}
                            placeholder={localFields.length === 0 ? 'Load local data first' : 'Select local field...'}
                            isClearable
                            styles={{ container: base => ({ ...base, marginBottom: '10px' }) }}
                          />

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

                  {/* Status Mappings Section */}
                  <div style={{ padding: '20px', background: 'white', borderRadius: '3px', border: '1px solid #dfe1e6', width: '100%' }}>
                    <div 
                      style={{
                        ...collapsibleHeaderStyle,
                        borderBottom: expandedSections.statuses ? '1px solid #DFE1E6' : 'none',
                        marginBottom: expandedSections.statuses ? '16px' : 0,
                        marginTop: 0
                      }}
                      onClick={() => toggleSection('statuses')}
                    >
                      <h3 style={{ margin: 0 }}>Status Mapping ({Object.keys(statusMappings).length})</h3>
                      <span style={{ fontSize: '18px' }}>{expandedSections.statuses ? '▼' : '▶'}</span>
                    </div>
                    
                    {expandedSections.statuses && (
                      <div>
                        <h4>Add Status Mapping</h4>
                        <div style={{ marginBottom: '16px' }}>
                          <label style={{ display: 'block', marginBottom: '4px', fontWeight: 600 }}>
                            Remote Status
                          </label>
                          <Select
                            options={remoteStatuses.map(status => ({
                              label: status.name,
                              value: status.id
                            }))}
                            value={remoteStatuses.find(s => s.id === newStatusRemote) ? {
                              label: remoteStatuses.find(s => s.id === newStatusRemote).name,
                              value: newStatusRemote
                            } : null}
                            onChange={(option) => setNewStatusRemote(option?.value || '')}
                            placeholder={remoteStatuses.length === 0 ? 'Load remote data first' : 'Select remote status...'}
                            isClearable
                            styles={{ container: base => ({ ...base, marginBottom: '10px' }) }}
                          />

                          <label style={{ display: 'block', marginBottom: '4px', fontWeight: 600 }}>
                            Local Status
                          </label>
                          <Select
                            options={localStatuses.map(status => ({
                              label: status.name,
                              value: status.id
                            }))}
                            value={localStatuses.find(s => s.id === newStatusLocal) ? {
                              label: localStatuses.find(s => s.id === newStatusLocal).name,
                              value: newStatusLocal
                            } : null}
                            onChange={(option) => setNewStatusLocal(option?.value || '')}
                            placeholder={localStatuses.length === 0 ? 'Load local data first' : 'Select local status...'}
                            isClearable
                            styles={{ container: base => ({ ...base, marginBottom: '10px' }) }}
                          />

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
              )}
            </TabPanel>

            {/* ...existing Sync Controls and Health & Stats tabs remain the same... */}
            <TabPanel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', marginTop: '16px' }}>
                <div style={{ padding: '20px', background: 'white', borderRadius: '3px', border: '1px solid #dfe1e6', width: '100%' }}>
                  <h3>Sync Options for {selectedOrg.name}</h3>
                  <p style={{ marginBottom: '16px', color: '#6B778C' }}>
                    Choose which types of data to sync to {selectedOrg.name}.
                  </p>

                  <div style={{ padding: '16px', background: '#f4f5f7', borderRadius: '3px', marginBottom: '16px' }}>
                    <div style={{ marginBottom: '12px' }}>
                      <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={syncOptions.syncComments}
                          onChange={(e) => setSyncOptions({ ...syncOptions, syncComments: e.target.checked })}
                          style={{ marginRight: '8px', width: '16px', height: '16px', cursor: 'pointer' }}
                        />
                        <span style={{ fontSize: '14px', fontWeight: '500' }}>Sync Comments</span>
                      </label>
                    </div>

                    <div style={{ marginBottom: '12px' }}>
                      <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={syncOptions.syncAttachments}
                          onChange={(e) => setSyncOptions({ ...syncOptions, syncAttachments: e.target.checked })}
                          style={{ marginRight: '8px', width: '16px', height: '16px', cursor: 'pointer' }}
                        />
                        <span style={{ fontSize: '14px', fontWeight: '500' }}>Sync Attachments</span>
                      </label>
                    </div>

                    <div style={{ marginBottom: '12px' }}>
                      <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={syncOptions.syncLinks}
                          onChange={(e) => setSyncOptions({ ...syncOptions, syncLinks: e.target.checked })}
                          style={{ marginRight: '8px', width: '16px', height: '16px', cursor: 'pointer' }}
                        />
                        <span style={{ fontSize: '14px', fontWeight: '500' }}>Sync Issue Links</span>
                      </label>
                    </div>

                    <div style={{ marginBottom: '12px' }}>
                      <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={syncOptions.syncSprints}
                          onChange={(e) => setSyncOptions({ ...syncOptions, syncSprints: e.target.checked })}
                          style={{ marginRight: '8px', width: '16px', height: '16px', cursor: 'pointer' }}
                        />
                        <span style={{ fontSize: '14px', fontWeight: '500' }}>Sync Sprints</span>
                      </label>
                    </div>
                  </div>

                  <Button appearance="primary" onClick={handleSaveSyncOptions} isLoading={saving}>
                    Save Sync Options
                  </Button>
                </div>

                <div style={{ padding: '20px', background: 'white', borderRadius: '3px', border: '1px solid #dfe1e6', width: '100%' }}>
                  <h3>Manual Sync Controls</h3>
                  <p style={{ marginBottom: '16px', color: '#6B778C' }}>
                    Manually trigger sync for a specific issue (will sync to ALL configured organizations).
                  </p>

                  <div style={{ marginBottom: '20px', padding: '16px', background: '#f4f5f7', borderRadius: '3px' }}>
                    <h4 style={{ marginTop: 0, marginBottom: '12px', color: '#172B4D' }}>Sync Specific Issue</h4>
                    <p style={{ fontSize: '13px', color: '#6B778C', marginBottom: '12px' }}>
                      Enter an issue key to force sync to all {organizations.length} organization(s):
                    </p>

                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        type="text"
                        value={manualIssueKey}
                        onChange={(e) => setManualIssueKey(e.target.value)}
                        onKeyPress={(e) => {
                          if (e.key === 'Enter') {
                            handleManualSync();
                          }
                        }}
                        placeholder="e.g., PROJ-123"
                        style={{
                          padding: '8px 12px',
                          border: '2px solid #DFE1E6',
                          borderRadius: '3px',
                          fontSize: '14px',
                          flex: '1',
                          minWidth: '200px'
                        }}
                      />
                      <Button
                        appearance="primary"
                        onClick={handleManualSync}
                        isLoading={manualSyncLoading}
                        isDisabled={!manualIssueKey.trim()}
                      >
                        Sync Now
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </TabPanel>

            <TabPanel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', marginTop: '16px' }}>
                <div style={{ padding: '20px', background: 'white', borderRadius: '3px', border: '1px solid #dfe1e6', width: '100%' }}>
                  <h3>Sync Health & Statistics</h3>
                  <p style={{ marginBottom: '16px', color: '#6B778C' }}>
                    View synchronization statistics across all organizations.
                  </p>

                  <Button appearance="primary" onClick={loadSyncStats} isLoading={statsLoading} style={{ marginBottom: '16px' }}>
                    Refresh Stats
                  </Button>

                  {webhookStats && (
                    <div style={{ padding: '16px', background: '#f4f5f7', borderRadius: '3px', marginBottom: '16px' }}>
                      <h4 style={{ marginTop: 0 }}>Webhook Sync Statistics</h4>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '16px' }}>
                        <div>
                          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#0052CC' }}>{webhookStats.totalSyncs || 0}</div>
                          <div style={{ fontSize: '12px', color: '#6B778C' }}>Total Syncs</div>
                        </div>
                        <div>
                          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#00875A' }}>{webhookStats.issuesCreated || 0}</div>
                          <div style={{ fontSize: '12px', color: '#6B778C' }}>Issues Created</div>
                        </div>
                        <div>
                          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#0052CC' }}>{webhookStats.issuesUpdated || 0}</div>
                          <div style={{ fontSize: '12px', color: '#6B778C' }}>Issues Updated</div>
                        </div>
                        <div>
                          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#403294' }}>{webhookStats.commentsSynced || 0}</div>
                          <div style={{ fontSize: '12px', color: '#6B778C' }}>Comments Synced</div>
                        </div>
                        <div>
                          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#FF991F' }}>{webhookStats.issuesSkipped || 0}</div>
                          <div style={{ fontSize: '12px', color: '#6B778C' }}>Issues Skipped</div>
                        </div>
                      </div>
                      
                      {webhookStats.lastSync && (
                        <p style={{ fontSize: '12px', color: '#6B778C', margin: 0 }}>
                          Last sync: {new Date(webhookStats.lastSync).toLocaleString()}
                        </p>
                      )}

                      {webhookStats.byOrg && Object.keys(webhookStats.byOrg).length > 0 && (
                        <div style={{ marginTop: '16px' }}>
                          <h5 style={{ marginBottom: '8px' }}>Stats by Organization:</h5>
                          {Object.entries(webhookStats.byOrg).map(([orgId, orgStats]) => {
                            const org = organizations.find(o => o.id === orgId);
                            return (
                              <div key={orgId} style={{ padding: '8px', background: '#fff', borderRadius: '3px', marginBottom: '8px' }}>
                                <strong>{org?.name || orgId}</strong>: {orgStats.totalSyncs} syncs 
                                ({orgStats.issuesCreated} created, {orgStats.issuesUpdated} updated)
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {webhookStats.errors && webhookStats.errors.length > 0 && (
                        <div style={{ marginTop: '16px' }}>
                          <h5 style={{ color: '#DE350B' }}>Recent Errors ({webhookStats.errors.length}):</h5>
                          <div style={{ maxHeight: '200px', overflow: 'auto' }}>
                            {webhookStats.errors.slice(0, 10).map((err, idx) => (
                              <div key={idx} style={{ padding: '8px', background: '#FFEBE6', borderRadius: '3px', marginBottom: '4px', fontSize: '12px' }}>
                                <div><strong>{new Date(err.timestamp).toLocaleString()}</strong></div>
                                <div>{err.error}</div>
                                {err.orgId && <div style={{ color: '#6B778C' }}>Org: {err.orgId}</div>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {scheduledStats && (
                    <div style={{ padding: '16px', background: '#f4f5f7', borderRadius: '3px', marginBottom: '16px' }}>
                      <h4 style={{ marginTop: 0 }}>Scheduled Sync Statistics</h4>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '16px' }}>
                        <div>
                          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#0052CC' }}>{scheduledStats.issuesChecked || 0}</div>
                          <div style={{ fontSize: '12px', color: '#6B778C' }}>Issues Checked</div>
                        </div>
                        <div>
                          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#00875A' }}>{scheduledStats.issuesCreated || 0}</div>
                          <div style={{ fontSize: '12px', color: '#6B778C' }}>Issues Created</div>
                        </div>
                        <div>
                          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#0052CC' }}>{scheduledStats.issuesUpdated || 0}</div>
                          <div style={{ fontSize: '12px', color: '#6B778C' }}>Issues Updated</div>
                        </div>
                        <div>
                          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#FF991F' }}>{scheduledStats.issuesSkipped || 0}</div>
                          <div style={{ fontSize: '12px', color: '#6B778C' }}>Issues Skipped</div>
                        </div>
                      </div>
                      
                      {scheduledStats.lastRun && (
                        <p style={{ fontSize: '12px', color: '#6B778C', margin: 0 }}>
                          Last run: {new Date(scheduledStats.lastRun).toLocaleString()}
                        </p>
                      )}

                      {scheduledStats.errors && scheduledStats.errors.length > 0 && (
                        <div style={{ marginTop: '16px' }}>
                          <h5 style={{ color: '#DE350B' }}>Recent Errors ({scheduledStats.errors.length}):</h5>
                          <div style={{ maxHeight: '200px', overflow: 'auto' }}>
                            {scheduledStats.errors.slice(0, 10).map((err, idx) => (
                              <div key={idx} style={{ padding: '8px', background: '#FFEBE6', borderRadius: '3px', marginBottom: '4px', fontSize: '12px' }}>
                                {err}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div style={{ padding: '16px', background: '#E3FCEF', borderRadius: '3px', border: '2px solid #00875A', width: '100%' }}>
                  <h4 style={{ marginTop: 0, color: '#00875A' }}>Pending Link Sync</h4>
                  <p style={{ fontSize: '13px', color: '#006644', marginBottom: '12px' }}>
                    When an issue is synced but its linked issues haven't been synced yet, the links are stored as "pending". 
                    Use this button to retry syncing all pending links across all organizations.
                  </p>
                  <p style={{ fontSize: '13px', color: '#006644', marginBottom: '12px' }}>
                    Tip: Scheduled sync runs every hour and automatically retries pending links. 
                    Or you can manually trigger it here.
                  </p>
                  <Button 
                    appearance="primary" 
                    onClick={handleRetryPendingLinks} 
                    isLoading={pendingLinksLoading}
                  >
                    Retry All Pending Links
                  </Button>
                </div>

                <div style={{ padding: '16px', background: '#DEEBFF', borderRadius: '3px', width: '100%' }}>
                  <p style={{ margin: 0, fontSize: '13px', color: '#0747A6' }}>
                    <strong>Note:</strong> Statistics tracking across {organizations.length} organization(s). 
                    Scheduled sync runs every hour. You can view detailed logs with: <code>forge logs</code>
                  </p>
                </div>
              </div>
            </TabPanel>
          </Tabs>
        </>
      )}
    </div>
  );
}

render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>, 
  document.getElementById('root')
);