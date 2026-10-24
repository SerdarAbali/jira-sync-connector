import { createHmac } from 'crypto';
import { processIncomingWebhook as processSignedWebhook } from '../../src/services/sync/incoming-sync.js';
export function processIncomingWebhook(payload, auth) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', auth.signingSecret).update(body, 'utf8').digest('hex')}`;
  return processSignedWebhook(body, { orgId: auth.orgId, signature });
}
