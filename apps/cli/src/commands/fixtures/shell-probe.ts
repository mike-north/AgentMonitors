/** Test-only synchronous Bash probes; each child owns a fresh POSIX process group. */
import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';

/** Probe-local environment and accelerated lifecycle-test deadlines. @internal */
export interface ShellProbeOptions {
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}

/** Stop this newly created group; only an already-absent group is harmless. */
function terminateOwnedGroup(group: number): void {
  try {
    process.kill(-group, 'SIGKILL');
  } catch (error) {
    if (
      !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
    ) {
      throw error;
    }
  }
}

/** Execute shell evidence without changing its status, signal or diagnostics. @internal */
export function runShellProbe(script: string, options: ShellProbeOptions = {}) {
  let result: SpawnSyncReturns<string> | undefined;
  try {
    // Node forwards detached through the synchronous spawn implementation, but
    // its synchronous option typings omit it. Keep the required ownership bit
    // explicit; real lifecycle tests verify Bash PID === process-group ID.
    const spawnOptions: SpawnSyncOptionsWithStringEncoding & {
      detached: true;
    } = {
      encoding: 'utf8',
      detached: true,
      timeout: options.timeout ?? 3000,
      killSignal: 'SIGKILL',
      env: { ...process.env, ...options.env },
    };
    result = spawnSync('bash', ['-c', script], spawnOptions);
    return result;
  } finally {
    // detached:true gives this Bash child a new session/group whose ID is its
    // PID. spawnSync reaps Bash, but its timeout only kills that direct child;
    // sampler/foreground descendants may still run after any kind of return.
    // Signal only this just-created owned group, never the caller's group.
    const group = result?.pid;
    if (group !== undefined && group > 1) {
      terminateOwnedGroup(group);
    }
  }
}
