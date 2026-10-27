import React, { useState } from 'react';
import Button from '@atlaskit/button';
import { count, available, usable, recordedHistory, withinPeriod } from './metrics';
import { formatDateTimeEuro } from './presentation';
import { WriteState } from './DashboardShell';

export function PageHeading({ eyebrow, title, description, children }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div><div className="page-actions">{children}</div></div>;
}
export function Panel({ title, detail, children, className = '' }) {
  return <section className={`dashboard-panel ${className}`}><div className="panel-heading"><h2>{title}</h2>{detail && <span className="muted">{detail}</span>}</div>{children}</section>;
}
export function Metric({ label, value, detail }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
}
export function Empty({ children }) { return <div className="empty-state">{children}</div>; }
export function DenseTable({ columns, rows, empty = 'Not recorded' }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return <div className="table-scroll"><table className="dense-table"><thead><tr>{columns.map(column => <th scope="col" key={column.key}>{column.label}</th>)}</tr></thead>
    <tbody>{rows.map((row, index) => <tr key={row.id || index}>{columns.map(column => <td key={column.key}>{column.render ? column.render(row) : row[column.key] ?? 'Not recorded'}</td>)}</tr>)}</tbody></table></div>;
}
export function OverviewPage({ controller: c, navigate }) {
  const webhook = usable(c.syncStats?.webhook);
  const selected = c.selectedOrg;
  const orgStats = selected ? usable(webhook?.byOrg?.[selected.id]) : null;
  return <>
    <PageHeading eyebrow="Installation overview" title="Connection workspace" description="Configuration, recorded activity and operational safety at a glance.">
      <Button onClick={c.loadStats} isLoading={c.statsLoading}>Refresh statistics</Button>
    </PageHeading>
    <Panel className="overview-kpis" title="Recorded webhook activity" detail={orgStats ? selected.name : 'Installation-wide · cumulative recorded counters'}>
      <div className="metric-grid">{[['Attempts', 'totalSyncs'], ['Issues created', 'issuesCreated'], ['Issues updated', 'issuesUpdated'], ['Comments synced', 'commentsSynced']].map(([label, field]) =>
        <Metric key={field} label={label} value={count((orgStats || webhook)?.[field])} />)}</div>
      {selected && !orgStats && <p className="muted">Organization counters are not recorded. Values above cover the installation.</p>}
    </Panel>
    <div className="overview-grid">
      <Panel className="organization-summary" title="Organization workspace" detail={selected ? 'Selected organization' : 'Explicit selection required'}>
        {selected ? <><h3>{selected.name}</h3><p className="muted break-word">{selected.remoteUrl || 'Jira URL not configured'}</p>
          <dl className="summary-list"><dt>Configuration</dt><dd>{selected.remoteUrl && selected.hasRemoteApiToken ? 'Connection details configured' : 'Incomplete'}</dd>
            <dt>Direction</dt><dd>{selected.syncDirection === 'bidirectional' ? 'Two-way' : 'Push only'}</dd>
            <dt>Source projects</dt><dd>{selected.allowedProjects?.length ?? 0} selected</dd>
            <dt>Latest sync activity</dt><dd>{formatDateTimeEuro(c.lastSyncTime)}</dd>
            <dt>Live connectivity</dt><dd>Not checked on this page</dd></dl>
          <Button onClick={() => navigate('organizations', 'connection')}>Manage organization</Button></>
          : <Empty>Select an organization to inspect its configuration. Installation totals remain available below.</Empty>}
      </Panel>
      <Panel className="installation-safety" title="Installation write safety" detail="Independent controls">
        <div className="safety-state"><WriteState stats={c.syncStats} /></div>
        <p>Synchronization authorization, setup approval and job approval are separate requirements. An emergency pause blocks synchronization writes; approved maintenance uses its existing separate permit controls.</p>
        <p className="muted">A configured connection or an inactive emergency pause does not prove Jira writes are authorized or healthy.</p>
        <Button onClick={() => navigate('recovery', 'write-controls')}>Review write controls</Button>
      </Panel>
    </div>
    <div className="overview-grid">
      <Panel className={(Array.isArray(webhook?.errors) ? webhook.errors : []).some(row => !selected || row.orgId === selected.id) ? 'has-errors' : ''} title="Recent errors" detail="Retained webhook records">
        <DenseTable columns={[{ key: 'timestamp', label: 'Time', render: row => formatDateTimeEuro(row.timestamp) }, { key: 'operation', label: 'Operation' }, { key: 'error', label: 'Safe error summary' }]}
          rows={(Array.isArray(webhook?.errors) ? webhook.errors : []).filter(row => !selected || row.orgId === selected.id).slice(0, 5)} empty="No retained errors in this scope. This is not a complete operation history." />
        <button className="text-button" onClick={() => navigate('activity')}>Open activity</button>
      </Panel>
      <Panel title="Synchronization workflows" detail={selected?.name || 'Select an organization'}>
        <p>Review initial backfill progress, recurring source reconciliation and attention records in the organization workspace.</p>
        <Button isDisabled={!selected} onClick={() => navigate('organizations', 'synchronization')}>Open synchronization</Button>
        <p className="muted">Latency trends and full synchronization history: Unavailable.</p>
      </Panel>
    </div>
  </>;
}

export function AnalyticsPage({ controller: c }) {
  const [scope, setScope] = useState('installation');
  const [period, setPeriod] = useState('all');
  const webhook = usable(c.syncStats?.webhook);
  const api = usable(c.syncStats?.apiUsage);
  const scheduled = usable(c.syncStats?.scheduled);
  const orgId = scope === 'organization' ? c.selectedOrg?.id : null;
  const web = scope === 'organization' ? usable(webhook?.byOrg?.[orgId]) : webhook;
  const apiOrg = scope === 'organization' ? usable(api?.byOrg?.[orgId]) : api;
  const history = withinPeriod(recordedHistory(api?.history), period, row => `${row.hour}:00:00Z`, Date.now());
  const max = Math.max(1, ...history.map(row => row.calls));
  return <>
    <PageHeading eyebrow="Recorded telemetry" title="Analytics" description="Counters cover instrumented activity. Attempts, skips and successful writes are different measures.">
      <Button onClick={c.loadStats} isLoading={c.statsLoading}>Refresh statistics</Button>
    </PageHeading>
    <div className="filter-bar"><label>Counter scope <select aria-label="Counter scope" value={scope} onChange={event => setScope(event.target.value)}>
      <option value="installation">Installation-wide</option><option value="organization" disabled={!c.selectedOrg}>Selected organization</option></select></label>
      <span className="muted">Cumulative counters have no date filter.</span></div>
    <Panel title="Webhook operations" detail={scope === 'organization' ? c.selectedOrg?.name : 'Installation-wide'}>
      <div className="metric-grid">{[['Attempts', 'totalSyncs'], ['Created', 'issuesCreated'], ['Updated', 'issuesUpdated'], ['Comments', 'commentsSynced'], ['Skipped', 'issuesSkipped'], ['Loops prevented', 'loopsPrevented']].map(([label, field]) => <Metric key={field} label={label} value={count(web?.[field])} />)}</div>
      <div className="timestamp-row"><span>Last attempt: {formatDateTimeEuro(web?.lastSync)}</span><span>Last successful Jira write: {formatDateTimeEuro(web?.lastSuccessfulJiraWrite)}</span></div>
      <p className="muted">Skipped counters can include unsuccessful attempts. Retained errors cannot establish a failure rate. Historical success/failure trends: Unavailable.</p>
    </Panel>
    <Panel title="API usage & rate-limit observations" detail={scope === 'organization' ? c.selectedOrg?.name : 'Installation-wide'}>
      <div className="metric-grid"><Metric label="Recorded calls" value={count(scope === 'organization' ? apiOrg?.calls : api?.totalCalls)} />
        <Metric label="Rate-limit hits" value={count(scope === 'organization' ? apiOrg?.rateLimits : api?.rateLimitHits)} />
        {scope === 'installation' && <><Metric label="Successful calls" value={count(api?.successfulCalls)} /><Metric label="Failed calls" value={count(api?.failedCalls)} />
          <Metric label="Recorded call success" value={available(api?.totalCalls) && api.totalCalls > 0 && available(api.successfulCalls) ? `${Math.round(api.successfulCalls / api.totalCalls * 100)}%` : 'Not recorded'} /></>}
        <Metric label="Actual remaining capacity" value="Unavailable" /></div>
      <p className="muted">Request counts are not Atlassian quota measurements. Actual quota usage and remaining allocation are not available here.</p>
      {scope === 'installation' && <><div className="timestamp-row"><span>Last recorded: {formatDateTimeEuro(api?.lastUpdated)}</span><span>Last rate limit: {formatDateTimeEuro(api?.lastRateLimitHit)}</span></div>
        <DenseTable columns={[{ key: 'type', label: 'Endpoint category' }, { key: 'calls', label: 'Recorded calls', render: row => count(row.calls) }, { key: 'rateLimits', label: 'Rate-limit hits', render: row => count(row.rateLimits) }]}
          rows={Object.entries(api?.byEndpoint || {}).map(([type, row]) => ({ ...row, type })).sort((a, b) => b.calls - a.calls)} />
      </>}
    </Panel>
    {scope === 'installation' ? <>
      <Panel title="Recorded API hourly history" detail="Installation-wide · up to 24 retained completed-hour buckets">
        <div className="filter-bar"><label>Recorded-hour range <select aria-label="Recorded-hour range" value={period} onChange={event => setPeriod(event.target.value)}><option value="all">All retained buckets</option><option value="24">Last 24 hours</option><option value="6">Last 6 hours</option></select></label></div>
        {history.length ? <>
          <div className="chart-legend" aria-label="Chart legend"><span><i className="legend-swatch" aria-hidden="true" />Recorded calls</span><span><i className="legend-swatch limited" aria-hidden="true" />Recorded rate-limit hits · amber hour</span></div>
          <div className="chart-scale">Peak recorded hour: {count(Math.max(...history.map(row => row.calls)))} calls</div>
          <div className="history-chart" role="group" aria-label="Recorded API calls by UTC hour; missing hours have no recorded value">
            {history.map(row => {
              const hourLabel = `${row.hour.replace('T', ' ')}:00 UTC`;
              const description = `${hourLabel}: ${count(row.calls)} recorded calls; ${count(row.rateLimits)} rate-limit hits`;
              return <div className="history-column" key={row.hour} tabIndex={0} aria-label={description} title={description}>
                <span>{count(row.calls)}</span>
                <div className={`bar ${row.rateLimits > 0 ? 'warning' : ''} ${row.calls === 0 ? 'is-zero' : ''}`} style={{ height: `${row.calls === 0 ? 1 : Math.max(2, row.calls / max * 105)}px` }} />
                <small>{row.hour.slice(5, 10)}<br />{row.hour.slice(11)}:00</small>
                <span className="chart-tooltip" aria-hidden="true">{description}</span>
              </div>;
            })}
          </div>
          <div className="chart-axis-label">Recorded hour · UTC</div>
          <DenseTable columns={[{ key: 'hour', label: 'UTC hour' }, { key: 'calls', label: 'Calls', render: row => count(row.calls) }, { key: 'rateLimits', label: 'Rate-limit hits', render: row => count(row.rateLimits) }]} rows={history} /></> : <Empty>No recorded buckets in this range.</Empty>}
        <p className="muted">Bar height represents recorded calls; amber marks an hour with recorded rate-limit hits. Missing hours are unknown, not zero. Current-hour completeness and historical latency are unavailable.</p>
      </Panel>
      <Panel title="Scheduled synchronization" detail="Installation-wide · stored counters">
        <div className="metric-grid">{[['Checked', 'issuesChecked'], ['Created', 'issuesCreated'], ['Updated', 'issuesUpdated'], ['Already current', 'issuesAlreadyCurrent'], ['Skipped', 'issuesSkipped'], ['Failed', 'issuesFailed'], ['Recreated', 'issuesRecreated']].map(([label, field]) => <Metric key={field} label={label} value={count(scheduled?.[field])} />)}</div>
        <div className="timestamp-row"><span>Last run: {formatDateTimeEuro(scheduled?.lastRun)}</span><span>Last successful Jira write: {formatDateTimeEuro(scheduled?.lastSuccessfulJiraWrite)}</span></div>
      </Panel>
    </> : <Empty>Scheduled totals and API hourly history have no organization-level series. They remain available under Installation-wide.</Empty>}
  </>;
}
