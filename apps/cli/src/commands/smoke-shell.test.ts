/** Execute the shipped diagnostic shell fragments without installs or Docker. */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
const script = readFileSync(
  path.join(import.meta.dirname, 'fixtures/cli-docker-smoke.sh'),
  'utf8',
);
const preamble = script.slice(0, script.indexOf('phase "apt-get-update"'));
const readiness = script
  .slice(
    script.indexOf('READY_TIMEOUT_S=60'),
    script.indexOf('phase "daemon-status-probe"'),
  )
  .replace('READY_TIMEOUT_S=60', 'READY_TIMEOUT_S=0');
function shell(body: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'am-shell-'));
  try {
    return spawnSync(
      'bash',
      [
        '-c',
        preamble
          .replace('LOG_DIR=/tmp/logs', `LOG_DIR=${dir}`)
          .replace(
            'DAEMON_LOG=/tmp/daemon.log',
            `DAEMON_LOG=${dir}/daemon.log`,
          ) + body,
      ],
      { encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
it('reports a failing phase and preserves its output', () => {
  const result = shell(
    'phase broken-build\nrun_logged bash -c "echo compile-error; exit 7"',
  );
  expect(result.status).toBe(7);
  expect(result.stderr).toContain('broken-build');
  expect(result.stdout + result.stderr).toContain('compile-error');
});
it('reports readiness expiry with process and socket state', () => {
  const result = shell('DAEMON_PID=$$\n' + readiness);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('socket did not appear');
  expect(result.stderr).toContain('still running');
});
it('reports the early daemon exit code', () => {
  const result = shell(
    'bash -c "exit 23" &\nDAEMON_PID=$!\nsleep 0.05\n' +
      readiness.replace('READY_TIMEOUT_S=0', 'READY_TIMEOUT_S=1'),
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('exit code 23');
});
it('does not mask a failed workspace-copy producer', () => {
  const line = script
    .split('\n')
    .find(
      (value) =>
        value.startsWith('run_logged bash') && value.includes('tar --exclude'),
    );
  expect(line).toBeDefined();
  const result = shell(
    'phase extract-workspace\ntar() { return 17; }; export -f tar\n' + line,
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('extract-workspace');
});

// Valid phase volume must not consume the outer helper's 20 MiB budget, even
// when the producer writes one giant line; the literal caller markers survive.
it('accepts more than 20 MiB from a successful phase with bounded recent output', () => {
  const result = shell(`
phase verbose-build
run_logged node -e 'process.stdout.write("x".repeat(21 * 1024 * 1024)); console.log("recent-build-evidence")'
echo CLAUDE_VERSION=ok
echo STATUS_RUNNING=true
echo EVENT_COUNT=1
echo CLAIM_URGENCY=normal
`);
  expect(result.status).toBe(0);
  expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThan(
    512 * 1024,
  );
  expect(result.stdout + result.stderr).toContain('recent-build-evidence');
  for (const marker of [
    'CLAUDE_VERSION=ok',
    'STATUS_RUNNING=true',
    'EVENT_COUNT=1',
    'CLAIM_URGENCY=normal',
  ])
    expect(result.stdout).toContain(marker);
});
it('bounds an ordinary failure tail including an unbroken diagnostic line', () => {
  const result = shell(`
phase broken-verbose-build
run_logged node -e 'process.stderr.write("x".repeat(21 * 1024 * 1024)); console.error("recent-error-evidence"); process.exit(7)'
`);
  expect(result.status).toBe(7);
  expect(result.stderr).toContain('broken-verbose-build');
  expect(result.stderr).toContain('recent-error-evidence');
  expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThan(
    512 * 1024,
  );
});

// Kill the actual shell group during child work: no ERR/TERM trap or later
// file retrieval can supply the evidence asserted here. A real process is
// needed because fake timers cannot establish pipe delivery before SIGKILL.
it('streams recent bounded phase and daemon evidence before abrupt active termination', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'am-shell-active-'));
  const body = `
phase active-build
node -e 'require("node:fs").writeFileSync(process.argv[1], "d".repeat(1024 * 1024) + "recent-daemon-evidence")' "$DAEMON_LOG"
active_command() { node -e 'process.stdout.write("x".repeat(21 * 1024 * 1024) + "recent-active-evidence")'; sleep 30; }
run_logged active_command
`;
  const child = spawn(
    'bash',
    [
      '-c',
      preamble
        .replace('LOG_DIR=/tmp/logs', `LOG_DIR=${dir}`)
        .replace('DAEMON_LOG=/tmp/daemon.log', `DAEMON_LOG=${dir}/daemon.log`) +
        body,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  // Kill the whole uniquely owned group, including sampler and active child.
  const kill = () => {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Already reaped. */
      }
    }
  };
  const watchdog = setTimeout(kill, 2500);
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    if (
      output.includes('recent-active-evidence') &&
      output.includes('recent-daemon-evidence')
    )
      kill();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.on('close', () => resolve());
      child.on('error', reject);
    });
    expect(child.signalCode).toBe('SIGKILL');
    expect(output).toContain('recent phase: active-build');
    expect(output).toContain('recent-active-evidence');
    expect(output).toContain('recent-daemon-evidence');
    expect(Buffer.byteLength(output)).toBeLessThan(512 * 1024);
  } finally {
    clearTimeout(watchdog);
    kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
