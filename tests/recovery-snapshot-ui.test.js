/**
 * Recovery-tab surface for the integration recovery snapshot export.
 *
 * Static assertions pin the wiring, the pause gate and the "not a complete
 * Forge installation backup" labelling. The rendered tests verify that the
 * downloaded bytes are the server-produced NDJSON and that the record counts
 * and installation identity are displayed.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { invoke } from '@forge/bridge';
import RecoverySnapshot, {
  SNAPSHOT_SCOPE_TEXT,
  formatBytes
} from '../static/admin-page/src/components/RecoverySnapshot.jsx';

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
const APP_PATH = path.join(ROOT, 'static/admin-page/src/App.jsx');
const COMPONENT_PATH = path.join(ROOT, 'static/admin-page/src/components/RecoverySnapshot.jsx');
const appSource = fs.readFileSync(APP_PATH, 'utf8');
const componentSource = fs.readFileSync(COMPONENT_PATH, 'utf8');

const ORG = { id: 'org-1', name: 'Pilot Org' };

function render(ui) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(ui); });
  return { container, root };
}

const snapshotFixture = () => ({
  success: true,
  fileName: 'pilot-org-org-1-recovery-snapshot-2026-02-03.ndjson',
  contentType: 'application/x-ndjson; charset=utf-8',
  content: '{"kind":"header"}\n{"kind":"counts","pairs":2,"ledger":1,"total":3}\n{"kind":"footer"}\n',
  checksum: 'sha256:abc123',
  counts: { pairs: 2, ledger: 1, total: 3, skippedRetryClaims: 0 },
  identity: {
    appId: '362d8e6b-b68c-4403-8020-d32ddcc02716',
    environmentType: 'development',
    installationId: 'installation-0000001',
    siteHost: 'site.example.com'
  },
  organization: { id: 'org-1', name: 'Pilot Org', remoteHost: 'vendor.example.com' },
  bytes: 1234,
  exportedAt: '2026-02-03T04:05:06.000Z'
});

describe('recovery snapshot UI wiring', () => {
  test('App mounts the snapshot export in the Recovery tab', () => {
    expect(appSource).toContain("import RecoverySnapshot from './components/RecoverySnapshot'");
    expect(appSource).toMatch(/\{\/\* Recovery Tab \*\/\}[\s\S]*?<RecoverySnapshot[\s\S]*?\/>/);
  });

  test('the component is read-only and labelled as a partial backup', () => {
    expect(componentSource).toContain("invoke('exportRecoverySnapshot'");
    expect(componentSource).toContain("invoke('getPilotStatus'");
    // No restore, adoption or integrity-state action is invoked from here.
    expect(componentSource).not.toContain("invoke('restore");
    expect(componentSource).not.toContain("invoke('reconcile");
    expect(componentSource).not.toContain("invoke('resume");
    expect(SNAPSHOT_SCOPE_TEXT).toContain('not a complete Forge installation backup');
    expect(componentSource).toContain('not a signature');
  });

  test('formatBytes renders bounded sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.00 MB');
    expect(formatBytes(undefined)).toBe('unknown');
  });
});

describe('recovery snapshot UI behaviour', () => {
  let originalCreateObjectURL;
  let originalRevokeObjectURL;
  let blobs;

  beforeEach(() => {
    jest.clearAllMocks();
    global.IS_REACT_ACT_ENVIRONMENT = true;
    blobs = [];
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = jest.fn((blob) => {
      blobs.push(blob);
      return 'blob:recovery-snapshot';
    });
    URL.revokeObjectURL = jest.fn();
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    delete global.IS_REACT_ACT_ENVIRONMENT;
    document.body.innerHTML = '';
  });

  test('keeps the export disabled until writes are paused', async () => {
    invoke.mockResolvedValue({ success: true, paused: false });

    const { container } = render(<RecoverySnapshot selectedOrg={ORG} showMessage={jest.fn()} />);
    await act(async () => {});

    const button = container.querySelector('button');
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain('Pause required');
    expect(invoke).toHaveBeenCalledWith('getPilotStatus');
    expect(invoke).not.toHaveBeenCalledWith('exportRecoverySnapshot', expect.anything());
  });

  test('downloads the server bytes and shows counts and identity', async () => {
    const fixture = snapshotFixture();
    invoke.mockImplementation(async (name) => (
      name === 'getPilotStatus' ? { success: true, paused: true } : fixture
    ));
    const showMessage = jest.fn();

    const { container } = render(
      <RecoverySnapshot selectedOrg={ORG} showMessage={showMessage} />
    );
    await act(async () => {});

    const button = container.querySelector('button');
    expect(button.disabled).toBe(false);

    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(invoke).toHaveBeenCalledWith('exportRecoverySnapshot', { orgId: 'org-1' });
    expect(blobs).toHaveLength(1);
    // The download is the exact server-produced NDJSON, not a re-serialization.
    expect(blobs[0].type).toBe(fixture.contentType);
    expect(blobs[0].size).toBe(Buffer.byteLength(fixture.content, 'utf8'));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:recovery-snapshot');
    expect(showMessage).toHaveBeenCalledWith('Recovery snapshot downloaded', 'success');

    expect(container.textContent).toContain('Create ledger records');
    expect(container.textContent).toContain('installation-0000001');
    expect(container.textContent).toContain('sha256:abc123');
    expect(container.textContent).toContain('vendor.example.com');
  });

  test('displays the server refusal without downloading a file', async () => {
    invoke.mockImplementation(async (name) => (
      name === 'getPilotStatus'
        ? { success: true, paused: true }
        : { success: false, code: 'SNAPSHOT_TOO_LARGE', error: 'Too large to export as one file.' }
    ));

    const { container } = render(<RecoverySnapshot selectedOrg={ORG} showMessage={jest.fn()} />);
    await act(async () => {});

    await act(async () => {
      container.querySelector('button').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(blobs).toHaveLength(0);
    expect(container.textContent).toContain('Snapshot not exported');
    expect(container.textContent).toContain('Too large to export as one file.');
  });
});
