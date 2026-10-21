import { getRemoteIssue } from '../jira/remote-client.js';
import { getFullIssue } from '../jira/local-client.js';
import { hashSynchronizedFields } from './field-normalization.js';

export const REMOTE_DESTINATION_HASH_FIELDS = [
  'summary',
  'description',
  'priority',
  'labels',
  'duedate',
  'components',
  'fixVersions',
  'versions',
  'timetracking',
  'assignee',
  'reporter',
  'parent',
  'status',
  'issuetype'
];

function localMappedFieldIds(fieldMappings) {
  return Object.values(fieldMappings || {})
    .map(mapping => (typeof mapping === 'string' ? mapping : mapping?.localId))
    .filter(id => typeof id === 'string' && id.startsWith('customfield_'));
}

function remoteMappedFieldIds(fieldMappings) {
  return Object.keys(fieldMappings || {}).filter(id => id.startsWith('customfield_'));
}

/**
 * Hash the complete synchronized-field projection of a remote destination.
 * The caller must use this exact projection for the later remote echo check.
 * Returns unavailable rather than a partial-payload hash when the destination
 * cannot be read.
 */
export async function resolveRemoteDestinationHash({
  org,
  remoteKey,
  mappings = {},
  fetchRemoteIssue = getRemoteIssue
}) {
  if (!org || !remoteKey) {
    return { available: false, reason: 'destination-identity-unavailable' };
  }
  try {
    const fields = new Set(REMOTE_DESTINATION_HASH_FIELDS);
    remoteMappedFieldIds(mappings.fieldMappings).forEach(id => fields.add(id));
    const issue = await fetchRemoteIssue(remoteKey, org, Array.from(fields));
    if (!issue || !issue.fields || typeof issue.fields !== 'object') {
      return { available: false, reason: 'destination-fetch-unavailable' };
    }
    return {
      available: true,
      hash: hashSynchronizedFields(issue.fields, {
        customFieldIds: remoteMappedFieldIds(mappings.fieldMappings),
        includeStatus: false
      })
    };
  } catch {
    return { available: false, reason: 'destination-fetch-failed' };
  }
}

/**
 * Hash the complete synchronized-field projection of a local destination.
 * The caller must use this exact projection for the later local echo check.
 */
export async function resolveLocalDestinationHash({
  localKey,
  mappings = {},
  fetchLocalIssue = getFullIssue
}) {
  if (!localKey) {
    return { available: false, reason: 'destination-identity-unavailable' };
  }
  try {
    const issue = await fetchLocalIssue(localKey);
    if (!issue || !issue.fields || typeof issue.fields !== 'object') {
      return { available: false, reason: 'destination-fetch-unavailable' };
    }
    return {
      available: true,
      hash: hashSynchronizedFields(issue.fields, {
        customFieldIds: localMappedFieldIds(mappings.fieldMappings),
        includeStatus: false
      })
    };
  } catch {
    return { available: false, reason: 'destination-fetch-failed' };
  }
}
