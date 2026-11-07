/**
 * Smoke tests for the unscoped launcher, driven through a real Node subprocess.
 * They run on the first attempt only: `nx run-many` runs them beside other
 * suites, so a failure here is evidence about the gate or the build, not noise
 * to re-roll (docs/specs/004-validation-testing.md section 2.9).
 *
 * @see https://vitest.dev/config/#testtimeout
 * @see https://github.com/tj/commander.js#parse-and-parseasync
 */
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

/** A subcommand name the CLI will never define. */
const UNKNOWN_COMMAND = '__no_such_command__';

/**
 * Upper bound for one subprocess. It must stay below the test's own budget:
 * `spawnSync` blocks vitest's timer, and vitest then fails an overrunning test
 * as "timed out" even if the child succeeded, without running the assertions
 * that carry `diagnose`. Killing the child first keeps its evidence.
 */
const SPAWN_TIMEOUT_MS = 4_500;

/** Run Node with the given arguments, killing it once `timeout` elapses. */
function runNode(
  args: string[],
  timeout = SPAWN_TIMEOUT_MS,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, args, { encoding: 'utf8', timeout });
}

/** Run the launcher the way an installed `agentmonitors` binary starts. */
function runLauncher(args: string[]): SpawnSyncReturns<string> {
  return runNode([LAUNCHER_BIN, ...args]);
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

/**
 * Assert the loaded CLI rejected the subcommand. A non-zero status alone is not
 * enough: a launcher that cannot load the CLI also exits 1.
 */
function expectUnknownCommandRejected(r: SpawnSyncReturns<string>): void {
  const evidence = diagnose('unknown-subcommand exit', r);
  expect(r.status, evidence).toBe(1);
  expect(r.stderr, evidence).toContain(`unknown command '${UNKNOWN_COMMAND}'`);
}

describe('agentmonitors umbrella launcher', () => {
  it('runs the CLI and prints its version on --version', () => {
    const result = runLauncher(['--version']);
    const evidence = diagnose('--version exit', result);

    expect(result.status, evidence).toBe(0);
    expect(result.stdout.trim(), evidence).toBe(CLI_VERSION);
  });

  it('exits non-zero for an unknown subcommand', () => {
    expectUnknownCommandRejected(runLauncher([UNKNOWN_COMMAND]));
  });
});

describe('launcher failure evidence', () => {
  // Regression: this exit-1-only check once passed beside a failing --version
  // while the CLI build was missing, so it could not tell a load failure from a
  // rejected subcommand.
  it('does not accept a crash as a rejected subcommand, and shows its stderr', () => {
    const crash = runNode([
      '-e',
      "console.error('launcher crash'); process.exit(1)",
    ]);

    expect(() => {
      expectUnknownCommandRejected(crash);
    }).toThrow('launcher crash');
  });

  it('kills a hung subprocess and reports the signal', () => {
    const hung = runNode(['-e', 'setInterval(() => {}, 1000)'], 200);

    expect(hung.signal).toBe('SIGTERM');
    expect(diagnose('hung exit', hung)).toContain('signal=SIGTERM');
  });

  it('keeps the subprocess bound inside the test budget', ({ task }) => {
    expect(SPAWN_TIMEOUT_MS).toBeLessThan(task.timeout);
  });
});
