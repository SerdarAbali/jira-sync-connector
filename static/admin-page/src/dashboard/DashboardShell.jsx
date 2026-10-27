import React from 'react';
import Select from '@atlaskit/select';
import Button from '@atlaskit/button';
import { PRIMARY_PAGES } from './navigation';

export function SecondaryNavigation({ items, value, onChange, label }) {
  return <nav className="secondary-nav" aria-label={label}>{items.map(([id, title]) =>
    <button key={id} type="button" aria-current={value === id ? 'page' : undefined}
      onClick={() => onChange(id)}>{title}</button>)}</nav>;
}

export function WriteState({ stats }) {
  const pilot = stats?.pilot;
  const known = typeof pilot?.paused === 'boolean' && pilot?.success !== false;
  return <span className={`status ${!known ? 'neutral' : pilot.paused ? 'warning' : 'neutral'}`}>
    {known ? pilot.paused ? 'Jira writes paused' : 'Emergency pause off' : 'Write state unavailable'}
  </span>;
}

export default function DashboardShell({ controller: c, route, navigate, version, children }) {
  const selectedOrg = c.selectedOrg;
  return <div className="admin-dashboard">
    <header className="dashboard-header">
      <div className="brand"><span className="brand-mark" aria-hidden="true">⇄</span><div><strong>SyncApp</strong><small>Administration · Application {version}</small></div></div>
      <div className="organization-picker">
        <label htmlFor="admin-organization-select">Organization scope</label>
        <Select inputId="admin-organization-select" placeholder="Select organization" isClearable={false}
          options={c.organizations.map(org => ({ label: org.name, value: org.id }))}
          value={selectedOrg ? { label: selectedOrg.name, value: selectedOrg.id } : null}
          onChange={(option) => c.selectOrganization(option?.value || null)} />
      </div>
      <Button onClick={() => { c.setEditingOrg(null); c.setShowOrgModal(true); }}>Add organization</Button>
    </header>
    <nav className="primary-nav" aria-label="Primary navigation">
      <div className="desktop-navigation">{PRIMARY_PAGES.map(([id, label]) => <button type="button" key={id}
        aria-current={route.page === id ? 'page' : undefined} onClick={() => navigate(id)}>{label}</button>)}</div>
      <label className="mobile-navigation">Page <select aria-label="Page" value={route.page}
        onChange={event => navigate(event.target.value)}>{PRIMARY_PAGES.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
    </nav>
    <div className={`installation-strip ${c.syncStats?.pilot?.paused === true ? 'is-paused' : ''}`}><span>Installation-wide</span><WriteState stats={c.syncStats} />
      <button type="button" className="text-button" onClick={() => navigate('recovery', 'write-controls')}>Write controls</button>
      <span className="scope-context">{selectedOrg ? `Organization: ${selectedOrg.name}` : 'No organization selected'}</span>
    </div>
    <main id="dashboard-main" className="dashboard-main">{children}</main>
    <footer className="dashboard-footer">Atlassian Forge · Configuration and operations console</footer>
  </div>;
}
