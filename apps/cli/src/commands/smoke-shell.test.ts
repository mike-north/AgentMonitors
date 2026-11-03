/** Execute the shipped diagnostic shell fragments without installs or Docker. */
import { spawnSync } from 'node:child_process';
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
      ['-c', preamble.replace('LOG_DIR=/tmp/logs', `LOG_DIR=${dir}`) + body],
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
  expect(result.stdout).toContain('compile-error');
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
