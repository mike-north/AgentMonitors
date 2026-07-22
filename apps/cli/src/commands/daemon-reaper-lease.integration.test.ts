import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeLocalState } from '../local-state.js';

/**
 * Reaper heartbeat lease — a live channel suppresses daemon reaping (issue
 * #435 Option A), and a stale lease lets reaping resume.
 *
 * This is the capstone of the channel-delivery story. Spec 006 sells the
 * channel as the push surface for an IDLE agent, but 002 makes daemon lifetime
 * a function of hook activity — and an idle listener session fires no hooks. So
 * the session goes dormant, the daemon reaps ~5 min later, monitors stop
 * ticking, and the channel is permanently silent exactly when it is needed.
 * Option A breaks that: a live channel-transport heartbeat counts as reaper
 * activity, guarded by the heartbeat's owner-declared TTL lease (issue #425) so
 * a dead server cannot pin the daemon alive forever (issue #426).
 *
 * These drive a REAL daemon process with a REAL (short) reap window and REAL
 * heartbeat records on disk — the whole point of #435 is a cross-process
 * lifetime contract that a unit test of `shouldReap` alone cannot prove. They
 * spawn a daemon child, so they run in the SERIAL config
 * (`vitest.serial.config.ts`) alongside the other daemon-spawning suites, where
 * the child is not CPU-starved by concurrent workers.
 *
 * @see ../../../docs/specs/002-runtime-delivery.md §10.2 (idle self-termination)
 * @see ../../../docs/specs/006-agent-integration.md §12.8 (channel keeps the daemon alive)
 */

const CLI_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'dist',
  'index.cjs',
);

/** Short reap window so the tests observe reaping in seconds, not minutes. */
const REAP_AFTER_MS = 1_000;

let workspace: string;
let dataHome: string;
let socketPath: string;
let dbPath: string;
let env: Record<string, string>;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'am-reaper-lease-'));
  dataHome = path.join(workspace, 'data-home');
  mkdirSync(dataHome, { recursive: true });
  // A file-fingerprint monitor with a 1s interval: changing `watched.txt`
  // produces an event within the kept-alive window, which is how we prove the
  // daemon is still TICKING (not merely still a live process) because it was
  // not reaped.
  const monitorDir = path.join(workspace, '.claude', 'monitors', 'watch-files');
  mkdirSync(monitorDir, { recursive: true });
  writeFileSync(path.join(workspace, 'watched.txt'), 'initial', 'utf-8');
  writeFileSync(
    path.join(monitorDir, 'MONITOR.md'),
    [
      '---',
      'name: Watch files',
      'watch:',
      '  type: file-fingerprint',
      '  globs:',
      "    - 'watched.txt'",
      `  cwd: ${JSON.stringify(workspace)}`,
      "  interval: '1s'",
      'urgency: normal',
      '---',
      'When files change, review them.',
      '',
    ].join('\n'),
    'utf-8',
  );

  socketPath = path.join(
    '/tmp',
    `am-reaper-lease-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
  );
  dbPath = path.join(workspace, 'am.db');
  writeLocalState(workspace, { enabled: true, socket: socketPath, db: dbPath });
  env = {
    XDG_DATA_HOME: dataHome,
    AGENTMONITORS_DB: dbPath,
    AGENTMONITORS_SOCKET: socketPath,
  };
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(socketPath, { force: true });
});

interface DaemonHandle {
  child: ReturnType<typeof spawn>;
  stdout: () => string;
  stop: () => void;
  waitForExit: (timeoutMs: number) => Promise<number | null>;
}

async function startDaemon(): Promise<DaemonHandle> {
  const monitorsDir = path.join(workspace, '.claude', 'monitors');
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
      '--reap-after-ms',
      String(REAP_AFTER_MS),
    ],
    {
      cwd: workspace,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let out = '';
  let err = '';
  child.stdout?.setEncoding('utf-8');
  child.stderr?.setEncoding('utf-8');
  child.stdout?.on('data', (chunk: string) => (out += chunk));
  child.stderr?.on('data', (chunk: string) => (err += chunk));

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(socketPath) && out.includes('AgentMon daemon listening')) {
      return {
        child,
        stdout: () => out,
        stop: () => child.kill('SIGKILL'),
        waitForExit: (timeoutMs) =>
          new Promise<number | null>((resolve) => {
            if (child.exitCode !== null) {
              resolve(child.exitCode);
              return;
            }
            const timer = setTimeout(() => resolve(null), timeoutMs);
            child.once('exit', (code) => {
              clearTimeout(timer);
              resolve(code ?? -1);
            });
          }),
      };
    }
    if (child.exitCode !== null) {
      throw new Error(
        `Daemon exited early (${String(child.exitCode)}).\n${out}\n${err}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`Daemon did not start.\n${out}\n${err}`);
}

/** Run a one-shot CLI command against the daemon and return its stdout. */
function runCli(args: string[]): { stdout: string; exitCode: number } {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd: workspace,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 20_000,
  });
  return { stdout: result.stdout ?? '', exitCode: result.status ?? -1 };
}

/**
 * Open a session then close it, so it is `dormant`: `openCount` is 0 (the
 * daemon would reap after the idle window) but `hasSeenSession` is true (the
 * short `reapAfterMs` applies, not the 10s boot grace). This reproduces the
 * #435 scenario — an idle listener whose session has gone dormant — without
 * waiting out the real session-dormancy threshold.
 */
function openThenCloseSession(hostSessionId: string): void {
  const opened = runCli([
    'session',
    'open',
    '--host-session-id',
    hostSessionId,
    '--workspace',
    workspace,
    '--format',
    'json',
  ]);
  expect(opened.exitCode).toBe(0);
  const sessionId = (JSON.parse(opened.stdout) as { id: string }).id;
  // `session close` takes the id positionally (marks the session dormant).
  const closed = runCli(['session', 'close', sessionId]);
  expect(closed.exitCode).toBe(0);
}

/**
 * Write a channel heartbeat record to the registry exactly as `channel serve`
 * would. Defaults to THIS test's own daemon socket; `socketPathOverride` lets
 * a caller simulate a heartbeat bound to a DIFFERENT daemon instance (PR #461
 * finding 1).
 */
function seedChannelHeartbeat(
  hostSessionId: string,
  updatedAt: Date,
  socketPathOverride?: string,
): void {
  const registry = path.join(dataHome, 'agentmonitors', 'transports');
  mkdirSync(registry, { recursive: true });
  const record = {
    schemaVersion: 1,
    transport: 'channel',
    pid: 4242,
    cliPath: '/usr/local/bin/agentmonitors',
    execPath: process.execPath,
    version: '9.9.9',
    home: process.env['HOME'] ?? '/tmp',
    dataRoot: dataHome,
    workspacePath: workspace,
    socketPath: socketPathOverride ?? socketPath,
    hostSessionId,
    startedAt: new Date(updatedAt.getTime() - 60_000).toISOString(),
    updatedAt: updatedAt.toISOString(),
    ttlMs: 30_000,
  };
  writeFileSync(
    path.join(registry, `channel-${hostSessionId}.json`),
    JSON.stringify(record, null, 2),
    'utf-8',
  );
}

function unreadEventCount(hostSessionId: string): number {
  const list = runCli(['session', 'list', '--format', 'json']);
  const sessions = JSON.parse(list.stdout) as {
    id: string;
    hostSessionId: string;
  }[];
  const session = sessions.find((s) => s.hostSessionId === hostSessionId);
  if (!session) return 0;
  const events = runCli([
    'events',
    'list',
    '--session',
    session.id,
    '--unread',
    '--format',
    'json',
  ]);
  if (events.exitCode !== 0) return 0;
  return (JSON.parse(events.stdout) as unknown[]).length;
}

describe('daemon reaper heartbeat lease (issue #435 Option A)', () => {
  it('a live channel heartbeat keeps a dormant-session daemon alive AND still ticking', async () => {
    const daemon = await startDaemon();
    try {
      const hostSessionId = 'idle-listener';
      openThenCloseSession(hostSessionId);
      // A fresh channel heartbeat (updatedAt = now, 30s TTL) — the idle
      // listener's channel server is alive. One seed stays non-stale for the
      // whole short test; no refresh loop needed.
      seedChannelHeartbeat(hostSessionId, new Date());

      // Wait well past the 1s reap window (5x). Without Option A the daemon
      // would have reaped seconds ago (dormant session, openCount 0).
      const exit = await daemon.waitForExit(5_000);
      expect(
        exit,
        'daemon must NOT have reaped while the channel is live',
      ).toBeNull();
      expect(daemon.child.exitCode).toBeNull();

      // And it is still TICKING, not merely a live idle process: a file change
      // now materializes an event, which only happens if the tick loop kept
      // running — i.e. the daemon was not reaped out from under the channel.
      writeFileSync(path.join(workspace, 'watched.txt'), 'changed', 'utf-8');
      const deadline = Date.now() + 6_000;
      let count = 0;
      while (Date.now() < deadline) {
        count = unreadEventCount(hostSessionId);
        if (count >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(
        count,
        'a monitor still fired past the reap window',
      ).toBeGreaterThanOrEqual(1);
    } finally {
      daemon.stop();
      await daemon.waitForExit(5_000);
    }
  }, 30_000);

  it('a STALE channel heartbeat does not suppress reaping — the lease has expired', async () => {
    const daemon = await startDaemon();
    let reaped = false;
    try {
      openThenCloseSession('dead-listener');
      // A heartbeat whose writer died: updatedAt is well past the 30s TTL, so
      // `isHeartbeatStale` is true and it must NOT count as activity. The
      // daemon reaps normally — the guard that stops an orphaned channel server
      // (issue #426) pinning the daemon alive forever.
      seedChannelHeartbeat('dead-listener', new Date(Date.now() - 10 * 60_000));

      // Reap window is 1s; give generous headroom for tick cadence.
      const exit = await daemon.waitForExit(8_000);
      reaped = exit !== null;
      expect(
        reaped,
        'daemon must reap when the only channel lease is stale',
      ).toBe(true);
      expect(exit).toBe(0);
    } finally {
      if (!reaped) daemon.stop();
      await daemon.waitForExit(5_000);
    }
  }, 30_000);

  it('a live HOOK heartbeat does NOT suppress reaping (only the channel counts)', async () => {
    // The hook transport is short-lived and self-healing; its 24h "wired-up"
    // TTL would wrongly pin the daemon for a day after a session ended. Only a
    // live CHANNEL heartbeat represents a long-lived process that needs the
    // daemon. Seed a FRESH hook heartbeat and confirm the daemon still reaps.
    const daemon = await startDaemon();
    let reaped = false;
    try {
      openThenCloseSession('hook-only');
      const registry = path.join(dataHome, 'agentmonitors', 'transports');
      mkdirSync(registry, { recursive: true });
      writeFileSync(
        path.join(registry, 'hook-hook-only.json'),
        JSON.stringify({
          schemaVersion: 1,
          transport: 'hook',
          pid: 4242,
          cliPath: '/usr/local/bin/agentmonitors',
          execPath: process.execPath,
          version: '9.9.9',
          home: process.env['HOME'] ?? '/tmp',
          dataRoot: dataHome,
          workspacePath: workspace,
          socketPath,
          hostSessionId: 'hook-only',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ttlMs: 24 * 60 * 60 * 1000,
        }),
        'utf-8',
      );

      const exit = await daemon.waitForExit(8_000);
      reaped = exit !== null;
      expect(
        reaped,
        'a live hook heartbeat must not keep the daemon alive',
      ).toBe(true);
      expect(exit).toBe(0);
    } finally {
      if (!reaped) daemon.stop();
      await daemon.waitForExit(5_000);
    }
  }, 30_000);

  it(
    'a registry read failure fails CLOSED — no reap that tick, normal ' +
      'reaping resumes once the registry is readable again (PR #461 finding 1)',
    async () => {
      // A transient EMFILE/EACCES on the transport registry DIRECTORY must not
      // read as "no channel attached": that would let the idle clock advance
      // toward reaping a possibly-LIVE channel, the exact #435 failure this
      // lease exists to prevent. Simulate an unreadable registry directory by
      // replacing it with a plain FILE: `readdirSync` on a non-directory throws
      // `ENOTDIR`, the same shape of failure as a permissions error.
      const daemon = await startDaemon();
      let reaped = false;
      try {
        openThenCloseSession('registry-unreadable');
        const registryDir = path.join(dataHome, 'agentmonitors', 'transports');
        rmSync(registryDir, { recursive: true, force: true });
        mkdirSync(path.dirname(registryDir), { recursive: true });
        writeFileSync(registryDir, 'not a directory', 'utf-8');

        // Past the 1s reap window with generous headroom: the daemon must NOT
        // have reaped while the registry read keeps failing.
        const exit = await daemon.waitForExit(5_000);
        expect(
          exit,
          'daemon must NOT reap while the registry directory is unreadable',
        ).toBeNull();
        expect(daemon.child.exitCode).toBeNull();

        // Recovery: once the registry is readable again (and genuinely empty —
        // no channel), normal reaping resumes on the next tick.
        rmSync(registryDir, { force: true });
        const exitAfterRecovery = await daemon.waitForExit(8_000);
        reaped = exitAfterRecovery !== null;
        expect(
          reaped,
          'daemon must resume reaping once the registry is readable again',
        ).toBe(true);
        expect(exitAfterRecovery).toBe(0);
      } finally {
        if (!reaped) daemon.stop();
        await daemon.waitForExit(5_000);
      }
    },
    30_000,
  );

  it(
    'a live channel heartbeat bound to a DIFFERENT daemon socket does NOT ' +
      'suppress reaping (PR #461 finding 1: same workspace, different socket)',
    async () => {
      // Two daemon instances can independently resolve the SAME workspacePath
      // (e.g. an orphaned daemon from a prior boot bound to a stale socket).
      // A channel heartbeat naming that OTHER daemon's socket is not keeping
      // THIS daemon alive, so it must not suppress THIS daemon's reaping.
      const daemon = await startDaemon();
      let reaped = false;
      try {
        openThenCloseSession('other-daemon-listener');
        const otherSocketPath = path.join(
          '/tmp',
          `am-reaper-lease-other-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
        );
        seedChannelHeartbeat(
          'other-daemon-listener',
          new Date(),
          otherSocketPath,
        );

        const exit = await daemon.waitForExit(8_000);
        reaped = exit !== null;
        expect(
          reaped,
          'daemon must reap when the only channel lease names a different socket',
        ).toBe(true);
        expect(exit).toBe(0);
      } finally {
        if (!reaped) daemon.stop();
        await daemon.waitForExit(5_000);
      }
    },
    30_000,
  );
});
