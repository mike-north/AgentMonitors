import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
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

/**
 * Run the launcher and return the result. The launcher spawns a real Node
 * subprocess that loads the full CLI (native modules, MCP SDK, …), so this is
 * a heavyweight smoke test. A generous timeout absorbs slow process startup
 * under parallel CI load.
 */
function runLauncher(args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [LAUNCHER_BIN, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

/**
 * A full dump of a spawn result, surfaced on assertion failure so an
 * intermittent CI failure reveals *why* the launcher misbehaved (a real error
 * in stderr, a timeout signal, …) rather than just "expected 1 to be 0".
 */
function diagnose(label: string, r: SpawnSyncReturns<string>): string {
  return [
    `${label}: status=${String(r.status)} signal=${String(r.signal)}`,
    r.error ? `spawn error: ${r.error.message}` : null,
    `stdout: ${JSON.stringify(r.stdout)}`,
    `stderr: ${JSON.stringify(r.stderr)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

describe('agentmonitors umbrella launcher', () => {
  it('runs the CLI and prints its version on --version', () => {
    const result = runLauncher(['--version']);

    expect(result.status, diagnose('--version exit', result)).toBe(0);
    expect(result.stdout.trim()).toBe(CLI_VERSION);
  });

  it('exits non-zero for an unknown subcommand', () => {
    const result = runLauncher(['__no_such_command__']);

    expect(result.status, diagnose('unknown-subcommand exit', result)).not.toBe(
      0,
    );
  });
});
