import React, { useState } from 'react';
import Button from '@atlaskit/button';
import WitnessAuditLog from '../components/WitnessAuditLog.jsx';
import { DenseTable, PageHeading, Panel } from './DataViews';
import { usable, withinPeriod } from './metrics';
import { formatDateTimeEuro } from './presentation';

export default function ActivityPage({ controller: c }) {
  const [scope, setScope] = useState('installation');
  const [period, setPeriod] = useState('all');
  const webhook = usable(c.syncStats?.webhook);
  const rows = withinPeriod((Array.isArray(webhook?.errors) ? webhook.errors : []).filter(row => scope === 'installation' || row.orgId === c.selectedOrg?.id), period, row => row.timestamp, Date.now());
  const scheduled = usable(c.syncStats?.scheduled);
  return <>
    <PageHeading eyebrow="Retained operational records" title="Activity" description="Bounded histories contain safe metadata. They are not a complete synchronization ledger.">
      <Button onClick={c.loadStats} isLoading={c.statsLoading}>Refresh statistics</Button>
    </PageHeading>
    <Panel title="Webhook errors" detail="Up to 50 retained records · normal safety skips excluded">
      <div className="filter-bar"><label>Error scope <select aria-label="Error scope" value={scope} onChange={event => setScope(event.target.value)}><option value="installation">Installation-wide</option><option value="organization" disabled={!c.selectedOrg}>Selected organization</option></select></label>
        <label>Recorded error range <select aria-label="Recorded error range" value={period} onChange={event => setPeriod(event.target.value)}><option value="all">All retained records</option><option value="24">Last 24 hours</option><option value="168">Last 7 days</option></select></label>
      </div>
      <DenseTable columns={[
        { key: 'timestamp', label: 'Time', render: row => formatDateTimeEuro(row.timestamp) },
        { key: 'orgId', label: 'Organization', render: row => c.organizations.find(org => org.id === row.orgId)?.name || row.orgId || 'Unknown' },
        { key: 'issueKey', label: 'Issue key' }, { key: 'operation', label: 'Operation' }, { key: 'error', label: 'Safe error summary' },
        { key: 'details', label: 'Safe details', render: row => row.details ? <details><summary>Details</summary><pre>{typeof row.details === 'string' ? row.details : JSON.stringify(row.details, null, 2)}</pre></details> : 'Not recorded' }
      ]} rows={rows} empty={webhook ? 'No retained errors match this filter.' : 'Webhook error records unavailable.'} />
      {Array.isArray(webhook?.errors) && webhook.errors.length > 0 && <div className="table-actions"><Button onClick={c.handleClearWebhookErrors}>Clear installation webhook errors</Button><span className="muted">Clears the retained error list across all organizations, including records outside this filter.</span></div>}
    </Panel>
    <Panel title="Scheduled activity" detail="Installation-wide · available retained records">
      <DenseTable columns={[{ key: 'timestamp', label: 'Time', render: row => formatDateTimeEuro(row.timestamp) }, { key: 'type', label: 'Type' }, { key: 'message', label: 'Safe summary' }]}
        rows={(Array.isArray(scheduled?.events) ? scheduled.events : []).map(row => typeof row === 'string' ? { message: row } : row)} />
      <DenseTable columns={[{ key: 'error', label: 'Retained scheduled error' }]} rows={(Array.isArray(scheduled?.errors) ? scheduled.errors : []).map(row => ({ error: typeof row === 'string' ? row : row.error || 'Not recorded' }))} empty="No retained scheduled errors." />
    </Panel>
    <WitnessAuditLog showMessage={c.showMessage} />
  </>;
}
