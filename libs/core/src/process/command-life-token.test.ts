/** Durable admission commits the private vnode with the nonce, before any later refusal. */
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { CommandProcessJournal } from './command-process-journal.js';

it.skipIf(process.platform !== 'darwin')(
  'commits the life token in the pre-spawn FULL-synchronous admission',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'am-life-'));
    const db = path.join(root, 'db');
    const journal = CommandProcessJournal.open(db, root);
    try {
      expect(journal.lifeToken()).toBeUndefined();
      const env = await journal.environment();
      const token = journal.lifeToken();
      expect(token).toBeDefined();
      if (!token) throw new Error('Missing committed life token');
      expect(existsSync(token.path)).toBe(true);
      const stat = lstatSync(token.path, { bigint: true });
      expect(stat.isFile()).toBe(true);
      expect(stat.mode & 0o777n).toBe(0o600n);
      expect(String(stat.dev)).toBe(token.device);
      expect(String(stat.ino)).toBe(token.inode);
      const sql = new Database(`${db}.commands.sqlite`);
      try {
        // A second connection observes the complete row even if capture refuses
        // next, without spawned() ever recording a numeric hint.
        const row = sql.prepare('SELECT life, vnode FROM command_lives').get();
        expect(row).toEqual({
          life: env.AGENTMONITORS_COMMAND_LIFE,
          vnode: JSON.stringify(token),
        });
        expect(
          sql.prepare('SELECT COUNT(*) AS n FROM command_pids').get(),
        ).toEqual({ n: 0 });
      } finally {
        sql.close();
      }
      expect(await journal.environment()).toEqual(env);
      expect(journal.lifeToken()).toEqual(token);
      expect(readdirSync(path.dirname(token.path))).toEqual([
        path.basename(token.path),
      ]);
    } finally {
      journal.close();
    }
  },
);

/** A file surviving failed admission is inert until a life row commits its tuple. */
it.skipIf(process.platform !== 'darwin')(
  'grants no signal authority after token creation but before life-row commit',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'am-gap-'));
    const db = path.join(root, 'db');
    const journal = CommandProcessJournal.open(db, root);
    const sql = new Database(`${db}.commands.sqlite`);
    sql.exec(
      "CREATE TRIGGER refuse_life BEFORE INSERT ON command_lives BEGIN SELECT RAISE(ABORT, 'injected admission crash'); END",
    );
    try {
      await expect(journal.environment()).rejects.toThrow(
        'injected admission crash',
      );
      expect(journal.lifeToken()).toBeUndefined();
      expect(
        sql.prepare('SELECT COUNT(*) AS n FROM command_lives').get(),
      ).toEqual({ n: 0 });
      const directory = `${db}.commands.sqlite.tokens`;
      const files = readdirSync(directory);
      expect(files).toHaveLength(1);
      const fd = openSync(path.join(directory, files[0] ?? ''), 'r');
      const child = spawn('/bin/sleep', ['30'], {
        cwd: root,
        stdio: ['ignore', 'ignore', 'ignore', fd],
      });
      try {
        await once(child, 'spawn');
        journal.close();
        const restarted = CommandProcessJournal.open(db, root);
        const kill = vi.spyOn(process, 'kill');
        try {
          const receipt = await restarted.sweep();
          expect(receipt).toMatchObject({ status: 'complete', outcomes: [] });
          expect(kill).not.toHaveBeenCalled();
          expect(child.exitCode).toBeNull();
          expect(child.signalCode).toBeNull();
        } finally {
          kill.mockRestore();
          restarted.close();
        }
      } finally {
        closeSync(fd);
        if (child.exitCode === null && child.signalCode === null) {
          const exit = once(child, 'exit');
          child.kill('SIGKILL');
          await exit;
        }
      }
    } finally {
      journal.close();
      sql.close();
    }
  },
);
