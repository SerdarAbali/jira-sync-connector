/** @jest-environment node */
import fs from 'fs';
import path from 'path';
import {
  buildReconciliationReviewCommentADF,
  isConnectorGeneratedComment,
  isCounterpartNotice,
  prependCounterpartNoticeToADF,
  stripCounterpartNoticeFromADF,
  extractTextFromADF
} from '../src/utils/adf';

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const paragraph = text => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const legacyNotice = { type: 'panel', attrs: { panelType: 'warning' }, content: [
  paragraph('Jira Sync Connector notice: protected counterpart. Existing notice.')
] };

test('Jira title and browser title display the product name without changing module identity', () => {
  const manifest = read('manifest.yml');
  expect(manifest).toContain('title: SyncApp');
  expect(manifest).not.toMatch(/title: .*Sync Connector/);
  expect(manifest).toContain('key: sync-connector-admin');
  expect(manifest).toContain('362d8e6b-b68c-4403-8020-d32ddcc02716');
  expect(read('static/admin-page/src/index.html')).toContain('<title>SyncApp</title>');
});

test('new review text uses SyncApp and current navigation; new and legacy comments remain excluded', () => {
  const body = buildReconciliationReviewCommentADF({ localKey: 'LOCAL-1', reasonCode: 'TEST', attempts: 2 });
  const text = extractTextFromADF(body);
  expect(text).toContain('SyncApp recurring reconciliation review required.');
  expect(text).toContain('SyncApp > Organizations > Synchronization');
  expect(text).not.toMatch(/Sync Connector/);
  expect(isConnectorGeneratedComment(body)).toBe(true);
  expect(isConnectorGeneratedComment('Jira Sync Connector recurring reconciliation review required. Legacy review.')).toBe(true);
  expect(isConnectorGeneratedComment('SyncApp recurring reconciliation review required. Current review.')).toBe(true);
  expect(isConnectorGeneratedComment('A user discussion mentioning SyncApp')).toBe(false);
});

test('new survivor notices use SyncApp and both generations preserve original user content', () => {
  const user = paragraph('Original user description');
  const original = { type: 'doc', version: 1, content: [legacyNotice, user] };
  const snapshot = JSON.stringify(original);
  const result = prependCounterpartNoticeToADF(original, { localKey: 'LOCAL-1', remoteKey: 'REMOTE-1' });
  expect(result.content).toHaveLength(2);
  expect(JSON.stringify(result.content[0])).toContain('SyncApp notice: protected counterpart.');
  expect(JSON.stringify(result.content[0])).not.toContain('Sync Connector');
  expect(isCounterpartNotice(legacyNotice)).toBe(true);
  expect(isCounterpartNotice(result.content[0])).toBe(true);
  expect(stripCounterpartNoticeFromADF(original).content).toEqual([user]);
  expect(stripCounterpartNoticeFromADF(result).content).toEqual([user]);
  expect(extractTextFromADF(original)).toBe('Original user description');
  expect(extractTextFromADF(result)).toBe('Original user description');
  expect(JSON.stringify(original)).toBe(snapshot);
});
