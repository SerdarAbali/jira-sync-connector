import React, { useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';
import SectionMessage from '@atlaskit/section-message';
import InitialSyncPanel from '../components/InitialSyncPanel';
import RecurringReconciliation from '../components/RecurringReconciliation';
import { isLegacyScheduledActive } from './presentation';

export default function OrganizationSynchronization({ selectedOrg, showMessage }) {
  const [scheduler, setScheduler] = useState(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setScheduler(null);
    Promise.all([
      invoke('getRecurringReconciliationStatus', { orgId: selectedOrg.id }),
      invoke('getScheduledSyncConfig')
    ]).then(([recurring, legacy]) => {
      if (active && recurring?.success === true) setScheduler({
        recurringEnabled: recurring.settings?.recurringReconciliationEnabled === true,
        legacyActive: isLegacyScheduledActive(legacy)
      });
    }).catch(() => {});
    return () => { active = false; };
  }, [selectedOrg.id, revision]);
  return <div className="workflow-stack">
    <SectionMessage appearance="information" title="Organization synchronization">
      <p>Initial backfill and recurring source reconciliation are local-to-remote workflows. Their job controls are separate from the installation emergency pause and synchronization authorization.</p>
    </SectionMessage>
    <InitialSyncPanel selectedOrg={selectedOrg} showMessage={showMessage} />
    <RecurringReconciliation selectedOrg={selectedOrg} showMessage={showMessage} onSettingsSaved={() => setRevision(value => value + 1)} />
    {scheduler && !scheduler.recurringEnabled && <SectionMessage appearance="information"
      title={scheduler.legacyActive ? 'Legacy scheduled synchronization is active' : 'Automatic source reconciliation is disabled'}>
      <p>{scheduler.legacyActive
        ? 'Existing legacy scheduling continues until recurring reconciliation is enabled. The two schedulers never run for the same organization.'
        : 'Real-time webhook handling is configured separately. Jira writes still require installation authorization and the emergency pause to be off.'}</p>
    </SectionMessage>}
  </div>;
}
