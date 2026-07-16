/**
 * Integration tests for `agentmonitors verify` (issue #399).
 *
 * These spawn the built CLI as a subprocess against a real temp workspace.
 * `verify` itself boots and tears down an isolated daemon internally, so the
 * test only invokes the one command and asserts the PASS/FAIL verdict, the
 * delivered additionalContext, the failing stage, and scratch cleanup — the
 * whole point of the command is that the caller does none of the manual recipe.
 *
 * @see docs/specs/005-cli-reference.md §16
 */
import {
  execFileSync,
  spawn,
  type ChildProcess,
  type ExecFileSyncOptions,
} from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const CLI_PATH = path.resolve(__dirname, '../../dist/index.cjs');

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run the CLI. Strips ambient AGENTMONITORS_* so an isolated verify run never
 * inherits the developer's real socket/db (mirrors cli.integration.test.ts).
 */
function run(args: string[], cwd: string): RunResult {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        key !== 'AGENTMONITORS_SOCKET' &&
        key !== 'AGENTMONITORS_DB',
    ) as [string, string][],
  );
  const opts: ExecFileSyncOptions = { encoding: 'utf-8', env, cwd };
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], opts) as string;
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    const e = err as { stdout: string; stderr: string; status: number };
    return {
      stdout: (e.stdout ?? '') as string,
      stderr: (e.stderr ?? '') as string,
      exitCode: e.status ?? 1,
    };
  }
}

function writeMonitor(
  workspace: string,
  id: string,
  frontmatter: string,
): void {
  const dir = path.join(workspace, '.claude', 'monitors', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'MONITOR.md'),
    `---\n${frontmatter}\n---\nWhen this changes, review it.\n`,
    'utf-8',
  );
}

/** Files matching the auto-trigger scratch name (must be gone after cleanup). */
function scratchFiles(workspace: string): string[] {
  return readdirSync(workspace).filter((name) =>
    name.startsWith('agentmonitors-verify-'),
  );
}

describe('agentmonitors verify', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'verify-it-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reaches PASS on a real file-fingerprint change and delivers additionalContext (criterion 1)', () => {
    const ws = path.join(tempDir, 'pass');
    mkdirSync(ws, { recursive: true });
    // normal urgency → post-compact recap: proves end-to-end delivery WITHOUT
    // the 15s high-urgency claim-settle window, keeping the test fast. A 1s
    // interval keeps the budget small.
    writeMonitor(
      ws,
      'docs-watch',
      `name: Docs watch\nwatch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\n  cwd: ${JSON.stringify(ws)}\n  interval: '1s'\nurgency: normal`,
    );
    writeFileSync(path.join(ws, 'readme.md'), 'hello', 'utf-8');

    const result = run(
      ['verify', 'docs-watch', '--workspace', ws, '--format', 'json'],
      ws,
    );
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      stages: { name: string; status: string }[];
      additionalContext: string | null;
    };
    expect(report.ok).toBe(true);
    // Every pipeline stage passed through delivery.
    const deliver = report.stages.find((s) => s.name === 'deliver');
    expect(deliver?.status).toBe('pass');
    // The delivered proof artifact carries the monitor body.
    expect(report.additionalContext).toBeTruthy();
    expect(report.additionalContext).toContain('review it');

    // Criterion 4: the scratch file it created was cleaned up.
    expect(scratchFiles(ws)).toHaveLength(0);
  }, 60_000);

  it('reaches PASS on a debounce monitor even though `no-change` ticks occur while it settles (regression)', () => {
    const ws = path.join(tempDir, 'debounce');
    mkdirSync(ws, { recursive: true });
    // A debounce notify holds the observed change for `settle-for` before it
    // emits. The post-trigger observation history is therefore
    // [suppressed, no-change, …, triggered@flush]: a genuine `no-change` row
    // appears WHILE the batch settles, before the emitting `triggered` row.
    // Pre-fix, verify fail-fast on that first `no-change` and reported a false
    // "no change detected"; post-fix it recognizes the `suppressed` row as
    // "settling" and keeps polling until the flush. 1s interval + 2s settle
    // keeps the budget comfortably under the test timeout.
    writeMonitor(
      ws,
      'debounced',
      `name: Debounced\nwatch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\n  cwd: ${JSON.stringify(ws)}\n  interval: '1s'\nnotify:\n  strategy: debounce\n  settle-for: '2s'\nurgency: normal`,
    );
    writeFileSync(path.join(ws, 'readme.md'), 'hello', 'utf-8');

    const result = run(
      ['verify', 'debounced', '--workspace', ws, '--format', 'json'],
      ws,
    );
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      failure: { kind: string } | null;
      stages: { name: string; status: string }[];
      additionalContext: string | null;
    };
    expect(report.ok).toBe(true);
    // Crucially, the observe stage passed rather than false-failing no-change.
    expect(report.stages.find((s) => s.name === 'observe')?.status).toBe(
      'pass',
    );
    expect(report.stages.find((s) => s.name === 'deliver')?.status).toBe(
      'pass',
    );
    expect(report.additionalContext).toContain('review it');
    expect(scratchFiles(ws)).toHaveLength(0);
  }, 60_000);

  it('FAILs with the observe stage when the trigger changes nothing observable (no-change)', () => {
    const ws = path.join(tempDir, 'nochange');
    mkdirSync(path.join(ws, 'data-1'), { recursive: true });
    // Glob requires a `data-*/` prefix; the auto-trigger scratch lands at the
    // workspace root, so it never matches — a deterministic no-change. An
    // existing matched file (data-1/report.md) means the post-trigger
    // observation is `no-change` (matched set unchanged), not
    // `no-files-matched`.
    writeMonitor(
      ws,
      'nc',
      `name: NC\nwatch:\n  type: file-fingerprint\n  globs:\n    - 'data-*/report.md'\n  cwd: ${JSON.stringify(ws)}\n  interval: '1s'\nurgency: normal`,
    );
    writeFileSync(path.join(ws, 'data-1', 'report.md'), 'orig', 'utf-8');

    const result = run(
      ['verify', 'nc', '--workspace', ws, '--format', 'json'],
      ws,
    );
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      failure: { kind: string } | null;
      stages: { name: string; status: string }[];
    };
    expect(report.ok).toBe(false);
    expect(report.failure?.kind).toBe('no-change');
    const observe = report.stages.find((s) => s.name === 'observe');
    expect(observe?.status).toBe('fail');
    // The workspace-root scratch file was still cleaned up.
    expect(scratchFiles(ws)).toHaveLength(0);
  }, 60_000);

  it('FAILs with a budget-exceeded verdict when a manual run gets no change in time', () => {
    const ws = path.join(tempDir, 'budget');
    mkdirSync(ws, { recursive: true });
    writeMonitor(
      ws,
      'm',
      `name: M\nwatch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\n  cwd: ${JSON.stringify(ws)}\n  interval: '1s'\nurgency: normal`,
    );
    writeFileSync(path.join(ws, 'readme.md'), 'hello', 'utf-8');

    // --manual + a short --timeout-ms, and we make NO change → the detect phase
    // exhausts its budget and reports budget-exceeded on the observe stage.
    const result = run(
      [
        'verify',
        'm',
        '--workspace',
        ws,
        '--manual',
        '--timeout-ms',
        '3000',
        '--format',
        'json',
      ],
      ws,
    );
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      failure: { kind: string } | null;
      stages: { name: string; status: string }[];
    };
    expect(report.ok).toBe(false);
    expect(report.failure?.kind).toBe('budget-exceeded');
    expect(report.stages.find((s) => s.name === 'observe')?.status).toBe(
      'fail',
    );
  }, 60_000);

  it('errors clearly when the named monitor does not exist (setup)', () => {
    const ws = path.join(tempDir, 'missing');
    mkdirSync(ws, { recursive: true });
    writeMonitor(
      ws,
      'present',
      `name: Present\nwatch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\n  cwd: ${JSON.stringify(ws)}`,
    );

    const result = run(['verify', 'absent', '--workspace', ws], ws);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Monitor "absent" not found');
    expect(result.stderr).toContain('present');
  });

  it('lists the choices when no monitor id is given and several exist (setup)', () => {
    const ws = path.join(tempDir, 'ambiguous');
    mkdirSync(ws, { recursive: true });
    writeMonitor(
      ws,
      'one',
      `watch:\n  type: file-fingerprint\n  globs:\n    - '*.md'`,
    );
    writeMonitor(
      ws,
      'two',
      `watch:\n  type: file-fingerprint\n  globs:\n    - '*.txt'`,
    );

    const result = run(['verify', '--workspace', ws], ws);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Multiple monitors found');
    expect(result.stderr).toContain('one');
    expect(result.stderr).toContain('two');
  });
});

/**
 * Issue #407: `verify --use-workspace-daemon` targets the persistent workspace
 * daemon and leaves it running, so — unlike the isolated default — its own
 * scratch trigger file lives on the daemon's watched tree. Pre-fix, verify's
 * teardown DELETED that scratch file, the daemon observed the deletion as a real
 * change, and a later session's `hook deliver`/`events list` saw a spurious
 * `File deleted: …/agentmonitors-verify-….md` FIRST, ahead of the user's real
 * change. The fix retracts every event verify's own scratch file produced
 * (create AND delete), scoped to that synthetic path only.
 *
 * This test drives the REAL failure shape: a persistent daemon, a lead session
 * open across the whole run (so verify's scratch events project into it), then
 * an assertion that after the run no event references the scratch path — while a
 * genuine change made afterward IS still delivered (no over-suppression).
 */
describe('agentmonitors verify --use-workspace-daemon (issue #407)', () => {
  let tempDir: string;

  const CLI = ['node', CLI_PATH] as const;

  /** Run a CLI command with the given socket/db env against a workspace daemon. */
  function runWs(
    args: string[],
    cwd: string,
    env: Record<string, string>,
  ): RunResult {
    const opts: ExecFileSyncOptions = { encoding: 'utf-8', env, cwd };
    try {
      const stdout = execFileSync(CLI[0], [CLI[1], ...args], opts) as string;
      return { stdout, stderr: '', exitCode: 0 };
    } catch (err) {
      const e = err as { stdout: string; stderr: string; status: number };
      return {
        stdout: (e.stdout ?? '') as string,
        stderr: (e.stderr ?? '') as string,
        exitCode: e.status ?? 1,
      };
    }
  }

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'verify-ws-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('leaves NO scratch-file event for a later session, but still delivers a real change afterward', async () => {
    // Per-attempt isolation: a unique workspace + socket dir so a retry never
    // collides with a leaked socket/db from a prior attempt.
    const ws = mkdtempSync(path.join(tempDir, 'proof-'));
    // A dedicated short dir for the Unix socket keeps it well under the AF_UNIX
    // ~104-char path limit regardless of the OS temp root's depth.
    const socketDir = mkdtempSync(path.join(tmpdir(), 'amw-'));
    // Pin BOTH the socket and db so the spawned daemon and every CLI call —
    // including verify's `--use-workspace-daemon` resolution — agree on one
    // persistent daemon we control and tear down.
    const env: Record<string, string> = {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>),
      AGENTMONITORS_SOCKET: path.join(socketDir, 'd.sock'),
      AGENTMONITORS_DB: path.join(socketDir, 'verify.db'),
    };

    // Enable the workspace so `--use-workspace-daemon` targets its daemon.
    expect(runWs(['init', '--enable-only'], ws, env).exitCode).toBe(0);
    // A normal-urgency 1s file-fingerprint monitor: fast, and delivery via the
    // post-compact recap avoids the 15s high-urgency claim-settle window.
    writeMonitor(
      ws,
      'docs-watch',
      `name: Docs watch\nwatch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\n  cwd: ${JSON.stringify(ws)}\n  interval: '1s'\nurgency: normal`,
    );
    writeFileSync(path.join(ws, 'readme.md'), 'hello', 'utf-8');

    const monitorsDir = path.join(ws, '.claude', 'monitors');
    // Start the persistent workspace daemon ourselves so a lead session can be
    // open BEFORE verify's scratch events materialize (the real pollution shape)
    // and so we control teardown. --reap-after-ms 0 keeps our session alive.
    const daemon: ChildProcess = spawn(
      CLI[0],
      [
        CLI[1],
        'daemon',
        'run',
        monitorsDir,
        '--workspace',
        ws,
        '--poll-ms',
        '500',
        '--reap-after-ms',
        '0',
      ],
      { cwd: ws, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    try {
      let dstdout = '';
      let dstderr = '';
      daemon.stdout?.setEncoding('utf-8');
      daemon.stderr?.setEncoding('utf-8');
      daemon.stdout?.on('data', (c: string) => (dstdout += c));
      daemon.stderr?.on('data', (c: string) => (dstderr += c));
      const bootDeadline = Date.now() + 15_000;
      while (
        Date.now() < bootDeadline &&
        !dstdout.includes('AgentMon daemon listening')
      ) {
        if (daemon.exitCode !== null) {
          throw new Error(
            `daemon exited early (${String(daemon.exitCode)}).\n${dstdout}\n${dstderr}`,
          );
        }
        await delay(100);
      }
      expect(dstdout).toContain('AgentMon daemon listening');

      // A lead session open for the whole run — verify's scratch create/delete
      // events project into it, exactly as a user's session would receive them.
      const sessionResult = runWs(
        [
          'session',
          'open',
          '--host-session-id',
          'user-session',
          '--workspace',
          ws,
          '--format',
          'id',
        ],
        ws,
        env,
      );
      expect(sessionResult.exitCode).toBe(0);
      const sessionId = sessionResult.stdout.trim();
      expect(sessionId).toBeTruthy();

      // Run verify against the running workspace daemon (reused, not re-spawned).
      const verifyResult = runWs(
        [
          'verify',
          'docs-watch',
          '--use-workspace-daemon',
          '--workspace',
          ws,
          '--format',
          'json',
        ],
        ws,
        env,
      );
      const verifyReport = JSON.parse(verifyResult.stdout) as {
        ok: boolean;
        stages: { name: string; status: string }[];
      };
      expect(verifyReport.ok).toBe(true);
      expect(verifyResult.exitCode).toBe(0);
      // The scratch file itself is gone from disk (unchanged cleanup contract).
      expect(scratchFiles(ws)).toHaveLength(0);

      // ── Criterion 1 & 4: no scratch-file event survives for the session ────
      // Retraction deletes the shared `monitor_events` rows, so ALL views (not
      // just --unread) are clean. Pre-fix, this listing contained a
      // `File deleted: …/agentmonitors-verify-….md` (and a create) event.
      const afterVerify = runWs(
        ['events', 'list', '--session', sessionId, '--format', 'json'],
        ws,
        env,
      );
      expect(afterVerify.exitCode).toBe(0);
      expect(afterVerify.stdout).not.toContain('agentmonitors-verify-');
      const eventsAfterVerify = JSON.parse(afterVerify.stdout) as unknown[];
      expect(eventsAfterVerify).toHaveLength(0);

      // ── Non-over-suppression: a REAL change afterward IS still delivered ───
      appendFileSync(path.join(ws, 'readme.md'), '\na genuine edit\n', 'utf-8');
      let realDelivered = false;
      const realDeadline = Date.now() + 20_000;
      while (Date.now() < realDeadline) {
        const unread = runWs(
          [
            'events',
            'list',
            '--session',
            sessionId,
            '--unread',
            '--format',
            'json',
          ],
          ws,
          env,
        );
        if (unread.exitCode === 0 && unread.stdout.includes('readme.md')) {
          // The real change is delivered, and STILL no scratch artifact rode in.
          expect(unread.stdout).not.toContain('agentmonitors-verify-');
          realDelivered = true;
          break;
        }
        await delay(400);
      }
      expect(realDelivered).toBe(true);
    } finally {
      // Tear the daemon down within the test so a retry starts clean.
      runWs(['daemon', 'stop'], ws, env);
      if (daemon.exitCode === null) {
        daemon.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const t = globalThis.setTimeout(() => {
            daemon.kill('SIGKILL');
            resolve();
          }, 3_000);
          daemon.once('exit', () => {
            globalThis.clearTimeout(t);
            resolve();
          });
        });
      }
      rmSync(socketDir, { recursive: true, force: true });
    }
  }, 90_000);
});
