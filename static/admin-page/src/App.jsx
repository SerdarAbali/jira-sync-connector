import React, { useState, useEffect, useRef } from 'react';
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

const DEFAULT_IMPORT_SECTIONS = {
  orgDetails: true,
  syncOptions: true,
  userMappings: true,
  fieldMappings: true,
  statusMappings: true,
  scheduledSync: false
};

const ISSUE_EXPORT_LIMIT = 250;
const DEFAULT_ISSUE_IMPORT_OPTIONS = {
  refreshFromSource: true,
  forceRecreate: false,
  skipIfRemoteExists: false
};


const App = () => {
  const [organizations, setOrganizations] = useState([]);
  const [selectedOrgId, setSelectedOrgId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [exportingSettings, setExportingSettings] = useState(false);
  const [importingSettings, setImportingSettings] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importData, setImportData] = useState(null);
  const [importSections, setImportSections] = useState(() => ({ ...DEFAULT_IMPORT_SECTIONS }));
  const importFileInputRef = useRef(null);
  const issueImportFileInputRef = useRef(null);
  const [issueImportModalOpen, setIssueImportModalOpen] = useState(false);
  const [issueImportData, setIssueImportData] = useState(null);
  const [issueImportOptions, setIssueImportOptions] = useState({ ...DEFAULT_ISSUE_IMPORT_OPTIONS });
  const [issueImporting, setIssueImporting] = useState(false);

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
  const [remoteIssueTypes, setRemoteIssueTypes] = useState([]);
  const [localIssueTypes, setLocalIssueTypes] = useState([]);
  const [localProjects, setLocalProjects] = useState([]);

  // Mappings
  const [userMappings, setUserMappings] = useState({});
  const [fieldMappings, setFieldMappings] = useState({});
  const [statusMappings, setStatusMappings] = useState({});
  const [issueTypeMappings, setIssueTypeMappings] = useState({});

  // Sync options
  const [syncOptions, setSyncOptions] = useState({
    syncComments: true,
    syncAttachments: true,
    syncLinks: true,
    syncSprints: false,
    syncCrossReference: true,
    recreateDeletedIssues: false
  });

  // Stats
  const [syncStats, setSyncStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);

  // Manual sync
  const [manualIssueKey, setManualIssueKey] = useState('');
  const [manualSyncLoading, setManualSyncLoading] = useState(false);
  const [issueExporting, setIssueExporting] = useState(false);
  const [scanningDeleted, setScanningDeleted] = useState(false);
  const [scanProgress, setScanProgress] = useState(null); // Track scan progress across multiple runs

  // Connection test
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState(null);
  
  // Last sync time
  const [lastSyncTime, setLastSyncTime] = useState(null);

  // Data loading states
  const [dataLoading, setDataLoading] = useState({
    projects: false,
    users: false,
    fields: false,
    statuses: false,
    issueTypes: false
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
      // Load mappings and last sync time
      const [userMappingData, fieldMappingData, statusMappingData, issueTypeMappingData, syncOptionsData, lastSyncData] = await Promise.all([
        invoke('getUserMappings', { orgId }),
        invoke('getFieldMappings', { orgId }),
        invoke('getStatusMappings', { orgId }),
        invoke('getIssueTypeMappings', { orgId }),
        invoke('getSyncOptions', { orgId }),
        invoke('getLastSyncTime', { orgId })
      ]);

      if (userMappingData?.mappings) setUserMappings(userMappingData.mappings);
      if (fieldMappingData) setFieldMappings(fieldMappingData);
      if (statusMappingData) setStatusMappings(statusMappingData);
      if (issueTypeMappingData) setIssueTypeMappings(issueTypeMappingData);
      if (syncOptionsData) setSyncOptions(syncOptionsData);
      if (lastSyncData?.lastSync) setLastSyncTime(lastSyncData.lastSync);
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

    setDataLoading(prev => ({ ...prev, users: true, fields: true, statuses: true, issueTypes: true }));

    try {
      const [remoteData, localData] = await Promise.all([
        invoke('fetchRemoteData', { orgId: selectedOrgId }),
        invoke('fetchLocalData', { orgId: selectedOrgId })
      ]);

      if (remoteData.users) setRemoteUsers(remoteData.users);
      if (remoteData.fields) setRemoteFields(remoteData.fields);
      if (remoteData.statuses) setRemoteStatuses(remoteData.statuses);
      if (remoteData.issueTypes) setRemoteIssueTypes(remoteData.issueTypes);

      if (localData.users) setLocalUsers(localData.users);
      if (localData.fields) setLocalFields(localData.fields);
      if (localData.statuses) setLocalStatuses(localData.statuses);
      if (localData.issueTypes) setLocalIssueTypes(localData.issueTypes);

      showMessage('Mapping data loaded successfully', 'success');
    } catch (error) {
      showMessage('Error loading mapping data: ' + error.message, 'error');
    } finally {
      setDataLoading(prev => ({ ...prev, users: false, fields: false, statuses: false, issueTypes: false }));
    }
  };

  const loadStats = async () => {
    setStatsLoading(true);
    try {
      const [scheduled, webhook, apiUsage] = await Promise.all([
        invoke('getScheduledSyncStats'),
        invoke('getWebhookSyncStats'),
        invoke('getApiUsageStats')
      ]);
      setSyncStats({ scheduled, webhook, apiUsage });
    } catch (error) {
      showMessage('Error loading stats: ' + error.message, 'error');
    } finally {
      setStatsLoading(false);
    }
  };

  const showMessage = (msg, type = 'success', persistent = false) => {
    setMessage({ text: msg, type, persistent });
    // Persistent messages don't auto-dismiss (user must click to close)
    // Errors stay 15 seconds, success messages stay 5 seconds
    if (!persistent) {
      const duration = type === 'error' ? 15000 : 5000;
      setTimeout(() => setMessage(null), duration);
    }
  };

  const dismissMessage = () => {
    setMessage(null);
  };

  const resetImportState = () => {
    setImportModalOpen(false);
    setImportData(null);
    setImportSections(() => ({ ...DEFAULT_IMPORT_SECTIONS }));
    if (importFileInputRef.current) {
      importFileInputRef.current.value = '';
    }
  };

  const handleExportSettings = async () => {
    if (!selectedOrgId) return;
    setExportingSettings(true);
    try {
      const result = await invoke('exportOrgSettings', { orgId: selectedOrgId });
      if (result.success && result.data) {
        const org = organizations.find(o => o.id === selectedOrgId);
        const fileNameBase = org?.name ? org.name.replace(/\s+/g, '-').toLowerCase() : 'organization';
        const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${fileNameBase}-sync-settings-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        showMessage('Settings exported successfully', 'success');
      } else {
        showMessage(`Error exporting settings: ${result.error || 'Unknown error'}`, 'error');
      }
    } catch (error) {
      showMessage('Error exporting settings: ' + error.message, 'error');
    } finally {
      setExportingSettings(false);
    }
  };

  const handleImportButtonClick = () => {
    if (!selectedOrgId) return;
    setImportSections(() => ({ ...DEFAULT_IMPORT_SECTIONS }));
    if (importFileInputRef.current) {
      importFileInputRef.current.value = '';
      importFileInputRef.current.click();
    }
  };

  const handleImportFileChange = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        setImportSections(() => ({ ...DEFAULT_IMPORT_SECTIONS }));
        setImportData(parsed);
        setImportModalOpen(true);
      } catch (error) {
        showMessage('Invalid import file: ' + error.message, 'error');
        if (importFileInputRef.current) {
          importFileInputRef.current.value = '';
        }
      }
    };
    reader.readAsText(file);
  };

  const handleToggleImportSection = (sectionKey) => {
    setImportSections(prev => ({ ...prev, [sectionKey]: !prev[sectionKey] }));
  };

  const handleConfirmImportSettings = async () => {
    if (!selectedOrgId || !importData) return;
    if (!Object.values(importSections).some(Boolean)) {
      showMessage('Select at least one section to import', 'error');
      return;
    }

    setImportingSettings(true);
    try {
      const result = await invoke('importOrgSettings', {
        orgId: selectedOrgId,
        data: importData,
        sections: importSections
      });

      if (result.success) {
        showMessage(result.message || 'Settings imported successfully', 'success');
        await loadOrganizations();
        await loadOrgData(selectedOrgId);
        resetImportState();
      } else {
        showMessage(`Error importing settings: ${result.error || 'Unknown error'}`, 'error');
      }
    } catch (error) {
      showMessage('Error importing settings: ' + error.message, 'error');
    } finally {
      setImportingSettings(false);
    }
  };

  const handleCloseImportModal = () => {
    resetImportState();
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

  const handleTestConnection = async () => {
    if (!selectedOrgId) return;
    
    setTestingConnection(true);
    setConnectionStatus(null);
    try {
      const result = await invoke('testConnection', { orgId: selectedOrgId });
      setConnectionStatus(result);
      if (result.success) {
        showMessage(result.message, 'success');
      } else {
        showMessage(`Connection failed: ${result.error}`, 'error');
      }
    } catch (error) {
      setConnectionStatus({ success: false, error: error.message });
      showMessage('Connection test failed: ' + error.message, 'error');
    } finally {
      setTestingConnection(false);
    }
  };

  const handleAutoMatch = async (type, remoteItems, localItems, currentMappings, setMappings) => {
    if (!selectedOrgId) return;
    
    try {
      const result = await invoke('autoMatchMappings', {
        orgId: selectedOrgId,
        type,
        localItems,
        remoteItems
      });
      
      if (result.success && result.matchCount > 0) {
        // Merge with existing mappings (don't overwrite)
        const merged = { ...currentMappings };
        for (const [key, value] of Object.entries(result.matches)) {
          if (!merged[key]) {
            merged[key] = value;
          }
        }
        setMappings(merged);
        showMessage(`Auto-matched ${result.matchCount} item(s)`, 'success');
      } else if (result.matchCount === 0) {
        showMessage('No new matches found', 'info');
      } else {
        showMessage(`Auto-match failed: ${result.error}`, 'error');
      }
    } catch (error) {
      showMessage('Auto-match failed: ' + error.message, 'error');
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
        case 'issueType': return { remote: remoteIssueTypes, local: localIssueTypes, setter: setIssueTypeMappings };
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
    const setterMap = {
      'user': setUserMappings,
      'field': setFieldMappings,
      'status': setStatusMappings,
      'issueType': setIssueTypeMappings
    };
    const setter = setterMap[type];
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
      const mappingsMap = {
        'user': userMappings,
        'field': fieldMappings,
        'status': statusMappings,
        'issueType': issueTypeMappings
      };
      const methodMap = {
        'user': 'saveUserMappings',
        'field': 'saveFieldMappings',
        'status': 'saveStatusMappings',
        'issueType': 'saveIssueTypeMappings'
      };
      const mappings = mappingsMap[type];
      const method = methodMap[type];

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

  const handleScanForDeletedIssues = async (existingProgress = null, options = {}) => {
    setScanningDeleted(true);
    const { updateExisting = false } = options;
    
    // Initialize or continue progress tracking
    const currentProgress = existingProgress || scanProgress || { 
      totalCreated: 0, 
      totalAlreadySynced: 0, 
      totalScanned: 0,
      runs: 0 
    };
    
    try {
      showMessage(`⏳ Starting bulk sync${updateExisting ? ' (updating existing)' : ''}...`, 'info', true);
      const result = await invoke('scanForDeletedIssues', { orgId: selectedOrgId, updateExisting });
      
      if (result.success) {
        // New async queue approach - poll for status
        if (result.status === 'running' && result.jobId) {
          showMessage(`⏳ Bulk sync started in background. Checking status...`, 'info', true);
          
          // Poll for completion
          const pollStatus = async (attempts = 0) => {
            if (attempts > 180) { // Max 3 minutes of polling (every 1 second)
              showMessage('⏳ Sync is still running in background. Refresh to check status.', 'info', true);
              setScanningDeleted(false);
              return;
            }
            
            try {
              const statusResult = await invoke('getBulkSyncStatus');
              const status = statusResult.status || {};
              
              if (status.status === 'complete') {
                const results = status.results || {};
                const parts = [];
                if (results.created) parts.push(`${results.created} created`);
                if (results.updated) parts.push(`${results.updated} updated`);
                parts.push(`${results.alreadySynced || 0} already synced`);
                showMessage(
                  `✅ Sync complete! ${parts.join(', ')} (${results.elapsedSeconds || 0}s)`,
                  'success',
                  true
                );
                setScanProgress(null);
                setScanningDeleted(false);
                await loadStats();
              } else if (status.status === 'error') {
                showMessage(`❌ Sync failed: ${status.error}`, 'error', true);
                setScanProgress(null);
                setScanningDeleted(false);
              } else if (status.status === 'cancelled') {
                const results = status.results || {};
                showMessage(
                  `🛑 Sync cancelled. ${results.created || 0} created, ${results.alreadySynced || 0} already synced before cancel.`,
                  'info',
                  true
                );
                setScanProgress(null);
                setScanningDeleted(false);
              } else if (status.status === 'running') {
                // Still running, poll again
                setTimeout(() => pollStatus(attempts + 1), 1000);
              } else {
                // Unknown status, keep polling
                setTimeout(() => pollStatus(attempts + 1), 1000);
              }
            } catch (pollError) {
              console.error('Poll error:', pollError);
              setTimeout(() => pollStatus(attempts + 1), 2000);
            }
          };
          
          // Start polling after a brief delay
          setTimeout(() => pollStatus(0), 1000);
          return;
        }
        
        // Legacy response format (shouldn't happen anymore but just in case)
        const newProgress = {
          totalCreated: currentProgress.totalCreated + (result.results?.created || 0),
          totalAlreadySynced: currentProgress.totalAlreadySynced + (result.results?.alreadySynced || 0),
          totalScanned: currentProgress.totalScanned + (result.results?.scanned || 0),
          runs: currentProgress.runs + 1
        };
        setScanProgress(newProgress);
        
        if (result.partial) {
          showMessage(
            `⏳ Progress: ${newProgress.totalCreated} created, ${newProgress.totalAlreadySynced} already synced (${newProgress.runs} runs). Continuing...`,
            'info',
            true
          );
          await loadStats();
          setTimeout(() => handleScanForDeletedIssues(newProgress), 500);
          return;
        } else {
          showMessage(
            `✅ Sync complete! Total: ${newProgress.totalCreated} created, ${newProgress.totalAlreadySynced} already synced (${newProgress.runs} runs)`,
            'success',
            true
          );
          setScanProgress(null);
        }
        await loadStats();
      } else {
        showMessage(`Error: ${result.error}`, 'error', true);
        setScanProgress(null);
      }
    } catch (error) {
      showMessage('Error: ' + error.message, 'error', true);
      setScanProgress(null);
    }
    setScanningDeleted(false);
  };

  // Cancel bulk sync
  const handleCancelBulkSync = async () => {
    try {
      const result = await invoke('cancelBulkSync');
      if (result.success) {
        showMessage('🛑 Cancel request sent. Sync will stop after current issue.', 'info');
      } else {
        showMessage(`Error: ${result.error}`, 'error');
      }
    } catch (error) {
      showMessage('Error: ' + error.message, 'error');
    }
  };

  const resetScanProgress = () => {
    setScanProgress(null);
    dismissMessage();
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

  const handleExportIssues = async (options) => {
    console.log('[Export Debug] handleExportIssues called', { options });
    
    // Check if invoke function is available
    if (typeof invoke !== 'function') {
      console.error('[Export Debug] invoke function is not available');
      showMessage('Error: Bridge function not available. Please refresh the page.', 'error');
      return;
    }
    
    if (!options?.jql?.trim()) {
      console.log('[Export Debug] No JQL provided, showing error');
      showMessage('Enter a JQL query to export issues', 'error');
      return;
    }

    console.log('[Sync Connector] Export issues clicked', {
      location: window?.location?.href,
      options
    });

    setIssueExporting(true);
    try {
      const payload = {
        jql: options.jql.trim(),
        maxResults: Number(options.maxResults) || 50,
        includeComments: options.includeComments,
        includeAttachments: options.includeAttachments,
        includeChangelog: options.includeChangelog,
        includeIssueLinks: options.includeIssueLinks
      };

      console.log('[Export Debug] Invoking exportIssues with payload:', payload);
      const result = await invoke('exportIssues', payload);
      console.log('[Export Debug] Received result:', result);
      if (result.success && result.data) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `issue-export-${timestamp}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        showMessage(`Exported ${result.data.issueCount || 0} issue(s)`, 'success');
      } else {
        showMessage(`Error exporting issues: ${result.error || 'Unknown error'}`, 'error');
      }
    } catch (error) {
      console.error('[Export Debug] Error in handleExportIssues:', error);
      showMessage('Error exporting issues: ' + error.message, 'error');
    } finally {
      console.log('[Export Debug] Export process completed');
      setIssueExporting(false);
    }
  };

  const resetIssueImportState = () => {
    setIssueImportModalOpen(false);
    setIssueImportData(null);
    setIssueImportOptions({ ...DEFAULT_ISSUE_IMPORT_OPTIONS });
    if (issueImportFileInputRef.current) {
      issueImportFileInputRef.current.value = '';
    }
  };

  const handleIssueImportClick = () => {
    if (!selectedOrgId) {
      showMessage('Select an organization before importing issues', 'error');
      return;
    }
    if (issueImportFileInputRef.current) {
      issueImportFileInputRef.current.value = '';
      issueImportFileInputRef.current.click();
    }
  };

  const handleIssueImportFileChange = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
        const issueKeys = Array.from(new Set(issues.map(issue => issue?.key).filter(Boolean)));

        if (issueKeys.length === 0) {
          showMessage('No issues found in the selected export file', 'error');
          if (issueImportFileInputRef.current) {
            issueImportFileInputRef.current.value = '';
          }
          return;
        }

        const snapshots = issues.reduce((acc, issue) => {
          if (issue?.key) {
            acc[issue.key] = issue;
          }
          return acc;
        }, {});

        setIssueImportData({
          issueKeys,
          snapshots,
          meta: {
            exportedAt: parsed.exportedAt,
            sourceOrg: parsed.sourceOrg,
            query: parsed.query
          }
        });
        setIssueImportOptions({ ...DEFAULT_ISSUE_IMPORT_OPTIONS });
        setIssueImportModalOpen(true);
      } catch (error) {
        showMessage('Invalid issue export file: ' + error.message, 'error');
        if (issueImportFileInputRef.current) {
          issueImportFileInputRef.current.value = '';
        }
      }
    };
    reader.readAsText(file);
  };

  const handleIssueImportOptionChange = (optionKey, value) => {
    setIssueImportOptions(prev => ({ ...prev, [optionKey]: value }));
  };

  const handleConfirmIssueImport = async () => {
    if (!selectedOrgId || !issueImportData?.issueKeys?.length) {
      showMessage('Select an organization and valid issue export before importing', 'error');
      return;
    }

    setIssueImporting(true);
    try {
      const payload = {
        orgId: selectedOrgId,
        issueKeys: issueImportData.issueKeys,
        options: issueImportOptions
      };

      if (!issueImportOptions.refreshFromSource) {
        payload.snapshots = issueImportData.snapshots || {};
      }

      const result = await invoke('importIssues', payload);
      if (result.success) {
        const summary = result.results || {};
        showMessage(
          `Issue import complete: ${summary.created || 0} created, ${summary.updated || 0} updated, ${summary.skipped || 0} skipped`,
          'success'
        );
        resetIssueImportState();
        await loadStats();
      } else {
        showMessage(`Issue import failed: ${result.error || 'Unknown error'}`, 'error');
      }
    } catch (error) {
      showMessage('Error importing issues: ' + error.message, 'error');
    } finally {
      setIssueImporting(false);
    }
  };

  const handleCancelIssueImport = () => {
    resetIssueImportState();
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
      <input
        ref={importFileInputRef}
        type="file"
        accept="application/json"
        style={{ display: 'none' }}
        onChange={handleImportFileChange}
      />
      <input
        ref={issueImportFileInputRef}
        type="file"
        accept="application/json"
        style={{ display: 'none' }}
        onChange={handleIssueImportFileChange}
      />
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
          <div style={{ padding: token('space.200', '16px'), position: 'relative' }}>
            <SectionMessage
              appearance={message.type === 'error' ? 'error' : message.type === 'warning' ? 'warning' : message.type === 'info' ? 'information' : 'success'}
              title={message.text}
            />
            {message.persistent && (
              <div style={{ marginTop: '8px', display: 'flex', gap: '8px' }}>
                <Button appearance="subtle" onClick={dismissMessage}>Dismiss</Button>
                {scanProgress && <Button appearance="subtle" onClick={resetScanProgress}>Reset Progress</Button>}
              </div>
            )}
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
                  <div style={{ color: '#6B778C', fontSize: '14px', display: 'flex', alignItems: 'center', gap: token('space.150', '12px'), flexWrap: 'wrap' }}>
                    <Lozenge appearance={selectedOrg.remoteUrl ? 'success' : 'removed'} isBold>
                      {selectedOrg.remoteUrl ? 'Connected' : 'Not Configured'}
                    </Lozenge>
                    <span>{selectedOrg.remoteUrl || 'Add Jira details to start syncing.'}</span>
                    {lastSyncTime && (
                      <span style={{ color: '#6B778C' }}>
                        • Last sync: {new Date(lastSyncTime).toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: token('space.150', '12px'), flexWrap: 'wrap' }}>
                  {selectedOrg.remoteUrl && (
                    <Button
                      appearance="subtle"
                      onClick={handleTestConnection}
                      isLoading={testingConnection}
                      style={lozengeButtonStyle}
                    >
                      Test
                    </Button>
                  )}
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
                    onExportIssues={handleExportIssues}
                    issueExporting={issueExporting}
                    onIssueImportClick={handleIssueImportClick}
                    issueImporting={issueImporting}
                    selectedOrg={selectedOrg}
                    syncOptions={syncOptions}
                    handleScanForDeletedIssues={handleScanForDeletedIssues}
                    scanningDeleted={scanningDeleted}
                    scanProgress={scanProgress}
                    resetScanProgress={resetScanProgress}
                    handleCancelBulkSync={handleCancelBulkSync}
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
                    handleExportSettings={handleExportSettings}
                    handleImportSettings={handleImportButtonClick}
                    exportingSettings={exportingSettings}
                    importingSettings={importingSettings}
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
                    remoteIssueTypes={remoteIssueTypes}
                    localIssueTypes={localIssueTypes}
                    userMappings={userMappings}
                    setUserMappings={setUserMappings}
                    fieldMappings={fieldMappings}
                    setFieldMappings={setFieldMappings}
                    statusMappings={statusMappings}
                    setStatusMappings={setStatusMappings}
                    issueTypeMappings={issueTypeMappings}
                    setIssueTypeMappings={setIssueTypeMappings}
                    addMapping={addMapping}
                    deleteMapping={deleteMapping}
                    handleSaveMappings={handleSaveMappings}
                    loadMappingData={loadMappingData}
                    dataLoading={dataLoading}
                    saving={saving}
                    handleAutoMatch={handleAutoMatch}
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
      <ModalTransition>
        {importModalOpen && (
          <ImportSettingsModal
            importData={importData}
            sections={importSections}
            onToggleSection={handleToggleImportSection}
            onConfirm={handleConfirmImportSettings}
            onClose={handleCloseImportModal}
            importing={importingSettings}
          />
        )}
      </ModalTransition>
      <ModalTransition>
        {issueImportModalOpen && issueImportData && (
          <IssueImportModal
            data={issueImportData}
            options={issueImportOptions}
            onOptionChange={handleIssueImportOptionChange}
            onConfirm={handleConfirmIssueImport}
            onClose={handleCancelIssueImport}
            importing={issueImporting}
            selectedOrg={selectedOrg}
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
  setSyncOptions, handleSaveSyncOptions, saving,
  handleExportSettings, handleImportSettings, exportingSettings, importingSettings
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
        gridTemplateColumns: 'repeat(2, 1fr)',
        gap: gridGap,
        alignItems: 'stretch'
      }}>
        <div style={surfaceCard({ display: 'flex', flexDirection: 'column' })}>
          <h4 style={{ margin: '0 0 12px 0' }}>Connection Settings</h4>
          <dl style={{
            margin: 0,
            display: 'grid',
            gridTemplateColumns: '120px 1fr',
            rowGap: token('space.100', '8px'),
            columnGap: token('space.150', '12px'),
            fontSize: '13px',
            color: '#6B778C',
            flex: 1
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
              { key: 'syncSprints', label: 'Sync Sprints' },
              { key: 'syncCrossReference', label: 'Add Cross-Reference in Description (show linked issue keys in both orgs)' },
              { key: 'recreateDeletedIssues', label: 'Recreate Deleted Issues (re-sync issues deleted in target org)' }
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

        <div style={surfaceCard({ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: token('space.150', '12px') })}>
          <h4 style={{ margin: 0 }}>Import / Export Settings</h4>
          <div style={{ fontSize: '13px', color: '#6B778C' }}>
            Download a JSON snapshot of this organization's configuration or import one to overwrite selected sections.
          </div>
          <div style={{ display: 'flex', gap: token('space.150', '12px'), flexWrap: 'wrap' }}>
            <Button
              appearance="subtle"
              onClick={handleExportSettings}
              isLoading={exportingSettings}
              style={lozengeButtonStyle}
            >
              Export Settings
            </Button>
            <Button
              appearance="subtle"
              onClick={handleImportSettings}
              isLoading={importingSettings}
              style={lozengeButtonStyle}
            >
              Import Settings
            </Button>
          </div>
          <div style={{ fontSize: '12px', color: '#6B778C' }}>
            Imports prompt for confirmation before applying and may overwrite existing mappings.
          </div>
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
  remoteStatuses, localStatuses, remoteIssueTypes, localIssueTypes,
  userMappings, setUserMappings, fieldMappings, setFieldMappings,
  statusMappings, setStatusMappings, issueTypeMappings, setIssueTypeMappings,
  addMapping, deleteMapping, handleSaveMappings, loadMappingData, dataLoading, saving,
  handleAutoMatch
}) => {
  const [newUserRemote, setNewUserRemote] = useState('');
  const [newUserLocal, setNewUserLocal] = useState('');
  const [newFieldRemote, setNewFieldRemote] = useState('');
  const [newFieldLocal, setNewFieldLocal] = useState('');
  const [newStatusRemote, setNewStatusRemote] = useState('');
  const [newStatusLocal, setNewStatusLocal] = useState('');
  const [newIssueTypeRemote, setNewIssueTypeRemote] = useState('');
  const [newIssueTypeLocal, setNewIssueTypeLocal] = useState('');

  const hasData = remoteUsers.length > 0 || localUsers.length > 0;
  const isLoading = dataLoading.users || dataLoading.fields || dataLoading.statuses || dataLoading.issueTypes;

  const MappingSection = ({ title, type, remotePlaceholder, localPlaceholder, remoteItems, localItems, mappings, setMappings, newRemote, setNewRemote, newLocal, setNewLocal }) => {
    const itemKey = type === 'user' ? 'accountId' : 'id';
    const itemLabel = type === 'user' ? (item) => `${item.displayName}${item.emailAddress ? ` (${item.emailAddress})` : ''}` : (item) => `${item.name}`;

    // Sort items alphabetically
    const sortedRemoteItems = [...remoteItems].sort((a, b) => itemLabel(a).localeCompare(itemLabel(b)));
    const sortedLocalItems = [...localItems].sort((a, b) => itemLabel(a).localeCompare(itemLabel(b)));

    return (
      <div style={surfaceCard({ marginBottom: token('space.250', '20px') })}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: token('space.200', '16px') }}>
          <h4 style={{ margin: 0 }}>{title} ({Object.keys(mappings).length})</h4>
          {hasData && handleAutoMatch && (
            <Button
              appearance="subtle"
              onClick={() => handleAutoMatch(type, remoteItems, localItems, mappings, setMappings)}
              style={lozengeButtonStyle}
            >
              Auto-Match
            </Button>
          )}
        </div>

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
            setMappings={setUserMappings}
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
            setMappings={setFieldMappings}
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
            setMappings={setStatusMappings}
            newRemote={newStatusRemote}
            setNewRemote={setNewStatusRemote}
            newLocal={newStatusLocal}
            setNewLocal={setNewStatusLocal}
          />

          <MappingSection
            title="Issue Type Mappings"
            type="issueType"
            remotePlaceholder="Select remote issue type"
            localPlaceholder="Select local issue type"
            remoteItems={remoteIssueTypes || []}
            localItems={localIssueTypes || []}
            mappings={issueTypeMappings || {}}
            setMappings={setIssueTypeMappings}
            newRemote={newIssueTypeRemote}
            setNewRemote={setNewIssueTypeRemote}
            newLocal={newIssueTypeLocal}
            setNewLocal={setNewIssueTypeLocal}
          />
        </div>
      )}
    </div>
  );
};

// Sync Activity Panel Component
const SyncActivityPanel = ({
  manualIssueKey, setManualIssueKey, handleManualSync, manualSyncLoading,
  syncStats, loadStats, statsLoading, handleRetryPendingLinks, handleClearWebhookErrors,
  organizations, onExportIssues, issueExporting, onIssueImportClick, issueImporting,
  selectedOrg, syncOptions, handleScanForDeletedIssues, scanningDeleted,
  scanProgress, resetScanProgress, handleCancelBulkSync
}) => {
  console.log('[Debug] SyncActivityPanel rendered', { onExportIssues: !!onExportIssues, organizations: organizations?.length });
  const [eventsExpanded, setEventsExpanded] = useState(false);
  const [exportJql, setExportJql] = useState('');
  const [exportMode, setExportMode] = useState('predefined'); // 'predefined' or 'custom'
  const [selectedPredefined, setSelectedPredefined] = useState(null);
  const [selectedProject, setSelectedProject] = useState(null);
  const [selectedStatus, setSelectedStatus] = useState(null);
  const [selectedAssignee, setSelectedAssignee] = useState(null);
  const [dayRange, setDayRange] = useState(30);
  const [exportLimit, setExportLimit] = useState(50);
  const [exportIncludeComments, setExportIncludeComments] = useState(true);
  const [exportIncludeAttachments, setExportIncludeAttachments] = useState(true);
  const [exportIncludeChangelog, setExportIncludeChangelog] = useState(false);
  const [exportIncludeLinks, setExportIncludeLinks] = useState(true);
  useEffect(() => {
    loadStats();
  }, []);

  // Predefined query options (all include positive restrictions for bounded queries)
  const predefinedQueries = [
    { label: 'My Issues (Last 90 days)', value: 'assignee = currentUser() AND updated >= -90d' },
    { label: 'Recently Updated (Last 7 days)', value: 'updated >= -7d ORDER BY updated DESC' },
    { label: 'Recently Updated (Last 30 days)', value: 'updated >= -30d ORDER BY updated DESC' },
    { label: 'Recently Created (Last 7 days)', value: 'created >= -7d ORDER BY created DESC' },
    { label: 'Recently Created (Last 30 days)', value: 'created >= -30d ORDER BY created DESC' },
    { label: 'Unassigned Issues (Last 30 days)', value: 'assignee is EMPTY AND updated >= -30d' },
    { label: 'High Priority Issues (Last 60 days)', value: '(priority = High OR priority = Highest) AND updated >= -60d' },
    { label: 'Open/In Progress (Last 60 days)', value: '(status = Open OR status = "In Progress" OR status = "To Do") AND updated >= -60d' }
  ];

  const statusOptions = [
    { label: 'Any Status', value: '' },
    { label: 'Open/To Do', value: 'status = "To Do" OR status = Open' },
    { label: 'In Progress', value: 'status = "In Progress"' },
    { label: 'Done/Closed', value: 'status = Done OR status = Closed' }
  ];

  const assigneeOptions = [
    { label: 'Any Assignee', value: '' },
    { label: 'Assigned to Me', value: 'assignee = currentUser()' },
    { label: 'Unassigned', value: 'assignee is EMPTY' }
  ];

  // Generate JQL based on selections
  const generateJQL = () => {
    if (exportMode === 'custom') {
      const customJql = exportJql.trim();
      // Check if custom JQL has project restriction
      const hasProject = /\bproject\s*(=|!=|in)/i.test(customJql);
      if (!hasProject && customJql) {
        // Add a note that project is required
        return '';
      }
      return customJql;
    }

    if (selectedPredefined) {
      // Predefined queries must also have project
      if (!selectedProject || !selectedProject.value) {
        return '';
      }
      // Combine project with predefined query
      return `project = "${selectedProject.value}" AND ${selectedPredefined.value}`;
    }

    const conditions = [];
    
    // Jira's /rest/api/3/search/jql endpoint REQUIRES a project restriction
    // It will not accept queries without a project, even with assignee or date restrictions
    
    if (!selectedProject || !selectedProject.value) {
      // Project is required - return empty to disable the button
      return '';
    }
    
    conditions.push(`project = "${selectedProject.value}"`);
    
    if (selectedStatus && selectedStatus.value) {
      conditions.push(selectedStatus.value);
    }
    
    if (selectedAssignee && selectedAssignee.value) {
      conditions.push(selectedAssignee.value);
    }
    
    // Add a date restriction
    const dateRestriction = dayRange > 0 ? `updated >= -${dayRange}d` : 'updated >= -30d';
    conditions.push(dateRestriction);

    return conditions.join(' AND ');
  };

  const triggerIssueExport = (event) => {
    // Prevent any default behavior
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    
    console.log('[Export Debug] triggerIssueExport called', { 
      onExportIssues: !!onExportIssues,
      exportJql,
      exportLimit,
      exportIncludeComments,
      exportIncludeAttachments,
      exportIncludeChangelog,
      exportIncludeLinks
    });
    
    // Generate JQL based on current selections
    const jqlQuery = generateJQL();
    
    // Check if JQL is provided
    if (!jqlQuery || !jqlQuery.trim()) {
      console.warn('[Export Debug] No JQL query generated');
      return;
    }
    
    if (!onExportIssues) {
      console.error('[Export Debug] onExportIssues is not available');
      return;
    }
    
    // Call the export function
    onExportIssues({
      jql: jqlQuery,
      maxResults: Number(exportLimit) || 50,
      includeComments: exportIncludeComments,
      includeAttachments: exportIncludeAttachments,
      includeChangelog: exportIncludeChangelog,
      includeIssueLinks: exportIncludeLinks
    });
  };

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
    
    // If the calculated "next run" is in the past, the job is overdue/running soon
    const now = new Date();
    if (next < now) {
      // Return null to indicate it should run soon
      return 'overdue';
    }
    return next;
  };

  const scheduledEvents = Array.isArray(syncStats?.scheduled?.events) ? syncStats.scheduled.events : [];
  const hasScheduledEvents = scheduledEvents.length > 0;

  const eventTypeMeta = {
    create: { label: 'Created', appearance: 'success' },
    recreate: { label: 'Recreated', appearance: 'new' },
    update: { label: 'Updated', appearance: 'moved' },
    error: { label: 'Error', appearance: 'removed' },
    'link-synced': { label: 'Link Synced', appearance: 'success' },
    'link-error': { label: 'Link Error', appearance: 'removed' },
    'link-pending': { label: 'Link Pending', appearance: 'inprogress' },
    'link-dropped': { label: 'Link Dropped', appearance: 'default' }
  };

  const formatSyncDetails = (details) => {
    if (!details) return '';
    const parts = [];
    if (details.fields) parts.push('fields');
    if (details.status) parts.push('status');
    
    // Comments: show new count or total if all already synced
    if (details.comments > 0) {
      parts.push(`${details.comments} comment${details.comments > 1 ? 's' : ''}`);
    } else if (details.commentsTotal > 0) {
      parts.push(`${details.commentsTotal} comment${details.commentsTotal > 1 ? 's' : ''} ✓`);
    }
    
    // Links: show new count or total if all already synced
    if (details.links > 0) {
      parts.push(`${details.links} link${details.links > 1 ? 's' : ''}`);
    } else if (details.linksTotal > 0) {
      parts.push(`${details.linksTotal} link${details.linksTotal > 1 ? 's' : ''} ✓`);
    }
    
    // Attachments: show new count or total if all already synced
    if (details.attachments > 0) {
      parts.push(`${details.attachments} attachment${details.attachments > 1 ? 's' : ''}`);
    } else if (details.attachmentsTotal > 0) {
      parts.push(`${details.attachmentsTotal} attachment${details.attachmentsTotal > 1 ? 's' : ''} ✓`);
    }
    
    return parts.length > 0 ? ` (${parts.join(', ')})` : '';
  };

  const describeScheduledEvent = (event) => {
    switch (event.type) {
      case 'create':
        return `Created ${event.issueKey || 'issue'} as ${event.remoteKey || 'remote issue'}${formatSyncDetails(event.details)}`;
      case 'recreate':
        return `Recreated ${event.issueKey || 'issue'} as ${event.remoteKey || 'remote issue'} (was ${event.previousRemoteKey || 'deleted'})${formatSyncDetails(event.details)}`;
      case 'update':
        return `Updated ${event.issueKey || 'issue'} → ${event.remoteKey || 'remote key'}${formatSyncDetails(event.details)}`;
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
          <p style={{ margin: '4px 0 0 0', color: '#6B778C', fontSize: '13px' }}>Monitor sync statistics, scheduled jobs, and webhook activity.</p>
        </div>
        <Button appearance="subtle" onClick={loadStats} isLoading={statsLoading} style={lozengeButtonStyle}>
          Refresh Stats
        </Button>
      </div>

      {/* Statistics Section - Always visible at top */}
      {syncStats && (
        <>
          {/* Webhook Stats */}
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

          {/* Scheduled Sync Stats */}
          {syncStats.scheduled && (
            <div style={surfaceCard()}>
              <h4 style={{ margin: '0 0 16px 0' }}>Scheduled Sync Statistics</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: token('space.200', '16px'), marginBottom: token('space.200', '16px') }}>
                <StatCard label="Issues Checked" value={syncStats.scheduled.issuesChecked || 0} color="#0052CC" />
                <StatCard label="Issues Created" value={syncStats.scheduled.issuesCreated || 0} color="#00875A" />
                <StatCard label="Issues Updated" value={syncStats.scheduled.issuesUpdated || 0} color="#0052CC" />
                <StatCard label="Issues Recreated" value={syncStats.scheduled.issuesRecreated || 0} color="#6554C0" />
                <StatCard label="Issues Skipped" value={syncStats.scheduled.issuesSkipped || 0} color="#FF991F" />
              </div>
              {syncStats.scheduled.lastRun && (
                <div style={{ fontSize: '12px', color: '#6B778C' }}>
                  Last run: {new Date(syncStats.scheduled.lastRun).toLocaleString()}
                </div>
              )}
            </div>
          )}

          {/* API Usage Dashboard */}
          {syncStats.apiUsage && (
            <div style={surfaceCard()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <div>
                  <h4 style={{ margin: 0 }}>API Usage & Rate Limiting</h4>
                  <div style={{ fontSize: '11px', color: '#6B778C', marginTop: '4px' }}>
                    Forge Platform Limits • ~10 req/sec sustained • 100K/min burst
                  </div>
                </div>
                {syncStats.apiUsage.lastRateLimitHit && (
                  <span style={{ 
                    fontSize: '12px', 
                    padding: '4px 8px', 
                    background: '#FFEBE6', 
                    color: '#DE350B',
                    borderRadius: '4px'
                  }}>
                    Last rate limit: {new Date(syncStats.apiUsage.lastRateLimitHit).toLocaleString()}
                  </span>
                )}
              </div>
              
              {/* Quota Progress Bars */}
              <div style={{ marginBottom: '20px' }}>
                {/* Hourly Sustained Rate */}
                <div style={{ marginBottom: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <span style={{ fontSize: '13px', fontWeight: 600 }}>Hourly Quota (Sustained Rate)</span>
                    <span style={{ fontSize: '13px', color: '#6B778C' }}>
                      {(syncStats.apiUsage.callsThisHour || 0).toLocaleString()} / {(syncStats.apiUsage.estimatedHourlyLimit || 36000).toLocaleString()}
                    </span>
                  </div>
                  <div style={{ 
                    height: '8px', 
                    background: '#DFE1E6', 
                    borderRadius: '4px', 
                    overflow: 'hidden' 
                  }}>
                    <div style={{ 
                      height: '100%', 
                      width: `${Math.min(syncStats.apiUsage.quotaUsagePercent || 0, 100)}%`,
                      background: (syncStats.apiUsage.quotaUsagePercent || 0) > 80 
                        ? '#DE350B' 
                        : (syncStats.apiUsage.quotaUsagePercent || 0) > 50 
                          ? '#FF991F' 
                          : '#00875A',
                      borderRadius: '4px',
                      transition: 'width 0.3s ease'
                    }} />
                  </div>
                  <div style={{ fontSize: '11px', color: '#6B778C', marginTop: '4px' }}>
                    {syncStats.apiUsage.quotaUsagePercent || 0}% of hourly sustained limit (~10 req/sec)
                  </div>
                </div>

                {/* Rate Limit Info Box */}
                <div style={{ 
                  background: token('color.background.neutral.subtle', '#F4F5F7'), 
                  borderRadius: '6px', 
                  padding: '12px',
                  fontSize: '12px'
                }}>
                  <div style={{ fontWeight: 600, marginBottom: '8px', color: '#0052CC' }}>Atlassian Forge Rate Limits</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px' }}>
                    <div><strong>Invocations:</strong> 1,200/min per app</div>
                    <div><strong>Network Requests:</strong> 100K/min per tenant</div>
                    <div><strong>Sustained Rate:</strong> ~10 req/sec</div>
                    <div><strong>Per-Issue Writes:</strong> 20 ops/2sec, 100 ops/30sec</div>
                  </div>
                  <div style={{ marginTop: '8px', color: '#6B778C', fontSize: '11px' }}>
                    Source: <a href="https://developer.atlassian.com/platform/forge/platform-quotas-and-limits/" target="_blank" rel="noopener noreferrer" style={{ color: '#0052CC' }}>Atlassian Forge Platform Quotas</a>
                  </div>
                </div>
              </div>

              {/* Stats Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: token('space.200', '16px'), marginBottom: token('space.200', '16px') }}>
                <StatCard label="Total API Calls" value={syncStats.apiUsage.totalCalls || 0} color="#0052CC" />
                <StatCard label="Successful" value={syncStats.apiUsage.successfulCalls || 0} color="#00875A" />
                <StatCard label="Failed" value={syncStats.apiUsage.failedCalls || 0} color="#DE350B" />
                <StatCard label="Rate Limits Hit" value={syncStats.apiUsage.rateLimitHits || 0} color="#FF991F" />
                <StatCard label="Success Rate" value={`${syncStats.apiUsage.successRate || 100}%`} color="#00875A" />
              </div>

              {/* By Endpoint Breakdown */}
              {syncStats.apiUsage.byEndpoint && Object.keys(syncStats.apiUsage.byEndpoint).length > 0 && (
                <div style={{ marginTop: token('space.200', '16px') }}>
                  <h5 style={{ marginBottom: '8px' }}>Calls by Type</h5>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                    {Object.entries(syncStats.apiUsage.byEndpoint)
                      .sort((a, b) => b[1].calls - a[1].calls)
                      .map(([type, data]) => (
                        <div key={type} style={{
                          padding: '8px 12px',
                          background: token('color.background.neutral.subtle', '#F4F5F7'),
                          borderRadius: '6px',
                          fontSize: '12px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px'
                        }}>
                          <span style={{ fontWeight: 600, textTransform: 'capitalize' }}>{type}</span>
                          <span style={{ color: '#6B778C' }}>{data.calls} calls</span>
                          {data.rateLimits > 0 && (
                            <span style={{ color: '#DE350B', fontSize: '11px' }}>({data.rateLimits} limited)</span>
                          )}
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {/* Hourly History Chart */}
              {syncStats.apiUsage.history && syncStats.apiUsage.history.length > 0 && (
                <div style={{ marginTop: token('space.200', '16px') }}>
                  <h5 style={{ marginBottom: '8px' }}>Last 24 Hours</h5>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: '60px' }}>
                    {syncStats.apiUsage.history.slice(0, 24).reverse().map((hour, idx) => {
                      const maxCalls = Math.max(...syncStats.apiUsage.history.map(h => h.calls), 1);
                      const heightPercent = (hour.calls / maxCalls) * 100;
                      return (
                        <div 
                          key={idx}
                          title={`${hour.hour}: ${hour.calls} calls${hour.rateLimits ? `, ${hour.rateLimits} rate limits` : ''}`}
                          style={{
                            flex: 1,
                            height: `${Math.max(heightPercent, 5)}%`,
                            background: hour.rateLimits > 0 ? '#FF991F' : '#0052CC',
                            borderRadius: '2px 2px 0 0',
                            minWidth: '8px'
                          }}
                        />
                      );
                    })}
                  </div>
                  <div style={{ fontSize: '11px', color: '#6B778C', marginTop: '4px', textAlign: 'center' }}>
                    Hover over bars to see details. Orange = rate limited.
                  </div>
                </div>
              )}

              {syncStats.apiUsage.lastUpdated && (
                <div style={{ fontSize: '12px', color: '#6B778C', marginTop: token('space.200', '16px') }}>
                  Last updated: {new Date(syncStats.apiUsage.lastUpdated).toLocaleString()}
                </div>
              )}
            </div>
          )}

          {/* Hourly Sync Timeline */}
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
                      if (nextRun === 'overdue') {
                        return <span style={{ color: '#00875A' }}>⏳ Running soon (within the hour)</span>;
                      }
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

      {/* Quick Actions Section */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: token('space.300', '24px') }}>
        {/* Manual Sync - Compact */}
        <div style={surfaceCard()}>
          <h4 style={{ margin: '0 0 4px 0' }}>Manual Sync</h4>
          <p style={{ fontSize: '13px', color: '#6B778C', margin: '0 0 12px 0' }}>
            Sync a specific issue to all <strong>{organizations.length}</strong> org(s).
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

        {/* Pending Link Sync - Compact */}
        <div style={surfaceCard({
          background: token('color.background.accent.green.subtlest', '#E3FCEF'),
          border: `1px solid ${token('color.border.accent.green', '#36B37E')}`
        })}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: token('space.100', '8px') }}>
            <h4 style={{ margin: 0, color: '#006644' }}>Pending Links</h4>
            <Lozenge appearance="success">Auto hourly</Lozenge>
          </div>
          <p style={{ fontSize: '13px', color: '#006644', margin: '0 0 12px 0' }}>
            Retry syncing pending links across all orgs.
          </p>
          <Button appearance="subtle" onClick={handleRetryPendingLinks} style={lozengeButtonStyle}>
            Retry All Pending Links
          </Button>
        </div>

        {/* Scan for Deleted Issues */}
        {syncOptions.recreateDeletedIssues && (
          <div style={surfaceCard({
            background: token('color.background.accent.orange.subtlest', '#FFF7E6'),
            border: `1px solid ${token('color.border.accent.orange', '#FF8B00')}`
          })}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: token('space.100', '8px') }}>
              <h4 style={{ margin: 0, color: '#974F0C' }}>Sync All Issues</h4>
              <Lozenge appearance="moved">{scanProgress ? `Run ${scanProgress.runs}` : 'Batch Sync'}</Lozenge>
            </div>
            <p style={{ fontSize: '13px', color: '#974F0C', margin: '0 0 8px 0' }}>
              Sync all missing issues from source to target, or update existing ones.
            </p>
            {scanProgress && (
              <div style={{ 
                fontSize: '12px', 
                color: '#974F0C', 
                background: 'rgba(255,139,0,0.1)', 
                padding: '8px', 
                borderRadius: '4px',
                marginBottom: '8px',
                fontFamily: 'monospace'
              }}>
                📊 Progress: {scanProgress.totalCreated} created | {scanProgress.totalAlreadySynced} already synced | {scanProgress.runs} runs
              </div>
            )}
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <Button 
                appearance="subtle" 
                onClick={() => handleScanForDeletedIssues(null, { updateExisting: false })} 
                isLoading={scanningDeleted}
                style={lozengeButtonStyle}
              >
                {scanningDeleted ? 'Syncing...' : 'Sync Missing'}
              </Button>
              <Button 
                appearance="subtle" 
                onClick={() => handleScanForDeletedIssues(null, { updateExisting: true })} 
                isLoading={scanningDeleted}
                style={{ ...lozengeButtonStyle, background: '#E3FCEF', color: '#006644' }}
                title="Re-sync all issues including already synced ones (applies current field mappings)"
              >
                Update All
              </Button>
              {scanningDeleted && (
                <Button 
                  appearance="subtle" 
                  onClick={handleCancelBulkSync}
                  style={{ ...lozengeButtonStyle, background: '#FFEBE6', color: '#BF2600' }}
                >
                  Cancel
                </Button>
              )}
              {scanProgress && !scanningDeleted && (
                <Button 
                  appearance="subtle" 
                  onClick={resetScanProgress}
                  style={{ ...lozengeButtonStyle, background: '#f4f5f7' }}
                >
                  Reset
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Issue Export/Import Section - Collapsible */}
      <IssueExportImportSection
        exportJql={exportJql}
        setExportJql={setExportJql}
        exportMode={exportMode}
        setExportMode={setExportMode}
        selectedPredefined={selectedPredefined}
        setSelectedPredefined={setSelectedPredefined}
        predefinedQueries={predefinedQueries}
        selectedProject={selectedProject}
        setSelectedProject={setSelectedProject}
        selectedStatus={selectedStatus}
        setSelectedStatus={setSelectedStatus}
        statusOptions={statusOptions}
        selectedAssignee={selectedAssignee}
        setSelectedAssignee={setSelectedAssignee}
        assigneeOptions={assigneeOptions}
        dayRange={dayRange}
        setDayRange={setDayRange}
        exportLimit={exportLimit}
        setExportLimit={setExportLimit}
        exportIncludeComments={exportIncludeComments}
        setExportIncludeComments={setExportIncludeComments}
        exportIncludeAttachments={exportIncludeAttachments}
        setExportIncludeAttachments={setExportIncludeAttachments}
        exportIncludeChangelog={exportIncludeChangelog}
        setExportIncludeChangelog={setExportIncludeChangelog}
        exportIncludeLinks={exportIncludeLinks}
        setExportIncludeLinks={setExportIncludeLinks}
        generateJQL={generateJQL}
        triggerIssueExport={triggerIssueExport}
        issueExporting={issueExporting}
        onIssueImportClick={onIssueImportClick}
        issueImporting={issueImporting}
        selectedOrg={selectedOrg}
      />
    </div>
  );
};

// Issue Export/Import Section Component - Collapsible
const IssueExportImportSection = ({
  exportJql, setExportJql, exportMode, setExportMode,
  selectedPredefined, setSelectedPredefined, predefinedQueries,
  selectedProject, setSelectedProject, selectedStatus, setSelectedStatus, statusOptions,
  selectedAssignee, setSelectedAssignee, assigneeOptions,
  dayRange, setDayRange, exportLimit, setExportLimit,
  exportIncludeComments, setExportIncludeComments,
  exportIncludeAttachments, setExportIncludeAttachments,
  exportIncludeChangelog, setExportIncludeChangelog,
  exportIncludeLinks, setExportIncludeLinks,
  generateJQL, triggerIssueExport, issueExporting,
  onIssueImportClick, issueImporting, selectedOrg
}) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={surfaceCard()}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <div>
          <h4 style={{ margin: '0 0 4px 0' }}>Issue Export / Import</h4>
          <p style={{ fontSize: '13px', color: '#6B778C', margin: 0 }}>
            Export issues via JQL for migration or backups, or import from a previous export.
          </p>
        </div>
        <span style={{ fontSize: '13px', color: '#6B778C' }}>{expanded ? 'Hide ▲' : 'Show ▼'}</span>
      </div>

      {expanded && (
        <div style={{ marginTop: token('space.200', '16px'), display: 'flex', flexDirection: 'column', gap: token('space.150', '12px') }}>
          <div style={{ fontSize: '12px', color: '#DE350B', fontWeight: 500 }}>
            ⚠️ Project key is required for export.
          </div>
          
          {/* Export Mode Toggle */}
          <div style={{ display: 'flex', gap: token('space.100', '8px'), alignItems: 'center' }}>
            <label style={{ fontSize: '14px', fontWeight: 500 }}>Export Mode:</label>
            <Button
              appearance={exportMode === 'predefined' ? 'primary' : 'subtle'}
              onClick={() => setExportMode('predefined')}
              style={{ ...lozengeButtonStyle, height: '32px' }}
            >
              Easy Select
            </Button>
            <Button
              appearance={exportMode === 'custom' ? 'primary' : 'subtle'}
              onClick={() => setExportMode('custom')}
              style={{ ...lozengeButtonStyle, height: '32px' }}
            >
              Custom JQL
            </Button>
          </div>

          {/* Easy Select Mode */}
          {exportMode === 'predefined' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: token('space.100', '8px'), padding: '16px', background: token('color.background.neutral.subtle', '#F4F5F7'), borderRadius: '8px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: token('space.100', '8px') }}>
                <div>
                  <label style={{ fontSize: '13px', fontWeight: 500, marginBottom: '4px', display: 'block' }}>Quick Filters (optional):</label>
                  <Select
                    placeholder="Select a filter to combine with project..."
                    value={selectedPredefined}
                    onChange={setSelectedPredefined}
                    options={predefinedQueries}
                    isClearable
                  />
                </div>

                <div style={{ fontSize: '12px', fontWeight: 500, color: token('color.text'), margin: '8px 0 4px 0' }}>Build Your Query:</div>
                
                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: '#DE350B', marginBottom: '2px', display: 'block' }}>Project Key (REQUIRED):</label>
                  <TextField
                    placeholder="Enter project key, e.g., SCRUM, TEST, PROJ"
                    value={selectedProject?.value || ''}
                    onChange={(e) => setSelectedProject(e.target.value ? { label: e.target.value, value: e.target.value } : null)}
                  />
                </div>

                <div>
                  <label style={{ fontSize: '12px', color: token('color.text.subtle'), marginBottom: '2px', display: 'block' }}>Status:</label>
                  <Select placeholder="Any status" value={selectedStatus} onChange={setSelectedStatus} options={statusOptions} isClearable />
                </div>

                <div>
                  <label style={{ fontSize: '12px', color: token('color.text.subtle'), marginBottom: '2px', display: 'block' }}>Assignee:</label>
                  <Select placeholder="Any assignee" value={selectedAssignee} onChange={setSelectedAssignee} options={assigneeOptions} isClearable />
                </div>

                <div>
                  <label style={{ fontSize: '12px', color: token('color.text.subtle'), marginBottom: '2px', display: 'block' }}>Updated within last X days:</label>
                  <TextField type="number" min={1} max={365} value={dayRange} onChange={(e) => setDayRange(Number(e.target.value))} placeholder="30" />
                </div>
              </div>

              <div style={{ marginTop: '8px', padding: '8px', background: token('color.background.neutral'), borderRadius: '4px' }}>
                <div style={{ fontSize: '12px', color: token('color.text.subtle'), marginBottom: '4px' }}>Generated JQL:</div>
                <code style={{ fontSize: '12px', wordBreak: 'break-all' }}>{generateJQL()}</code>
              </div>
            </div>
          )}

          {/* Custom JQL Mode */}
          {exportMode === 'custom' && (
            <div>
              <TextField
                value={exportJql}
                onChange={(event) => setExportJql(event.target.value)}
                placeholder="Enter JQL, e.g., project = ABC AND updated >= -30d"
              />
              <div style={{ fontSize: '12px', color: token('color.text.subtle'), marginTop: '4px' }}>
                Need help with JQL? <a href="https://support.atlassian.com/jira-software-cloud/docs/use-advanced-search-with-jira-query-language-jql/" target="_blank" rel="noopener noreferrer">Learn JQL syntax</a>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: token('space.150', '12px'), flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ flex: '0 0 120px' }}>
              <TextField type="number" min={1} max={ISSUE_EXPORT_LIMIT} value={exportLimit} onChange={(event) => setExportLimit(event.target.value)} placeholder="Max results" />
            </div>
            <div style={{ fontSize: '12px', color: '#6B778C' }}>Max {ISSUE_EXPORT_LIMIT} issues per export</div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.100', '8px') }}>
            <Checkbox label="Comments" isChecked={exportIncludeComments} onChange={(event) => setExportIncludeComments(event.target.checked)} />
            <Checkbox label="Attachments (metadata)" isChecked={exportIncludeAttachments} onChange={(event) => setExportIncludeAttachments(event.target.checked)} />
            <Checkbox label="Issue links" isChecked={exportIncludeLinks} onChange={(event) => setExportIncludeLinks(event.target.checked)} />
            <Checkbox label="Changelog" isChecked={exportIncludeChangelog} onChange={(event) => setExportIncludeChangelog(event.target.checked)} />
          </div>

          <div style={{ display: 'flex', gap: token('space.150', '12px'), flexWrap: 'wrap' }}>
            <Button appearance="subtle" onClick={triggerIssueExport} isDisabled={!generateJQL().trim()} isLoading={issueExporting} style={lozengeButtonStyle}>
              Export Issues
            </Button>
            <Button appearance="subtle" onClick={onIssueImportClick} isDisabled={!selectedOrg || issueImporting} isLoading={issueImporting} style={lozengeButtonStyle}>
              Import Issues
            </Button>
          </div>
          <div style={{ fontSize: '12px', color: '#6B778C' }}>
            Imports target the currently selected organization.
          </div>
        </div>
      )}
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

const ImportSettingsModal = ({ importData, sections, onToggleSection, onConfirm, onClose, importing }) => {
  const sectionOptions = [
    { key: 'orgDetails', label: 'Connection details & project filters' },
    { key: 'syncOptions', label: 'Sync options' },
    { key: 'userMappings', label: 'User mappings' },
    { key: 'fieldMappings', label: 'Field mappings' },
    { key: 'statusMappings', label: 'Status mappings' },
    { key: 'scheduledSync', label: 'Scheduled sync config (global)' }
  ];
  const hasSelection = sectionOptions.some(option => sections?.[option.key]);

  return (
    <ModalDialog
      heading="Import Settings"
      onClose={onClose}
      width="medium"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: token('space.200', '16px') }}>
        <div style={{ fontSize: '13px', color: '#6B778C' }}>
          <div><strong>Source org:</strong> {importData?.org?.name || 'Unknown organization'}</div>
          <div><strong>Exported:</strong> {importData?.exportedAt ? new Date(importData.exportedAt).toLocaleString() : 'Not specified'}</div>
          {importData?.version && (
            <div><strong>Schema version:</strong> {importData.version}</div>
          )}
        </div>
        <div>
          <h4 style={{ margin: '0 0 8px 0' }}>Select sections to import</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: token('space.100', '8px') }}>
            {sectionOptions.map(option => (
              <Checkbox
                key={option.key}
                label={option.label}
                name={`import-${option.key}`}
                isChecked={!!sections?.[option.key]}
                onChange={() => onToggleSection(option.key)}
              />
            ))}
          </div>
        </div>
        <SectionMessage appearance="warning">
          <p style={{ margin: 0, fontSize: '13px' }}>
            Importing will overwrite the selected sections for the currently active organization. This action cannot be undone.
          </p>
        </SectionMessage>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: token('space.150', '12px') }}>
          <Button
            appearance="subtle"
            onClick={onConfirm}
            isDisabled={!hasSelection}
            isLoading={importing}
            style={lozengeButtonStyle}
          >
            Import Selected
          </Button>
          <Button appearance="subtle" onClick={onClose} style={lozengeButtonStyle}>
            Cancel
          </Button>
        </div>
      </div>
    </ModalDialog>
  );
};

const IssueImportModal = ({ data, options, onOptionChange, onConfirm, onClose, importing, selectedOrg }) => {
  const meta = data?.meta || {};
  const disabled = importing;

  return (
    <ModalDialog
      heading="Import Issues"
      onClose={onClose}
      width="medium"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: token('space.200', '16px') }}>
        <div style={{ fontSize: '13px', color: '#6B778C' }}>
          <div><strong>Destination:</strong> {selectedOrg?.name || 'Selected organization'}</div>
          <div><strong>Issues detected:</strong> {data.issueKeys.length}</div>
          {meta.sourceOrg && <div><strong>Source org:</strong> {meta.sourceOrg}</div>}
          {meta.query && <div><strong>Original JQL:</strong> {meta.query}</div>}
          {meta.exportedAt && <div><strong>Exported:</strong> {new Date(meta.exportedAt).toLocaleString()}</div>}
        </div>
        <div>
          <h4 style={{ margin: '0 0 8px 0' }}>Import options</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: token('space.100', '8px') }}>
            <Checkbox
              label="Fetch latest data from source Jira (recommended)"
              isChecked={options.refreshFromSource}
              onChange={(event) => onOptionChange('refreshFromSource', event.target.checked)}
              isDisabled={disabled}
            />
            <Checkbox
              label="Force re-create remote issues (ignore existing mappings)"
              isChecked={options.forceRecreate}
              onChange={(event) => onOptionChange('forceRecreate', event.target.checked)}
              isDisabled={disabled}
            />
            <Checkbox
              label="Skip issues that already have a remote copy"
              isChecked={options.skipIfRemoteExists}
              onChange={(event) => onOptionChange('skipIfRemoteExists', event.target.checked)}
              isDisabled={disabled}
            />
          </div>
        </div>
        {!options.refreshFromSource && (
          <SectionMessage appearance="warning">
            <p style={{ margin: 0, fontSize: '13px' }}>
              Importing from the export snapshot may fail if attachments or comments reference resources that no longer exist. Keep this option enabled when the source Jira is still accessible.
            </p>
          </SectionMessage>
        )}
        {options.refreshFromSource && (
          <SectionMessage appearance="info">
            <p style={{ margin: 0, fontSize: '13px' }}>
              The app will re-fetch each issue before importing so attachments and latest field values are included. Ensure the source issues still exist.
            </p>
          </SectionMessage>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: token('space.150', '12px') }}>
          <Button
            appearance="subtle"
            onClick={onConfirm}
            isLoading={importing}
            style={lozengeButtonStyle}
          >
            Import Issues
          </Button>
          <Button appearance="subtle" onClick={onClose} isDisabled={importing} style={lozengeButtonStyle}>
            Cancel
          </Button>
        </div>
      </div>
    </ModalDialog>
  );
};

// Org Modal Component
const OrgModal = ({ editingOrg, onClose, onSave, saving }) => (
  <ModalDialog
    heading={editingOrg ? `Edit Organization` : 'Add Organization'}
    onClose={onClose}
    width="large"
  >
    <Form onSubmit={onSave}>
      {({ formProps }) => (
        <form {...formProps} style={{ padding: token('space.200', '16px') }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: token('space.300', '24px') }}>
            
            {/* Connection Details Section */}
            <div>
              <h4 style={{ 
                margin: `0 0 ${token('space.150', '12px')} 0`, 
                fontSize: '11px', 
                fontWeight: 600, 
                textTransform: 'uppercase', 
                letterSpacing: '0.5px',
                color: token('color.text.subtlest', '#6B778C') 
              }}>
                Connection Details
              </h4>
              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: '1fr 2fr', 
                gap: token('space.200', '16px'),
                background: token('color.background.neutral', '#F4F5F7'),
                padding: token('space.200', '16px'),
                borderRadius: token('border.radius', '8px')
              }}>
                <Field
                  name="name"
                  defaultValue={editingOrg?.name || ''}
                  isRequired
                  label="Organization Name"
                >
                  {({ fieldProps }) => (
                    <TextField {...fieldProps} placeholder="e.g., Production" autoFocus />
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
              </div>
            </div>

            {/* Authentication Section */}
            <div>
              <h4 style={{ 
                margin: `0 0 ${token('space.150', '12px')} 0`, 
                fontSize: '11px', 
                fontWeight: 600, 
                textTransform: 'uppercase', 
                letterSpacing: '0.5px',
                color: token('color.text.subtlest', '#6B778C') 
              }}>
                Authentication
              </h4>
              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: '1fr 1fr', 
                gap: token('space.200', '16px'),
                background: token('color.background.neutral', '#F4F5F7'),
                padding: token('space.200', '16px'),
                borderRadius: token('border.radius', '8px')
              }}>
                <Field
                  name="remoteEmail"
                  defaultValue={editingOrg?.remoteEmail || ''}
                  isRequired
                  label="Admin Email"
                >
                  {({ fieldProps }) => (
                    <TextField {...fieldProps} placeholder="admin@example.com" />
                  )}
                </Field>

                <Field
                  name="remoteApiToken"
                  defaultValue={editingOrg?.remoteApiToken || ''}
                  isRequired
                  label="API Token"
                >
                  {({ fieldProps }) => (
                    <TextField {...fieldProps} type="password" placeholder="••••••••••••" />
                  )}
                </Field>
              </div>
            </div>

            {/* Sync Configuration Section */}
            <div>
              <h4 style={{ 
                margin: `0 0 ${token('space.150', '12px')} 0`, 
                fontSize: '11px', 
                fontWeight: 600, 
                textTransform: 'uppercase', 
                letterSpacing: '0.5px',
                color: token('color.text.subtlest', '#6B778C') 
              }}>
                Sync Configuration
              </h4>
              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: '1fr 2fr', 
                gap: token('space.200', '16px'),
                background: token('color.background.neutral', '#F4F5F7'),
                padding: token('space.200', '16px'),
                borderRadius: token('border.radius', '8px')
              }}>
                <Field
                  name="remoteProjectKey"
                  defaultValue={editingOrg?.remoteProjectKey || ''}
                  isRequired
                  label="Target Project Key"
                >
                  {({ fieldProps }) => (
                    <TextField {...fieldProps} placeholder="PROJ" />
                  )}
                </Field>

                <div>
                  <Field
                    name="jqlFilter"
                    defaultValue={editingOrg?.jqlFilter || ''}
                    label="JQL Filter (optional)"
                  >
                    {({ fieldProps }) => (
                      <TextField {...fieldProps} placeholder="e.g., priority = High AND status != Done" />
                    )}
                  </Field>
                  <p style={{ fontSize: '11px', color: token('color.text.subtlest', '#6B778C'), margin: `${token('space.050', '4px')} 0 0 0` }}>
                    Only issues matching this JQL will sync
                  </p>
                </div>
              </div>
            </div>

            {editingOrg && (
              <Field
                name="allowedProjects"
                defaultValue={editingOrg?.allowedProjects || []}
              >
                {({ fieldProps }) => <input {...fieldProps} type="hidden" />}
              </Field>
            )}
          </div>

          <div style={{ 
            display: 'flex', 
            justifyContent: 'flex-end', 
            gap: token('space.100', '8px'), 
            marginTop: token('space.300', '24px'),
            paddingTop: token('space.200', '16px'),
            borderTop: `1px solid ${token('color.border', '#DFE1E6')}`
          }}>
            <Button appearance="subtle" onClick={onClose} type="button">
              Cancel
            </Button>
            <Button type="submit" appearance="primary" isLoading={saving}>
              {editingOrg ? 'Save Changes' : 'Add Organization'}
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
