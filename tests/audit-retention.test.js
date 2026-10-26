/**
 * Audit retention: count bound, byte bound, ordering, rotation and read
 * compatibility, exercised through the real writer and the real resolver.
 */
import { resetStore, seed } from './helpers/pair-witness-store.js';
import { logAuditEntry } from '../src/services/storage/stats.js';
import { defineAuditResolvers } from '../src/resolvers/audit.js';
import { MAX_AUDIT_LOG_ENTRIES, MAX_AUDIT_LOG_BYTES } from '../src/constants.js';
import { boundAuditLog, sanitizeAuditEntry } from '../src/utils/redaction.js';

jest.mock('../src/services/storage/kvs.js', () => require('./helpers/pair-witness-store.js').kvsModule);

const FORGE_KVS_VALUE_LIMIT_BYTES = 240 * 1024;

function witnessEntry(index) {
  return {
    action: 'pair_witness_property_write',
    outcome: index % 2 === 0 ? 'attempted' : 'succeeded',
    source: 'jira_transport',
    orgId: 'org-1792917897410',
    site: index % 2 === 0 ? 'local' : 'serdarjiratwo.atlassian.net',
    issueId: String(10000 + index),
    pairId: '058331cc-6195-5e28-903d-d328e33b9fe8',
    permitId: 'pw_mvpokevi_nf0qm8zj',
    reason: 'http_status',
    statusCode: 201
  };
}

async function readAuditLog() {
  let handler = null;
  defineAuditResolvers({ define: (name, fn) => { if (name === 'getAuditLog') handler = fn; } });
  return handler();
}

beforeEach(() => {
  resetStore();
});

describe('audit retention capacity', () => {
  test('the cap covers the remaining maintenance events with headroom', () => {
    // Remaining migration: 15 Org A pairs + 1 Org B pair, 2 writes per pair and
    // 2 audit events per write = 64 events. Ordinary sync and recovery entries
    // share the same log, so the cap must exceed the migration many times over.
    const remainingMaintenanceEvents = (15 + 1) * 2 * 2;
    expect(MAX_AUDIT_LOG_ENTRIES).toBeGreaterThanOrEqual(remainingMaintenanceEvents * 2);
    expect(MAX_AUDIT_LOG_ENTRIES).toBe(200);
  });

  test('the byte budget stays well below the 240 KiB platform value limit', () => {
    expect(MAX_AUDIT_LOG_BYTES).toBeLessThan(FORGE_KVS_VALUE_LIMIT_BYTES);
    expect(FORGE_KVS_VALUE_LIMIT_BYTES - MAX_AUDIT_LOG_BYTES).toBeGreaterThanOrEqual(128 * 1024);
  });

  test('a realistic witness log fits inside the byte budget', async () => {
    for (let index = 0; index < 64; index += 1) {
      await logAuditEntry(witnessEntry(index));
    }
    const entries = await readAuditLog();
    expect(entries).toHaveLength(64);
    expect(JSON.stringify(entries).length).toBeLessThan(MAX_AUDIT_LOG_BYTES);
    expect(JSON.stringify(entries).length).toBeLessThan(FORGE_KVS_VALUE_LIMIT_BYTES);
  });
});

describe('audit retention behaviour', () => {
  test('the log never exceeds the entry cap and keeps the newest entries', async () => {
    const total = MAX_AUDIT_LOG_ENTRIES + 12;
    for (let index = 0; index < total; index += 1) {
      await logAuditEntry(witnessEntry(index));
    }

    const entries = await readAuditLog();
    expect(entries).toHaveLength(MAX_AUDIT_LOG_ENTRIES);
    // Newest first: the last write is the head, the earliest entries are gone.
    expect(entries[0].issueId).toBe(String(10000 + total - 1));
    expect(entries[MAX_AUDIT_LOG_ENTRIES - 1].issueId).toBe(String(10000 + total - MAX_AUDIT_LOG_ENTRIES));
    expect(entries.some((entry) => entry.issueId === '10000')).toBe(false);
  });

  test('rotation preserves order and identity of what remains', async () => {
    const total = MAX_AUDIT_LOG_ENTRIES + 5;
    for (let index = 0; index < total; index += 1) {
      await logAuditEntry(witnessEntry(index));
    }

    const entries = await readAuditLog();
    const expected = [];
    for (let index = total - 1; index >= total - MAX_AUDIT_LOG_ENTRIES; index -= 1) {
      expected.push(String(10000 + index));
    }
    expect(entries.map((entry) => entry.issueId)).toEqual(expected);

    // Timestamps stay monotonically decreasing, so the table renders newest first.
    const timestamps = entries.map((entry) => entry.timestamp);
    expect([...timestamps].sort().reverse()).toEqual(timestamps);
  });

  test('the byte budget trims the oldest entries before the count cap bites', async () => {
    const wide = {
      ...witnessEntry(7),
      orgId: 'o'.repeat(120),
      issueKey: 'I'.repeat(120),
      remoteKey: 'R'.repeat(120),
      sourceIssue: 'S'.repeat(120),
      targetIssue: 'T'.repeat(120)
    };
    let stored = [];
    for (let index = 0; index < 120; index += 1) {
      await logAuditEntry(wide);
      stored = await readAuditLog();
      expect(JSON.stringify(stored).length).toBeLessThanOrEqual(MAX_AUDIT_LOG_BYTES);
      expect(JSON.stringify(stored).length).toBeLessThan(FORGE_KVS_VALUE_LIMIT_BYTES);
    }
    // Trimmed by bytes well before hitting the entry cap.
    expect(stored.length).toBeLessThan(MAX_AUDIT_LOG_ENTRIES);
    expect(stored.length).toBeGreaterThan(0);
  });

  test('read compatibility survives a rotation: witness fields are still intact', async () => {
    for (let index = 0; index < MAX_AUDIT_LOG_ENTRIES + 3; index += 1) {
      await logAuditEntry(witnessEntry(index));
    }
    const [newest] = await readAuditLog();
    expect(newest).toMatchObject({
      action: 'pair_witness_property_write',
      orgId: 'org-1792917897410',
      issueId: String(10000 + MAX_AUDIT_LOG_ENTRIES + 2),
      pairId: '058331cc-6195-5e28-903d-d328e33b9fe8',
      permitId: 'pw_mvpokevi_nf0qm8zj'
    });
    expect(newest.outcome === 'attempted' || newest.outcome === 'succeeded').toBe(true);
    expect(newest.site).toBeDefined();
  });

  test('pre-existing records are preserved on the next write', async () => {
    const legacy = [
      // A record written before the field fix: identity stripped, still retained.
      { action: 'pair_witness_property_write', orgId: 'org-1792917897410', timestamp: '2026-10-26T20:00:04.787Z', errorCount: 0, errors: [] }
    ];
    seed('auditLog', legacy);

    await logAuditEntry(witnessEntry(1));
    const entries = await readAuditLog();
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ orgId: 'org-1792917897410', timestamp: '2026-10-26T20:00:04.787Z' });
  });
});

describe('boundAuditLog', () => {
  test('falls back to count-only when no byte budget is given', () => {
    const entries = [{ a: 1 }, { a: 2 }, { a: 3 }];
    expect(boundAuditLog(entries, 2)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(boundAuditLog(entries, 2, 0)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test('returns an empty list for a non-array value', () => {
    expect(boundAuditLog(null, 10, 1024)).toEqual([]);
    expect(boundAuditLog({}, 10, 1024)).toEqual([]);
  });

  test('always keeps at least the newest entry, even when it alone exceeds the budget', () => {
    const huge = [{ blob: 'x'.repeat(500) }];
    expect(boundAuditLog(huge, 10, 100)).toHaveLength(1);
  });

  test('sanitized entries stay within the sanitizer field caps', () => {
    const entry = sanitizeAuditEntry({
      ...witnessEntry(2),
      body: 'x'.repeat(5000),
      authorization: 'y'.repeat(5000)
    });
    expect(JSON.stringify(entry).length).toBeLessThan(1024);
  });
});

