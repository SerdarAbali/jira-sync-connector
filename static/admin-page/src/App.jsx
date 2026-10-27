import React, { useCallback, useState } from 'react';
import Button from '@atlaskit/button';
import Spinner from '@atlaskit/spinner';
import SectionMessage from '@atlaskit/section-message';
import useAdminController from './hooks/useAdminController';
import { readStoredOrganizationId } from './org-selection';
import DashboardShell from './dashboard/DashboardShell';
import AdminDialogs from './dashboard/AdminDialogs';
import OrganizationsPage from './dashboard/OrganizationsPage';
import RecoveryPage from './dashboard/RecoveryPage';
import ActivityPage from './dashboard/ActivityPage';
import SettingsPage from './dashboard/SettingsPage';
import { OverviewPage, AnalyticsPage, PageHeading, Empty } from './dashboard/DataViews';
import Diagnostics from './components/Diagnostics';

export { APPLICATION_VERSION as ADMIN_UI_VERSION } from './dashboard/version';
import { APPLICATION_VERSION } from './dashboard/version';

// Replacing the session discards approvals and unsubmitted dialogs. Pending
// requests retain their original orgId and cannot update the new session.
export const App = () => {
  const [scope, setScope] = useState(() => ({ id: readStoredOrganizationId(), revision: 0 }));
  const [route, setRoute] = useState({ page: 'overview', organization: 'connection', recovery: 'write-controls' });
  const navigate = useCallback((page, section) => setRoute(current => ({
    ...current, page,
    ...(section && page === 'organizations' ? { organization: section } : {}),
    ...(section && page === 'recovery' ? { recovery: section } : {})
  })), []);
  const onSelect = useCallback(id => setScope(current => ({ id, revision: current.revision + 1 })), []);
  return <DashboardSession key={scope.revision} selection={scope.id} onSelect={onSelect} route={route} navigate={navigate} />;
};

function DashboardSession({ selection, onSelect, route, navigate }) {
  const c = useAdminController({ selection, onSelect, navigate });
  React.useEffect(() => { c.loadStats(); }, []);
  let page;
  switch (route.page) {
    case 'organizations': page = c.organizationsLoadState.status === 'loaded'
      ? <OrganizationsPage controller={c} section={route.organization} navigate={navigate} />
      : <><PageHeading title="Organizations" eyebrow="Organization administration" /><Empty>Organization configuration is unavailable until the list loads successfully.</Empty></>; break;
    case 'analytics': page = <AnalyticsPage controller={c} />; break;
    case 'activity': page = <ActivityPage controller={c} navigate={navigate} />; break;
    case 'diagnostics': page = <><PageHeading eyebrow={c.selectedOrg?.name || 'Organization required'} title="Diagnostics" description="Read-only checks and explicitly confirmed issue repair." /><Diagnostics selectedOrgId={c.selectedOrg?.id} /></>; break;
    case 'recovery': page = <RecoveryPage controller={c} section={route.recovery} navigate={navigate} />; break;
    case 'settings': page = <><PageHeading eyebrow="Application information" title="About & Security" description="Security, architecture, capabilities and support." /><SettingsPage /></>; break;
    default: page = <OverviewPage controller={c} navigate={navigate} />;
  }
  return <DashboardShell controller={c} route={route} navigate={navigate} version={APPLICATION_VERSION}>
    <input ref={c.importFileInputRef} type="file" accept="application/json" hidden onChange={c.handleImportFileChange} />
    <input ref={c.issueImportFileInputRef} type="file" accept="application/json" hidden onChange={c.handleIssueImportFileChange} />
    <div aria-live="polite" className="feedback-region">
      {c.message && <SectionMessage appearance={c.message.type === 'error' ? 'error' : c.message.type === 'warning' ? 'warning' : c.message.type === 'info' ? 'information' : 'success'} title={c.message.text}>
        {c.message.persistent && <Button appearance="subtle" onClick={c.dismissMessage}>Dismiss</Button>}
      </SectionMessage>}
      {c.organizationsLoadState.status === 'error' && <SectionMessage appearance="error" title={c.organizationsLoadState.message}>
        <Button onClick={c.loadOrganizations}>Retry organizations</Button>
      </SectionMessage>}
    </div>
    {c.loading ? <div className="empty-state"><Spinner /> Loading workspace…</div> : page}
    <AdminDialogs controller={c} />
  </DashboardShell>;
}
