import fs from 'fs';
import path from 'path';
import {
  SELECTED_ORGANIZATION_STORAGE_KEY,
  readStoredOrganizationId,
  resolveSelectedOrganizationId,
  storeSelectedOrganizationId
} from '../static/admin-page/src/org-selection.js';

const APP_PATH = path.join(process.cwd(), 'static/admin-page/src/hooks/useAdminController.js');
const app = fs.readFileSync(APP_PATH, 'utf8');

const organizations = [
  { id: 'org-1', name: 'Source Mobile', allowedProjects: ['MOB'] },
  { id: 'org-1792934416107', name: 'Source DEV', allowedProjects: ['DEV'] }
];

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: jest.fn((key) => (key in data ? data[key] : null)),
    setItem: jest.fn((key, value) => {
      data[key] = String(value);
    }),
    removeItem: jest.fn((key) => {
      delete data[key];
    }),
    dump: () => data
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('organization selection resolution', () => {
  test('never falls back to the first organization when nothing is selected', () => {
    expect(resolveSelectedOrganizationId(organizations, null)).toBeNull();
    expect(resolveSelectedOrganizationId(organizations, undefined)).toBeNull();
    expect(resolveSelectedOrganizationId(organizations, '')).toBeNull();
  });

  test('keeps an explicitly selected organization', () => {
    expect(resolveSelectedOrganizationId(organizations, 'org-1792934416107'))
      .toBe('org-1792934416107');
  });

  test('drops a stale selection instead of silently retargeting another organization', () => {
    expect(resolveSelectedOrganizationId(organizations, 'org-deleted')).toBeNull();
    expect(resolveSelectedOrganizationId([], 'org-1')).toBeNull();
    expect(resolveSelectedOrganizationId(null, 'org-1')).toBeNull();
    expect(resolveSelectedOrganizationId([{ name: 'missing id' }], null)).toBeNull();
  });
});

describe('organization selection persistence', () => {
  test('a stored selection is restored only while that organization still exists', () => {
    storeSelectedOrganizationId('org-1792934416107');
    const stored = readStoredOrganizationId();

    expect(stored).toBe('org-1792934416107');
    expect(resolveSelectedOrganizationId(organizations, stored)).toBe('org-1792934416107');
    expect(resolveSelectedOrganizationId(organizations.slice(0, 1), stored)).toBeNull();
  });

  test('clearing the selection removes the stored value', () => {
    storeSelectedOrganizationId('org-1');
    storeSelectedOrganizationId(null);

    expect(readStoredOrganizationId()).toBeNull();
    expect(window.localStorage.getItem(SELECTED_ORGANIZATION_STORAGE_KEY)).toBeNull();
  });

  test('storage failures are tolerated without breaking the page', () => {
    const broken = {
      getItem: () => { throw new Error('storage unavailable'); },
      setItem: () => { throw new Error('storage unavailable'); },
      removeItem: () => { throw new Error('storage unavailable'); }
    };

    expect(() => readStoredOrganizationId(broken)).not.toThrow();
    expect(readStoredOrganizationId(broken)).toBeNull();
    expect(() => storeSelectedOrganizationId('org-1', broken)).not.toThrow();
  });

  test('unexpected stored values never resolve to an organization', () => {
    const storage = memoryStorage({ [SELECTED_ORGANIZATION_STORAGE_KEY]: '{"id":"org-1"}' });
    expect(readStoredOrganizationId(storage)).toBe('{"id":"org-1"}');
    expect(resolveSelectedOrganizationId(organizations, readStoredOrganizationId(storage))).toBeNull();

    const empty = memoryStorage({ [SELECTED_ORGANIZATION_STORAGE_KEY]: '' });
    expect(readStoredOrganizationId(empty)).toBeNull();
  });
});

describe('admin page organization selection wiring', () => {
  test('loading organizations no longer selects the first organization implicitly', () => {
    expect(app).not.toContain('setSelectedOrgId(orgs[0].id)');
    expect(app).not.toContain('organizations[0]?.id');
    expect(app).toContain('resolveSelectedOrganizationId(');
  });

  test('the selected organization is restored from and persisted to storage', () => {
    expect(app).toContain('useState(() => selection)');
    expect(app).toContain('const nextSelection = resolveSelectedOrganizationId(orgs, selectedOrgIdRef.current)');
    expect(app).toContain('storeSelectedOrganizationId(nextSelection)');
    expect(fs.readFileSync(path.join(process.cwd(), 'static/admin-page/src/dashboard/DashboardShell.jsx'), 'utf8')).toContain('onChange={(option) => c.selectOrganization(');
    expect(app).toContain('if (selectionReady && selectedOrgId)');
  });

  test('deleting the selected organization clears the selection', () => {
    const start = app.indexOf('const executeDeleteOrg = async');
    const end = app.indexOf('const handleTestConnection = async', start);
    const handler = app.slice(start, end);

    expect(handler).toContain('selectOrganization(null)');
    expect(handler).not.toContain('organizations[0]');
  });

  test('an empty selection requires an explicit organization choice', () => {
    expect(fs.readFileSync(path.join(process.cwd(), 'static/admin-page/src/dashboard/OrganizationsPage.jsx'), 'utf8')).toContain('Select an organization to view or edit its configuration.');
  });

  test('saving the project filter does not resubmit or clear the JQL filter', () => {
    const start = app.indexOf('const handleSaveProjectFilter = async');
    const end = app.indexOf('const addMapping =', start);
    const handler = app.slice(start, end);

    expect(handler).toContain('allowedProjects: selectedOrg.allowedProjects || []');
    expect(handler).toMatch(/id: selectedOrg\.id/);
    expect(handler).not.toMatch(/jqlFilter\s*:/);
  });
});
