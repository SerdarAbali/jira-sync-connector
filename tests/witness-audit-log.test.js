/**
 * Maintenance-write audit: storage compatibility and the read-only viewer.
 *
 * The compatibility half runs the real `logAuditEntry` writer and the real
 * `getAuditLog` resolver against the modelled KVS boundary, so it proves the
 * fields survive write-time sanitization rather than merely passing a mock.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { invoke } from '@forge/bridge';
import { resetStore, seed } from './helpers/pair-witness-store.js';
import { logAuditEntry } from '../src/services/storage/stats.js';
import { defineAuditResolvers } from '../src/resolvers/audit.js';
import WitnessAuditLog, {
  WITNESS_AUDIT_ACTION,
  WITNESS_AUDIT_EMPTY_TEXT,
  WITNESS_AUDIT_READ_FAILED_TEXT,
  WITNESS_AUDIT_UNAVAILABLE_TEXT,
  witnessAuditRows
} from '../static/admin-page/src/components/WitnessAuditLog.jsx';

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

jest.mock('../src/services/storage/kvs.js', () => require('./helpers/pair-witness-store.js').kvsModule);

const WITNESS_ENTRY = {
  action: WITNESS_AUDIT_ACTION,
  outcome: 'succeeded',
  source: 'jira_transport',
  orgId: 'org-1792917897410',
  site: 'serdarjiratwo.atlassian.net',
  issueId: '10060',
  pairId: 'd066baab-12ad-5168-a832-50c316006820',
  permitId: 'pw_mvpokevi_nf0qm8zj',
  reason: 'http_status',
  statusCode: 200
};

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
  resetStore();
  jest.clearAllMocks();
  document.body.innerHTML = '';
});

describe('write/read compatibility through the real audit log', () => {
  /** Runs the real resolver definition and returns whatever getAuditLog returns. */
  async function readAuditLogViaResolver() {
    let handler = null;
    defineAuditResolvers({
      define: (name, fn) => {
        if (name === 'getAuditLog') handler = fn;
      }
    });
    expect(typeof handler).toBe('function');
    return handler();
  }

  test('a witness entry survives write-time sanitization and reads back complete', async () => {
    await logAuditEntry(WITNESS_ENTRY);

    const entries = await readAuditLogViaResolver();
    const witnessEntries = entries.filter((entry) => entry.action === WITNESS_AUDIT_ACTION);

    expect(witnessEntries).toHaveLength(1);
    expect(witnessEntries[0]).toMatchObject({
      action: WITNESS_AUDIT_ACTION,
      outcome: 'succeeded',
      source: 'jira_transport',
      orgId: 'org-1792917897410',
      site: 'serdarjiratwo.atlassian.net',
      issueId: '10060',
      pairId: 'd066baab-12ad-5168-a832-50c316006820',
      permitId: 'pw_mvpokevi_nf0qm8zj',
      reason: 'http_status',
      statusCode: 200
    });

    // The viewer maps that stored record without losing anything.
    const rows = witnessAuditRows(entries);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'succeeded',
      issueId: '10060',
      pairId: 'd066baab-12ad-5168-a832-50c316006820',
      permitId: 'pw_mvpokevi_nf0qm8zj'
    });
    expect(rows[0].statusReason).toBe('200 · http_status');
  });

  test('attempt, success, failure and refusal remain distinguishable in storage', async () => {
    for (const outcome of ['attempted', 'succeeded', 'failed', 'refused']) {
      await logAuditEntry({ ...WITNESS_ENTRY, outcome });
    }

    const entries = await readAuditLogViaResolver();
    const rows = witnessAuditRows(entries);
    expect(rows.map((row) => row.outcome).sort()).toEqual(
      ['attempted', 'failed', 'refused', 'succeeded']
    );
  });

  test('content, credentials and unrelated fields are dropped at write time', async () => {
    await logAuditEntry({
      ...WITNESS_ENTRY,
      body: '{"v":1,"pairId":"should-not-be-stored"}',
      authorization: 'Basic c2VjcmV0OnRva2Vu',
      token: 'ATATT3xFfGF0-secret',
      description: 'issue description text',
      entries: [{ issueId: '10060', payloadDigest: 'sha256:deadbeef' }]
    });

    const entries = await readAuditLogViaResolver();
    const stored = entries[0];
    const serialized = JSON.stringify(stored);

    expect(serialized).not.toContain('should-not-be-stored');
    expect(serialized).not.toContain('Basic');
    expect(serialized).not.toContain('ATATT');
    expect(serialized).not.toContain('issue description text');
    expect(serialized).not.toContain('payloadDigest');
    expect(stored.body).toBeUndefined();
    expect(stored.authorization).toBeUndefined();
    expect(stored.token).toBeUndefined();
    expect(stored.entries).toBeUndefined();
  });

  test('the witness writer itself emits identifiers only', async () => {
    const { pairWitnessAuditEntry } = require('../src/services/sync/pair-witness-permit.js');
    const entry = pairWitnessAuditEntry({
      outcome: 'attempted',
      permit: { orgId: 'org-1792917897410', permitId: 'pw_test_1' },
      entry: { site: 'local', issueId: '10040', pairId: 'd066baab-12ad-5168-a832-50c316006820' }
    });

    // Issue keys, bodies, headers and permit payload digests are never part of
    // a witness audit record: this is the invariant this feature controls.
    expect(Object.keys(entry).sort()).toEqual([
      'action', 'issueId', 'orgId', 'outcome', 'pairId', 'permitId', 'reason', 'site', 'source',
      'statusCode'
    ]);
  });

  test('malformed maintenance values are dropped rather than displayed', async () => {
    await logAuditEntry({
      ...WITNESS_ENTRY,
      issueId: 'MOB-9',
      pairId: 'not-a-uuid',
      statusCode: 9999,
      outcome: 'succ eeded<script>'
    });

    const entries = await readAuditLogViaResolver();
    const stored = entries[0];

    expect(stored.issueId).toBeUndefined();
    expect(stored.pairId).toBeUndefined();
    expect(stored.statusCode).toBeUndefined();
    expect(stored.outcome).toBeUndefined();
    expect(stored.action).toBe(WITNESS_AUDIT_ACTION);
    // The viewer still renders the record, with explicit dashes.
    const rows = witnessAuditRows(entries);
    expect(rows[0]).toMatchObject({ issueId: '—', pairId: '—', outcome: '—' });
  });

  test('other audit actions are filtered out of the witness view', async () => {
    await logAuditEntry({ action: 'config_update', orgId: 'org-1', success: true });
    await logAuditEntry(WITNESS_ENTRY);

    const entries = await readAuditLogViaResolver();
    expect(entries.length).toBe(2);
    expect(witnessAuditRows(entries)).toHaveLength(1);
  });

  test('an empty audit log reads as an empty list, not an error', async () => {
    seed('auditLog', []);
    const entries = await readAuditLogViaResolver();
    expect(entries).toEqual([]);
    expect(witnessAuditRows(entries)).toEqual([]);
  });
});


describe('read-only audit viewer', () => {
  test('renders witness records and hides non-witness entries', async () => {
    invoke.mockResolvedValue([
      { action: 'config_update', orgId: 'org-1', success: true, timestamp: '2026-10-26T19:00:00.000Z' },
      {
        ...WITNESS_ENTRY,
        timestamp: '2026-10-26T20:00:06.327Z',
        outcome: 'attempted',
        site: 'local',
        issueId: '10040'
      },
      { ...WITNESS_ENTRY, timestamp: '2026-10-26T20:00:06.400Z' }
    ]);

    const { container } = render(<WitnessAuditLog />);
    await flush();

    expect(invoke).toHaveBeenCalledWith('getAuditLog');
    expect(container.textContent).toContain('Maintenance write audit');
    expect(container.textContent).toContain('2 record(s)');
    expect(container.textContent).toContain('attempted');
    expect(container.textContent).toContain('succeeded');
    expect(container.textContent).toContain('10040');
    expect(container.textContent).toContain('10060');
    expect(container.textContent).toContain('d066baab-12ad-5168-a832-50c316006820');
    expect(container.textContent).toContain('pw_mvpokevi_nf0qm8zj');
    expect(container.textContent).toContain('200 · http_status');
    // Non-witness records are filtered out.
    expect(container.textContent).not.toContain('config_update');
  });

  test('an audit log with no witness records is a distinct empty state', async () => {
    invoke.mockResolvedValue([{ action: 'config_update', orgId: 'org-1', success: true }]);

    const { container } = render(<WitnessAuditLog />);
    await flush();

    expect(container.textContent).toContain(WITNESS_AUDIT_EMPTY_TEXT);
    expect(container.textContent).not.toContain('record(s)');
    expect(container.querySelector('table')).toBeNull();
  });

  test('a non-list response is reported as unavailable, not as empty', async () => {
    invoke.mockResolvedValue({ success: false, error: 'boom' });

    const { container } = render(<WitnessAuditLog />);
    await flush();

    expect(container.textContent).toContain(WITNESS_AUDIT_UNAVAILABLE_TEXT);
    expect(container.textContent).not.toContain(WITNESS_AUDIT_EMPTY_TEXT);
  });

  test('a failed read is reported as an error and never as empty', async () => {
    invoke.mockRejectedValue(new Error('bridge unavailable'));
    const showMessage = jest.fn();

    const { container } = render(<WitnessAuditLog showMessage={showMessage} />);
    await flush();

    expect(container.textContent).toContain(WITNESS_AUDIT_READ_FAILED_TEXT);
    expect(container.textContent).not.toContain(WITNESS_AUDIT_EMPTY_TEXT);
    expect(showMessage).toHaveBeenCalledWith('error', WITNESS_AUDIT_READ_FAILED_TEXT);
  });

  test('the viewer only ever calls the read resolver', async () => {
    invoke.mockResolvedValue([]);

    const { container } = render(<WitnessAuditLog />);
    await flush();

    const calls = invoke.mock.calls.map((call) => call[0]);
    expect(calls).toEqual(['getAuditLog']);

    const labels = [...container.querySelectorAll('button')].map((node) => node.textContent);
    expect(labels).toEqual(['Refresh audit records']);
    expect(labels.join(' ')).not.toMatch(/clear|delete|export|apply/i);
  });

  test('refreshing re-reads without changing anything', async () => {
    invoke.mockResolvedValue([{ ...WITNESS_ENTRY, timestamp: '2026-10-26T20:00:06.327Z' }]);

    const { container } = render(<WitnessAuditLog />);
    await flush();
    expect(container.textContent).toContain('1 record(s)');

    const button = [...container.querySelectorAll('button')][0];
    await act(async () => {
      button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls.every((call) => call[0] === 'getAuditLog')).toBe(true);
  });
});

