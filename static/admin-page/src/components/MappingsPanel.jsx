import React, { useState, useEffect } from 'react';
import Button from '@atlaskit/button';
import TextField from '@atlaskit/textfield';
import Select from '@atlaskit/select';
import Spinner from '@atlaskit/spinner';
import SectionMessage from '@atlaskit/section-message';
import { token } from '@atlaskit/tokens';
import { surfaceCard, lozengeButtonStyle } from '../dashboard/presentation';
// Mappings Panel Component
const MappingsPanel = ({
  selectedOrg, remoteUsers, localUsers, remoteFields, localFields,
  remoteStatuses, localStatuses, remoteIssueTypes, localIssueTypes,
  userMappings, setUserMappings, fieldMappings, setFieldMappings,
  statusMappings, setStatusMappings, issueTypeMappings, setIssueTypeMappings,
  projectMappings, setProjectMappings, rejectedFieldIds,
  addMapping, deleteMapping, handleSaveMappings, loadMappingData, dataLoading, saving,
  handleAutoMatch
}) => {
  const [selectedLocalProject, setSelectedLocalProject] = useState('');

  useEffect(() => {
    const allowed = Array.isArray(selectedOrg?.allowedProjects) ? selectedOrg.allowedProjects.filter(Boolean) : [];
    setSelectedLocalProject((prev) => (allowed.includes(prev) ? prev : (allowed[0] || '')));
  }, [selectedOrg?.id, selectedOrg?.allowedProjects]);

  const [newUserRemote, setNewUserRemote] = useState('');
  const [newUserLocal, setNewUserLocal] = useState('');
  const [newFieldRemote, setNewFieldRemote] = useState('');
  const [newFieldLocal, setNewFieldLocal] = useState('');
  const [newStatusRemote, setNewStatusRemote] = useState('');
  const [newStatusLocal, setNewStatusLocal] = useState('');
  const [newIssueTypeRemote, setNewIssueTypeRemote] = useState('');
  const [newIssueTypeLocal, setNewIssueTypeLocal] = useState('');
  const [newProjectSource, setNewProjectSource] = useState('');
  const [newProjectTarget, setNewProjectTarget] = useState('');

  const hasData = remoteUsers.length > 0 || localUsers.length > 0;
  const isLoading = dataLoading.users || dataLoading.fields || dataLoading.statuses || dataLoading.issueTypes;

  const MappingSection = ({ title, type, remotePlaceholder, localPlaceholder, remoteItems, localItems, mappings, setMappings, newRemote, setNewRemote, newLocal, setNewLocal, warningIds = [] }) => {
    const itemKey = type === 'user' ? 'accountId' : 'id';
    const warningSet = new Set(warningIds || []);
    const itemLabel = type === 'user'
      ? (item) => `${item.displayName}${item.emailAddress ? ` (${item.emailAddress})` : ''}`
      : (item) => type === 'field' ? `${item.name} (${item.id})` : `${item.name}`;

    const optionLabel = (item) => warningSet.has(item[itemKey]) ? `⚠️ ${itemLabel(item)}` : itemLabel(item);

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

        {type === 'field' && warningSet.size > 0 && (
          <div style={{ color: '#B65C00', fontSize: '12px', marginBottom: token('space.200', '16px') }}>
            ⚠️ = field was rejected by Jira in a previous sync (read-only or unmappable). Remove its mapping to stop the warnings.
          </div>
        )}

        {hasData && (
          <>
            <div className="workflow-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: token('space.150', '12px'), marginBottom: token('space.200', '16px') }}>
              <Select
                options={sortedRemoteItems.map(item => ({ label: optionLabel(item), value: item[itemKey] }))}
                value={sortedRemoteItems.find(i => i[itemKey] === newRemote) ? { label: itemLabel(sortedRemoteItems.find(i => i[itemKey] === newRemote)), value: newRemote } : null}
                onChange={(option) => setNewRemote(option?.value || '')}
                placeholder={remotePlaceholder}
                isClearable
              />
              <Select
                options={sortedLocalItems.map(item => ({ label: optionLabel(item), value: item[itemKey] }))}
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

            <div className="table-scroll" style={{ marginBottom: token('space.200', '16px') }}>
              {Object.keys(mappings).length === 0 ? <div className="empty-state">No mappings yet</div> :
                <table className="dense-table"><thead><tr><th scope="col">Remote</th><th scope="col">Local</th><th scope="col">Action</th></tr></thead><tbody>
                  {Object.entries(mappings).map(([remoteId, mapping]) => {
                    const localId = typeof mapping === 'string' ? mapping : mapping.localId;
                    const remoteName = typeof mapping === 'object' ? mapping.remoteName : remoteId;
                    const localName = typeof mapping === 'object' ? mapping.localName : localId;
                    return <tr key={remoteId}>
                      <td><strong>{remoteName}</strong>{remoteId && remoteId !== remoteName ? ` (${remoteId})` : ''}</td>
                      <td>{localName}{localId && localId !== localName ? ` (${localId})` : ''}{warningSet.has(localId) ? ' ⚠️' : ''}</td>
                      <td><Button appearance="subtle" onClick={() => deleteMapping(type, remoteId)} style={lozengeButtonStyle}>Delete</Button></td>
                    </tr>;
                  })}
                </tbody></table>}
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
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', justifyContent: 'space-between', alignItems: 'center', marginBottom: token('space.250', '20px') }}>
        <h3>Mappings</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: token('space.150', '12px') }}>
          <label style={{ fontSize: '13px', color: '#6B778C', display: 'flex', alignItems: 'center' }}>
            Local project
            <select
              value={selectedLocalProject}
              onChange={(e) => setSelectedLocalProject(e.target.value)}
              style={{ marginLeft: token('space.100', '8px'), padding: '6px 8px', borderRadius: token('border.radius', '4px'), border: '1px solid #DFE1E6', background: '#FFFFFF', color: '#172B4D', fontSize: '13px' }}
            >
              {(selectedOrg?.allowedProjects || []).map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
              {(!selectedOrg?.allowedProjects || selectedOrg.allowedProjects.length === 0) && (
                <option value="">Select allowed projects in Configuration</option>
              )}
            </select>
          </label>
          <Button
            appearance="subtle"
            onClick={() => loadMappingData(selectedLocalProject)}
            isLoading={isLoading}
            style={lozengeButtonStyle}
          >
            {hasData ? 'Reload Data' : 'Load Mapping Data'}
          </Button>
        </div>
      </div>

      {!hasData && !isLoading && (
        <div style={surfaceCard()}>
          <SectionMessage appearance="info" title="Load mapping data first">
            <p>Select a local project above, then click "Load Mapping Data" to fetch users, fields, and statuses from both organizations.</p>
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
            warningIds={rejectedFieldIds}
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

          {/* Project Mappings - simple text inputs, no dropdowns needed */}
          <div style={surfaceCard({ marginBottom: token('space.250', '20px') })}>
            <div style={{ marginBottom: token('space.200', '16px') }}>
              <h4 style={{ margin: 0, marginBottom: '8px' }}>Project Mappings ({Object.keys(projectMappings || {}).length})</h4>
              <p style={{ color: '#6B778C', fontSize: '13px', margin: 0 }}>
                Map source project keys to target project keys. Issues from a source project will be synced to the corresponding target project.
                If no mapping exists, issues go to the default remote project configured for this organization.
              </p>
            </div>

            <div className="workflow-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: token('space.150', '12px'), marginBottom: token('space.200', '16px') }}>
              <TextField
                value={newProjectSource}
                onChange={(e) => setNewProjectSource(e.target.value.toUpperCase())}
                placeholder="Source project key (e.g., PROJ)"
              />
              <TextField
                value={newProjectTarget}
                onChange={(e) => setNewProjectTarget(e.target.value.toUpperCase())}
                placeholder="Target project key (e.g., SYNC)"
              />
              <Button
                appearance="subtle"
                onClick={() => {
                  if (newProjectSource && newProjectTarget) {
                    setProjectMappings({ ...projectMappings, [newProjectSource]: newProjectTarget });
                    setNewProjectSource('');
                    setNewProjectTarget('');
                  }
                }}
                isDisabled={!newProjectSource || !newProjectTarget}
                style={lozengeButtonStyle}
              >
                Add
              </Button>
            </div>

            <div style={{ marginBottom: token('space.200', '16px') }}>
              {Object.keys(projectMappings || {}).length === 0 ? (
                <div style={{ color: '#6B778C', fontSize: '13px', fontStyle: 'italic' }}>
                  No project mappings configured. All issues will sync to the default remote project.
                </div>
              ) : (
                Object.entries(projectMappings).map(([sourceKey, targetKey]) => (
                  <div key={sourceKey} style={{
                    padding: '8px 12px',
                    background: token('color.background.neutral.subtle', '#F4F5F7'),
                    borderRadius: token('border.radius', '8px'),
                    marginBottom: '4px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: '13px'
                  }}>
                    <span><strong>{sourceKey}</strong> → {targetKey}</span>
                    <Button
                      appearance="subtle"
                      onClick={() => {
                        const updated = { ...projectMappings };
                        delete updated[sourceKey];
                        setProjectMappings(updated);
                      }}
                      style={lozengeButtonStyle}
                    >
                      Delete
                    </Button>
                  </div>
                ))
              )}
            </div>

            <Button
              appearance="subtle"
              onClick={() => handleSaveMappings('project')}
              isLoading={saving}
              style={lozengeButtonStyle}
            >
              Save Project Mappings
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default MappingsPanel;
