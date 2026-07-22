import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentMonitorRuntime } from '@agentmonitors/core';
import {
  describeDetachIdentityIssue,
  describeSpawnedCleanupOutcome,
  runLoop,
  terminateSpawnedDetachedDaemon,
  waitForDetachedDaemonReady,
  waitForDetachIdentityProof,
} from './daemon.js';
import { callDaemon, daemonAvailable } from '../daemon-ipc.js';
import { transportRegistryDir } from '../transport-heartbeat.js';
import type { SpawnedDaemon } from '../detached-spawn.js';

// Spies (not fully mocks — real fs behavior passes through) on `node:fs` so a
// single test below can assert `readdirSync` is never called with the
// transport registry path. Declared with `vi.mock(..., { spy: true })` (hoisted
// by vitest to the top of the module) since ESM module namespaces are otherwise
// non-configurable and cannot be `vi.spyOn`'d directly per-test.
vi.mock('node:fs', { spy: true });

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
// PR #461 review finding 4: the reaper's channel-heartbeat check must not scan
// the machine-wide transport registry at all when reaping is disabled
// (`--reap-after-ms 0`) — `shouldReap` short-circuits on that case regardless
// of `channelAttached`, so the registry `readdirSync` is pure wasted I/O with
// a disabled reaper. Asserted via a spy on the real `readdirSync` rather than
// a fake/mocked registry: the property under test is "is the directory read
// at all", not the read's result.
// ---------------------------------------------------------------------------
describe('runLoop — reap registry scan runs only when the lease could matter (PR #461 finding 4)', () => {
  it('never reads the transport registry directory when reaping is disabled', async () => {
    const dir = tempDir();
    const monitorsDir = path.join(dir, '.claude', 'monitors');
    mkdirSync(monitorsDir, { recursive: true });
    const socketPath = path.join(dir, 'agentmon.sock');
    const registryDir = transportRegistryDir();
    const readdirSpy = vi.mocked(readdirSync);
    readdirSpy.mockClear();

    const loopPromise = runLoop(
      monitorsDir,
      dir,
      20,
      socketPath,
      0,
      ':memory:',
    );

    try {
      const deadline = Date.now() + 2000;
      // Give the loop a few iterations' worth of time to prove the absence,
      // not just the first tick.
      while (
        Date.now() < deadline &&
        !(await daemonAvailable(socketPath).catch(() => false))
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 100));

      const registryReads = readdirSpy.mock.calls.filter(
        (call) => call[0] === registryDir,
      );
      expect(registryReads).toHaveLength(0);
    } finally {
      await callDaemon('stop', {}, { socketPath }).catch(() => undefined);
      await loopPromise;
      // `vi.restoreAllMocks()` in the top-level `afterEach` restores the
      // `readdirSync` spy after this test — no manual restore needed here.
    }
  });

  // The other half of the same finding (PR #461 thread 3632150387): the scan is
  // ALSO wasted while a session is active. `shouldReap` short-circuits to
  // `reap: false` on `openCount > 0` before it ever consults `channelAttached`,
  // so a channel lease cannot change the outcome then — reading the registry
  // every tick with an active session is pure I/O for a value that is ignored.
  it('never reads the transport registry directory while a session is active (reaping enabled)', async () => {
    const dir = tempDir();
    const monitorsDir = path.join(dir, '.claude', 'monitors');
    mkdirSync(monitorsDir, { recursive: true });
    const socketPath = path.join(dir, 'agentmon.sock');
    const registryDir = transportRegistryDir();
    const readdirSpy = vi.mocked(readdirSync);

    // Reaping ENABLED this time — so only an open session, not `reapAfterMs`,
    // can gate the scan away.
    const loopPromise = runLoop(
      monitorsDir,
      dir,
      20,
      socketPath,
      60_000,
      ':memory:',
    );

    try {
      const deadline = Date.now() + 2000;
      while (
        Date.now() < deadline &&
        !(await daemonAvailable(socketPath).catch(() => false))
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // Open an ACTIVE session for this workspace, so `openCount > 0`.
      await callDaemon(
        'session.open',
        {
          adapter: 'claude-code',
          hostSessionId: 'active-session',
          agentIdentity: 'claude',
          workspacePath: dir,
          hookStatePath: path.join(dir, 'hook-state.json'),
        },
        { socketPath },
      );

      // Clear only AFTER the session is open, so startup reads (unrelated) do
      // not count; then prove the reaper does not touch the registry across
      // several subsequent ticks while the session stays active.
      readdirSpy.mockClear();
      await new Promise((resolve) => setTimeout(resolve, 200));

      const registryReads = readdirSpy.mock.calls.filter(
        (call) => call[0] === registryDir,
      );
      expect(registryReads).toHaveLength(0);
    } finally {
      await callDaemon('stop', {}, { socketPath }).catch(() => undefined);
      await loopPromise;
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #389 review finding 1 (round 2: 3611413813): `daemon run --detach`'s
// readiness wait only proves SOME daemon answers on the socket, not that it
// is the child THIS invocation spawned. Concurrent lazy-boot elsewhere can
// make our own child lose the startup race and exit while a different daemon
// answers — and a `status` call that errors, or that can't report a pid, must
// NOT be read as "identity confirmed" either (the fail-open gap the round-2
// finding named). These cases exercise the pure decision function directly —
// reproducing the actual OS-level race deterministically in an integration
// test is inherently timing-dependent, so the decision logic itself gets
// unit coverage instead.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Round-4 review finding 3611539482: the ready-timeout/spawn-error branch
// awaited terminateSpawnedDetachedDaemon(pid) but discarded its result, so the
// failure report could never state whether cleanup actually succeeded — a
// direct contradiction of the spec language both non-success --detach
// branches share. Both outcomes (terminated / not terminated) get direct unit
// coverage on the pure formatter, since reliably forcing a real child to
// survive SIGTERM+SIGKILL in an integration test would be flaky.
// ---------------------------------------------------------------------------
describe('describeSpawnedCleanupOutcome (round-4 review 3611539482)', () => {
  it('reports nothing when there was no pid to clean up', () => {
    expect(describeSpawnedCleanupOutcome(undefined, '', true)).toBe('');
    expect(describeSpawnedCleanupOutcome(undefined, '', false)).toBe('');
  });

  it('states cleanup succeeded, naming the pid, when termination is confirmed', () => {
    const note = describeSpawnedCleanupOutcome(4242, ' (pid 4242)', true);
    expect(note).toContain('has been terminated');
    expect(note).toContain('(pid 4242)');
    expect(note).not.toContain('WARNING');
  });

  it('states cleanup FAILED with an explicit WARNING, naming the pid, when the process is still alive', () => {
    const note = describeSpawnedCleanupOutcome(4242, ' (pid 4242)', false);
    expect(note).toContain('WARNING');
    expect(note).toContain('could not be terminated');
    expect(note).toContain('may still be running');
    expect(note).toContain('(pid 4242)');
  });
});

describe('describeDetachIdentityIssue (issue #389 review finding 1)', () => {
  it('reports nothing when the serving pid matches the spawned pid (the ordinary case)', () => {
    expect(
      describeDetachIdentityIssue({
        spawnedPid: 4242,
        servingPid: 4242,
        servingReapAfterMs: 0,
        requestedReapAfterMs: 0,
        socketPath: '/tmp/x.sock',
        statusError: undefined,
      }),
    ).toBeUndefined();
  });

  // Round-2 finding 3611413813: the pre-fix version of this decision reported
  // SUCCESS (`undefined`) whenever either pid was unavailable — recreating
  // the exact false-success case the whole check exists to close, just moved
  // one layer down. Fail CLOSED instead: identity is unproven, so this must
  // report the uncertainty, never silently pass.
  it('fails CLOSED — reports the identity as unproven, never success — when either pid is unavailable', () => {
    const spawnedPidMissing = describeDetachIdentityIssue({
      spawnedPid: undefined,
      servingPid: 4242,
      servingReapAfterMs: 0,
      requestedReapAfterMs: 0,
      socketPath: '/tmp/x.sock',
      statusError: undefined,
    });
    expect(spawnedPidMissing).toBeDefined();
    expect(spawnedPidMissing).toContain('/tmp/x.sock');
    expect(spawnedPidMissing).toContain('Could not confirm');
    expect(spawnedPidMissing).not.toContain('started in the background');

    const servingPidMissing = describeDetachIdentityIssue({
      spawnedPid: 4242,
      servingPid: undefined,
      servingReapAfterMs: 0,
      requestedReapAfterMs: 0,
      socketPath: '/tmp/x.sock',
      statusError: undefined,
    });
    expect(servingPidMissing).toBeDefined();
    expect(servingPidMissing).toContain('pid 4242');
    expect(servingPidMissing).toContain('Could not confirm');
  });

  it('names the status error when that is why identity could not be proven', () => {
    const message = describeDetachIdentityIssue({
      spawnedPid: 4242,
      servingPid: undefined,
      servingReapAfterMs: undefined,
      requestedReapAfterMs: 0,
      socketPath: '/tmp/x.sock',
      statusError: new Error('socket hang up'),
    });
    expect(message).toContain('socket hang up');
  });

  it('names both pids and the socket when a different daemon won the race', () => {
    const message = describeDetachIdentityIssue({
      spawnedPid: 111,
      servingPid: 222,
      servingReapAfterMs: 300_000,
      requestedReapAfterMs: 0,
      socketPath: '/tmp/agentmon.sock',
      statusError: undefined,
    });
    expect(message).toBeDefined();
    expect(message).toContain('/tmp/agentmon.sock');
    expect(message).toContain('pid 222');
    expect(message).toContain('pid 111');
    expect(message).toContain('lost the startup race');
  });

  it("reports the SURVIVING daemon's actual reap setting, not the one this invocation requested", () => {
    const disabled = describeDetachIdentityIssue({
      spawnedPid: 111,
      servingPid: 222,
      servingReapAfterMs: 0,
      requestedReapAfterMs: 300_000,
      socketPath: '/tmp/x.sock',
      statusError: undefined,
    });
    expect(disabled).toContain('disabled');
    expect(disabled).toContain('--reap-after-ms 300000');

    const enabled = describeDetachIdentityIssue({
      spawnedPid: 111,
      servingPid: 222,
      servingReapAfterMs: 60_000,
      requestedReapAfterMs: 0,
      socketPath: '/tmp/x.sock',
      statusError: undefined,
    });
    expect(enabled).toContain('stops after 60s idle');
  });

  it('reports the reap setting as "unknown" when the status call could not read it', () => {
    const message = describeDetachIdentityIssue({
      spawnedPid: 111,
      servingPid: 222,
      servingReapAfterMs: undefined,
      requestedReapAfterMs: 0,
      socketPath: '/tmp/x.sock',
      statusError: undefined,
    });
    expect(message).toContain('unknown');
  });
});

// ---------------------------------------------------------------------------
// Round-2 review finding 3611413813 (part 2): identity must be RETRIED within
// the readiness deadline, not given up on after a single `status` call. This
// exercises `waitForDetachIdentityProof` directly against a real daemon IPC
// server, proving a transient failure followed by a real answer resolves to
// the true pid rather than the caller falling back to "unproven" too early.
// ---------------------------------------------------------------------------
describe('waitForDetachIdentityProof (issue #389 review finding 1, round 2)', () => {
  it('retries daemon status until it answers, within the deadline', async () => {
    const dir = tempDir();
    const socketPath = path.join(dir, 'agentmon.sock');
    const monitorsDir = path.join(dir, '.claude', 'monitors');
    mkdirSync(monitorsDir, { recursive: true });

    // No daemon is listening yet — the first attempts must fail, then a
    // daemon binds partway through, and the retry loop must pick it up
    // rather than giving up after the very first failed attempt.
    const loopPromise = runLoop(
      monitorsDir,
      dir,
      20,
      socketPath,
      0,
      ':memory:',
    );
    try {
      const deadline = Date.now() + 5_000;
      const probe = await waitForDetachIdentityProof(socketPath, deadline, 25);
      expect(probe.servingPid).toBeDefined();
      expect(probe.statusError).toBeUndefined();
    } finally {
      await callDaemon('stop', {}, { socketPath }).catch(() => undefined);
      await loopPromise;
    }
  });

  it('reports the last status error once the deadline passes with nothing ever answering', async () => {
    const deadline = Date.now() + 100;
    const probe = await waitForDetachIdentityProof(
      '/does/not/exist-389-identity.sock',
      deadline,
      20,
    );
    expect(probe.servingPid).toBeUndefined();
    expect(probe.statusError).toBeInstanceOf(Error);
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

// ---------------------------------------------------------------------------
// Round-2 review finding 3611470928: every `--detach` outcome we REPORT as a
// failure must actually leave no process behind. Reporting "not started" while
// an unowned daemon keeps serving — indefinitely under `--reap-after-ms 0` —
// makes the error message a lie and sets up the suggested retry to collide
// with the very process this invocation orphaned.
//
// Driven with real, disposable child processes so the terminate-and-confirm
// contract is proven deterministically, with no daemon or socket involved.
// ---------------------------------------------------------------------------
describe('terminateSpawnedDetachedDaemon (round-2 finding 3611470928)', () => {
  const spawnedChildren: ChildProcess[] = [];

  /** A real child that stays alive until signalled. */
  function spawnLongLivedChild(): number {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        stdio: 'ignore',
      },
    );
    spawnedChildren.push(child);
    const pid = child.pid;
    if (pid === undefined) throw new Error('child was not assigned a pid');
    return pid;
  }

  /** A real child that IGNORES SIGTERM, forcing the SIGKILL escalation. */
  function spawnUnkillableChild(): number {
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { stdio: 'ignore' },
    );
    spawnedChildren.push(child);
    const pid = child.pid;
    if (pid === undefined) throw new Error('child was not assigned a pid');
    return pid;
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  afterEach(() => {
    for (const child of spawnedChildren.splice(0)) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });

  it('terminates a live child and confirms it is actually gone', async () => {
    const pid = spawnLongLivedChild();
    expect(isAlive(pid)).toBe(true);

    await expect(terminateSpawnedDetachedDaemon(pid)).resolves.toBe(true);

    // The contract is "confirmed gone", not "signal sent".
    expect(isAlive(pid)).toBe(false);
  });

  // A wedged daemon that swallows SIGTERM would otherwise keep holding the
  // socket after we told the user it was gone.
  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const pid = spawnUnkillableChild();
    expect(isAlive(pid)).toBe(true);

    // A short grace window so the escalation is exercised promptly.
    await expect(terminateSpawnedDetachedDaemon(pid, 300, 25)).resolves.toBe(
      true,
    );

    expect(isAlive(pid)).toBe(false);
  });

  it('is a no-op that reports success when no pid was ever assigned', async () => {
    await expect(terminateSpawnedDetachedDaemon(undefined)).resolves.toBe(true);
  });

  it('reports success for a pid that has already exited', async () => {
    const pid = spawnLongLivedChild();
    process.kill(pid, 'SIGKILL');
    // Wait for the OS to actually reap it before asserting the no-op path.
    const deadline = Date.now() + 2_000;
    while (isAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    await expect(terminateSpawnedDetachedDaemon(pid)).resolves.toBe(true);
  });

  // The guard that keeps a concurrent lazy-boot daemon safe: this helper is
  // only ever handed OUR pid, so a proven-different serving pid is never
  // signalled. Proven here by terminating one child while a second stands in
  // for the daemon that won the socket race.
  it('never signals a process it was not given — a different serving pid survives', async () => {
    const ourPid = spawnLongLivedChild();
    const otherServingPid = spawnLongLivedChild();

    await expect(terminateSpawnedDetachedDaemon(ourPid)).resolves.toBe(true);

    expect(isAlive(ourPid)).toBe(false);
    expect(isAlive(otherServingPid)).toBe(true);
  });
});
