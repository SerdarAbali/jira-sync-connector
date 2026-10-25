/**
 * Normalizes issue-link event payloads into the fields the link triggers use.
 *
 * Forge issue-link events (`avi:jira:created:issuelink`,
 * `avi:jira:deleted:issuelink`) document `id`, `sourceIssueId`,
 * `destinationIssueId`, `sourceProjectId`, `destinationProjectId` and
 * `issueLinkType` at the payload root:
 * https://developer.atlassian.com/platform/forge/events-reference/jira/
 *
 * A payload that nests the same fields under `issueLink` is still accepted so a
 * legacy or replayed event is not dropped.
 */
export function extractLinkEventFields(event) {
  const payload = event || {};
  const legacy = payload.issueLink || {};

  return {
    linkId: payload.id ?? legacy.id ?? null,
    sourceIssueId: payload.sourceIssueId ?? legacy.sourceIssueId ?? null,
    destinationIssueId: payload.destinationIssueId ?? legacy.destinationIssueId ?? null,
    linkTypeName: payload.issueLinkType?.name ?? legacy.issueLinkType?.name ?? null
  };
}

/** Field names only: enough to diagnose payload drift without logging values. */
export function describeLinkEventFields(event) {
  const keys = Object.keys(event || {});
  return keys.length > 0 ? keys.join(', ') : 'none';
}
