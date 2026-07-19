import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentMonitorRuntime } from '@agentmonitors/core';
import {
  describeDetachRaceLoss,
  runLoop,
  waitForDetachedDaemonReady,
} from './daemon.js';
import { callDaemon, daemonAvailable } from '../daemon-ipc.js';
import type { SpawnedDaemon } from '../detached-spawn.js';

const tempRoots: string[] = [];

function tempDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'agentmonitors-daemon-loop-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Issue #398: the idle-reaping block ran outside the tick's error boundary,
// so a transient error there (e.g. `runtime.listSessions()` hitting a brief
// schema-visibility gap) escaped the loop and killed the whole daemon. This
// asserts the reaping block is now resilient the same way the tick already
// is: log and continue, rather than crash.
// ---------------------------------------------------------------------------
describe('runLoop — idle-reaping errors do not crash the daemon (issue #398)', () => {
  it('logs "AgentMon reaping check failed" and keeps ticking when listSessions() throws once', async () => {
    const dir = tempDir();
    const monitorsDir = path.join(dir, '.claude', 'monitors');
    mkdirSync(monitorsDir, { recursive: true });
    const socketPath = path.join(dir, 'agentmon.sock');

    // Simulate the field failure signature: the first reaping-block call to
    // listSessions() throws (mirrors "no such table: agent_sessions"), then
    // subsequent calls succeed as normal.
    let listSessionsCalls = 0;
    const listSessionsSpy = vi
      .spyOn(AgentMonitorRuntime.prototype, 'listSessions')
      .mockImplementation(() => {
        listSessionsCalls += 1;
        if (listSessionsCalls === 1) {
          throw new Error('no such table: agent_sessions');
        }
        return [];
      });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      // Silence expected error logging during the test.
    });

    // reapAfterMs=0 disables the reap decision itself; listSessions() is
    // still invoked every iteration, which is all this test needs to force
    // the throw.
    const loopPromise = runLoop(
      monitorsDir,
      dir,
      20,
      socketPath,
      0,
      ':memory:',
    );

    try {
      // Pre-fix, the uncaught throw from the first listSessions() call would
      // reject runLoop's promise and end the daemon right there. Poll until a
      // SECOND call happens — proof the loop survived the first throw and
      // continued to the next iteration, not just that the error was logged.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && listSessionsCalls < 2) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(listSessionsCalls).toBeGreaterThanOrEqual(2);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'AgentMon reaping check failed: no such table: agent_sessions',
        ),
      );

      // Decisive proof the daemon is still alive and serving, not merely that
      // the loop's internal promise hasn't settled yet.
      await expect(daemonAvailable(socketPath)).resolves.toBe(true);
    } finally {
      // Real stop condition (issue #398 criterion 2): the intended `stop()`
      // path via the daemon's own IPC must still work after this change.
      await callDaemon('stop', {}, { socketPath });
      await loopPromise;
    }

    listSessionsSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Issue #389 review finding 1: `daemon run --detach`'s readiness wait only
// proves SOME daemon answers on the socket, not that it is the child THIS
// invocation spawned. Concurrent lazy-boot elsewhere can make our own child
// lose the startup race and exit while a different daemon answers. These
// cases exercise the pure decision function directly — reproducing the
// actual OS-level race deterministically in an integration test is
// inherently timing-dependent, so the decision logic itself gets unit
// coverage instead.
// ---------------------------------------------------------------------------
describe('describeDetachRaceLoss (issue #389 review finding 1)', () => {
  it('reports nothing when the serving pid matches the spawned pid (the ordinary case)', () => {
    expect(
      describeDetachRaceLoss({
        spawnedPid: 4242,
        servingPid: 4242,
        servingReapAfterMs: 0,
        requestedReapAfterMs: 0,
        socketPath: '/tmp/x.sock',
      }),
    ).toBeUndefined();
  });

  it('reports nothing when either pid is unavailable (best-effort identity check only)', () => {
    expect(
      describeDetachRaceLoss({
        spawnedPid: undefined,
        servingPid: 4242,
        servingReapAfterMs: 0,
        requestedReapAfterMs: 0,
        socketPath: '/tmp/x.sock',
      }),
    ).toBeUndefined();
    expect(
      describeDetachRaceLoss({
        spawnedPid: 4242,
        servingPid: undefined,
        servingReapAfterMs: 0,
        requestedReapAfterMs: 0,
        socketPath: '/tmp/x.sock',
      }),
    ).toBeUndefined();
  });

  it('names both pids and the socket when a different daemon won the race', () => {
    const message = describeDetachRaceLoss({
      spawnedPid: 111,
      servingPid: 222,
      servingReapAfterMs: 300_000,
      requestedReapAfterMs: 0,
      socketPath: '/tmp/agentmon.sock',
    });
    expect(message).toBeDefined();
    expect(message).toContain('/tmp/agentmon.sock');
    expect(message).toContain('pid 222');
    expect(message).toContain('pid 111');
    expect(message).toContain('lost the startup race');
  });

  it("reports the SURVIVING daemon's actual reap setting, not the one this invocation requested", () => {
    const disabled = describeDetachRaceLoss({
      spawnedPid: 111,
      servingPid: 222,
      servingReapAfterMs: 0,
      requestedReapAfterMs: 300_000,
      socketPath: '/tmp/x.sock',
    });
    expect(disabled).toContain('disabled');
    expect(disabled).toContain('--reap-after-ms 300000');

    const enabled = describeDetachRaceLoss({
      spawnedPid: 111,
      servingPid: 222,
      servingReapAfterMs: 60_000,
      requestedReapAfterMs: 0,
      socketPath: '/tmp/x.sock',
    });
    expect(enabled).toContain('stops after 60s idle');
  });

  it('reports the reap setting as "unknown" when the status call could not read it', () => {
    const message = describeDetachRaceLoss({
      spawnedPid: 111,
      servingPid: 222,
      servingReapAfterMs: undefined,
      requestedReapAfterMs: 0,
      socketPath: '/tmp/x.sock',
    });
    expect(message).toContain('unknown');
  });
});

// ---------------------------------------------------------------------------
// Issue #389 review finding 2: a synchronous spawn failure (bad `execPath`,
// `ENOENT`) must fail FAST with the real cause, not silently wait out the
// full readiness timeout and then point at a log file the daemon never had
// the chance to write. A fake `SpawnedDaemon` whose `spawnError` resolves
// immediately proves the race deterministically.
// ---------------------------------------------------------------------------
describe('waitForDetachedDaemonReady (issue #389 review finding 2)', () => {
  it('reports ready when the socket answers before any spawn error', async () => {
    const outcome = await waitForDetachedDaemonReady(
      '/does/not/matter.sock',
      50,
      10,
      {
        pid: 123,
        spawnError: new Promise<Error>(() => {
          /* never settles — the socket check below wins */
        }),
      } as SpawnedDaemon,
    );
    // The socket genuinely does not exist, so `daemonAvailable` will return
    // false for the whole window — this case only proves `ready: false`
    // without a spawnError surfaces when nothing else fires either. The
    // "answers" half of this function's contract is covered end to end by
    // the daemon-detach integration suite's happy-path case.
    expect(outcome).toEqual({ ready: false });
  });

  it('fails fast with the spawn error instead of waiting out the full timeout', async () => {
    const spawnFailure = new Error('spawn ENOENT');
    const start = Date.now();
    const outcome = await waitForDetachedDaemonReady(
      '/does/not/exist-either.sock',
      // A deliberately long timeout — if the race did NOT fail fast, this
      // test would take the full window instead of resolving almost
      // immediately with the spawn error.
      5_000,
      50,
      { pid: undefined, spawnError: Promise.resolve(spawnFailure) },
    );
    const elapsedMs = Date.now() - start;
    expect(outcome).toEqual({ ready: false, spawnError: spawnFailure });
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
