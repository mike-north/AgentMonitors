/**
 * Run an owned Vitest child with a deadline and cleanup of its worker group.
 * Node 24 also supports spawnSync with detached private groups at runtime;
 * its synchronous typings omit that option. Async spawn is used here for
 * streaming output and observing exit so surviving workers can be killed
 * before their inherited pipes prevent closure.
 * The caller's deadline must exceed this child's bound so cleanup can finish.
 */
import { spawn } from 'node:child_process';

/**
 * @param {readonly string[]} args - Node arguments selecting only the intended child suite.
 * @param {{cwd: string, env: NodeJS.ProcessEnv, timeout: number}} options - Isolated host context and child bound.
 * @returns {Promise<{status: number | null, stdout: string, stderr: string, error: Error | undefined}>} Captured evidence, after child/workers have exited.
 * @internal
 */
export async function runJqTestChild(args, options) {
  const child = spawn(process.execPath, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    killSignal: 'SIGKILL',
  });
  let stdout = '';
  let stderr = '';
  /** @type {Error | undefined} */
  let error;
  child.stdout?.on('data', (data) => {
    stdout += data.toString();
  });
  child.stderr?.on('data', (data) => {
    stderr += data.toString();
  });
  child.on('error', (cause) => {
    error = cause;
  });
  // Kill surviving workers on exit, before waiting for pipe closure: workers
  // can inherit those pipes and otherwise keep a timed-out parent unresolved.
  child.on('exit', () => {
    if (child.pid && process.platform !== 'win32') {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (cause) {
        if (
          !(cause instanceof Error && 'code' in cause && cause.code === 'ESRCH')
        ) {
          error = cause instanceof Error ? cause : new Error(String(cause));
        }
      }
    }
  });
  /** @type {Promise<number | null>} */
  const completion = new Promise((resolve) => child.on('close', resolve));
  const status = await completion;
  return { status, stdout, stderr, error };
}
