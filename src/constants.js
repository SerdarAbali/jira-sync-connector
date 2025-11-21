// Retry and rate limiting constants
export const MAX_RETRY_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 1000; // 1 second base delay for exponential backoff
export const RATE_LIMIT_RETRY_DELAY_MS = 60000; // 60 seconds delay for rate limit (429) responses

// HTTP status codes
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500
};

// Error messages
export const ERROR_MESSAGES = {
  MISSING_CONFIG: 'Remote Jira configuration is missing',
  AUTH_FAILED: 'Authentication failed',
  SYNC_FAILED: 'Sync operation failed',
  RATE_LIMITED: 'Rate limit exceeded',
  NETWORK_ERROR: 'Network error occurred'
};

// Logging emojis for better console visibility
export const LOG_EMOJI = {
  SUCCESS: '✅',
  ERROR: '❌',
  WARNING: '⚠️',
  INFO: 'ℹ️',
  SYNC: '🔄',
  WEBHOOK: '📡',
  SCHEDULED: '⏰',
  ATTACHMENT: '📎',
  LINK: '🔗',
  COMMENT: '💬',
  STATUS: '🎯',
  SUMMARY: '📊',
  STATS: '📈'
};

// Attachment size limits
export const MAX_ATTACHMENT_SIZE = 10485760; // 10MB in bytes (10 * 1024 * 1024)
export const MAX_ATTACHMENT_SIZE_MB = 10; // 10MB

// Sync flag TTL to prevent infinite loops
export const SYNC_FLAG_TTL_SECONDS = 300; // 5 minutes

// Scheduled sync delay between processing issues
export const SCHEDULED_SYNC_DELAY_MS = 1000; // 1 second delay between issues

// Storage keys for Forge storage
export const STORAGE_KEYS = {
  CONFIG: 'config',
  USER_MAPPINGS: 'userMappings',
  FIELD_MAPPINGS: 'fieldMappings',
  STATUS_MAPPINGS: 'statusMappings',
  PROJECT_FILTER: 'projectFilter',
  ISSUE_MAPPINGS: 'issueMappings',
  SYNC_FLAGS: 'syncFlags',
  WEBHOOK_STATS: 'webhookStats',
  SCHEDULED_STATS: 'scheduledStats',
  WEBHOOK_ERRORS: 'webhookErrors',
  SCHEDULED_ERRORS: 'scheduledErrors'
};

// Recent creation window for duplicate detection
export const RECENT_CREATION_WINDOW_MS = 300000; // 5 minutes in milliseconds

// Operation result statuses
export const OPERATION_RESULT = {
  SUCCESS: 'success',
  PARTIAL: 'partial',
  FAILURE: 'failure'
};
