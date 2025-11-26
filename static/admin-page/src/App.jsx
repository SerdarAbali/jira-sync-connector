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
import Checkbox from '@atlaskit/checkbox';
import ModalDialog, { ModalTransition } from '@atlaskit/modal-dialog';
import Lozenge from '@atlaskit/lozenge';
import { token } from '@atlaskit/tokens';
import '@atlaskit/css-reset';
import ErrorBoundary from './components/ErrorBoundary';

const surfaceCard = (overrides = {}) => ({
  background: token('color.background.neutral', '#FFFFFF'),
  borderRadius: token('border.radius', '8px'),
  border: `1px solid ${token('color.border', '#DFE1E6')}`,
  boxShadow: token('elevation.shadow.raised', '0 1px 2px rgba(9, 30, 66, 0.15)'),
  padding: token('space.300', '24px'),
  ...overrides
});

const lozengeButtonStyle = {
  borderRadius: token('border.radius', '4px'),
  border: `1px solid ${token('color.border.brand', '#4C9AFF')}`,
  background: token('color.background.neutral', '#FFFFFF'),
  color: token('color.text', '#172B4D'),
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontSize: '11px',
  fontWeight: 700,
  padding: `0 ${token('space.150', '12px')}`,
  height: '28px',
  lineHeight: '26px',
  boxShadow: 'none'
};


const App = () => {
  const [organizations, setOrganizations] = useState([]);
  const [selectedOrgId, setSelectedOrgId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

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
    setTimeout(() => setMessage(null), 5000);
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

  const handleClearWebhookErrors = async () => {
    try {
      const result = await invoke('clearWebhookErrors');
      if (result.success) {
        showMessage('Webhook errors cleared successfully', 'success');
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

  const contentHorizontalPadding = token('space.500', '40px');
  const canvasBackground = token('color.background.canvas', '#F7F8F9');
  const borderColor = token('color.border', '#DFE1E6');
  const tabPanelContainerStyle = {
    padding: `${token('space.300', '24px')} 0 ${token('space.500', '40px')}`,
    width: '100%',
    boxSizing: 'border-box'
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', background: canvasBackground }}>
      {/* Top Header with Organization Selector */}
      <div style={{
        background: token('color.background.neutral', '#FFFFFF'),
        borderBottom: `1px solid ${borderColor}`,
        padding: `${token('space.200', '16px')} ${token('space.400', '32px')}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: token('space.200', '16px'),
        boxShadow: token('elevation.shadow.raised', '0 2px 4px rgba(9, 30, 66, 0.13)')
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: token('space.200', '16px'), flex: 1, minWidth: '320px' }}>
          <h3 style={{ margin: 0, fontSize: '18px' }}>Jira Sync Connector</h3>
          <div style={{ width: '250px' }}>
            <Select
              options={organizations.map(org => ({
                label: `${org.name}${org.remoteUrl ? ' - ' + org.remoteUrl : ''}`,
                value: org.id
              }))}
              value={selectedOrgId ? {
                label: selectedOrg ? `${selectedOrg.name}${selectedOrg.remoteUrl ? ' - ' + selectedOrg.remoteUrl : ''}` : '',
                value: selectedOrgId
              } : null}
              onChange={(option) => setSelectedOrgId(option?.value || null)}
              placeholder="Select organization"
              isClearable={false}
            />
          </div>
        </div>
        <div style={{ display: 'flex', gap: token('space.150', '12px'), alignItems: 'center' }}>
          <Button
            appearance="subtle"
            onClick={() => { setShowOrgModal(true); setEditingOrg(null); }}
            style={lozengeButtonStyle}
          >
            + Add Org
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: canvasBackground }}>
        {message && (
          <div style={{ padding: token('space.200', '16px') }}>
            <SectionMessage
              appearance={message.type === 'error' ? 'error' : 'success'}
              title={message.text}
            />
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
                appearance="subtle"
                onClick={() => { setShowOrgModal(true); setEditingOrg(null); }}
                style={lozengeButtonStyle}
              >
                Add Your First Organization
              </Button>
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {/* Organization Header */}
            <div style={{ padding: `${token('space.300', '24px')} ${contentHorizontalPadding}` }}>
              <div style={surfaceCard({ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: token('space.300', '24px') })}>
                <div style={{ flex: 1 }}>
                  <h2 style={{ margin: '0 0 8px 0' }}>{selectedOrg.name}</h2>
                  <div style={{ color: '#6B778C', fontSize: '14px', display: 'flex', alignItems: 'center', gap: token('space.150', '12px') }}>
                    <Lozenge appearance={selectedOrg.remoteUrl ? 'success' : 'removed'} isBold>
                      {selectedOrg.remoteUrl ? 'Connected' : 'Not Configured'}
                    </Lozenge>
                    <span>{selectedOrg.remoteUrl || 'Add Jira details to start syncing.'}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: token('space.150', '12px') }}>
                  <Button
                    appearance="subtle"
                    onClick={() => { setEditingOrg(selectedOrg); setShowOrgModal(true); }}
                    style={lozengeButtonStyle}
                  >
                    Edit
                  </Button>
                  <Button
                    appearance="subtle"
                    onClick={() => handleDeleteOrg(selectedOrgId)}
                    style={lozengeButtonStyle}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </div>

            {/* Tabs */}
            <div style={{ padding: `0 ${contentHorizontalPadding}` }}>
              <Tabs id="org-tabs">
                <TabList
                  style={{
                    padding: `0 0 ${token('space.100', '8px')} 0`,
                    background: 'transparent',
                    borderBottom: `1px solid ${borderColor}`,
                    gap: token('space.200', '16px')
                  }}
                >
                  <Tab>Sync Activity</Tab>
                  <Tab>Configuration</Tab>
                  <Tab>Mappings</Tab>
                </TabList>

              {/* Sync Activity Tab */}
              <TabPanel>
                <div style={tabPanelContainerStyle}>
                  <SyncActivityPanel
                    manualIssueKey={manualIssueKey}
                    setManualIssueKey={setManualIssueKey}
                    handleManualSync={handleManualSync}
                    manualSyncLoading={manualSyncLoading}
                    syncStats={syncStats}
                    loadStats={loadStats}
                    statsLoading={statsLoading}
                    handleRetryPendingLinks={handleRetryPendingLinks}
                    handleClearWebhookErrors={handleClearWebhookErrors}
                    organizations={organizations}
                  />
                </div>
              </TabPanel>

              {/* Configuration Tab */}
              <TabPanel>
                <div style={tabPanelContainerStyle}>
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
                <div style={tabPanelContainerStyle}>
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
              </Tabs>
            </div>
          </div>
        )}
      </div>

      {/* Org Modal */}
      <ModalTransition>
        {showOrgModal && (
          <OrgModal
            editingOrg={editingOrg}
            onClose={() => { setShowOrgModal(false); setEditingOrg(null); }}
            onSave={handleSaveOrg}
            saving={saving}
          />
        )}
      </ModalTransition>
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
  const gridGap = token('space.300', '24px');

  const toggleProjects = () => {
    const next = !projectsExpanded;
    setProjectsExpanded(next);
    if (next && localProjects.length === 0) {
      loadProjects();
    }
  };

  const renderProjectCard = (project) => {
    const isSelected = selectedOrg.allowedProjects?.includes(project.key);
    return (
      <div
        key={project.key}
        onClick={() => toggleProjectSelection(project.key)}
        style={{
          padding: token('space.200', '16px'),
          background: isSelected
            ? token('color.background.accent.green.subtler', '#E3FCEF')
            : token('color.background.neutral.subtle', '#F4F5F7'),
          border: `2px solid ${isSelected ? token('color.border.accent.green', '#00875A') : 'transparent'}`,
          borderRadius: token('border.radius', '8px'),
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: token('space.150', '12px'),
          fontSize: '13px'
        }}
      >
        <Checkbox
          isChecked={isSelected}
          onChange={(event) => {
            event.stopPropagation();
            toggleProjectSelection(project.key);
          }}
          label=""
          name={`project-${project.key}`}
          aria-label={`${project.key} ${project.name}`}
        />
        <div>
          <strong>{project.key}</strong>
          <div style={{ color: '#6B778C', fontSize: '12px' }}>{project.name}</div>
        </div>
      </div>
    );
  };

  return (
    <div style={{ width: '100%' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
        gap: gridGap,
        alignItems: 'start'
      }}>
        <div style={surfaceCard()}>
          <h4 style={{ margin: '0 0 12px 0' }}>Connection Settings</h4>
          <dl style={{
            margin: 0,
            display: 'grid',
            gridTemplateColumns: '120px 1fr',
            rowGap: token('space.100', '8px'),
            columnGap: token('space.150', '12px'),
            fontSize: '13px',
            color: '#6B778C'
          }}>
            <dt style={{ fontWeight: 600 }}>URL</dt>
            <dd style={{ margin: 0 }}>{selectedOrg.remoteUrl || '—'}</dd>
            <dt style={{ fontWeight: 600 }}>Email</dt>
            <dd style={{ margin: 0 }}>{selectedOrg.remoteEmail || '—'}</dd>
            <dt style={{ fontWeight: 600 }}>Project</dt>
            <dd style={{ margin: 0 }}>{selectedOrg.remoteProjectKey || '—'}</dd>
          </dl>
        </div>

        <div style={surfaceCard({ display: 'flex', flexDirection: 'column', gap: token('space.150', '12px') })}>
          <h4 style={{ margin: 0 }}>Sync Options</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: token('space.100', '8px') }}>
            {[
              { key: 'syncComments', label: 'Sync Comments' },
              { key: 'syncAttachments', label: 'Sync Attachments' },
              { key: 'syncLinks', label: 'Sync Issue Links' },
              { key: 'syncSprints', label: 'Sync Sprints' }
            ].map(option => (
              <Checkbox
                key={option.key}
                label={option.label}
                name={option.key}
                isChecked={!!syncOptions[option.key]}
                onChange={(event) => setSyncOptions({ ...syncOptions, [option.key]: event.target.checked })}
              />
            ))}
          </div>
          <Button
            appearance="subtle"
            onClick={handleSaveSyncOptions}
            isLoading={saving}
            style={lozengeButtonStyle}
          >
            Save Sync Options
          </Button>
        </div>

        <div style={surfaceCard({ gridColumn: '1 / -1' })}>
          <div
            onClick={toggleProjects}
            style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <div>
              <h4 style={{ margin: '0 0 4px 0' }}>Project Filter</h4>
              <div style={{ color: '#6B778C', fontSize: '13px' }}>Control which projects participate in scheduled syncs.</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: token('space.150', '12px') }}>
              <Lozenge appearance="inprogress">
                {selectedOrg.allowedProjects?.length || 0} selected
              </Lozenge>
              <span style={{ fontSize: '13px', color: '#6B778C' }}>{projectsExpanded ? 'Hide' : 'Show'}</span>
            </div>
          </div>

          {projectsExpanded && (
            <div style={{ marginTop: token('space.200', '16px') }}>
              {dataLoading.projects ? (
                <div style={{ textAlign: 'center', padding: token('space.300', '24px') }}><Spinner /></div>
              ) : localProjects.length === 0 ? (
                <div style={{ color: '#6B778C', fontSize: '13px' }}>No projects loaded yet.</div>
              ) : (
                <>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                    gap: token('space.200', '16px')
                  }}>
                    {localProjects.map(renderProjectCard)}
                  </div>
                  <Button
                    appearance="subtle"
                    onClick={handleSaveProjectFilter}
                    isLoading={saving}
                    style={{ ...lozengeButtonStyle, marginTop: token('space.200', '16px') }}
                  >
                    Save Project Filter
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
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

    // Sort items alphabetically
    const sortedRemoteItems = [...remoteItems].sort((a, b) => itemLabel(a).localeCompare(itemLabel(b)));
    const sortedLocalItems = [...localItems].sort((a, b) => itemLabel(a).localeCompare(itemLabel(b)));

    return (
      <div style={surfaceCard({ marginBottom: token('space.250', '20px') })}>
        <h4 style={{ margin: '0 0 16px 0' }}>{title} ({Object.keys(mappings).length})</h4>

        {hasData && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: token('space.150', '12px'), marginBottom: token('space.200', '16px') }}>
              <Select
                options={sortedRemoteItems.map(item => ({ label: itemLabel(item), value: item[itemKey] }))}
                value={sortedRemoteItems.find(i => i[itemKey] === newRemote) ? { label: itemLabel(sortedRemoteItems.find(i => i[itemKey] === newRemote)), value: newRemote } : null}
                onChange={(option) => setNewRemote(option?.value || '')}
                placeholder={remotePlaceholder}
                isClearable
              />
              <Select
                options={sortedLocalItems.map(item => ({ label: itemLabel(item), value: item[itemKey] }))}
                value={sortedLocalItems.find(i => i[itemKey] === newLocal) ? { label: itemLabel(sortedLocalItems.find(i => i[itemKey] === newLocal)), value: newLocal } : null}
                onChange={(option) => setNewLocal(option?.value || '')}
                placeholder={localPlaceholder}
                isClearable
              />
              <Button
                appearance="subtle"
                onClick={() => { addMapping(type, newRemote, newLocal); setNewRemote(''); setNewLocal(''); }}
                isDisabled={!newRemote || !newLocal}
                style={lozengeButtonStyle}
              >
                Add
              </Button>
            </div>

            <div style={{ marginBottom: token('space.200', '16px') }}>
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
                      background: token('color.background.neutral.subtle', '#F4F5F7'),
                      borderRadius: token('border.radius', '8px'),
                      marginBottom: '4px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: '13px'
                    }}>
                      <span><strong>{remoteName}</strong> → {localName}</span>
                      <Button appearance="subtle" onClick={() => deleteMapping(type, remoteId)} style={lozengeButtonStyle}>Delete</Button>
                    </div>
                  );
                })
              )}
            </div>

            <Button appearance="subtle" onClick={() => handleSaveMappings(type)} isLoading={saving} style={lozengeButtonStyle}>
              Save {title}
            </Button>
          </>
        )}
      </div>
    );
  };

  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: token('space.250', '20px') }}>
        <h3>Mappings</h3>
        <Button
          appearance="subtle"
          onClick={loadMappingData}
          isLoading={isLoading}
          style={lozengeButtonStyle}
        >
          {hasData ? 'Reload Data' : 'Load Mapping Data'}
        </Button>
      </div>

      {!hasData && !isLoading && (
        <div style={surfaceCard()}>
          <SectionMessage appearance="info" title="Load mapping data first">
            <p>Click "Load Mapping Data" to fetch users, fields, and statuses from both organizations.</p>
          </SectionMessage>
        </div>
      )}

      {isLoading && (
        <div style={{ textAlign: 'center', padding: '40px' }}><Spinner size="large" /></div>
      )}

      {hasData && (
        <div>
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
        </div>
      )}
    </div>
  );
};

// Sync Activity Panel Component
const SyncActivityPanel = ({
  manualIssueKey, setManualIssueKey, handleManualSync, manualSyncLoading,
  syncStats, loadStats, statsLoading, handleRetryPendingLinks, handleClearWebhookErrors, organizations
}) => {
  const [eventsExpanded, setEventsExpanded] = useState(false);
  useEffect(() => {
    loadStats();
  }, []);

  const formatHelsinkiTime = (timestamp) => {
    if (!timestamp) return 'Not available';
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/Helsinki',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }).format(new Date(timestamp));
    } catch (error) {
      console.error('Error formatting Helsinki time:', error);
      return new Date(timestamp).toLocaleString();
    }
  };

  const getNextRunTime = () => {
    const lastRun = syncStats?.scheduled?.lastRun;
    if (!lastRun) return null;
    const next = new Date(lastRun);
    next.setHours(next.getHours() + 1);
    return next;
  };

  const scheduledEvents = Array.isArray(syncStats?.scheduled?.events) ? syncStats.scheduled.events : [];
  const hasScheduledEvents = scheduledEvents.length > 0;

  const eventTypeMeta = {
    create: { label: 'Created', appearance: 'success' },
    update: { label: 'Updated', appearance: 'moved' },
    error: { label: 'Error', appearance: 'removed' },
    'link-synced': { label: 'Link Synced', appearance: 'success' },
    'link-error': { label: 'Link Error', appearance: 'removed' },
    'link-pending': { label: 'Link Pending', appearance: 'inprogress' },
    'link-dropped': { label: 'Link Dropped', appearance: 'default' }
  };

  const describeScheduledEvent = (event) => {
    switch (event.type) {
      case 'create':
        return `Created ${event.issueKey || 'issue'} as ${event.remoteKey || 'remote issue'}`;
      case 'update':
        return `Updated ${event.issueKey || 'issue'} → ${event.remoteKey || 'remote key'}`;
      case 'link-synced':
        return `Linked ${event.issueKey || 'issue'} with ${event.linkedIssueKey || 'peer'}`;
      case 'link-error':
        return `Link error on ${event.issueKey || 'issue'}`;
      case 'link-pending':
        return `Link pending for ${event.issueKey || 'issue'}`;
      case 'link-dropped':
        return `Dropped pending link for ${event.issueKey || 'issue'}`;
      case 'error':
        return `Sync error${event.issueKey ? ' on ' + event.issueKey : ''}`;
      default:
        return 'Scheduled event';
    }
  };

  const formatDirection = (direction) => {
    if (!direction) return null;
    if (direction === 'outward') return 'Outward (source → target)';
    if (direction === 'inward') return 'Inward (target → source)';
    return direction;
  };

  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: token('space.300', '24px') }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h3 style={{ margin: 0 }}>Sync Activity</h3>
          <p style={{ margin: '4px 0 0 0', color: '#6B778C', fontSize: '13px' }}>Monitor scheduled jobs, webhook throughput, and manual syncs.</p>
        </div>
        <Button appearance="subtle" onClick={loadStats} isLoading={statsLoading} style={lozengeButtonStyle}>
          Refresh Stats
        </Button>
      </div>

      <div style={surfaceCard()}>
        <h4 style={{ margin: '0 0 4px 0' }}>Manual Sync</h4>
        <p style={{ fontSize: '13px', color: '#6B778C', margin: '0 0 16px 0' }}>
          Sync a specific issue to all <strong>{organizations.length}</strong> organization(s).
        </p>
        <div style={{ display: 'flex', gap: token('space.150', '12px'), alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <TextField
              value={manualIssueKey}
              onChange={(event) => setManualIssueKey(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && handleManualSync()}
              placeholder="e.g., PROJ-123"
              width="100%"
            />
          </div>
          <Button
            appearance="subtle"
            onClick={handleManualSync}
            isLoading={manualSyncLoading}
            isDisabled={!manualIssueKey.trim()}
            style={lozengeButtonStyle}
          >
            Sync Now
          </Button>
        </div>
      </div>

      {syncStats && (
        <>
          {syncStats.webhook && (
            <div style={surfaceCard()}>
              <h4 style={{ margin: '0 0 16px 0' }}>Webhook Sync Statistics</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: token('space.200', '16px'), marginBottom: token('space.200', '16px') }}>
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
                <div style={{ marginTop: token('space.200', '16px') }}>
                  <h5 style={{ marginBottom: '8px' }}>By Organization</h5>
                  {Object.entries(syncStats.webhook.byOrg).map(([orgId, orgStats]) => {
                    const org = organizations.find(o => o.id === orgId);
                    return (
                      <div key={orgId} style={{
                        padding: token('space.150', '12px'),
                        background: token('color.background.neutral.subtle', '#F4F5F7'),
                        borderRadius: token('border.radius', '8px'),
                        marginBottom: '4px',
                        fontSize: '13px'
                      }}>
                        <strong>{org?.name || orgId}</strong>: {orgStats.totalSyncs} syncs ({orgStats.issuesCreated} created, {orgStats.issuesUpdated} updated)
                      </div>
                    );
                  })}
                </div>
              )}

              {syncStats.webhook.errors && syncStats.webhook.errors.length > 0 && (
                <div style={{ marginTop: token('space.200', '16px') }}>
                  <h5 style={{ color: '#DE350B', marginBottom: '8px' }}>Recent Errors ({syncStats.webhook.errors.length})</h5>
                  <div style={{ maxHeight: '300px', overflow: 'auto' }}>
                    {syncStats.webhook.errors.slice(0, 10).map((err, idx) => (
                      <div key={idx} style={{
                        padding: token('space.200', '16px'),
                        background: token('color.background.danger', '#FFEBE6'),
                        borderRadius: token('border.radius', '8px'),
                        marginBottom: '8px',
                        fontSize: '12px',
                        border: `1px solid ${token('color.border.danger', '#DE350B')}`
                      }}>
                        <div style={{ marginBottom: '8px' }}>
                          <strong style={{ fontSize: '13px' }}>{new Date(err.timestamp).toLocaleString()}</strong>
                        </div>
                        <div style={{ marginBottom: '4px' }}>
                          <strong>Error:</strong> {err.error}
                        </div>
                        {err.issueKey && (
                          <div style={{ marginBottom: '4px' }}>
                            <strong>Issue:</strong> {err.issueKey}
                          </div>
                        )}
                        {err.orgId && (
                          <div style={{ marginBottom: '4px' }}>
                            <strong>Organization:</strong> {organizations.find(o => o.id === err.orgId)?.name || err.orgId}
                          </div>
                        )}
                        {err.operation && (
                          <div style={{ marginBottom: '4px' }}>
                            <strong>Operation:</strong> {err.operation}
                          </div>
                        )}
                        {err.details && (
                          <div style={{ marginTop: '8px', padding: token('space.150', '12px'), background: '#FFF', borderRadius: token('border.radius', '8px'), fontSize: '11px', fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <Button
                    appearance="subtle"
                    onClick={handleClearWebhookErrors}
                    style={{ ...lozengeButtonStyle, marginTop: token('space.150', '12px') }}
                  >
                    Clear Errors
                  </Button>
                </div>
              )}
            </div>
          )}

          {syncStats.scheduled && (
            <div style={surfaceCard()}>
              <h4 style={{ margin: '0 0 16px 0' }}>Scheduled Sync Statistics</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: token('space.200', '16px'), marginBottom: token('space.200', '16px') }}>
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

          {syncStats?.scheduled && (
            <div style={surfaceCard({ background: token('color.background.neutral.subtle', '#F4F5F7') })}>
              <h4 style={{ margin: '0 0 8px 0' }}>Hourly Sync Timeline</h4>
              <p style={{ fontSize: '13px', color: '#6B778C', margin: '0 0 12px 0' }}>
                Timestamps are shown in Helsinki time (Europe/Helsinki).
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: token('space.200', '16px') }}>
                <div>
                  <div style={{ fontSize: '12px', color: '#6B778C' }}>Last automatic run</div>
                  <div style={{ fontSize: '16px', fontWeight: 'bold' }}>{formatHelsinkiTime(syncStats.scheduled.lastRun)}</div>
                </div>
                <div>
                  <div style={{ fontSize: '12px', color: '#6B778C' }}>Next scheduled run</div>
                  <div style={{ fontSize: '16px', fontWeight: 'bold' }}>
                    {(() => {
                      const nextRun = getNextRunTime();
                      return nextRun ? formatHelsinkiTime(nextRun) : 'Pending first schedule';
                    })()}
                  </div>
                </div>
              </div>
              <div style={{ marginTop: '12px', fontSize: '12px', color: '#6B778C' }}>
                Runs every 60 minutes; next run is calculated from the last completed execution.
              </div>
              <div style={{ marginTop: token('space.300', '24px') }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: token('space.150', '12px') }}>
                  <strong style={{ fontSize: '13px' }}>Recent events ({scheduledEvents.length})</strong>
                  {hasScheduledEvents && (
                    <Button
                      appearance="subtle"
                      onClick={() => setEventsExpanded(!eventsExpanded)}
                      style={lozengeButtonStyle}
                    >
                      {eventsExpanded ? 'Hide Log' : 'Show Log'}
                    </Button>
                  )}
                </div>
                {!hasScheduledEvents && (
                  <div style={{ fontSize: '12px', color: '#6B778C' }}>
                    No events recorded yet. The next hourly run will populate this log.
                  </div>
                )}
                {hasScheduledEvents && eventsExpanded && (
                  <div style={{ borderRadius: token('border.radius', '8px'), border: `1px solid ${token('color.border', '#DFE1E6')}`, background: token('color.background.neutral', '#FFFFFF'), maxHeight: '320px', overflowY: 'auto' }}>
                    {scheduledEvents.map((event, index) => {
                      const meta = eventTypeMeta[event.type] || { label: event.type || 'Event', appearance: 'default' };
                      const detailPairs = [
                        event.issueKey ? { label: 'Issue', value: event.issueKey } : null,
                        event.remoteKey ? { label: 'Remote', value: event.remoteKey } : null,
                        event.linkedIssueKey ? { label: 'Linked', value: event.linkedIssueKey } : null,
                        event.direction ? { label: 'Direction', value: formatDirection(event.direction) } : null
                      ].filter(Boolean);

                      return (
                        <div
                          key={`${event.timestamp || 'event'}-${index}`}
                          style={{
                            padding: token('space.200', '16px'),
                            borderBottom: index === scheduledEvents.length - 1 ? 'none' : `1px solid ${token('color.border', '#DFE1E6')}`
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: token('space.150', '12px') }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: token('space.150', '12px'), flexWrap: 'wrap' }}>
                              <Lozenge appearance={meta.appearance} isBold>{meta.label}</Lozenge>
                              <div style={{ fontWeight: 600, fontSize: '13px' }}>{describeScheduledEvent(event)}</div>
                            </div>
                            <div style={{ fontSize: '11px', color: '#6B778C', whiteSpace: 'nowrap' }}>
                              {event.timestamp ? formatHelsinkiTime(event.timestamp) : '—'}
                            </div>
                          </div>
                          {detailPairs.length > 0 && (
                            <div style={{ marginTop: token('space.150', '12px'), fontSize: '12px', color: '#6B778C', display: 'flex', flexWrap: 'wrap', gap: token('space.150', '12px') }}>
                              {detailPairs.map(({ label, value }) => (
                                <div key={`${label}-${value}`} style={{ minWidth: '120px' }}>
                                  <strong>{label}:</strong> {value}
                                </div>
                              ))}
                            </div>
                          )}
                          {event.message && (
                            <div style={{
                              marginTop: token('space.150', '12px'),
                              fontSize: '12px',
                              color: '#172B4D',
                              background: token('color.background.neutral.subtle', '#F4F5F7'),
                              borderRadius: token('border.radius', '6px'),
                              padding: token('space.150', '12px'),
                              fontFamily: 'monospace',
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word'
                            }}>
                              {event.message}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      <div style={surfaceCard({
        background: token('color.background.accent.green.subtlest', '#E3FCEF'),
        border: `1px solid ${token('color.border.accent.green', '#36B37E')}`
      })}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: token('space.150', '12px') }}>
          <h4 style={{ margin: 0, color: '#006644' }}>Pending Link Sync</h4>
          <Lozenge appearance="success">Automated hourly</Lozenge>
        </div>
        <p style={{ fontSize: '13px', color: '#006644', marginBottom: token('space.200', '16px') }}>
          Retry syncing all pending links across every organization. The scheduled job already attempts this each hour; trigger an on-demand retry if needed.
        </p>
        <Button appearance="subtle" onClick={handleRetryPendingLinks} style={lozengeButtonStyle}>
          Retry All Pending Links
        </Button>
      </div>
    </div>
  );
};

const StatCard = ({ label, value, color }) => (
  <div style={{
    padding: token('space.200', '16px'),
    borderRadius: token('border.radius', '8px'),
    background: token('color.background.neutral.subtle', '#F4F5F7')
  }}>
    <div style={{ fontSize: '12px', color: '#6B778C', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: '4px' }}>{label}</div>
    <div style={{ fontSize: '28px', fontWeight: 600, color: color || token('color.text', '#172B4D') }}>{value}</div>
  </div>
);

// Org Modal Component
const OrgModal = ({ editingOrg, onClose, onSave, saving }) => (
  <ModalDialog
    heading={editingOrg ? `Edit ${editingOrg.name}` : 'Add Organization'}
    onClose={onClose}
    width="medium"
  >
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
              <TextField {...fieldProps} placeholder="e.g., Production Org" autoFocus />
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
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: token('space.150', '12px'), marginTop: token('space.300', '24px') }}>
            <Button type="submit" appearance="subtle" isLoading={saving} style={lozengeButtonStyle}>
              {editingOrg ? 'Update' : 'Add'}
            </Button>
            <Button appearance="subtle" onClick={onClose} type="button" style={lozengeButtonStyle}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Form>
  </ModalDialog>
);

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
