/**
 * Recovery-tab surface for ambiguous issue creates.
 *
 * Static assertions pin the wiring and the safety copy. The rendered tests
 * exercise the lookup, the explicit-key confirmation gate and the reuse of the
 * existing reconcileIssueCreate resolver.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { invoke } from '@forge/bridge';
import IssueCreateRecovery, {
  CREATE_RECONCILIATION_REASON_TEXT,
  isExplicitCreateTargetKey
} from '../static/admin-page/src/components/IssueCreateRecovery.jsx';

jest.mock('@forge/bridge', () => ({ invoke: jest.fn() }), { virtual: true });

jest.mock('@atlaskit/tokens', () => ({ token: (_name, fallback) => fallback }), { virtual: true });

jest.mock('@atlaskit/button', () => {
  const ReactMock = require('react');
  const Button = ({ children, isDisabled, isLoading, appearance, spacing, onClick }) =>
    ReactMock.createElement(
      'button',
      { disabled: Boolean(isDisabled), onClick },
      children
    );
  return { __esModule: true, default: Button };
}, { virtual: true });

jest.mock('@atlaskit/section-message', () => {
  const ReactMock = require('react');
  return {
    __esModule: true,
    default: ({ children, title }) => ReactMock.createElement(
      'div',
      null,
      title ? ReactMock.createElement('strong', null, title) : null,
      children
    )
  };
}, { virtual: true });

jest.mock('@atlaskit/spinner', () => {
  const ReactMock = require('react');
  return { __esModule: true, default: () => ReactMock.createElement('span', null, 'spinner') };
}, { virtual: true });

jest.mock('@atlaskit/textfield', () => {
  const ReactMock = require('react');
  return {
    __esModule: true,
    default: ({ value, isDisabled, ...props }) => ReactMock.createElement('input', {
      ...props,
      value: value === undefined ? '' : value,
      disabled: Boolean(isDisabled),
      readOnly: false
    })
  };
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

jest.mock('@atlaskit/lozenge', () => {
  const ReactMock = require('react');
  return {
    __esModule: true,
    default: ({ children }) => ReactMock.createElement('span', null, children)
  };
}, { virtual: true });

jest.mock('@atlaskit/select', () => {
  const ReactMock = require('react');
  return { __esModule: true, default: () => ReactMock.createElement('div', null) };
}, { virtual: true });

jest.mock('@atlaskit/modal-dialog', () => {
  const ReactMock = require('react');
  const wrap = name => ({ children }) => ReactMock.createElement('div', { 'data-modal': name }, children);
  return {
    __esModule: true,
    default: wrap('dialog'),
    ModalTransition: ({ children }) => ReactMock.createElement('div', null, children),
    ModalHeader: wrap('header'),
    ModalTitle: wrap('title'),
    ModalBody: wrap('body'),
    ModalFooter: wrap('footer')
  };
}, { virtual: true });

const ROOT = process.cwd();
const APP_PATH = path.join(ROOT, 'static/admin-page/src/App.jsx');
const COMPONENT_PATH = path.join(ROOT, 'static/admin-page/src/components/IssueCreateRecovery.jsx');

const app = fs.readFileSync(APP_PATH, 'utf8');
const component = fs.readFileSync(COMPONENT_PATH, 'utf8');

const ORG = { id: 'org-1', name: 'Target Org' };

const baseOperation = (overrides = {}) => ({
  state: 'unknown',
  attempt: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:05:00.000Z',
  startedAt: '2026-01-01T00:00:00.000Z',
  submissionStarted: false,
  unknownAt: '2026-01-01T00:05:00.000Z',
  failedAt: null,
  failureReason: null,
  completedAt: null,
  targetKey: null,
  ...overrides
});

const unknownFixture = () => ({
  success: true,
  exists: true,
  orgId: ORG.id,
  direction: 'local-to-remote',
  sourceKey: 'LOCAL-1',
  operation: baseOperation(),
  mapping: { sourceMappedKey: null },
  reconciliation: {
    applicable: true,
    reason: 'CREATE_RECONCILIATION_REQUIRED',
    requiresExplicitTarget: true,
    recordedTargetKey: null
  }
});

const succeededMissingMappingFixture = () => ({
  success: true,
  exists: true,
  orgId: ORG.id,
  direction: 'local-to-remote',
  sourceKey: 'LOCAL-1',
  operation: baseOperation({
    state: 'succeeded',
    unknownAt: null,
    completedAt: '2026-01-01T00:06:00.000Z',
    targetKey: 'REMOTE-9'
  }),
  mapping: { sourceMappedKey: null },
  reconciliation: {
    applicable: true,
    reason: 'CREATE_SUCCEEDED_MAPPING_MISSING',
    requiresExplicitTarget: true,
    recordedTargetKey: 'REMOTE-9'
  }
});

const reconciledFixture = () => ({
  success: true,
  exists: true,
  orgId: ORG.id,
  direction: 'local-to-remote',
  sourceKey: 'LOCAL-1',
  operation: baseOperation({
    state: 'succeeded',
    unknownAt: null,
    completedAt: '2026-01-01T00:06:00.000Z',
    targetKey: 'REMOTE-9'
  }),
  mapping: { sourceMappedKey: 'REMOTE-9' },
  reconciliation: {
    applicable: false,
    reason: 'CREATE_ALREADY_RECONCILED',
    requiresExplicitTarget: true,
    recordedTargetKey: 'REMOTE-9'
  }
});

const missingLedgerFixture = () => ({
  success: true,
  exists: false,
  orgId: ORG.id,
  direction: 'local-to-remote',
  sourceKey: 'LOCAL-1',
  operation: null,
  mapping: { sourceMappedKey: null },
  reconciliation: {
    applicable: false,
    reason: 'CREATE_OPERATION_NOT_FOUND',
    requiresExplicitTarget: true,
    recordedTargetKey: null
  }
});

let container;
let root;
let showMessage;

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const render = async () => {
  await act(async () => {
    root.render(React.createElement(IssueCreateRecovery, { selectedOrg: ORG, showMessage }));
  });
  await flush();
};

const findButton = text => Array.from(container.querySelectorAll('button'))
  .find(candidate => candidate.textContent.trim() === text);

const click = async element => {
  expect(element).toBeTruthy();
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
};

const typeInto = async (element, value) => {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  ).set;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
};

const sourceInput = () => container.querySelector('input[placeholder="e.g. PROJ-123"]');
const destinationInput = () => container.querySelector('input[placeholder="e.g. REMOTE-456"]');

const lookUp = async (key = 'LOCAL-1') => {
  await typeInto(sourceInput(), key);
  await click(findButton('Look up create ledger'));
};

const reconcileCalls = () => invoke.mock.calls.filter(([name]) => name === 'reconcileIssueCreate');
const lookupCalls = () => invoke.mock.calls.filter(([name]) => name === 'getIssueCreateOperationStatus');

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  showMessage = jest.fn();
  invoke.mockReset();
  invoke.mockImplementation(async name => {
    if (name === 'getIssueCreateOperationStatus') return unknownFixture();
    if (name === 'reconcileIssueCreate') {
      return {
        success: true,
        code: 'CREATE_RECONCILED',
        message: 'Create operation reconciled without creating or deleting any issue.'
      };
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


describe('Issue create recovery wiring', () => {
  test('is rendered in the existing Recovery tab without replacing deletion recovery', () => {
    expect(app).toContain("import IssueCreateRecovery from './components/IssueCreateRecovery'");
    expect(app).toContain('<IssueCreateRecovery');

    const recoveryTabIndex = app.indexOf('<Tab>Recovery</Tab>');
    const createRecoveryIndex = app.indexOf('<IssueCreateRecovery');
    const deletionRecoveryIndex = app.indexOf('<DeletedCounterpartRecovery');

    expect(recoveryTabIndex).toBeGreaterThan(-1);
    expect(createRecoveryIndex).toBeGreaterThan(recoveryTabIndex);
    expect(deletionRecoveryIndex).toBeGreaterThan(createRecoveryIndex);
  });

  test('reuses the existing resolvers and adds no issue creation or deletion path', () => {
    expect(component).toContain("invoke('getIssueCreateOperationStatus'");
    expect(component).toContain("invoke('reconcileIssueCreate'");
    expect(component).not.toContain('fetch(');
    expect(component).not.toContain('DELETE');
    expect(component).not.toMatch(/\bsummary\s*:/);
    expect(component).not.toMatch(/\bdescription\s*:/);
  });

  test('does not present the ledger submission marker as proof about the remote create', () => {
    expect(component).toContain('Create submission marker');
    expect(component).toContain('Absence is not proof the remote create was never sent.');
    expect(component).not.toContain("submissionStarted ? 'Yes' : 'No'");
    expect(component).not.toContain('Submission marker recorded');
  });

  test('states that reconciliation only repairs the mapping', () => {
    expect(component).toContain('Reconciling repairs the mapping only');
    expect(component).toContain('never creates or deletes a Jira issue');
    expect(component).toContain('does not create, update or delete any Jira issue');
    expect(component).toContain('I verified this destination issue directly in Jira');
  });
});

describe('Issue create recovery behaviour', () => {
  test('looks up the ledger for the selected organization and direction only', async () => {
    await render();
    await lookUp();

    expect(lookupCalls()).toHaveLength(1);
    expect(lookupCalls()[0][1]).toEqual({
      orgId: 'org-1',
      direction: 'local-to-remote',
      sourceKey: 'LOCAL-1'
    });
    expect(reconcileCalls()).toHaveLength(0);
  });

  test('renders the recorded state, destination key and mapping', async () => {
    await render();
    await lookUp();

    const text = container.textContent;
    expect(text).toContain('Outcome unknown');
    expect(text).toContain('Not mapped');
    expect(text).toContain('Reconciliation is available');
    expect(text).toContain('Reconciliation applicable');
    expect(text).toContain(CREATE_RECONCILIATION_REASON_TEXT.CREATE_RECONCILIATION_REQUIRED);
    expect(text).toContain('Absent');
    expect(text).toContain('Absence is not proof the remote create was never sent.');
  });

  test('shows the submission-marker caveat only for an unknown outcome', async () => {
    invoke.mockImplementation(async name => {
      if (name === 'getIssueCreateOperationStatus') return reconciledFixture();
      return { success: true };
    });

    await render();
    await lookUp();

    expect(container.textContent).toContain('Succeeded');
    expect(container.textContent).not.toContain(
      'Absence is not proof the remote create was never sent.'
    );
  });

  test('requires an explicit valid destination key and explicit verification', async () => {
    await render();
    await lookUp();

    const reconcileButton = () => findButton('Reconcile mapping for this create');
    expect(reconcileButton().disabled).toBe(true);

    await typeInto(destinationInput(), 'REMOTE');
    expect(container.textContent).toContain('Enter a complete issue key');
    expect(reconcileButton().disabled).toBe(true);

    await typeInto(destinationInput(), 'REMOTE-9');
    expect(reconcileButton().disabled).toBe(true);

    const checkbox = container.querySelector('input[type="checkbox"]');
    await act(async () => { checkbox.click(); });
    await flush();

    expect(reconcileButton().disabled).toBe(false);
  });

  test('prefills a recorded destination key but still requires confirmation', async () => {
    invoke.mockImplementation(async name => {
      if (name === 'getIssueCreateOperationStatus') return succeededMissingMappingFixture();
      return { success: true };
    });

    await render();
    await lookUp();

    expect(destinationInput().value).toBe('REMOTE-9');
    expect(findButton('Reconcile mapping for this create').disabled).toBe(true);
    expect(container.textContent).toContain(
      CREATE_RECONCILIATION_REASON_TEXT.CREATE_SUCCEEDED_MAPPING_MISSING
    );
  });
});


describe('Issue create recovery reconciliation', () => {
  const openConfirm = async () => {
    await click(findButton('Reconcile mapping for this create'));
    expect(container.textContent).toContain('Repair the create mapping?');
    expect(container.textContent).toContain('does not create, update or delete any Jira issue');
  };

  test('invokes the existing resolver with the confirmed key and refreshes the lookup', async () => {
    let lookupCount = 0;
    invoke.mockImplementation(async name => {
      if (name === 'getIssueCreateOperationStatus') {
        lookupCount += 1;
        return lookupCount === 1 ? unknownFixture() : reconciledFixture();
      }
      if (name === 'reconcileIssueCreate') {
        return {
          success: true,
          code: 'CREATE_RECONCILED',
          message: 'Create operation reconciled without creating or deleting any issue.'
        };
      }
      return { success: true };
    });

    await render();
    await lookUp();
    await typeInto(destinationInput(), '  REMOTE-42  ');
    const checkbox = container.querySelector('input[type="checkbox"]');
    await act(async () => { checkbox.click(); });
    await flush();
    await openConfirm();
    await click(findButton('Reconcile mapping'));

    expect(reconcileCalls()).toHaveLength(1);
    expect(reconcileCalls()[0][1]).toEqual({
      orgId: 'org-1',
      direction: 'local-to-remote',
      sourceKey: 'LOCAL-1',
      jiraIssueKey: 'REMOTE-42'
    });
    expect(showMessage).toHaveBeenCalledWith(
      'Create operation reconciled without creating or deleting any issue.',
      'success'
    );
    expect(lookupCalls()).toHaveLength(2);
    expect(container.textContent).toContain('Nothing needs to be reconciled');
    expect(findButton('Reconcile mapping for this create')).toBeUndefined();
  });


  test('surfaces a mapping conflict without claiming success', async () => {
    invoke.mockImplementation(async name => {
      if (name === 'getIssueCreateOperationStatus') return unknownFixture();
      if (name === 'reconcileIssueCreate') {
        return { success: false, code: 'MAPPING_CONFLICT' };
      }
      return { success: true };
    });

    await render();
    await lookUp();
    await typeInto(destinationInput(), 'REMOTE-9');
    const checkbox = container.querySelector('input[type="checkbox"]');
    await act(async () => { checkbox.click(); });
    await flush();
    await openConfirm();
    await click(findButton('Reconcile mapping'));

    expect(container.textContent).toContain('already mapped to a different issue');
    expect(showMessage).not.toHaveBeenCalled();
    expect(lookupCalls()).toHaveLength(1);
  });

  test('surfaces an already recorded ledger target without a second lookup', async () => {
    invoke.mockImplementation(async name => {
      if (name === 'getIssueCreateOperationStatus') return unknownFixture();
      if (name === 'reconcileIssueCreate') {
        return { success: false, code: 'CREATE_TARGET_MISMATCH' };
      }
      return { success: true };
    });

    await render();
    await lookUp();
    await typeInto(destinationInput(), 'REMOTE-77');
    const checkbox = container.querySelector('input[type="checkbox"]');
    await act(async () => { checkbox.click(); });
    await flush();
    await openConfirm();
    await click(findButton('Reconcile mapping'));

    expect(container.textContent).toContain('already reconciled to a different issue key');
    expect(showMessage).not.toHaveBeenCalled();
  });

  test('does not offer reconciliation for a missing ledger entry', async () => {
    invoke.mockImplementation(async name => {
      if (name === 'getIssueCreateOperationStatus') return missingLedgerFixture();
      return { success: true };
    });

    await render();
    await lookUp();

    expect(container.textContent).toContain('No create operation recorded');
    expect(container.textContent).toContain(
      CREATE_RECONCILIATION_REASON_TEXT.CREATE_OPERATION_NOT_FOUND
    );
    expect(findButton('Reconcile mapping for this create')).toBeUndefined();
    expect(destinationInput()).toBeNull();
  });


  test.each([
    [{ applicable: false, reason: 'CREATE_IN_PROGRESS' }, 'still owns the ledger'],
    [{ applicable: false, reason: 'CREATE_RETRY_ALLOWED' }, 'Retry the synchronization'],
    [{ applicable: false, reason: 'CREATE_ALREADY_RECONCILED' }, 'Nothing needs to be reconciled']
  ])('hides reconciliation for %p', async (reconciliation, expectedCopy) => {
    invoke.mockImplementation(async name => {
      if (name === 'getIssueCreateOperationStatus') {
        const fixture = unknownFixture();
        return { ...fixture, reconciliation: { ...fixture.reconciliation, ...reconciliation } };
      }
      return { success: true };
    });

    await render();
    await lookUp();

    expect(container.textContent).toContain(expectedCopy);
    expect(container.textContent).toContain('Reconciliation is not available');
    expect(findButton('Reconcile mapping for this create')).toBeUndefined();
    expect(reconcileCalls()).toHaveLength(0);
  });

  test('reports a forbidden ledger lookup without showing ledger data', async () => {
    invoke.mockImplementation(async name => {
      if (name === 'getIssueCreateOperationStatus') {
        return { success: false, code: 'FORBIDDEN', error: 'Jira administrator permission required' };
      }
      return { success: true };
    });

    await render();
    await lookUp();

    expect(container.textContent).toContain('Jira administrator permission is required');
    expect(container.textContent).not.toContain('Reconciliation applicable');
    expect(reconcileCalls()).toHaveLength(0);
  });
});

describe('explicit destination key validation', () => {
  test.each([
    ['REMOTE-9', true],
    [' rmob-12 ', true],
    ['REMOTE', false],
    ['REMOTE-', false],
    ['-9', false],
    ['REMOTE 9', false],
    ['', false],
    [null, false]
  ])('validates %p as %p', (value, expected) => {
    expect(isExplicitCreateTargetKey(value)).toBe(expected);
  });
});

