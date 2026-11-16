/** A restricted PID needs its own exact inherited vnode; argv and siblings grant no proof. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { CommandProcessJournal } from './command-process-journal.js';
import {
  readDarwinCommandMarks,
  withDarwinCommandMarkReader,
} from './darwin-command-marks.js';

it.skipIf(process.platform !== 'darwin')(
  'proves a restricted process only through its own exact journaled vnode',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'am-vnode-λ-🦉-'));
    const filename = path.join(root, 'life');
    const fd = openSync(filename, 'wx', 0o600);
    const stat = fstatSync(fd, { bigint: true });
    const token = {
      life: '00000000-0000-4000-8000-000000000626',
      path: realpathSync(filename),
      device: String(stat.dev),
      inode: String(stat.ino),
    };
    const marked = spawn('/bin/sleep', ['30'], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'ignore', fd],
    });
    const unrelated = spawn(
      '/bin/sh',
      // A blocking builtin keeps the mark in this restricted shell's argv;
      // it neither forks a child nor inherits the life-token descriptor.
      ['-c', 'read -r marker', `AGENTMONITORS_COMMAND_LIFE=${token.life}`],
      { cwd: root, stdio: ['pipe', 'ignore', 'ignore'] },
    );
    try {
      await Promise.all([once(marked, 'spawn'), once(unrelated, 'spawn')]);
      if (marked.pid === undefined || unrelated.pid === undefined)
        throw new Error('Missing fixture PID');
      const pids = [marked.pid, unrelated.pid];
      await withDarwinCommandMarkReader(async () => {
        const result = await readDarwinCommandMarks(pids);
        expect(result.supported && [...result.marks]).toEqual([
          [marked.pid, token.life],
        ]);
        expect(result.supported && result.unreadable).toContain(unrelated.pid);
      }, [token]);
      // A matching pathname alone must never override mismatched kernel identity.
      await withDarwinCommandMarkReader(async () => {
        const result = await readDarwinCommandMarks(pids);
        expect(result.supported && result.marks.size).toBe(0);
      }, [{ ...token, inode: String(stat.ino + 1n) }]);
      // An unjournaled file contributes nothing even while a restricted PID holds it.
      const unjournaled = await readDarwinCommandMarks(pids);
      expect(unjournaled.supported && unjournaled.marks.size).toBe(0);
      // A surviving open descriptor cannot substitute for the reserved on-disk
      // token after its pathname disappears. Never recreate it for an old life.
      unlinkSync(filename);
      await withDarwinCommandMarkReader(async () => {
        const missing = await readDarwinCommandMarks(pids);
        expect(missing.supported && missing.marks.size).toBe(0);
        expect(
          missing.supported && missing.unreadableReasons?.get(marked.pid ?? 0),
        ).toMatch(/file is unavailable/);
      }, [token]);
    } finally {
      closeSync(fd);
      for (const child of [marked, unrelated]) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }
      }
    }
  },
  20_000,
);

it.skipIf(process.platform !== 'darwin')(
  'preserves readable absent and conflicting environment marks even with the exact vnode',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'am-vread-'));
    const filename = path.join(root, 'life');
    const fd = openSync(filename, 'wx', 0o600);
    const stat = fstatSync(fd, { bigint: true });
    const token = {
      life: '00000000-0000-4000-8000-000000000626',
      path: realpathSync(filename),
      device: String(stat.dev),
      inode: String(stat.ino),
    };
    const controls = [false, true].map((conflicting) =>
      spawn(
        process.execPath,
        ['-e', 'setInterval(()=>{},1000);process.send("ready")'],
        {
          cwd: root,
          env: {
            PATH: '/usr/bin:/bin',
            ...(conflicting
              ? { AGENTMONITORS_COMMAND_LIFE: 'conflicting-life' }
              : {}),
          },
          stdio: ['ignore', 'ignore', 'ignore', fd, 'ipc'],
        },
      ),
    );
    try {
      await Promise.all(controls.map((child) => once(child, 'message')));
      const pids = controls.map((child) => {
        if (child.pid === undefined)
          throw new Error('Missing readable fixture PID');
        return child.pid;
      });
      await withDarwinCommandMarkReader(async () => {
        const reading = await readDarwinCommandMarks(pids);
        expect(reading.supported && [...reading.marks]).toEqual([
          [pids[1], 'conflicting-life'],
        ]);
        expect(reading.supported && reading.unreadable).toEqual([]);
        expect(reading.supported && reading.vnodes?.size).toBeUndefined();
      }, [token]);
    } finally {
      closeSync(fd);
      for (const child of controls) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }
      }
    }
  },
  20_000,
);

/** A token's physical existence cannot repair absent journal evidence. */
it.skipIf(process.platform !== 'darwin')(
  'abstains from a vnode holder whose life row is without vnode metadata',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'am-vlegacy-'));
    const db = path.join(root, 'db');
    const first = CommandProcessJournal.open(db, root);
    let fd: number | undefined;
    try {
      await first.environment();
      const token = first.lifeToken();
      if (!token) throw new Error('Missing fixture life token');
      fd = openSync(token.path, 'r');
      const child = spawn('/bin/sleep', ['30'], {
        cwd: root,
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', fd],
      });
      try {
        await once(child, 'spawn');
        if (child.pid === undefined)
          throw new Error('Missing legacy fixture PID');
        first.spawned(child.pid);
        const sql = new Database(`${db}.commands.sqlite`);
        try {
          sql.prepare('UPDATE command_lives SET vnode=NULL, owner=?').run(
            JSON.stringify({
              pid: 2147483647,
              pgid: 2147483647,
              startTime: 'dead fixture owner',
            }),
          );
        } finally {
          sql.close();
        }
        const restarted = CommandProcessJournal.open(db, root);
        const kill = vi.spyOn(process, 'kill');
        try {
          const receipt = await restarted.sweep();
          expect(kill).not.toHaveBeenCalled();
          expect(child.exitCode).toBeNull();
          expect(child.signalCode).toBeNull();
          expect(receipt.outcomes).toContainEqual(
            expect.objectContaining({
              pid: child.pid,
              status: 'abstained',
              reason: expect.stringMatching(/unreadable|ownership/i),
            }),
          );
        } finally {
          kill.mockRestore();
          restarted.close();
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      first.close();
    }
  },
  25_000,
);
