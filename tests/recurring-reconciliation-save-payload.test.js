import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { invoke } from '@forge/bridge';
import RecurringReconciliation from '../static/admin-page/src/components/RecurringReconciliation.jsx';
import {
  RECONCILIATION_EDITABLE_SETTING_KEYS,
  toReconciliationSavePayload
} from '../static/admin-page/src/reconciliation-save-payload.js';
import { validateReconciliationSettings } from '../src/services/sync/reconciliation-settings.js';

jest.mock('@forge/bridge', () => ({ invoke: jest.fn() }), { virtual: true });

jest.mock('../src/services/storage/kvs.js', () => {
  const store = new Map();
  return {
    get: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
    set: jest.fn(async (key, value) => {
      store.set(key, value);
    }),
    del: jest.fn(async (key) => {
      store.delete(key);
    }),
    setIfNotExists: jest.fn(),
    queryByPrefix: jest.fn(async () => [])
  };
});

jest.mock('@atlaskit/tokens', () => ({ token: (_name, fallback) => fallback }), { virtual: true });

jest.mock('@atlaskit/button', () => {
  const ReactMock = require('react');
  const Button = ({ children, isDisabled, isLoading, appearance, spacing, ...props }) =>
    ReactMock.createElement('button', { ...props, disabled: Boolean(isDisabled) }, children);
  return { __esModule: true, default: Button };
}, { virtual: true });

jest.mock('@atlaskit/checkbox', () => {
  const ReactMock = require('react');
  const Checkbox = ({ label, isChecked, isDisabled, onChange }) =>
    ReactMock.createElement(
      'label',
      null,
      ReactMock.createElement('input', {
        type: 'checkbox',
        checked: Boolean(isChecked),
        disabled: Boolean(isDisabled),
        onChange
      }),
      label
    );
  return { __esModule: true, default: Checkbox };
}, { virtual: true });

jest.mock('@atlaskit/select', () => {
  const ReactMock = require('react');
  return { __esModule: true, default: () => ReactMock.createElement('div', null) };
}, { virtual: true });

jest.mock('@atlaskit/section-message', () => {
  const ReactMock = require('react');
  return { __esModule: true, default: ({ children }) => ReactMock.createElement('div', null, children) };
}, { virtual: true });

jest.mock('@atlaskit/spinner', () => {
  const ReactMock = require('react');
  return { __esModule: true, default: () => ReactMock.createElement('span', null, 'spinner') };
}, { virtual: true });

jest.mock('@atlaskit/lozenge', () => {
  const ReactMock = require('react');
  return { __esModule: true, default: ({ children }) => ReactMock.createElement('span', null, children) };
}, { virtual: true });

const ORG = { id: 'org-1', name: 'STG MOB' };

// Mirrors the real getRecurringReconciliationStatus payload: settings includes
// the server-owned `version` field alongside the four editable fields.
const statusFixture = (overrides = {}) => ({
  success: true,
  settings: {
    version: 1,
    recurringReconciliationEnabled: false,
    reconciliationIntervalMinutes: 60,
    reconciliationCommentOnReview: true,
    reconciliationFailureThreshold: 3,
    ...overrides
  },
  schedule: { nextRunAt: null, lastCompletedAt: null, isDue: false },
  activeJob: null,
  lastJob: null,
  attention: [],
  attentionSummary: { open: 0, notificationRequired: 0 }
});

let container;
let root;
let showMessage;
let onSettingsSaved;

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const render = async () => {
  await act(async () => {
    root.render(
      React.createElement(RecurringReconciliation, {
        selectedOrg: ORG,
        showMessage,
        onSettingsSaved
      })
    );
  });
  await flush();
  await flush();
};

const saveCalls = () => invoke.mock.calls.filter(([name]) => name === 'saveRecurringReconciliationSettings');

const clickSave = async () => {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent.trim() === 'Save Reconciliation Settings'
  );
  expect(button).toBeTruthy();
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
};

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  showMessage = jest.fn();
  onSettingsSaved = jest.fn();
  invoke.mockReset();
  invoke.mockImplementation(async (name, payload) => {
    if (name === 'getRecurringReconciliationStatus') return statusFixture();
    if (name === 'saveRecurringReconciliationSettings') {
      return { success: true, settings: { version: 1, ...payload.settings }, cancelledJob: null };
    }
    return { success: true };
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  delete global.IS_REACT_ACT_ENVIRONMENT;
});

describe('recurring reconciliation save payload', () => {
  test('keeps only editable fields and drops server-owned metadata', () => {
    const payload = toReconciliationSavePayload({
      version: 1,
      recurringReconciliationEnabled: true,
      reconciliationIntervalMinutes: 180,
      reconciliationCommentOnReview: false,
      reconciliationFailureThreshold: 5,
      unexpectedKey: 'ignored'
    });

    expect(Object.keys(payload).sort()).toEqual([...RECONCILIATION_EDITABLE_SETTING_KEYS].sort());
    expect(payload).not.toHaveProperty('version');
    expect(payload).not.toHaveProperty('unexpectedKey');
    expect(payload.reconciliationIntervalMinutes).toBe(180);
    expect(() => validateReconciliationSettings(payload)).not.toThrow();
  });

  test('handles missing or non-object input without throwing', () => {
    expect(toReconciliationSavePayload(undefined)).toEqual({});
    expect(toReconciliationSavePayload(null)).toEqual({});
    expect(toReconciliationSavePayload('nope')).toEqual({});
  });

  test('saves a payload the resolver accepts instead of echoing version back', async () => {
    await render();
    await clickSave();

    const calls = saveCalls();
    expect(calls).toHaveLength(1);
    const [, payload] = calls[0];
    expect(payload.orgId).toBe(ORG.id);
    expect(payload.settings).toEqual({
      recurringReconciliationEnabled: false,
      reconciliationIntervalMinutes: 60,
      reconciliationCommentOnReview: true,
      reconciliationFailureThreshold: 3
    });
    expect(payload.settings).not.toHaveProperty('version');
    // The real resolver validator must accept exactly what the panel sends.
    expect(() => validateReconciliationSettings(payload.settings)).not.toThrow();
    expect(onSettingsSaved).toHaveBeenCalled();
    expect(showMessage).toHaveBeenCalledWith(expect.stringContaining('disabled'), 'success');
  });

  test('enabling reconciliation sends an opt-in payload the resolver accepts', async () => {
    await render();

    const checkbox = container.querySelector('input[type="checkbox"]');
    expect(checkbox).toBeTruthy();
    await act(async () => {
      checkbox.click();
    });
    await flush();

    await clickSave();

    const calls = saveCalls();
    expect(calls).toHaveLength(1);
    const [, payload] = calls[0];
    expect(payload.settings.recurringReconciliationEnabled).toBe(true);
    expect(payload.settings).not.toHaveProperty('version');
    expect(() => validateReconciliationSettings(payload.settings)).not.toThrow();
    expect(showMessage).toHaveBeenCalledWith(expect.stringContaining('enabled'), 'success');
  });

  test('surfaces a resolver rejection instead of silently doing nothing', async () => {
    invoke.mockImplementation(async (name) => {
      if (name === 'getRecurringReconciliationStatus') return statusFixture();
      if (name === 'saveRecurringReconciliationSettings') {
        return {
          success: false,
          code: 'RECONCILIATION_INVALID_SETTINGS',
          error: 'version is not a supported reconciliation setting.'
        };
      }
      return { success: true };
    });

    await render();
    await clickSave();

    expect(container.textContent).toContain('version is not a supported reconciliation setting.');
    expect(onSettingsSaved).not.toHaveBeenCalled();
  });
});

