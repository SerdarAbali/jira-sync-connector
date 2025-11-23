const LOG_LEVELS = {
  ERROR: 'ERROR',
  WARN: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG'
};

function log(level, message, metadata = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...metadata
  };
  
  console.log(JSON.stringify(logEntry));
}

export const logger = {
  error: (msg, meta) => log(LOG_LEVELS.ERROR, msg, meta),
  warn: (msg, meta) => log(LOG_LEVELS.WARN, msg, meta),
  info: (msg, meta) => log(LOG_LEVELS.INFO, msg, meta),
  debug: (msg, meta) => log(LOG_LEVELS.DEBUG, msg, meta)
};

export default logger;
