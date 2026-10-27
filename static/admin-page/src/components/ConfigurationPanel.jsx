import React, { useState, useEffect } from 'react';
import { invoke } from '@forge/bridge';
import Button from '@atlaskit/button';
import TextField from '@atlaskit/textfield';
import Spinner from '@atlaskit/spinner';
import SectionMessage from '@atlaskit/section-message';
import Checkbox from '@atlaskit/checkbox';
import Lozenge from '@atlaskit/lozenge';
import { token } from '@atlaskit/tokens';
import { surfaceCard, lozengeButtonStyle } from '../dashboard/presentation';
// Configuration Panel Component
const ConfigurationPanel = ({
  selectedOrg, localProjects, loadProjects, dataLoading,
  toggleProjectSelection, handleSaveProjectFilter, syncOptions,
  setSyncOptions, attachmentMaxMb, setAttachmentMaxMb,
  handleSaveSyncOptions, saving,
  handleExportSettings, handleImportSettings, exportingSettings, importingSettings,
  onRefreshOrganizations, notify, section = 'connection'
}) => {
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [rotatedWebhookSigningSecret, setRotatedWebhookSigningSecret] = useState(null);
  const [rotatingWebhookSecret, setRotatingWebhookSecret] = useState(false);
  const gridGap = token('space.300', '24px');

  useEffect(() => {
    setRotatedWebhookSigningSecret(null);
  }, [selectedOrg?.id]);

  const handleRotateWebhookSecret = async () => {
    if (!selectedOrg?.id) {
      notify?.('Select an organization before rotating the webhook secret.', 'error');
      return;
    }
    if (selectedOrg.syncDirection !== 'bidirectional') {
      notify?.('Webhook rotation requires a bidirectional organization.', 'error');
      return;
    }
    if (!window.confirm('Rotate the incoming webhook secret? The current secret will stop working immediately.')) {
      return;
    }

    setRotatedWebhookSigningSecret(null);
    setRotatingWebhookSecret(true);
    try {
      const result = await invoke('rotateWebhookSecret', { orgId: selectedOrg.id });
      if (!result.success) {
        notify?.(`Error rotating webhook secret: ${result.error}`, 'error');
        return;
      }
      setRotatedWebhookSigningSecret(result.secret);
      notify?.('Signing secret rotated. Copy the one-time secret into Jira and update the callback URL together.', 'success');
      onRefreshOrganizations?.();
    } catch {
      notify?.('Error rotating webhook secret. Please try again.', 'error');
    } finally {
      setRotatingWebhookSecret(false);
    }
  };

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
      <div className="workflow-grid" style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr)',
        gap: gridGap,
        alignItems: 'stretch'
      }}>
        {section === 'connection' && <>
        <div style={surfaceCard({ display: 'flex', flexDirection: 'column' })}>
          <h4 style={{ margin: '0 0 12px 0' }}>Connection Settings</h4>
          <dl className="connection-details" style={{
            margin: 0,
            display: 'grid',
            gridTemplateColumns: '120px minmax(0, 1fr)',
            rowGap: token('space.100', '8px'),
            columnGap: token('space.150', '12px'),
            fontSize: '13px',
            color: '#6B778C',
            flex: 1
          }}>
            <dt style={{ fontWeight: 600 }}>URL</dt>
            <dd style={{ margin: 0, wordBreak: 'break-all' }}>{selectedOrg.remoteUrl || '—'}</dd>
            <dt style={{ fontWeight: 600 }}>Email</dt>
            <dd style={{ margin: 0, wordBreak: 'break-all' }}>{selectedOrg.remoteEmail || '—'}</dd>
            <dt style={{ fontWeight: 600 }}>Project</dt>
            <dd style={{ margin: 0 }}>{selectedOrg.remoteProjectKey || '—'}</dd>
            <dt style={{ fontWeight: 600 }}>API Token</dt>
            <dd style={{ margin: 0 }}>
              {selectedOrg.hasRemoteApiToken ? 'Configured' : 'Not configured'}
            </dd>
            <dt style={{ fontWeight: 600 }}>Direction</dt>
            <dd style={{ margin: 0 }}>
              <Lozenge appearance={selectedOrg.syncDirection === 'bidirectional' ? 'success' : 'default'}>
                {selectedOrg.syncDirection === 'bidirectional' ? 'Two-Way' : 'One-Way'}
              </Lozenge>
            </dd>

            {selectedOrg.syncDirection === 'bidirectional' && (
              <>
                <dt style={{ fontWeight: 600, alignSelf: 'start', marginTop: '4px' }}>Incoming URL</dt>
                <dd style={{ margin: 0 }}>
                  {selectedOrg.incomingWebhookUrl ? (
                    <code style={{
                      display: 'block',
                      padding: '4px 8px',
                      background: '#F4F5F7',
                      borderRadius: '4px',
                      fontSize: '11px',
                      wordBreak: 'break-all',
                      border: '1px solid #DFE1E6'
                    }}>
                      {selectedOrg.incomingWebhookUrl}
                    </code>
                  ) : (
                    <span style={{ fontStyle: 'italic', color: '#DE350B' }}>Not generated (Save Org first)</span>
                  )}
                </dd>
                <dt style={{ fontWeight: 600, alignSelf: 'start', marginTop: '4px' }}>Signing Secret (HMAC-SHA256)</dt>
                <dd style={{ margin: 0 }}>
                  <div style={{ marginBottom: '6px' }}>
                    {selectedOrg.webhookConfigured ? 'Configured' : 'Not configured'}
                    {selectedOrg.webhookSecretLastRotatedAt ? (
                      <span style={{ color: '#6B778C', marginLeft: '6px' }}>
                        (rotated {new Date(selectedOrg.webhookSecretLastRotatedAt).toLocaleString()})
                      </span>
                    ) : null}
                  </div>
                  <Button
                    appearance="subtle"
                    type="button"
                    isLoading={rotatingWebhookSecret}
                    onClick={handleRotateWebhookSecret}
                  >
                    Rotate Webhook Secret
                  </Button>
                  {rotatedWebhookSigningSecret ? (
                    <SectionMessage appearance="warning">
                      <p style={{ margin: '0 0 6px 0' }}>
                        One-time signing secret: copy this into the Jira System Webhook Secret field. Set the Incoming URL shown above in the same change. This secret cannot be retrieved again.
                      </p>
                      <code style={{
                        display: 'block',
                        padding: '6px 8px',
                        background: '#FFFFFF',
                        borderRadius: '4px',
                        fontSize: '11px',
                        wordBreak: 'break-all',
                        border: '1px solid #FFAB00'
                      }}>
                        {rotatedWebhookSigningSecret}
                      </code>
                      <Button appearance="subtle" type="button" onClick={() => setRotatedWebhookSigningSecret(null)}>
                        Dismiss
                      </Button>
                    </SectionMessage>
                  ) : null}
                </dd>
              </>
            )}
          </dl>
        </div>

        </>}
        {section === 'features' && <>
        <div style={surfaceCard({ display: 'flex', flexDirection: 'column', gap: token('space.150', '12px') })}>
          <h4 style={{ margin: 0 }}>Sync Options</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: token('space.100', '8px') }}>
            <SectionMessage appearance={syncOptions.syncAttachments ? 'information' : 'warning'}>
              <p style={{ margin: 0, fontSize: '13px' }}>
                {syncOptions.syncAttachments
                  ? 'Attachment synchronization is On. Transfers use Jira attachment IDs, the smaller of both Jira attachment limits, and any lower limit set below.'
                  : 'Attachment synchronization is Off. New organizations start with this setting off.'}
              </p>
              <p style={{ margin: '6px 0 0 0', fontSize: '12px' }}>
                Jira malware scanning is not performed by this connector. Rejected size, type, filename, mapping and permission cases are reported as safe status categories.
              </p>
            </SectionMessage>
            {[
              { key: 'syncComments', label: 'Sync Comments' },
              { key: 'syncAttachments', label: 'Synchronize attachments' },
              { key: 'syncLinks', label: 'Sync Issue Links' },
              { key: 'syncCrossReference', label: 'Add Cross-Reference in Description (show linked issue keys in both orgs)' },
              { key: 'recreateDeletedIssues', label: 'Recreate Deleted Issues (legacy setting; does not enable automatic counterpart replacement)' },
              { key: 'automaticReplacementAfterDeletion', label: 'Automatically recreate a confirmed deleted counterpart (explicit opt-in; push never recreates a deleted local issue)' }
            ].map(option => (
              <Checkbox
                key={option.key}
                label={option.label}
                name={option.key}
                isChecked={!!syncOptions[option.key]}
                onChange={(event) => setSyncOptions({ ...syncOptions, [option.key]: event.target.checked })}
              />
            ))}
            {syncOptions.syncAttachments && (
              <div style={{
                marginLeft: token('space.300', '24px'),
                paddingLeft: token('space.200', '16px'),
                borderLeft: `2px solid ${token('color.border', '#DFE1E6')}`,
                display: 'flex',
                flexDirection: 'column',
                gap: token('space.100', '8px')
              }}>
                <Checkbox
                  label="Propagate attachment deletions"
                  name="propagateAttachmentDeletions"
                  isChecked={!!syncOptions.propagateAttachmentDeletions}
                  onChange={(event) => setSyncOptions({
                    ...syncOptions,
                    propagateAttachmentDeletions: event.target.checked
                  })}
                />
                <div style={{ fontSize: '12px', color: '#6B778C' }}>
                  Off by default. When off, counterpart attachments and mapping history are retained. When on, only the explicitly mapped counterpart attachment is deleted; Jira issues are never deleted.
                </div>
                <label style={{ fontSize: '12px', fontWeight: 600 }}>
                  Maximum attachment size (MB)
                  <TextField
                    name="maxAttachmentSizeBytes"
                    type="number"
                    min="0"
                    step="0.1"
                    value={attachmentMaxMb}
                    placeholder="Use Jira attachment settings"
                    onChange={(event) => setAttachmentMaxMb(event.target.value)}
                    style={{ marginTop: '4px' }}
                  />
                </label>
                <div style={{ fontSize: '12px', color: '#6B778C' }}>
                  {attachmentMaxMb.trim() === ''
                    ? 'Configured maximum: Jira attachment settings (no lower connector limit).'
                    : `Configured maximum: ${attachmentMaxMb} MB, or the lower Jira attachment limit.`}
                </div>
              </div>
            )}
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

        </>}
        {section === 'transfer' && <>
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

        </>}
        {section === 'scope' && <>
        <div style={surfaceCard({ gridColumn: '1 / -1' })}>
          <div
            onClick={toggleProjects}
            role="button"
            tabIndex={0}
            aria-expanded={projectsExpanded}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleProjects(); }
            }}
            style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <div>
              <h4 style={{ margin: '0 0 4px 0' }}>Project Filter</h4>
              <div style={{ color: '#6B778C', fontSize: '13px' }}>Control which projects participate in source synchronization.</div>
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
                  <div className="workflow-grid" style={{
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
        </>}
      </div>
    </div>
  );
};

export default ConfigurationPanel;
