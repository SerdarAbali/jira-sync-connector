/**
 * Optional mapping-based sprint synchronization.
 *
 * All Jira transports are injected. The tests verify that mappings are explicit,
 * preview is read-only, only add-only sprint posts are issued, and closed,
 * missing, ambiguous or unauthorized states fail closed.
 */
import {
  SPRINT_SYNC_ERRORS,
  applySprintSync,
  getSprintSyncStatus,
  previewSprintSync,
  saveSprintMapping
} from '../src/services/sync/sprint-sync.js';

const ORG = {
  id: 'org-1',
  name: 'Pilot',
  remoteUrl: 'https://remote.example.com/jira',
  remoteEmail: 'operator@example.com',
  remoteApiToken: 'TOKEN',
  remoteProjectKey: 'VEND',
  allowedProjects: ['LOCAL'],
  syncDirection: 'push'
};

const PAUSED = { paused: true, reasonCode: 'PILOT_CHANGE' };

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

function sprint(id, name, state = 'active') {
  return { id, name, state, originBoardId: 7 };
}

function issue(key, projectKey) {
  return { key, fields: { project: { key: projectKey } } };
}

function createDeps(overrides = {}) {
  const store = new Map();
  store.set('syncOptions:org-1', { syncSprints: true });
  store.set('sprintMappings:org-1', [{
    version: 1,
    localSprintId: '10',
    remoteSprintId: '20',
    localName: 'Local Sprint',
    remoteName: 'Remote Sprint',
    localState: 'active',
    remoteState: 'active',
    verifiedAt: '2026-01-01T00:00:00.000Z'
  }]);
  const localSprints = {
    10: sprint('10', 'Local Sprint'),
    11: sprint('11', 'Closed Local', 'closed')
  };
  const remoteSprints = {
    20: sprint('20', 'Remote Sprint'),
    21: sprint('21', 'Closed Remote', 'closed')
  };
  const localIssues = {
    10: [issue('LOCAL-1', 'LOCAL'), issue('LOCAL-2', 'LOCAL')],
    11: [issue('LOCAL-3', 'LOCAL')]
  };
  const remoteIssues = {
    20: [issue('VEND-1', 'VEND')],
    21: [issue('VEND-2', 'VEND')]
  };
  const posted = [];

  const deps = {
    getStored: async (key) => store.get(key) ?? null,
    setStored: async (key, value) => { store.set(key, value); },
    readPause: async () => ({ ...PAUSED }),
    getOrganizations: async () => [ORG],
    getRemoteKey: async (localKey) => ({
      'LOCAL-1': 'VEND-1',
      'LOCAL-2': 'VEND-2'
    }[localKey] || null),
    getLocalKey: async (remoteKey) => ({
      'VEND-1': 'LOCAL-1',
      'VEND-2': 'LOCAL-2'
    }[remoteKey] || null),
    readAuthorization: async () => ({ authorized: true }),
    issuePermit: jest.fn(async () => ({ permitId: 'test-permit' })),
    revokePermit: jest.fn(async () => true),
    localRequest: async ({ path, method = 'GET', body }) => {
      if (method === 'POST') {
        posted.push({ side: 'local', path, body });
        return response({});
      }
      if (path.includes('/issue')) {
        const id = path.match(/sprint\/(\d+)\/issue/)?.[1];
        return response({ issues: localIssues[id] || [], total: (localIssues[id] || []).length, isLast: true });
      }
      const id = path.match(/sprint\/(\d+)$/)?.[1];
      return localSprints[id] ? response(localSprints[id]) : response({}, 404);
    },
    remoteRequest: async (org, { path, method = 'GET', body }) => {
      if (method === 'POST') {
        posted.push({ side: 'remote', path, body });
        return response({});
      }
      if (path.includes('/issue')) {
        const id = path.match(/sprint\/(\d+)\/issue/)?.[1];
        return response({ issues: remoteIssues[id] || [], total: (remoteIssues[id] || []).length, isLast: true });
      }
      const id = path.match(/sprint\/(\d+)$/)?.[1];
      return remoteSprints[id] ? response(remoteSprints[id]) : response({}, 404);
    },
    auditWrite: async () => true,
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    store,
    posted,
    localSprints,
    remoteSprints,
    localIssues,
    remoteIssues,
    ...overrides
  };
  return deps;
}

describe('sprint synchronization', () => {
  test('defaults Off and preserves explicit option values in the config normalizer', async () => {
    const { normalizeSyncOptions, DEFAULT_SYNC_OPTIONS } = await import('../src/resolvers/config.js');
    expect(DEFAULT_SYNC_OPTIONS.syncSprints).toBe(false);
    expect(normalizeSyncOptions({}).syncSprints).toBe(false);
    expect(normalizeSyncOptions({ syncSprints: true }).syncSprints).toBe(true);
    expect(normalizeSyncOptions({ syncSprints: true, syncComments: false }))
      .toEqual(expect.objectContaining({ syncSprints: true, syncComments: false }));
  });

  test('verifies and stores an explicit mapping without using names', async () => {
    const deps = createDeps();
    const phrase = 'MAP SPRINT org-1 10 20';
    const result = await saveSprintMapping({
      orgId: 'org-1',
      localSprintId: '10',
      remoteSprintId: '20',
      confirmation: phrase,
      deps
    });
    expect(result.success).toBe(true);
    expect(result.mapping).toEqual(expect.objectContaining({
      localSprintId: '10',
      remoteSprintId: '20',
      localName: 'Local Sprint',
      remoteName: 'Remote Sprint'
    }));
    expect(deps.posted).toHaveLength(0);
  });

  test('rejects a mapping when the exact confirmation phrase is missing or wrong', async () => {
    const deps = createDeps();
    await expect(saveSprintMapping({
      orgId: 'org-1',
      localSprintId: '10',
      remoteSprintId: '20',
      deps
    })).rejects.toMatchObject({ code: SPRINT_SYNC_ERRORS.CONFIRMATION_REQUIRED });
    await expect(saveSprintMapping({
      orgId: 'org-1',
      localSprintId: '10',
      remoteSprintId: '20',
      confirmation: 'not the phrase',
      deps
    })).rejects.toMatchObject({ code: SPRINT_SYNC_ERRORS.CONFIRMATION_MISMATCH });
    expect(deps.posted).toHaveLength(0);
  });

  test('previews mapped additions read-only and applies only the remote additions', async () => {
    const deps = createDeps();
    const preview = await previewSprintSync({
      orgId: 'org-1',
      localSprintId: '10',
      remoteSprintId: '20',
      deps
    });
    expect(preview.success).toBe(true);
    expect(preview.readOnly).toBe(true);
    expect(preview.noWritesPerformed).toBe(true);
    expect(preview.status).toBe('ready');
    expect(preview.counts.remoteToAdd).toBe(1);
    expect(preview.counts.localToAdd).toBe(0);
    expect(preview.additions.remote).toEqual([
      { localKey: 'LOCAL-2', remoteKey: 'VEND-2' }
    ]);
    expect(deps.posted).toHaveLength(0);
    expect(deps.issuePermit).not.toHaveBeenCalled();

    const applied = await applySprintSync({
      orgId: 'org-1',
      localSprintId: '10',
      remoteSprintId: '20',
      digest: preview.digest,
      confirmation: preview.confirmationPhrase,
      deps
    });
    expect(applied.success).toBe(true);
    expect(applied.jiraWrites).toBe(1);
    expect(deps.issuePermit).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1',
      digest: preview.digest,
      entries: [expect.objectContaining({
        side: 'remote',
        sprintId: '20',
        host: 'remote.example.com',
        issues: ['VEND-2']
      })]
    }));
    expect(deps.revokePermit).toHaveBeenCalled();
    expect(deps.posted).toEqual([expect.objectContaining({
      side: 'remote',
      path: '/rest/agile/1.0/sprint/20/issue',
      body: JSON.stringify({ issues: ['VEND-2'] })
    })]);
  });


  test('adds local issues only for bidirectional organizations', async () => {
    const deps = createDeps({
      getOrganizations: async () => [{ ...ORG, syncDirection: 'bidirectional' }]
    });
    deps.remoteIssues[20] = [issue('VEND-1', 'VEND'), issue('VEND-2', 'VEND')];
    deps.localIssues[10] = [issue('LOCAL-1', 'LOCAL')];
    const preview = await previewSprintSync({
      orgId: 'org-1',
      localSprintId: '10',
      remoteSprintId: '20',
      deps
    });
    expect(preview.direction).toBe('bidirectional');
    expect(preview.counts.localToAdd).toBe(1);
    expect(preview.additions.local).toEqual([
      { localKey: 'LOCAL-2', remoteKey: 'VEND-2' }
    ]);
  });

  test('fails closed for absent mappings, closed sprints, and unreadable membership', async () => {
    const absent = createDeps();
    await expect(previewSprintSync({
      orgId: 'org-1',
      localSprintId: '10',
      remoteSprintId: '99',
      deps: absent
    })).rejects.toMatchObject({ code: SPRINT_SYNC_ERRORS.MAPPING_MISSING });

    const closed = createDeps({
      getStored: async (key) => {
        if (key === 'syncOptions:org-1') return { syncSprints: true };
        if (key === 'sprintMappings:org-1') {
          return [{ localSprintId: '10', remoteSprintId: '20', localState: 'active', remoteState: 'closed' }];
        }
        return null;
      },
      remoteRequest: async (org, { path }) => {
        if (path.includes('/issue')) return response({ issues: [], total: 0, isLast: true });
        return response(sprint('20', 'Remote', 'closed'));
      }
    });
    const closedPreview = await previewSprintSync({
      orgId: 'org-1',
      localSprintId: '10',
      remoteSprintId: '20',
      deps: closed
    });
    expect(closedPreview.status).toBe('blocked');
    expect(closedPreview.blockedReasons).toEqual(['closed-sprint']);

    const denied = createDeps({
      localRequest: async ({ path, method = 'GET' }) => {
        if (method === 'GET' && path.includes('/issue')) return response({}, 403);
        return response(sprint('10', 'Local'));
      }
    });
    await expect(previewSprintSync({
      orgId: 'org-1',
      localSprintId: '10',
      remoteSprintId: '20',
      deps: denied
    })).rejects.toMatchObject({ code: SPRINT_SYNC_ERRORS.ISSUES_UNREADABLE });
  });

  test('rejects stale or unauthorized applies before any sprint write', async () => {
    const stale = createDeps();
    await expect(applySprintSync({
      orgId: 'org-1',
      localSprintId: '10',
      remoteSprintId: '20',
      digest: `sha256:${'0'.repeat(64)}`,
      confirmation: 'SYNC SPRINT org-1 wrong',
      deps: stale
    })).rejects.toMatchObject({ code: SPRINT_SYNC_ERRORS.STALE_PREVIEW });
    expect(stale.posted).toHaveLength(0);

    const unauthorized = createDeps({
      readAuthorization: async () => ({ authorized: false, reason: 'SYNC_AUTHORIZATION_MISSING' })
    });
    const plan = await previewSprintSync({
      orgId: 'org-1',
      localSprintId: '10',
      remoteSprintId: '20',
      deps: unauthorized
    });
    await expect(applySprintSync({
      orgId: 'org-1',
      localSprintId: '10',
      remoteSprintId: '20',
      digest: plan.digest,
      confirmation: plan.confirmationPhrase,
      deps: unauthorized
    })).rejects.toMatchObject({ code: SPRINT_SYNC_ERRORS.AUTHORIZATION_REQUIRED });
    expect(unauthorized.posted).toHaveLength(0);
  });

  test('rejects preview and apply while Sync Sprints is Off', async () => {
    const deps = createDeps({
      getStored: async (key) => {
        if (key === 'syncOptions:org-1') return { syncSprints: false };
        return null;
      }
    });
    await expect(previewSprintSync({
      orgId: 'org-1',
      localSprintId: '10',
      remoteSprintId: '20',
      deps
    })).rejects.toMatchObject({ code: SPRINT_SYNC_ERRORS.OPTION_DISABLED });
    await expect(applySprintSync({
      orgId: 'org-1',
      localSprintId: '10',
      remoteSprintId: '20',
      digest: `sha256:${'0'.repeat(64)}`,
      confirmation: 'SYNC SPRINT org-1 wrong',
      deps
    })).rejects.toMatchObject({ code: SPRINT_SYNC_ERRORS.OPTION_DISABLED });
    expect(deps.posted).toHaveLength(0);
  });

  test('declares ADMIN policies and registers the sprint endpoints', async () => {
    const { RESOLVER_POLICIES } = await import('../src/resolvers/authorization-policy.js');
    const { createAuthorizedResolver } = await import('../src/resolvers/authorization.js');
    const { defineSprintSyncResolvers } = await import('../src/resolvers/sprint-sync.js');
    expect(RESOLVER_POLICIES.getSprintSyncStatus).toBe('ADMIN_READ');
    expect(RESOLVER_POLICIES.saveSprintMapping).toBe('ADMIN_WRITE');
    expect(RESOLVER_POLICIES.previewSprintSync).toBe('ADMIN_READ');
    expect(RESOLVER_POLICIES.applySprintSync).toBe('ADMIN_WRITE');
    const resolver = createAuthorizedResolver();
    defineSprintSyncResolvers(resolver);
    expect(resolver.getRegisteredNames()).toEqual(expect.arrayContaining([
      'getSprintSyncStatus',
      'saveSprintMapping',
      'previewSprintSync',
      'applySprintSync'
    ]));
  });
});

