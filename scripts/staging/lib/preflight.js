'use strict';

const crypto = require('crypto');

const { maskEmail } = require('./config');
const { JiraReadOnlyClient } = require('./http');
const {
  evaluateSiteIsolation,
  fetchAccessibleProjects,
  fetchMyself,
  fetchPermissions,
  fetchProject,
} = require('./jira');
const { redactObject, redactText, safeErrorMessage } = require('./redact');

const SCHEMA_VERSION = '1.0';
const EXIT_CODES = Object.freeze({ PASS: 0, FAIL: 1, ERROR: 2 });
const KIND = 'jira-sync-staging-preflight';

const CHECK_DEFINITIONS = [
  ['configuration', 'Configuration'],
  ['host-allow-list', 'Host allow-list'],
  ['authentication', 'Authentication'],
  ['accessible-projects', 'Accessible projects'],
  ['staging-projects', 'Staging projects'],
  ['permissions', 'Permissions'],
  ['isolation', 'Project classification and visibility'],
  ['forge-staging-installation', 'Forge staging installation'],
  ['f07-migration-state', 'F07 migration state'],
];

function check(id, status, detail, evidence) {
  const definition = CHECK_DEFINITIONS.find(([entry]) => entry === id);
  return {
    id,
    title: definition ? definition[1] : id,
    status,
    detail: detail || null,
    evidence: evidence || null,
  };
}

function configIssue(code, field, message, action) {
  return { check: 'configuration', code, field, message, action };
}

function inferConfigurationIssues(config) {
  const issues = [];
  if (!Array.isArray(config.allowedHosts) || config.allowedHosts.length === 0) {
    issues.push(
      configIssue(
        'missing-configuration',
        'STAGING_ALLOWED_HOSTS',
        'STAGING_ALLOWED_HOSTS is required.',
        'List the exact Jira Cloud hostnames permitted for this run, comma-separated.'
      )
    );
  }

  [
    ['local', 'LOCAL'],
    ['remote', 'REMOTE'],
  ].forEach(([role, upper]) => {
    const site = config[role] || {};
    if (!site.host) {
      issues.push(
        configIssue(
          'missing-configuration',
          `STAGING_${upper}_URL`,
          `STAGING_${upper}_URL is required.`,
          `Set STAGING_${upper}_URL to the https://<site>.atlassian.net origin.`
        )
      );
    }
    if (!site.email) {
      issues.push(
        configIssue(
          'missing-configuration',
          `STAGING_${upper}_EMAIL`,
          `STAGING_${upper}_EMAIL is required.`,
          `Set STAGING_${upper}_EMAIL to the Atlassian account email.`
        )
      );
    }
    if (!site.apiToken) {
      issues.push(
        configIssue(
          'missing-configuration',
          `STAGING_${upper}_API_TOKEN`,
          `STAGING_${upper}_API_TOKEN is required.`,
          `Set STAGING_${upper}_API_TOKEN in the staging environment file (mode 600) or the process environment.`
        )
      );
    }
    if (!Array.isArray(site.stagingProjects) || site.stagingProjects.length === 0) {
      issues.push(
        configIssue(
          'missing-configuration',
          `STAGING_${upper}_PROJECTS`,
          `STAGING_${upper}_PROJECTS is required.`,
          `Set STAGING_${upper}_PROJECTS to the staging project key(s).`
        )
      );
    }
  });

  return issues;
}

function dedupeIssues(issues) {
  const seen = new Set();
  return issues.filter((entry) => {
    const signature = [entry.code, entry.field, entry.message, entry.action].join('|');
    if (seen.has(signature)) {
      return false;
    }
    seen.add(signature);
    return true;
  });
}

function dedupeActions(actions) {
  const seen = new Set();
  return actions.filter((entry) => {
    if (typeof entry !== 'string' || !entry.trim() || seen.has(entry)) {
      return false;
    }
    seen.add(entry);
    return true;
  });
}

function buildClients(config, options) {
  const clients = {};
  ['local', 'remote'].forEach((role) => {
    const site = config[role];
    clients[role] = new JiraReadOnlyClient({
      site,
      email: site.email,
      apiToken: site.apiToken,
      request: options.request,
      sleep: options.sleep,
      maxRetries: config.maxRetries,
      retryMaxWaitMs: config.retryMaxWaitMs,
      timeoutMs: config.requestTimeoutMs,
    });
  });
  return clients;
}

function secretsFor(config) {
  return [
    config.local && config.local.apiToken,
    config.remote && config.remote.apiToken,
    config.local && config.local.email,
    config.remote && config.remote.email,
  ].filter((entry) => typeof entry === 'string' && entry);
}

function roleLabel(role) {
  return role === 'local' ? 'local' : 'remote';
}

function fieldFor(role, suffix) {
  return `STAGING_${roleLabel(role).toUpperCase()}_${suffix}`;
}

function authAction(role) {
  return `Verify ${fieldFor(role, 'EMAIL')} and ${fieldFor(role, 'API_TOKEN')} for the ${role} staging site.`;
}


function siteSummary(role, site, identity) {
  return {
    role,
    host: site.host || null,
    configuredEmail: maskEmail(site.email),
    identity: identity
      ? {
          accountId: identity.accountId,
          displayName: identity.displayName,
          emailAddress: maskEmail(identity.emailAddress),
          active: identity.active,
          accountType: identity.accountType,
        }
      : null,
    stagingProjects: Array.isArray(site.stagingProjects)
      ? site.stagingProjects.slice()
      : [],
    nonStagingProjects: Array.isArray(site.nonStagingProjects)
      ? site.nonStagingProjects.slice()
      : [],
  };
}

function isolationFailures(role, result) {
  const failures = [];
  if (result.missingStaging.length > 0) {
    failures.push(
      `${role}: unverified staging project(s) ${result.missingStaging
        .map((entry) => entry.key)
        .join(', ')}`
    );
  }
  if (result.missingNonStaging.length > 0) {
    failures.push(
      `${role}: non-staging project(s) not accessible ${result.missingNonStaging
        .map((entry) => entry.key)
        .join(', ')}`
    );
  }
  if (result.unclassified.length > 0) {
    failures.push(
      `${role}: unclassified accessible project(s) ${result.unclassified
        .map((entry) => entry.key)
        .join(', ')}`
    );
  }
  if (result.overlaps.length > 0) {
    failures.push(
      `${role}: classification overlap ${result.overlaps
        .map((entry) => `${entry.key} (${entry.reason})`)
        .join(', ')}`
    );
  }
  return failures;
}

function addIsolationActions(role, result, nextActions) {
  if (result.unclassified.length > 0) {
    nextActions.push(
      `Update ${fieldFor(role, 'NON_STAGING_PROJECTS')} to classify accessible project(s) ${result.unclassified
        .map((entry) => entry.key)
        .join(', ')}, or remove the account's access.`
    );
  }
  if (result.missingNonStaging.length > 0) {
    nextActions.push(
      `Add ${result.missingNonStaging
        .map((entry) => entry.key)
        .join(', ')} to ${fieldFor(role, 'NON_STAGING_PROJECTS')} after confirming the inventory.`
    );
  }
  if (result.missingStaging.length > 0) {
    nextActions.push(
      `Verify ${fieldFor(role, 'PROJECTS')} and browse access for ${result.missingStaging
        .map((entry) => entry.key)
        .join(', ')}.`
    );
  }
  result.overlaps.forEach((entry) => {
    nextActions.push(
      `Resolve the ${entry.reason} on ${entry.key} before treating ${role} project classification as complete.`
    );
  });
}

function combinedIsolationDigest(local, remote) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        local: local ? local.evidenceDigest : null,
        remote: remote ? remote.evidenceDigest : null,
      })
    )
    .digest('hex')}`;
}

function classificationEvidence(result) {
  if (!result) {
    return null;
  }
  const { verified, ...evidence } = result;
  return {
    ...evidence,
    classificationVerified: verified === true,
  };
}

async function runPreflight(options = {}) {
  const config = options.config || {};
  const secrets = secretsFor(config);
  const configIssues = dedupeIssues([
    ...(Array.isArray(options.issues) ? options.issues : []),
    ...inferConfigurationIssues(config),
  ]);
  const nextActions = configIssues
    .map((entry) => entry.action)
    .filter(Boolean);
  const checks = [];
  const identities = {};
  const inventories = {};
  const verified = { local: [], remote: [] };
  const evaluations = { local: null, remote: null };

  const configurationOk = configIssues.length === 0;
  checks.push(
    check(
      'configuration',
      configurationOk ? 'pass' : 'fail',
      configurationOk
        ? `Configuration loaded from ${config.envSource || 'process'} with an explicit host allow-list.`
        : `${configIssues.length} configuration issue(s) must be resolved before any Jira request.`,
      {
        source: config.envFile || null,
        envSource: config.envSource || 'process',
        issueCount: configIssues.length,
      }
    )
  );

  const allowedHosts = new Set(
    Array.isArray(config.allowedHosts) ? config.allowedHosts : []
  );
  const hostInvalid = ['local', 'remote'].filter((role) => {
    const site = config[role] || {};
    return !site.host || !allowedHosts.has(site.host);
  });
  const hostsDistinct =
    Boolean(config.local && config.local.host) &&
    Boolean(config.remote && config.remote.host) &&
    config.local.host !== config.remote.host;
  const hostOk = configurationOk && hostInvalid.length === 0 && hostsDistinct;

  if (!configurationOk) {
    checks.push(
      check(
        'host-allow-list',
        'skipped',
        'Host validation was skipped because configuration is incomplete.'
      )
    );
  } else {
    checks.push(
      check(
        'host-allow-list',
        hostOk ? 'pass' : 'fail',
        hostOk
          ? 'Both sites are distinct Jira Cloud hosts covered by the explicit allow-list.'
          : `Host validation failed: ${hostInvalid.join(', ') || 'hosts are not distinct'}.`,
        {
          allowedHosts: Array.from(allowedHosts),
          localHost: config.local ? config.local.host : null,
          remoteHost: config.remote ? config.remote.host : null,
        }
      )
    );
  }


  let authOk = false;
  let accessibleOk = false;
  let stagingOk = false;
  let permissionsOk = false;
  let clients = null;

  if (!configurationOk || !hostOk) {
    ['authentication', 'accessible-projects', 'staging-projects', 'permissions', 'isolation'].forEach(
      (id) => {
        checks.push(
          check(
            id,
            'skipped',
            id === 'isolation'
              ? 'Project classification and visibility were not evaluated without successful read-only checks.'
              : 'This check was skipped because configuration or host validation failed.'
          )
        );
      }
    );
  } else {
    clients = buildClients(config, options);

    const authErrors = [];
    for (const role of ['local', 'remote']) {
      try {
        identities[role] = await fetchMyself(clients[role]);
        if (!identities[role].active) {
          authErrors.push({
            role,
            message: `The ${role} Atlassian account is inactive.`,
          });
          nextActions.push(authAction(role));
        }
      } catch (error) {
        authErrors.push({ role, message: safeErrorMessage(error, secrets) });
        nextActions.push(authAction(role));
      }
    }

    authOk = authErrors.length === 0;
    checks.push(
      check(
        'authentication',
        authOk ? 'pass' : 'fail',
        authOk
          ? `Authenticated to both sites: ${['local', 'remote']
              .map(
                (role) =>
                  `${role} ${identities[role].accountId || 'account'} (${
                    maskEmail(identities[role].emailAddress) || 'email not exposed'
                  })`
              )
              .join(', ')}.`
          : `Authentication failed: ${authErrors
              .map((entry) => `${entry.role}: ${entry.message}`)
              .join(' ')}`,
        {
          local: identities.local
            ? { accountId: identities.local.accountId, active: identities.local.active }
            : null,
          remote: identities.remote
            ? { accountId: identities.remote.accountId, active: identities.remote.active }
            : null,
        }
      )
    );

    if (!authOk) {
      ['accessible-projects', 'staging-projects', 'permissions', 'isolation'].forEach(
        (id) => {
          checks.push(
            check(
              id,
              'skipped',
              'This check was skipped because authentication failed.'
            )
          );
        }
      );
    } else {
      const accessErrors = [];
      for (const role of ['local', 'remote']) {
        try {
          inventories[role] = await fetchAccessibleProjects(clients[role], {
            pageSize: config.projectPageSize,
            maxPages: config.maxProjectPages,
          });
        } catch (error) {
          accessErrors.push({ role, message: safeErrorMessage(error, secrets) });
          nextActions.push(
            `Confirm ${fieldFor(role, 'EMAIL')} can browse the complete ${role} project inventory.`
          );
        }
      }

      accessibleOk = accessErrors.length === 0;
      checks.push(
        check(
          'accessible-projects',
          accessibleOk ? 'pass' : 'fail',
          accessibleOk
            ? `Read the complete accessible inventory: local ${inventories.local.projects.length} project(s), remote ${inventories.remote.projects.length} project(s).`
            : `The accessible project inventory is incomplete: ${accessErrors
                .map((entry) => `${entry.role}: ${entry.message}`)
                .join(' ')}`,
          accessibleOk
            ? {
                local: {
                  projects: inventories.local.projects.length,
                  pages: inventories.local.pages,
                  total: inventories.local.total,
                },
                remote: {
                  projects: inventories.remote.projects.length,
                  pages: inventories.remote.pages,
                  total: inventories.remote.total,
                },
              }
            : null
        )
      );


      if (!accessibleOk) {
        ['staging-projects', 'permissions', 'isolation'].forEach((id) => {
          checks.push(
            check(
              id,
              'skipped',
              'This check was skipped because the accessible project inventory is incomplete.'
            )
          );
        });
      } else {
        const stagingErrors = [];
        for (const role of ['local', 'remote']) {
          for (const key of config[role].stagingProjects) {
            try {
              const project = await fetchProject(clients[role], key);
              verified[role].push(project);
            } catch (error) {
              stagingErrors.push(`${role} ${key}: ${safeErrorMessage(error, secrets)}`);
              nextActions.push(
                `Verify ${fieldFor(role, 'PROJECTS')} includes ${key} and that the account can browse it.`
              );
            }
          }
        }

        stagingOk = stagingErrors.length === 0;
        checks.push(
          check(
            'staging-projects',
            stagingOk ? 'pass' : 'fail',
            stagingOk
              ? `Verified every configured staging project: local ${verified.local
                  .map((entry) => entry.key)
                  .join(', ')}, remote ${verified.remote
                  .map((entry) => entry.key)
                  .join(', ')}.`
              : `Staging project verification failed: ${stagingErrors.join(' ')}`,
            {
              local: verified.local.map((entry) => ({ key: entry.key, id: entry.id })),
              remote: verified.remote.map((entry) => ({ key: entry.key, id: entry.id })),
            }
          )
        );

        if (!stagingOk) {
          checks.push(
            check(
              'permissions',
              'skipped',
              'Permission verification was skipped because a staging project could not be verified.'
            )
          );
        } else {
          const permissionErrors = [];
          const required = ['BROWSE_PROJECTS'];
          const permissionEvidence = {};

          for (const role of ['local', 'remote']) {
            for (const project of verified[role]) {
              try {
                const granted = await fetchPermissions(
                  clients[role],
                  project.key,
                  required
                );
                const denied = required.filter((entry) => granted[entry] !== true);
                permissionEvidence[`${role}:${project.key}`] = {
                  required,
                  denied,
                };
                denied.forEach((permission) => {
                  permissionErrors.push(
                    `${role} ${project.key} is missing ${permission}`
                  );
                  nextActions.push(
                    `Grant ${permission} on ${role} project ${project.key} to ${
                      maskEmail(config[role].email) || 'the configured account'
                    }.`
                  );
                });
              } catch (error) {
                permissionErrors.push(
                  `${role} ${project.key}: ${safeErrorMessage(error, secrets)}`
                );
                nextActions.push(
                  `Grant BROWSE_PROJECTS and the configured E2E permissions on ${role} project ${project.key}.`
                );
              }
            }
          }

          permissionsOk = permissionErrors.length === 0;
          checks.push(
            check(
              'permissions',
              permissionsOk ? 'pass' : 'fail',
              permissionsOk
                ? `Verified ${required.join(', ')} on every staging project.`
                : `Permission verification failed: ${permissionErrors.join('; ')}.`,
              permissionEvidence
            )
          );
        }

        for (const role of ['local', 'remote']) {
          const stagingProjects = config[role].stagingProjects.map((key) => {
            const project = verified[role].find((entry) => entry.key === key);
            return project ? { key: project.key, id: project.id } : { key, id: null };
          });
          evaluations[role] = evaluateSiteIsolation({
            role,
            host: config[role].host,
            stagingProjects,
            configuredNonStagingProjects: config[role].nonStagingProjects,
            accessibleProjects: inventories[role].projects,
          });
          addIsolationActions(role, evaluations[role], nextActions);
        }

        const isolationOk =
          evaluations.local.verified && evaluations.remote.verified;
        const failures = [
          ...isolationFailures('local', evaluations.local),
          ...isolationFailures('remote', evaluations.remote),
        ];
        checks.push(
          check(
            'isolation',
            isolationOk ? 'unknown' : 'fail',
            isolationOk
              ? 'Every accessible project is explicitly classified and visible, staging IDs are verified, and no project ID or key overlaps. Development/staging operational isolation remains unknown without verified development configuration, account access, callbacks, and pending-work evidence.'
              : `Project classification and visibility are not verified: ${failures.join('; ')}. Operational isolation remains unknown.`,
            {
              localDigest: evaluations.local.evidenceDigest,
              remoteDigest: evaluations.remote.evidenceDigest,
            }
          )
        );
      }
    }
  }


  checks.push(
    check(
      'forge-staging-installation',
      'unknown',
      'Forge staging installation state is not observable through the permitted read-only Jira APIs; it was not inferred from environment claims.',
      { status: 'unknown' }
    )
  );
  checks.push(
    check(
      'f07-migration-state',
      'unknown',
      'F07 migration state is not observable through the permitted read-only Jira APIs; it was not inferred from environment claims.',
      { status: 'unknown' }
    )
  );

  const failed = checks.filter((entry) => entry.status === 'fail');
  const counts = checks.reduce(
    (accumulator, entry) => {
      accumulator[entry.status] = (accumulator[entry.status] || 0) + 1;
      return accumulator;
    },
    { pass: 0, fail: 0, skipped: 0, unknown: 0 }
  );
  const nowValue = typeof options.now === 'function' ? options.now() : new Date();
  const nowDate = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const generatedAt = Number.isNaN(nowDate.getTime())
    ? new Date().toISOString()
    : nowDate.toISOString();
  const runId =
    options.runId ||
    `run-${generatedAt.replace(/[^0-9]/g, '').slice(0, 14)}-${crypto
      .randomBytes(3)
      .toString('hex')}`;

  const localEvaluation = evaluations.local;
  const remoteEvaluation = evaluations.remote;
  const classificationVerified = Boolean(
    localEvaluation &&
      remoteEvaluation &&
      localEvaluation.verified &&
      remoteEvaluation.verified
  );

  const report = {
    schemaVersion: SCHEMA_VERSION,
    kind: KIND,
    mode: 'read-only',
    runId,
    generatedAt,
    configuration: {
      envFile: config.envFile || null,
      envSource: config.envSource || 'process',
      reportDir: config.reportDirLabel || null,
      issues: redactObject(configIssues, secrets),
    },
    sites: {
      local: siteSummary('local', config.local || {}, identities.local),
      remote: siteSummary('remote', config.remote || {}, identities.remote),
    },
    checks,
    isolation: {
      verified: false,
      classificationVerified,
      operationalIsolation: {
        status: 'unknown',
        reason:
          'Project classification and Jira visibility do not establish that development is not synchronizing these projects. Operational isolation requires verified development configuration, development account access, callback inventory, and pending-work evidence, which this read-only Jira preflight does not observe.',
      },
      evidenceDigest: combinedIsolationDigest(localEvaluation, remoteEvaluation),
      local: classificationEvidence(localEvaluation),
      remote: classificationEvidence(remoteEvaluation),
    },
    forge: {
      status: 'unknown',
      reason:
        'The read-only preflight does not call Forge APIs. Installation state must be verified separately and is never accepted from environment variables.',
    },
    f07: {
      status: 'unknown',
      reason:
        'The read-only preflight does not call F07 migration APIs. Migration state must be verified separately and is never accepted from environment variables.',
    },
    summary: {
      status: failed.length > 0 ? 'fail' : 'pass',
      exitCode: failed.length > 0 ? EXIT_CODES.FAIL : EXIT_CODES.PASS,
      certification: 'withheld',
      checks: counts,
      failedChecks: failed.map((entry) => entry.id),
      message:
        failed.length > 0
          ? `${failed.length} preflight check(s) failed. Certification remains withheld.`
          : 'All verifiable read-only preflight checks passed. Development/staging operational isolation, Forge, and F07 remain unknown, so certification is withheld.',
    },
    nextActions: dedupeActions(
      nextActions.map((entry) => redactText(entry, secrets))
    ),
  };

  return redactObject(report, secrets);
}

module.exports = {
  CHECK_DEFINITIONS,
  EXIT_CODES,
  KIND,
  SCHEMA_VERSION,
  runPreflight,
};
