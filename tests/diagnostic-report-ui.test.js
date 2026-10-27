import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { invoke } from '@forge/bridge';
import DiagnosticReportPanel, {
  DIAGNOSTIC_REPORT_CATEGORIES
} from '../static/admin-page/src/components/DiagnosticReportPanel.jsx';

jest.mock('@forge/bridge', () => ({ invoke: jest.fn() }), { virtual: true });
jest.mock('@atlaskit/tokens', () => ({ token: (_name, fallback) => fallback }), { virtual: true });
jest.mock('@atlaskit/button', () => {
  const ReactMock = require('react');
  const Button = ({ children, isLoading, isDisabled, ...props }) => (
    ReactMock.createElement('button', { ...props, disabled: Boolean(isDisabled) }, children)
  );
  return { __esModule: true, default: Button, LoadingButton: Button };
}, { virtual: true });
jest.mock('@atlaskit/section-message', () => {
  const ReactMock = require('react');
  return { __esModule: true, default: ({ children, title }) => (
    ReactMock.createElement('div', null, title, children)
  ) };
}, { virtual: true });

const REPORT = {
  schema: 'syncapp.diagnostic-report',
  schemaVersion: 1,
  generatedAt: '2026-10-27T12:00:00.000Z',
  diagnosticStatus: 'warning',
  scope: { organizationId: 'org-1', organizationName: 'Acme' },
  statusCodes: ['PAUSE_ACTIVE'],
  evidence: {}
};

let container, root;
const flush = async () => {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
};
const render = async selectedOrgId => {
  await act(async () => { root.render(<DiagnosticReportPanel selectedOrgId={selectedOrgId} />); });
  await flush();
};
const button = text => [...container.querySelectorAll('button')]
  .find(node => node.textContent.trim() === text);
const click = async text => {
  await act(async () => { button(text).click(); });
  await flush();
};

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks();
  invoke.mockResolvedValue({ success: true, report: REPORT });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete global.IS_REACT_ACT_ENVIRONMENT;
});

describe('diagnostic report UI', () => {
  test('requires an organization and never invokes on page load', async () => {
    await render(undefined);
    expect(container.textContent).toContain('Select an organization before generating a diagnostic report.');
    expect(invoke).not.toHaveBeenCalled();

    await render('org-1');
    expect(container.textContent).toContain('Export Diagnostic Report');
    for (const category of DIAGNOSTIC_REPORT_CATEGORIES) {
      expect(container.textContent).toContain(category);
    }
    expect(container.textContent).toContain('Even after sanitization');
    expect(container.textContent).toContain('Review the preview before external sharing');
    expect(container.textContent).toContain('Credentials, Jira content and issue records are excluded.');
    expect(invoke).not.toHaveBeenCalled();
  });

  test('generates only on explicit click and offers a download', async () => {
    await render('org-1');
    await click('Generate diagnostic report');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('exportDiagnosticReport', { orgId: 'org-1' });
    expect(container.querySelector('[aria-label="Diagnostic report preview"]').textContent)
      .toContain('syncapp.diagnostic-report');
    expect(button('Download JSON')).toBeTruthy();
  });

  test('shows a stable error and no report when generation fails', async () => {
    invoke.mockResolvedValue({ success: false, code: 'DIAGNOSTIC_ORGANIZATION_NOT_FOUND' });
    await render('org-1');
    await click('Generate diagnostic report');
    expect(container.textContent).toContain('DIAGNOSTIC_ORGANIZATION_NOT_FOUND');
    expect(container.querySelector('[aria-label="Diagnostic report preview"]')).toBeNull();
  });

  test('ignores a stale response after organization switching', async () => {
    let resolveFirst;
    const first = new Promise(resolve => { resolveFirst = resolve; });
    invoke.mockImplementationOnce(() => first);
    await render('org-1');
    await click('Generate diagnostic report');
    await render('org-2');
    await act(async () => {
      resolveFirst({ success: true, report: { ...REPORT, scope: { organizationId: 'org-1' } } });
      await Promise.resolve();
    });
    await flush();
    expect(container.querySelector('[aria-label="Diagnostic report preview"]')).toBeNull();
    expect(container.textContent).not.toContain('Acme');
  });
});
