import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { invoke } from '@forge/bridge';
import { App, ADMIN_UI_VERSION } from '../static/admin-page/src/App.jsx';
import { SELECTED_ORGANIZATION_STORAGE_KEY } from '../static/admin-page/src/org-selection.js';

jest.mock('@forge/bridge', () => ({
  invoke: jest.fn()
}), { virtual: true });

jest.mock('@atlaskit/css-reset', () => ({}), { virtual: true });

jest.mock('@atlaskit/tokens', () => ({
  token: (_name, fallback) => fallback
}), { virtual: true });

jest.mock('@atlaskit/button', () => {
  const ReactMock = require('react');
  const Button = ({ children, isDisabled, isLoading, appearance, spacing, ...props }) => ReactMock.createElement(
    'button',
    { ...props, disabled: Boolean(isDisabled) },
    children
  );
  return {
    __esModule: true,
    default: Button,
    LoadingButton: Button
  };
}, { virtual: true });

jest.mock('@atlaskit/icon/glyph/check-circle', () => {
  const ReactMock = require('react');
  return { __esModule: true, default: () => ReactMock.createElement('span', null, 'ok') };
}, { virtual: true });

jest.mock('@atlaskit/icon/glyph/error', () => {
  const ReactMock = require('react');
  return { __esModule: true, default: () => ReactMock.createElement('span', null, 'error') };
}, { virtual: true });

jest.mock('@atlaskit/icon/glyph/warning', () => {
  const ReactMock = require('react');
  return { __esModule: true, default: () => ReactMock.createElement('span', null, 'warning') };
}, { virtual: true });

jest.mock('@atlaskit/form', () => {
  const ReactMock = require('react');
  const Form = ({ children, onSubmit }) => children({ formProps: { onSubmit } });
  const Field = ({ children }) => children({ fieldProps: {} });
  return { __esModule: true, default: Form, Field };
}, { virtual: true });

jest.mock('@atlaskit/textfield', () => {
  const ReactMock = require('react');
  return {
    __esModule: true,
    default: ({ value, isDisabled, isInvalid, ...props }) => ReactMock.createElement('input', {
      ...props,
      value: value === undefined ? '' : value,
      disabled: Boolean(isDisabled)
    })
  };
}, { virtual: true });

jest.mock('@atlaskit/tabs', () => {
  const ReactMock = require('react');
  const Tabs = ({ children }) => ReactMock.createElement('div', null, children);
  const TabList = ({ children }) => ReactMock.createElement('div', null, children);
  const Tab = ({ children }) => ReactMock.createElement('div', null, children);
  const TabPanel = ({ children }) => ReactMock.createElement('div', null, children);
  return { __esModule: true, default: Tabs, Tab, TabList, TabPanel };
}, { virtual: true });

jest.mock('@atlaskit/select', () => {
  const R = require('react');
  return { __esModule: true, default: ({ inputId, value, options = [], onChange, placeholder, isDisabled }) =>
    R.createElement('select', { id: inputId, 'aria-label': inputId || placeholder, value: value?.value || '', disabled: isDisabled,
      onChange: event => onChange?.(options.find(option => String(option.value) === event.target.value) || null) },
      R.createElement('option', { value: '' }, placeholder || 'Choose'), ...options.map(option => R.createElement('option', { key: option.value, value: option.value }, option.label))) };
}, { virtual: true });

jest.mock('@atlaskit/spinner', () => {
  const ReactMock = require('react');
  return {
    __esModule: true,
    default: () => ReactMock.createElement('span', null, 'Loading')
  };
}, { virtual: true });

jest.mock('@atlaskit/section-message', () => {
  const ReactMock = require('react');
  return {
    __esModule: true,
    default: ({ children, title }) => ReactMock.createElement(
      'section',
      null,
      title || null,
      children
    )
  };
}, { virtual: true });

jest.mock('@atlaskit/checkbox', () => {
  const ReactMock = require('react');
  return {
    __esModule: true,
    default: ({ label, isChecked, isDisabled, isInvalid, ...props }) => ReactMock.createElement(
      'label',
      null,
      ReactMock.createElement('input', { ...props, type: 'checkbox', checked: Boolean(isChecked), disabled: Boolean(isDisabled), readOnly: true }),
      label || null
    )
  };
}, { virtual: true });

jest.mock('@atlaskit/modal-dialog', () => {
  const ReactMock = require('react');
  const Wrapper = ({ children }) => ReactMock.createElement('div', null, children);
  return {
    __esModule: true,
    default: Wrapper,
    ModalTransition: Wrapper,
    ModalHeader: Wrapper,
    ModalTitle: Wrapper,
    ModalBody: Wrapper,
    ModalFooter: Wrapper
  };
}, { virtual: true });

jest.mock('@atlaskit/lozenge', () => {
  const ReactMock = require('react');
  return {
    __esModule: true,
    default: ({ children }) => ReactMock.createElement('span', null, children)
  };
}, { virtual: true });


import { recordedHistory, withinPeriod } from '../static/admin-page/src/dashboard/metrics';
const ORGS = [
  { id: 'a', name: 'Organization Alpha', remoteUrl: 'https://alpha.example.invalid', allowedProjects: ['ALPHA'], syncDirection: 'bidirectional', hasRemoteApiToken: true },
  { id: 'b', name: 'Organization Beta', remoteUrl: 'https://beta.example.invalid', allowedProjects: ['BETA'], syncDirection: 'push', hasRemoteApiToken: true }
];
let container, root;
function response(name, payload) {
  if (name === 'getOrganizations') return ORGS;
  if (name === 'getPilotStatus') return { paused: true };
  if (name === 'getSyncAuthorizationStatus') return { success: true, authorized: false, state: 'blocked', confirmationPhrase: 'AUTHORIZE EXACT INSTALLATION' };
  if (name === 'getUserMappings') return { mappings: {} };
  if (name === 'getSyncOptions') return { syncComments: payload.orgId === 'a', syncAttachments: false };
  if (name === 'getAuditLog') return [];
  if (name === 'getInitialSyncStatus') return { success: true, status: null };
  if (name === 'getRecurringReconciliationStatus') return { success: true, settings: { recurringReconciliationEnabled: false }, attention: [] };
  if (name === 'getDeletedCounterparts') return { success: true, items: [] };
  if (name === 'getPairWitnessMigrationStatus') return { success: true, plan: null };
  if (name === 'setupWizard') return { success: true, organization: ORGS.find(org => org.id === payload.orgId), state: null, metadata: {} };
  if (name === 'getApiUsageStats') return { totalCalls: 0, successfulCalls: 0, successRate: 100, estimatedHourlyLimit: 36000, quotaUsagePercent: 75, estimatedRemainingQuota: 9000, history: [] };
  if (name === 'getWebhookSyncStats') return { totalSyncs: 14, issuesCreated: 2, byOrg: { a: { totalSyncs: 4 } }, errors: [] };
  if (name === 'getScheduledSyncStats') return { issuesChecked: 20 };
  return {};
}
async function flush() { await act(async () => { await Promise.resolve(); }); }
async function mount() { await act(async () => { root.render(<App />); }); await flush(); }
function button(text) { const result = [...container.querySelectorAll('button')].find(node => node.textContent.trim() === text); if (!result) throw new Error(`Missing button ${text}`); return result; }
async function click(text) { await act(async () => { button(text).click(); }); await flush(); }
async function select(id) {
  await act(async () => { const node = container.querySelector('#admin-organization-select'); node.value = id; node.dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
}
function input(node, value) {
  const setter = Object.getOwnPropertyDescriptor(node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
  setter.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
}
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks(); window.localStorage.clear(); window.localStorage.setItem(SELECTED_ORGANIZATION_STORAGE_KEY, 'a');
  invoke.mockImplementation(async (name, payload = {}) => response(name, payload));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); window.localStorage.clear(); delete global.IS_REACT_ACT_ENVIRONMENT; });

test('all primary and secondary navigation uses only read-policy resolvers', async () => {
  await mount();
  for (const page of ['Overview', 'Organizations', 'Analytics', 'Activity', 'Diagnostics', 'Recovery', 'About & Security']) await click(page);
  await click('Organizations');
  for (const section of ['Connection', 'Scope & direction', 'Mappings', 'Sync options', 'Synchronization', 'Guided Setup', 'Configuration transfer']) await click(section);
  await click('Recovery');
  for (const section of ['Write controls', 'Snapshots', 'Pairing witnesses', 'Ambiguous creates', 'Deleted counterparts', 'Targeted repair', 'Data transfer']) await click(section);
  const reads = new Set(['getOrganizations', 'getUserMappings', 'getFieldMappings', 'getStatusMappings', 'getIssueTypeMappings', 'getProjectMappings', 'getSyncOptions', 'getLastSyncTime', 'getRejectedFields', 'getScheduledSyncStats', 'getWebhookSyncStats', 'getApiUsageStats', 'getPilotStatus', 'getAuditLog', 'getInitialSyncStatus', 'getRecurringReconciliationStatus', 'getScheduledSyncConfig', 'getSyncAuthorizationStatus', 'getPairWitnessMigrationStatus', 'getDeletedCounterparts']);
  for (const [name, payload] of invoke.mock.calls) {
    expect(reads.has(name)).toBe(true);
  }
});

test('no selection keeps global pages reachable without organization reads or writes', async () => {
  window.localStorage.clear(); await mount();
  await click('Organizations'); expect(container.textContent).toContain('Select an organization to view or edit');
  await click('Analytics'); await click('Recovery');
  expect(container.textContent).toContain('Installation-wide write controls');
  expect(invoke.mock.calls.filter(([, payload]) => payload?.orgId)).toHaveLength(0);
});

test('organization switch discards an open authorization phrase and pending confirmation', async () => {
  await mount(); await click('Recovery');
  await act(async () => { input(container.querySelector('[aria-label="Authorization confirmation"]'), 'AUTHORIZE EXACT INSTALLATION'); });
  const authorize = [...container.querySelectorAll('button')].find(node => node.textContent.includes('Authorize synchronization'));
  expect(authorize.disabled).toBe(false);
  await select('b');
  expect(container.querySelector('[aria-label="Authorization confirmation"]').value).toBe('');
  expect([...container.querySelectorAll('button')].find(node => node.textContent.includes('Authorize synchronization')).disabled).toBe(true);
  expect(invoke.mock.calls.some(([name]) => name === 'authorizeSynchronization')).toBe(false);
});

test('organization switch closes deletion dialog and never deletes another organization', async () => {
  await mount(); await click('Organizations'); await click('Delete');
  expect(container.textContent).toContain('Delete Organization?'); await select('b');
  expect(container.textContent).not.toContain('Delete Organization?');
  expect(invoke.mock.calls.some(([name]) => name === 'deleteOrganization')).toBe(false);
});

test('late organization data cannot replace the newly selected configuration', async () => {
  let completeAlpha;
  invoke.mockImplementation((name, payload = {}) => name === 'getSyncOptions' && payload.orgId === 'a'
    ? new Promise(resolve => { completeAlpha = resolve; }) : Promise.resolve(response(name, payload)));
  await mount(); await select('b'); await click('Organizations'); await click('Sync options');
  await act(async () => { completeAlpha({ syncComments: true, syncAttachments: true }); }); await flush();
  expect(container.querySelector('input[name="syncComments"]').checked).toBe(false);
  expect(container.querySelector('input[name="syncAttachments"]').checked).toBe(false);
});

test('initial-sync preview approval is lost on organization change', async () => {
  invoke.mockImplementation(async (name, payload = {}) => name === 'previewInitialSync' ? { success: true, preview: { previewChecksum: 'alpha-preview', configurationChecksum: 'alpha-config', counts: { eligible: 1 }, classification: {} } } : response(name, payload));
  await mount(); await click('Organizations'); await click('Synchronization'); await click('Preview Scope');
  const approval = [...container.querySelectorAll('label')].find(label => label.textContent.includes('I approve this exact previewed scope')).querySelector('input');
  await act(async () => approval.click());
  await select('b');
  expect(container.textContent).not.toContain('I approve this exact previewed scope');
  expect(invoke.mock.calls.some(([name]) => name === 'startInitialSync')).toBe(false);
});

test('witness selected-pair drafts and approvals are discarded on organization change', async () => {
  await mount(); await click('Recovery'); await click('Pairing witnesses');
  await act(async () => input(container.querySelector('[aria-label="Witness migration pair selection"]'), 'ALPHA-1 REMOTE-1'));
  expect(button('Build plan').disabled).toBe(false); await select('b');
  expect(container.querySelector('[aria-label="Witness migration pair selection"]').value).toBe('');
  expect(button('Build plan').disabled).toBe(true);
  expect(invoke.mock.calls.some(([name]) => /^(approve|apply)PairWitness/.test(name))).toBe(false);
});

test('manual issue draft is discarded and repair invocation uses the current organization', async () => {
  await mount(); await click('Recovery'); await click('Targeted repair');
  await act(async () => input(container.querySelector('input[placeholder="e.g., PROJ-123"]'), 'ALPHA-9'));
  await select('b'); expect(container.querySelector('input[placeholder="e.g., PROJ-123"]').value).toBe('');
  await act(async () => input(container.querySelector('input[placeholder="e.g., PROJ-123"]'), 'BETA-2'));
  await click('Sync Now'); expect(invoke).toHaveBeenCalledWith('forceSyncIssue', { issueKey: 'BETA-2', orgId: 'b' });
});

test('analytics rejects fabricated quota and zero-sample success values', async () => {
  await mount(); await click('Analytics');
  expect(container.textContent).toContain('Actual remaining capacityUnavailable');
  expect(container.textContent).toContain('Recorded call successNot recorded');
  expect(container.textContent).not.toContain('75%'); expect(container.textContent).not.toContain('100%'); expect(container.textContent).not.toContain('9,000');
});

test('unavailable organization counters never fall back to installation totals', async () => {
  await mount(); await select('b'); await click('Analytics');
  const scope = container.querySelector('[aria-label="Counter scope"]');
  await act(async () => { scope.value = 'organization'; scope.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.textContent).toContain('AttemptsNot recorded');
  expect(container.textContent).toContain('Scheduled totals and API hourly history have no organization-level series');
});

test('recorded history preserves gaps and applies dates only to real timestamps', () => {
  const rows = recordedHistory([{ hour: '2026-10-27T12', calls: 9 }, { hour: '2026-10-27T10', calls: 0 }, { hour: 'unknown', calls: 8 }]);
  expect(rows.map(row => row.hour)).toEqual(['2026-10-27T10', '2026-10-27T12']);
  expect(withinPeriod(rows, '1', row => `${row.hour}:00:00Z`, Date.parse('2026-10-27T12:30:00Z'))).toHaveLength(1);
});

test('failed audit feedback is readable and does not cause automatic reload loops', async () => {
  let reads = 0;
  invoke.mockImplementation(async (name, payload = {}) => {
    if (name === 'getAuditLog') { reads++; if (reads === 1) throw new Error('unavailable'); return []; }
    return response(name, payload);
  });
  await mount(); await click('Activity'); await flush();
  expect(reads).toBe(1);
  expect(container.querySelector('.feedback-region').textContent).toContain('audit');
  expect(container.querySelector('.feedback-region').textContent).not.toBe('error');
});

test('a failed statistics refresh invalidates that source without discarding other real metrics', async () => {
  await mount(); await click('Analytics');
  invoke.mockImplementation(async (name, payload = {}) => {
    if (name === 'getWebhookSyncStats') throw new Error('unavailable');
    if (name === 'getPilotStatus') throw new Error('unavailable');
    if (name === 'getApiUsageStats') return { totalCalls: 8, successfulCalls: 6 };
    return response(name, payload);
  });
  await click('Refresh statistics');
  expect(container.textContent).toContain('Write state unavailable');
  expect(container.textContent).toContain('AttemptsNot recorded');
  expect(container.textContent).toContain('Recorded calls8');
  expect(container.textContent).not.toContain('Attempts14');
});


test('loading setup metadata is an explicit action because the resolver is write-audited', async () => {
  await mount(); await click('Organizations'); await click('Guided Setup');
  expect(invoke.mock.calls.some(([name]) => name === 'setupWizard')).toBe(false);
  await click('Load Guided Setup');
  expect(invoke).toHaveBeenCalledWith('setupWizard', { action: 'load', orgId: 'a' });
  expect(container.textContent).toContain('Start Guided Setup');
});

test('a forbidden organization response is unavailable, never an empty configuration', async () => {
  invoke.mockImplementation(async (name, payload = {}) => name === 'getOrganizations'
    ? { success: false, code: 'FORBIDDEN' } : response(name, payload));
  await mount(); await click('Organizations');
  expect(container.textContent).toContain('Jira administrator permission is required');
  expect(container.textContent).not.toContain('No organizations configured');
  expect(container.textContent).not.toContain('Edit organization');
  await click('Diagnostics');
  expect(container.textContent).toContain('Please select an organization to run diagnostics.');
});

test('Overview puts real scoped KPIs before configuration and keeps write state explicit', async () => {
  await mount();
  const kpis = container.querySelector('.overview-kpis');
  expect(kpis).not.toBeNull();
  expect(kpis.textContent).toContain('Organization Alpha');
  expect(kpis.textContent).toContain('Attempts4');
  expect(kpis.textContent).toContain('Issues createdNot recorded');
  const workspace = [...container.querySelectorAll('section')].find(node => node.textContent.includes('Organization workspace'));
  expect(kpis.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(container.querySelector('.installation-safety').textContent).toContain('Jira writes paused');
});

test('hourly chart labels actual UTC dates and values with keyboard-accessible details', async () => {
  invoke.mockImplementation(async (name, payload = {}) => name === 'getApiUsageStats'
    ? { totalCalls: 9, successfulCalls: 9, history: [{ hour: '2026-10-26T23', calls: 0, rateLimits: 0 }, { hour: '2026-10-27T01', calls: 9, rateLimits: 2 }] }
    : response(name, payload));
  await mount(); await click('Analytics');
  const bars = container.querySelectorAll('.history-column[tabindex="0"]');
  expect(bars).toHaveLength(2);
  expect(bars[0].getAttribute('aria-label')).toContain('2026-10-26 23:00 UTC');
  expect(bars[0].getAttribute('aria-label')).toContain('0 recorded calls');
  expect(bars[1].getAttribute('aria-label')).toContain('2 rate-limit hits');
  expect(container.querySelector('.chart-legend').textContent).toContain('Recorded rate-limit hits');
  expect(container.querySelector('.chart-axis-label').textContent).toContain('UTC');
});

test('About & Security qualifies platform claims and preserves the diagram and support information', async () => {
  await mount(); await click('About & Security');
  const text = container.textContent;
  expect(text).not.toContain('Zero Data Egress');
  expect(text).not.toContain('never leaving the secure Atlassian network');
  expect(text).not.toContain('inherits Atlassian');
  expect(text).not.toContain('Secrets are never exposed');
  expect(text).toContain('shared responsibility');
  expect(text).toContain('one-time');
  expect(text).toContain('Data residency');
  expect(container.querySelector('svg[aria-labelledby]')).toBeTruthy();
  expect(container.querySelector('a[href="mailto:serdar@live.fi"]')).toBeTruthy();
});

test('application version comes from the product package and is explicitly labelled', async () => {
  const { version } = require('../package.json');
  expect(ADMIN_UI_VERSION).toBe(`v${version}`);
  await mount();
  expect(container.querySelector('.brand').textContent).toContain(`Application v${version}`);
  await click('About & Security');
  expect(container.textContent).toContain(`Application versionv${version}`);
  expect(container.textContent).toContain('Deployment version');
  expect(container.textContent).not.toContain('3.22.0');
});


test('informational navigation is About & Security in both desktop and narrow selectors', async () => {
  await mount();
  expect(button('About & Security')).toBeTruthy();
  expect([...container.querySelectorAll('button')].some(node => node.textContent.trim() === 'Settings')).toBe(false);
  const option = container.querySelector('select[aria-label="Page"] option[value="settings"]');
  expect(option.textContent).toBe('About & Security');
  await click('About & Security');
  expect(container.querySelector('h1').textContent).toBe('About & Security');
  expect(container.querySelector('main').textContent).toContain('Security & Architecture');
  expect(container.querySelector('.settings-content').querySelector('input, textarea, form')).toBeNull();
  await click('Organizations');
  expect(button('Sync options')).toBeTruthy();
  await click('Recovery');
  expect(button('Write controls')).toBeTruthy();
});
