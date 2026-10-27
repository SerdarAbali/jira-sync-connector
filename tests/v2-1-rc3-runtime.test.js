import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { invoke } from '@forge/bridge';
import { App, ADMIN_UI_VERSION } from '../static/admin-page/src/App.jsx';
import InitialSyncPanel from '../static/admin-page/src/components/InitialSyncPanel.jsx';
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
  const Form = ({ children, ...props }) => ReactMock.createElement('form', props, children);
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
  const ReactMock = require('react');
  return {
    __esModule: true,
    default: ({ value, placeholder, children }) => ReactMock.createElement(
      'div',
      null,
      value?.label || placeholder || '',
      children
    )
  };
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

const ORG = {
  id: 'org-1',
  name: 'Runtime Test Org',
  remoteUrl: 'https://remote.example.invalid',
  remoteEmail: 'sync@example.invalid',
  remoteProjectKey: 'REMOTE',
  allowedProjects: ['LOCAL'],
  syncDirection: 'push',
  hasRemoteApiToken: true
};

let container;
let root;
let syncOptionsFixture;
let recurringStatusFixture;
let scheduledConfigFixture;
let pilotStatusFixture;

function defaultInvoke(name) {
  switch (name) {
    case 'getOrganizations':
      return [ORG];
    case 'getUserMappings':
      return { mappings: {} };
    case 'getFieldMappings':
    case 'getStatusMappings':
    case 'getIssueTypeMappings':
    case 'getProjectMappings':
      return {};
    case 'getSyncOptions':
      return syncOptionsFixture;
    case 'getRejectedFields':
      return { fields: [] };
    case 'getLastSyncTime':
      return { lastSync: '2026-10-22T09:15:00.000Z' };
    case 'getScheduledSyncStats':
      return {
        lastRun: '2026-10-22T09:00:00.000Z',
        issuesChecked: 8,
        issuesUpdated: 2,
        issuesAlreadyCurrent: 3,
        issuesSkipped: 2,
        issuesFailed: 1,
        lastSuccessfulJiraWrite: '2026-10-22T08:59:00.000Z',
        errors: [],
        events: []
      };
    case 'getWebhookSyncStats':
      return {
        totalSyncs: 4,
        issuesCreated: 1,
        issuesUpdated: 2,
        commentsSynced: 1,
        issuesSkipped: 1,
        loopsPrevented: 0,
        lastSync: '2026-10-22T09:10:00.000Z',
        lastSuccessfulJiraWrite: '2026-10-22T09:09:00.000Z',
        errors: [],
        byOrg: {}
      };
    case 'getApiUsageStats':
      return {
        totalCalls: 10,
        successfulCalls: 9,
        failedCalls: 1,
        rateLimitHits: 0,
        successRate: 90,
        callsThisHour: 10,
        estimatedHourlyLimit: 36000,
        quotaUsagePercent: 0,
        byEndpoint: {},
        history: [],
        lastUpdated: '2026-10-22T09:12:00.000Z'
      };
    case 'getPilotStatus':
      return pilotStatusFixture;
    case 'getScheduledSyncConfig':
      return scheduledConfigFixture;
    case 'getDeletedCounterparts':
      return { success: true, items: [] };
    case 'getInitialSyncStatus':
      return { success: true, status: null };
    case 'getRecurringReconciliationStatus':
      return recurringStatusFixture;
    case 'setupWizard':
      return { success: false, error: 'Guided setup is not configured in this test.' };
    default:
      return { success: true };
  }
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

async function render(element) {
  await act(async () => {
    root.render(element);
  });
  await flush();
  await flush();
}

function findButton(label) {
  return Array.from(container.querySelectorAll('button'))
    .find(button => button.textContent.trim() === label);
}

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  syncOptionsFixture = {
    syncComments: true,
    syncAttachments: false,
    propagateAttachmentDeletions: false,
    maxAttachmentSizeBytes: null,
    syncLinks: true,
    syncCrossReference: true,
    recreateDeletedIssues: false,
    automaticReplacementAfterDeletion: false
  };
  pilotStatusFixture = {
    success: true,
    paused: false,
    pausedAt: null,
    pausedBy: null,
    reasonCode: null,
    organizations: []
  };
  recurringStatusFixture = {
    success: true,
    settings: {
      recurringReconciliationEnabled: false,
      reconciliationIntervalMinutes: 60,
      reconciliationCommentOnReview: true,
      reconciliationFailureThreshold: 3
    },
    schedule: {
      nextRunAt: null,
      lastCompletedAt: null,
      isDue: false
    },
    activeJob: null,
    lastJob: null,
    attention: [],
    attentionSummary: { notificationRequired: 0 }
  };
  scheduledConfigFixture = {
    enabled: true,
    syncScope: 'recent',
    intervalMinutes: 60,
    lastRun: '2026-10-22T09:00:00.000Z'
  };
  invoke.mockReset();
  invoke.mockImplementation(async (name) => defaultInvoke(name));

  // Existing scenarios operate on an explicitly selected organization, which
  // the page restores from storage instead of defaulting to the first one.
  window.localStorage.setItem(SELECTED_ORGANIZATION_STORAGE_KEY, ORG.id);

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  window.localStorage.clear();
  delete global.IS_REACT_ACT_ENVIRONMENT;
});

async function go(page, section) {
  await act(async () => { findButton(page).click(); });
  await flush();
  if (section) { await act(async () => { findButton(section).click(); }); await flush(); }
}

describe('v2.1.0-rc3 admin runtime', () => {
  test('renders all seven pages and the complete organization and recovery navigation', async () => {
    await render(React.createElement(App));
    expect(container.textContent).toContain(ADMIN_UI_VERSION);
    for (const page of ['Overview', 'Organizations', 'Analytics', 'Activity', 'Diagnostics', 'Recovery', 'About & Security']) {
      await go(page);
      expect(container.querySelector('h1')).toBeTruthy();
    }
    await go('Organizations');
    for (const section of ['Connection', 'Scope & direction', 'Mappings', 'Sync options', 'Synchronization', 'Guided Setup', 'Configuration transfer']) expect(findButton(section)).toBeTruthy();
    await go('Recovery');
    for (const section of ['Write controls', 'Snapshots', 'Pairing witnesses', 'Ambiguous creates', 'Deleted counterparts', 'Targeted repair', 'Data transfer']) expect(findButton(section)).toBeTruthy();
  });

  test('uses only non-pilot write-control wording and displays Synchronization Write Control', async () => {
    await render(React.createElement(App));
    await go('Recovery');

    const text = container.textContent;
    expect(text).toContain('Synchronization Write Control');
    expect(text).toContain('Write Status');
    expect(text).not.toMatch(/Corporate Pilot|Pilot Status|Pilot Controls|Pause Jira Writes|Resume Jira Writes/i);
  });

  test('keeps both pause and resume resolvers wired to the renamed write controls', async () => {
    await render(React.createElement(App));
    await go('Recovery');

    await act(async () => {
      findButton('Pause Synchronization').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const pauseConfirm = Array.from(container.querySelectorAll('button'))
      .filter(button => button.textContent.trim() === 'Pause Synchronization')
      .at(-1);
    await act(async () => {
      pauseConfirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(invoke).toHaveBeenCalledWith('pausePilot', { reasonCode: 'emergency_stop' });

    pilotStatusFixture = {
      ...pilotStatusFixture,
      paused: true,
      pausedAt: '2026-10-22T09:20:00.000Z',
      pausedBy: 'admin-1',
      reasonCode: 'emergency_stop'
    };
    await act(async () => {
      findButton('Refresh Stats').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    await flush();

    await act(async () => {
      findButton('Resume Synchronization').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const resumeConfirm = Array.from(container.querySelectorAll('button'))
      .filter(button => button.textContent.trim() === 'Resume Synchronization')
      .at(-1);
    await act(async () => {
      resumeConfirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(invoke).toHaveBeenCalledWith('resumePilot');
    expect(container.textContent).not.toMatch(/Corporate Pilot|Pilot Status|Pilot Controls/i);
  });

  test('shows webhook statistics and one compact migration notice while legacy scheduling is active', async () => {
    await render(React.createElement(App));
    await go('Organizations', 'Synchronization');

    const text = container.textContent;
    expect(invoke).toHaveBeenCalledWith('getWebhookSyncStats');
    expect(invoke).toHaveBeenCalledWith('getWebhookSyncStats');
    expect(invoke).toHaveBeenCalledWith('getWebhookSyncStats');
    expect(text).toContain('Legacy scheduled synchronization is active');
    expect(text).toContain('continues until');
    expect(text).not.toContain('Legacy Scheduled Sync Statistics');
    expect(text).not.toContain('Legacy Scheduled Sync Timeline');
    expect(text).not.toContain('Last scheduled sync attempt');
    expect(text).not.toContain('Last successful scheduled Jira write');
    expect(text).not.toContain('Run Now');
    expect(text).not.toContain('Run Scheduled Sync Now');
  });

  test('hides legacy scheduling panels and the migration notice when recurring reconciliation is enabled', async () => {
    recurringStatusFixture = {
      ...recurringStatusFixture,
      settings: {
        ...recurringStatusFixture.settings,
        recurringReconciliationEnabled: true
      }
    };
    await render(React.createElement(App));
    await go('Organizations', 'Synchronization');

    const text = container.textContent;
    expect(text).toContain('Recurring Source Reconciliation');
    expect(text).toContain('ENABLED');
    expect(text).not.toContain('Legacy scheduled synchronization is active');
    expect(text).not.toContain('Legacy Scheduled Sync Statistics');
    expect(text).not.toContain('Legacy Scheduled Sync Timeline');
  });

  test('explains disabled automatic reconciliation while webhook synchronization remains active', async () => {
    scheduledConfigFixture = {
      enabled: false,
      syncScope: 'recent',
      intervalMinutes: 60,
      lastRun: null
    };
    await render(React.createElement(App));
    await go('Organizations', 'Synchronization');

    const text = container.textContent;
    expect(text).toContain('Automatic source reconciliation is disabled');
    expect(text).toContain('Real-time webhook handling is configured separately');
    expect(text).not.toContain('Legacy scheduled synchronization is active');
    expect(text).not.toContain('Legacy Scheduled Sync Statistics');
    expect(text).not.toContain('Legacy Scheduled Sync Timeline');
  });

  test('keeps Pending Links separate under Background Maintenance and retains all synchronization surfaces', async () => {
    await render(React.createElement(App));
    await go('Recovery', 'Targeted repair');

    const text = container.textContent;
    expect(text.indexOf('Background Maintenance')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Pending Links')).toBeGreaterThan(text.indexOf('Background Maintenance'));
    expect(text).toContain('Hourly maintenance');
    expect(text).not.toContain('Auto hourly');
    expect(text).toContain('Manual Sync');
    await go('Organizations', 'Synchronization');
    expect(container.textContent).toContain('Recurring Source Reconciliation');
    await go('Recovery', 'Write controls');
    expect(container.textContent).toContain('Pause Synchronization');
    expect(container.textContent).toContain('Resume Synchronization');
    expect(invoke).toHaveBeenCalledWith('getWebhookSyncStats');
    expect(invoke).toHaveBeenCalledWith('getWebhookSyncStats');
    expect(invoke).toHaveBeenCalledWith('getPilotStatus');
    expect(invoke).toHaveBeenCalledWith('getRecurringReconciliationStatus', { orgId: ORG.id });
  });

  test('keeps attachment settings Off by default without a size control', async () => {
    await render(React.createElement(App));
    await go('Organizations', 'Sync options');

    expect(container.textContent).not.toContain('Maximum attachment size (MB)');
  });

  test('shows Jira attachment settings when the attachment limit is null', async () => {
    syncOptionsFixture = {
      ...syncOptionsFixture,
      syncAttachments: true,
      maxAttachmentSizeBytes: null
    };
    await render(React.createElement(App));
    await go('Organizations', 'Sync options');

    expect(container.textContent).toContain('Maximum attachment size (MB)');
    expect(container.textContent).toContain('Configured maximum: Jira attachment settings');
    expect(container.querySelector('input[name="maxAttachmentSizeBytes"]').value).toBe('');
  });

  test('treats a missing attachment limit field as Jira attachment settings', async () => {
    syncOptionsFixture = {
      ...syncOptionsFixture,
      syncAttachments: true
    };
    delete syncOptionsFixture.maxAttachmentSizeBytes;
    await render(React.createElement(App));
    await go('Organizations', 'Sync options');

    expect(container.querySelector('input[name="maxAttachmentSizeBytes"]').value).toBe('');
    expect(container.textContent).toContain('Configured maximum: Jira attachment settings');
  });

  test('shows a configured attachment limit in megabytes', async () => {
    syncOptionsFixture = {
      ...syncOptionsFixture,
      syncAttachments: true,
      maxAttachmentSizeBytes: 5 * 1024 * 1024
    };
    await render(React.createElement(App));
    await go('Organizations', 'Sync options');

    expect(container.querySelector('input[name="maxAttachmentSizeBytes"]').value).toBe('5');
    expect(container.textContent).toContain('Configured maximum: 5 MB');
  });

  test('hides approval and Start for a zero-work initial-sync preview while keeping Preview and Refresh', async () => {
    invoke.mockImplementation(async (name) => {
      if (name === 'getInitialSyncStatus') return { success: true, status: null };
      if (name === 'previewInitialSync') {
        return {
          success: true,
          preview: {
            previewChecksum: 'preview-checksum',
            counts: {
              eligible: 0,
              alreadyMapped: 3,
              blockedByValidation: 0,
              mappingConflicts: 0
            },
            classification: {
              eligible: { count: 0, issueKeys: [], reasons: {} },
              alreadyMapped: { count: 3, issueKeys: ['LOCAL-1'], reasons: {} },
              blockedByValidation: { count: 0, issueKeys: [], reasons: {} },
              mappingConflicts: { count: 0, issueKeys: [], reasons: {} }
            }
          }
        };
      }
      return defaultInvoke(name);
    });

    await render(React.createElement(InitialSyncPanel, {
      selectedOrg: ORG,
      showMessage: jest.fn()
    }));

    const previewButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'Preview Scope');
    expect(previewButton).toBeTruthy();

    await act(async () => {
      previewButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const text = container.textContent;
    expect(text).toContain('No eligible issues were found. No issues will be created, and there is nothing to approve or start.');
    expect(text).not.toContain('Start Approved Initial Sync');
    expect(text).not.toContain('I approve this exact previewed scope');
    expect(text).toContain('Preview Scope');
    expect(text).toContain('Refresh Status');
  });

  test('requires an explicit organization selection instead of targeting the first organization', async () => {
    window.localStorage.clear();

    await render(React.createElement(App));
    await go('Organizations');

    const text = container.textContent;
    expect(text).toContain('Select an organization to view or edit its configuration.');
    expect(text).not.toContain('Selected organization');
    expect(text).not.toContain('Synchronization Write Control');
    expect(window.localStorage.getItem(SELECTED_ORGANIZATION_STORAGE_KEY)).toBeNull();
  });

  test('does not reuse a stored organization that no longer exists', async () => {
    window.localStorage.setItem(SELECTED_ORGANIZATION_STORAGE_KEY, 'org-removed');

    await render(React.createElement(App));
    await go('Organizations');

    const text = container.textContent;
    expect(text).toContain('Select an organization to view or edit its configuration.');
    expect(text).not.toContain('Selected organization');
    expect(window.localStorage.getItem(SELECTED_ORGANIZATION_STORAGE_KEY)).toBeNull();
  });

  test('keeps the stored selection while that organization still exists', async () => {
    await render(React.createElement(App));
    await go('Organizations');

    expect(container.textContent).toContain('Selected organization');
    expect(window.localStorage.getItem(SELECTED_ORGANIZATION_STORAGE_KEY)).toBe(ORG.id);
  });

  test('saving the project filter never submits or clears the JQL filter', async () => {
    invoke.mockImplementation(async (name) => {
      if (name === 'fetchLocalProjects') {
        return {
          projects: [
            { key: 'LOCAL', name: 'Local Project' },
            { key: 'OTHER', name: 'Other Project' }
          ]
        };
      }
      return defaultInvoke(name);
    });

    await render(React.createElement(App));
    await go('Organizations', 'Scope & direction');

    const projectFilterHeader = Array.from(container.querySelectorAll('h4'))
      .find(heading => heading.textContent === 'Project Filter');
    expect(projectFilterHeader).toBeTruthy();

    await act(async () => {
      projectFilterHeader.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const saveButton = findButton('Save Project Filter');
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const call = invoke.mock.calls.find(([name]) => name === 'updateOrganization');
    expect(call).toBeTruthy();
    expect(call[1]).toMatchObject({ id: ORG.id, allowedProjects: ['LOCAL'] });
    expect(Object.prototype.hasOwnProperty.call(call[1], 'jqlFilter')).toBe(false);
  });
});
