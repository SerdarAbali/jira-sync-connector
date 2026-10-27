import React from 'react';
import fs from 'fs';
import path from 'path';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { invoke } from '@forge/bridge';
import WitnessedPairAdoption, {
  ADOPTION_STALE_TEXT,
  pairAdoptionFingerprint
} from '../static/admin-page/src/components/WitnessedPairAdoption.jsx';

jest.mock('@forge/bridge', () => ({ invoke: jest.fn() }), { virtual: true });
jest.mock('@atlaskit/tokens', () => ({ token: (_name, fallback) => fallback }), { virtual: true });

jest.mock('@atlaskit/button', () => {
  const ReactMock = require('react');
  const Button = ({ children, isDisabled, onClick }) =>
    ReactMock.createElement('button', { disabled: Boolean(isDisabled), onClick }, children);
  return { __esModule: true, default: Button };
}, { virtual: true });

jest.mock('@atlaskit/textfield', () => {
  const ReactMock = require('react');
  const Textfield = ({ value, onChange, isDisabled, ...props }) =>
    ReactMock.createElement('input', {
      'aria-label': props['aria-label'],
      value,
      disabled: Boolean(isDisabled),
      onChange
    });
  return { __esModule: true, default: Textfield };
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

const ORG = { id: 'org-1', name: 'Primary organization' };
const PAIR_ID = '3f6c1a8e-9b21-4f0d-9d4e-6a1b2c3d4e5f';
const PHRASE = `ADOPT org-1 LOCAL-1 REMOT-1 ${PAIR_ID}`;
const RECOVERY_SOURCE = fs.readFileSync(
  path.join(process.cwd(), 'static/admin-page/src/dashboard/RecoveryPage.jsx'),
  'utf8'
);
const COMPONENT_SOURCE = fs.readFileSync(
  path.join(process.cwd(), 'static/admin-page/src/components/WitnessedPairAdoption.jsx'),
  'utf8'
);

const previewResult = (overrides = {}) => ({
  success: true,
  readOnly: true,
  ready: true,
  orgId: 'org-1',
  localKey: 'LOCAL-1',
  remoteKey: 'REMOT-1',
  localIssueId: '10001',
  remoteIssueId: '20881',
  pairId: PAIR_ID,
  localWitness: { class: 'matching', state: 'active', pairId: PAIR_ID },
  remoteWitness: { class: 'matching', state: 'active', pairId: PAIR_ID },
  mapping: { state: 'missing', remoteKey: null, localKey: null },
  pause: { readable: true, paused: true, reasonCode: null },
  alreadyMapped: false,
  conflicts: [],
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
  await act(async () => { await Promise.resolve(); });
}

function setInputValue(inputElement, value) {
  const prototype = window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
  setter.call(inputElement, value);
  inputElement.dispatchEvent(new window.Event('input', { bubbles: true }));
}

async function clickButton(container, label) {
  const button = [...container.querySelectorAll('button')]
    .find((node) => node.textContent === label);
  if (!button) throw new Error(`button ${label} not found`);
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  await flush();
  return button;
}

function input(container, label) {
  return container.querySelector(`input[aria-label="${label}"]`);
}

beforeEach(() => {
  jest.clearAllMocks();
  document.body.innerHTML = '';
  invoke.mockReset();
});

describe('witnessed pair adoption panel', () => {
  test('Recovery mounts the panel and the panel invokes only preview and adoption', () => {
    expect(RECOVERY_SOURCE).toContain(
      "import WitnessedPairAdoption from '../components/WitnessedPairAdoption.jsx'"
    );
    expect(RECOVERY_SOURCE).toContain('<WitnessedPairAdoption');
    const invocations = [...COMPONENT_SOURCE.matchAll(/invoke\('([^']+)'/g)]
      .map((match) => match[1]);
    expect(invocations).toEqual(['previewWitnessedPairAdoption', 'adoptWitnessedPair']);
  });

  test('requires an organization and never invokes anything on mount', async () => {
    const { container } = render(<WitnessedPairAdoption selectedOrg={null} />);
    await flush();

    expect(container.textContent).toContain('Select an organization to verify a witnessed pair.');
    expect(invoke).not.toHaveBeenCalled();
  });

  test('verifies a pair, shows its identity and phrase, then adopts only after the exact phrase', async () => {
    invoke.mockImplementation(async (action) => (
      action === 'previewWitnessedPairAdoption'
        ? previewResult()
        : {
          success: true,
          code: 'PAIR_WITNESS_PAIR_ADOPTED',
          message: 'The verified pair mapping was restored. No Jira issue was changed.'
        }
    ));

    const { container } = render(<WitnessedPairAdoption selectedOrg={ORG} />);
    await flush();
    expect(invoke).not.toHaveBeenCalled();

    act(() => { setInputValue(input(container, 'Witness adoption local issue key'), 'LOCAL-1'); });
    act(() => { setInputValue(input(container, 'Witness adoption remote issue key'), 'REMOT-1'); });
    await clickButton(container, 'Verify witnesses');

    expect(invoke).toHaveBeenCalledWith('previewWitnessedPairAdoption', {
      orgId: 'org-1',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOT-1'
    });
    expect(container.textContent).toContain(PAIR_ID);
    expect(container.textContent).toContain(PHRASE);

    let adoptButton = [...container.querySelectorAll('button')]
      .find((node) => node.textContent === 'Adopt verified mapping');
    expect(adoptButton.disabled).toBe(true);

    const phraseInput = input(container, 'Witness adoption confirmation');
    act(() => { setInputValue(phraseInput, 'ADOPT wrong'); });
    adoptButton = [...container.querySelectorAll('button')]
      .find((node) => node.textContent === 'Adopt verified mapping');
    expect(adoptButton.disabled).toBe(true);

    act(() => { setInputValue(phraseInput, PHRASE); });
    await clickButton(container, 'Adopt verified mapping');

    expect(invoke).toHaveBeenCalledWith('adoptWitnessedPair', {
      orgId: 'org-1',
      localKey: 'LOCAL-1',
      remoteKey: 'REMOT-1',
      pairId: PAIR_ID,
      confirmation: PHRASE
    });
    expect(container.textContent).toContain('Mapping restored');
  });

  test('changing an issue key invalidates the previous verification and approval', async () => {
    invoke.mockResolvedValue(previewResult());
    const { container } = render(<WitnessedPairAdoption selectedOrg={ORG} />);
    await flush();

    act(() => { setInputValue(input(container, 'Witness adoption local issue key'), 'LOCAL-1'); });
    act(() => { setInputValue(input(container, 'Witness adoption remote issue key'), 'REMOT-1'); });
    await clickButton(container, 'Verify witnesses');
    expect(container.textContent).toContain(PHRASE);

    act(() => { setInputValue(input(container, 'Witness adoption remote issue key'), 'REMOT-2'); });
    await flush();

    expect(container.textContent).not.toContain(PHRASE);
    expect([...container.querySelectorAll('button')]
      .some((node) => node.textContent === 'Adopt verified mapping')).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test('changing the organization invalidates the preview', async () => {
    invoke.mockResolvedValue(previewResult());
    const { container, root } = render(<WitnessedPairAdoption selectedOrg={ORG} />);
    await flush();

    act(() => { setInputValue(input(container, 'Witness adoption local issue key'), 'LOCAL-1'); });
    act(() => { setInputValue(input(container, 'Witness adoption remote issue key'), 'REMOT-1'); });
    await clickButton(container, 'Verify witnesses');
    expect(container.textContent).toContain(PHRASE);

    await act(async () => {
      root.render(<WitnessedPairAdoption selectedOrg={{ id: 'org-2', name: 'Other' }} />);
    });
    await flush();

    expect(container.textContent).not.toContain(PHRASE);
    expect([...container.querySelectorAll('button')]
      .some((node) => node.textContent === 'Adopt verified mapping')).toBe(false);
  });

  test('a refusal is shown and never offers adoption', async () => {
    invoke.mockResolvedValue({
      success: false,
      code: 'PAIR_WITNESS_WITNESS_ABSENT',
      message: 'Both issues must carry a pairing witness. An absent witness is not proof of a pair.'
    });

    const { container } = render(<WitnessedPairAdoption selectedOrg={ORG} />);
    await flush();
    act(() => { setInputValue(input(container, 'Witness adoption local issue key'), 'LOCAL-1'); });
    act(() => { setInputValue(input(container, 'Witness adoption remote issue key'), 'REMOT-1'); });
    await clickButton(container, 'Verify witnesses');

    expect(container.textContent).toContain('Pair not adoptable');
    expect(container.textContent).toContain('PAIR_WITNESS_WITNESS_ABSENT');
    expect([...container.querySelectorAll('button')]
      .some((node) => node.textContent === 'Adopt verified mapping')).toBe(false);
  });

  test('shows the required phrase while a pause prerequisite is unresolved, but disables adoption', async () => {
    invoke.mockResolvedValue(previewResult({
      ready: false,
      pause: { readable: true, paused: false, reasonCode: null },
      conflicts: ['PAIR_WITNESS_PAUSE_REQUIRED']
    }));

    const { container } = render(<WitnessedPairAdoption selectedOrg={ORG} />);
    await flush();
    act(() => { setInputValue(input(container, 'Witness adoption local issue key'), 'LOCAL-1'); });
    act(() => { setInputValue(input(container, 'Witness adoption remote issue key'), 'REMOT-1'); });
    await clickButton(container, 'Verify witnesses');

    expect(container.textContent).toContain(PHRASE);
    expect(container.textContent).toContain('PAIR_WITNESS_PAUSE_REQUIRED');
    const adoptButton = [...container.querySelectorAll('button')]
      .find((node) => node.textContent === 'Adopt verified mapping');
    expect(adoptButton.disabled).toBe(true);
  });

  test('the stale warning and fingerprint are bound to org and both keys', () => {
    expect(ADOPTION_STALE_TEXT).toContain('Verify the pair again');
    expect(pairAdoptionFingerprint({ orgId: 'org-1', localKey: 'A-1', remoteKey: 'B-1' }))
      .toBe('org-1|A-1|B-1');
    expect(pairAdoptionFingerprint({ orgId: 'org-1', localKey: 'A-1', remoteKey: 'B-2' }))
      .not.toBe(pairAdoptionFingerprint({ orgId: 'org-1', localKey: 'A-1', remoteKey: 'B-1' }));
  });
});

