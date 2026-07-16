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

  it('reaches PASS on a non-auto-triggerable command-poll monitor via --trigger-cmd in a single self-contained call (issue #413)', () => {
    const ws = path.join(tempDir, 'trigger-cmd');
    mkdirSync(ws, { recursive: true });
    // command-poll cannot be auto-triggered — verify has no way to fabricate a
    // change for it. Pre-#413 the only path was --manual, which BLOCKS waiting
    // for an out-of-band change and can't be driven by a call-and-return agent
    // (one shell command per tool call). --trigger-cmd makes verify run the
    // change itself: the monitor `cat`s an absolute watched file, and the
    // trigger rewrites that file's contents, so the whole
    // daemon→observe→materialize→deliver pipeline completes in ONE invocation.
    // Absolute paths keep the command output independent of any daemon cwd. A 1s
    // interval keeps the budget small.
    const watched = path.join(ws, 'watched.txt');
    writeMonitor(
      ws,
      'cmd-watch',
      `name: Cmd watch\nwatch:\n  type: command-poll\n  command:\n    - cat\n    - ${JSON.stringify(watched)}\n  interval: '1s'\nurgency: normal`,
    );
    writeFileSync(watched, 'baseline contents\n', 'utf-8');

    const result = run(
      [
        'verify',
        'cmd-watch',
        '--workspace',
        ws,
        '--trigger-cmd',
        `printf 'changed by trigger\\n' > ${JSON.stringify(watched)}`,
        '--format',
        'json',
      ],
      ws,
    );
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      stages: { name: string; status: string; detail: string }[];
      additionalContext: string | null;
    };
    expect(report.ok).toBe(true);
    // The trigger stage ran the command itself (not the file-fingerprint scratch
    // path), and delivery completed end-to-end.
    const trigger = report.stages.find((s) => s.name === 'trigger');
    expect(trigger?.status).toBe('pass');
    expect(trigger?.detail).toContain('printf');
    expect(report.stages.find((s) => s.name === 'deliver')?.status).toBe(
      'pass',
    );
    expect(report.additionalContext).toContain('review it');
  }, 60_000);

  it('FAILs with a `setup` verdict when --trigger-cmd exits non-zero (a broken trigger command, not a monitor problem)', () => {
    const ws = path.join(tempDir, 'trigger-cmd-fail');
    mkdirSync(ws, { recursive: true });
    const watched = path.join(ws, 'watched.txt');
    writeMonitor(
      ws,
      'cmd-watch',
      `name: Cmd watch\nwatch:\n  type: command-poll\n  command:\n    - cat\n    - ${JSON.stringify(watched)}\n  interval: '1s'\nurgency: normal`,
    );
    writeFileSync(watched, 'baseline contents\n', 'utf-8');

    const result = run(
      [
        'verify',
        'cmd-watch',
        '--workspace',
        ws,
        '--trigger-cmd',
        'exit 3',
        '--format',
        'json',
      ],
      ws,
    );
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      failure: { kind: string; message: string } | null;
      stages: { name: string; status: string }[];
    };
    expect(report.ok).toBe(false);
    expect(report.failure?.kind).toBe('setup');
    expect(report.failure?.message).toContain('--trigger-cmd');
    expect(report.stages.find((s) => s.name === 'trigger')?.status).toBe(
      'fail',
    );
  }, 60_000);

  it('reaches PASS when --trigger-cmd blocks well past the poll interval before making its change (issue #416: observeFrom must start after fire() returns)', () => {
    const ws = path.join(tempDir, 'trigger-cmd-slow');
    mkdirSync(ws, { recursive: true });
    const watched = path.join(ws, 'watched.txt');
    writeMonitor(
      ws,
      'cmd-watch-slow',
      `name: Cmd watch slow\nwatch:\n  type: command-poll\n  command:\n    - cat\n    - ${JSON.stringify(watched)}\n  interval: '1s'\nurgency: normal`,
    );
    writeFileSync(watched, 'baseline contents\n', 'utf-8');

    // `fire()` for --trigger-cmd is a synchronous, blocking execSync — the
    // isolated daemon (a separate process) keeps polling on its own 1s
    // interval while it blocks, and will very likely record a `no-change`
    // observation timestamped mid-sleep (the file hasn't been rewritten yet).
    // The post-trigger filter must exclude that stray tick — if it instead
    // used a timestamp captured BEFORE fire() started (as it did pre-fix),
    // that mid-sleep `no-change` row would be counted as "post-trigger" and
    // fail verify fast, even though the real change is still coming.
    const result = run(
      [
        'verify',
        'cmd-watch-slow',
        '--workspace',
        ws,
        '--trigger-cmd',
        `sleep 2 && printf 'changed by slow trigger\\n' > ${JSON.stringify(watched)}`,
        '--timeout-ms',
        '10000',
        '--format',
        'json',
      ],
      ws,
    );
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      failure: { kind: string; message: string } | null;
      stages: { name: string; status: string }[];
    };
    expect(report.ok).toBe(true);
    expect(report.stages.find((s) => s.name === 'observe')?.status).toBe(
      'pass',
    );
  }, 30_000);

  it('FAILs bounded (does not hang) when --trigger-cmd never exits, honoring --timeout-ms (issue #416: execSync needs a timeout)', () => {
    const ws = path.join(tempDir, 'trigger-cmd-timeout');
    mkdirSync(ws, { recursive: true });
    const watched = path.join(ws, 'watched.txt');
    writeMonitor(
      ws,
      'cmd-watch-timeout',
      `name: Cmd watch timeout\nwatch:\n  type: command-poll\n  command:\n    - cat\n    - ${JSON.stringify(watched)}\n  interval: '1s'\nurgency: normal`,
    );
    writeFileSync(watched, 'baseline contents\n', 'utf-8');

    // Without an execSync timeout, `sleep 60` would block the whole `verify`
    // process for a minute regardless of any other budget. The 15s vitest
    // timeout on this test is itself part of the proof: pre-fix, this test
    // hangs past that timeout instead of failing fast.
    const result = run(
      [
        'verify',
        'cmd-watch-timeout',
        '--workspace',
        ws,
        '--trigger-cmd',
        'sleep 60',
        '--timeout-ms',
        '1000',
        '--format',
        'json',
      ],
      ws,
    );
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      failure: { kind: string; message: string } | null;
      stages: { name: string; status: string }[];
    };
    expect(report.ok).toBe(false);
    expect(report.failure?.kind).toBe('setup');
    expect(report.failure?.message).toContain('timed out');
    expect(report.stages.find((s) => s.name === 'trigger')?.status).toBe(
      'fail',
    );
  }, 15_000);

  it('the --manual budget-exceeded FAIL names the --trigger-cmd decoupled mode and the workaround (issue #413 AC3)', () => {
    const ws = path.join(tempDir, 'manual-hint');
    mkdirSync(ws, { recursive: true });
    writeMonitor(
      ws,
      'm',
      `name: M\nwatch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\n  cwd: ${JSON.stringify(ws)}\n  interval: '1s'\nurgency: normal`,
    );
    writeFileSync(path.join(ws, 'readme.md'), 'hello', 'utf-8');

    // --manual with no out-of-band change → budget-exceeded. The FAIL message
    // must now point a stuck (call-and-return) caller at --trigger-cmd and the
    // background workaround, not a bare "did you make a change?".
    const result = run(
      [
        'verify',
        'm',
        '--workspace',
        ws,
        '--manual',
        '--timeout-ms',
        '2000',
        '--format',
        'json',
      ],
      ws,
    );
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      failure: { kind: string; message: string } | null;
    };
    expect(report.ok).toBe(false);
    expect(report.failure?.kind).toBe('budget-exceeded');
    expect(report.failure?.message).toContain('--trigger-cmd');
    expect(report.failure?.message).toContain('stdin');
  }, 60_000);

  it('rejects --manual together with --trigger-cmd (mutually exclusive)', () => {
    const ws = path.join(tempDir, 'both-flags');
    mkdirSync(ws, { recursive: true });
    writeMonitor(
      ws,
      'm',
      `name: M\nwatch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\n  cwd: ${JSON.stringify(ws)}`,
    );

    const result = run(
      ['verify', 'm', '--workspace', ws, '--manual', '--trigger-cmd', 'true'],
      ws,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('either --manual or --trigger-cmd');
  });

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
describe('agentmonitors verify --use-workspace-daemon (issues #407/#418)', () => {
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

  // Issue #418 (HIGH): a LITERAL single-file glob whose watched file did not exist
  // is a case verify triggers by creating the REAL watched file — its objectKey is
  // a genuine monitored path, NOT a synthetic scratch key. Cleaning it up with the
  // durable by-KEY tombstone (safe only for synthetic keys) would sweep a LATER
  // genuine event at that same path within the TTL window, silently losing the
  // user's real change. verify must instead retract only its OWN observed event ids
  // (issue #407's id-scoped path), leaving a real create afterward intact. This
  // drives the real failure: run verify against a literal-file monitor, then create
  // the watched file for real and assert that event DOES materialize and survive.
  // Pre-fix, the tombstone at the real path ate it (it never appeared).
  it('a real create at a literal-glob monitor’s path AFTER verify still materializes and survives (no tombstone at a real path)', async () => {
    const ws = mkdtempSync(path.join(tempDir, 'literal-'));
    const socketDir = mkdtempSync(path.join(tmpdir(), 'aml-'));
    const env: Record<string, string> = {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>),
      AGENTMONITORS_SOCKET: path.join(socketDir, 'd.sock'),
      AGENTMONITORS_DB: path.join(socketDir, 'verify.db'),
    };
    expect(runWs(['init', '--enable-only'], ws, env).exitCode).toBe(0);
    // A LITERAL single-file glob (`watched.txt`, no glob magic) whose file does NOT
    // exist yet: verify's auto-trigger CREATES the real watched file, so its events
    // reference a genuine monitored path.
    writeMonitor(
      ws,
      'file-watch',
      `name: File watch\nwatch:\n  type: file-fingerprint\n  globs:\n    - 'watched.txt'\n  cwd: ${JSON.stringify(ws)}\n  interval: '1s'\nurgency: normal`,
    );

    const monitorsDir = path.join(ws, '.claude', 'monitors');
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

      // Run verify: it creates `watched.txt`, proves delivery, then cleans up via
      // the id-scoped retract (NOT a tombstone) because the path is real.
      const verifyResult = runWs(
        [
          'verify',
          'file-watch',
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
      // verify's own trigger file is gone from disk again (it created + removed it).
      expect(scratchFiles(ws)).toHaveLength(0);

      // ── The finding: a REAL create at the watched path AFTER verify must be
      // delivered and SURVIVE. Pre-fix, a durable tombstone keyed to this real path
      // swept it on the tick it materialized, so it never appeared. Post-fix there
      // is no tombstone at a real path, so it lands and stays.
      writeFileSync(
        path.join(ws, 'watched.txt'),
        'a genuine change\n',
        'utf-8',
      );
      let realDelivered = false;
      const realDeadline = Date.now() + 20_000;
      while (Date.now() < realDeadline && !realDelivered) {
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
        if (unread.exitCode === 0 && unread.stdout.includes('watched.txt')) {
          realDelivered = true;
          break;
        }
        await delay(400);
      }
      expect(realDelivered).toBe(true);

      // And it SURVIVES subsequent ticks (a tombstone would have swept it by now).
      await delay(2_000);
      const stillThere = runWs(
        ['events', 'list', '--session', sessionId, '--format', 'json'],
        ws,
        env,
      );
      expect(stillThere.exitCode).toBe(0);
      expect(stillThere.stdout).toContain('watched.txt');
    } finally {
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

  // Issue #414 criterion 2 (interruption-safety): a `--use-workspace-daemon` run
  // interrupted (e.g. by a command/CI timeout) must NOT leave permanent stray
  // state — no `active` verify session, no dangling scratch event/file. We SIGTERM
  // verify once its throwaway session is open, then assert the workspace converges
  // clean (verify's signal handler tears down + the daemon's backstops finish).
  it('an interrupted run leaves no active verify session and no dangling scratch event/file', async () => {
    const ws = mkdtempSync(path.join(tempDir, 'interrupt-'));
    const socketDir = mkdtempSync(path.join(tmpdir(), 'ami-'));
    const env: Record<string, string> = {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>),
      AGENTMONITORS_SOCKET: path.join(socketDir, 'd.sock'),
      AGENTMONITORS_DB: path.join(socketDir, 'verify.db'),
    };
    expect(runWs(['init', '--enable-only'], ws, env).exitCode).toBe(0);
    writeMonitor(
      ws,
      'docs-watch',
      `name: Docs watch\nwatch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\n  cwd: ${JSON.stringify(ws)}\n  interval: '1s'\nurgency: normal`,
    );
    writeFileSync(path.join(ws, 'readme.md'), 'hello', 'utf-8');

    const monitorsDir = path.join(ws, '.claude', 'monitors');
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
      daemon.stdout?.setEncoding('utf-8');
      daemon.stdout?.on('data', (c: string) => (dstdout += c));
      const bootDeadline = Date.now() + 15_000;
      while (
        Date.now() < bootDeadline &&
        !dstdout.includes('AgentMon daemon listening')
      ) {
        if (daemon.exitCode !== null) throw new Error('daemon exited early');
        await delay(100);
      }
      expect(dstdout).toContain('AgentMon daemon listening');

      // A persistent lead session that outlives verify, so we can query for any
      // stray scratch event a later session would see (events list is
      // session-scoped) and confirm none survive the interruption.
      const userSession = runWs(
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
      expect(userSession.exitCode).toBe(0);
      const userSessionId = userSession.stdout.trim();

      // Spawn verify as a signalable child (not execFileSync).
      const verify: ChildProcess = spawn(
        CLI[0],
        [
          CLI[1],
          'verify',
          'docs-watch',
          '--use-workspace-daemon',
          '--workspace',
          ws,
          '--format',
          'json',
        ],
        { cwd: ws, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let exited = false;
      verify.once('exit', () => (exited = true));

      // Wait until verify has fired its trigger (the scratch file is on disk and
      // its create event is materializing), then interrupt it mid-run — the exact
      // shape of a timeout-killed run, so the interruption hits with real scratch
      // state present, not before it exists.
      const armedDeadline = Date.now() + 15_000;
      let armed = false;
      while (Date.now() < armedDeadline && !armed && !exited) {
        if (scratchFiles(ws).length > 0) {
          armed = true;
          break;
        }
        await delay(150);
      }
      expect(armed).toBe(true);
      verify.kill('SIGTERM');

      // Wait for verify to exit (its signal handler runs teardown first).
      const exitDeadline = Date.now() + 10_000;
      while (Date.now() < exitDeadline && !exited) await delay(100);
      expect(exited).toBe(true);

      // Converge-clean assertion: no ACTIVE agentmonitors-verify-* session and no
      // scratch event/file survive. Poll a few daemon ticks so the daemon's
      // suppression sweep / reap backstop can finish alongside the signal handler.
      let clean = false;
      const cleanDeadline = Date.now() + 20_000;
      while (Date.now() < cleanDeadline && !clean) {
        const sessions = runWs(
          ['session', 'list', '--format', 'json'],
          ws,
          env,
        );
        const events = runWs(
          ['events', 'list', '--session', userSessionId, '--format', 'json'],
          ws,
          env,
        );
        const parsedSessions = JSON.parse(sessions.stdout) as {
          hostSessionId: string;
          status: string;
        }[];
        const strayActiveVerify = parsedSessions.some(
          (s) =>
            s.hostSessionId.startsWith('agentmonitors-verify-') &&
            s.status === 'active',
        );
        const strayScratchEvent = events.stdout.includes(
          'agentmonitors-verify-',
        );
        if (
          !strayActiveVerify &&
          !strayScratchEvent &&
          scratchFiles(ws).length === 0
        ) {
          clean = true;
          break;
        }
        await delay(500);
      }
      expect(clean).toBe(true);
    } finally {
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
