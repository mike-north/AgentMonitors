import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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
    const output = execFileSync(
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

    expect(output).toContain('CLAUDE_VERSION=');
    expect(output).toContain('STATUS_RUNNING=true');
    expect(output).toContain('EVENT_COUNT=1');
    expect(output).toContain('CLAIM_URGENCY=normal');
  }, 300_000);
});
