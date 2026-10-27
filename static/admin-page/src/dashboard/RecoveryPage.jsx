import React from 'react';
import SectionMessage from '@atlaskit/section-message';
import SyncAuthorization from '../components/SyncAuthorization.jsx';
import RecoverySnapshot from '../components/RecoverySnapshot';
import PairWitnessMigration from '../components/PairWitnessMigration.jsx';
import WitnessedPairAdoption from '../components/WitnessedPairAdoption.jsx';
import DeletedCounterpartRecovery from '../components/DeletedCounterpartRecovery';
import IssueCreateRecovery from '../components/IssueCreateRecovery';
import SyncOperations from '../components/SyncOperations';
import { Empty, PageHeading } from './DataViews';
import { SecondaryNavigation } from './DashboardShell';
import { RECOVERY_SECTIONS } from './navigation';

export default function RecoveryPage({ controller: c, section, navigate }) {
  const selectedOrg = c.selectedOrg;
  const operations = <SyncOperations {...c} selectedOrg={selectedOrg} view={section}
    onExportIssues={c.handleExportIssues} onIssueImportClick={c.handleIssueImportClick} />;
  return <>
    <PageHeading eyebrow="Controlled administration" title="Recovery" description="Emergency controls, approved maintenance and targeted repair. No operation runs just by opening this page." />
    <SecondaryNavigation items={RECOVERY_SECTIONS} value={section} label="Recovery sections" onChange={id => navigate('recovery', id)} />
    <SectionMessage appearance="warning" title={section === 'write-controls' ? 'Installation-wide write controls' : `Recovery scope: ${selectedOrg?.name || 'organization required'}`}>
      <p>{section === 'write-controls' ? 'Emergency pause and synchronization authorization apply to this installation. Setup approval, initial-backfill approval and maintenance permits remain separate.' : 'Review the exact organization, issue pair and operation before confirming. Pending-link retry applies across all organizations; issue export uses its explicit local Jira query.'}</p>
    </SectionMessage>
    <div className="workflow-stack">
      {section === 'write-controls' ? <>{operations}<SyncAuthorization showMessage={c.showMessage} /></>
        : !selectedOrg ? <Empty>Select an organization before using this recovery section.</Empty>
        : <>
          {section === 'snapshots' && <RecoverySnapshot selectedOrg={selectedOrg} showMessage={c.showMessage} />}
          {section === 'witnesses' && <><PairWitnessMigration selectedOrg={selectedOrg} showMessage={c.showMessage} /><WitnessedPairAdoption selectedOrg={selectedOrg} showMessage={c.showMessage} /><button className="text-button" onClick={() => navigate('activity')}>Open maintenance write audit</button></>}
          {section === 'creates' && <IssueCreateRecovery selectedOrg={selectedOrg} showMessage={c.showMessage} />}
          {section === 'counterparts' && <DeletedCounterpartRecovery selectedOrg={selectedOrg} showMessage={c.showMessage} />}
          {['repair', 'transfer'].includes(section) && operations}
        </>}
    </div>
  </>;
}
