import * as storage from '../storage/kvs.js';
import { getPilotPause } from './pilot-pause.js';
import { syncRemoteAttachmentsToLocal } from './attachment-sync.js';
import { getAttachmentOperation } from './attachment-operation.js';
import { isValidIssueKey, isValidAttachmentId } from '../../utils/attachment-url.js';
import { isKeyConflictError } from '../../utils/storage-errors.js';

const PREFIX = 'post-create-attachment:';
const ATTENTION = 'post-create-attachment-attention:';
const direction = 'remote-to-local';

function keyFor({ orgId, localKey, remoteKey, attachmentId }) {
  if (!/^(org-\d{1,32}|legacy)$/.test(orgId) || !isValidIssueKey(localKey) || !isValidIssueKey(remoteKey)
      || !isValidAttachmentId(attachmentId)) throw new Error('Invalid post-create attachment identifiers');
  return `${PREFIX}${orgId}:${localKey}:${remoteKey}:${attachmentId}`;
}

// Persist before any post-create reads/tasks. Only identifiers and scheduling
// metadata are retained; canonical attachment metadata is fetched by the engine.
export async function retainPostCreateAttachments({ orgId, localKey, remoteKey, attachmentIds }) {
  for (const attachmentId of new Set(attachmentIds.filter(isValidAttachmentId).map(String))) {
    const record = { orgId: orgId || 'legacy', localKey, remoteKey, attachmentId, createdAt: Date.now(), attempts: 0 };
    const key = keyFor(record);
    if (await storage.get(key.replace(PREFIX, ATTENTION))) continue;
    try { await storage.createIfNotExists(key, record); }
    catch (error) { if (!isKeyConflictError(error)) throw error; }
  }
}

async function attemptAttachment(key, record) {
  const worker = key.replace(PREFIX, 'post-create-attachment-worker:');
  try { await storage.setIfNotExists(worker, true, 360); }
  catch (error) { if (isKeyConflictError(error)) return false; throw error; }
  try {
    const current = await storage.get(key);
    if (!current || (await getPilotPause()).paused) return false;
    const operation = await getAttachmentOperation({ orgId: record.orgId, direction, sourceAttachmentId: record.attachmentId });
    const ambiguous = operation?.state === 'unknown'
      || (operation?.state === 'pending' && (operation.writeStartedAt || operation.submissionStartedAt));
    if (ambiguous || current.attempts >= 5 || Date.now() - current.createdAt >= 24 * 60 * 60 * 1000) {
      await storage.set(key.replace(PREFIX, ATTENTION), { ...current, reason: ambiguous ? 'ATTACHMENT_RECONCILIATION_REQUIRED' : 'RECOVERY_EXHAUSTED' });
      await storage.del(key);
      return false;
    }
    const legacy = record.orgId === 'legacy';
    const org = legacy ? await storage.get('syncConfig')
      : (await storage.get('organizations') || []).find(item => item.id === record.orgId);
    const options = await storage.get(legacy ? 'syncOptions' : `syncOptions:${record.orgId}`) || {};
    if (!org || options.syncAttachments !== true || org.syncDirection !== 'bidirectional') return false;
    const token = await storage.getSecret(`secret:${record.orgId}:token`);
    if (!token) return false;
    await storage.set(key, { ...current, attempts: current.attempts + 1 });
    try {
      const mapping = await syncRemoteAttachmentsToLocal(record.remoteKey, record.localKey,
        { key: record.remoteKey, fields: { attachment: [{ id: record.attachmentId }] } },
        { ...org, id: record.orgId, remoteApiToken: token }, null, legacy ? null : record.orgId,
        { syncOptions: options, attachmentIds: [record.attachmentId] });
      if (mapping[record.attachmentId]) {
        await storage.del(key);
        return true;
      }
      // A nonterminal/ambiguous engine outcome is never treated as completion.
      // Next heartbeat inspects its operation ledger before any further attempt.
      return false;
    } catch (error) {
      await storage.set(key, { ...current, attempts: current.attempts + 1,
        reason: error?.code?.startsWith('INBOUND_SCOPE_') ? error.code : 'ATTACHMENT_DEFERRED' });
      throw error;
    }
  } finally { await storage.del(worker); }
}

// A duplicate create delivery resumes only previously retained work. It cannot
// discover new attachments, create issues, or replay an ambiguous upload.
export async function resumePostCreateAttachments({ orgId, localKey, remoteKey }) {
  const prefix = `${PREFIX}${orgId || 'legacy'}:${localKey}:${remoteKey}:`;
  const records = await storage.queryByPrefix(prefix, 3);
  let completed = 0;
  for (const { key, value } of records) {
    if (keyFor(value) !== key) throw new Error('Invalid post-create attachment record');
    if (await attemptAttachment(key, value)) completed++;
  }
  return { completed, pending: (await storage.queryByPrefix(prefix, 1)).length > 0 };
}

// Existing hourly heartbeat, at most three attempts from a 100-record scan.
export async function recoverPostCreateAttachments() {
  if ((await getPilotPause()).paused) return { completed: 0 };
  const records = await storage.queryByPrefix(PREFIX, 100);
  let completed = 0;
  for (const { key, value } of records.slice(0, 3)) {
    try {
      if (keyFor(value) !== key) continue;
      if (await attemptAttachment(key, value)) completed++;
    } catch {
      // Work remains durable; never rely on successful webhook redelivery.
    }
  }
  return { completed };
}
