import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnDetachedDaemon } from './detached-spawn.js';
import { daemonAvailable, callDaemon } from './daemon-ipc.js';

// TODO (Plan C): add a UAT that proves the daemon survives PARENT-PROCESS EXIT,
// not just survival of the spawn call. The in-process test below proves
// daemonAvailable() returns true while the test process is still running, but
// it does not prove the daemon keeps running after the parent exits (the real
// requirement for hook-based usage). That will be exercised by the real
// SessionEnd hook in Plan C, or by a subprocess UAT that spawns a short-lived
// "booter" process, waits for the booter to exit, then polls the socket.

describe('spawnDetachedDaemon', () => {
  it('boots a daemon that survives the spawning call and answers on the socket', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-spawn-'));
    const socket = path.join(ws, 'd.sock');
    const db = path.join(ws, 'i.db');
    try {
      spawnDetachedDaemon({
        monitorsDir: path.join(ws, '.claude', 'monitors'),
        workspacePath: ws,
        socket,
        db,
        pollMs: 1000,
      });
      // poll until the daemon answers (it was spawned detached, not awaited)
      const start = Date.now();
      let up = false;
      while (Date.now() - start < 10000) {
        if (await daemonAvailable(socket)) {
          up = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(up).toBe(true);
    } finally {
      try {
        await callDaemon('stop', {}, { socketPath: socket });
      } catch {
        /* ignore */
      }
      rmSync(ws, { recursive: true, force: true });
    }
  }, 15_000);
});
