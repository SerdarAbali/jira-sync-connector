/**
 * UI wiring for the controlled recovery restore panel.
 *
 * The panel is separate from the read-only snapshot preview so the preview
 * component still cannot invoke a mutating resolver.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { invoke } from '@forge/bridge';
import RecoveryRestore, {
  RESTORE_SCOPE_TEXT
} from '../static/admin-page/src/components/RecoveryRestore.jsx';

jest.mock('@forge/bridge', () => ({ invoke: jest.fn() }), { virtual: true });

jest.mock('@atlaskit/tokens', () => ({ token: (_name, fallback) => fallback }), { virtual: true });

jest.mock('@atlaskit/button', () => {
  const ReactMock = require('react');
  const Button = ({ children, isDisabled, onClick }) =>
    ReactMock.createElement('button', { disabled: Boolean(isDisabled), onClick }, children);
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

const ROOT = process.cwd();
const COMPONENT_PATH = path.join(ROOT, 'static/admin-page/src/components/RecoveryRestore.jsx');
const componentSource = fs.readFileSync(COMPONENT_PATH, 'utf8');

const PREVIEW = {
  success: true,
  counts: { restorablePairs: 2 }
};

const PLAN = {
  success: true,
  status: 'pending',
  digest: `sha256:${'a'.repeat(64)}`,
  approvalPhrase: `RESTORE org-1 sha256:${'a'.repeat(64)}`,
  counts: {
    selectedPairs: 2,
    witnessConfirmed: 1,
    witnessAbsent: 1,
    ledgerRows: 1,
    excludedPairs: 0
  },
  excluded: []
};

function render(ui) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(ui); });
  return { container, root };
}

describe('recovery restore UI', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    delete global.IS_REACT_ACT_ENVIRONMENT;
    document.body.innerHTML = '';
  });

  test('wires planning, approval and batches without a Jira/resume action', () => {
    expect(componentSource).toContain("invoke('planRecoveryRestore'");
    expect(componentSource).toContain("invoke('approveRecoveryRestore'");
    expect(componentSource).toContain("invoke('applyRecoveryRestore'");
    expect(componentSource).toContain("invoke('cancelRecoveryRestore'");
    expect(componentSource).not.toContain("invoke('resume");
    expect(componentSource).not.toContain("invoke('restoreSyncAuthorization");
    expect(RESTORE_SCOPE_TEXT).toContain('No Jira issue is created');
  });

  test('keeps planning disabled while writes are not paused', () => {
    const { container } = render(
      <RecoveryRestore
        orgId="org-1"
        paused={false}
        previewContent="snapshot"
        preview={PREVIEW}
      />
    );
    expect(container.textContent).toContain('Controlled restore');
    expect(container.querySelector('button').disabled).toBe(true);
  });

  test('creates a plan and enables approval only for the exact phrase', async () => {
    invoke.mockResolvedValue(PLAN);
    const { container } = render(
      <RecoveryRestore
        orgId="org-1"
        paused
        previewContent="snapshot"
        preview={PREVIEW}
      />
    );

    const planButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Create bounded restore plan');
    expect(planButton.disabled).toBe(false);

    await act(async () => { planButton.click(); });
    expect(invoke).toHaveBeenCalledWith('planRecoveryRestore', {
      orgId: 'org-1',
      content: 'snapshot'
    });
    expect(container.textContent).toContain(PLAN.digest);
    expect(container.textContent).toContain(PLAN.approvalPhrase);

    const approveButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Approve restore plan');
    expect(approveButton.disabled).toBe(true);

    const input = container.querySelector('#restore-confirmation');
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    ).set;
    await act(async () => {
      setter.call(input, PLAN.approvalPhrase);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const enabledApprove = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Approve restore plan');
    expect(enabledApprove.disabled).toBe(false);
  });
});
