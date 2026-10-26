'use strict';

/**
 * Single-runner guard for local staging orchestration.
 *
 * A browser-driven rehearsal mutates real state through the connector, so two
 * overlapping local runners are an operator hazard: the second one re-reads a
 * plan the first already consumed. The server-side permit, single-flight batch
 * lock and digest-bound approval remain the real write protection; this only
 * stops the local scripts from racing each other.
 *
 * Design notes:
 * - exclusive create (`wx`) makes acquisition atomic on a local filesystem;
 * - the lock records pid and start time so a crashed run can be reclaimed;
 * - a live foreign pid is never stolen, even if it looks old;
 * - release removes the file only when it still records our own pid.
 */

const fs = require('fs');
const path = require('path');

class RunnerLockedError extends Error {
  constructor(lockPath, holder) {
    super(`Another local runner holds ${lockPath}${holder && holder.pid ? ` (pid ${holder.pid})` : ''}`);
    this.name = 'RunnerLockedError';
    this.code = 'RUNNER_LOCKED';
    this.lockPath = lockPath;
    this.holder = holder || null;
  }
}

class RunnerLockPathError extends Error {
  constructor(lockPath) {
    super(`Runner lock path must be absolute: ${lockPath}`);
    this.name = 'RunnerLockPathError';
    this.code = 'RUNNER_LOCK_PATH_NOT_ABSOLUTE';
    this.lockPath = lockPath;
  }
}

function readRunnerLock(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { raw };
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { unreadable: true };
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function isStale(holder) {
  if (!holder || holder.unreadable) return true;
  if (!Number.isInteger(holder.pid) || holder.pid <= 0) return true;
  // A live pid always wins, however old the record looks: stealing from a runner
  // that is merely slow would reintroduce exactly the overlap this prevents.
  return !isProcessAlive(holder.pid);
}

/**
 * Acquires the local runner lock.
 *
 * @param {string} lockPath absolute path of the lock file
 * @param {{ label?: string, now?: number, pid?: number }} [options]
 * @returns {{ path: string, pid: number, startedAt: number, release: () => void }}
 * @throws {RunnerLockPathError|RunnerLockedError}
 */
function acquireRunnerLock(lockPath, options = {}) {
  if (typeof lockPath !== 'string' || !path.isAbsolute(lockPath)) {
    throw new RunnerLockPathError(lockPath);
  }

  const label = typeof options.label === 'string' ? options.label : '';
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const pid = Number.isInteger(options.pid) ? options.pid : process.pid;
  const payload = `${JSON.stringify({ pid, startedAt: now, label })}\n`;

  const tryCreate = () => {
    const descriptor = fs.openSync(lockPath, 'wx');
    try {
      fs.writeSync(descriptor, payload);
    } finally {
      fs.closeSync(descriptor);
    }
  };

  try {
    tryCreate();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const holder = readRunnerLock(lockPath);
    if (!isStale(holder)) throw new RunnerLockedError(lockPath, holder);
    // Reclaim a lock left by a dead or unreadable runner. If another process wins the
    // race here, the create below fails and that runner is reported instead.
    try {
      fs.unlinkSync(lockPath);
    } catch (unlinkError) {
      if (unlinkError.code !== 'ENOENT') throw unlinkError;
    }
    try {
      tryCreate();
    } catch (retryError) {
      if (retryError.code === 'EEXIST') {
        throw new RunnerLockedError(lockPath, readRunnerLock(lockPath));
      }
      throw retryError;
    }
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const holder = readRunnerLock(lockPath);
    if (holder && holder.pid === pid) {
      try {
        fs.unlinkSync(lockPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  };

  return { path: lockPath, pid, startedAt: now, release };
}

/**
 * Refuses to continue unless the process runs from the expected directory.
 * Orchestration scripts resolve paths from the repository root, so a different
 * cwd silently changes what they read and write.
 *
 * Paths are canonicalized through the filesystem first: on macOS `/tmp` is a
 * symlink to `/private/tmp`, so a plain string compare rejects a correct cwd.
 */
function canonicalDirectory(directory) {
  const resolved = path.resolve(directory);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function assertWorkingDirectory(expectedDirectory, actualDirectory = process.cwd()) {
  const expected = canonicalDirectory(expectedDirectory);
  const actual = canonicalDirectory(actualDirectory);
  if (expected !== actual) {
    const error = new Error(`Refusing to run outside ${expected} (cwd is ${actual})`);
    error.code = 'RUNNER_WRONG_CWD';
    throw error;
  }
  return actual;
}

module.exports = {
  acquireRunnerLock,
  assertWorkingDirectory,
  readRunnerLock,
  isProcessAlive,
  RunnerLockedError,
  RunnerLockPathError
};
