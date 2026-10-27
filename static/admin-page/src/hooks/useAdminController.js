import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@forge/bridge';
import { resolveSelectedOrganizationId, storeSelectedOrganizationId } from '../org-selection';
const DEFAULT_IMPORT_SECTIONS = {
  orgDetails: true,
  syncOptions: true,
  userMappings: true,
  fieldMappings: true,
  statusMappings: true,
  scheduledSync: false
};

const DEFAULT_ISSUE_IMPORT_OPTIONS = {
  refreshFromSource: true,
  skipIfRemoteExists: false
};

export default function useAdminController({ selection, onSelect, navigate }) {
  const sessionActive = useRef(true);
  useEffect(() => {
    sessionActive.current = true;
    return () => { sessionActive.current = false; };
  }, []);
  const [organizations, setOrganizations] = useState([]);
  // Read once before effects run. The stored value is only applied after it is
  // validated against the loaded organizations; the page never defaults to the
  // first organization in the list.
  const [selectedOrgId, setSelectedOrgId] = useState(() => selection);
  const [selectionReady, setSelectionReady] = useState(false);
  // Mirrors the applied selection for async loaders without reading stale state.
  const selectedOrgIdRef = useRef(selectedOrgId);

  const [loading, setLoading] = useState(true);
  const [organizationsLoadState, setOrganizationsLoadState] = useState({
    status: 'loading',
    message: ''
  });
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

  // Delete confirmation state
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [orgToDelete, setOrgToDelete] = useState(null);

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
  const [projectMappings, setProjectMappings] = useState({});
  const [rejectedFieldIds, setRejectedFieldIds] = useState([]);

  // Sync options
  const [syncOptions, setSyncOptions] = useState({
    syncComments: true,
    syncAttachments: false,
    propagateAttachmentDeletions: false,
    maxAttachmentSizeBytes: null,
    syncLinks: true,
    syncCrossReference: true,
    recreateDeletedIssues: false,
    automaticReplacementAfterDeletion: false
  });
  const [attachmentMaxMb, setAttachmentMaxMb] = useState('');

  // Stats
  const [syncStats, setSyncStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);

  // Manual sync
  const [manualIssueKey, setManualIssueKey] = useState('');
  const [manualSyncLoading, setManualSyncLoading] = useState(false);
  const [issueExporting, setIssueExporting] = useState(false);
  const [scanningDeleted, setScanningDeleted] = useState(false);
  const [scanProgress, setScanProgress] = useState(null); // Track scan progress across multiple runs

  // Scheduled sync manual triggering was removed. Recurring reconciliation is
  // scheduled by the existing hourly recovery heartbeat.

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
    if (selectionReady && selectedOrgId) {
      loadOrgData(selectedOrgId);
    }
  }, [selectedOrgId, selectionReady]);

  // Existing authenticated bridge: reads are passive; fresh initialization
  // requires an explicit confirmation argument and server-side ADMIN_WRITE.
  // Neither handle is invoked automatically. Legacy activation is not exposed.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    window.__syncConnectorReadinessInvoke = () => invoke('getConnectorReadiness', {});
    window.__syncConnectorInitializeFreshIssueLeases = (confirmation) =>
      invoke('initializeFreshIssueLeases', { confirmation });
    return () => {
      delete window.__syncConnectorReadinessInvoke;
      delete window.__syncConnectorInitializeFreshIssueLeases;
    };
  }, []);

  const loadOrganizations = async () => {
    setOrganizationsLoadState({ status: 'loading', message: '' });
    try {
      const orgs = await invoke('getOrganizations');

      if (Array.isArray(orgs)) {
        setOrganizations(orgs);
        setOrganizationsLoadState({ status: 'loaded', message: '' });
        // Apply the current (or restored) selection only while that
        // organization still exists. Never fall back to the first
        // organization, which could address the wrong vendor.
        const nextSelection = resolveSelectedOrganizationId(orgs, selectedOrgIdRef.current);
        selectedOrgIdRef.current = nextSelection;
        setSelectedOrgId(nextSelection);
        storeSelectedOrganizationId(nextSelection);
        setSelectionReady(true);
        return;
      }

      if (orgs && typeof orgs === 'object' && orgs.code === 'FORBIDDEN') {
        const message = 'Jira administrator permission is required to load connector configuration.';
        setOrganizationsLoadState({ status: 'error', message });
        showMessage(message, 'error');
        return;
      }

      const message = 'Unable to load connector organizations.';
      setOrganizationsLoadState({ status: 'error', message });
      showMessage(message, 'error');
    } catch (error) {
      const message = 'Unable to load connector organizations.';
      setOrganizationsLoadState({ status: 'error', message });
      showMessage(message, 'error');
    } finally {
      setLoading(false);
    }
  };

  // Every organization-specific view and write uses this explicit selection.
  const selectOrganization = (orgId) => {
    if (!sessionActive.current) return;
    const nextSelection = orgId || null;
    selectedOrgIdRef.current = nextSelection;
    setSelectedOrgId(nextSelection);
    storeSelectedOrganizationId(nextSelection);
    sessionActive.current = false;
    onSelect(nextSelection);
  };

  const loadOrgData = async (orgId) => {
    try {
      // Load mappings and last sync time
      const [userMappingData, fieldMappingData, statusMappingData, issueTypeMappingData, projectMappingData, syncOptionsData, lastSyncData, rejectedFieldData] = await Promise.all([
        invoke('getUserMappings', { orgId }),
        invoke('getFieldMappings', { orgId }),
        invoke('getStatusMappings', { orgId }),
        invoke('getIssueTypeMappings', { orgId }),
        invoke('getProjectMappings', { orgId }),
        invoke('getSyncOptions', { orgId }),
        invoke('getLastSyncTime', { orgId }),
        invoke('getRejectedFields', { orgId })
      ]);

      if (userMappingData?.mappings) setUserMappings(userMappingData.mappings);
      if (fieldMappingData) setFieldMappings(fieldMappingData);
      if (statusMappingData) setStatusMappings(statusMappingData);
      if (issueTypeMappingData) setIssueTypeMappings(issueTypeMappingData);
      if (projectMappingData) setProjectMappings(projectMappingData);
      if (syncOptionsData) setSyncOptions(syncOptionsData);
      setAttachmentMaxMb(
        Number.isSafeInteger(syncOptionsData?.maxAttachmentSizeBytes)
          ? String(syncOptionsData.maxAttachmentSizeBytes / (1024 * 1024))
          : ''
      );
      if (lastSyncData?.lastSync) setLastSyncTime(lastSyncData.lastSync);
      if (rejectedFieldData?.fields) setRejectedFieldIds(rejectedFieldData.fields);
    } catch (error) {
      showMessage('Organization settings could not be loaded. Reload before editing.', 'error');
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

  const loadMappingData = async (localProjectKey) => {
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
        invoke('fetchLocalData', { orgId: selectedOrgId, localProjectKey: localProjectKey || undefined })
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
      const results = await Promise.allSettled([
        invoke('getScheduledSyncStats'), invoke('getWebhookSyncStats'),
        invoke('getApiUsageStats'), invoke('getPilotStatus')
      ]);
      const [scheduled, webhook, apiUsage, pilot] = results.map(result =>
        result.status === 'fulfilled' && result.value?.success !== false ? result.value : null
      );
      setSyncStats({ scheduled, webhook, apiUsage, pilot });
      if (results.some(result => result.status === 'rejected')) {
        showMessage('Some statistics are unavailable. Failed sources are not shown as current.', 'warning');
      }
    } catch (error) {
      showMessage('Error loading stats: ' + error.message, 'error');
    } finally {
      setStatsLoading(false);
    }
  };

  const showMessage = useCallback((msg, type = 'success', persistent = false) => {
    setMessage({ text: msg, type, persistent });
    // Persistent messages don't auto-dismiss (user must click to close)
    // Errors stay 15 seconds, success messages stay 5 seconds
    if (!persistent) {
      const duration = type === 'error' ? 15000 : 5000;
      setTimeout(() => setMessage(null), duration);
    }
  }, []);

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
      const { replacementRemoteApiToken, ...orgData } = data;

      if (editingOrg && replacementRemoteApiToken?.trim()) {
        const replaceResult = await invoke('replaceOrganizationToken', {
          orgId: editingOrg.id,
          remoteApiToken: replacementRemoteApiToken.trim()
        });
        if (!sessionActive.current) return;
        if (!replaceResult.success) {
          showMessage(`Error replacing API token: ${replaceResult.error}`, 'error');
          return;
        }
      }

      const result = editingOrg
        ? await invoke('updateOrganization', { id: editingOrg.id, ...orgData })
        : await invoke('addOrganization', { ...orgData, allowedProjects: [] });

      if (result.success) {
        showMessage(`Organization ${editingOrg ? 'updated' : 'added'} successfully`, 'success');
        await loadOrganizations();
        setShowOrgModal(false);
        setEditingOrg(null);
        if (!editingOrg && sessionActive.current) {
          navigate('organizations', 'setup');
          selectOrganization(result.organization.id);
        }
      } else {
        showMessage(`Error: ${result.error}`, 'error');
      }
    } catch (error) {
      showMessage('Error saving organization: ' + error.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteOrg = (orgId) => {
    const org = organizations.find(o => o.id === orgId);
    setOrgToDelete(org);
    setDeleteModalOpen(true);
  };

  const executeDeleteOrg = async () => {
    if (!orgToDelete) return;

    setSaving(true);
    try {
      const result = await invoke('deleteOrganization', { id: orgToDelete.id });
      if (result.success) {
        showMessage('Organization deleted successfully', 'success');
        const deletedId = orgToDelete.id;
        await loadOrganizations();
        if (selectedOrgId === deletedId) {
          // Require an explicit choice instead of silently editing another vendor.
          selectOrganization(null);
        }
      } else {
        showMessage(`Error: ${result.error}`, 'error');
      }
    } catch (error) {
      showMessage('Error deleting organization: ' + error.message, 'error');
    } finally {
      setSaving(false);
      setDeleteModalOpen(false);
      setOrgToDelete(null);
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
      // The project filter is saved on its own. The stored JQL filter is not
      // submitted here, so this action cannot clear or replace it; the JQL
      // editor submits the value explicitly, including an intentional clear.
      const result = await invoke('updateOrganization', {
        id: selectedOrg.id,
        name: selectedOrg.name,
        remoteUrl: selectedOrg.remoteUrl,
        remoteEmail: selectedOrg.remoteEmail,
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
        'issueType': issueTypeMappings,
        'project': projectMappings
      };
      const methodMap = {
        'user': 'saveUserMappings',
        'field': 'saveFieldMappings',
        'status': 'saveStatusMappings',
        'issueType': 'saveIssueTypeMappings',
        'project': 'saveProjectMappings'
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

    let maxAttachmentSizeBytes = null;
    if (attachmentMaxMb.trim() !== '') {
      const megabytes = Number(attachmentMaxMb);
      if (!Number.isFinite(megabytes) || megabytes <= 0) {
        showMessage('Maximum attachment size must be a positive number of megabytes, or blank to use Jira settings.', 'error');
        return;
      }
      maxAttachmentSizeBytes = Math.round(megabytes * 1024 * 1024);
    }

    setSaving(true);
    try {
      const result = await invoke('saveSyncOptions', {
        orgId: selectedOrgId,
        options: { ...syncOptions, maxAttachmentSizeBytes }
      });
      if (result.success) {
        setSyncOptions(previous => ({ ...previous, maxAttachmentSizeBytes }));
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
    if (!selectedOrgId) {
      showMessage('Please select an organization first', 'warning');
      return;
    }
    if (!manualIssueKey.trim()) return;

    setManualSyncLoading(true);
    try {
      const result = await invoke('forceSyncIssue', {
        issueKey: manualIssueKey.trim(),
        orgId: selectedOrgId
      });
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
    const { updateExisting = false, dryRun = false } = options;
    
    // Initialize or continue progress tracking
    const currentProgress = existingProgress || scanProgress || { 
      totalCreated: 0, 
      totalAlreadySynced: 0, 
      totalScanned: 0,
      runs: 0 
    };
    
    try {
      showMessage(`⏳ Starting ${dryRun ? 'DRY RUN' : 'bulk sync'}${updateExisting ? ' (updating existing)' : ''}...`, 'info', true);
      const result = await invoke('scanForDeletedIssues', { orgId: selectedOrgId, updateExisting, dryRun });
      
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
                const createdCount = (results.created || 0) + (results.recreated || 0);
                
                if (results.dryRun) {
                  parts.push(`[DRY RUN] Would create ${createdCount}, would update ${results.updated}`);
                } else {
                  if (createdCount > 0) parts.push(`${createdCount} created`);
                  if (results.updated) parts.push(`${results.updated} updated`);
                }
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
    
    // Check if invoke function is available
    if (typeof invoke !== 'function') {
      showMessage('Error: Bridge function not available. Please refresh the page.', 'error');
      return;
    }
    
    if (!options?.jql?.trim()) {
      showMessage('Enter a JQL query to export issues', 'error');
      return;
    }

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

      const result = await invoke('exportIssues', payload);
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
      showMessage('Error exporting issues: ' + error.message, 'error');
    } finally {
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

  const selectedOrg = organizationsLoadState.status === 'loaded'
    ? organizations.find(o => o.id === selectedOrgId) : null;
  return {
    organizations,
    selectedOrgId,
    loading,
    organizationsLoadState,
    saving,
    message,
    exportingSettings,
    importingSettings,
    importModalOpen,
    importData,
    importSections,
    importFileInputRef,
    issueImportFileInputRef,
    issueImportModalOpen,
    issueImportData,
    issueImportOptions,
    issueImporting,
    showOrgModal,
    setShowOrgModal,
    editingOrg,
    setEditingOrg,
    deleteModalOpen,
    setDeleteModalOpen,
    orgToDelete,
    remoteUsers,
    localUsers,
    remoteFields,
    localFields,
    remoteStatuses,
    localStatuses,
    remoteIssueTypes,
    localIssueTypes,
    localProjects,
    userMappings,
    setUserMappings,
    fieldMappings,
    setFieldMappings,
    statusMappings,
    setStatusMappings,
    issueTypeMappings,
    setIssueTypeMappings,
    projectMappings,
    setProjectMappings,
    rejectedFieldIds,
    syncOptions,
    setSyncOptions,
    attachmentMaxMb,
    setAttachmentMaxMb,
    syncStats,
    statsLoading,
    manualIssueKey,
    setManualIssueKey,
    manualSyncLoading,
    issueExporting,
    scanningDeleted,
    scanProgress,
    testingConnection,
    lastSyncTime,
    dataLoading,
    loadOrganizations,
    selectOrganization,
    loadProjects,
    loadMappingData,
    loadStats,
    showMessage,
    dismissMessage,
    handleExportSettings,
    handleImportButtonClick,
    handleImportFileChange,
    handleToggleImportSection,
    handleConfirmImportSettings,
    handleCloseImportModal,
    handleSaveOrg,
    handleDeleteOrg,
    executeDeleteOrg,
    handleTestConnection,
    handleAutoMatch,
    toggleProjectSelection,
    handleSaveProjectFilter,
    addMapping,
    deleteMapping,
    handleSaveMappings,
    handleSaveSyncOptions,
    handleManualSync,
    handleRetryPendingLinks,
    handleScanForDeletedIssues,
    handleCancelBulkSync,
    resetScanProgress,
    handleClearWebhookErrors,
    handleExportIssues,
    handleIssueImportClick,
    handleIssueImportFileChange,
    handleIssueImportOptionChange,
    handleConfirmIssueImport,
    handleCancelIssueImport,
    selectedOrg
  };
}
