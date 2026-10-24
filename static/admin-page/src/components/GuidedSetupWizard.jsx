import React, { useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';
import Button from '@atlaskit/button';
import TextField from '@atlaskit/textfield';
import Select from '@atlaskit/select';
import Checkbox from '@atlaskit/checkbox';
import SectionMessage from '@atlaskit/section-message';
import Lozenge from '@atlaskit/lozenge';
import Spinner from '@atlaskit/spinner';
import { token } from '@atlaskit/tokens';
import InitialSyncPanel from './InitialSyncPanel';

const surfaceCard = (overrides = {}) => ({
  background: token('color.background.neutral', '#FFFFFF'),
  borderRadius: token('border.radius', '8px'),
  border: `1px solid ${token('color.border', '#DFE1E6')}`,
  boxShadow: token('elevation.shadow.raised', '0 1px 2px rgba(9, 30, 66, 0.15)'),
  padding: token('space.300', '24px'),
  ...overrides
});

const stepChipStyle = (active, completed) => ({
  border: `1px solid ${active || completed ? token('color.border.brand', '#4C9AFF') : token('color.border', '#DFE1E6')}`,
  background: active
    ? token('color.background.selected', '#DEEBFF')
    : completed
      ? token('color.background.success.subtle', '#E3FCEF')
      : token('color.background.neutral', '#FFFFFF'),
  color: token('color.text', '#172B4D'),
  borderRadius: token('border.radius', '6px'),
  padding: '6px 10px',
  fontSize: '12px',
  cursor: 'pointer',
  textAlign: 'left'
});

const fieldLabel = {
  display: 'block',
  marginBottom: token('space.075', '6px'),
  fontSize: '12px',
  fontWeight: 600,
  color: token('color.text.subtle', '#6B778C')
};

const staticOptions = Object.freeze({
  syncComments: true,
  syncCrossReference: true,
  syncLinks: true,
  syncAttachments: false,
  propagateAttachmentDeletions: false,
  maxAttachmentSizeBytes: null
});

function ValidationMessages({ result, title = 'Validation details' }) {
  if (!result) return null;
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  if (errors.length === 0 && warnings.length === 0) return null;
  return (
    <div style={{ display: 'grid', gap: token('space.100', '8px'), marginTop: token('space.200', '16px') }}>
      {errors.length > 0 && (
        <SectionMessage appearance="error" title={`${title}: errors`}>
          <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px' }}>
            {errors.map((message, index) => <li key={`${message}-${index}`}>{message}</li>)}
          </ul>
        </SectionMessage>
      )}
      {warnings.length > 0 && (
        <SectionMessage appearance="warning" title="Optional warnings">
          <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px' }}>
            {warnings.map((message, index) => <li key={`${message}-${index}`}>{message}</li>)}
          </ul>
        </SectionMessage>
      )}
    </div>
  );
}

function CountCard({ label, value, color }) {
  return (
    <div style={{
      padding: token('space.150', '12px'),
      borderRadius: token('border.radius', '8px'),
      background: token('color.background.neutral.subtle', '#F4F5F7'),
      borderLeft: `3px solid ${color}`
    }}>
      <div style={{ fontSize: '11px', color: token('color.text.subtle', '#6B778C'), textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: '20px', fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function StepHeader({ title, description }) {
  return (
    <div>
      <h3 style={{ margin: 0, fontSize: '18px' }}>{title}</h3>
      <p style={{ margin: '6px 0 0 0', color: token('color.text.subtle', '#6B778C'), fontSize: '13px' }}>{description}</p>
    </div>
  );
}

function ScopeCounts({ counts }) {
  if (!counts) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: token('space.150', '12px'), marginTop: token('space.200', '16px') }}>
      <CountCard label="Matching" value={counts.matchingIssueCount || 0} color="#0052CC" />
      <CountCard label="Eligible" value={counts.eligible || 0} color="#00875A" />
      <CountCard label="Already mapped" value={counts.alreadyMapped || 0} color="#403294" />
      <CountCard label="Blocked" value={counts.blockedByValidation || 0} color="#FF991F" />
      <CountCard label="Conflicts" value={counts.mappingConflicts || 0} color="#DE350B" />
    </div>
  );
}

async function updateOrganizationFromWizard(org, overrides = {}) {
  return await invoke('updateOrganization', {
    id: org.id,
    name: org.name,
    remoteUrl: org.remoteUrl,
    remoteEmail: org.remoteEmail,
    remoteProjectKey: org.remoteProjectKey,
    allowedProjects: org.allowedProjects || [],
    jqlFilter: org.jqlFilter || '',
    syncDirection: org.syncDirection || 'push',
    ...overrides
  });
}
function ConnectionStep({ org, saving, validation, onRefresh, onSaveStep, showMessage }) {
  const [name, setName] = useState(org?.name || '');
  const [remoteUrl, setRemoteUrl] = useState(org?.remoteUrl || '');
  const [remoteEmail, setRemoteEmail] = useState(org?.remoteEmail || '');
  const [remoteProjectKey, setRemoteProjectKey] = useState(org?.remoteProjectKey || '');
  const [apiToken, setApiToken] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setName(org?.name || '');
    setRemoteUrl(org?.remoteUrl || '');
    setRemoteEmail(org?.remoteEmail || '');
    setRemoteProjectKey(org?.remoteProjectKey || '');
    setApiToken('');
    setError('');
  }, [org?.id]);

  const save = async () => {
    setError('');
    if (!org?.id) {
      setError('Select an organization first.');
      return;
    }
    if (!name.trim() || !remoteUrl.trim() || !remoteEmail.trim() || !remoteProjectKey.trim()) {
      setError('Organization name, Jira URL, email and destination project are required.');
      return;
    }
    if (!org.hasRemoteApiToken && !apiToken.trim()) {
      setError('Enter an API token. It is written only to secure storage and is never shown again.');
      return;
    }

    try {
      if (apiToken.trim()) {
        const tokenResult = await invoke('replaceOrganizationToken', {
          orgId: org.id,
          remoteApiToken: apiToken.trim()
        });
        if (!tokenResult?.success) {
          setError(tokenResult?.error || 'The API token could not be saved.');
          return;
        }
      }

      const update = await updateOrganizationFromWizard(org, {
        name: name.trim(),
        remoteUrl: remoteUrl.trim(),
        remoteEmail: remoteEmail.trim(),
        remoteProjectKey: remoteProjectKey.trim()
      });
      if (!update?.success) {
        setError(update?.error || 'Organization details could not be saved.');
        return;
      }

      await onRefresh();
      const result = await onSaveStep('connection');
      if (!result?.success) {
        setError('Connection details were saved, but authentication or project access did not pass.');
      } else {
        showMessage?.('Remote authentication and destination project access verified.', 'success');
      }
    } catch (err) {
      setError(err?.message || 'Connection setup failed.');
    } finally {
      setApiToken('');
    }
  };

  return (
    <div style={surfaceCard()}>
      <StepHeader
        title="1. Remote Jira connection"
        description="Connection details are saved through the existing organization configuration. The API token uses the existing write-only secret storage."
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: token('space.200', '16px'), marginTop: token('space.300', '24px') }}>
        <label>
          <span style={fieldLabel}>Organization name</span>
          <TextField value={name} onChange={event => setName(event.target.value)} isDisabled={saving} />
        </label>
        <label>
          <span style={fieldLabel}>Remote Jira HTTPS URL</span>
          <TextField value={remoteUrl} onChange={event => setRemoteUrl(event.target.value)} placeholder="https://example.atlassian.net" isDisabled={saving} />
        </label>
        <label>
          <span style={fieldLabel}>Email</span>
          <TextField type="email" value={remoteEmail} onChange={event => setRemoteEmail(event.target.value)} isDisabled={saving} autoComplete="off" />
        </label>
        <label>
          <span style={fieldLabel}>API token (write-only)</span>
          <TextField
            type="password"
            value={apiToken}
            onChange={event => setApiToken(event.target.value)}
            placeholder={org?.hasRemoteApiToken ? 'Stored token exists — leave blank to keep it' : 'Enter API token'}
            isDisabled={saving}
            autoComplete="new-password"
            data-testid="setup-api-token"
          />
        </label>
        <label>
          <span style={fieldLabel}>Destination project key</span>
          <TextField value={remoteProjectKey} onChange={event => setRemoteProjectKey(event.target.value)} isDisabled={saving} />
        </label>
      </div>
      <div style={{ marginTop: token('space.150', '12px'), fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
        {org?.hasRemoteApiToken
          ? 'A token is already stored. It is never loaded into this page.'
          : 'No token is stored yet. The token field is cleared immediately after the save attempt.'}
      </div>
      {error && (
        <div style={{ marginTop: token('space.200', '16px') }}>
          <SectionMessage appearance="error"><p style={{ margin: 0, fontSize: '13px' }}>{error}</p></SectionMessage>
        </div>
      )}
      <ValidationMessages result={validation} title="Connection validation" />
      <div style={{ marginTop: token('space.200', '16px') }}>
        <Button appearance="primary" onClick={save} isLoading={saving} isDisabled={saving}>
          Save and Verify Connection
        </Button>
      </div>
    </div>
  );
}

function ScopeStep({ org, saving, validation, onRefresh, onSaveStep, showMessage, onOpenAdministration }) {
  const [projects, setProjects] = useState([]);
  const [selectedProjects, setSelectedProjects] = useState(org?.allowedProjects || []);
  const [jqlFilter, setJqlFilter] = useState(org?.jqlFilter || '');
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setSelectedProjects(org?.allowedProjects || []);
    setJqlFilter(org?.jqlFilter || '');
    setError('');
  }, [org?.id]);

  const loadProjects = async () => {
    setLoadingProjects(true);
    try {
      const result = await invoke('fetchLocalProjects');
      setProjects(Array.isArray(result?.projects) ? result.projects : []);
    } catch {
      setError('Local projects could not be loaded. Existing allowed-project selections are preserved.');
    } finally {
      setLoadingProjects(false);
    }
  };

  useEffect(() => {
    loadProjects();
  }, [org?.id]);

  const toggleProject = (projectKey) => {
    setSelectedProjects(projectsSelected => projectsSelected.includes(projectKey)
      ? projectsSelected.filter(key => key !== projectKey)
      : [...projectsSelected, projectKey]);
  };

  const save = async () => {
    setError('');
    if (selectedProjects.length === 0) {
      setError('Select at least one source project.');
      return;
    }
    try {
      const update = await updateOrganizationFromWizard(org, {
        allowedProjects: selectedProjects,
        jqlFilter: jqlFilter.trim()
      });
      if (!update?.success) {
        setError(update?.error || 'Source scope could not be saved.');
        return;
      }
      await onRefresh();
      const result = await onSaveStep('scope');
      if (!result?.success) {
        setError('Scope was saved, but project or JQL validation did not pass.');
      } else {
        showMessage?.('Source scope validated with a read-only Jira search.', 'success');
      }
    } catch (err) {
      setError(err?.message || 'Source scope validation failed.');
    }
  };

  const counts = validation?.summary?.counts || null;

  return (
    <div style={surfaceCard()}>
      <StepHeader
        title="2. Source scope"
        description="Reuse the existing allowedProjects selection and optional JQL. Validation is read-only and never writes to Jira."
      />
      <div style={{ marginTop: token('space.300', '24px') }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: token('space.150', '12px'), flexWrap: 'wrap' }}>
          <strong style={{ fontSize: '13px' }}>Source projects</strong>
          <Button appearance="subtle" onClick={loadProjects} isLoading={loadingProjects}>
            {projects.length > 0 ? 'Reload Projects' : 'Load Projects'}
          </Button>
        </div>
        {projects.length === 0 ? (
          <p style={{ fontSize: '13px', color: token('color.text.subtle', '#6B778C') }}>
            Existing selections: {(org?.allowedProjects || []).join(', ') || 'none'}.
          </p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: token('space.100', '8px'), marginTop: token('space.100', '8px') }}>
            {projects.map(project => (
              <Checkbox
                key={project.key}
                label={`${project.key} — ${project.name}`}
                isChecked={selectedProjects.includes(project.key)}
                onChange={() => toggleProject(project.key)}
                isDisabled={saving}
              />
            ))}
          </div>
        )}
      </div>

      <label style={{ display: 'block', marginTop: token('space.200', '16px') }}>
        <span style={fieldLabel}>Optional JQL (combined with each selected project)</span>
        <TextField
          value={jqlFilter}
          onChange={event => setJqlFilter(event.target.value)}
          placeholder="labels = ready-for-sync"
          maxLength={500}
          isDisabled={saving}
        />
      </label>

      {error && (
        <div style={{ marginTop: token('space.200', '16px') }}>
          <SectionMessage appearance="error"><p style={{ margin: 0, fontSize: '13px' }}>{error}</p></SectionMessage>
        </div>
      )}
      <ValidationMessages result={validation} title="Scope validation" />
      <ScopeCounts counts={counts} />
      {counts && (
        <p style={{ fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
          This count came from the existing read-only initial-sync preview. No issue was created, updated, transitioned or deleted.
        </p>
      )}

      <div style={{ marginTop: token('space.200', '16px'), display: 'flex', gap: token('space.150', '12px'), flexWrap: 'wrap' }}>
        <Button appearance="primary" onClick={save} isLoading={saving} isDisabled={saving}>
          Save Scope and Count Issues
        </Button>
        <Button appearance="subtle" onClick={onOpenAdministration}>
          Open Current Administration
        </Button>
      </div>
    </div>
  );
}

function DirectionStep({ org, saving, validation, onRefresh, onSaveStep, showMessage }) {
  const [direction, setDirection] = useState(org?.syncDirection || 'push');
  const [error, setError] = useState('');

  useEffect(() => {
    setDirection(org?.syncDirection || 'push');
    setError('');
  }, [org?.id]);

  const options = [
    { label: 'One-Way (Push Only)', value: 'push' },
    { label: 'Two-Way (Bidirectional)', value: 'bidirectional' }
  ];

  const save = async () => {
    setError('');
    try {
      const update = await updateOrganizationFromWizard(org, { syncDirection: direction });
      if (!update?.success) {
        setError(update?.error || 'Direction could not be saved.');
        return;
      }
      await onRefresh();
      const result = await onSaveStep('direction');
      if (!result?.success) setError('Direction was saved but validation did not pass.');
      else showMessage?.(`Direction validated: ${direction}.`, 'success');
    } catch (err) {
      setError(err?.message || 'Direction validation failed.');
    }
  };

  return (
    <div style={surfaceCard()}>
      <StepHeader
        title="3. Direction"
        description="This uses the organization's existing syncDirection setting. No additional operating-mode system is added."
      />
      <div style={{ marginTop: token('space.300', '24px'), maxWidth: '420px' }}>
        <span style={fieldLabel}>Existing synchronization direction</span>
        <Select
          options={options}
          value={options.find(option => option.value === direction)}
          onChange={option => setDirection(option?.value || 'push')}
          isDisabled={saving}
          isSearchable={false}
        />
      </div>
      <SectionMessage appearance="information">
        <p style={{ margin: 0, fontSize: '13px' }}>
          Push mode synchronizes source-to-target only. Bidirectional mode also requires the existing incoming webhook and authenticated webhook events.
        </p>
      </SectionMessage>
      {error && (
        <div style={{ marginTop: token('space.200', '16px') }}>
          <SectionMessage appearance="error"><p style={{ margin: 0, fontSize: '13px' }}>{error}</p></SectionMessage>
        </div>
      )}
      <ValidationMessages result={validation} title="Direction validation" />
      <div style={{ marginTop: token('space.200', '16px') }}>
        <Button appearance="primary" onClick={save} isLoading={saving} isDisabled={saving}>
          Save and Validate Direction
        </Button>
      </div>
    </div>
  );
}

function MappingsStep({ org, saving, validation, onSaveStep, showMessage, onOpenMappings }) {
  const [counts, setCounts] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadCounts = async () => {
    if (!org?.id) return;
    setLoading(true);
    try {
      const [users, fields, statuses, issueTypes, projects] = await Promise.all([
        invoke('getUserMappings', { orgId: org.id }),
        invoke('getFieldMappings', { orgId: org.id }),
        invoke('getStatusMappings', { orgId: org.id }),
        invoke('getIssueTypeMappings', { orgId: org.id }),
        invoke('getProjectMappings', { orgId: org.id })
      ]);
      setCounts({
        users: Object.keys(users?.mappings || users || {}).length,
        fields: Object.keys(fields || {}).length,
        statuses: Object.keys(statuses || {}).length,
        issueTypes: Object.keys(issueTypes || {}).length,
        projects: Object.keys(projects || {}).length
      });
    } catch {
      setError('Existing mappings could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCounts();
  }, [org?.id]);

  const validate = async () => {
    setError('');
    const result = await onSaveStep('mappings');
    if (!result?.success) setError('Required mapping validation failed. Optional warnings can be reviewed below.');
    else showMessage?.('Existing mappings validated.', 'success');
  };

  const summary = validation?.summary || {};
  const displayed = counts || {
    users: summary.userMappings || 0,
    fields: summary.fieldMappings || 0,
    statuses: summary.statusMappings || 0,
    issueTypes: summary.issueTypeMappings || 0,
    projects: summary.projectMappings || 0
  };

  return (
    <div style={surfaceCard()}>
      <StepHeader
        title="4. Mappings"
        description="The wizard reads the existing project, issue type, status, user, field and custom-field mappings. It does not create a second mapping store."
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: token('space.150', '12px'), marginTop: token('space.300', '24px') }}>
        <CountCard label="Projects" value={displayed.projects} color="#0052CC" />
        <CountCard label="Issue types" value={displayed.issueTypes} color="#403294" />
        <CountCard label="Statuses" value={displayed.statuses} color="#00875A" />
        <CountCard label="Users" value={displayed.users} color="#FF991F" />
        <CountCard label="Fields" value={displayed.fields} color="#6554C0" />
      </div>
      <SectionMessage appearance="information">
        <p style={{ margin: 0, fontSize: '13px' }}>
          Priority values continue to use the existing field and issue-data behavior. Project mappings fall back to the destination project when a source-specific mapping is absent.
        </p>
      </SectionMessage>
      {error && (
        <div style={{ marginTop: token('space.200', '16px') }}>
          <SectionMessage appearance="error"><p style={{ margin: 0, fontSize: '13px' }}>{error}</p></SectionMessage>
        </div>
      )}
      <ValidationMessages result={validation} title="Mapping validation" />
      <div style={{ marginTop: token('space.200', '16px'), display: 'flex', gap: token('space.150', '12px'), flexWrap: 'wrap' }}>
        <Button appearance="primary" onClick={validate} isLoading={saving || loading} isDisabled={saving}>
          Validate Required Mappings
        </Button>
        <Button appearance="subtle" onClick={onOpenMappings}>
          Open Existing Mapping Editor
        </Button>
        <Button appearance="subtle" onClick={loadCounts} isLoading={loading}>
          Refresh Counts
        </Button>
      </div>
    </div>
  );
}

function FeaturesStep({ org, saving, validation, onSaveStep, showMessage }) {
  const [options, setOptions] = useState({ ...staticOptions });
  const [maxMb, setMaxMb] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!org?.id) return;
      setLoading(true);
      try {
        const stored = await invoke('getSyncOptions', { orgId: org.id });
        if (!cancelled) {
          setOptions({ ...staticOptions, ...(stored || {}) });
          setMaxMb(Number.isSafeInteger(stored?.maxAttachmentSizeBytes)
            ? String(stored.maxAttachmentSizeBytes / (1024 * 1024))
            : '');
        }
      } catch {
        if (!cancelled) setError('Existing feature options could not be loaded.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [org?.id]);

  const update = (key, value) => {
    setOptions(current => {
      const next = { ...current, [key]: value };
      if (!next.syncAttachments) next.propagateAttachmentDeletions = false;
      return next;
    });
  };

  const save = async () => {
    setError('');
    const maxAttachmentSizeBytes = maxMb.trim() === ''
      ? null
      : Math.round(Number(maxMb) * 1024 * 1024);
    if (maxAttachmentSizeBytes !== null
        && (!Number.isSafeInteger(maxAttachmentSizeBytes) || maxAttachmentSizeBytes <= 0)) {
      setError('Maximum attachment size must be a positive number of megabytes.');
      return;
    }

    try {
      const stored = await invoke('saveSyncOptions', {
        orgId: org.id,
        options: {
          ...options,
          maxAttachmentSizeBytes,
          propagateAttachmentDeletions: options.syncAttachments
            && options.propagateAttachmentDeletions === true
        }
      });
      if (!stored?.success) {
        setError(stored?.error || 'Feature options could not be saved.');
        return;
      }
      const result = await onSaveStep('features');
      if (!result?.success) setError('Feature options were saved but validation did not pass.');
      else showMessage?.('Existing feature options validated.', 'success');
    } catch (err) {
      setError(err?.message || 'Feature options could not be saved.');
    }
  };

  return (
    <div style={surfaceCard()}>
      <StepHeader
        title="5. Features"
        description="These controls reuse the organization's existing syncOptions record. No second feature model is created."
      />
      {loading ? <Spinner /> : (
        <div style={{ display: 'grid', gap: token('space.150', '12px'), marginTop: token('space.300', '24px') }}>
          <Checkbox
            label="Comments"
            isChecked={options.syncComments === true}
            onChange={event => update('syncComments', event.target.checked)}
            isDisabled={saving}
          />
          <Checkbox
            label="Cross-reference in descriptions"
            isChecked={options.syncCrossReference === true}
            onChange={event => update('syncCrossReference', event.target.checked)}
            isDisabled={saving}
          />
          <div style={{ fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
            Descriptions use the existing field synchronization behavior. The option above controls the cross-reference added to descriptions.
          </div>
          <div style={{ fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
            Status transitions use the existing status mappings and transition behavior. No additional status feature switch is introduced.
          </div>
          <Checkbox
            label="Issue links"
            isChecked={options.syncLinks === true}
            onChange={event => update('syncLinks', event.target.checked)}
            isDisabled={saving}
          />
          <Checkbox
            label="Automatic counterpart replacement after confirmed deletion (default Off)"
            isChecked={options.automaticReplacementAfterDeletion === true}
            onChange={event => update('automaticReplacementAfterDeletion', event.target.checked)}
            isDisabled={saving}
          />
          <div style={{ fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
            This is separate from the legacy Recreate Deleted Issues value. It remains Off until an administrator explicitly enables it. Push may recreate a deleted remote counterpart from the surviving local issue; a deleted local issue is recreated only in bidirectional mode.
          </div>
          <Checkbox
            label="Secure attachments"
            isChecked={options.syncAttachments === true}
            onChange={event => update('syncAttachments', event.target.checked)}
            isDisabled={saving}
          />
          <Checkbox
            label="Attachment deletion propagation (separate, default Off)"
            isChecked={options.propagateAttachmentDeletions === true}
            onChange={event => update('propagateAttachmentDeletions', event.target.checked)}
            isDisabled={saving || options.syncAttachments !== true}
          />
          <label style={{ maxWidth: '320px' }}>
            <span style={fieldLabel}>Lower attachment limit in MB (optional)</span>
            <TextField
              value={maxMb}
              onChange={event => setMaxMb(event.target.value)}
              placeholder="Use Jira limits"
              isDisabled={saving || options.syncAttachments !== true}
            />
          </label>
        </div>
      )}
      {error && (
        <div style={{ marginTop: token('space.200', '16px') }}>
          <SectionMessage appearance="error"><p style={{ margin: 0, fontSize: '13px' }}>{error}</p></SectionMessage>
        </div>
      )}
      <ValidationMessages result={validation} title="Feature validation" />
      <div style={{ marginTop: token('space.200', '16px') }}>
        <Button appearance="primary" onClick={save} isLoading={saving} isDisabled={saving || loading}>
          Save and Validate Features
        </Button>
      </div>
    </div>
  );
}

function WebhookStep({
  org,
  saving,
  validation,
  requiredEvents,
  onRefresh,
  onSaveStep,
  showMessage
}) {
  const [callbackUrl, setCallbackUrl] = useState(null);
  const [signingSecret, setSigningSecret] = useState(null);
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState('');
  const required = org?.syncDirection === 'bidirectional';

  useEffect(() => {
    setCallbackUrl(null);
    setSigningSecret(null);
    setError('');
  }, [org?.id]);

  const rotate = async () => {
    if (org?.webhookConfigured && !window.confirm('Rotate the signing secret? Existing signed deliveries stop working immediately. Update Jira during a planned change.')) return;
    setSigningSecret(null);
    setError('');
    setRotating(true);
    try {
      const result = await invoke('rotateWebhookSecret', { orgId: org.id });
      if (!result?.success) {
        setError(result?.error || 'The webhook credential could not be rotated.');
        return;
      }
      setCallbackUrl(result.callbackUrl || null);
      setSigningSecret(result.secret || null);
      await onRefresh();
      showMessage?.(result.message || 'Copy the signing secret into Jira now. It cannot be retrieved again.', 'success');
    } catch (err) {
      setError(err?.message || 'The webhook credential could not be rotated.');
    } finally {
      setRotating(false);
    }
  };

  const copyCallback = async () => {
    if (!callbackUrl) return;
    try {
      await navigator.clipboard.writeText(callbackUrl);
      showMessage?.('Callback URL copied.', 'success');
    } catch {
      setError('Clipboard access failed. Select and copy the URL manually.');
    }
  };

  const verify = async () => {
    setError('');
    const result = await onSaveStep('webhook');
    if (!result?.success) {
      setError('No fresh authenticated webhook event has been verified yet. Confirm the Jira webhook and retry.');
      return;
    }
    setCallbackUrl(null);
    setSigningSecret(null);
    showMessage?.('Authenticated webhook event verified.', 'success');
  };

  return (
    <div style={surfaceCard()}>
      <StepHeader
        title="6. Webhook"
        description={required
          ? 'Bidirectional mode requires the HMAC-SHA256 signing secret, credential-free callback URL and an authenticated event received by this app.'
          : 'Push mode does not require an incoming Jira webhook. This step is recorded as not required.'}
      />
      {!required ? (
        <SectionMessage appearance="success">
          <p style={{ margin: 0, fontSize: '13px' }}>Webhook verification is skipped for push-only synchronization.</p>
        </SectionMessage>
      ) : (
        <>
          <div style={{ display: 'flex', gap: token('space.150', '12px'), flexWrap: 'wrap', marginTop: token('space.200', '16px') }}>
            <Button appearance="subtle" onClick={rotate} isLoading={rotating} isDisabled={saving || rotating}>
              {org?.webhookConfigured ? 'Rotate Webhook Credential' : 'Create Webhook Credential'}
            </Button>
            <Button appearance="primary" onClick={verify} isLoading={saving} isDisabled={saving || rotating}>
              Verify Authenticated Event
            </Button>
          </div>

          {signingSecret && <SectionMessage appearance="warning">
            <p>One-time signing secret — paste into the Jira System Webhook Secret field. Rotation invalidates the previous key immediately.</p>
            <code style={{ wordBreak: 'break-all' }}>{signingSecret}</code>
            <Button appearance="subtle" onClick={() => setSigningSecret(null)}>Dismiss secret</Button>
          </SectionMessage>}
          {callbackUrl && (
            <div style={{ marginTop: token('space.200', '16px'), padding: token('space.150', '12px'), background: '#FFFAE6', border: '1px solid #FFC400', borderRadius: '6px' }}>
              <strong style={{ fontSize: '13px' }}>Callback URL</strong>
              <p style={{ margin: '4px 0 8px 0', fontSize: '12px' }}>Set this URL and the one-time signing secret below together in Jira System Webhooks. Keep Exclude body unchecked.</p>
              <code style={{ display: 'block', fontSize: '12px', wordBreak: 'break-all', background: '#FFFFFF', padding: '8px', borderRadius: '4px' }}>{callbackUrl}</code>
              <Button appearance="subtle" onClick={copyCallback} style={{ marginTop: '8px' }}>Copy Callback URL</Button>
            </div>
          )}

          <div style={{ marginTop: token('space.200', '16px') }}>
            <strong style={{ fontSize: '13px' }}>Required Jira webhook events</strong>
            <ul style={{ fontSize: '12px', columns: 2, marginTop: token('space.100', '8px') }}>
              {requiredEvents.map(event => <li key={event}><code>{event}</code></li>)}
            </ul>
          </div>
          <div style={{ fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
            Last authenticated event: {org?.lastAuthenticatedWebhookAt || 'none yet'}.
          </div>
        </>
      )}
      {error && (
        <div style={{ marginTop: token('space.200', '16px') }}>
          <SectionMessage appearance="error"><p style={{ margin: 0, fontSize: '13px' }}>{error}</p></SectionMessage>
        </div>
      )}
      <ValidationMessages result={validation} title="Webhook validation" />
      {!required && (
        <div style={{ marginTop: token('space.200', '16px') }}>
          <Button appearance="primary" onClick={verify} isLoading={saving} isDisabled={saving}>
            Continue Without Webhook
          </Button>
        </div>
      )}
    </div>
  );
}

function CommunicationStep({ org, saving, validation, onSaveStep, showMessage }) {
  const [approved, setApproved] = useState(false);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState('');
  const bidirectional = org?.syncDirection === 'bidirectional';
  const summary = validation?.summary || null;

  const run = async () => {
    setError('');
    if (!approved) {
      setError('Explicit administrator approval is required.');
      return;
    }
    try {
      const healthResult = await invoke('runHealthCheck', { orgId: org.id });
      setHealth(healthResult);
      if (!healthResult?.success) {
        setError('The existing read-only diagnostics health check did not pass.');
        return;
      }
    } catch {
      setError('The existing read-only diagnostics health check could not run.');
      return;
    }

    const result = await onSaveStep('communication', { approved: true });
    if (!result?.success) setError('The read-only connectivity/readiness preflight did not pass.');
    else showMessage?.('Read-only connectivity/readiness preflight passed; no Jira write occurred.', 'success');
  };

  return (
    <div style={surfaceCard()}>
      <StepHeader
        title="7. Communication preflight"
        description="This administrator-approved, read-only preflight checks authentication, project permissions, mappings and inbound readiness. It does not synchronize, create, update or delete any Jira issue."
      />
      <SectionMessage appearance="warning">
        <p style={{ margin: 0, fontSize: '13px' }}>
          A passing result means connectivity and readiness only. It is not proof that end-to-end synchronization works. No Jira write occurs, and full end-to-end synchronization remains part of later manual testing.
        </p>
      </SectionMessage>
      {health && (
        <div style={{ marginTop: token('space.150', '12px'), padding: token('space.150', '12px'), background: '#F4F5F7', borderRadius: '6px' }}>
          <strong style={{ fontSize: '13px' }}>Existing diagnostics health check (read-only preflight)</strong>
          <ul style={{ margin: '4px 0 0 0', paddingLeft: '20px', fontSize: '12px' }}>
            {(health.steps || []).map((step, index) => (
              <li key={`${step.name}-${index}`}>
                {step.name}: {step.status}{step.message ? ` — ${step.message}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Checkbox
        label="I explicitly approve this read-only connectivity/readiness preflight."
        isChecked={approved}
        onChange={event => setApproved(event.target.checked)}
        isDisabled={saving}
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: token('space.150', '12px'), marginTop: token('space.200', '16px') }}>
        <div style={{ padding: token('space.150', '12px'), borderLeft: '3px solid #0052CC', background: '#F4F5F7' }}>
          <strong style={{ fontSize: '13px' }}>A → B connectivity/readiness preflight</strong>
          <div style={{ marginTop: '4px' }}><Lozenge appearance={summary?.aToB?.status === 'ready' ? 'success' : summary?.aToB?.status === 'not-ready' ? 'removed' : 'default'}>{summary?.aToB?.status || 'not run'}</Lozenge></div>
        </div>
        <div style={{ padding: token('space.150', '12px'), borderLeft: '3px solid #403294', background: '#F4F5F7' }}>
          <strong style={{ fontSize: '13px' }}>B → A connectivity/readiness preflight</strong>
          <div style={{ marginTop: '4px' }}><Lozenge appearance={summary?.bToA?.status === 'ready' ? 'success' : summary?.bToA?.status === 'not-ready' ? 'removed' : 'default'}>{summary?.bToA?.status || (bidirectional ? 'not run' : 'skipped')}</Lozenge></div>
        </div>
      </div>
      {summary && (
        <div style={{ marginTop: token('space.150', '12px'), fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
          Jira writes: {summary.writesPerformed || 0}. Deletions: {summary.deletionPerformed ? 'yes' : 'no'}.
          Disposable issues created: {(summary.issuesCreated || []).length === 0 ? 'none' : summary.issuesCreated.join(', ')}.
          <br />
          End-to-end synchronization: not tested. A real A↔B synchronization test remains part of later manual testing.
        </div>
      )}
      {error && (
        <div style={{ marginTop: token('space.200', '16px') }}>
          <SectionMessage appearance="error"><p style={{ margin: 0, fontSize: '13px' }}>{error}</p></SectionMessage>
        </div>
      )}
      <ValidationMessages result={validation} title="Communication preflight validation" />
      <div style={{ marginTop: token('space.200', '16px') }}>
        <Button appearance="primary" onClick={run} isLoading={saving} isDisabled={saving || !approved}>
          Run Read-Only Connectivity/Readiness Preflight
        </Button>
      </div>
    </div>
  );
}

function InitialSyncStep({ org, saving, validation, onSaveStep, showMessage }) {
  const [deferred, setDeferred] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState('');
  const summary = validation?.summary || null;

  const record = async () => {
    setError('');
    if (deferred && !acknowledged) {
      setError('Acknowledge that initial synchronization is deferred before continuing.');
      return;
    }
    const result = await onSaveStep('initial-sync', {
      choice: deferred ? 'deferred' : 'previewed',
      acknowledged
    });
    if (!result?.success) setError('Initial synchronization preview could not be recorded.');
    else showMessage?.(
      deferred ? 'Initial synchronization deferred with acknowledgement.' : 'Initial-sync preview counts recorded.',
      'success'
    );
  };

  return (
    <div style={{ display: 'grid', gap: token('space.200', '16px') }}>
      <div style={surfaceCard()}>
        <StepHeader
          title="8. Initial synchronization"
          description="This reuses the safe initial-sync preview and backfill workflow. Scope counts are read-only, and starting still requires the panel's explicit approval."
        />
        <SectionMessage appearance="information">
          <p style={{ margin: 0, fontSize: '13px' }}>
            The existing backfill uses bounded batches, progress, pause, resume and cancel. Preview never writes to Jira. Starting is bound to the preview checksum shown by the existing panel.
          </p>
        </SectionMessage>
        <Checkbox
          label="Defer the initial backfill for now"
          isChecked={deferred}
          onChange={event => setDeferred(event.target.checked)}
          isDisabled={saving}
        />
        {deferred && (
          <Checkbox
            label="I understand that existing issues will not be backfilled until I start the approved workflow later."
            isChecked={acknowledged}
            onChange={event => setAcknowledged(event.target.checked)}
            isDisabled={saving}
          />
        )}
        <ScopeCounts counts={summary?.counts || null} />
        {summary?.choice && (
          <p style={{ fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
            Recorded choice: {summary.choice}. Preview checksum: {summary.previewChecksum || 'not available'}.
          </p>
        )}
        {error && (
          <div style={{ marginTop: token('space.200', '16px') }}>
            <SectionMessage appearance="error"><p style={{ margin: 0, fontSize: '13px' }}>{error}</p></SectionMessage>
          </div>
        )}
        <ValidationMessages result={validation} title="Initial-sync validation" />
        <div style={{ marginTop: token('space.200', '16px') }}>
          <Button appearance="primary" onClick={record} isLoading={saving} isDisabled={saving}>
            Preview and Record Initial-Sync Choice
          </Button>
        </div>
      </div>
      <InitialSyncPanel selectedOrg={org} showMessage={showMessage} />
    </div>
  );
}

function SummaryRow({ label, value }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: token('space.150', '12px'), padding: '6px 0', borderBottom: '1px solid #F4F5F7', fontSize: '13px' }}>
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}

function ReviewStep({ org, state, metadata, saving, onComplete, onOpenAdministration }) {
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState('');
  const choices = state?.choices || {};
  const validations = state?.validations || {};
  const counts = choices.initialSync?.counts || choices.scope?.counts || null;
  const featureSummary = choices.features || {};

  const complete = async () => {
    setError('');
    if (!approved) {
      setError('Explicit activation approval is required.');
      return;
    }
    const result = await onComplete();
    if (!result?.success) {
      setError(result?.requiresRevalidation
        ? `${result.error} Revalidation step: ${result.requiresRevalidation}.`
        : result?.error || 'Setup could not be activated.');
    }
  };

  if (metadata?.setupStatus === 'completed') {
    return (
      <div style={surfaceCard()}>
        <SectionMessage appearance="success" title="Guided setup activated">
          <p style={{ margin: 0, fontSize: '13px' }}>
            Safe setup metadata was saved. No credential or Jira issue content was stored in wizard metadata.
          </p>
        </SectionMessage>
        <div style={{ marginTop: token('space.200', '16px') }}>
          <SummaryRow label="setupStatus" value={metadata.setupStatus} />
          <SummaryRow label="setupVersion" value={metadata.setupVersion} />
          <SummaryRow label="setupCompletedAt" value={metadata.setupCompletedAt} />
        </div>
        <div style={{ marginTop: token('space.200', '16px') }}>
          <Button appearance="primary" onClick={onOpenAdministration}>Open Current Administration</Button>
        </div>
      </div>
    );
  }

  return (
    <div style={surfaceCard()}>
      <StepHeader
        title="9. Review and activation"
        description="Review the validated setup. Activation stores only setupStatus, setupVersion and setupCompletedAt."
      />
      <div style={{ marginTop: token('space.300', '24px') }}>
        <SummaryRow label="Organization" value={`${org?.name || ''} (${org?.id || ''})`} />
        <SummaryRow label="Destination" value={org?.remoteProjectKey || 'not configured'} />
        <SummaryRow label="Scope" value={`${(choices.scope?.allowedProjects || []).join(', ') || 'not recorded'}${choices.scope?.jqlFilter ? ` — JQL: ${choices.scope.jqlFilter}` : ''}`} />
        <SummaryRow label="Direction" value={choices.direction?.syncDirection || org?.syncDirection || 'push'} />
        <SummaryRow label="Mappings" value={`${validations.mappings?.summary?.projectMappings || 0} project, ${validations.mappings?.summary?.issueTypeMappings || 0} issue type, ${validations.mappings?.summary?.statusMappings || 0} status, ${validations.mappings?.summary?.userMappings || 0} user, ${validations.mappings?.summary?.fieldMappings || 0} field`} />
        <SummaryRow label="Features" value={`Comments ${featureSummary.syncComments ? 'On' : 'Off'}; descriptions/cross-reference ${featureSummary.syncCrossReference ? 'On' : 'Off'}; links ${featureSummary.syncLinks ? 'On' : 'Off'}; attachments ${featureSummary.syncAttachments ? 'On' : 'Off'}; attachment deletion ${featureSummary.propagateAttachmentDeletions ? 'On' : 'Off'}; automatic counterpart replacement ${featureSummary.automaticReplacementAfterDeletion ? 'On' : 'Off'}`} />
        <SummaryRow label="Webhook" value={validations.webhook?.status === 'skipped' ? 'Not required for push mode' : validations.webhook?.summary?.verified ? 'Authenticated event verified' : 'Not verified'} />
        <SummaryRow label="Communication preflight" value={`A→B readiness ${validations.communication?.summary?.aToB?.status || 'not run'}; B→A readiness ${validations.communication?.summary?.bToA?.status || 'not run'}. End-to-end synchronization not tested.`} />
        <SummaryRow label="Initial sync" value={`${choices.initialSync?.choice || 'previewed'} — eligible ${counts?.eligible || 0}, mapped ${counts?.alreadyMapped || 0}, blocked ${counts?.blockedByValidation || 0}, conflicts ${counts?.mappingConflicts || 0}`} />
      </div>
      <SectionMessage appearance="information">
        <p style={{ margin: 0, fontSize: '13px' }}>
          Global Pause remains available in Sync Activity. Wizard metadata never contains API tokens, webhook secrets, Jira issue descriptions or other issue content.
        </p>
      </SectionMessage>
      <Checkbox
        label="I approve activation of this reviewed setup."
        isChecked={approved}
        onChange={event => setApproved(event.target.checked)}
        isDisabled={saving}
      />
      {error && (
        <div style={{ marginTop: token('space.200', '16px') }}>
          <SectionMessage appearance="error"><p style={{ margin: 0, fontSize: '13px' }}>{error}</p></SectionMessage>
        </div>
      )}
      <div style={{ marginTop: token('space.200', '16px'), display: 'flex', gap: token('space.150', '12px'), flexWrap: 'wrap' }}>
        <Button appearance="primary" onClick={complete} isLoading={saving} isDisabled={saving || !approved}>
          Activate Reviewed Setup
        </Button>
        <Button appearance="subtle" onClick={onOpenAdministration}>Open Current Administration</Button>
      </div>
    </div>
  );
}

export default function GuidedSetupWizard({
  selectedOrg,
  onRefreshOrganizations,
  onOpenAdministration,
  onOpenMappings,
  showMessage
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeStep, setActiveStep] = useState('connection');
  const [lastResult, setLastResult] = useState(null);
  const [error, setError] = useState('');
  const [existingValidation, setExistingValidation] = useState(null);
  const [validatingExisting, setValidatingExisting] = useState(false);

  const loadWizard = async (showSpinner = true) => {
    if (!selectedOrg?.id) {
      setLoading(false);
      return;
    }
    if (showSpinner) setLoading(true);
    setError('');
    try {
      const result = await invoke('setupWizard', { action: 'load', orgId: selectedOrg.id });
      if (!result?.success) {
        setError(result?.error || 'Guided setup could not be loaded.');
        return;
      }
      setData(result);
      if (result.state?.currentStep) setActiveStep(result.state.currentStep);
    } catch (err) {
      setError(err?.message || 'Guided setup could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setData(null);
    setLastResult(null);
    setExistingValidation(null);
    setActiveStep('connection');
    loadWizard();
  }, [selectedOrg?.id]);

  const start = async () => {
    setSaving(true);
    setError('');
    try {
      const result = await invoke('setupWizard', { action: 'start', orgId: selectedOrg.id });
      if (!result?.success) {
        setError(result?.error || 'Guided setup could not be started.');
        return;
      }
      setData(current => ({ ...(current || {}), ...result }));
      setActiveStep(result.state?.currentStep || 'connection');
    } catch (err) {
      setError(err?.message || 'Guided setup could not be started.');
    } finally {
      setSaving(false);
    }
  };

  const saveStep = async (step, stepData = {}) => {
    setSaving(true);
    setError('');
    try {
      const result = await invoke('setupWizard', {
        action: 'save-step',
        orgId: selectedOrg.id,
        step,
        data: stepData
      });
      if (result?.state) {
        setData(current => ({
          ...(current || {}),
          state: result.state,
          steps: result.steps || current?.steps || []
        }));
        if (result.state.currentStep) setActiveStep(result.state.currentStep);
      }
      setLastResult({
        step,
        result: result?.validation || result
      });
      return result;
    } catch (err) {
      const failure = { success: false, error: err?.message || 'Validation failed.', errors: [err?.message || 'Validation failed.'] };
      setLastResult({ step, result: failure });
      return failure;
    } finally {
      setSaving(false);
    }
  };

  const complete = async () => {
    setSaving(true);
    setError('');
    try {
      const result = await invoke('setupWizard', {
        action: 'complete',
        orgId: selectedOrg.id,
        approved: true
      });
      if (result?.success) {
        setData(current => ({ ...(current || {}), metadata: result.metadata }));
        showMessage?.('Guided setup activated with safe setup metadata.', 'success');
      }
      return result;
    } catch (err) {
      return { success: false, error: err?.message || 'Activation failed.' };
    } finally {
      setSaving(false);
    }
  };

  const validateExisting = async () => {
    setValidatingExisting(true);
    setError('');
    setExistingValidation(null);
    try {
      const result = await invoke('setupWizard', {
        action: 'validate-existing',
        orgId: selectedOrg.id
      });
      setExistingValidation(result);
    } catch (err) {
      setError(err?.message || 'Existing setup validation failed.');
    } finally {
      setValidatingExisting(false);
    }
  };

  if (!selectedOrg) {
    return <div style={surfaceCard()}>Select an organization to configure guided setup.</div>;
  }

  if (loading && !data) {
    return <div style={surfaceCard({ textAlign: 'center' })}><Spinner size="large" /></div>;
  }

  const state = data?.state || null;
  const metadata = data?.metadata || null;
  const steps = data?.steps || [];
  const completed = new Set(state?.completedSteps || []);
  if (metadata?.setupStatus === 'completed') completed.add('review');
  const activeValidation = lastResult?.step === activeStep
    ? lastResult.result
    : state?.validations?.[activeStep] || null;
  const activeIndex = steps.findIndex(step => step.key === activeStep);
  const nextStep = activeIndex >= 0 ? steps[activeIndex + 1] : null;
  const previousStep = activeIndex > 0 ? steps[activeIndex - 1] : null;

  if (!state) {
    return (
      <div style={{ display: 'grid', gap: token('space.200', '16px') }}>
        <div style={surfaceCard()}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: token('space.200', '16px'), flexWrap: 'wrap' }}>
            <div>
              <h3 style={{ margin: 0 }}>Guided Setup</h3>
              <p style={{ margin: '6px 0 0 0', color: token('color.text.subtle', '#6B778C'), fontSize: '13px' }}>
                An optional nine-step path through the existing configuration, mappings, webhook, diagnostics, attachments and safe initial-sync workflow.
              </p>
            </div>
            {metadata?.setupStatus === 'completed' && <Lozenge appearance="success" isBold>SETUP COMPLETE</Lozenge>}
          </div>
          {metadata?.setupStatus === 'completed' && (
            <SectionMessage appearance="success" title="Setup metadata is complete">
              <p style={{ margin: 0, fontSize: '13px' }}>
                Completed {metadata.setupCompletedAt}. Existing organizations are not forced through the wizard again.
              </p>
            </SectionMessage>
          )}
          <SectionMessage appearance="information">
            <p style={{ margin: 0, fontSize: '13px' }}>
              Existing organizations remain fully usable through the current administration tabs. Use validation to check the current setup, or start the guided path to review it step by step.
            </p>
          </SectionMessage>
          <div style={{ display: 'flex', gap: token('space.150', '12px'), flexWrap: 'wrap', marginTop: token('space.200', '16px') }}>
            {metadata?.setupStatus !== 'completed' && (
              <Button appearance="primary" onClick={start} isLoading={saving} isDisabled={saving}>
                Start Guided Setup
              </Button>
            )}
            <Button appearance="subtle" onClick={validateExisting} isLoading={validatingExisting} isDisabled={validatingExisting}>
              Validate Existing Setup
            </Button>
            <Button appearance="subtle" onClick={onOpenAdministration}>
              Open Current Administration
            </Button>
          </div>
          {error && (
            <div style={{ marginTop: token('space.200', '16px') }}>
              <SectionMessage appearance="error"><p style={{ margin: 0, fontSize: '13px' }}>{error}</p></SectionMessage>
            </div>
          )}
        </div>
        {existingValidation && <ExistingSetupValidation result={existingValidation} />}
      </div>
    );
  }

  const org = {
    ...(data.organization || {}),
    ...selectedOrg,
    syncDirection: state.choices?.direction?.syncDirection || selectedOrg.syncDirection || 'push',
    lastAuthenticatedWebhookAt: data.organization?.lastAuthenticatedWebhookAt || selectedOrg.lastAuthenticatedWebhookAt
  };
  const refreshOrg = async () => {
    await onRefreshOrganizations?.();
  };

  let stepContent = null;
  switch (activeStep) {
    case 'connection':
      stepContent = (
        <ConnectionStep
          org={org}
          saving={saving}
          validation={activeValidation}
          onRefresh={refreshOrg}
          onSaveStep={saveStep}
          showMessage={showMessage}
        />
      );
      break;
    case 'scope':
      stepContent = (
        <ScopeStep
          org={org}
          saving={saving}
          validation={activeValidation}
          onRefresh={refreshOrg}
          onSaveStep={saveStep}
          showMessage={showMessage}
          onOpenAdministration={onOpenAdministration}
        />
      );
      break;
    case 'direction':
      stepContent = (
        <DirectionStep
          org={org}
          saving={saving}
          validation={activeValidation}
          onRefresh={refreshOrg}
          onSaveStep={saveStep}
          showMessage={showMessage}
        />
      );
      break;
    case 'mappings':
      stepContent = (
        <MappingsStep
          org={org}
          saving={saving}
          validation={activeValidation}
          onSaveStep={saveStep}
          showMessage={showMessage}
          onOpenMappings={onOpenMappings}
        />
      );
      break;
    case 'features':
      stepContent = (
        <FeaturesStep
          org={org}
          saving={saving}
          validation={activeValidation}
          onSaveStep={saveStep}
          showMessage={showMessage}
        />
      );
      break;
    case 'webhook':
      stepContent = (
        <WebhookStep
          org={org}
          saving={saving}
          validation={activeValidation}
          requiredEvents={data.requiredWebhookEvents || []}
          onRefresh={refreshOrg}
          onSaveStep={saveStep}
          showMessage={showMessage}
        />
      );
      break;
    case 'communication':
      stepContent = (
        <CommunicationStep
          org={org}
          saving={saving}
          validation={activeValidation}
          onSaveStep={saveStep}
          showMessage={showMessage}
        />
      );
      break;
    case 'initial-sync':
      stepContent = (
        <InitialSyncStep
          org={org}
          saving={saving}
          validation={activeValidation}
          onSaveStep={saveStep}
          showMessage={showMessage}
        />
      );
      break;
    case 'review':
      stepContent = (
        <ReviewStep
          org={org}
          state={state}
          metadata={metadata}
          saving={saving}
          onComplete={complete}
          onOpenAdministration={onOpenAdministration}
        />
      );
      break;
    default:
      stepContent = <div style={surfaceCard()}>Unknown setup step.</div>;
  }

  return (
    <div style={{ display: 'grid', gap: token('space.200', '16px') }}>
      <div style={surfaceCard()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: token('space.200', '16px'), flexWrap: 'wrap' }}>
          <div>
            <h3 style={{ margin: 0 }}>Guided Setup</h3>
            <p style={{ margin: '6px 0 0 0', color: token('color.text.subtle', '#6B778C'), fontSize: '13px' }}>
              Progress is saved after every validated step and resumes after a browser refresh. A step cannot complete until validation succeeds.
            </p>
          </div>
          <Lozenge appearance="inprogress" isBold>
            {completed.size}/{steps.length} VALIDATED
          </Lozenge>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: token('space.100', '8px'), marginTop: token('space.200', '16px') }}>
          {steps.map(step => {
            const canOpen = completed.has(step.key) || step.key === state.currentStep;
            return (
              <button
                key={step.key}
                type="button"
                style={stepChipStyle(step.key === activeStep, completed.has(step.key))}
                onClick={() => canOpen && setActiveStep(step.key)}
                disabled={!canOpen}
                title={canOpen ? step.label : 'Complete the preceding steps first'}
              >
                <strong>{step.index}. {step.label}</strong>
                <div style={{ marginTop: '2px', fontSize: '11px', color: token('color.text.subtle', '#6B778C') }}>
                  {completed.has(step.key) ? 'Validated' : step.key === state.currentStep ? 'Current' : 'Locked'}
                </div>
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: token('space.150', '12px'), flexWrap: 'wrap', marginTop: token('space.200', '16px') }}>
          <Button appearance="subtle" onClick={validateExisting} isLoading={validatingExisting} isDisabled={validatingExisting}>
            Validate Existing Setup
          </Button>
          <Button appearance="subtle" onClick={onOpenAdministration}>Open Current Administration</Button>
        </div>
        {error && (
          <div style={{ marginTop: token('space.200', '16px') }}>
            <SectionMessage appearance="error"><p style={{ margin: 0, fontSize: '13px' }}>{error}</p></SectionMessage>
          </div>
        )}
      </div>

      {existingValidation && <ExistingSetupValidation result={existingValidation} />}
      {stepContent}

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: token('space.150', '12px'), flexWrap: 'wrap' }}>
        <Button
          appearance="subtle"
          onClick={() => previousStep && setActiveStep(previousStep.key)}
          isDisabled={!previousStep}
        >
          Back
        </Button>
        <Button
          appearance="subtle"
          onClick={() => nextStep && setActiveStep(nextStep.key)}
          isDisabled={!nextStep || !completed.has(activeStep)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function ExistingSetupValidation({ result }) {
  const steps = result?.steps && typeof result.steps === 'object'
    ? Object.entries(result.steps)
    : [];
  const appearanceByStatus = {
    passed: 'success',
    warning: 'moved',
    skipped: 'default',
    failed: 'removed'
  };

  return (
    <div style={surfaceCard()}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: token('space.150', '12px') }}>
        <h4 style={{ margin: 0 }}>Existing Setup Validation</h4>
        <Lozenge appearance={result?.success ? 'success' : 'removed'} isBold>
          {result?.success ? 'VALID' : 'ISSUES FOUND'}
        </Lozenge>
      </div>
      <p style={{ margin: '6px 0 0 0', fontSize: '12px', color: token('color.text.subtle', '#6B778C') }}>
        Read-only validation. Jira writes performed: {result?.writesPerformed || 0}.
      </p>
      <div style={{ display: 'grid', gap: token('space.100', '8px'), marginTop: token('space.150', '12px') }}>
        {steps.map(([key, validation]) => (
          <div key={key} style={{ padding: '8px', background: '#F4F5F7', borderRadius: '6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: token('space.100', '8px') }}>
              <strong style={{ fontSize: '13px', textTransform: 'capitalize' }}>{key.replace('-', ' ')}</strong>
              <Lozenge appearance={appearanceByStatus[validation.status] || 'default'}>{validation.status}</Lozenge>
            </div>
            {(validation.errors || []).length > 0 && (
              <ul style={{ margin: '4px 0 0 0', paddingLeft: '20px', fontSize: '12px', color: '#DE350B' }}>
                {validation.errors.map((message, index) => <li key={`${message}-${index}`}>{message}</li>)}
              </ul>
            )}
            {(validation.warnings || []).length > 0 && (
              <ul style={{ margin: '4px 0 0 0', paddingLeft: '20px', fontSize: '12px', color: '#974F0C' }}>
                {validation.warnings.map((message, index) => <li key={`${message}-${index}`}>{message}</li>)}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
