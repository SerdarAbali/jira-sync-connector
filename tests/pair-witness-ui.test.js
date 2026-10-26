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
  pairClassText,
  pairWitnessFindingText
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
const APP_SOURCE = read('static/admin-page/src/App.jsx');
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
    expect(APP_SOURCE).toContain("import PairWitnessMigration from './components/PairWitnessMigration.jsx'");
    expect(APP_SOURCE).toContain('<PairWitnessMigration');
    expect(APP_SOURCE).toContain('selectedOrg={selectedOrg}');
  });

  test('the panel calls exactly one resolver and it is the read-only preview', () => {
    const invocations = [...COMPONENT_SOURCE.matchAll(/invoke\('([^']+)'/g)].map((match) => match[1]);
    expect(invocations).toEqual(['previewPairWitnessMigration']);
    expect(COMPONENT_SOURCE).not.toMatch(/invoke\('(approve|apply|migrate|restore)/i);
  });

  test('the read-only promise is stated in the surface text', () => {
    expect(PAIR_WITNESS_READ_ONLY_TEXT).toContain('writes no issue property');
    expect(PAIR_WITNESS_READ_ONLY_TEXT).toContain('creates no issue');
    expect(PAIR_WITNESS_NO_APPLY_TEXT).toContain('No migration action is available');
    expect(PAIR_WITNESS_PAUSE_TEXT).toContain('never changes the pause state');
    expect(PAIR_WITNESS_SCOPE_TEXT).toContain('Jira issue property');
    // The panel offers one control and it cannot write anything.
    const buttonBlocks = [...COMPONENT_SOURCE.matchAll(/<Button[\s\S]*?<\/Button>/g)]
      .map((match) => match[0]);
    expect(buttonBlocks).toHaveLength(1);
    expect(buttonBlocks[0]).toContain('Run read-only preview');
    expect(buttonBlocks[0]).not.toMatch(/apply|approve|migrate/i);
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

    const { container } = render(<PairWitnessMigration selectedOrg={ORG} showMessage={jest.fn()} />);
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

