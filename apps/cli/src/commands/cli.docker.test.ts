import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  runSmokeContainer,
  reportContainerFailure,
} from './fixtures/smoke-container.js';

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
