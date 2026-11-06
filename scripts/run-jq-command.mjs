/**
 * Execute only the facility's real jq command, with a nonblocking total verdict.
 * jq is an owned direct executable, not a source observation or descendant scope.
 * Even discovery-time probes must fail without waiting for a failed kill request
 * to produce exit. Handle release on failure is not a termination claim.
 */
import { execFile } from 'node:child_process';
import { setTimeout, clearTimeout } from 'node:timers';

// Preserve the existing per-command jq budget for both probes and reductions.
const JQ_COMMAND_TIMEOUT = 1_000;

/**
 * @param {readonly string[]} args - jq's real argv, including the canonical program.
 * @param {string} [input] - Authored raw fixture input; never interpreted by a shell.
 * @returns {Promise<{stdout: string, stderr: string}>} Successful jq output; failures remain visible.
 * @internal
 */
export function runJqCommand(args, input = '') {
  const deadline = Date.now() + JQ_COMMAND_TIMEOUT;
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const child = execFile(
      'jq',
      [...args],
      { encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (settled) return;
        if (Date.now() >= deadline) {
          fail(new Error('jq command deadline expired (1000ms)'));
        } else if (error) {
          fail(Object.assign(error, { stdout, stderr }));
        } else {
          settled = true;
          clearTimeout(timer);
          resolve({ stdout, stderr });
        }
      },
    );
    /**
     * Settle failure independently of process close. Only this exact jq child is
     * signaled; keep execFile's error/close listeners for any eventual callback.
     * @param {Error} error
     */
    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* The failure verdict is already definitive. */
      }
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      reject(error);
    }
    timer = setTimeout(
      () => fail(new Error('jq command deadline expired (1000ms)')),
      Math.max(0, deadline - Date.now()),
    );
    // A failed executable or early exit can close stdin before fixture input is
    // written. Report it as command failure rather than an unhandled pipe error.
    child.stdin?.on('error', fail);
    child.stdin?.end(input);
  });
}

/**
 * @returns {Promise<boolean>} Only genuine executable absence permits optional local omission.
 * @internal
 */
export async function jqAvailable() {
  try {
    await runJqCommand(['--version']);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}
