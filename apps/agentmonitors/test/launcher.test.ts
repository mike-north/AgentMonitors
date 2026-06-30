import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** Path to the launcher bin in this package. */
const LAUNCHER_BIN = path.join(__dirname, '..', 'bin', 'agentmonitors.cjs');

/** Version declared in @agentmonitors/cli's package.json — the expected --version output. */
const cliPkgJson = require(
  require.resolve('@agentmonitors/cli/package.json'),
) as { version: string };
const CLI_VERSION: string = cliPkgJson.version;

describe('agentmonitors umbrella launcher', () => {
  it('runs the CLI and prints its version on --version', () => {
    const result = spawnSync(process.execPath, [LAUNCHER_BIN, '--version'], {
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(CLI_VERSION);
  });

  it('exits non-zero for an unknown subcommand', () => {
    const result = spawnSync(
      process.execPath,
      [LAUNCHER_BIN, '__no_such_command__'],
      {
        encoding: 'utf8',
        timeout: 15_000,
      },
    );

    expect(result.status).not.toBe(0);
  });
});
