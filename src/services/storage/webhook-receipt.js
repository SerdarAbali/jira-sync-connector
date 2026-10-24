import * as kvsStore from './kvs.js';

export const WEBHOOK_RECEIPT_PREFIX = 'signedWebhookReceipt:';
const MAX_EVENT_NAME_LENGTH = 80;

export function webhookReceiptKey(orgId) {
  return `${WEBHOOK_RECEIPT_PREFIX}${orgId}`;
}

/**
 * Persist only non-sensitive proof that an authenticated webhook reached the
 * app. Failure is non-fatal: webhook processing must not depend on wizard
 * observability.
 */
export async function recordAuthenticatedWebhookReceipt(orgId, event, receivedAt = new Date().toISOString()) {
  if (typeof orgId !== 'string' || !orgId) return false;
  try {
    await kvsStore.set(webhookReceiptKey(orgId), {
      version: 1,
      orgId,
      event: typeof event === 'string' ? event.slice(0, MAX_EVENT_NAME_LENGTH) : null,
      receivedAt
    });
    return true;
  } catch {
    console.warn('Authenticated webhook receipt could not be stored');
    return false;
  }
}

export async function getAuthenticatedWebhookReceipt(orgId) {
  if (typeof orgId !== 'string' || !orgId) return null;
  try {
    const receipt = await kvsStore.get(webhookReceiptKey(orgId));
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      return null;
    }
    if (typeof receipt.receivedAt !== 'string' || Number.isNaN(Date.parse(receipt.receivedAt))) {
      return null;
    }
    return {
      event: typeof receipt.event === 'string' ? receipt.event.slice(0, MAX_EVENT_NAME_LENGTH) : null,
      receivedAt: receipt.receivedAt
    };
  } catch {
    return null;
  }
}
