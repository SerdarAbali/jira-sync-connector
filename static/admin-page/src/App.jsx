import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
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

const App = () => {
  const [organizations, setOrganizations] = useState([]);
  const [selectedOrgId, setSelectedOrgId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  // Add/Edit org modal state
  const [showOrgModal, setShowOrgModal] = useState(false);
  const [editingOrg, setEditingOrg] = useState(null);

  // Auto-loaded data
  const [remoteUsers, setRemoteUsers] = useState([]);
  const [localUsers, setLocalUsers] = useState([]);
  const [remoteFields, setRemoteFields] = useState([]);
  const [localFields, setLocalFields] = useState([]);
  const [remoteStatuses, setRemoteStatuses] = useState([]);
  const [localStatuses, setLocalStatuses] = useState([]);
  const [localProjects, setLocalProjects] = useState([]);

  // Mappings
  const [userMappings, setUserMappings] = useState({});
  const [fieldMappings, setFieldMappings] = useState({});
  const [statusMappings, setStatusMappings] = useState({});

  // Sync options
  const [syncOptions, setSyncOptions] = useState({
    syncComments: true,
    syncAttachments: true,
    syncLinks: true,
    syncSprints: false
  });

  // Stats
  const [syncStats, setSyncStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);

  // Manual sync
  const [manualIssueKey, setManualIssueKey] = useState('');
  const [manualSyncLoading, setManualSyncLoading] = useState(false);

  // Data loading states
  const [dataLoading, setDataLoading] = useState({
    projects: false,
    users: false,
    fields: false,
    statuses: false
  });

  useEffect(() => {
    loadOrganizations();
  }, []);

  useEffect(() => {
    if (selectedOrgId) {
      loadOrgData(selectedOrgId);
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
    } finally {
      setLoading(false);
    }
  };

  const loadOrgData = async (orgId) => {
    try {
      // Load mappings
      const [userMappingData, fieldMappingData, statusMappingData, syncOptionsData] = await Promise.all([
        invoke('getUserMappings', { orgId }),
        invoke('getFieldMappings', { orgId }),
        invoke('getStatusMappings', { orgId }),
        invoke('getSyncOptions', { orgId })
      ]);

      if (userMappingData?.mappings) setUserMappings(userMappingData.mappings);
      if (fieldMappingData) setFieldMappings(fieldMappingData);
      if (statusMappingData) setStatusMappings(statusMappingData);
      if (syncOptionsData) setSyncOptions(syncOptionsData);
    } catch (error) {
      console.error('Error loading org data:', error);
    }
  };

  const loadProjects = async () => {
    if (localProjects.length > 0) return;
    setDataLoading(prev => ({ ...prev, projects: true }));
    try {
      const data = await invoke('fetchLocalProjects');
      if (data.projects) setLocalProjects(data.projects);
    } catch (error) {
      showMessage('Error loading projects: ' + error.message, 'error');
    } finally {
      setDataLoading(prev => ({ ...prev, projects: false }));
    }
  };

  const loadMappingData = async () => {
    if (!selectedOrgId) return;
    const selectedOrg = organizations.find(o => o.id === selectedOrgId);
    if (!selectedOrg?.remoteUrl) {
      showMessage('Please configure the organization first', 'error');
      return;
    }

    setDataLoading(prev => ({ ...prev, users: true, fields: true, statuses: true }));

    try {
      const [remoteData, localData] = await Promise.all([
        invoke('fetchRemoteData', { orgId: selectedOrgId }),
        invoke('fetchLocalData', { orgId: selectedOrgId })
      ]);

      if (remoteData.users) setRemoteUsers(remoteData.users);
      if (remoteData.fields) setRemoteFields(remoteData.fields);
      if (remoteData.statuses) setRemoteStatuses(remoteData.statuses);

      if (localData.users) setLocalUsers(localData.users);
      if (localData.fields) setLocalFields(localData.fields);
      if (localData.statuses) setLocalStatuses(localData.statuses);

      showMessage('Mapping data loaded successfully', 'success');
    } catch (error) {
      showMessage('Error loading mapping data: ' + error.message, 'error');
    } finally {
      setDataLoading(prev => ({ ...prev, users: false, fields: false, statuses: false }));
    }
  };

  const loadStats = async () => {
    setStatsLoading(true);
    try {
      const [scheduled, webhook] = await Promise.all([
        invoke('getScheduledSyncStats'),
        invoke('getWebhookSyncStats')
      ]);
      setSyncStats({ scheduled, webhook });
    } catch (error) {
      showMessage('Error loading stats: ' + error.message, 'error');
    } finally {
      setStatsLoading(false);
    }
  };

  const showMessage = (msg, type = 'success') => {
    setMessage({ text: msg, type });
    setTimeout(() => setMessage(''), 5000);
  };

  const handleSaveOrg = async (data) => {
    setSaving(true);
    try {
      const result = editingOrg
        ? await invoke('updateOrganization', { id: editingOrg.id, ...data })
        : await invoke('addOrganization', { ...data, allowedProjects: [] });

      if (result.success) {
        showMessage(`Organization ${editingOrg ? 'updated' : 'added'} successfully`, 'success');
        await loadOrganizations();
        setShowOrgModal(false);
        setEditingOrg(null);
        if (!editingOrg) setSelectedOrgId(result.organization.id);
      } else {
        showMessage(`Error: ${result.error}`, 'error');
      }
    } catch (error) {
      showMessage('Error saving organization: ' + error.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteOrg = async (orgId) => {
    if (!confirm('Delete this organization? Mappings will be preserved.')) return;

    setSaving(true);
    try {
      const result = await invoke('deleteOrganization', { id: orgId });
      if (result.success) {
        showMessage('Organization deleted successfully', 'success');
        await loadOrganizations();
        if (selectedOrgId === orgId) {
          setSelectedOrgId(organizations[0]?.id || null);
        }
      } else {
        showMessage(`Error: ${result.error}`, 'error');
      }
    } catch (error) {
      showMessage('Error deleting organization: ' + error.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleProjectSelection = (projectKey) => {
    if (!selectedOrgId) return;
    setOrganizations(orgs => orgs.map(org => {
      if (org.id !== selectedOrgId) return org;
      const currentProjects = org.allowedProjects || [];
      const isSelected = currentProjects.includes(projectKey);
      return {
        ...org,
        allowedProjects: isSelected
          ? currentProjects.filter(p => p !== projectKey)
          : [...currentProjects, projectKey]
      };
    }));
  };

  const handleSaveProjectFilter = async () => {
    if (!selectedOrgId) return;
    const selectedOrg = organizations.find(o => o.id === selectedOrgId);
    if (!selectedOrg) return;

    setSaving(true);
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
        showMessage('Project filter saved', 'success');
      } else {
        showMessage(`Error: ${result.error}`, 'error');
      }
    } catch (error) {
      showMessage('Error saving project filter: ' + error.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const addMapping = (type, remoteId, localId) => {
    if (!remoteId || !localId) return;

    const getItems = () => {
      switch(type) {
        case 'user': return { remote: remoteUsers, local: localUsers, setter: setUserMappings };
        case 'field': return { remote: remoteFields, local: localFields, setter: setFieldMappings };
        case 'status': return { remote: remoteStatuses, local: localStatuses, setter: setStatusMappings };
      }
    };

    const { remote, local, setter } = getItems();
    const remoteItem = remote.find(i => (i.accountId || i.id) === remoteId);
    const localItem = local.find(i => (i.accountId || i.id) === localId);

    setter(prev => ({
      ...prev,
      [remoteId]: {
        localId,
        remoteName: remoteItem?.displayName || remoteItem?.name || remoteId,
        localName: localItem?.displayName || localItem?.name || localId
      }
    }));
  };

  const deleteMapping = (type, remoteId) => {
    const setter = type === 'user' ? setUserMappings : type === 'field' ? setFieldMappings : setStatusMappings;
    setter(prev => {
      const updated = { ...prev };
      delete updated[remoteId];
      return updated;
    });
  };

  const handleSaveMappings = async (type) => {
    if (!selectedOrgId) return;

    setSaving(true);
    try {
      const mappings = type === 'user' ? userMappings : type === 'field' ? fieldMappings : statusMappings;
      const method = type === 'user' ? 'saveUserMappings' : type === 'field' ? 'saveFieldMappings' : 'saveStatusMappings';

      const payload = type === 'user'
        ? { orgId: selectedOrgId, mappings, config: { autoMapUsers: false, fallbackUser: 'unassigned' } }
        : { orgId: selectedOrgId, mappings };

      await invoke(method, payload);
      showMessage(`${type} mappings saved`, 'success');
    } catch (error) {
      showMessage(`Error saving ${type} mappings: ` + error.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSyncOptions = async () => {
    if (!selectedOrgId) return;

    setSaving(true);
    try {
      const result = await invoke('saveSyncOptions', { orgId: selectedOrgId, options: syncOptions });
      if (result.success) {
        showMessage('Sync options saved', 'success');
      } else {
        showMessage(`Error: ${result.error}`, 'error');
      }
    } catch (error) {
      showMessage('Error saving sync options: ' + error.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleManualSync = async () => {
    if (!manualIssueKey.trim()) return;

    setManualSyncLoading(true);
    try {
      const result = await invoke('forceSyncIssue', { issueKey: manualIssueKey.trim() });
      if (result.success) {
        showMessage(result.message, 'success');
        setManualIssueKey('');
        await loadStats();
      } else {
        showMessage(`Error: ${result.error}`, 'error');
      }
    } catch (error) {
      showMessage('Error: ' + error.message, 'error');
    } finally {
      setManualSyncLoading(false);
    }
  };

  const handleRetryPendingLinks = async () => {
    try {
      const result = await invoke('retryPendingLinks');
      if (result.success) {
        showMessage(result.message, 'success');
        await loadStats();
      } else {
        showMessage(`Error: ${result.error}`, 'error');
      }
    } catch (error) {
      showMessage('Error: ' + error.message, 'error');
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <Spinner size="large" />
      </div>
    );
  }

  const selectedOrg = organizations.find(o => o.id === selectedOrgId);

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {/* Sidebar */}
      <div style={{
        width: '280px',
        background: '#F4F5F7',
        borderRight: '2px solid #DFE1E6',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}>
        <div style={{ padding: '20px', borderBottom: '2px solid #DFE1E6' }}>
          <h3 style={{ margin: '0 0 8px 0', fontSize: '16px' }}>Organizations</h3>
          <Button
            appearance="primary"
            onClick={() => { setShowOrgModal(true); setEditingOrg(null); }}
            style={{ width: '100%' }}
          >
            + Add Organization
          </Button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
          {organizations.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: '#6B778C', fontSize: '13px' }}>
              No organizations yet. Add one to get started.
            </div>
          ) : (
            organizations.map(org => (
              <div
                key={org.id}
                onClick={() => setSelectedOrgId(org.id)}
                style={{
                  padding: '12px',
                  margin: '4px 0',
                  background: selectedOrgId === org.id ? '#DEEBFF' : 'white',
                  border: `2px solid ${selectedOrgId === org.id ? '#0052CC' : '#DFE1E6'}`,
                  borderRadius: '3px',
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
              >
                <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '4px' }}>
                  {org.name}
                </div>
                <div style={{ fontSize: '12px', color: '#6B778C', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {org.remoteUrl || 'Not configured'}
                </div>
                {org.allowedProjects && org.allowedProjects.length > 0 && (
                  <div style={{ fontSize: '11px', color: '#00875A', marginTop: '4px' }}>
                    {org.allowedProjects.length} project(s) filtered
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {message && (
          <div style={{ padding: '12px 20px', background: message.type === 'error' ? '#FFEBE6' : '#E3FCEF', borderBottom: '1px solid #DFE1E6' }}>
            <div style={{ color: message.type === 'error' ? '#DE350B' : '#00875A', fontSize: '14px' }}>
              {message.text}
            </div>
          </div>
        )}

        {!selectedOrgId ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px' }}>
            <div style={{ textAlign: 'center', maxWidth: '500px' }}>
              <h2>Welcome to Jira Sync Connector</h2>
              <p style={{ color: '#6B778C', marginBottom: '24px' }}>
                Configure multiple target Jira organizations to sync from this instance.
                Get started by adding your first organization.
              </p>
              <Button
                appearance="primary"
                onClick={() => { setShowOrgModal(true); setEditingOrg(null); }}
              >
                Add Your First Organization
              </Button>
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {/* Organization Header */}
            <div style={{ padding: '20px', borderBottom: '2px solid #DFE1E6', background: 'white' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <h2 style={{ margin: '0 0 8px 0' }}>{selectedOrg.name}</h2>
                  <div style={{ color: '#6B778C', fontSize: '14px' }}>
                    {selectedOrg.remoteUrl || 'Not configured'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <Button
                    appearance="default"
                    onClick={() => { setEditingOrg(selectedOrg); setShowOrgModal(true); }}
                  >
                    Edit
                  </Button>
                  <Button
                    appearance="danger"
                    onClick={() => handleDeleteOrg(selectedOrgId)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </div>

            {/* Tabs */}
            <Tabs id="org-tabs">
              <TabList>
                <Tab>Configuration</Tab>
                <Tab>Mappings</Tab>
                <Tab>Sync Activity</Tab>
              </TabList>

              {/* Configuration Tab */}
              <TabPanel>
                <div style={{ padding: '20px' }}>
                  <ConfigurationPanel
                    selectedOrg={selectedOrg}
                    localProjects={localProjects}
                    loadProjects={loadProjects}
                    dataLoading={dataLoading}
                    toggleProjectSelection={toggleProjectSelection}
                    handleSaveProjectFilter={handleSaveProjectFilter}
                    syncOptions={syncOptions}
                    setSyncOptions={setSyncOptions}
                    handleSaveSyncOptions={handleSaveSyncOptions}
                    saving={saving}
                  />
                </div>
              </TabPanel>

              {/* Mappings Tab */}
              <TabPanel>
                <div style={{ padding: '20px' }}>
                  <MappingsPanel
                    selectedOrg={selectedOrg}
                    remoteUsers={remoteUsers}
                    localUsers={localUsers}
                    remoteFields={remoteFields}
                    localFields={localFields}
                    remoteStatuses={remoteStatuses}
                    localStatuses={localStatuses}
                    userMappings={userMappings}
                    fieldMappings={fieldMappings}
                    statusMappings={statusMappings}
                    addMapping={addMapping}
                    deleteMapping={deleteMapping}
                    handleSaveMappings={handleSaveMappings}
                    loadMappingData={loadMappingData}
                    dataLoading={dataLoading}
                    saving={saving}
                  />
                </div>
              </TabPanel>

              {/* Sync Activity Tab */}
              <TabPanel>
                <div style={{ padding: '20px' }}>
                  <SyncActivityPanel
                    manualIssueKey={manualIssueKey}
                    setManualIssueKey={setManualIssueKey}
                    handleManualSync={handleManualSync}
                    manualSyncLoading={manualSyncLoading}
                    syncStats={syncStats}
                    loadStats={loadStats}
                    statsLoading={statsLoading}
                    handleRetryPendingLinks={handleRetryPendingLinks}
                    organizations={organizations}
                  />
                </div>
              </TabPanel>
            </Tabs>
          </div>
        )}
      </div>

      {/* Org Modal */}
      {showOrgModal && (
        <OrgModal
          editingOrg={editingOrg}
          onClose={() => { setShowOrgModal(false); setEditingOrg(null); }}
          onSave={handleSaveOrg}
          saving={saving}
        />
      )}
    </div>
  );
};

// Configuration Panel Component
const ConfigurationPanel = ({
  selectedOrg, localProjects, loadProjects, dataLoading,
  toggleProjectSelection, handleSaveProjectFilter, syncOptions,
  setSyncOptions, handleSaveSyncOptions, saving
}) => {
  const [projectsExpanded, setProjectsExpanded] = useState(false);

  return (
    <div style={{ maxWidth: '800px' }}>
      <h3>Configuration</h3>

      {/* Connection Info */}
      <div style={{ padding: '16px', background: '#F4F5F7', borderRadius: '3px', marginBottom: '20px' }}>
        <h4 style={{ margin: '0 0 12px 0' }}>Connection Settings</h4>
        <div style={{ fontSize: '13px', color: '#6B778C' }}>
          <div><strong>URL:</strong> {selectedOrg.remoteUrl}</div>
          <div><strong>Email:</strong> {selectedOrg.remoteEmail}</div>
          <div><strong>Project Key:</strong> {selectedOrg.remoteProjectKey}</div>
        </div>
      </div>

      {/* Project Filter */}
      <div style={{ padding: '16px', background: 'white', border: '1px solid #DFE1E6', borderRadius: '3px', marginBottom: '20px' }}>
        <div
          onClick={() => { setProjectsExpanded(!projectsExpanded); if (!projectsExpanded && localProjects.length === 0) loadProjects(); }}
          style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <h4 style={{ margin: 0 }}>Project Filter ({selectedOrg.allowedProjects?.length || 0} selected)</h4>
          <span>{projectsExpanded ? '▼' : '▶'}</span>
        </div>

        {projectsExpanded && (
          <div style={{ marginTop: '16px' }}>
            {dataLoading.projects ? (
              <div style={{ textAlign: 'center', padding: '20px' }}><Spinner /></div>
            ) : localProjects.length === 0 ? (
              <div style={{ color: '#6B778C', fontSize: '13px' }}>No projects loaded</div>
            ) : (
              <>
                {localProjects.map(project => {
                  const isSelected = selectedOrg.allowedProjects?.includes(project.key);
                  return (
                    <div
                      key={project.key}
                      onClick={() => toggleProjectSelection(project.key)}
                      style={{
                        padding: '8px 12px',
                        background: isSelected ? '#E3FCEF' : '#F4F5F7',
                        border: `2px solid ${isSelected ? '#00875A' : 'transparent'}`,
                        borderRadius: '3px',
                        marginBottom: '8px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        fontSize: '13px'
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        readOnly
                        style={{ marginRight: '8px', pointerEvents: 'none' }}
                      />
                      <strong>{project.key}</strong>&nbsp;- {project.name}
                    </div>
                  );
                })}
                <Button
                  appearance="primary"
                  onClick={handleSaveProjectFilter}
                  isLoading={saving}
                  style={{ marginTop: '12px' }}
                >
                  Save Project Filter
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Sync Options */}
      <div style={{ padding: '16px', background: 'white', border: '1px solid #DFE1E6', borderRadius: '3px' }}>
        <h4 style={{ margin: '0 0 16px 0' }}>Sync Options</h4>
        {[
          { key: 'syncComments', label: 'Sync Comments' },
          { key: 'syncAttachments', label: 'Sync Attachments' },
          { key: 'syncLinks', label: 'Sync Issue Links' },
          { key: 'syncSprints', label: 'Sync Sprints' }
        ].map(option => (
          <label key={option.key} style={{ display: 'flex', alignItems: 'center', marginBottom: '12px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={syncOptions[option.key]}
              onChange={(e) => setSyncOptions({ ...syncOptions, [option.key]: e.target.checked })}
              style={{ marginRight: '8px', cursor: 'pointer' }}
            />
            <span style={{ fontSize: '14px' }}>{option.label}</span>
          </label>
        ))}
        <Button
          appearance="primary"
          onClick={handleSaveSyncOptions}
          isLoading={saving}
          style={{ marginTop: '8px' }}
        >
          Save Sync Options
        </Button>
      </div>
    </div>
  );
};

// Mappings Panel Component
const MappingsPanel = ({
  selectedOrg, remoteUsers, localUsers, remoteFields, localFields,
  remoteStatuses, localStatuses, userMappings, fieldMappings, statusMappings,
  addMapping, deleteMapping, handleSaveMappings, loadMappingData, dataLoading, saving
}) => {
  const [newUserRemote, setNewUserRemote] = useState('');
  const [newUserLocal, setNewUserLocal] = useState('');
  const [newFieldRemote, setNewFieldRemote] = useState('');
  const [newFieldLocal, setNewFieldLocal] = useState('');
  const [newStatusRemote, setNewStatusRemote] = useState('');
  const [newStatusLocal, setNewStatusLocal] = useState('');

  const hasData = remoteUsers.length > 0 || localUsers.length > 0;
  const isLoading = dataLoading.users || dataLoading.fields || dataLoading.statuses;

  const MappingSection = ({ title, type, remotePlaceholder, localPlaceholder, remoteItems, localItems, mappings, newRemote, setNewRemote, newLocal, setNewLocal }) => {
    const itemKey = type === 'user' ? 'accountId' : 'id';
    const itemLabel = type === 'user' ? (item) => `${item.displayName}${item.emailAddress ? ` (${item.emailAddress})` : ''}` : (item) => `${item.name}`;

    return (
      <div style={{ padding: '16px', background: 'white', border: '1px solid #DFE1E6', borderRadius: '3px', marginBottom: '20px' }}>
        <h4 style={{ margin: '0 0 16px 0' }}>{title} ({Object.keys(mappings).length})</h4>

        {hasData && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '8px', marginBottom: '16px' }}>
              <Select
                options={remoteItems.map(item => ({ label: itemLabel(item), value: item[itemKey] }))}
                value={remoteItems.find(i => i[itemKey] === newRemote) ? { label: itemLabel(remoteItems.find(i => i[itemKey] === newRemote)), value: newRemote } : null}
                onChange={(option) => setNewRemote(option?.value || '')}
                placeholder={remotePlaceholder}
                isClearable
              />
              <Select
                options={localItems.map(item => ({ label: itemLabel(item), value: item[itemKey] }))}
                value={localItems.find(i => i[itemKey] === newLocal) ? { label: itemLabel(localItems.find(i => i[itemKey] === newLocal)), value: newLocal } : null}
                onChange={(option) => setNewLocal(option?.value || '')}
                placeholder={localPlaceholder}
                isClearable
              />
              <Button
                appearance="primary"
                onClick={() => { addMapping(type, newRemote, newLocal); setNewRemote(''); setNewLocal(''); }}
                isDisabled={!newRemote || !newLocal}
              >
                Add
              </Button>
            </div>

            <div style={{ marginBottom: '16px' }}>
              {Object.keys(mappings).length === 0 ? (
                <div style={{ color: '#6B778C', fontSize: '13px', fontStyle: 'italic' }}>No mappings yet</div>
              ) : (
                Object.entries(mappings).map(([remoteId, mapping]) => {
                  const localId = typeof mapping === 'string' ? mapping : mapping.localId;
                  const remoteName = typeof mapping === 'object' ? mapping.remoteName : remoteId;
                  const localName = typeof mapping === 'object' ? mapping.localName : localId;

                  return (
                    <div key={remoteId} style={{
                      padding: '8px 12px',
                      background: '#F4F5F7',
                      borderRadius: '3px',
                      marginBottom: '4px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: '13px'
                    }}>
                      <span><strong>{remoteName}</strong> → {localName}</span>
                      <Button appearance="subtle" onClick={() => deleteMapping(type, remoteId)}>Delete</Button>
                    </div>
                  );
                })
              )}
            </div>

            <Button appearance="primary" onClick={() => handleSaveMappings(type)} isLoading={saving}>
              Save {title}
            </Button>
          </>
        )}
      </div>
    );
  };

  return (
    <div style={{ maxWidth: '800px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h3>Mappings</h3>
        <Button
          appearance="primary"
          onClick={loadMappingData}
          isLoading={isLoading}
        >
          {hasData ? 'Reload Data' : 'Load Mapping Data'}
        </Button>
      </div>

      {!hasData && !isLoading && (
        <SectionMessage appearance="info" title="Load mapping data first">
          <p>Click "Load Mapping Data" to fetch users, fields, and statuses from both organizations.</p>
        </SectionMessage>
      )}

      {isLoading && (
        <div style={{ textAlign: 'center', padding: '40px' }}><Spinner size="large" /></div>
      )}

      {hasData && (
        <>
          <MappingSection
            title="User Mappings"
            type="user"
            remotePlaceholder="Select remote user"
            localPlaceholder="Select local user"
            remoteItems={remoteUsers}
            localItems={localUsers}
            mappings={userMappings}
            newRemote={newUserRemote}
            setNewRemote={setNewUserRemote}
            newLocal={newUserLocal}
            setNewLocal={setNewUserLocal}
          />

          <MappingSection
            title="Field Mappings"
            type="field"
            remotePlaceholder="Select remote field"
            localPlaceholder="Select local field"
            remoteItems={remoteFields}
            localItems={localFields}
            mappings={fieldMappings}
            newRemote={newFieldRemote}
            setNewRemote={setNewFieldRemote}
            newLocal={newFieldLocal}
            setNewLocal={setNewFieldLocal}
          />

          <MappingSection
            title="Status Mappings"
            type="status"
            remotePlaceholder="Select remote status"
            localPlaceholder="Select local status"
            remoteItems={remoteStatuses}
            localItems={localStatuses}
            mappings={statusMappings}
            newRemote={newStatusRemote}
            setNewRemote={setNewStatusRemote}
            newLocal={newStatusLocal}
            setNewLocal={setNewStatusLocal}
          />
        </>
      )}
    </div>
  );
};

// Sync Activity Panel Component
const SyncActivityPanel = ({
  manualIssueKey, setManualIssueKey, handleManualSync, manualSyncLoading,
  syncStats, loadStats, statsLoading, handleRetryPendingLinks, organizations
}) => {
  useEffect(() => {
    loadStats();
  }, []);

  return (
    <div style={{ maxWidth: '1000px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h3>Sync Activity</h3>
        <Button appearance="default" onClick={loadStats} isLoading={statsLoading}>
          Refresh Stats
        </Button>
      </div>

      {/* Manual Sync */}
      <div style={{ padding: '16px', background: 'white', border: '1px solid #DFE1E6', borderRadius: '3px', marginBottom: '20px' }}>
        <h4 style={{ margin: '0 0 8px 0' }}>Manual Sync</h4>
        <p style={{ fontSize: '13px', color: '#6B778C', marginBottom: '12px' }}>
          Sync a specific issue to all {organizations.length} organization(s)
        </p>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text"
            value={manualIssueKey}
            onChange={(e) => setManualIssueKey(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleManualSync()}
            placeholder="e.g., PROJ-123"
            style={{
              flex: 1,
              padding: '8px 12px',
              border: '2px solid #DFE1E6',
              borderRadius: '3px',
              fontSize: '14px'
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

      {/* Stats */}
      {syncStats && (
        <>
          {syncStats.webhook && (
            <div style={{ padding: '16px', background: 'white', border: '1px solid #DFE1E6', borderRadius: '3px', marginBottom: '20px' }}>
              <h4 style={{ margin: '0 0 16px 0' }}>Webhook Sync Statistics</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '16px', marginBottom: '16px' }}>
                <StatCard label="Total Syncs" value={syncStats.webhook.totalSyncs || 0} color="#0052CC" />
                <StatCard label="Issues Created" value={syncStats.webhook.issuesCreated || 0} color="#00875A" />
                <StatCard label="Issues Updated" value={syncStats.webhook.issuesUpdated || 0} color="#0052CC" />
                <StatCard label="Comments Synced" value={syncStats.webhook.commentsSynced || 0} color="#403294" />
                <StatCard label="Issues Skipped" value={syncStats.webhook.issuesSkipped || 0} color="#FF991F" />
              </div>
              {syncStats.webhook.lastSync && (
                <div style={{ fontSize: '12px', color: '#6B778C' }}>
                  Last sync: {new Date(syncStats.webhook.lastSync).toLocaleString()}
                </div>
              )}

              {syncStats.webhook.byOrg && Object.keys(syncStats.webhook.byOrg).length > 0 && (
                <div style={{ marginTop: '16px' }}>
                  <h5 style={{ marginBottom: '8px' }}>By Organization:</h5>
                  {Object.entries(syncStats.webhook.byOrg).map(([orgId, orgStats]) => {
                    const org = organizations.find(o => o.id === orgId);
                    return (
                      <div key={orgId} style={{ padding: '8px', background: '#F4F5F7', borderRadius: '3px', marginBottom: '4px', fontSize: '13px' }}>
                        <strong>{org?.name || orgId}</strong>: {orgStats.totalSyncs} syncs ({orgStats.issuesCreated} created, {orgStats.issuesUpdated} updated)
                      </div>
                    );
                  })}
                </div>
              )}

              {syncStats.webhook.errors && syncStats.webhook.errors.length > 0 && (
                <div style={{ marginTop: '16px' }}>
                  <h5 style={{ color: '#DE350B' }}>Recent Errors ({syncStats.webhook.errors.length}):</h5>
                  <div style={{ maxHeight: '200px', overflow: 'auto' }}>
                    {syncStats.webhook.errors.slice(0, 10).map((err, idx) => (
                      <div key={idx} style={{ padding: '8px', background: '#FFEBE6', borderRadius: '3px', marginBottom: '4px', fontSize: '12px' }}>
                        <div><strong>{new Date(err.timestamp).toLocaleString()}</strong></div>
                        <div>{err.error}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {syncStats.scheduled && (
            <div style={{ padding: '16px', background: 'white', border: '1px solid #DFE1E6', borderRadius: '3px', marginBottom: '20px' }}>
              <h4 style={{ margin: '0 0 16px 0' }}>Scheduled Sync Statistics</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '16px', marginBottom: '16px' }}>
                <StatCard label="Issues Checked" value={syncStats.scheduled.issuesChecked || 0} color="#0052CC" />
                <StatCard label="Issues Created" value={syncStats.scheduled.issuesCreated || 0} color="#00875A" />
                <StatCard label="Issues Updated" value={syncStats.scheduled.issuesUpdated || 0} color="#0052CC" />
                <StatCard label="Issues Skipped" value={syncStats.scheduled.issuesSkipped || 0} color="#FF991F" />
              </div>
              {syncStats.scheduled.lastRun && (
                <div style={{ fontSize: '12px', color: '#6B778C' }}>
                  Last run: {new Date(syncStats.scheduled.lastRun).toLocaleString()}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Pending Links */}
      <div style={{ padding: '16px', background: '#E3FCEF', border: '2px solid #00875A', borderRadius: '3px' }}>
        <h4 style={{ margin: '0 0 8px 0', color: '#00875A' }}>Pending Link Sync</h4>
        <p style={{ fontSize: '13px', color: '#006644', marginBottom: '12px' }}>
          Retry syncing all pending links across all organizations. Runs automatically every hour during scheduled sync.
        </p>
        <Button appearance="primary" onClick={handleRetryPendingLinks}>
          Retry All Pending Links
        </Button>
      </div>
    </div>
  );
};

const StatCard = ({ label, value, color }) => (
  <div>
    <div style={{ fontSize: '24px', fontWeight: 'bold', color }}>{value}</div>
    <div style={{ fontSize: '12px', color: '#6B778C' }}>{label}</div>
  </div>
);

// Org Modal Component
const OrgModal = ({ editingOrg, onClose, onSave, saving }) => {
  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0, 0, 0, 0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000
    }}>
      <div style={{
        background: 'white',
        borderRadius: '3px',
        padding: '24px',
        maxWidth: '500px',
        width: '90%',
        maxHeight: '90vh',
        overflow: 'auto'
      }}>
        <h3 style={{ margin: '0 0 16px 0' }}>
          {editingOrg ? `Edit ${editingOrg.name}` : 'Add Organization'}
        </h3>
        <Form onSubmit={onSave}>
          {({ formProps }) => (
            <form {...formProps}>
              <Field
                name="name"
                defaultValue={editingOrg?.name || ''}
                isRequired
                label="Organization Name"
              >
                {({ fieldProps }) => (
                  <TextField {...fieldProps} placeholder="e.g., Production Org" />
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
              {editingOrg && (
                <Field
                  name="allowedProjects"
                  defaultValue={editingOrg?.allowedProjects || []}
                >
                  {({ fieldProps }) => <input {...fieldProps} type="hidden" />}
                </Field>
              )}
              <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
                <Button type="submit" appearance="primary" isLoading={saving}>
                  {editingOrg ? 'Update' : 'Add'}
                </Button>
                <Button appearance="subtle" onClick={onClose}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </Form>
      </div>
    </div>
  );
};

// Wait for DOM to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

function initApp() {
  const rootElement = document.getElementById('root');
  if (rootElement) {
    const root = createRoot(rootElement);
    root.render(
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    );
  } else {
    console.error('Root element not found');
  }
}
