import fs from 'fs';
import path from 'path';
import api from '@forge/api';
import { defineSyncResolvers } from '../src/resolvers/sync.js';
import { createAuthorizedResolver, forbiddenResponse } from '../src/resolvers/authorization.js';
import { RESOLVER_POLICIES } from '../src/resolvers/authorization-policy.js';
import { getOrganizationsWithTokens, getRemoteKey } from '../src/services/storage/mappings.js';
import { getFullIssue } from '../src/services/jira/local-client.js';
import { createRemoteIssue, updateRemoteIssue } from '../src/services/sync/issue-sync.js';
import { isProjectAllowedToSync } from '../src/utils/validation.js';
import * as kvsStore from '../src/services/storage/kvs.js';

jest.mock('@forge/api', () => {
  const requestJira = jest.fn();
  return {
    __esModule: true,
    default: {
      asUser: jest.fn(() => ({ requestJira })),
      asApp: jest.fn(() => ({ requestJira }))
    },
    route: (strings, ...values) =>
      strings.reduce((out, part, i) => out + part + (values[i] ?? ''), '')
  };
});

jest.mock('@forge/events', () => ({
  Queue: jest.fn(() => ({ push: jest.fn() }))
}));

jest.mock('../src/services/storage/kvs.js', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn()
}));

jest.mock('../src/services/storage/mappings.js', () => ({
  getRemoteKey: jest.fn(),
  getOrganizationsWithTokens: jest.fn()
}));

jest.mock('../src/services/jira/local-client.js', () => ({
  getFullIssue: jest.fn()
}));

jest.mock('../src/services/sync/issue-sync.js', () => ({
  createRemoteIssue: jest.fn(),
  updateRemoteIssue: jest.fn()
}));

jest.mock('../src/src/utils/validation.js', () => ({
  isProjectAllowedToSync: jest.fn()
}), { virtual: true });

jest.mock('../src/utils/validation.js', () => ({
  isProjectAllowedToSync: jest.fn()
}));

jest.mock('../src/services/storage/stats.js', () => ({
  logAuditEntry: jest.fn()
}));

jest.mock('../src/utils/logger.js', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const userRequestJira = api.asUser().requestJira;

function allowAdmin() {
  userRequestJira.mockResolvedValue({
    ok: true,
    json: async () => ({ permissions: { ADMINISTER: { havePermission: true } } })
  });
}

function denyAdmin() {
  userRequestJira.mockResolvedValue({
    ok: true,
    json: async () => ({ permissions: { ADMINISTER: { havePermission: false } } })
  });
}

describe('v2.1 RC2 final corrections', () => {
  const DIAGNOSTICS_PATH = path.join(process.cwd(), 'static/admin-page/src/components/Diagnostics.jsx');
  const APP_PATH = path.join(process.cwd(), 'static/admin-page/src/hooks/useAdminController.js');
  const diagnosticsSrc = fs.readFileSync(DIAGNOSTICS_PATH, 'utf8');
  const appSrc = fs.readFileSync(APP_PATH, 'utf8');

  let authorizedCallable;

  beforeEach(() => {
    jest.clearAllMocks();
    allowAdmin();
    kvsStore.get.mockResolvedValue(null);

    const resolver = createAuthorizedResolver({
      policies: RESOLVER_POLICIES
    });
    defineSyncResolvers(resolver);
    authorizedCallable = resolver.getDefinitions();
  });

  function invoke(payload = {}, accountId = 'admin-user') {
    return authorizedCallable(
      { call: { functionKey: 'forceSyncIssue', payload }, context: {} },
      { principal: { accountId } }
    );
  }

  describe('UI corrections', () => {
    test('confirmation text in Diagnostics.jsx no longer claims mapping removal', () => {
      expect(diagnosticsSrc).not.toContain('remove any existing mapping');
      expect(diagnosticsSrc).not.toMatch(/remove.*mapping/i);
      expect(diagnosticsSrc).toContain(
        "confirm('This will update the existing remote issue, or create one if the issue is not yet mapped. Proceed?')"
      );
    });

    test('manual sync in App.jsx passes selected orgId to forceSyncIssue', () => {
      expect(appSrc).toMatch(/invoke\(\s*'forceSyncIssue',\s*\{\s*issueKey:\s*manualIssueKey\.trim\(\),\s*orgId:\s*selectedOrgId\s*\}\s*\)/);
    });

    test('missing selected organization fails safely and does not invoke manual sync', () => {
      const handleManualSyncMatch = appSrc.match(/const handleManualSync = async \(\) => \{([\s\S]*?)\};/);
      expect(handleManualSyncMatch).toBeTruthy();
      const fnBody = handleManualSyncMatch[1];
      expect(fnBody).toMatch(/if\s*\(!selectedOrgId\)\s*\{\s*showMessage\([^)]+\);\s*return;\s*\}/);
      const orgCheckIndex = fnBody.indexOf('!selectedOrgId');
      const invokeIndex = fnBody.indexOf("invoke('forceSyncIssue'");
      expect(orgCheckIndex).toBeGreaterThan(-1);
      expect(invokeIndex).toBeGreaterThan(-1);
      expect(orgCheckIndex).toBeLessThan(invokeIndex);
    });
  });

  describe('Backend forceSyncIssue resolver safety and behavior', () => {
    test('non-administrator caller is rejected with FORBIDDEN', async () => {
      denyAdmin();

      const result = await invoke({ issueKey: 'TEST-1', orgId: 'org-1' });

      expect(result).toEqual(forbiddenResponse());
      expect(getOrganizationsWithTokens).not.toHaveBeenCalled();
      expect(getFullIssue).not.toHaveBeenCalled();
    });

    test('returns error when specified orgId does not match configured organizations', async () => {
      getOrganizationsWithTokens.mockResolvedValue([
        { id: 'org-1', name: 'Org 1', allowedProjects: ['TEST'] }
      ]);

      const result = await invoke({ issueKey: 'TEST-1', orgId: 'non-existent-org' });

      expect(result).toEqual({
        success: false,
        error: 'Organization not found'
      });
      expect(getFullIssue).not.toHaveBeenCalled();
    });

    test('scopes execution strictly to the specified orgId', async () => {
      const org1 = { id: 'org-1', name: 'Org 1', allowedProjects: ['TEST'] };
      const org2 = { id: 'org-2', name: 'Org 2', allowedProjects: ['TEST'] };
      getOrganizationsWithTokens.mockResolvedValue([org1, org2]);

      getFullIssue.mockResolvedValue({
        key: 'TEST-1',
        fields: { project: { key: 'TEST' } }
      });
      isProjectAllowedToSync.mockResolvedValue(true);
      getRemoteKey.mockResolvedValue('REMOTE-1');
      updateRemoteIssue.mockResolvedValue({ success: true });

      const result = await invoke({ issueKey: 'TEST-1', orgId: 'org-1' });

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].org).toBe('Org 1');
      expect(updateRemoteIssue).toHaveBeenCalledTimes(1);
      expect(updateRemoteIssue).toHaveBeenCalledWith(
        'TEST-1',
        'REMOTE-1',
        expect.anything(),
        org1,
        expect.anything(),
        null,
        null
      );
    });

    test('rejects sync when issue project is not in allowedProjects', async () => {
      getOrganizationsWithTokens.mockResolvedValue([
        { id: 'org-1', name: 'Org 1', allowedProjects: ['ALLOWED'] }
      ]);
      getFullIssue.mockResolvedValue({
        key: 'BLOCKED-1',
        fields: { project: { key: 'BLOCKED' } }
      });
      isProjectAllowedToSync.mockResolvedValue(false);

      const result = await invoke({ issueKey: 'BLOCKED-1', orgId: 'org-1' });

      expect(result.success).toBe(false);
      expect(result.results[0].error).toContain('Project BLOCKED not selected for sync');
      expect(updateRemoteIssue).not.toHaveBeenCalled();
      expect(createRemoteIssue).not.toHaveBeenCalled();
    });

    test('updates existing mapped issue without removing mapping or recreating', async () => {
      const org = { id: 'org-1', name: 'Org 1', allowedProjects: ['TEST'] };
      getOrganizationsWithTokens.mockResolvedValue([org]);
      getFullIssue.mockResolvedValue({
        key: 'TEST-1',
        fields: { project: { key: 'TEST' } }
      });
      isProjectAllowedToSync.mockResolvedValue(true);
      getRemoteKey.mockResolvedValue('REMOTE-99');
      updateRemoteIssue.mockResolvedValue({ success: true });

      const result = await invoke({ issueKey: 'TEST-1', orgId: 'org-1' });

      expect(result.success).toBe(true);
      expect(updateRemoteIssue).toHaveBeenCalledTimes(1);
      expect(createRemoteIssue).not.toHaveBeenCalled();
      expect(result.results[0].message).toContain('Updated TEST-1 → REMOTE-99');
    });

    test('creates new remote issue when unmapped', async () => {
      const org = { id: 'org-1', name: 'Org 1', allowedProjects: ['TEST'] };
      getOrganizationsWithTokens.mockResolvedValue([org]);
      getFullIssue.mockResolvedValue({
        key: 'TEST-2',
        fields: { project: { key: 'TEST' } }
      });
      isProjectAllowedToSync.mockResolvedValue(true);
      getRemoteKey.mockResolvedValue(null);
      createRemoteIssue.mockResolvedValue({ key: 'REMOTE-100' });

      const result = await invoke({ issueKey: 'TEST-2', orgId: 'org-1' });

      expect(result.success).toBe(true);
      expect(createRemoteIssue).toHaveBeenCalledTimes(1);
      expect(updateRemoteIssue).not.toHaveBeenCalled();
      expect(result.results[0].message).toContain('Created TEST-2 → REMOTE-100');
    });
  });
});
