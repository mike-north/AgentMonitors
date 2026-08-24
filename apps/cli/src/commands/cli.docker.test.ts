import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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
    });
  } catch {
    // already gone (or the daemon is unresponsive) — nothing more we can do
  }
}

/**
 * Issue #509 (review round 2): the previous `execFileSync(..., { timeout })`
 * did NOT provide a hard bound. Node's timeout only SIGTERMs the `docker run`
 * *client*; the container keeps running, and if its PID 1 bash is blocked in
 * apt/npm/pnpm its TERM trap is deferred too — reproduced: after the client
 * timeout, the container stayed `Up` until an explicit `docker rm -f`. That
 * could still hang the serial CI job to its 30-minute limit and leak a
 * container. So the container gets a unique `--name`, runs via async `spawn`
 * (leaving the vitest worker free), and on deadline we BOTH force-remove the
 * container (kills PID 1 regardless of what it is blocked on) AND SIGKILL
 * the docker client (so `close` fires even when the deadline lands before
 * the container exists — mid image-pull — where removal alone no-ops), then
 * retry removal in case the container appears after the first attempt,
 * before dumping the captured output (including whatever failure
 * diagnostics `cli-docker-smoke.sh` flushed).
 */
function runSmokeContainer(script: string): Promise<ContainerResult> {
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
    let capturedBytes = 0;

    // Deadline path (also used for runaway output). `docker rm -f` alone is
    // NOT sufficient (review round 3): if the deadline fires while the client
    // is still pulling the image or waiting on the daemon — before the
    // container exists — removal no-ops with "No such container", the client
    // stays blocked, and the container can even be created afterwards. So we
    // also SIGKILL the client itself (guaranteeing `close` fires), and the
    // close handler retries removal to catch a container that appears after
    // this first attempt.
    const enforceDeadline = (): void => {
      timedOut = true;
      forceRemoveContainer(name);
      child.kill('SIGKILL');
    };

    const capture =
      (append: (text: string) => void) =>
      (chunk: Buffer): void => {
        capturedBytes += chunk.length;
        append(chunk.toString('utf-8'));
        if (capturedBytes > MAX_CAPTURED_OUTPUT_BYTES) {
          // Runaway output: treat like a deadline — bound it and let the
          // close handler report with what we captured.
          enforceDeadline();
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

    const timer = setTimeout(enforceDeadline, CONTAINER_DEADLINE_MS);

    /**
     * Final cleanup before resolving. On the deadline path the client was
     * SIGKILLed and may have died mid-creation — dockerd can still finish
     * creating and starting the container *after* the first removal attempt,
     * so retry removal a few times (bounded) before handing back the result.
     * The normal path stays fast: one best-effort removal (usually a no-op
     * thanks to `--rm`).
     */
    const cleanupThenResolve = (result: ContainerResult): void => {
      forceRemoveContainer(name);
      if (!result.timedOut) {
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
      cleanupThenResolve({ code, signal, stdout, stderr, timedOut });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      cleanupThenResolve({
        code: null,
        signal: null,
        stdout,
        stderr: `${stderr}\nfailed to spawn docker: ${String(error)}`,
        timedOut,
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
function reportContainerFailure(result: ContainerResult): never {
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
    result.timedOut
      ? `docker smoke container exceeded its ${String(CONTAINER_DEADLINE_MS / 1000)}s deadline and was force-removed; see captured output above`
      : `docker smoke container failed (exit code ${String(result.code)}, signal ${String(result.signal)}); see captured output above`,
  );
}

function hasDocker(): boolean {
  try {
    // `docker info` reaches the daemon, unlike `docker --version` which only
    // confirms the CLI is installed. This keeps the smoke test skipped (not
    // failed) when the CLI exists but the daemon is stopped.
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = hasDocker();
const repoRoot = path.resolve(__dirname, '../../../..');
const dockerScriptPath = path.join(
  __dirname,
  'fixtures',
  'cli-docker-smoke.sh',
);

describe.skipIf(!dockerAvailable)('Docker runtime smoke', () => {
  it('installs real Claude Code in a clean home directory and exercises AgentMon end-to-end', async () => {
    const script = readFileSync(dockerScriptPath, 'utf-8');

    const result = await runSmokeContainer(script);
    if (result.timedOut || result.code !== 0) {
      reportContainerFailure(result);
    }

    expect(result.stdout).toContain('CLAUDE_VERSION=');
    expect(result.stdout).toContain('STATUS_RUNNING=true');
    expect(result.stdout).toContain('EVENT_COUNT=1');
    expect(result.stdout).toContain('CLAIM_URGENCY=normal');
  }, 300_000);
});
