import {
  execFileSync,
  type ExecFileSyncOptions,
  spawn,
} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeLocalState } from '../local-state.js';

/**
 * Delivery-transport health, driven through the real CLI (issue #425).
 *
 * These live in the SERIAL config (`vitest.serial.config.ts`) rather than in
 * `cli.integration.test.ts`, for the reason that config already documents: they
 * spawn real daemon child processes that must bind a Unix socket, and in the
 * default parallel run — nx running several projects at once, vitest running
 * files in parallel — those children are CPU-starved.
 *
 * Moving `cli.docker.test.ts` to the serial suite was necessary but NOT
 * sufficient to fix this PR's CI hang: with Docker already out of the parallel
 * pool, `pnpm test` still ran past the 30-minute job budget. These five
 * daemon-spawning cases took the parallel file from 31 real daemons to 36, and
 * on CI's constrained runners that was enough to stall a neighbouring test past
 * its timeout. A local run never showed it — an 18-core dev machine absorbs the
 * extra load, and the Docker test that dominates CI's pool does not even run
 * here.
 *
 * @see docs/specs/006-agent-integration.md §12 (transport health)
 * @see docs/specs/005-cli-reference.md §15 (doctor)
 */

const CLI_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'dist',
  'index.cjs',
);

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runWithEnv(
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): RunResult {
  const opts: ExecFileSyncOptions = {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    cwd,
    // Bounded, unlike the parallel suite's helper: these drive a live daemon,
    // and vitest cannot interrupt a synchronous `execFileSync` — an unbounded
    // one would hang the worker outright instead of failing the test.
    timeout: 60_000,
  };
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

interface DaemonHandle {
  stop: () => void;
  waitForExit: () => Promise<void>;
}

async function startDaemon(
  monitorsDir: string,
  workspace: string,
  env: Record<string, string>,
  socketPath: string,
): Promise<DaemonHandle> {
  const child = spawn(
    'node',
    [
      CLI_PATH,
      'daemon',
      'run',
      monitorsDir,
      '--workspace',
      workspace,
      '--poll-ms',
      '200',
      '--socket',
      socketPath,
    ],
    {
      cwd: workspace,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const handle: DaemonHandle = {
    stop: () => {
      child.kill('SIGTERM');
    },
    waitForExit: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
      }),
  };

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (
      existsSync(socketPath) &&
      stdout.includes('AgentMon daemon listening')
    ) {
      return handle;
    }
    if (child.exitCode !== null) {
      throw new Error(
        `Daemon exited early with code ${String(child.exitCode)}.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGTERM');
  throw new Error(
    `Timed out waiting for daemon startup.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
  );
}

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'agentmon-transport-health-'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// Issue #425: the delivery-transport health surface — "what is the listening
// method for this session, and is it healthy?".
//
// These drive the REAL CLI as a user does (`agentmonitors doctor`, subprocess,
// stdout + exit code) against a seeded transport registry in an isolated data
// root, because the property under test is cross-process by nature: one process
// writes a heartbeat, a different one reads it back and judges it. A unit test
// of the verdict alone (`transport-health.test.ts`) cannot prove the two halves
// agree on the registry layout, the socket resolution, or the wording a user
// actually sees.
//
// The misbinding cases run against a LIVE daemon with a registered lead
// session, because correlating "a channel bound to workspace X" with "the
// session waiting in workspace Y" is only possible through that session's host
// id — without it there is no link between the two, and the surface correctly
// has nothing to say.
//
// @see docs/specs/006-agent-integration.md §12 (transport health)
// @see docs/specs/005-cli-reference.md §15 (doctor)
describe('doctor delivery-transport health (issue #425)', () => {
  const SCHEDULE_MONITOR = `---
name: Heartbeat
watch:
  type: schedule
  cron: '* * * * *'
  timezone: UTC
urgency: normal
---
This monitor fires on a schedule.
`;

  const HOST_SESSION = 'transport-health-host';

  // The version a heartbeat carries is compared against the running CLI's own,
  // so a fixture must seed the REAL version unless it is deliberately
  // exercising version skew — otherwise every "healthy" case would also report
  // a skew and the negative control would prove nothing.
  const CLI_VERSION = runWithEnv(['--version'], {}).stdout.trim();

  interface TransportFixture {
    dir: string;
    monitorsRoot: string;
    dataHome: string;
    socketPath: string;
    env: Record<string, string>;
  }

  /**
   * An enabled workspace with one schedule monitor and an isolated
   * `XDG_DATA_HOME`, so the transport registry can neither see nor pollute the
   * developer's real one. `daemon once` runs a tick up front so the monitor is
   * observed — otherwise every case would also trip the pre-existing
   * `never observed` check and the exit code would stop telling us anything
   * about transports.
   */
  function transportFixture(label: string): TransportFixture {
    const dir = path.join(tempDir, `transports-${label}`);
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    const monitorDir = path.join(monitorsRoot, 'heartbeat');
    mkdirSync(monitorDir, { recursive: true });
    writeFileSync(
      path.join(monitorDir, 'MONITOR.md'),
      SCHEDULE_MONITOR,
      'utf-8',
    );

    const dataHome = path.join(dir, 'data-home');
    mkdirSync(dataHome, { recursive: true });
    const socketPath = path.join(
      '/tmp',
      `agentmon-tr-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    writeLocalState(dir, { enabled: true, socket: socketPath });

    const env = {
      XDG_DATA_HOME: dataHome,
      AGENTMONITORS_DB: path.join(dir, 'agentmon.db'),
      AGENTMONITORS_SOCKET: socketPath,
    };
    const once = runWithEnv(
      ['daemon', 'once', monitorsRoot, '--workspace', dir],
      env,
      dir,
    );
    expect(once.exitCode).toBe(0);

    return { dir, monitorsRoot, dataHome, socketPath, env };
  }

  /** Seed a heartbeat exactly as a transport process would have written one. */
  function seedHeartbeat(
    fixture: TransportFixture,
    transport: 'hook' | 'channel',
    overrides: Record<string, unknown> = {},
  ): void {
    const registry = path.join(fixture.dataHome, 'agentmonitors', 'transports');
    mkdirSync(registry, { recursive: true });
    const hostSessionId =
      (overrides['hostSessionId'] as string) ?? HOST_SESSION;
    const record = {
      schemaVersion: 1,
      transport,
      pid: 4242,
      cliPath: '/usr/local/bin/agentmonitors',
      execPath: process.execPath,
      version: CLI_VERSION,
      home: process.env['HOME'] ?? '/tmp',
      dataRoot: fixture.dataHome,
      workspacePath: fixture.dir,
      socketPath: fixture.socketPath,
      hostSessionId,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
      ttlMs: 30_000,
      ...overrides,
    };
    const key = transport === 'channel' ? hostSessionId : 'workspace';
    writeFileSync(
      path.join(registry, `${transport}-${key}.json`),
      JSON.stringify(record, null, 2),
      'utf-8',
    );
  }

  /** Register a lead session so a session-scoped transport can be correlated. */
  function openLeadSession(fixture: TransportFixture): void {
    const opened = runWithEnv(
      [
        'session',
        'open',
        '--host-session-id',
        HOST_SESSION,
        '--workspace',
        fixture.dir,
        '--format',
        'json',
      ],
      fixture.env,
      fixture.dir,
    );
    expect(opened.exitCode).toBe(0);
  }

  // --- Failure mode (a): no daemon running for this workspace ---------------
  // Deliberately NO daemon: the socket in the fixture is dead. This is the
  // reviewer-agent incident — a hook-lazy-booted daemon reaped while an idle
  // listener fired no hooks to revive it, and nothing anywhere said so.
  it('names the absent daemon as its own problem, distinct from the transports themselves', () => {
    const fixture = transportFixture('no-daemon');
    seedHeartbeat(fixture, 'hook');

    const result = runWithEnv(
      ['doctor', '--workspace', fixture.dir],
      fixture.env,
      fixture.dir,
    );

    expect(result.stdout).toContain('Delivery transports:');
    expect(result.stdout).toContain('[daemon-unreachable]');
    expect(result.stdout).toContain('No daemon is reachable at');
    // The transport itself is NOT blamed: "restart your session" would be the
    // wrong fix. The row still reads "listening, with nothing behind it".
    expect(result.stdout).toContain('hook: running');
    expect(result.stdout).toContain('agentmonitors daemon run');
    expect(result.stdout).toContain('NOT deliverable');
  });

  // --- Negative control: healthy, with a live daemon and a lead session ------
  it('reports a healthy verdict when the daemon is up and the transport is correctly bound', async () => {
    const fixture = transportFixture('healthy');
    const daemon = await startDaemon(
      fixture.monitorsRoot,
      fixture.dir,
      fixture.env,
      fixture.socketPath,
    );
    try {
      openLeadSession(fixture);
      seedHeartbeat(fixture, 'hook');

      const result = runWithEnv(
        ['doctor', '--workspace', fixture.dir],
        fixture.env,
        fixture.dir,
      );

      expect(result.stdout).toContain('hook: running');
      expect(result.stdout).toContain('delivery to THIS session → via hook');
      expect(result.stdout).toContain('✓ transport:hook');
      expect(result.stdout).not.toContain('[daemon-unreachable]');
      expect(result.stdout).not.toContain('[workspace-mismatch]');
      expect(result.stdout).not.toContain('NOT deliverable');
    } finally {
      daemon.stop();
      await daemon.waitForExit();
    }
  }, 30_000);

  // --- Failure mode (b): bound to a different workspace ----------------------
  it('reports a channel bound to another workspace, naming both paths', async () => {
    const fixture = transportFixture('misbound');
    const daemon = await startDaemon(
      fixture.monitorsRoot,
      fixture.dir,
      fixture.env,
      fixture.socketPath,
    );
    try {
      openLeadSession(fixture);
      // The reviewer-agent incident: the session was launched from $HOME, so
      // its channel resolved the home-directory workspace instead of the repo
      // whose monitors it was meant to receive. Same host session id, different
      // workspace — which is exactly what makes it correlatable at all.
      seedHeartbeat(fixture, 'channel', { workspacePath: '/somewhere/else' });

      const result = runWithEnv(
        ['doctor', '--workspace', fixture.dir],
        fixture.env,
        fixture.dir,
      );

      expect(result.stdout).toContain('[workspace-mismatch]');
      expect(result.stdout).toContain('/somewhere/else');
      expect(result.stdout).toContain(fixture.dir);
      expect(result.stdout).toContain('CLAUDE_PROJECT_DIR');
      // Reported as a transport-owned defect, never as the down-daemon problem:
      // the daemon here is perfectly healthy.
      expect(result.stdout).not.toContain('[daemon-unreachable]');
      expect(result.stdout).toContain('✗ transport:channel');
      expect(result.exitCode).toBe(1);
    } finally {
      daemon.stop();
      await daemon.waitForExit();
    }
  }, 30_000);

  // --- Failure mode (d): channel present but not heartbeating ---------------
  it('reports a lapsed channel heartbeat as stale, not as absent', async () => {
    const fixture = transportFixture('stale-channel');
    const daemon = await startDaemon(
      fixture.monitorsRoot,
      fixture.dir,
      fixture.env,
      fixture.socketPath,
    );
    try {
      openLeadSession(fixture);
      seedHeartbeat(fixture, 'channel', {
        updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      });

      const result = runWithEnv(
        ['doctor', '--workspace', fixture.dir],
        fixture.env,
        fixture.dir,
      );

      expect(result.stdout).toContain('[heartbeat-stale]');
      expect(result.stdout).toContain('channel: stale');
      // "Stale" and "never configured" need different fixes, so a lapsed
      // server must not be reported as simply missing.
      expect(result.stdout).not.toContain('channel: not reporting');
      expect(result.stdout).toContain('MCP server');
    } finally {
      daemon.stop();
      await daemon.waitForExit();
    }
  }, 30_000);

  // --- Negative control: no transport has reported in -----------------------
  it('reports "via none" without inventing a failure when nothing has registered', () => {
    const fixture = transportFixture('none');

    const result = runWithEnv(
      ['doctor', '--workspace', fixture.dir],
      fixture.env,
      fixture.dir,
    );

    expect(result.stdout).toContain('hook: not reporting');
    expect(result.stdout).toContain('channel: not reporting');
    expect(result.stdout).toContain('via none');
    // No lead session and no transport is the ordinary idle state, not a
    // degradation — it must not turn doctor red (matching the existing
    // `daemon-reachable`/`lead-session` idle discipline, issue #373).
    expect(result.exitCode).toBe(0);
  });

  // --- Failure mode (c): reminders suppressed by coalesced-until-ack --------
  // The hardest case, and the reason this is a HEALTH surface: the daemon is
  // up, a lead session is open, an event materialized on a real transition —
  // and the agent is still never told, because that unread event is already
  // claimed. Driven end to end through the real CLI.
  //
  // Deterministic by construction (issue #425 review — the prior version of
  // this test wrapped every assertion in
  // `if (result.stdout.includes('[reminders-suppressed]'))`, so if the
  // schedule-monitor-plus-`daemon once` precondition it relied on ever failed
  // to materialize the state in time, EVERY assertion below was silently
  // skipped and the test passed green while proving nothing — exactly the
  // hardest failure mode this whole surface exists to catch, going unguarded).
  // This version follows the same real-daemon recipe issue #333's regression
  // test uses: open the session FIRST, then drive an actual file-fingerprint
  // change through a live daemon tick and POLL for the resulting unread event
  // before claiming it — so the precondition is confirmed to hold, never
  // merely hoped for.
  it('reports muted reminders with the session-scoped ack remediation, and fails the verdict', async () => {
    const dir = path.join(tempDir, 'transports-suppressed');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    const monitorDir = path.join(monitorsRoot, 'docs-watcher');
    mkdirSync(monitorDir, { recursive: true });
    const watchedFile = path.join(dir, 'watched.txt');
    writeFileSync(watchedFile, 'initial content', 'utf-8');
    writeFileSync(
      path.join(monitorDir, 'MONITOR.md'),
      [
        '---',
        'name: Docs watcher',
        'watch:',
        '  type: file-fingerprint',
        '  globs:',
        '    - "watched.txt"',
        `  cwd: ${JSON.stringify(dir)}`,
        '  interval: "1s"',
        'urgency: normal',
        '---',
        'When files change, review them.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const dataHome = path.join(dir, 'data-home');
    mkdirSync(dataHome, { recursive: true });
    const socketPath = path.join(
      '/tmp',
      `agentmon-tr-suppressed-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    writeLocalState(dir, { enabled: true, socket: socketPath });
    const env = {
      XDG_DATA_HOME: dataHome,
      AGENTMONITORS_DB: path.join(dir, 'agentmon.db'),
      AGENTMONITORS_SOCKET: socketPath,
    };

    const daemon = await startDaemon(monitorsRoot, dir, env, socketPath);
    try {
      const opened = runWithEnv(
        [
          'session',
          'open',
          '--host-session-id',
          HOST_SESSION,
          '--workspace',
          dir,
          '--format',
          'json',
        ],
        env,
        dir,
      );
      expect(opened.exitCode).toBe(0);
      const sessionId = (JSON.parse(opened.stdout) as { id: string }).id;

      // Let the baseline tick complete, then change the watched file — a real
      // daemon tick materializes exactly one durable, unread normal event
      // (mirrors issue #333's regression test).
      await new Promise((resolve) => setTimeout(resolve, 1200));
      writeFileSync(watchedFile, 'changed: added eval()', 'utf-8');

      const unread = () =>
        runWithEnv(
          [
            'events',
            'list',
            '--session',
            sessionId,
            '--unread',
            '--format',
            'json',
          ],
          env,
          dir,
        );
      const eventDeadline = Date.now() + 10_000;
      while (Date.now() < eventDeadline) {
        const polled = unread();
        if (
          polled.exitCode === 0 &&
          (JSON.parse(polled.stdout) as unknown[]).length >= 1
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      // Confirmed, not hoped for: the precondition the rest of this test
      // depends on actually holds before we act on it.
      expect(JSON.parse(unread().stdout)).toHaveLength(1);

      const claim = runWithEnv(
        [
          'hook',
          'claim',
          '--session',
          sessionId,
          '--lifecycle',
          'turn-interruptible',
          '--format',
          'json',
        ],
        env,
        dir,
      );
      expect(claim.exitCode).toBe(0);
      const claimed = JSON.parse(claim.stdout) as { mode: string } | null;
      // The first turn-interruptible claim over an unclaimed normal event
      // always surfaces the coalesced reminder (002 §9.2) and durably claims
      // the event (never acknowledges it) — confirming the exact
      // claimed-but-unread state the suppression guard holds on, rather than
      // assuming the claim did what it was expected to.
      expect(claimed?.mode).toBe('delivery');
      // Still unread (claiming never acknowledges — BP2/SP4): the suppression
      // guard's precondition (an unread event that IS claimed) is exactly
      // this state, confirmed rather than assumed.
      expect(JSON.parse(unread().stdout)).toHaveLength(1);

      const result = runWithEnv(['doctor', '--workspace', dir], env, dir);

      expect(result.stdout).toContain('[reminders-suppressed]');
      expect(result.stdout).toContain('coalesced-until-ack');
      expect(result.stdout).toContain(
        `agentmonitors events ack --session ${sessionId}`,
      );
      expect(result.stdout).toContain('✗ delivery-verdict');
      expect(result.exitCode).toBe(1);
    } finally {
      daemon.stop();
      await daemon.waitForExit();
    }
  }, 30_000);

  // --- `--json` structured contract -----------------------------------------
  it('exposes transports, the verdict, and remediation in --json', async () => {
    const fixture = transportFixture('json');
    const daemon = await startDaemon(
      fixture.monitorsRoot,
      fixture.dir,
      fixture.env,
      fixture.socketPath,
    );
    try {
      openLeadSession(fixture);
      seedHeartbeat(fixture, 'channel', { workspacePath: '/somewhere/else' });
      seedHeartbeat(fixture, 'hook');

      const result = runWithEnv(
        ['doctor', '--workspace', fixture.dir, '--format', 'json'],
        fixture.env,
        fixture.dir,
      );

      const payload = JSON.parse(result.stdout) as {
        transports: {
          name: string;
          configured: boolean;
          running: boolean;
          healthy: boolean;
          boundTo: { workspacePath: string; socketPath: string } | null;
          version: string | null;
          lastDelivery: string | null;
          problems: { code: string; detail: string; remediation: string }[];
        }[];
        pipelineProblems: { code: string; remediation: string }[];
        deliveryWillReachThisSession: string;
        deliverable: boolean;
        verdict: string;
        remediation: string[];
      };

      expect(payload.transports.map((transport) => transport.name)).toEqual([
        'hook',
        'channel',
      ]);
      const channel = payload.transports.find(
        (transport) => transport.name === 'channel',
      );
      expect(channel?.configured).toBe(true);
      expect(channel?.healthy).toBe(false);
      expect(channel?.boundTo?.workspacePath).toBe('/somewhere/else');
      expect(channel?.version).toBe(CLI_VERSION);
      expect(channel?.problems.map((problem) => problem.code)).toContain(
        'workspace-mismatch',
      );
      // Every problem carries an actionable next step — never a bare
      // "unhealthy" with nothing the reader can do about it.
      for (const problem of channel?.problems ?? []) {
        expect(problem.remediation.length).toBeGreaterThan(0);
      }
      // The misbound channel is excluded from the listening method; the hook
      // transport is still the one that would reach this session.
      expect(payload.deliveryWillReachThisSession).toBe('hook');
      expect(payload.verdict).toContain('delivery to THIS session');
      expect(payload.remediation.length).toBeGreaterThan(0);
      // `pipelineProblems` is present even when empty: an absent key would be
      // indistinguishable from "nothing was checked".
      expect(Array.isArray(payload.pipelineProblems)).toBe(true);
    } finally {
      daemon.stop();
      await daemon.waitForExit();
    }
  }, 30_000);
});
