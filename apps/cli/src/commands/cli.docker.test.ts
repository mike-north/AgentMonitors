import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The shape Node attaches to the `Error` thrown by a failing
 * `execFileSync`/`spawnSync` call (see `child_process.SpawnSyncReturns`).
 * There is no exported class for this — Node merges these fields onto a
 * plain `Error` — so this is a structural type, not a class to `instanceof`.
 */
interface ExecFileSyncFailure {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

function isExecFileSyncFailure(
  error: unknown,
): error is Error & ExecFileSyncFailure {
  return (
    error instanceof Error &&
    'status' in error &&
    'signal' in error &&
    ('stdout' in error || 'stderr' in error)
  );
}

function toDisplayString(value: string | Buffer | undefined): string {
  if (value === undefined) return '(none captured)';
  return typeof value === 'string' ? value : value.toString('utf-8');
}

/**
 * Issue #509: a bare rethrow here surfaced in CI as nothing more than
 * "Command failed: docker run ...", with no way to root-cause a failure
 * without re-running. The container's own stdout/stderr — including
 * whatever `cli-docker-smoke.sh`'s own failure diagnostics (phase name,
 * captured install/build log tail, daemon log tail) it managed to flush
 * before dying — is still captured on Node's `error.stdout`/`error.stderr`
 * even when the child is killed by the `timeout` option (verified: Node
 * populates both from whatever was buffered before the kill). Printing them
 * here, then rethrowing, makes every failure diagnosable from the CI log
 * alone.
 */
function reportDockerFailure(error: unknown): never {
  if (isExecFileSyncFailure(error)) {
    console.error(
      [
        '',
        '=== Docker runtime smoke test failed ===',
        `exit status: ${String(error.status)}, signal: ${String(error.signal)}`,
        '--- captured container stdout ---',
        toDisplayString(error.stdout),
        '--- captured container stderr ---',
        toDisplayString(error.stderr),
        '=== end captured output ===',
        '',
      ].join('\n'),
    );
  }
  throw error;
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
  it('installs real Claude Code in a clean home directory and exercises AgentMon end-to-end', () => {
    const script = readFileSync(dockerScriptPath, 'utf-8');

    // `timeout` is load-bearing, not decorative (PR #453 CI hang, issue #425
    // review): `execFileSync` blocks its vitest worker thread synchronously,
    // so vitest's own `testTimeout`/per-test timeout below can never interrupt
    // it — only Node killing the child itself can bound a stalled container.
    // Set comfortably under the test's own 300s budget so a genuine timeout
    // here reports as this test failing with a clear message, not as the
    // whole CI job silently running out its 30-minute budget.
    let output: string;
    try {
      output = execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${repoRoot}:/workspace:ro`,
          '-w',
          '/workspace',
          'node:24-bookworm',
          'bash',
          '-lc',
          script,
        ],
        {
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024 * 20,
          timeout: 240_000,
        },
      ) as string;
    } catch (error) {
      reportDockerFailure(error);
    }

    expect(output).toContain('CLAUDE_VERSION=');
    expect(output).toContain('STATUS_RUNNING=true');
    expect(output).toContain('EVENT_COUNT=1');
    expect(output).toContain('CLAIM_URGENCY=normal');
  }, 300_000);
});
