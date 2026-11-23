/** Durable admission commits the private vnode with the nonce, before any later refusal. */
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { CommandProcessJournal } from './command-process-journal.js';

// Model failed cleanup without changing filesystem permissions for the host.
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    unlinkSync: vi.fn(actual.unlinkSync),
    fsyncSync: vi.fn(actual.fsyncSync),
  };
});

afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(unlinkSync).mockReset().mockImplementation(actual.unlinkSync);
});

it.skipIf(process.platform !== 'darwin')(
  'commits the life token in the pre-spawn FULL-synchronous admission',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'am-life-'));
    const db = path.join(root, 'db');
    const journal = CommandProcessJournal.open(db, root);
    try {
      expect(journal.lifeToken()).toBeUndefined();
      await expect(journal.environment()).resolves.toHaveProperty(
        'AGENTMONITORS_COMMAND_LIFE',
      );
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
      // A failed release models the inert reservation a crash can also leave.
      vi.mocked(unlinkSync).mockImplementationOnce(() => {
        throw new Error('injected release failure');
      });
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

/** A handled storage failure must not poison subsequent admission on the same owner. */
it
  .skipIf(process.platform !== 'darwin')
  .each(['released', 'release-failed', 'replaced'])(
  'recovers on the same journal after INSERT failure with reservation %s',
  async (cleanup) => {
    const root = mkdtempSync(path.join(tmpdir(), 'am-retry-'));
    const db = path.join(root, 'db');
    const directory = `${db}.commands.sqlite.tokens`;
    const journal = CommandProcessJournal.open(db, root);
    const sql = new Database(`${db}.commands.sqlite`);
    let reserved = '';
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(fsyncSync).mockImplementation((fd) => {
      actual.fsyncSync(fd);
      if (
        reserved ||
        !existsSync(directory) ||
        readdirSync(directory).length === 0
      )
        return;
      reserved = path.join(directory, readdirSync(directory)[0] ?? '');
      if (cleanup === 'replaced') {
        // The old inode stays allocated so this is certainly a different file.
        renameSync(reserved, path.join(root, 'original'));
        writeFileSync(reserved, 'replacement');
      }
    });
    sql.exec(
      "CREATE TRIGGER refuse_life BEFORE INSERT ON command_lives BEGIN SELECT RAISE(ABORT, 'injected INSERT failure'); END",
    );
    try {
      if (cleanup === 'release-failed')
        vi.mocked(unlinkSync).mockImplementationOnce(() => {
          throw new Error('injected unlink failure');
        });
      await expect(journal.environment()).rejects.toThrow(
        'injected INSERT failure',
      );
      expect(journal.lifeToken()).toBeUndefined();
      expect(
        sql.prepare('SELECT COUNT(*) AS n FROM command_lives').get(),
      ).toEqual({ n: 0 });
      expect(readdirSync(directory)).toHaveLength(
        cleanup === 'released' ? 0 : 1,
      );
      if (cleanup === 'replaced') expect(existsSync(reserved)).toBe(true);
      sql.exec('DROP TRIGGER refuse_life');
      await expect(journal.environment()).resolves.toHaveProperty(
        'AGENTMONITORS_COMMAND_LIFE',
      );
      const env = await journal.environment();
      const token = journal.lifeToken();
      expect(token).toBeDefined();
      expect(token?.path).not.toBe(reserved);
      expect(
        sql.prepare('SELECT life, vnode FROM command_lives').all(),
      ).toEqual([
        { life: env.AGENTMONITORS_COMMAND_LIFE, vnode: JSON.stringify(token) },
      ]);
      expect(readdirSync(directory)).toHaveLength(
        cleanup === 'released' ? 1 : 2,
      );
      // A committed life is stable; retries never rotate or repair its authority.
      expect(await journal.environment()).toEqual(env);
      expect(journal.lifeToken()).toEqual(token);
    } finally {
      vi.mocked(fsyncSync).mockImplementation(actual.fsyncSync);
      journal.close();
      sql.close();
    }
  },
);

/** SQLite FAIL may retain an inserted row even while reporting an error to the caller. */
it.skipIf(process.platform !== 'darwin')(
  'preserves a life row and token retained by an INSERT that reports failure',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'am-retained-'));
    const db = path.join(root, 'db');
    const directory = `${db}.commands.sqlite.tokens`;
    const journal = CommandProcessJournal.open(db, root);
    const sql = new Database(`${db}.commands.sqlite`);
    sql.exec(
      "CREATE TRIGGER fail_after_life AFTER INSERT ON command_lives BEGIN SELECT RAISE(FAIL, 'injected retained INSERT'); END",
    );
    try {
      await expect(journal.environment()).rejects.toThrow(
        'injected retained INSERT',
      );
      const rows = sql.prepare('SELECT * FROM command_lives').all();
      expect(rows).toHaveLength(1);
      expect(journal.lifeToken()).toBeUndefined();
      const files = readdirSync(directory);
      expect(files).toHaveLength(1);
      const retained = path.join(directory, files[0] ?? '');
      const identity = lstatSync(retained, { bigint: true });
      sql.exec('DROP TRIGGER fail_after_life');
      await expect(journal.environment()).resolves.toHaveProperty(
        'AGENTMONITORS_COMMAND_LIFE',
      );
      // A retry creates its own life, never reconstructing the retained tuple.
      expect(journal.lifeToken()?.path).not.toBe(retained);
      expect(
        sql.prepare('SELECT COUNT(*) AS n FROM command_lives').get(),
      ).toEqual({ n: 2 });
      expect(readdirSync(directory)).toHaveLength(2);
      expect(lstatSync(retained, { bigint: true }).ino).toBe(identity.ino);
      expect(
        sql
          .prepare('SELECT * FROM command_lives WHERE life != ?')
          .all(journal.lifeToken()?.life),
      ).toEqual(rows);
    } finally {
      journal.close();
      sql.close();
    }
  },
);
