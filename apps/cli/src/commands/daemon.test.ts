import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentMonitorRuntime } from '@agentmonitors/core';
import { runLoop } from './daemon.js';
import { callDaemon, daemonAvailable } from '../daemon-ipc.js';

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
