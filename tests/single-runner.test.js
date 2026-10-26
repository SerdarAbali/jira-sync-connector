'use strict';

/**
 * Local single-runner guard. These tests exercise the real filesystem in an
 * isolated temporary directory; the module never touches connector storage.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  acquireRunnerLock,
  assertWorkingDirectory,
  readRunnerLock,
  RunnerLockedError,
  RunnerLockPathError
} = require('../scripts/staging/lib/single-runner');

let workdir;

function lockPath(name = 'runner.lock') {
  return path.join(workdir, name);
}

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'single-runner-'));
});

afterEach(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe('acquireRunnerLock', () => {
  test('creates the lock and records pid and start time', () => {
    const lock = acquireRunnerLock(lockPath(), { label: 'rehearsal', now: 1000 });
    expect(fs.existsSync(lockPath())).toBe(true);
    const recorded = readRunnerLock(lockPath());
    expect(recorded).toMatchObject({ pid: process.pid, startedAt: 1000, label: 'rehearsal' });
    lock.release();
  });

  test('refuses a second runner while the first holds the lock', () => {
    const first = acquireRunnerLock(lockPath());
    let caught;
    try {
      acquireRunnerLock(lockPath());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RunnerLockedError);
    expect(caught.code).toBe('RUNNER_LOCKED');
    expect(caught.holder.pid).toBe(process.pid);
    first.release();
  });

  test('refuses a foreign live pid even when the lock looks old', () => {
    // The parent process is definitely alive and is not this runner.
    fs.writeFileSync(lockPath(), JSON.stringify({
      pid: process.ppid || 1,
      startedAt: 1,
      label: 'other-runner'
    }) + '\n');

    expect(() => acquireRunnerLock(lockPath(), { now: Date.now() })).toThrow(RunnerLockedError);
    expect(readRunnerLock(lockPath()).label).toBe('other-runner');
  });

  test('reclaims a lock left by a dead process', () => {
    fs.writeFileSync(lockPath(), JSON.stringify({
      pid: 999999,
      startedAt: Date.now() - 60 * 60 * 1000,
      label: 'crashed-runner'
    }) + '\n');

    const lock = acquireRunnerLock(lockPath(), { label: 'recovery-run' });
    expect(readRunnerLock(lockPath()).label).toBe('recovery-run');
    expect(readRunnerLock(lockPath()).pid).toBe(process.pid);
    lock.release();
  });

  test('a live holder is never reclaimed no matter how old the record is', () => {
    fs.writeFileSync(lockPath(), JSON.stringify({
      pid: process.ppid || 1,
      startedAt: 1,
      label: 'slow-runner'
    }) + '\n');

    expect(() => acquireRunnerLock(lockPath(), { now: Date.now() })).toThrow(RunnerLockedError);
    expect(readRunnerLock(lockPath()).label).toBe('slow-runner');
  });

  test('reclaims an unreadable lock file rather than blocking forever', () => {
    fs.writeFileSync(lockPath(), 'not json at all');
    const lock = acquireRunnerLock(lockPath(), { label: 'recovered' });
    expect(readRunnerLock(lockPath()).label).toBe('recovered');
    lock.release();
  });

  test('rejects a relative lock path', () => {
    expect(() => acquireRunnerLock('runner.lock')).toThrow(RunnerLockPathError);
    try {
      acquireRunnerLock('runner.lock');
    } catch (error) {
      expect(error.code).toBe('RUNNER_LOCK_PATH_NOT_ABSOLUTE');
    }
  });

  test('release removes the file and is idempotent', () => {
    const lock = acquireRunnerLock(lockPath());
    lock.release();
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(() => lock.release()).not.toThrow();
  });

  test('release does not delete a lock that another runner now owns', () => {
    const lock = acquireRunnerLock(lockPath());
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: process.ppid || 1, startedAt: Date.now() }) + '\n');

    lock.release();
    expect(fs.existsSync(lockPath())).toBe(true);
    expect(readRunnerLock(lockPath()).pid).toBe(process.ppid || 1);
  });

  test('a released lock can be taken again immediately', () => {
    const first = acquireRunnerLock(lockPath());
    first.release();
    const second = acquireRunnerLock(lockPath());
    expect(readRunnerLock(lockPath()).pid).toBe(process.pid);
    second.release();
  });
});

describe('assertWorkingDirectory', () => {
  test('accepts the expected directory', () => {
    expect(assertWorkingDirectory(workdir, workdir)).toBe(path.resolve(workdir));
  });

  test('refuses a different directory', () => {
    expect(() => assertWorkingDirectory(workdir, os.tmpdir())).toThrow(/Refusing to run outside/);
    try {
      assertWorkingDirectory(workdir, os.tmpdir());
    } catch (error) {
      expect(error.code).toBe('RUNNER_WRONG_CWD');
    }
  });
});
