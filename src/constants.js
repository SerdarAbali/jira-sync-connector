// Configuration Constants for Jira Sync Connector

// File Upload Limits
export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB in bytes
export const MAX_ATTACHMENT_SIZE_MB = 10; // For user-facing messages

// Rate Limiting & Performance
export const SCHEDULED_SYNC_DELAY_MS = 500; // Delay between issues in scheduled sync
export const RETRY_BASE_DELAY_MS = 1000; // Base delay for exponential backoff (1 second)
export const MAX_RETRY_ATTEMPTS = 3; // Maximum number of retry attempts for failed API calls
export const RATE_LIMIT_RETRY_DELAY_MS = 60000; // Wait 1 minute when rate limited (429)
export const BATCH_SIZE = 10; // Number of issues to process per batch in scheduled sync
export const BATCH_DELAY_MS = 5000; // Delay between batches (5 seconds) to avoid rate limits

// Sync Detection & Loop Prevention
export const SYNC_FLAG_TTL_SECONDS = 5; // TTL for "syncing" flag in storage
export const RECENT_CREATION_WINDOW_MS = 3000; // 3 seconds window to detect newly created issues

// Storage Management
export const MAX_AUDIT_LOG_ENTRIES = 50; // Keep only 50 most recent audit entries
export const MAX_ERROR_ENTRIES = 50; // Keep only 50 most recent errors
export const MAX_PENDING_LINK_ATTEMPTS = 10; // Remove pending links after 10 failed attempts

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
  SPRINT: '🏃',
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
