/** Test-only Docker lifecycle and failure diagnostics. */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const repoRoot = path.resolve(import.meta.dirname, '../../../../..');
/**
 * How long the container may run before we force-remove it. Comfortably
 * under the test's own 300s budget so a genuine timeout reports as this
 * test failing with a clear message, not as the whole CI job silently
 * running out its 30-minute budget.
 */
const CONTAINER_DEADLINE_MS = 240_000;

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
      timeout: 10_000,
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

    // Deadline path (also used for runaway output). `docker rm -f` alone is
    // NOT sufficient (review round 3): if the deadline fires while the client
    // is still pulling the image or waiting on the daemon — before the
    // container exists — removal no-ops with "No such container", the client
    // stays blocked, and the container can even be created afterwards. So we
    // also SIGKILL the client itself (guaranteeing `close` fires), and the
    // close handler retries removal to catch a container that appears after
    // this first attempt.
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
            'tail -n 200 /tmp/logs/*.log /tmp/daemon.log 2>/dev/null',
          ],
          {
            encoding: 'utf8',
            timeout: 5000,
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
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise((r) => setTimeout(r, 1_500));
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
