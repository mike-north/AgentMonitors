/**
 * Test-only terminal-state confirmation for a known, exclusively owned group.
 * This is not an arbitrary descendant supervisor: detached production source
 * scopes are outside this boundary and must not be started by facility controls.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { setTimeout, clearTimeout } from 'node:timers';

/** @param {unknown} error @param {string} code @returns {boolean} @internal */
function hasCode(error, code) {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** @param {number} group @returns {Error} */
function expired(group) {
  return new Error(`Owned group ${group} not terminated within deadline`);
}

/** @param {number} group @param {number} deadline @param {AbortSignal} signal */
function checkBudget(group, deadline, signal) {
  if (signal.aborted || Date.now() >= deadline) throw expired(group);
}

/**
 * The Darwin membership query owns a direct child outside the group it inspects.
 * Retain that handle so a deadline verdict also releases the driver's readers/ref,
 * even when cancellation cannot make the query exit. This proves no termination.
 * @param {number} group
 * @param {number} deadline
 * @param {AbortSignal} signal
 * @returns {Promise<string>}
 */
async function darwinGroupState(group, deadline, signal) {
  checkBudget(group, deadline, signal);
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  /** @type {(() => void) | undefined} */
  let onAbort;
  /** Release only this query's owned handles; late callback/error events stay handled. */
  function release() {
    if (!child) return;
    try {
      child.kill('SIGKILL');
    } catch {
      /* Preserve the original query failure. */
    }
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  }
  try {
    return await new Promise((resolve, reject) => {
      child = execFile(
        '/bin/ps',
        ['-axo', 'pid=,pgid=,stat='],
        {
          encoding: 'utf8',
          timeout: Math.max(1, deadline - Date.now()),
          killSignal: 'SIGKILL',
          signal,
        },
        (error, stdout, stderr) => {
          if (error) reject(Object.assign(error, { stdout, stderr }));
          else resolve(stdout);
        },
      );
      onAbort = () => {
        release();
        reject(expired(group));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  } catch (error) {
    release();
    throw error;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** @param {number} group @param {number} deadline @param {AbortSignal} signal @returns {Promise<boolean>} */
async function terminated(group, deadline, signal) {
  checkBudget(group, deadline, signal);
  if (platform() === 'darwin') {
    // Use OS membership/state instead of unreliable Darwin group-zero probes.
    const stdout = await darwinGroupState(group, deadline, signal);
    checkBudget(group, deadline, signal);
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      checkBudget(group, deadline, signal);
      const fields = line.trim().split(/\s+/);
      if (fields.length !== 3)
        throw new Error('Unreadable owned-group process state');
      if (Number(fields[1]) === group && !/^[ZXx]/.test(fields[2]))
        return false;
    }
    checkBudget(group, deadline, signal);
    return true;
  }
  try {
    process.kill(-group, 0);
  } catch (error) {
    checkBudget(group, deadline, signal);
    if (hasCode(error, 'ESRCH')) return true;
    throw error;
  }
  checkBudget(group, deadline, signal);
  if (platform() !== 'linux') return false;
  let members = 0;
  const entries = await readdir('/proc');
  checkBudget(group, deadline, signal);
  for (const pid of entries) {
    checkBudget(group, deadline, signal);
    if (!/^\d+$/.test(pid)) continue;
    let stat;
    try {
      stat = await readFile(`/proc/${pid}/stat`, { encoding: 'utf8', signal });
    } catch (error) {
      checkBudget(group, deadline, signal);
      if (hasCode(error, 'ENOENT') || hasCode(error, 'ESRCH')) continue;
      throw error;
    }
    checkBudget(group, deadline, signal);
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    if (fields.length < 3)
      throw new Error(`Unreadable process group state for ${pid}`);
    if (Number(fields[2]) !== group) continue;
    members++;
    if (!['Z', 'X', 'x'].includes(fields[0])) return false;
  }
  checkBudget(group, deadline, signal);
  if (members > 0) return true;
  // A disappearing proc entry is not proof that an existing group is dead.
  try {
    process.kill(-group, 0);
  } catch (error) {
    checkBudget(group, deadline, signal);
    if (hasCode(error, 'ESRCH')) return true;
    throw error;
  }
  checkBudget(group, deadline, signal);
  return false;
}

/**
 * @param {number} group - Group created by this helper's detached direct child.
 * @param {number} deadline - Absolute deadline within the caller's existing bound.
 * @returns {Promise<void>} Resolves only after timely terminal evidence; errors are never success.
 * @internal
 */
export async function waitForOwnedGroupTermination(group, deadline) {
  const controller = new globalThis.AbortController();
  checkBudget(group, deadline, controller.signal);
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(expired(group));
    }, deadline - Date.now());
  });
  // The race bounds the verdict even when an OS query cannot finish promptly.
  // Abort supported operations, but do not claim arbitrary kernel I/O was
  // synchronously interrupted. Every continuation checks budget before more work.
  const query = (async () => {
    while (true) {
      checkBudget(group, deadline, controller.signal);
      const done = await terminated(group, deadline, controller.signal);
      checkBudget(group, deadline, controller.signal);
      if (done) return;
      await delay(Math.min(10, deadline - Date.now()), undefined, {
        signal: controller.signal,
      });
    }
  })();
  try {
    await Promise.race([query, timeout]);
    checkBudget(group, deadline, controller.signal);
  } catch (error) {
    if (controller.signal.aborted || Date.now() >= deadline)
      throw expired(group);
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
