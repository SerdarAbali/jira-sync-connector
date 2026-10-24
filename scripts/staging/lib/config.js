'use strict';

const fs = require('fs');
const path = require('path');

const {
  resolveConfiguredReportDirectory,
  validateCredentialFileLocation,
} = require('./paths');

const PROJECT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const JIRA_CLOUD_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PERMISSION_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const ISSUE_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]{0,79}$/;
const ENV_FILE_MAX_BYTES = 64 * 1024;

const DEFAULT_E2E_PERMISSIONS = [
  'CREATE_ISSUES',
  'EDIT_ISSUES',
  'ADD_COMMENTS',
  'CREATE_ATTACHMENTS',
  'LINK_ISSUES',
  'TRANSITION_ISSUES',
];

const SITE_FIELDS = {
  local: {
    url: 'STAGING_LOCAL_URL',
    email: 'STAGING_LOCAL_EMAIL',
    token: 'STAGING_LOCAL_API_TOKEN',
    projects: 'STAGING_LOCAL_PROJECTS',
    nonStaging: 'STAGING_LOCAL_NON_STAGING_PROJECTS',
  },
  remote: {
    url: 'STAGING_REMOTE_URL',
    email: 'STAGING_REMOTE_EMAIL',
    token: 'STAGING_REMOTE_API_TOKEN',
    projects: 'STAGING_REMOTE_PROJECTS',
    nonStaging: 'STAGING_REMOTE_NON_STAGING_PROJECTS',
  },
};

const OPTIONAL_KEYS = [
  'STAGING_REQUEST_TIMEOUT_MS',
  'STAGING_MAX_RETRIES',
  'STAGING_RETRY_MAX_WAIT_MS',
  'STAGING_PROJECT_PAGE_SIZE',
  'STAGING_MAX_PROJECT_PAGES',
  'STAGING_E2E_PERMISSIONS',
  'STAGING_REPORT_DIR',
  'STAGING_E2E_WRITE_MODE',
  'STAGING_E2E_EVIDENCE_FILE',
  'STAGING_E2E_ENVIRONMENT',
  'STAGING_E2E_LOCAL_PROJECT',
  'STAGING_E2E_REMOTE_PROJECT',
  'STAGING_E2E_ISSUE_TYPE',
  'STAGING_E2E_EVIDENCE_MAX_AGE_MS',
  'STAGING_E2E_SYNC_TIMEOUT_MS',
  'STAGING_E2E_POLL_INTERVAL_MS',
  'STAGING_E2E_POLL_MAX_INTERVAL_MS',
  'STAGING_E2E_MAX_POLLS',
  'STAGING_E2E_DUPLICATE_SETTLE_MS',
  'STAGING_E2E_CLEANUP',
  'STAGING_E2E_REPORT_DIR',
];

const KNOWN_ENV_KEYS = new Set([
  'STAGING_ALLOWED_HOSTS',
  ...Object.values(SITE_FIELDS).flatMap((fields) => Object.values(fields)),
  ...OPTIONAL_KEYS,
]);

function issue(check, code, field, message, action) {
  return {
    check,
    code,
    field: field || null,
    message,
    action: action || null,
  };
}

function parseAllowedHosts(raw) {
  const issues = [];
  const hosts = [];
  const value = typeof raw === 'string' ? raw.trim() : '';

  if (!value) {
    issues.push(
      issue(
        'host-allow-list',
        'missing-configuration',
        'STAGING_ALLOWED_HOSTS',
        'STAGING_ALLOWED_HOSTS is required.',
        'List the exact Jira Cloud hostnames permitted for this run, comma-separated.'
      )
    );
    return { hosts, issues };
  }

  value.split(',').forEach((part) => {
    const candidate = part.trim().toLowerCase();
    if (!candidate) {
      issues.push(
        issue(
          'host-allow-list',
          'invalid-allow-list-entry',
          'STAGING_ALLOWED_HOSTS',
          'The host allow-list contains an empty entry.',
          'Remove empty entries from STAGING_ALLOWED_HOSTS.'
        )
      );
      return;
    }

    if (
      candidate.includes('*') ||
      candidate.includes('/') ||
      candidate.includes(':') ||
      candidate.includes('@') ||
      !JIRA_CLOUD_HOST_PATTERN.test(candidate)
    ) {
      issues.push(
        issue(
          'host-allow-list',
          'invalid-allow-list-entry',
          'STAGING_ALLOWED_HOSTS',
          `Allow-list entry "${candidate}" is not a bare Jira Cloud hostname.`,
          'Use bare hostnames only, for example site-name.atlassian.net. Do not use schemes, ports, paths, or wildcards.'
        )
      );
      return;
    }

    if (!hosts.includes(candidate)) {
      hosts.push(candidate);
    }
  });

  return { hosts, issues };
}

function validateJiraSiteUrl(raw, allowedHosts) {
  const issues = [];
  const value = typeof raw === 'string' ? raw : '';

  if (!value || value !== value.trim()) {
    return {
      issues: [
        issue(
          'host-allow-list',
          'invalid-site-url',
          null,
          'The Jira site URL is missing or contains surrounding whitespace.',
          'Set the site URL to a bare HTTPS origin with no whitespace.'
        ),
      ],
    };
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    return {
      issues: [
        issue(
          'host-allow-list',
          'invalid-site-url',
          null,
          'The Jira site URL is not a valid URL.',
          'Set the site URL to https://<site>.atlassian.net.'
        ),
      ],
    };
  }

  if (parsed.protocol !== 'https:') {
    issues.push(
      issue(
        'host-allow-list',
        'insecure-site-url',
        null,
        'The Jira site URL must use HTTPS.',
        'Change the site URL scheme to https.'
      )
    );
  }

  if (parsed.username || parsed.password) {
    issues.push(
      issue(
        'host-allow-list',
        'site-url-userinfo',
        null,
        'The Jira site URL must not contain credentials.',
        'Remove user information from the URL and use the dedicated email and API token fields.'
      )
    );
  }

  const authority = value.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0];
  if (/:\d+$/.test(authority)) {
    issues.push(
      issue(
        'host-allow-list',
        'site-url-port',
        null,
        'The Jira site URL must not specify a port.',
        'Remove the port from the site URL.'
      )
    );
  }

  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    issues.push(
      issue(
        'host-allow-list',
        'site-url-path',
        null,
        'The Jira site URL must be an origin only.',
        'Remove paths, query strings, and fragments from the site URL.'
      )
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (!JIRA_CLOUD_HOST_PATTERN.test(host)) {
    issues.push(
      issue(
        'host-allow-list',
        'host-not-jira-cloud',
        null,
        `Host "${host}" is not a Jira Cloud hostname.`,
        'Use a hostname of the form <site>.atlassian.net.'
      )
    );
  }

  if (!allowedHosts.includes(host)) {
    issues.push(
      issue(
        'host-allow-list',
        'host-not-allowlisted',
        null,
        `Host "${host}" is not present in STAGING_ALLOWED_HOSTS.`,
        'Add the exact hostname to STAGING_ALLOWED_HOSTS only after confirming it is the intended staging site.'
      )
    );
  }

  if (issues.length > 0) {
    return { issues };
  }

  return { host, origin: `https://${host}` };
}

function parseEnvFile(text) {
  const vars = Object.create(null);
  const issues = [];

  if (Buffer.byteLength(text, 'utf8') > ENV_FILE_MAX_BYTES) {
    return {
      vars,
      issues: [
        issue(
          'configuration',
          'env-file-too-large',
          null,
          `The environment file exceeds ${ENV_FILE_MAX_BYTES} bytes.`,
          'Keep only the staging configuration keys in the environment file.'
        ),
      ],
    };
  }

  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) {
      issues.push(
        issue(
          'configuration',
          'env-file-syntax',
          null,
          `Environment file line ${index + 1} is not a KEY=VALUE assignment.`,
          'Remove the line or rewrite it as KEY=VALUE.'
        )
      );
      return;
    }

    const key = match[1];
    let value = match[2];
    const first = value.charAt(0);
    if (first === '"' || first === "'") {
      if (value.length < 2 || value.charAt(value.length - 1) !== first) {
        issues.push(
          issue(
            'configuration',
            'env-file-quote',
            key,
            `Environment file line ${index + 1} has an unterminated quoted value.`,
            'Close the quote or remove it.'
          )
        );
        return;
      }
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }

    if (value.includes('\0')) {
      issues.push(
        issue(
          'configuration',
          'env-file-null-byte',
          key,
          `Environment file line ${index + 1} contains a null byte.`,
          'Remove the null byte.'
        )
      );
      return;
    }

    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      issues.push(
        issue(
          'configuration',
          'env-file-duplicate-key',
          key,
          `Environment file line ${index + 1} repeats ${key}.`,
          'Keep exactly one assignment for each key.'
        )
      );
      return;
    }

    vars[key] = value;
  });

  return { vars, issues };
}

function parseProjectList(raw, options) {
  const issues = [];
  const keys = [];
  const value = typeof raw === 'string' ? raw.trim() : '';

  if (!value && !options.allowEmpty) {
    issues.push(
      issue(
        options.check,
        'empty-project-list',
        options.field,
        `${options.field} must list at least one project key.`,
        `Set ${options.field} to one or more comma-separated Jira project keys.`
      )
    );
    return { keys, issues };
  }

  if (value) {
    value.split(',').forEach((part) => {
      const key = part.trim();
      if (!key) {
        return;
      }
      if (!PROJECT_KEY_PATTERN.test(key)) {
        issues.push(
          issue(
            options.check,
            'invalid-project-key',
            options.field,
            `${options.field} contains a value that is not a valid Jira project key.`,
            'Use project keys that start with a letter and contain only letters, digits, and underscores.'
          )
        );
        return;
      }
      if (keys.some((entry) => entry.toUpperCase() === key.toUpperCase())) {
        issues.push(
          issue(
            options.check,
            'duplicate-project-key',
            options.field,
            `${options.field} contains duplicate project key "${key}".`,
            'Remove duplicate project keys.'
          )
        );
        return;
      }
      keys.push(key);
    });
  }

  return { keys, issues };
}

function parsePermissionList(raw) {
  const issues = [];
  const permissions = [];
  const value = typeof raw === 'string' ? raw.trim() : '';

  if (!value) {
    return { permissions: [...DEFAULT_E2E_PERMISSIONS], issues };
  }

  value.split(',').forEach((part) => {
    const key = part.trim();
    if (!key) {
      return;
    }
    if (!PERMISSION_KEY_PATTERN.test(key)) {
      issues.push(
        issue(
          'configuration',
          'invalid-permission-key',
          'STAGING_E2E_PERMISSIONS',
          'STAGING_E2E_PERMISSIONS contains an invalid Jira permission key.',
          'Use uppercase Jira permission keys separated by commas.'
        )
      );
      return;
    }
    if (!permissions.includes(key)) {
      permissions.push(key);
    }
  });

  if (permissions.length === 0) {
    issues.push(
      issue(
        'configuration',
        'empty-permission-list',
        'STAGING_E2E_PERMISSIONS',
        'STAGING_E2E_PERMISSIONS must contain at least one permission key.',
        'Remove the variable to use the default permission list.'
      )
    );
  }

  return { permissions: permissions.length > 0 ? permissions : [...DEFAULT_E2E_PERMISSIONS], issues };
}

function toRelativeLabel(cwd, absolutePath) {
  const relative = path.relative(cwd, absolutePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative;
  }
  return path.basename(absolutePath);
}

function resolveEnvFile(options = {}) {
  const cwd = options.cwd || process.cwd();
  const fsImpl = options.fsImpl || fs;
  const explicitPath = options.explicitPath;

  if (explicitPath) {
    const absolutePath = path.resolve(cwd, explicitPath);
    return {
      path: absolutePath,
      explicit: true,
      missing: !fsImpl.existsSync(absolutePath),
    };
  }

  const candidates = ['.env.staging.local', '.env.staging'];
  for (const candidate of candidates) {
    const absolutePath = path.resolve(cwd, candidate);
    if (fsImpl.existsSync(absolutePath)) {
      return { path: absolutePath, explicit: false, missing: false };
    }
  }

  return { path: null, explicit: false, missing: false };
}

function readEnvFile(absolutePath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const label = options.label || path.basename(absolutePath);
  let stat;

  try {
    stat = fsImpl.statSync(absolutePath);
  } catch (error) {
    return {
      vars: {},
      issues: [
        issue(
          'configuration',
          'env-file-missing',
          null,
          `The environment file "${label}" was not found.`,
          'Create the environment file with mode 600 or pass --env-file with an existing file.'
        ),
      ],
    };
  }

  if (!stat.isFile()) {
    return {
      vars: {},
      issues: [
        issue(
          'configuration',
          'env-file-not-file',
          null,
          `The environment path "${label}" is not a regular file.`,
          'Point --env-file at a regular file with mode 600.'
        ),
      ],
    };
  }

  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    return {
      vars: {},
      issues: [
        issue(
          'configuration',
          'env-file-permissions',
          null,
          `The environment file "${label}" is readable by group or other users.`,
          `Restrict it with: chmod 600 ${label}`
        ),
      ],
    };
  }

  if (stat.size > ENV_FILE_MAX_BYTES) {
    return {
      vars: {},
      issues: [
        issue(
          'configuration',
          'env-file-too-large',
          null,
          `The environment file "${label}" is too large.`,
          'Keep only the staging configuration keys in the environment file.'
        ),
      ],
    };
  }

  let text;
  try {
    text = fsImpl.readFileSync(absolutePath, 'utf8');
  } catch (error) {
    return {
      vars: {},
      issues: [
        issue(
          'configuration',
          'env-file-unreadable',
          null,
          `The environment file "${label}" could not be read.`,
          'Check file ownership and permissions.'
        ),
      ],
    };
  }

  const parsed = parseEnvFile(text);
  return {
    vars: parsed.issues.length > 0 ? {} : parsed.vars,
    issues: parsed.issues,
  };
}

function pickStagingEnv(env) {
  const picked = {};
  if (!env || typeof env !== 'object') {
    return picked;
  }
  KNOWN_ENV_KEYS.forEach((key) => {
    if (typeof env[key] === 'string') {
      picked[key] = env[key];
    }
  });
  return picked;
}

function loadConfig(options = {}) {
  const cwd = options.cwd || process.cwd();
  const fsImpl = options.fsImpl || fs;
  const resolved = resolveEnvFile({
    cwd,
    explicitPath: options.envFile,
    fsImpl,
  });

  const empty = {
    config: buildConfig({}, { cwd, envFile: null, envSource: 'none' }).config,
    issues: [],
  };

  if (resolved.explicit && resolved.missing) {
    const label = toRelativeLabel(cwd, resolved.path);
    return {
      config: { ...empty.config, envFile: label, envSource: 'file' },
      issues: [
        issue(
          'configuration',
          'env-file-missing',
          null,
          `The environment file "${label}" was not found.`,
          'Create the environment file with mode 600 or pass --env-file with an existing file.'
        ),
      ],
    };
  }

  if (resolved.path) {
    const locationIssue = validateCredentialFileLocation(resolved.path, {
      fsImpl,
    });
    if (locationIssue) {
      const label = toRelativeLabel(cwd, resolved.path);
      return {
        config: { ...empty.config, envFile: label, envSource: 'file' },
        issues: [
          issue(
            'configuration',
            locationIssue.code,
            null,
            locationIssue.message,
            locationIssue.action
          ),
        ],
      };
    }
  }

  let fileVars = {};
  let envFileLabel = null;
  const fileIssues = [];

  if (resolved.path) {
    envFileLabel = toRelativeLabel(cwd, resolved.path);
    const read = readEnvFile(resolved.path, { fsImpl, label: envFileLabel });
    fileIssues.push(...read.issues);
    if (read.issues.length > 0) {
      return {
        config: { ...empty.config, envFile: envFileLabel, envSource: 'file' },
        issues: fileIssues,
      };
    }
    fileVars = read.vars;
  }

  const processVars = pickStagingEnv(options.env || process.env);
  const envSource = resolved.path
    ? Object.keys(processVars).length > 0
      ? 'file+process'
      : 'file'
    : 'process';

  const built = buildConfig(
    { ...fileVars, ...processVars },
    { cwd, envFile: envFileLabel, envSource }
  );

  return {
    config: built.config,
    issues: [...fileIssues, ...built.issues],
  };
}

function readInteger(env, key, defaultValue, minimum, maximum, issues) {
  const raw = env[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return defaultValue;
  }

  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) {
    issues.push(
      issue(
        'configuration',
        'invalid-integer',
        key,
        `${key} must be a whole number.`,
        `Set ${key} to a whole number between ${minimum} and ${maximum}.`
      )
    );
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    issues.push(
      issue(
        'configuration',
        'integer-out-of-range',
        key,
        `${key} must be between ${minimum} and ${maximum}.`,
        `Set ${key} to a whole number between ${minimum} and ${maximum}.`
      )
    );
    return defaultValue;
  }

  return parsed;
}

function readChoice(env, key, defaultValue, allowed, issues) {
  const raw = env[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return defaultValue;
  }

  const value = String(raw).trim().toLowerCase();
  if (!allowed.includes(value)) {
    issues.push(
      issue(
        'configuration',
        'invalid-choice',
        key,
        `${key} must be one of: ${allowed.join(', ')}.`,
        `Set ${key} to one of: ${allowed.join(', ')}.`
      )
    );
    return defaultValue;
  }

  return value;
}

function readBoolean(env, key, defaultValue, issues) {
  const raw = env[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return defaultValue;
  }

  const value = String(raw).trim().toLowerCase();
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }

  issues.push(
    issue(
      'configuration',
      'invalid-boolean',
      key,
      `${key} must be "true" or "false".`,
      `Set ${key} to "true" or "false".`
    )
  );
  return defaultValue;
}

function readProjectSelector(env, key, issues) {
  const raw = env[key];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    return null;
  }
  if (!PROJECT_KEY_PATTERN.test(value)) {
    issues.push(
      issue(
        'configuration',
        'invalid-project-key',
        key,
        `${key} must be a single Jira project key.`,
        'Use one project key that starts with a letter and contains only letters, digits, and underscores.'
      )
    );
    return null;
  }
  return value;
}

function buildConfig(env, options = {}) {
  const values = env && typeof env === 'object' ? env : {};
  const cwd = options.cwd || process.cwd();
  const fsImpl = options.fsImpl || fs;
  const issues = [];

  function requireValue(key, check) {
    const present =
      Object.prototype.hasOwnProperty.call(values, key) &&
      typeof values[key] === 'string';
    if (!present || values[key].trim() === '') {
      issues.push(
        issue(
          check,
          'missing-configuration',
          key,
          `${key} is required.`,
          `Set ${key} in the staging environment file (mode 600) or the process environment.`
        )
      );
      return '';
    }
    return values[key];
  }

  function requirePresence(key, check) {
    const present =
      Object.prototype.hasOwnProperty.call(values, key) &&
      typeof values[key] === 'string';
    if (!present) {
      issues.push(
        issue(
          check,
          'missing-configuration',
          key,
          `${key} is required.`,
          `Set ${key} explicitly. Use an empty value when the site has no non-staging projects.`
        )
      );
      return null;
    }
    return values[key];
  }

  const allowList = parseAllowedHosts(values.STAGING_ALLOWED_HOSTS);
  issues.push(...allowList.issues);

  const sites = {};
  Object.entries(SITE_FIELDS).forEach(([role, fields]) => {
    const site = {
      role,
      host: null,
      origin: null,
      email: '',
      apiToken: '',
      stagingProjects: [],
      nonStagingProjects: [],
    };

    const rawUrl = requireValue(fields.url, 'configuration');
    if (rawUrl) {
      const validated = validateJiraSiteUrl(rawUrl, allowList.hosts);
      if (validated.issues) {
        validated.issues.forEach((entry) => {
          issues.push({ ...entry, check: 'host-allow-list', field: fields.url });
        });
      } else {
        site.host = validated.host;
        site.origin = validated.origin;
      }
    }

    const rawEmail = requireValue(fields.email, 'configuration');
    if (rawEmail) {
      const email = rawEmail.trim();
      if (!EMAIL_PATTERN.test(email)) {
        issues.push(
          issue(
            'configuration',
            'invalid-email',
            fields.email,
            `${fields.email} is not a valid email address.`,
            'Use the email address associated with the Atlassian API token.'
          )
        );
      } else {
        site.email = email;
      }
    }

    const rawToken = requireValue(fields.token, 'configuration');
    if (rawToken) {
      if (rawToken !== rawToken.trim() || /\s/.test(rawToken)) {
        issues.push(
          issue(
            'configuration',
            'invalid-api-token',
            fields.token,
            `${fields.token} must not contain whitespace.`,
            'Paste the API token without leading, trailing, or embedded whitespace.'
          )
        );
      } else if (rawToken.length < 8) {
        issues.push(
          issue(
            'configuration',
            'invalid-api-token',
            fields.token,
            `${fields.token} is too short to be an Atlassian API token.`,
            'Use a current Atlassian API token.'
          )
        );
      } else {
        site.apiToken = rawToken;
      }
    }

    const rawStagingProjects = requireValue(fields.projects, 'project-configuration');
    if (rawStagingProjects) {
      const parsed = parseProjectList(rawStagingProjects, {
        field: fields.projects,
        check: 'project-configuration',
        allowEmpty: false,
      });
      issues.push(...parsed.issues);
      site.stagingProjects = parsed.keys;
    }

    const rawNonStaging = requirePresence(
      fields.nonStaging,
      'project-configuration'
    );
    if (rawNonStaging !== null) {
      const parsed = parseProjectList(rawNonStaging, {
        field: fields.nonStaging,
        check: 'project-configuration',
        allowEmpty: true,
      });
      issues.push(...parsed.issues);
      site.nonStagingProjects = parsed.keys;
    }

    const stagingUpper = site.stagingProjects.map((key) => key.toUpperCase());
    const overlap = site.nonStagingProjects.filter((key) =>
      stagingUpper.includes(key.toUpperCase())
    );
    if (overlap.length > 0) {
      issues.push(
        issue(
          'project-configuration',
          'project-overlap-configuration',
          fields.nonStaging,
          `The non-staging inventory includes staging project key(s): ${overlap.join(', ')}.`,
          'Remove staging project keys from the non-staging inventory. Isolation cannot be certified while the classification overlaps.'
        )
      );
    }

    sites[role] = site;
  });


  if (
    sites.local.host &&
    sites.remote.host &&
    sites.local.host === sites.remote.host
  ) {
    issues.push(
      issue(
        'host-allow-list',
        'host-not-distinct',
        null,
        'The local and remote sites resolve to the same hostname.',
        'Configure two independent Jira Cloud sites; isolation cannot be certified for a single site.'
      )
    );
  }

  const e2ePermissions = parsePermissionList(values.STAGING_E2E_PERMISSIONS);
  issues.push(...e2ePermissions.issues);

  const defaultReportDir = path.resolve(cwd, 'artifacts/staging-preflight');
  let reportDir = defaultReportDir;
  const rawReportDir = values.STAGING_REPORT_DIR;
  const reportDirValue =
    rawReportDir !== undefined && String(rawReportDir).trim() !== ''
      ? String(rawReportDir).trim()
      : 'artifacts/staging-preflight';
  try {
    reportDir = resolveConfiguredReportDirectory(
      cwd,
      reportDirValue,
      fsImpl
    ).dir;
  } catch (error) {
    issues.push(
      issue(
        'configuration',
        'invalid-report-directory',
        'STAGING_REPORT_DIR',
        error.message,
        'Use a relative path under artifacts/, for example artifacts/staging-preflight.'
      )
    );
  }

  const defaultE2EReportDir = path.resolve(cwd, 'artifacts/staging-e2e');
  let e2eReportDir = defaultE2EReportDir;
  const rawE2EReportDir = values.STAGING_E2E_REPORT_DIR;
  const e2eReportDirValue =
    rawE2EReportDir !== undefined && String(rawE2EReportDir).trim() !== ''
      ? String(rawE2EReportDir).trim()
      : 'artifacts/staging-e2e';
  try {
    e2eReportDir = resolveConfiguredReportDirectory(
      cwd,
      e2eReportDirValue,
      fsImpl
    ).dir;
  } catch (error) {
    issues.push(
      issue(
        'configuration',
        'invalid-report-directory',
        'STAGING_E2E_REPORT_DIR',
        String(error.message || '').replace(/STAGING_REPORT_DIR/g, 'STAGING_E2E_REPORT_DIR'),
        'Use a relative path under artifacts/, for example artifacts/staging-e2e.'
      )
    );
  }

  const e2eIssueType = String(values.STAGING_E2E_ISSUE_TYPE || '').trim() || 'Task';
  if (!ISSUE_TYPE_PATTERN.test(e2eIssueType)) {
    issues.push(
      issue(
        'configuration',
        'invalid-issue-type',
        'STAGING_E2E_ISSUE_TYPE',
        'STAGING_E2E_ISSUE_TYPE is not a valid Jira issue type name.',
        'Use a Jira issue type name such as Task or Story.'
      )
    );
  }

  const e2e = {
    writeMode: typeof values.STAGING_E2E_WRITE_MODE === 'string'
      ? values.STAGING_E2E_WRITE_MODE.trim()
      : '',
    evidenceFile: typeof values.STAGING_E2E_EVIDENCE_FILE === 'string'
      ? values.STAGING_E2E_EVIDENCE_FILE.trim()
      : '',
    environment: readChoice(
      values,
      'STAGING_E2E_ENVIRONMENT',
      'staging',
      ['development', 'staging'],
      issues
    ),
    localProject: readProjectSelector(values, 'STAGING_E2E_LOCAL_PROJECT', issues),
    remoteProject: readProjectSelector(values, 'STAGING_E2E_REMOTE_PROJECT', issues),
    issueType: e2eIssueType,
    evidenceMaxAgeMs: readInteger(
      values,
      'STAGING_E2E_EVIDENCE_MAX_AGE_MS',
      15 * 60 * 1000,
      60 * 1000,
      24 * 60 * 60 * 1000,
      issues
    ),
    syncTimeoutMs: readInteger(
      values,
      'STAGING_E2E_SYNC_TIMEOUT_MS',
      180 * 1000,
      5000,
      15 * 60 * 1000,
      issues
    ),
    pollIntervalMs: readInteger(
      values,
      'STAGING_E2E_POLL_INTERVAL_MS',
      2000,
      250,
      30000,
      issues
    ),
    pollMaxIntervalMs: readInteger(
      values,
      'STAGING_E2E_POLL_MAX_INTERVAL_MS',
      15000,
      250,
      60000,
      issues
    ),
    maxPolls: readInteger(values, 'STAGING_E2E_MAX_POLLS', 60, 1, 600, issues),
    duplicateSettleMs: readInteger(
      values,
      'STAGING_E2E_DUPLICATE_SETTLE_MS',
      5000,
      0,
      60000,
      issues
    ),
    cleanup: readBoolean(values, 'STAGING_E2E_CLEANUP', true, issues),
    reportDir: e2eReportDir,
    reportDirLabel: toRelativeLabel(cwd, e2eReportDir),
  };

  return {
    config: {
      mode: 'read-only',
      envFile: options.envFile || null,
      envSource: options.envSource || 'process',
      allowedHosts: allowList.hosts,
      local: sites.local,
      remote: sites.remote,
      requestTimeoutMs: readInteger(
        values,
        'STAGING_REQUEST_TIMEOUT_MS',
        15000,
        1000,
        60000,
        issues
      ),
      maxRetries: readInteger(values, 'STAGING_MAX_RETRIES', 2, 0, 5, issues),
      retryMaxWaitMs: readInteger(
        values,
        'STAGING_RETRY_MAX_WAIT_MS',
        30000,
        0,
        60000,
        issues
      ),
      projectPageSize: readInteger(
        values,
        'STAGING_PROJECT_PAGE_SIZE',
        50,
        1,
        100,
        issues
      ),
      maxProjectPages: readInteger(
        values,
        'STAGING_MAX_PROJECT_PAGES',
        40,
        1,
        100,
        issues
      ),
      e2ePermissions: e2ePermissions.permissions,
      e2e,
      reportDir,
      reportDirLabel: toRelativeLabel(cwd, reportDir),
      cwd,
    },
    issues,
  };
}

function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) {
    return null;
  }
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

module.exports = {
  DEFAULT_E2E_PERMISSIONS,
  KNOWN_ENV_KEYS,
  PROJECT_KEY_PATTERN,
  buildConfig,
  loadConfig,
  maskEmail,
  parseAllowedHosts,
  parseEnvFile,
  parseProjectList,
  readEnvFile,
  resolveEnvFile,
  validateJiraSiteUrl,
};
