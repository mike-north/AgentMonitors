/**
 * Test-only terminal-state confirmation for a known, exclusively owned group.
 * This is not an arbitrary descendant supervisor: detached production source
 * scopes are outside this boundary and must not be started by facility controls.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

/** @param {unknown} error @param {string} code @returns {boolean} @internal */
function hasCode(error, code) {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** @param {number} group @param {number} deadline @returns {Promise<boolean>} */
async function terminated(group, deadline) {
  if (platform() === 'darwin') {
    // Darwin group-zero probes can return EPERM after orphan cleanup. Query
    // kernel membership/state instead; use the OS path, never the test PATH.
    const { stdout } = await promisify(execFile)(
      '/bin/ps',
      ['-axo', 'pid=,pgid=,stat='],
      {
        encoding: 'utf8',
        timeout: Math.max(1, deadline - Date.now()),
        killSignal: 'SIGKILL',
      },
    );
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .every((line) => {
        const fields = line.trim().split(/\s+/);
        if (fields.length !== 3)
          throw new Error('Unreadable owned-group process state');
        return Number(fields[1]) !== group || /^[ZXx]/.test(fields[2]);
      });
  }
  try {
    process.kill(-group, 0);
  } catch (error) {
    if (hasCode(error, 'ESRCH')) return true;
    throw error;
  }
  if (platform() !== 'linux') return false;
  // Linux can retain dead group members under a non-reaping PID1. Read
  // kernel group membership and state, never equate kill-zero with running.
  let members = 0;
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    let stat;
    try {
      stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    } catch (error) {
      if (hasCode(error, 'ENOENT') || hasCode(error, 'ESRCH')) continue;
      throw error;
    }
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
  if (members > 0) return true;
  // A disappearing proc entry is not proof that an existing group is dead.
  try {
    process.kill(-group, 0);
    return false;
  } catch (error) {
    if (hasCode(error, 'ESRCH')) return true;
    throw error;
  }
}

/**
 * @param {number} group - Group created by this helper's detached direct child.
 * @param {number} deadline - Absolute deadline within the caller's existing bound.
 * @returns {Promise<void>} Resolves only after terminal evidence; errors are never success.
 * @internal
 */
export async function waitForOwnedGroupTermination(group, deadline) {
  while (!(await terminated(group, deadline))) {
    if (Date.now() >= deadline)
      throw new Error(`Owned group ${group} not terminated within deadline`);
    await delay(Math.min(10, Math.max(1, deadline - Date.now())));
  }
}
