/** Test-only Docker lifecycle and failure diagnostics. */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const repoRoot = path.resolve(import.meta.dirname, '../../../../..');
/** Caller budget stays fixed; all run/cleanup work must leave time to report. @internal */
export const SMOKE_TEST_TIMEOUT_MS = 300_000;
/** Reserved for client-close delivery, formatting/reporting and ordinary scheduling. */
const REPORTING_RESERVE_MS = 30_000;
/** Each diagnostic/cleanup client is independently SIGKILL-bounded. */
const LOG_RETRIEVAL_TIMEOUT_MS = 5_000;
const REMOVE_TIMEOUT_MS = 10_000;
/** Late container creation gets all three delayed cleanup attempts. */
const LATE_REMOVE_ATTEMPTS = 3;
const LATE_REMOVE_DELAY_MS = 1_500;
/**
 * Worst logical cleanup: retrieval + initial/close removal + delayed retries.
 * 5s + 2*10s + 3*(1.5s + 10s) = 59.5s. Deduct this AND a 30s reporting
 * reserve from the unchanged 300s caller timeout: container execution gets
 * 210.5s, and failure reporting begins by logical t=270s in the bounded model.
 * This allocation does not protect against arbitrary CPU starvation, delayed
 * OS process reaping, or Docker server work continuing beyond client lifetime.
 */
const CLEANUP_BUDGET_MS =
  LOG_RETRIEVAL_TIMEOUT_MS +
  2 * REMOVE_TIMEOUT_MS +
  LATE_REMOVE_ATTEMPTS * (LATE_REMOVE_DELAY_MS + REMOVE_TIMEOUT_MS);
const CONTAINER_DEADLINE_MS =
  SMOKE_TEST_TIMEOUT_MS - REPORTING_RESERVE_MS - CLEANUP_BUDGET_MS;

/** Cap on captured container output, mirroring the old `maxBuffer`. */
const MAX_CAPTURED_OUTPUT_BYTES = 20 * 1024 * 1024;

interface ContainerResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  terminationReason: 'deadline' | 'output-limit' | undefined;
}

/**
 * Kill and remove the container by name. Best-effort by design: after a
 * normal exit `--rm` has already removed it and this errors harmlessly.
 * Bounded with its own timeout so a wedged docker daemon cannot turn
 * cleanup itself into the hang it exists to prevent.
 */
function forceRemoveContainer(name: string): void {
  try {
    execFileSync('docker', ['rm', '-f', name], {
      stdio: 'ignore',
      timeout: REMOVE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
  } catch {
    // already gone (or the daemon is unresponsive) — nothing more we can do
  }
}

/**
 * Run a uniquely named container with bounded output and cleanup. Termination
 * preserves diagnostic logs before killing the client and removing the container;
 * repeated removal catches creation racing the first cleanup attempt.
 * @internal
 */
export function runSmokeContainer(script: string): Promise<ContainerResult> {
  const name = `am-docker-smoke-${String(process.pid)}-${randomUUID().slice(0, 8)}`;
  return new Promise((resolve) => {
    const child = spawn(
      'docker',
      [
        'run',
        '--rm',
        '--name',
        name,
        '-v',
        `${repoRoot}:/workspace:ro`,
        '-w',
        '/workspace',
        'node:24-bookworm',
        'bash',
        '-lc',
        script,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let terminationReason: 'deadline' | 'output-limit' | undefined;
    let settled = false;
    let capturedBytes = 0;

    // Kill the owned client even before container creation, then remove by its
    // unique name. Closing the client triggers delayed removal attempts for
    // server-side creation racing the first removal. Retrieval precedes removal
    // so streamed/retained diagnostics survive a force-killed container.
    const enforceDeadline = (
      reason: 'deadline' | 'output-limit' = 'deadline',
    ): void => {
      if (terminationReason) return;
      terminationReason = reason;
      timedOut = reason === 'deadline';
      // Retrieve logs before removal; SIGKILL bounds an unresponsive client.
      try {
        stderr += execFileSync(
          'docker',
          [
            'exec',
            name,
            'bash',
            '-c',
            'for log in /tmp/logs/*.log /tmp/daemon.log; do echo "--- $log ---"; tail -c 8192 "$log" 2>/dev/null; done',
          ],
          {
            encoding: 'utf8',
            timeout: LOG_RETRIEVAL_TIMEOUT_MS,
            killSignal: 'SIGKILL',
            maxBuffer: MAX_CAPTURED_OUTPUT_BYTES,
          },
        );
      } catch {
        /* Streamed phase output remains available if retrieval fails. */
      }
      forceRemoveContainer(name);
      child.kill('SIGKILL');
    };

    const capture =
      (append: (text: string) => void) =>
      (chunk: Buffer): void => {
        capturedBytes += chunk.length;
        if (!terminationReason)
          append(
            chunk
              .subarray(
                0,
                Math.max(
                  0,
                  MAX_CAPTURED_OUTPUT_BYTES - (capturedBytes - chunk.length),
                ),
              )
              .toString('utf-8'),
          );
        if (capturedBytes > MAX_CAPTURED_OUTPUT_BYTES) {
          // Runaway output: treat like a deadline — bound it and let the
          // close handler report with what we captured.
          enforceDeadline('output-limit');
        }
      };
    child.stdout.on(
      'data',
      capture((text) => (stdout += text)),
    );
    child.stderr.on(
      'data',
      capture((text) => (stderr += text)),
    );

    const timer = setTimeout(() => {
      enforceDeadline();
    }, CONTAINER_DEADLINE_MS);

    /**
     * Final cleanup before resolving. On the deadline path the client was
     * SIGKILLed and may have died mid-creation — dockerd can still finish
     * creating and starting the container *after* the first removal attempt,
     * so retry removal a few times (bounded) before handing back the result.
     * The normal path stays fast: one best-effort removal (usually a no-op
     * thanks to `--rm`).
     */
    const cleanupThenResolve = (result: ContainerResult): void => {
      if (settled) return;
      settled = true;
      forceRemoveContainer(name);
      if (!terminationReason) {
        resolve(result);
        return;
      }
      void (async (): Promise<void> => {
        for (let attempt = 0; attempt < LATE_REMOVE_ATTEMPTS; attempt++) {
          await new Promise((r) => setTimeout(r, LATE_REMOVE_DELAY_MS));
          forceRemoveContainer(name);
        }
        resolve(result);
      })();
    };

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      cleanupThenResolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        terminationReason,
      });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      cleanupThenResolve({
        code: null,
        signal: null,
        stdout,
        stderr: `${stderr}\nfailed to spawn docker: ${String(error)}`,
        timedOut,
        terminationReason,
      });
    });
  });
}

/**
 * Issue #509: a bare failure here used to surface in CI as nothing more
 * than "Command failed: docker run ...". Dumping the captured container
 * output — which now includes `cli-docker-smoke.sh`'s own phase-labeled
 * failure diagnostics — makes every failure diagnosable from the CI log
 * alone.
 */
export function reportContainerFailure(result: ContainerResult): never {
  console.error(
    [
      '',
      '=== Docker runtime smoke test failed ===',
      `exit code: ${String(result.code)}, signal: ${String(result.signal)}, deadline hit: ${String(result.timedOut)}`,
      '--- captured container stdout ---',
      result.stdout || '(none captured)',
      '--- captured container stderr ---',
      result.stderr || '(none captured)',
      '=== end captured output ===',
      '',
    ].join('\n'),
  );
  throw new Error(
    result.terminationReason === 'output-limit'
      ? 'docker smoke container exceeded its captured output limit; see captured output above'
      : result.timedOut
        ? `docker smoke container exceeded its ${String(CONTAINER_DEADLINE_MS / 1000)}s deadline and was force-removed; see captured output above`
        : `docker smoke container failed (exit code ${String(result.code)}, signal ${String(result.signal)}); see captured output above`,
  );
}

/** Reject unusable results before the caller checks its success markers. @internal */
export function assertSmokeContainerSuccess(result: ContainerResult): void {
  if (
    result.terminationReason !== undefined ||
    result.timedOut ||
    result.code !== 0
  ) {
    reportContainerFailure(result);
  }
}
