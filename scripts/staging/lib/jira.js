'use strict';

const crypto = require('crypto');

const { PROJECT_KEY_PATTERN } = require('./config');

class JiraInventoryError extends Error {
  constructor(message, code, options = {}) {
    super(message);
    this.name = 'JiraInventoryError';
    this.code = code;
    this.endpoint = options.endpoint || null;
    this.attempts = options.attempts || 0;
  }
}

function requirePageSize(value, name, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new JiraInventoryError(
      `${name} must be a whole number between 1 and 100.`,
      'invalid-option'
    );
  }
  return value;
}

function normalizeProject(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const id = entry.id === undefined || entry.id === null ? null : String(entry.id);
  const key = typeof entry.key === 'string' ? entry.key.toUpperCase() : null;
  if (!id || !key || !PROJECT_KEY_PATTERN.test(key)) {
    return null;
  }
  return {
    id,
    key,
    name: typeof entry.name === 'string' ? entry.name : key,
    projectTypeKey:
      typeof entry.projectTypeKey === 'string' ? entry.projectTypeKey : null,
    simplified: entry.simplified === true,
  };
}

async function fetchAccessibleProjects(client, options = {}) {
  const pageSize = requirePageSize(options.pageSize, 'pageSize', 50);
  const maxPages = requirePageSize(options.maxPages, 'maxPages', 40);
  const byKey = new Map();
  let startAt = 0;
  let pages = 0;

  for (;;) {
    if (pages >= maxPages) {
      throw new JiraInventoryError(
        `The accessible project inventory was not complete after ${maxPages} page(s).`,
        'incomplete-pagination'
      );
    }

    const page = await client.get('/rest/api/3/project/search', {
      startAt,
      maxResults: pageSize,
      status: ['live', 'archived'],
      orderBy: 'key',
    });
    pages += 1;

    if (!page || typeof page !== 'object' || !Array.isArray(page.values)) {
      throw new JiraInventoryError(
        'Jira returned an unreadable project inventory page.',
        'incomplete-pagination'
      );
    }

    if (
      page.startAt !== undefined &&
      (!Number.isSafeInteger(page.startAt) || page.startAt !== startAt)
    ) {
      throw new JiraInventoryError(
        'Jira returned a project inventory page at an unexpected offset.',
        'incomplete-pagination'
      );
    }

    if (
      page.total !== undefined &&
      (!Number.isSafeInteger(page.total) || page.total < 0)
    ) {
      throw new JiraInventoryError(
        'Jira returned an invalid project inventory total.',
        'incomplete-pagination'
      );
    }

    page.values.forEach((entry) => {
      const normalized = normalizeProject(entry);
      if (!normalized) {
        throw new JiraInventoryError(
          'Jira returned a project without a usable id and key.',
          'incomplete-pagination'
        );
      }
      const existing = byKey.get(normalized.key);
      if (existing && existing.id !== normalized.id) {
        throw new JiraInventoryError(
          `Jira returned conflicting identities for project ${normalized.key}.`,
          'incomplete-pagination'
        );
      }
      byKey.set(normalized.key, normalized);
    });

    const nextStartAt = startAt + page.values.length;
    const totalKnown = Number.isSafeInteger(page.total);
    const reportedLast = page.isLast === true;
    const reachedTotal = totalKnown && nextStartAt >= page.total;

    if (!reportedLast && !reachedTotal) {
      if (nextStartAt <= startAt) {
        throw new JiraInventoryError(
          'The project inventory pagination stopped making progress.',
          'incomplete-pagination'
        );
      }
      if (page.values.length === 0 || (totalKnown && nextStartAt > page.total)) {
        throw new JiraInventoryError(
          'The project inventory pagination returned inconsistent offsets.',
          'incomplete-pagination'
        );
      }
      startAt = nextStartAt;
      continue;
    }

    if (totalKnown && byKey.size < page.total) {
      throw new JiraInventoryError(
        `The project inventory was incomplete: received ${byKey.size} of ${page.total} project(s).`,
        'incomplete-pagination'
      );
    }

    if (!reportedLast && totalKnown && nextStartAt < page.total) {
      throw new JiraInventoryError(
        'The project inventory ended before every project was received.',
        'incomplete-pagination'
      );
    }

    return {
      projects: [...byKey.values()],
      pages,
      complete: true,
      total: totalKnown ? page.total : byKey.size,
    };
  }
}

async function fetchPermissions(client, projectKey, permissions) {
  const key = String(projectKey || '').toUpperCase();
  if (!PROJECT_KEY_PATTERN.test(key)) {
    throw new JiraInventoryError(
      'A valid project key is required to read permissions.',
      'invalid-project'
    );
  }
  const requested = Array.isArray(permissions)
    ? permissions.filter((entry) => typeof entry === 'string' && entry)
    : [];
  if (requested.length === 0) {
    return {};
  }

  const response = await client.get('/rest/api/3/mypermissions', {
    permissions: requested.join(','),
    projectKey: key,
  });
  const payload =
    response && typeof response === 'object' ? response.permissions : null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new JiraInventoryError(
      `Jira returned an unreadable permission response for project ${key}.`,
      'permission-response-incomplete'
    );
  }

  const result = {};
  const missing = [];
  requested.forEach((permission) => {
    const entry = payload[permission];
    if (!entry || typeof entry !== 'object') {
      missing.push(permission);
      return;
    }
    result[permission] = entry.havePermission === true;
  });

  if (missing.length > 0) {
    throw new JiraInventoryError(
      `The permission response omitted ${missing.join(', ')} for project ${key}.`,
      'permission-response-incomplete'
    );
  }

  return result;
}

async function fetchMyself(client) {
  const identity = await client.get('/rest/api/3/myself');
  if (!identity || typeof identity !== 'object') {
    throw new JiraInventoryError(
      'Jira returned an unreadable identity response.',
      'identity-response-incomplete'
    );
  }
  return {
    accountId:
      typeof identity.accountId === 'string' ? identity.accountId : null,
    displayName:
      typeof identity.displayName === 'string' ? identity.displayName : null,
    emailAddress:
      typeof identity.emailAddress === 'string' ? identity.emailAddress : null,
    active: identity.active === true,
    accountType:
      typeof identity.accountType === 'string' ? identity.accountType : null,
  };
}

async function fetchProject(client, projectKey) {
  const key = String(projectKey || '').toUpperCase();
  if (!PROJECT_KEY_PATTERN.test(key)) {
    throw new JiraInventoryError(
      'A valid project key is required to read a project.',
      'invalid-project'
    );
  }

  const response = await client.get(`/rest/api/3/project/${key}`);
  const project = normalizeProject(response);
  if (!project || project.key !== key) {
    throw new JiraInventoryError(
      `Jira did not return the expected project ${key}.`,
      'project-response-incomplete'
    );
  }
  return project;
}

function uniqueSorted(values) {
  return Array.from(new Set(values)).sort();
}

function evaluateSiteIsolation(input = {}) {
  const role = input.role || 'unknown';
  const host = input.host || null;
  const stagingProjects = Array.isArray(input.stagingProjects)
    ? input.stagingProjects
    : [];
  const configuredNonStagingProjects = uniqueSorted(
    (Array.isArray(input.configuredNonStagingProjects)
      ? input.configuredNonStagingProjects
      : []
    ).map((entry) => String(entry).toUpperCase())
  );
  const accessibleProjects = Array.isArray(input.accessibleProjects)
    ? input.accessibleProjects
    : [];

  const stagingKeys = new Set(
    stagingProjects
      .map((entry) => String(entry.key || '').toUpperCase())
      .filter(Boolean)
  );
  const stagingIds = new Set(
    stagingProjects
      .map((entry) =>
        entry.id === undefined || entry.id === null ? null : String(entry.id)
      )
      .filter(Boolean)
  );
  const nonStagingKeys = new Set(configuredNonStagingProjects);

  const accessibleByKey = new Map();
  accessibleProjects.forEach((entry) => {
    const normalized = normalizeProject(entry);
    if (normalized && !accessibleByKey.has(normalized.key)) {
      accessibleByKey.set(normalized.key, normalized);
    }
  });

  const missingStaging = [];
  stagingProjects.forEach((entry) => {
    const key = String(entry.key || '').toUpperCase();
    const id =
      entry.id === undefined || entry.id === null ? null : String(entry.id);
    if (!key || !id) {
      missingStaging.push({ key: key || String(entry.key || ''), id, reason: 'unverified-project' });
      return;
    }
    const accessible = accessibleByKey.get(key);
    if (!accessible) {
      missingStaging.push({ key, id, reason: 'not-accessible' });
      return;
    }
    if (accessible.id !== id) {
      missingStaging.push({ key, id, reason: 'project-id-mismatch' });
    }
  });

  const missingNonStaging = configuredNonStagingProjects
    .filter((key) => !accessibleByKey.has(key))
    .map((key) => ({ key }));

  const overlaps = [];
  const overlapKeys = new Set();
  function addOverlap(entry) {
    const signature = `${entry.key}:${entry.reason}`;
    if (!overlapKeys.has(signature)) {
      overlapKeys.add(signature);
      overlaps.push(entry);
    }
  }

  configuredNonStagingProjects.forEach((key) => {
    if (stagingKeys.has(key)) {
      addOverlap({ key, id: null, reason: 'project-key-overlap' });
    }
  });

  Array.from(accessibleByKey.values()).forEach((entry) => {
    if (stagingKeys.has(entry.key)) {
      return;
    }
    if (stagingIds.has(entry.id)) {
      addOverlap({ key: entry.key, id: entry.id, reason: 'project-id-overlap' });
    }
  });

  const unclassified = Array.from(accessibleByKey.values())
    .filter(
      (entry) => !stagingKeys.has(entry.key) && !nonStagingKeys.has(entry.key)
    )
    .map((entry) => ({ id: entry.id, key: entry.key, name: entry.name }));

  const evidence = {
    role,
    host,
    staging: stagingProjects
      .map((entry) => ({
        key: String(entry.key || '').toUpperCase(),
        id: entry.id === undefined || entry.id === null ? null : String(entry.id),
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    configuredNonStagingProjects,
    accessibleProjects: Array.from(accessibleByKey.values())
      .map((entry) => ({ id: entry.id, key: entry.key }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    missingStaging,
    missingNonStaging,
    overlaps,
    unclassified,
  };

  const evidenceDigest = `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(evidence))
    .digest('hex')}`;

  const verified =
    missingStaging.length === 0 &&
    missingNonStaging.length === 0 &&
    overlaps.length === 0 &&
    unclassified.length === 0;

  return {
    role,
    host,
    verified,
    stagingProjects: evidence.staging,
    configuredNonStagingProjects,
    accessibleCount: accessibleByKey.size,
    missingStaging,
    missingNonStaging,
    overlaps,
    unclassified,
    evidenceDigest,
  };
}

module.exports = {
  JiraInventoryError,
  evaluateSiteIsolation,
  fetchAccessibleProjects,
  fetchMyself,
  fetchPermissions,
  fetchProject,
};
