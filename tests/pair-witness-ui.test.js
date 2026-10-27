/**
 * Pairing-witness preview surface.
 *
 * The assertions pin three things: the Recovery tab mounts the panel, the panel
 * exposes exactly one resolver and that resolver is the read-only preview, and
 * no rendered state offers an apply, approve or migrate control.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { invoke } from '@forge/bridge';
import PairWitnessMigration, {
  PAIR_WITNESS_NO_APPLY_TEXT,
  PAIR_WITNESS_PAUSE_TEXT,
  PAIR_WITNESS_READ_ONLY_TEXT,
  PAIR_WITNESS_SCOPE_TEXT,
  WITNESS_ORGANIZATION_WARNING,
  WITNESS_SELECTION_REQUIRED_TEXT,
  WITNESS_SELECTION_TEXT,
  WitnessMigrationControls,
  pairClassText,
  pairWitnessFindingText,
  parsePairSelection
} from '../static/admin-page/src/components/PairWitnessMigration.jsx';

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

const ROOT = process.cwd();
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const APP_SOURCE = read('static/admin-page/src/dashboard/RecoveryPage.jsx');
const COMPONENT_SOURCE = read('static/admin-page/src/components/PairWitnessMigration.jsx');

const ORG = { id: 'org-1', name: 'Primary organization' };

const previewResult = (overrides = {}) => ({
  success: true,
  readOnly: true,
  orgId: 'org-1',
  organization: { id: 'org-1', name: 'Primary organization', remoteSite: 'remote.atlassian.net' },
  generatedAt: '2026-10-26T10:00:00.000Z',
  limits: { maxPairs: 25, pairsListed: 2, pagesScanned: 1, truncated: false, findingLimit: 50 },
  counts: {
    pairsScanned: 2,
    readyToWitness: 1,
    partiallyWitnessed: 0,
    alreadyWitnessed: 1,
    witnessConflict: 0,
    witnessEnded: 0,
    witnessPendingCreate: 0,
    witnessInaccessible: 0,
    witnessUnverifiable: 0,
    counterpartMissing: 0,
    counterpartInaccessible: 0,
    unverified: 0,
    mappingMismatch: 0,
    duplicateDestination: 0,
    createInDoubt: 0,
    pairEnded: 0,
    repairRequired: 0,
    invalidRecords: 0
  },
  witnesses: {},
  duplicates: [],
  cost: {
    jiraIssueReads: 4,
    jiraPropertyReads: 4,
    jiraReads: 8,
    witnessWritesPerformed: 0,
    witnessWritesProjected: 2,
    jiraIssuesCreated: 0
  },
  pairs: [],
  findings: [],
  omittedFindings: 0,
  limitations: ['This preview only reads.'],
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

beforeEach(() => {
  jest.clearAllMocks();
  document.body.innerHTML = '';
});

describe('pairing-witness UI wiring', () => {
  test('App mounts the panel in the Recovery tab', () => {
    expect(APP_SOURCE).toContain("import PairWitnessMigration from '../components/PairWitnessMigration.jsx'");
    expect(APP_SOURCE).toContain('<PairWitnessMigration');
    expect(APP_SOURCE).toContain('selectedOrg={selectedOrg}');
  });

  test('the panel calls only witness-preview and witness-migration resolvers', () => {
    const invocations = [...new Set([...COMPONENT_SOURCE.matchAll(/'(preview|plan|approve|apply|cancel|get)PairWitness[A-Za-z]+'/g)]
      .map((match) => match[0].replace(/'/g, '')))];
    expect(invocations.sort()).toEqual([
      'applyPairWitnessMigration',
      'approvePairWitnessMigration',
      'cancelPairWitnessMigration',
      'getPairWitnessMigrationStatus',
      'planPairWitnessMigration',
      'previewPairWitnessMigration'
    ]);
    // Nothing here can resume synchronization, create an issue or restore.
    expect(COMPONENT_SOURCE).not.toMatch(/'(resumePilot|resume|forceSyncIssue|importIssues|restore)[A-Za-z]*'/);
  });

  test('the read-only promise is stated in the surface text', () => {
    expect(PAIR_WITNESS_READ_ONLY_TEXT).toContain('writes no issue property');
    expect(PAIR_WITNESS_READ_ONLY_TEXT).toContain('creates no issue');
    expect(PAIR_WITNESS_NO_APPLY_TEXT).toContain('No migration action is available');
    expect(PAIR_WITNESS_PAUSE_TEXT).toContain('never changes the pause state');
    expect(PAIR_WITNESS_SCOPE_TEXT).toContain('Jira issue property');
    // The preview card keeps exactly one control: it cannot write anything.
    const previewCard = COMPONENT_SOURCE.slice(0, COMPONENT_SOURCE.indexOf('WitnessMigrationControls'));
    const previewButtons = [...previewCard.matchAll(/<Button[\s\S]*?<\/Button>/g)]
      .map((match) => match[0]);
    expect(previewButtons).toHaveLength(1);
    expect(previewButtons[0]).toContain('Run read-only preview');
  });

  test('renders the read-only notice and disables the preview until an organization is selected', async () => {
    const { container } = render(<PairWitnessMigration selectedOrg={null} />);
    await flush();

    expect(container.textContent).toContain('Pairing witness preview');
    expect(container.textContent).toContain('Read-only');
    expect(container.textContent).toContain('This preview cannot change anything');
    expect(container.textContent).toContain('Select an organization to preview.');

    const button = [...container.querySelectorAll('button')]
      .find((node) => node.textContent === 'Run read-only preview');
    expect(button).toBeTruthy();
    expect(button.disabled).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  test('runs the preview for the selected organization and reports the counts', async () => {
    invoke.mockResolvedValue(previewResult());

    const { container } = render(<PairWitnessMigration selectedOrg={ORG} />);
    await flush();

    const button = [...container.querySelectorAll('button')]
      .find((node) => node.textContent === 'Run read-only preview');
    expect(button.disabled).toBe(false);

    await act(async () => {
      button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(invoke).toHaveBeenCalledWith('previewPairWitnessMigration', { orgId: 'org-1' });
    expect(container.textContent).toContain('Pairs scanned');
    expect(container.textContent).toContain('Ready to witness');
    expect(container.textContent).toContain('Property writes performed');
    expect(container.textContent).toContain('Issues created');
  });

  test('shows a resolver refusal without offering a retry that could write', async () => {
    invoke.mockResolvedValue({
      success: false,
      readOnly: true,
      code: 'PAIR_WITNESS_REQUIRES_PAUSE',
      error: 'Pause synchronization before previewing pairing witnesses.'
    });

    const showMessage = jest.fn();
    const { container } = render(<PairWitnessMigration selectedOrg={ORG} showMessage={showMessage} />);
    await flush();
    const button = [...container.querySelectorAll('button')]
      .find((node) => node.textContent === 'Run read-only preview');

    await act(async () => {
      button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.textContent)
      .toContain('Pause synchronization before previewing pairing witnesses.');
    expect(container.textContent).not.toContain('Pairs scanned');
    expect(showMessage).toHaveBeenCalledWith('Pause synchronization before previewing pairing witnesses.', 'error');
  });
});


describe('pairing-witness findings rendering', () => {
  async function renderWithResult(result) {
    invoke.mockResolvedValue(result);
    const { container } = render(<PairWitnessMigration selectedOrg={ORG} />);
    await flush();
    const button = [...container.querySelectorAll('button')]
      .find((node) => node.textContent === 'Run read-only preview');
    await act(async () => {
      button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await flush();
    return container;
  }

  test('warns when the preview was truncated', async () => {
    const container = await renderWithResult(previewResult({
      limits: { maxPairs: 1, pairsListed: 1, pagesScanned: 1, truncated: true, findingLimit: 50 }
    }));

    expect(container.textContent).toContain('Preview truncated');
  });

  test('renders findings and duplicate destinations in operator language', async () => {
    const container = await renderWithResult(previewResult({
      counts: { ...previewResult().counts, readyToWitness: 0, witnessConflict: 1, duplicateDestination: 1 },
      duplicates: [{ remoteKey: 'REMOT-1', localKeys: ['LOCAL-1', 'LOCAL-2'] }],
      findings: [{
        code: 'witness-conflict',
        localKey: 'LOCAL-1',
        remoteKey: 'REMOT-1',
        detail: 'local:malformed'
      }]
    }));

    expect(container.textContent).toContain('Two local issues claim the same remote issue');
    expect(container.textContent).toContain('REMOT-1 ← LOCAL-1, LOCAL-2');
    expect(container.textContent)
      .toContain('Witness contradicts storage or this installation: LOCAL-1 ↔ REMOT-1 (local:malformed)');
  });

  test('states that a clean preview found nothing outstanding', async () => {
    const container = await renderWithResult(previewResult());

    expect(container.textContent)
      .toContain('Every inspected pair is either already witnessed on both issues or has a pairing witness on neither issue yet.');
  });

  test('operator-facing class text is readable', () => {
    expect(pairClassText('ready-to-witness')).toContain('No witness');
    expect(pairClassText('witness-inaccessible')).toContain('not readable');
    expect(pairClassText('something-new')).toBe('something-new');
    expect(pairWitnessFindingText({ code: 'pair-ended', localKey: 'A-1', remoteKey: 'B-2' }))
      .toContain('A-1 ↔ B-2');
    expect(pairWitnessFindingText(null)).toBe('Unknown finding');
  });
});


describe('pair selection control', () => {
  function setInputValue(input, value) {
    const prototype = input.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  }

  async function clickButton(container, label) {
    const button = [...container.querySelectorAll('button')]
      .find((node) => node.textContent === label);
    expect(button).toBeTruthy();
    await act(async () => {
      button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await flush();
    return button;
  }

  test('the parser treats blank as "not supplied" and reads exact pairs', () => {
    expect(parsePairSelection('')).toEqual({ pairs: undefined, error: null, blank: true });
    expect(parsePairSelection('   ')).toEqual({ pairs: undefined, error: null, blank: true });

    expect(parsePairSelection('MOB-8 VMOB-13')).toEqual({
      pairs: [{ localKey: 'MOB-8', remoteKey: 'VMOB-13' }],
      error: null,
      blank: false
    });
    expect(parsePairSelection('MOB-8,VMOB-13').pairs)
      .toEqual([{ localKey: 'MOB-8', remoteKey: 'VMOB-13' }]);
    expect(parsePairSelection('MOB-8 -> VMOB-13').pairs)
      .toEqual([{ localKey: 'MOB-8', remoteKey: 'VMOB-13' }]);
    expect(parsePairSelection('MOB-8 VMOB-13\nMOB-9 VMOB-14').pairs).toHaveLength(2);
  });

  test('a malformed selection line is reported instead of guessed', () => {
    const parsed = parsePairSelection('MOB-8');
    expect(parsed.pairs).toBeNull();
    expect(parsed.error).toContain('MOB-8');
    expect(parsePairSelection('A-1 B-2 C-3').error).toBeTruthy();
  });

  test('selected-pairs mode explains that a blank entry cannot build a plan', () => {
    expect(WITNESS_SELECTION_TEXT).toContain('cannot build a plan');
    expect(WITNESS_SELECTION_REQUIRED_TEXT).toContain('Build plan stays disabled');
    expect(WITNESS_ORGANIZATION_WARNING).toContain('Every eligible pair');
  });

  test('the default scope is Selected pairs and a blank entry keeps Build plan disabled', async () => {
    invoke.mockImplementation(async (action) => (
      action === 'getPairWitnessMigrationStatus'
        ? { success: true, plan: null, permit: null }
        : { success: true, plan: null }
    ));

    const { container } = render(<WitnessMigrationControls orgId="org-1" />);
    await flush();

    const buildButton = [...container.querySelectorAll('button')]
      .find((node) => node.textContent === 'Build plan');
    expect(buildButton.disabled).toBe(true);
    expect(container.textContent).toContain(WITNESS_SELECTION_REQUIRED_TEXT);
    expect(container.textContent).not.toContain(WITNESS_ORGANIZATION_WARNING);

    invoke.mockClear();
    await clickButton(container, 'Build plan');
    expect(invoke).not.toHaveBeenCalledWith('planPairWitnessMigration', expect.anything());
  });

  test('a valid pair enables Build plan and is sent as the selection', async () => {
    invoke.mockImplementation(async (action) => {
      if (action === 'getPairWitnessMigrationStatus') {
        return { success: true, plan: null, permit: null };
      }
      if (action === 'planPairWitnessMigration') {
        return {
          success: true,
          plan: {
            selectionMode: 'explicit',
            selection: [{ localKey: 'MOB-8', remoteKey: 'VMOB-13' }],
            digest: 'sha256:abc123',
            approvalPhrase: 'APPROVE WITNESS org-1 abcdefabcdef 1',
            counts: { pairs: 1, writablePairs: 1, verifyOnlyPairs: 0, writesRequired: 2, excludedPairs: 0 },
            items: [{
              seq: 1,
              localKey: 'MOB-8',
              localIssueId: '10039',
              remoteKey: 'VMOB-13',
              remoteIssueId: '20881',
              pairId: '3e8e7c47-6530-566a-ba14-076a8762fb1c',
              action: 'both'
            }],
            excluded: []
          }
        };
      }
      return { success: true };
    });

    const { container } = render(<WitnessMigrationControls orgId="org-1" />);
    await flush();

    const input = container.querySelector('[aria-label="Witness migration pair selection"]');
    act(() => { setInputValue(input, 'MOB-8 VMOB-13'); });

    const buildButton = [...container.querySelectorAll('button')]
      .find((node) => node.textContent === 'Build plan');
    expect(buildButton.disabled).toBe(false);

    await clickButton(container, 'Build plan');

    expect(invoke).toHaveBeenCalledWith('planPairWitnessMigration', {
      orgId: 'org-1',
      pairs: [{ localKey: 'MOB-8', remoteKey: 'VMOB-13' }]
    });
    expect(container.textContent).toContain('APPROVE WITNESS org-1 abcdefabcdef 1');
    expect(container.textContent).toContain('sha256:abc123');
    expect(container.textContent).toContain('MOB-8 / 10039');
    expect(container.textContent).toContain('VMOB-13 / 20881');
    expect(container.textContent).toContain('3e8e7c47-6530-566a-ba14-076a8762fb1c');
  });

  test('entire-organization scope must be chosen and warns before it is used', async () => {
    invoke.mockImplementation(async (action) => (
      action === 'getPairWitnessMigrationStatus'
        ? { success: true, plan: null, permit: null }
        : {
          success: true,
          plan: {
            selectionMode: 'organization',
            selection: null,
            digest: 'sha256:full',
            approvalPhrase: 'APPROVE WITNESS org-1 fullfullfull 20',
            counts: { pairs: 20, writablePairs: 20, writesRequired: 40, excludedPairs: 0 },
            items: [],
            excluded: []
          }
        }
    ));

    const { container } = render(<WitnessMigrationControls orgId="org-1" />);
    await flush();
    invoke.mockClear();

    await clickButton(container, 'Entire organization');

    expect(container.textContent).toContain(WITNESS_ORGANIZATION_WARNING);
    await clickButton(container, 'Build plan');

    // No selection is sent: the backend's whole-organization path is used.
    expect(invoke).toHaveBeenCalledWith('planPairWitnessMigration', { orgId: 'org-1' });
    expect(container.textContent).toContain('Entire organization');
    expect(container.textContent).toContain('APPROVE WITNESS org-1 fullfullfull 20');
  });

  test('three pairs can be entered on separate lines and are sent as three', async () => {
    invoke.mockImplementation(async (action) => (
      action === 'getPairWitnessMigrationStatus'
        ? { success: true, plan: null, permit: null }
        : {
          success: true,
          plan: {
            selectionMode: 'explicit',
            selection: [
              { localKey: 'MOB-10', remoteKey: 'VMOB-15' },
              { localKey: 'MOB-11', remoteKey: 'VMOB-16' },
              { localKey: 'MOB-12', remoteKey: 'VMOB-17' }
            ],
            digest: 'sha256:three',
            approvalPhrase: 'APPROVE WITNESS org-1 threeeeeeeee 3',
            counts: { pairs: 3, writablePairs: 3, writesRequired: 6, excludedPairs: 0 },
            items: [],
            excluded: []
          }
        }
    ));

    const { container } = render(<WitnessMigrationControls orgId="org-1" />);
    await flush();

    const selection = container.querySelector('[aria-label="Witness migration pair selection"]');
    expect(selection).toBeTruthy();
    expect(selection.tagName).toBe('TEXTAREA');

    act(() => {
      setInputValue(selection, 'MOB-10 VMOB-15\nMOB-11 VMOB-16\nMOB-12 VMOB-17');
    });
    await clickButton(container, 'Build plan');

    expect(invoke).toHaveBeenCalledWith('planPairWitnessMigration', {
      orgId: 'org-1',
      pairs: [
        { localKey: 'MOB-10', remoteKey: 'VMOB-15' },
        { localKey: 'MOB-11', remoteKey: 'VMOB-16' },
        { localKey: 'MOB-12', remoteKey: 'VMOB-17' }
      ]
    });
    expect(container.textContent).toContain('APPROVE WITNESS org-1 threeeeeeeee 3');
  });


  test('switching back to Selected pairs re-requires a selection', async () => {
    invoke.mockImplementation(async (action) => (
      action === 'getPairWitnessMigrationStatus'
        ? { success: true, plan: null, permit: null }
        : { success: true, plan: null }
    ));

    const { container } = render(<WitnessMigrationControls orgId="org-1" />);
    await flush();

    await clickButton(container, 'Entire organization');
    let buildButton = [...container.querySelectorAll('button')]
      .find((node) => node.textContent === 'Build plan');
    expect(buildButton.disabled).toBe(false);

    await clickButton(container, 'Selected pairs');
    buildButton = [...container.querySelectorAll('button')]
      .find((node) => node.textContent === 'Build plan');
    expect(buildButton.disabled).toBe(true);
    expect(container.textContent).not.toContain(WITNESS_ORGANIZATION_WARNING);
  });

  test('a malformed selection never reaches the server', async () => {
    invoke.mockImplementation(async (action) => (
      action === 'getPairWitnessMigrationStatus'
        ? { success: true, plan: null, permit: null }
        : { success: true, plan: null }
    ));

    const { container } = render(<WitnessMigrationControls orgId="org-1" />);
    await flush();
    invoke.mockClear();

    const input = container.querySelector('[aria-label="Witness migration pair selection"]');
    act(() => { setInputValue(input, 'MOB-8'); });
    await clickButton(container, 'Build plan');

    expect(invoke).not.toHaveBeenCalledWith('planPairWitnessMigration', expect.anything());
    expect(container.textContent).toContain('Could not read "MOB-8"');
  });

  test('approval sends the same selection the administrator planned with', async () => {
    invoke.mockImplementation(async (action) => {
      if (action === 'getPairWitnessMigrationStatus') {
        return { success: true, plan: null, permit: null };
      }
      if (action === 'planPairWitnessMigration') {
        return {
          success: true,
          plan: {
            selectionMode: 'explicit',
            digest: 'sha256:abc',
            approvalPhrase: 'APPROVE WITNESS org-1 abcdefabcdef 1',
            counts: { pairs: 1, writablePairs: 1, writesRequired: 2, excludedPairs: 0 }
          }
        };
      }
      return { success: true, status: 'approved' };
    });

    const { container } = render(<WitnessMigrationControls orgId="org-1" />);
    await flush();

    const selection = container.querySelector('[aria-label="Witness migration pair selection"]');
    act(() => { setInputValue(selection, 'MOB-8 VMOB-13'); });
    await clickButton(container, 'Build plan');

    const phrase = container.querySelector('input[aria-label="Witness migration confirmation"]');
    act(() => { setInputValue(phrase, 'APPROVE WITNESS org-1 abcdefabcdef 1'); });
    await clickButton(container, 'Approve witness plan');

    expect(invoke).toHaveBeenCalledWith('approvePairWitnessMigration', {
      orgId: 'org-1',
      confirmation: 'APPROVE WITNESS org-1 abcdefabcdef 1',
      pairs: [{ localKey: 'MOB-8', remoteKey: 'VMOB-13' }]
    });
  });
});

