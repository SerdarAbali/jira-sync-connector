// Configuration Constants for Jira Sync Connector

// File Upload Limits
export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB in bytes
export const MAX_ATTACHMENT_SIZE_MB = 10; // For user-facing messages
export const MAX_STORAGE_SIZE = 240000; // 240 KiB limit per key in Forge (verified)

// Rate Limiting & Performance
export const SCHEDULED_SYNC_DELAY_MS = 500; // Delay between issues in scheduled sync
export const RETRY_BASE_DELAY_MS = 1000; // Base delay for exponential backoff (1 second)
export const MAX_RETRY_ATTEMPTS = 3; // Maximum number of retry attempts for failed API calls

// Retry execution budgets.
//
// Forge invocation limits are not uniform: product-event triggers and resolvers
// run for at most 25 seconds, async consumer/scheduled functions default to
// 55 seconds and may be raised up to 900 seconds with timeoutSeconds. Forge
// exposes no remaining-time API, so retries use one conservative budget that
// fits inside the shortest supported context. A Jira Retry-After deadline that
// does not fit inside the remaining budget is deferred instead of slept away.
export const RETRY_SAFE_BUDGET_MS = 10000; // Total wait allowed per retry helper call
export const RETRY_MIN_WAIT_MS = 250; // Floor for an honored Retry-After delay
export const MAX_RETRY_AFTER_MS = 3600000; // Bounded representation of Retry-After (1 hour)
export const RATE_LIMIT_RETRY_FALLBACK_MS = 5000; // Used only when Jira omits Retry-After
export const WRITE_RETRY_MAX_ATTEMPTS = 2; // Idempotent write: initial attempt plus one retry
export const BATCH_SIZE = 10; // Number of issues to process per batch in scheduled sync
export const BATCH_DELAY_MS = 5000; // Delay between batches (5 seconds) to avoid rate limits

// Sync Detection & Loop Prevention
export const SYNC_FLAG_TTL_MS = 120000; // TTL for "syncing" flag in storage (2 minutes for large issues with attachments)
export const RECENT_CREATION_WINDOW_MS = 3000; // 3 seconds window to detect newly created issues

// The Forge event that reports a user-created issue link. These events carry no
// changelog, so the link trigger marks the synthetic issue event it passes to
// syncIssue with `linkChange`; the echo gate accepts only that explicit signal.
export const LINK_CREATED_EVENT = 'avi:jira:created:issuelink';

// Storage Management
export const MAX_AUDIT_LOG_ENTRIES = 50; // Keep only 50 most recent audit entries
export const MAX_ERROR_ENTRIES = 50; // Keep only 50 most recent errors
export const MAX_PENDING_LINK_ATTEMPTS = 10; // Remove pending links after 10 failed attempts
export const MAX_HOURLY_HISTORY = 24; // Keep last 24 hourly sync stats

// Sync Hierarchy Limits
export const MAX_PARENT_SYNC_DEPTH = 5; // Maximum depth for recursive parent/epic sync

// HTTP Status Codes
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503
};

// Sync Statistics Default Values
export const DEFAULT_SYNC_STATS = {
  lastRun: null,
  issuesChecked: 0,
  issuesCreated: 0,
  issuesUpdated: 0,
  issuesSkipped: 0,
  errors: []
};

// Storage Keys (for consistency)
export const STORAGE_KEYS = {
  SYNC_CONFIG: 'syncConfig',
  USER_MAPPINGS: 'userMappings',
  USER_MAPPING_CONFIG: 'userMappingConfig',
  FIELD_MAPPINGS: 'fieldMappings',
  STATUS_MAPPINGS: 'statusMappings',
  SCHEDULED_SYNC_CONFIG: 'scheduledSyncConfig',
  SCHEDULED_SYNC_STATS: 'scheduledSyncStats',
  LOCAL_TO_REMOTE: 'local-to-remote',
  REMOTE_TO_LOCAL: 'remote-to-local',
  ATTACHMENT_MAPPINGS: 'attachment-mappings',
  LINK_MAPPINGS: 'link-mappings'
};

// Error Messages
export const ERROR_MESSAGES = {
  NO_CONFIG: 'Sync not configured',
  NO_ISSUE_KEY: 'Issue key is required',
  NO_ISSUE_DATA: 'Could not fetch issue data',
  CREATE_FAILED: 'Failed to create remote issue',
  UPDATE_FAILED: 'Failed to update remote issue',
  TRANSITION_FAILED: 'Failed to transition remote issue',
  RATE_LIMIT_EXCEEDED: 'Rate limit exceeded, retrying after delay',
  MAX_RETRIES_EXCEEDED: 'Maximum retry attempts exceeded'
};

// Log Emojis (for consistent logging)
export const LOG_EMOJI = {
  SUCCESS: '✅',
  ERROR: '❌',
  SKIP: '⏭️',
  SYNC: '🔄',
  CREATE: '✨',
  UPDATE: '📝',
  COMMENT: '💬',
  ATTACHMENT: '📎',
  LINK: '🔗',
  COMPONENT: '🏷️',
  STATUS: '🚦',
  WARNING: '⚠️',
  STOP: '⛔',
  INFO: 'ℹ️',
  SUMMARY: '📊',
  PARTIAL: '⚠️',
  DOWNLOAD: '📥',
  UPLOAD: '📤'
};

// Operation Result Types
export const OPERATION_RESULT = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  PARTIAL: 'partial',
  SKIPPED: 'skipped'
};
