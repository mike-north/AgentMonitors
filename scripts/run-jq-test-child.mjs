/**
 * Run a Vitest child inside an outermost owner's process-group boundary.
 * Nested helpers inherit that boundary so killing a timeout owner cannot leave
 * its separately detached descendants alive. Only the outermost owner signals
 * the group; a nested helper must never signal its own ancestor's group.
 * Node 24 also supports spawnSync with detached private groups at runtime;
 * its synchronous typings omit that option. Async spawn is used here for
 * streaming output and observing exit so surviving workers can be killed
 * before their inherited pipes prevent closure.
 * One total deadline covers execution, pipe closure and group confirmation;
 * expiry returns an error even if a kill request never produces child exit.
 * Facility controls run jq directly, never detached command-poll observations.
 */
import { spawn } from 'node:child_process';
import { setTimeout, clearTimeout } from 'node:timers';
import { waitForOwnedGroupTermination } from './owned-test-group.mjs';

// Private to these test drivers and propagated only to their owned children.
// The marker grants no independent cleanup ownership to a nested helper.
const OWNER_BOUNDARY = 'AGENTMONITORS_JQ_TEST_OWNER_BOUNDARY';

/**
 * @param {readonly string[]} args - Node arguments selecting only the intended child suite.
 * @param {{cwd: string, env: NodeJS.ProcessEnv, timeout: number}} options - Isolated host context and child bound.
 * @returns {Promise<{status: number | null, stdout: string, stderr: string, error: Error | undefined}>} Captured child evidence; error-free outermost return confirms the known owned group is terminal.
 * @internal
 */
export async function runJqTestChild(args, options) {
  // Ownership belongs to this helper process, even if the caller supplies a
  // minimal environment for its next child. Child env cannot revoke the owner.
  const inheritedBoundary = process.env[OWNER_BOUNDARY] === '1';
  const ownsGroup = process.platform !== 'win32' && !inheritedBoundary;
  const deadline = Date.now() + options.timeout;
  // Reserve cleanup time inside, never after, the existing total bound.
  const reserve = ownsGroup
    ? Math.min(1_000, Math.floor(options.timeout / 4))
    : 0;
  let cleanup = Promise.resolve();
  const child = spawn(process.execPath, args, {
    ...options,
    env: {
      ...options.env,
      ...(process.platform !== 'win32' ? { [OWNER_BOUNDARY]: '1' } : {}),
    },
    timeout: Math.max(1, options.timeout - reserve),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: ownsGroup,
    killSignal: 'SIGKILL',
  });
  let stdout = '';
  let stderr = '';
  /** @type {Error | undefined} */
  let error;
  // Late process events remain handled but cannot change the returned verdict.
  let finished = false;
  child.stdout?.on('data', (data) => {
    stdout += data.toString();
  });
  child.stderr?.on('data', (data) => {
    stderr += data.toString();
  });
  child.on('error', (cause) => {
    if (!finished) error ??= cause;
  });
  /**
   * Cleanup failure is not a termination claim. Release held readers so a
   * visible error result does not depend on the failed group's pipe closure.
   * @param {unknown} cause
   */
  function failCleanup(cause) {
    if (finished) return;
    error ??= cause instanceof Error ? cause : new Error(String(cause));
    child.stdout?.destroy();
    child.stderr?.destroy();
  }

  // Kill surviving workers on exit, before waiting for pipe closure: workers
  // can inherit those pipes and otherwise keep a timed-out parent unresolved.
  child.on('exit', () => {
    if (finished) return;
    if (inheritedBoundary) {
      // Descendants may retain these pipes. Release nested readers on direct
      // child exit so the owner can complete and terminate the shared subtree.
      // Remaining descendant output is not evidence from this direct child.
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    if (child.pid && ownsGroup) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (cause) {
        if (
          !(cause instanceof Error && 'code' in cause && cause.code === 'ESRCH')
        ) {
          failCleanup(cause);
          return;
        }
      }
      // Even ESRCH must be accepted within the confirmation deadline.
      cleanup = waitForOwnedGroupTermination(child.pid, deadline).catch(
        failCleanup,
      );
    }
  });
  /** @type {Promise<number | null>} */
  const completion = new Promise((resolve) => child.on('close', resolve));
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {Promise<number | null>} */
  const expiry = new Promise((resolve) => {
    timer = setTimeout(
      () => {
        failCleanup(new Error('Owned child confirmation deadline expired'));
        // Best effort only: successful signal requests are not terminal evidence.
        // Nested helpers can signal their direct child, never the ancestor group.
        try {
          if (ownsGroup && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch (cause) {
          failCleanup(cause);
        }
        // A non-exiting process must not keep the driver's event loop referenced.
        // Keep error/exit listeners installed for eventual lifecycle events.
        child.unref();
        resolve(child.exitCode);
      },
      Math.max(0, deadline - Date.now()),
    );
  });
  const confirmed = (async () => {
    const status = await completion;
    await cleanup;
    if (!error && Date.now() >= deadline)
      failCleanup(new Error('Owned child confirmation deadline expired'));
    return status;
  })();
  try {
    const status = await Promise.race([confirmed, expiry]);
    return { status, stdout, stderr, error };
  } finally {
    finished = true;
    clearTimeout(timer);
  }
}
