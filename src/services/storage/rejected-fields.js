import * as kvsStore from './kvs.js';

/**
 * Persists field IDs that Jira rejected during a sync (read-only,
 * unknown, or not-on-screen fields). The admin page surfaces these
 * so users can remove or fix the corresponding field mappings.
 */

function buildKey(orgId) {
  return `rejected-fields:${orgId || 'legacy'}`;
}

export async function recordRejectedFields(orgId, fieldIds) {
  if (!orgId || !Array.isArray(fieldIds) || fieldIds.length === 0) return [];
  const key = buildKey(orgId);
  const existing = (await kvsStore.get(key)) || [];
  const merged = Array.from(new Set([...existing, ...fieldIds]));
  await kvsStore.set(key, merged);
  return merged;
}

export async function getRejectedFields(orgId) {
  if (!orgId) return [];
  return (await kvsStore.get(buildKey(orgId))) || [];
}

export async function clearRejectedField(orgId, fieldId) {
  if (!orgId || !fieldId) return;
  const key = buildKey(orgId);
  const existing = (await kvsStore.get(key)) || [];
  const filtered = existing.filter(f => f !== fieldId);
  if (filtered.length === 0) {
    await kvsStore.del(key);
  } else {
    await kvsStore.set(key, filtered);
  }
}
