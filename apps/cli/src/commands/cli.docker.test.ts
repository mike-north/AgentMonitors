import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { packageUpSync } from 'pkg-up';
import { describe, expect, it } from 'vitest';

function hasDocker(): boolean {
  try {
    execFileSync('docker', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = hasDocker();
const cliPackageJson = packageUpSync({ cwd: __dirname });

if (!cliPackageJson) {
  throw new Error('Could not locate package.json for the CLI package.');
}

const repoRoot = path.resolve(path.dirname(cliPackageJson), '../..');
const dockerScriptPath = path.join(
  __dirname,
  'fixtures',
  'cli-docker-smoke.sh',
);

describe.skipIf(!dockerAvailable)('Docker runtime smoke', () => {
  it('installs real Claude Code in a clean home directory and exercises AgentMon end-to-end', () => {
    const script = readFileSync(dockerScriptPath, 'utf-8');

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
      },
    ) as string;

    expect(output).toContain('CLAUDE_VERSION=');
    expect(output).toContain('STATUS_RUNNING=true');
    expect(output).toContain('EVENT_COUNT=1');
    expect(output).toContain('CLAIM_URGENCY=normal');
  }, 300_000);
});
