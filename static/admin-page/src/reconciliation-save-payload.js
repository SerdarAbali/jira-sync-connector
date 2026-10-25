/**
 * The recurring reconciliation status resolver returns `settings` as a stored
 * record: the four editable fields plus server-owned metadata (`version`).
 * The save resolver validates its input against an allowlist of editable keys
 * only, so echoing the whole status object back is rejected with
 * RECONCILIATION_INVALID_SETTINGS ("version is not a supported reconciliation
 * setting."). Build the mutation payload from the editable fields only.
 */
export const RECONCILIATION_EDITABLE_SETTING_KEYS = Object.freeze([
  'recurringReconciliationEnabled',
  'reconciliationIntervalMinutes',
  'reconciliationCommentOnReview',
  'reconciliationFailureThreshold'
]);

export function toReconciliationSavePayload(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const payload = {};
  for (const key of RECONCILIATION_EDITABLE_SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      payload[key] = source[key];
    }
  }
  return payload;
}
