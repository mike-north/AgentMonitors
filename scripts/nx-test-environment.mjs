#!/usr/bin/env node
/**
 * Nx `runtime` cache input for test targets (see nx.json `testEnvironment` and
 * `dockerEnvironment`).
 *
 * Several suites change what they exercise based on the host: jq-backed preset
 * reductions skip without a local `jq` (and fail instead under `CI`), the
 * Docker smoke test self-skips without a reachable daemon, and native modules
 * such as better-sqlite3 are bound to the running Node ABI. Without this input
 * Nx would replay a green result recorded on a host that skipped that coverage
 * onto a host that would have run it. Printing a stable fingerprint of those
 * facilities makes such a change a cache miss.
 *
 * The output must be deterministic and fast: Nx runs this once per hash
 * computation. Only availability and version are reported, never paths or
 * other host-identifying details.
 *
 * Usage: node scripts/nx-test-environment.mjs [--docker]
 *
 * Nx caches runtime-input results for the lifetime of a task hasher, which the
 * Nx daemon keeps until the project graph changes. nx.json therefore sets
 * `useDaemonProcess: false` so this script runs on every invocation.
 *
 * @internal
 */
import { execFileSync } from 'node:child_process';

/**
 * Returns the first line of a command's stdout, or `'unavailable'` when the
 * command is missing, fails, or exceeds the timeout.
 */
function probe(command, args, timeout) {
  try {
    const out = execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout,
    });
    return out.split('\n')[0]?.trim() || 'available';
  } catch {
    return 'unavailable';
  }
}

const fingerprint = {
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  // Mirrors the probes in apps/cli/src/commands/pr-alerting-presets.test.ts and
  // scripts/run-jq-command.mjs: availability decides run vs reported skip.
  jq: probe('jq', ['--version'], 5_000),
  // `process.env.CI` turns a missing-jq skip into a hard failure.
  ci: process.env['CI'] ? 'set' : 'unset',
  // Permission-denial cases in libs/core/src/runtime/notify-live-definition.test.ts
  // skip when running as root.
  root: process.getuid?.() === 0 ? 'yes' : 'no',
  // source-incoming-changes and CLI integration suites exec git.
  git: probe('git', ['--version'], 5_000),
  // plugins/source-command-poll/src/self-bound.test.ts skips without perl.
  perl: probe('perl', ['-e', 'print "available"'], 5_000),
};

if (process.argv.includes('--docker')) {
  // Mirrors hasDocker() in apps/cli/src/commands/cli.docker.test.ts and
  // plugins/source-command-poll/src/watchdog-reaping.docker.test.ts: the daemon
  // must answer `docker info` (5s, the shorter of the two), not merely have its
  // CLI installed.
  fingerprint.docker =
    probe('docker', ['info'], 5_000) === 'unavailable'
      ? 'unavailable'
      : 'reachable';
}

process.stdout.write(`${JSON.stringify(fingerprint)}\n`);
