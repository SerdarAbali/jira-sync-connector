import React, { useState } from 'react';
import { invoke } from '@forge/bridge';
import Button from '@atlaskit/button';
import TextField from '@atlaskit/textfield';
import SectionMessage from '@atlaskit/section-message';
import ModalDialog, { ModalTransition, ModalHeader, ModalTitle, ModalBody, ModalFooter } from '@atlaskit/modal-dialog';
import Lozenge from '@atlaskit/lozenge';
import { token } from '@atlaskit/tokens';
import { surfaceCard, lozengeButtonStyle, formatDateTimeEuro } from '../dashboard/presentation';
import IssueExportImportSection from './IssueExportImportSection';
const StatCard = ({ label, value }) => <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
// Sync Activity Panel Component
const SyncOperations = ({
  manualIssueKey, setManualIssueKey, handleManualSync, manualSyncLoading,
  syncStats, loadStats, statsLoading, handleRetryPendingLinks, handleClearWebhookErrors,
  organizations, onExportIssues, issueExporting, onIssueImportClick, issueImporting,
  selectedOrg, syncOptions, handleScanForDeletedIssues, scanningDeleted,
  scanProgress, resetScanProgress, handleCancelBulkSync,
  showMessage, view = 'write-controls'
}) => {
  const [pilotConfirmAction, setPilotConfirmAction] = useState(null);
  const [pilotActionLoading, setPilotActionLoading] = useState(false);
  const [pilotActionError, setPilotActionError] = useState('');
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
  const executePilotAction = async () => {
    if (!pilotConfirmAction || pilotActionLoading) return;

    setPilotActionLoading(true);
    setPilotActionError('');
    try {
      const result = pilotConfirmAction === 'pause'
        ? await invoke('pausePilot', { reasonCode: 'emergency_stop' })
        : await invoke('resumePilot');

      if (result?.success) {
        setPilotConfirmAction(null);
        showMessage?.(
          pilotConfirmAction === 'pause' ? 'Jira writes paused' : 'Jira writes resumed',
          'success'
        );
        await loadStats();
      } else {
        setPilotActionError(result?.error || 'Unable to update synchronization write state');
      }
    } catch {
      setPilotActionError('Unable to update synchronization write state');
    } finally {
      setPilotActionLoading(false);
    }
  };

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


    // Generate JQL based on current selections
    const jqlQuery = generateJQL();

    // Check if JQL is provided
    if (!jqlQuery || !jqlQuery.trim()) {
      return;
    }

    if (!onExportIssues) {
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

  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: token('space.300', '24px') }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h3 style={{ margin: 0 }}>{view === 'write-controls' ? 'Installation write controls' : view === 'repair' ? 'Targeted repair' : 'Issue data transfer'}</h3>
          <p style={{ margin: '4px 0 0 0', color: '#6B778C', fontSize: '13px' }}>Write-capable operations require an explicit administrator action. Navigation never starts synchronization.</p>
        </div>
        <Button appearance="subtle" onClick={loadStats} isLoading={statsLoading} style={lozengeButtonStyle}>
          Refresh Stats
        </Button>
      </div>

      {view === 'write-controls' && typeof syncStats?.pilot?.paused === 'boolean' && syncStats.pilot.success !== false && (
        <div style={surfaceCard()} data-testid="pilot-pause-status">
          <h4 style={{ margin: '0 0 12px 0' }}>Synchronization Write Control · installation-wide</h4>
          <div className="workflow-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: token('space.200', '16px') }}>
            <StatCard
              label="Write Status"
              value={syncStats.pilot.paused ? 'PAUSED' : 'ACTIVE'}
              color={syncStats.pilot.paused ? '#DE350B' : '#00875A'}
            />
            <StatCard
              label="Paused At"
              value={syncStats.pilot.pausedAt ? formatDateTimeEuro(syncStats.pilot.pausedAt) : 'Not paused'}
              color="#6B778C"
            />
            <StatCard
              label="Paused By"
              value={syncStats.pilot.pausedBy || 'None'}
              color="#6B778C"
            />
            <StatCard
              label="Reason Code"
              value={syncStats.pilot.reasonCode || 'None'}
              color="#6B778C"
            />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: token('space.150', '12px'), marginTop: token('space.200', '16px') }}>
            <Button
              appearance="danger"
              onClick={() => {
                setPilotActionError('');
                setPilotConfirmAction('pause');
              }}
              isDisabled={pilotActionLoading || syncStats.pilot.paused}
              isLoading={pilotActionLoading && pilotConfirmAction === 'pause'}
            >
              Pause Synchronization
            </Button>
            <Button
              appearance="primary"
              onClick={() => {
                setPilotActionError('');
                setPilotConfirmAction('resume');
              }}
              isDisabled={pilotActionLoading || !syncStats.pilot.paused}
              isLoading={pilotActionLoading && pilotConfirmAction === 'resume'}
            >
              Resume Synchronization
            </Button>
          </div>
          {pilotActionError && (
            <div style={{ marginTop: token('space.150', '12px') }}>
              <SectionMessage appearance="error">
                <p style={{ margin: 0, fontSize: '13px' }}>{pilotActionError}</p>
              </SectionMessage>
            </div>
          )}
          {Array.isArray(syncStats.pilot.organizations) && syncStats.pilot.organizations.length > 0 && (
            <div style={{ marginTop: token('space.200', '16px') }}>
              <h5 style={{ margin: '0 0 8px 0' }}>Organization Sync Direction</h5>
              {syncStats.pilot.organizations.map(org => (
                <div key={org.id || org.name} style={{
                  padding: token('space.100', '8px'),
                  background: token('color.background.neutral.subtle', '#F4F5F7'),
                  borderRadius: token('border.radius', '8px'),
                  marginBottom: '4px',
                  fontSize: '13px'
                }}>
                  <strong>{org.name || org.id || 'Organization'}</strong>: {org.syncDirection}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {view === 'write-controls' && typeof syncStats?.pilot?.paused !== 'boolean' && <SectionMessage appearance="warning" title="Write state unavailable"><p>Refresh status before using emergency pause or resume controls.</p></SectionMessage>}
      <ModalTransition>
        {pilotConfirmAction && (
          <ModalDialog onClose={() => { if (!pilotActionLoading) setPilotConfirmAction(null); }}>
            <ModalHeader>
              <ModalTitle>
                {pilotConfirmAction === 'pause' ? 'Pause Synchronization?' : 'Resume Synchronization?'}
              </ModalTitle>
            </ModalHeader>
            <ModalBody>
              {pilotConfirmAction === 'pause' ? (
                <>
                  <p>
                    This immediately blocks all Jira issue, comment, attachment, link, and transition writes in both directions.
                  </p>
                  <SectionMessage appearance="warning" title="Reads remain available">
                    <p>
                      Mappings, issues, secrets, and organization configuration are not changed. The fixed reason code
                      <strong> emergency_stop</strong> is stored with your account ID.
                    </p>
                  </SectionMessage>
                </>
              ) : (
                <>
                  <p>
                    This allows Jira writes again using each organization's existing sync direction.
                  </p>
                  <SectionMessage appearance="info" title="No automatic replay">
                    <p>
                      Resume does not queue or replay webhook events and does not start an initial backfill. An explicitly approved initial-sync job stays paused until resumed separately.
                    </p>
                  </SectionMessage>
                </>
              )}
              {pilotActionError && (
                <div style={{ marginTop: token('space.150', '12px') }}>
                  <SectionMessage appearance="error">
                    <p style={{ margin: 0, fontSize: '13px' }}>{pilotActionError}</p>
                  </SectionMessage>
                </div>
              )}
            </ModalBody>
            <ModalFooter>
              <Button
                appearance="subtle"
                onClick={() => setPilotConfirmAction(null)}
                isDisabled={pilotActionLoading}
              >
                Cancel
              </Button>
              <Button
                appearance={pilotConfirmAction === 'pause' ? 'danger' : 'primary'}
                onClick={executePilotAction}
                isLoading={pilotActionLoading}
                isDisabled={pilotActionLoading}
              >
                {pilotConfirmAction === 'pause' ? 'Pause Synchronization' : 'Resume Synchronization'}
              </Button>
            </ModalFooter>
          </ModalDialog>
        )}
      </ModalTransition>

      {/* Background Maintenance */}
      {view === 'repair' && <div style={{ marginTop: token('space.300', '24px') }}>
        <h4 style={{ margin: '0 0 4px 0' }}>Background Maintenance</h4>
        <p style={{ fontSize: '13px', color: '#6B778C', margin: '0 0 16px 0' }}>
          Targeted repair actions for manual issue sync and pending links. These actions do not change sync scope or mappings.
        </p>
        <div className="workflow-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: token('space.300', '24px') }}>
          {/* Manual Sync - Compact */}
          <div style={surfaceCard()}>
            <h4 style={{ margin: '0 0 4px 0' }}>Manual Sync</h4>
            <p style={{ fontSize: '13px', color: '#6B778C', margin: '0 0 12px 0' }}>
              Sync a specific issue to the selected organization.
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
              <Lozenge appearance="success">Hourly maintenance</Lozenge>
            </div>
            <p style={{ fontSize: '13px', color: '#006644', margin: '0 0 12px 0' }}>
              Retry syncing pending links across all orgs.
            </p>
            <Button appearance="subtle" onClick={handleRetryPendingLinks} style={lozengeButtonStyle}>
              Retry All Pending Links
            </Button>
          </div>
        </div>
      </div>

      }
      {/* Issue Export/Import Section - Collapsible */}
      {view === 'transfer' && (
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
      )}
    </div>
  );
};

export default SyncOperations;
