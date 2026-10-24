'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPORT_ROOT = 'artifacts';

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function canonicalize(target, fsImpl = fs) {
  const resolved = path.resolve(target);
  let current = resolved;
  const suffix = [];

  for (;;) {
    let exists = false;
    try {
      fsImpl.lstatSync(current);
      exists = true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    if (exists) {
      let real;
      try {
        real = fsImpl.realpathSync(current);
      } catch (error) {
        if (error.code === 'ENOENT') {
          throw new Error('The path contains an unresolved symbolic link.');
        }
        throw error;
      }
      if (suffix.length > 0 && !fsImpl.statSync(real).isDirectory()) {
        throw new Error('A parent of the path is not a directory.');
      }
      return path.resolve(real, ...suffix);
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return resolved;
    }
    suffix.unshift(path.basename(current));
    current = parent;
  }
}

function reportDirectoryError(message) {
  return new Error(`Unsafe report directory: ${message}`);
}

function resolveConfiguredReportDirectory(cwd, rawValue, fsImpl = fs) {
  const candidate = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!candidate || candidate.includes('\0') || path.isAbsolute(candidate)) {
    throw reportDirectoryError(
      'STAGING_REPORT_DIR must be a relative path under artifacts/.'
    );
  }

  const segments = candidate.split(/[\\/]+/);
  if (segments.includes('..')) {
    throw reportDirectoryError(
      'STAGING_REPORT_DIR must not contain parent-directory traversal.'
    );
  }

  const root = path.resolve(cwd);
  const artifacts = path.join(root, REPORT_ROOT);
  const resolved = path.resolve(root, candidate);
  if (!isInside(artifacts, resolved)) {
    throw reportDirectoryError(
      'STAGING_REPORT_DIR must stay inside the private artifacts/ subtree.'
    );
  }

  const canonicalRoot = canonicalize(root, fsImpl);
  const canonicalArtifacts = canonicalize(artifacts, fsImpl);
  const expectedCanonicalArtifacts = path.join(canonicalRoot, REPORT_ROOT);
  if (canonicalArtifacts !== expectedCanonicalArtifacts) {
    throw reportDirectoryError(
      'The artifacts/ directory must be the real private directory, not a symbolic link.'
    );
  }

  const canonicalCandidate = canonicalize(resolved, fsImpl);
  if (!isInside(canonicalArtifacts, canonicalCandidate)) {
    throw reportDirectoryError(
      'STAGING_REPORT_DIR resolves outside the private artifacts/ subtree.'
    );
  }

  return { dir: resolved, canonicalDir: canonicalCandidate };
}

function resolveReportDirectoryForWrite(dir, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const root = path.resolve(options.cwd || process.cwd());
  const resolved = path.resolve(dir);
  const artifacts = path.join(root, REPORT_ROOT);

  if (!isInside(artifacts, resolved)) {
    throw reportDirectoryError(
      'Report output must stay inside the private artifacts/ subtree.'
    );
  }

  const canonicalRoot = canonicalize(root, fsImpl);
  const canonicalArtifacts = canonicalize(artifacts, fsImpl);
  const expectedCanonicalArtifacts = path.join(canonicalRoot, REPORT_ROOT);
  if (canonicalArtifacts !== expectedCanonicalArtifacts) {
    throw reportDirectoryError(
      'The artifacts/ directory must be the real private directory, not a symbolic link.'
    );
  }

  const canonicalCandidate = canonicalize(resolved, fsImpl);
  if (!isInside(canonicalArtifacts, canonicalCandidate)) {
    throw reportDirectoryError(
      'Report output resolves outside the private artifacts/ subtree through a symbolic link.'
    );
  }

  return resolved;
}

function findRepositoryRoot(start, fsImpl = fs) {
  let current = path.resolve(start);
  for (;;) {
    try {
      fsImpl.lstatSync(path.join(current, '.git'));
      return current;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function gitIgnoreStatus(repositoryRoot, target) {
  const result = spawnSync(
    'git',
    ['-C', repositoryRoot, 'check-ignore', '--quiet', '--', target],
    {
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      timeout: 10000,
    }
  );

  if (result.error || result.status === null) {
    return { known: false, ignored: false };
  }
  if (result.status === 0) {
    return { known: true, ignored: true };
  }
  if (result.status === 1) {
    return { known: true, ignored: false };
  }
  return { known: false, ignored: false };
}

function validateCredentialFileLocation(filePath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  let canonicalFile;
  try {
    canonicalFile = canonicalize(filePath, fsImpl);
  } catch (error) {
    return null;
  }

  const repositoryRoot = findRepositoryRoot(
    path.dirname(canonicalFile),
    fsImpl
  );
  if (!repositoryRoot) {
    return null;
  }

  let canonicalRepository;
  try {
    canonicalRepository = canonicalize(repositoryRoot, fsImpl);
  } catch (error) {
    return {
      code: 'env-file-ignore-unverified',
      message:
        'The environment file is inside a repository whose ignore status could not be verified.',
      action:
        'Move the credential file outside the repository or repair the repository path.',
    };
  }

  if (!isInside(canonicalRepository, canonicalFile)) {
    return null;
  }

  const status = gitIgnoreStatus(repositoryRoot, canonicalFile);
  if (!status.known) {
    return {
      code: 'env-file-ignore-unverified',
      message:
        'Git could not verify that the repository-resident environment file is ignored.',
      action:
        'Move the credential file outside the repository or repair Git ignore handling.',
    };
  }
  if (!status.ignored) {
    return {
      code: 'env-file-not-ignored',
      message:
        'The environment file is inside the repository but is not ignored by Git.',
      action:
        'Move it to an ignored location such as .env.staging or artifacts/ and keep mode 600.',
    };
  }

  return null;
}

module.exports = {
  REPORT_ROOT,
  canonicalize,
  findRepositoryRoot,
  isInside,
  resolveConfiguredReportDirectory,
  resolveReportDirectoryForWrite,
  validateCredentialFileLocation,
};
