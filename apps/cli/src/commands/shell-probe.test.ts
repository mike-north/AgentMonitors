/** Real POSIX lifecycle checks; an independent owner cleans even faulty probes. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const fixture = readFileSync(
  path.join(import.meta.dirname, 'fixtures/cli-docker-smoke.sh'),
  'utf8',
);
const preamble = fixture.slice(0, fixture.indexOf('phase "apt-get-update"'));
const driver = pathToFileURL(
  path.join(import.meta.dirname, 'fixtures/shell-probe.ts'),
).href;

/** Only ESRCH proves absence; permission and other inspection failures are errors. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

/** Independent cleanup cannot share the helper operation being fault-injected. */
function terminateProbeGroup(group: number): void {
  try {
    process.kill(-group, 'SIGKILL');
  } catch (error) {
    if (
      !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
    ) {
      throw error;
    }
  }
}

/** Give OS orphan reaping a bounded opportunity after synchronous group cleanup. */
async function absent(pids: number[]): Promise<boolean> {
  const deadline = Date.now() + 1000;
  while (pids.some(alive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return pids.every((pid) => !alive(pid));
}

it.each([
  { outcome: 'success', body: 'exit 0', status: 0 },
  { outcome: 'failure', body: 'exit 7', status: 7 },
  { outcome: 'timeout', body: 'wait "$FOREGROUND_PID"', status: null },
])(
  'reaps the owned sampler and foreground descendants after $outcome',
  async ({ outcome, body, status }) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'am-probe-lifecycle-'));
    const groupFile = path.join(dir, 'group.pid');
    const childrenFile = path.join(dir, 'children.pid');
    let group: number | undefined;
    let children: number[] = [];
    try {
      // The preamble is real and deliberately has no phase file. Its sampler
      // cannot reach its sample-count exit while waiting for that missing file.
      // Check the group exists under Bash's PID without requiring privileged ps.
      // Record ownership before child work so the outer finally can recover even
      // when the tested helper loses its cleanup or its runner times out.
      const script =
        `kill -0 -- "-$$" || exit 93; printf '%s' "$$" >"$PROBE_GROUP_FILE"\n` +
        preamble
          .replace('LOG_DIR=/tmp/logs', `LOG_DIR=${dir}/logs`)
          .replace(
            'DAEMON_LOG=/tmp/daemon.log',
            `DAEMON_LOG=${dir}/daemon.log`,
          ) +
        `
sleep 30 </dev/null >/dev/null 2>&1 &
FOREGROUND_PID=$!
printf '%s %s' "$SAMPLER_PID" "$FOREGROUND_PID" >"$PROBE_CHILDREN_FILE"
echo lifecycle-started
${body}
`;
      const runner = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
import { runShellProbe } from ${JSON.stringify(driver)};
import { readFileSync } from 'node:fs';
const script = readFileSync(0, 'utf8');
const result = runShellProbe(script, { timeout: 200 });
console.log(JSON.stringify({ pid: result.pid, status: result.status, signal: result.signal,
  error: result.error?.code, stdout: result.stdout, stderr: result.stderr }));
`,
        ],
        {
          input: script,
          encoding: 'utf8',
          detached: true,
          timeout: 2000,
          killSignal: 'SIGKILL',
          env: {
            ...process.env,
            PROBE_GROUP_FILE: groupFile,
            PROBE_CHILDREN_FILE: childrenFile,
          },
        },
      );
      group = Number(readFileSync(groupFile, 'utf8'));
      children = readFileSync(childrenFile, 'utf8').split(' ').map(Number);
      expect(group).toBeGreaterThan(1);
      expect(children).toHaveLength(2);
      expect(runner.error).toBeUndefined();
      expect(runner.status).toBe(0);
      const result = JSON.parse(runner.stdout);
      // detached:true must make the Bash PID the unique group leader; group
      // cleanup can never target the runner's or Vitest's shared process group.
      expect(result.pid).toBe(group);
      expect(result.status).toBe(status);
      expect(result.stdout).toContain('lifecycle-started');
      expect(result.stderr).toBe('');
      expect(result.error).toBe(
        outcome === 'timeout' ? 'ETIMEDOUT' : undefined,
      );
      expect(result.signal).toBe(outcome === 'timeout' ? 'SIGKILL' : null);
      await absent(children);
      expect(children.map(alive), 'sampler/foreground survivors').toEqual([
        false,
        false,
      ]);
    } finally {
      // This is independent of runShellProbe's cleanup. A fault experiment must
      // fail its assertion while still leaving no owned process alive afterwards.
      if (group === undefined) {
        try {
          group = Number(readFileSync(groupFile, 'utf8'));
        } catch {
          /* No child started. */
        }
      }
      if (group !== undefined && Number.isInteger(group) && group > 1) {
        terminateProbeGroup(group);
      }
      if (children.length === 0) {
        try {
          children = readFileSync(childrenFile, 'utf8').split(' ').map(Number);
        } catch {
          /* No child recorded. */
        }
      }
      try {
        expect(
          await absent(
            group !== undefined && group > 1 ? [...children, -group] : children,
          ),
        ).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);
