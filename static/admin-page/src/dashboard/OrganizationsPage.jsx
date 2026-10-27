import React from 'react';
import Button from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import ConfigurationPanel from '../components/ConfigurationPanel';
import MappingsPanel from '../components/MappingsPanel';
import GuidedSetupWizard from '../components/GuidedSetupWizard';
import OrganizationSynchronization from './OrganizationSynchronization';
import { DenseTable, Empty, PageHeading, Panel } from './DataViews';
import { SecondaryNavigation } from './DashboardShell';
import { ORGANIZATION_SECTIONS } from './navigation';

export default function OrganizationsPage({ controller: c, section, navigate }) {
  const selectedOrg = c.selectedOrg;
  return <>
    <PageHeading eyebrow="Organization administration" title="Organizations" description="Each organization has its own source scope, destination, mappings and synchronization settings." />
    <Panel title="Connections" detail={`${c.organizations.length} configured`}>
      <DenseTable columns={[
        { key: 'name', label: 'Organization', render: org => <button type="button" className="text-button" aria-pressed={org.id === c.selectedOrgId} onClick={() => c.selectOrganization(org.id)}>{org.name}{org.id === c.selectedOrgId ? ' · selected' : ''}</button> },
        { key: 'remoteUrl', label: 'Remote Jira' },
        { key: 'syncDirection', label: 'Direction', render: org => org.syncDirection === 'bidirectional' ? 'Two-way' : 'Push only' },
        { key: 'configuration', label: 'Configuration', render: org => <span className={`status ${org.remoteUrl && org.hasRemoteApiToken ? 'neutral' : 'warning'}`}>{org.remoteUrl && org.hasRemoteApiToken ? 'Configured' : 'Incomplete'}</span> }
      ]} rows={c.organizations} empty="No organizations configured. Add your first organization to begin." />
    </Panel>
    {!selectedOrg ? <Empty>Select an organization to view or edit its configuration.</Empty> : <>
      <div className="selected-organization"><div><span className="eyebrow">Selected organization</span><h2>{selectedOrg.name}</h2><span className="muted">{selectedOrg.remoteUrl || 'Jira URL not configured'}</span></div><div className="page-actions">
        {selectedOrg.remoteUrl && <Button onClick={c.handleTestConnection} isLoading={c.testingConnection}>Test connection</Button>}
        <Button onClick={() => { c.setEditingOrg(selectedOrg); c.setShowOrgModal(true); }}>Edit organization</Button>
        <Button appearance="danger" onClick={() => c.handleDeleteOrg(selectedOrg.id)}>Delete</Button>
      </div></div>
      <SecondaryNavigation items={ORGANIZATION_SECTIONS} value={section} label="Organization sections" onChange={id => navigate('organizations', id)} />
      {section === 'scope' && <SectionMessage appearance="information" title="Source projects, JQL and direction">
        <p>Project selection is saved independently. Use Edit organization to change JQL, the default remote project or direction. Empty source selection does not authorize every project.</p>
        <Button onClick={() => { c.setEditingOrg(selectedOrg); c.setShowOrgModal(true); }}>Edit JQL & direction</Button>
      </SectionMessage>}
      {['connection', 'scope', 'features', 'transfer'].includes(section) && <ConfigurationPanel
        {...c} selectedOrg={selectedOrg} section={section} handleImportSettings={c.handleImportButtonClick}
        onRefreshOrganizations={c.loadOrganizations} notify={c.showMessage} />}
      {section === 'mappings' && <MappingsPanel {...c} selectedOrg={selectedOrg} />}
      {section === 'synchronization' && <OrganizationSynchronization selectedOrg={selectedOrg} showMessage={c.showMessage} />}
      {section === 'setup' && <GuidedSetupWizard selectedOrg={selectedOrg} onRefreshOrganizations={c.loadOrganizations}
        onOpenAdministration={() => navigate('organizations', 'connection')} onOpenMappings={() => navigate('organizations', 'mappings')} showMessage={c.showMessage} />}
    </>}
  </>;
}
