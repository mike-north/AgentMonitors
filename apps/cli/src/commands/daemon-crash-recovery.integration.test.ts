/**
 * Proves the process boundary of durable recipient work: an abruptly killed
 * daemon must leave an unread event available to the same resumed session.
 * Every process, database, socket and user-data directory belongs to this test;
 * this is an explicit restart proof, not an operating-system supervision test.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { DeliveryClaim, MonitorEventRecord } from '@agentmonitors/core';
import { callDaemon } from '../daemon-ipc.js';
import { writeLocalState } from '../local-state.js';

/** Built CLI is the same executable users run; no runtime or SQLite mocks. */
const CLI_PATH = path.resolve(import.meta.dirname, '../../dist/index.cjs');
/** A captured child exit distinguishes death from a slow socket or observation. */
interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}
/** Only handles created by this test may be signalled during crash/cleanup. */
interface OwnedDaemon {
  child: ChildProcess;
  exit: Promise<ExitResult>;
  result?: ExitResult;
  output: string;
}
const children: OwnedDaemon[] = [];
const directories: string[] = [];
const sockets: string[] = [];

/** Bound a wait and dispose its timer even when the operation completes early. */
async function bounded<T>(
  operation: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(async () => {
  // Reap every owned child before removing its socket or database. Cleanup is
  // also mandatory when readiness, an assertion, or a later restart fails.
  const results = await Promise.allSettled(
    children.map(async (daemon) => {
      if (!daemon.result) daemon.child.kill('SIGKILL');
      await bounded(daemon.exit, 5_000, 'owned daemon cleanup');
    }),
  );
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    // Preserve diagnostic files if a child cannot be confirmed dead; never
    // unlink the database/socket beneath a potentially running process.
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      'Owned daemon cleanup failed',
    );
  }
  children.length = 0;
  for (const socket of sockets.splice(0)) {
    rmSync(socket, { force: true });
    rmSync(`${socket}.lock.d`, { recursive: true, force: true });
  }
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** Poll only while the owned process is alive and include its output on failure. */
async function until(
  daemon: OwnedDaemon,
  label: string,
  predicate: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (daemon.result) {
      throw new Error(
        `${label}: daemon exited ${JSON.stringify(daemon.result)}\n${daemon.output}`,
      );
    }
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `${label}: daemon still running but condition timed out\n${daemon.output}`,
  );
}

it('preserves unread work across SIGKILL and serves it to the same resumed session', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'am-crash-recovery-'));
  directories.push(workspace);
  const socket = path.join('/tmp', `am-crash-${randomUUID()}.sock`);
  sockets.push(socket);
  const db = path.join(workspace, 'inbox.db');
  const monitors = path.join(workspace, '.claude', 'monitors');
  const monitorDir = path.join(monitors, 'file-change');
  const home = path.join(workspace, 'home');
  mkdirSync(monitorDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeLocalState(workspace, { enabled: true, socket, db });
  const watched = path.join(workspace, 'watched.txt');
  writeFileSync(watched, 'before crash');
  writeFileSync(
    path.join(monitorDir, 'MONITOR.md'),
    [
      '---',
      'name: Crash recovery fixture',
      'watch:',
      '  type: file-fingerprint',
      "  globs: ['watched.txt']",
      `  cwd: ${JSON.stringify(workspace)}`,
      "  interval: '1s'",
      'urgency: normal',
      '---',
      'Inspect the changed file.',
      '',
    ].join('\n'),
  );
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: path.join(workspace, 'data'),
    AGENTMONITORS_DB: db,
    AGENTMONITORS_SOCKET: socket,
  };
  const cli = (args: string[]) =>
    spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd: workspace,
      env,
      encoding: 'utf8',
      timeout: 15_000,
    });
  // Establish a real source baseline synchronously, before the live observer
  // and recipient session exist. No sleeps or hand-seeded database rows.
  const baseline = cli(['daemon', 'once', monitors, '--workspace', workspace]);
  expect(baseline.status, baseline.stderr).toBe(0);

  // Pin every IPC request at this boundary so no caller can fall back to a
  // real user's default workspace socket.
  const rpc = <T>(
    method: Parameters<typeof callDaemon>[0],
    params: Record<string, unknown> = {},
  ): Promise<T> =>
    callDaemon<T>(method, params, { socketPath: socket, timeoutMs: 1_000 });

  const start = async (): Promise<OwnedDaemon> => {
    const child = spawn(
      process.execPath,
      [
        CLI_PATH,
        'daemon',
        'run',
        monitors,
        '--workspace',
        workspace,
        '--socket',
        socket,
        '--poll-ms',
        '100',
        '--reap-after-ms',
        '0',
      ],
      {
        cwd: workspace,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let resolveExit!: (result: ExitResult) => void;
    const daemon: OwnedDaemon = {
      child,
      output: '',
      exit: new Promise((resolve) => {
        resolveExit = resolve;
      }),
    };
    children.push(daemon);
    const exited = (result: ExitResult): void => {
      daemon.result = result;
      resolveExit(result);
    };
    child.once('exit', (code, signal) => exited({ code, signal }));
    child.once('error', (error) =>
      exited({ code: null, signal: null, error: error.message }),
    );
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        daemon.output = (daemon.output + chunk).slice(-65_536);
      });
    }
    await until(daemon, 'daemon readiness', async () => {
      try {
        const status = await rpc<{ pid: number }>('status');
        return status.pid === child.pid;
      } catch {
        return false;
      }
    });
    return daemon;
  };
  const sessionParams = {
    adapter: 'claude-code',
    hostSessionId: 'owned-crash-session',
    role: 'lead',
    workspacePath: workspace,
    agentIdentity: 'crash-recovery-test',
    hookStatePath: path.join(workspace, 'hook-state.json'),
  };
  const first = await start();
  const session = await rpc<{ id: string }>('session.open', sessionParams);
  writeFileSync(watched, 'durable unread change');
  const unread = () =>
    rpc<MonitorEventRecord[]>('events.list', {
      sessionId: session.id,
      unreadOnly: true,
    });
  await until(
    first,
    'persisted unread event',
    async () => (await unread()).length === 1,
  );
  const before = await unread();
  expect(before).toHaveLength(1);
  const eventId = before[0]?.id;
  expect(eventId).toBeTruthy();

  // SIGKILL intentionally bypasses daemon stop, SQLite close, and signal
  // handlers. Await the actual signal exit before inspecting durable state.
  expect(first.child.kill('SIGKILL')).toBe(true);
  expect(await bounded(first.exit, 5_000, 'crash exit')).toEqual({
    code: null,
    signal: 'SIGKILL',
  });
  const doctor = cli(['doctor', '--workspace', workspace]);
  expect(doctor.status, doctor.stderr).toBe(1);
  expect(doctor.stdout).toContain('daemon-reachable');
  expect(doctor.stdout).toContain('lead session is registered');

  const restarted = await start();
  expect(restarted.child.pid).not.toBe(first.child.pid);
  const resumed = await rpc<{ id: string }>('session.open', sessionParams);
  expect(resumed.id).toBe(session.id);
  expect(await unread()).toEqual(before);
  const claim = await rpc<DeliveryClaim | null>('hook.claim', {
    sessionId: resumed.id,
    lifecycle: 'turn-interruptible',
  });
  expect(claim?.sessionId).toBe(session.id);
  expect(claim?.mode).toBe('delivery');
  expect(claim?.urgency).toBe('normal');
  expect(claim?.unreadCounts.normal).toBe(1);
  expect(claim?.message).toBeTruthy();
  // Delivery is not acknowledgment: the exact event stays unread until the
  // resumed recipient explicitly acknowledges that id.
  expect((await unread()).map((event) => event.id)).toEqual([eventId]);
  await rpc('events.ack', {
    sessionId: resumed.id,
    eventIds: [eventId],
  });
  expect(await unread()).toEqual([]);
}, 60_000);
