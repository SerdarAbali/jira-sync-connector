/**
 * Synchronization authorization surface.
 *
 * Static assertions pin the wiring and the "one storage record, no Jira write"
 * promise. Rendered tests verify the blocked/authorized states, the uncovered
 * organization warning and the exact confirmation phrase.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { invoke } from '@forge/bridge';
import SyncAuthorization, {
  SYNC_AUTHORIZATION_PAUSE_TEXT,
  SYNC_AUTHORIZATION_SCOPE_TEXT,
  authorizationReasonText
} from '../static/admin-page/src/components/SyncAuthorization.jsx';

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
      'div', null, title ? ReactMock.createElement('strong', null, title) : null, children
    )
  };
}, { virtual: true });

jest.mock('@atlaskit/spinner', () => {
  const ReactMock = require('react');
  return { __esModule: true, default: () => ReactMock.createElement('span', null, 'spinner') };
}, { virtual: true });

jest.mock('@atlaskit/lozenge', () => {
  const ReactMock = require('react');
  return {
    __esModule: true,
    default: ({ children }) => ReactMock.createElement('span', null, children)
  };
}, { virtual: true });

jest.mock('@atlaskit/textfield', () => {
  const ReactMock = require('react');
  const Textfield = ({ value, onChange, isDisabled, 'aria-label': ariaLabel }) =>
    ReactMock.createElement('input', {
      'aria-label': ariaLabel,
      value: value ?? '',
      disabled: Boolean(isDisabled),
      onChange
    });
  return { __esModule: true, default: Textfield };
}, { virtual: true });

const ROOT = process.cwd();
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'static/admin-page/src/dashboard/RecoveryPage.jsx'), 'utf8');
const COMPONENT_SOURCE = fs.readFileSync(
  path.join(ROOT, 'static/admin-page/src/components/SyncAuthorization.jsx'),
  'utf8'
);

const PHRASE = 'AUTHORIZE 974910c5-2861-4d40-a7eb-37802842d0a0 org-1792917897410,org-1792934416107';

const blockedStatus = (overrides = {}) => ({
  success: true,
  authorized: false,
  state: 'missing',
  reason: 'SYNC_AUTHORIZATION_MISSING',
  message: 'Synchronization authorization is missing.',
  installationId: '974910c5-2861-4d40-a7eb-37802842d0a0',
  environmentId: '2e8c0cb5-881a-4345-b9ba-e887f790d316',
  authorizedAt: null,
  authorizedBy: null,
  basis: null,
  authorizedOrganizationIds: [],
  configuredOrganizationIds: ['org-1792917897410', 'org-1792934416107'],
  uncoveredOrganizationIds: [],
  confirmationPhrase: PHRASE,
  ...overrides
});

function render(ui) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(ui); });
  return { container, root };
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
}

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

beforeEach(() => {
  jest.clearAllMocks();
  document.body.innerHTML = '';
});

describe('synchronization authorization UI wiring', () => {
  test('App mounts the authorization panel in the Recovery tab', () => {
    expect(APP_SOURCE).toContain("import SyncAuthorization from '../components/SyncAuthorization.jsx'");
    expect(APP_SOURCE).toMatch(/<SyncAuthorization showMessage=\{c.showMessage\} \/>/);
  });

  test('the panel only exposes the status read and the explicit authorization write', () => {
    expect(COMPONENT_SOURCE).toContain("invoke('getSyncAuthorizationStatus'");
    expect(COMPONENT_SOURCE).toContain("invoke('authorizeSynchronization'");
    expect(COMPONENT_SOURCE).not.toMatch(/invoke\('(resume|restore|apply|pause)/);
    expect(SYNC_AUTHORIZATION_SCOPE_TEXT).toContain('writes one connector storage record');
    expect(SYNC_AUTHORIZATION_PAUSE_TEXT).toContain('does not resume synchronization');
  });

  test('renders the blocked state with the exact confirmation phrase', async () => {
    invoke.mockResolvedValue(blockedStatus());

    const { container } = render(<SyncAuthorization />);
    await flush();

    expect(container.textContent).toContain('Writes blocked');
    expect(container.textContent).toContain(PHRASE);
    expect(container.textContent).toContain('No authorization record exists');
    const button = [...container.querySelectorAll('button')]
      .find((node) => node.textContent === 'Authorize synchronization');
    expect(button).toBeTruthy();
    expect(button.disabled).toBe(true);
  });

  test('enables authorization only for the exact phrase and sends it unchanged', async () => {
    invoke.mockResolvedValueOnce(blockedStatus());
    invoke.mockResolvedValueOnce({ success: true, state: 'authorized' });
    invoke.mockResolvedValueOnce(blockedStatus({
      authorized: true,
      state: 'authorized',
      reason: null,
      authorizedAt: '2026-10-26T00:00:00.000Z',
      authorizedBy: 'admin-account',
      basis: 'established',
      authorizedOrganizationIds: ['org-1792917897410', 'org-1792934416107']
    }));

    const { container } = render(<SyncAuthorization />);
    await flush();

    const input = container.querySelector('input[aria-label="Authorization confirmation"]');
    const button = [...container.querySelectorAll('button')]
      .find((node) => node.textContent === 'Authorize synchronization');

    act(() => { setInputValue(input, 'AUTHORIZE wrong'); });
    expect(button.disabled).toBe(true);

    act(() => { setInputValue(input, PHRASE); });
    expect(button.disabled).toBe(false);

    await act(async () => {
      button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(invoke).toHaveBeenCalledWith('authorizeSynchronization', { confirmation: PHRASE });
    expect(container.textContent).toContain('Writes authorized');
    expect(container.textContent).toContain('still subject to the emergency pause');
  });

  test('warns when a configured organization is not covered', async () => {
    invoke.mockResolvedValue(blockedStatus({
      state: 'authorized',
      reason: 'SYNC_AUTHORIZATION_ORGANIZATIONS_UNVERIFIED',
      authorizedOrganizationIds: ['org-1792917897410'],
      uncoveredOrganizationIds: ['org-1792934416107']
    }));

    const { container } = render(<SyncAuthorization />);
    await flush();

    expect(container.textContent).toContain('Not every organization is covered');
    expect(container.textContent).toContain('org-1792934416107');
  });

  test('reports a restore in progress as blocked', async () => {
    invoke.mockResolvedValue(blockedStatus({
      state: 'restore-in-progress',
      reason: 'SYNC_RESTORE_IN_PROGRESS'
    }));

    const { container } = render(<SyncAuthorization />);
    await flush();

    expect(container.textContent).toContain('Writes blocked');
    expect(container.textContent).toContain('A restore is in progress');
  });

  test('shows the authorized state without an authorization control', async () => {
    invoke.mockResolvedValue(blockedStatus({
      authorized: true,
      state: 'authorized',
      reason: null,
      authorizedAt: '2026-10-26T00:00:00.000Z',
      authorizedBy: 'admin-account',
      basis: 'established',
      authorizedOrganizationIds: ['org-1792917897410', 'org-1792934416107']
    }));

    const { container } = render(<SyncAuthorization />);
    await flush();

    expect(container.textContent).toContain('Writes authorized');
    expect(container.textContent).not.toContain('Authorize synchronization');
  });

  test('operator-facing reason text is readable', () => {
    expect(authorizationReasonText('SYNC_AUTHORIZATION_MISSING'))
      .toContain('No authorization record');
    expect(authorizationReasonText('SNAPSHOT_UNKNOWN')).toBe('SNAPSHOT_UNKNOWN');
  });
});
