/**
 * Separate processes must observe committed writes through a long-lived database
 * connection. Real child processes are essential: same-process SQLite handles
 * share lock bookkeeping and cannot detect accidentally released POSIX locks.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { createDb } from './db.js';

/** Resolve the same SQLite binding for independently owned child processes. */
const sqliteModule = createRequire(import.meta.url).resolve('better-sqlite3');

it.each([
  'first-open',
  'equivalent-path',
  ...(process.platform === 'win32'
    ? []
    : ['symlinked-directory', 'file-symlink-first', 'file-symlink-later']),
])(
  'observes each independent process commit without warming or reopening the reader (%s)',
  (scenario) => {
    const root = mkdtempSync(path.join(tmpdir(), 'am-db-visibility-'));
    const dbPath = path.join(root, 'state.db');
    const fileAlias = path.join(root, 'linked.db');
    if (scenario === 'file-symlink-first') {
      writeFileSync(dbPath, '');
      chmodSync(dbPath, 0o644);
      symlinkSync(dbPath, fileAlias);
    }
    // The public database is intentionally opaque; this storage-level test needs
    // its native handle to isolate locking from higher-level runtime behavior.
    const client = (
      createDb(
        scenario === 'file-symlink-first' ? fileAlias : dbPath,
      ) as unknown as { $client: Database }
    ).$client;
    try {
      if (scenario === 'file-symlink-first') {
        for (const suffix of ['', '-wal', '-shm']) {
          expect(statSync(`${dbPath}${suffix}`).mode & 0o777).toBe(0o600);
        }
      }
      if (scenario !== 'first-open') {
        // A second spelling must not repeat descriptor-based permission migration
        // while the first SQLite connection owns locks on the same files.
        const alias = path.join(root, 'alias');
        if (
          scenario === 'symlinked-directory' ||
          scenario === 'file-symlink-first'
        ) {
          symlinkSync(root, alias);
        }
        if (scenario === 'file-symlink-later') {
          symlinkSync(dbPath, fileAlias);
        }
        const alternatePath =
          scenario === 'file-symlink-later'
            ? fileAlias
            : scenario === 'symlinked-directory' ||
                scenario === 'file-symlink-first'
              ? path.join(alias, 'state.db')
              : path.relative(process.cwd(), dbPath);
        const other = (
          createDb(alternatePath) as unknown as { $client: Database }
        ).$client;
        other.close();
      }
      client.exec(
        'CREATE TABLE visibility_probe(value INTEGER NOT NULL); INSERT INTO visibility_probe VALUES(0)',
      );
      const observed: unknown[] = [];
      for (let round = 1; round <= 3; round++) {
        execFileSync(
          process.execPath,
          [
            '-e',
            `
        const Database = require(${JSON.stringify(sqliteModule)});
        const client = new Database(process.argv[1]);
        try { client.prepare('UPDATE visibility_probe SET value=value+1').run(); }
        finally { client.close(); }
      `,
            dbPath,
          ],
          { timeout: 15000 },
        );
        expect(client.inTransaction).toBe(false);
        observed.push(
          client.prepare('SELECT value FROM visibility_probe').pluck().get(),
        );
      }
      expect(observed).toEqual([1, 2, 3]);
    } finally {
      client.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it('keeps an uncommitted writer isolated from another process', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'am-db-isolation-'));
  const dbPath = path.join(root, 'state.db');
  // Storage tests inspect the native handle hidden by the public opaque type.
  const client = (createDb(dbPath) as unknown as { $client: Database }).$client;
  try {
    client.exec(
      'CREATE TABLE visibility_probe(value INTEGER NOT NULL); INSERT INTO visibility_probe VALUES(0)',
    );
    client.exec('BEGIN IMMEDIATE; UPDATE visibility_probe SET value=99');
    const result = execFileSync(
      process.execPath,
      [
        '-e',
        `
      const Database = require(${JSON.stringify(sqliteModule)});
      const client = new Database(process.argv[1], { timeout: 100 });
      try {
        const visible = client.prepare('SELECT value FROM visibility_probe').pluck().get();
        let writeError = null;
        try { client.prepare('UPDATE visibility_probe SET value=10').run(); }
        catch (error) { writeError = error.code; }
        process.stdout.write(JSON.stringify({ visible, writeError }));
      } finally { client.close(); }
    `,
        dbPath,
      ],
      { encoding: 'utf8', timeout: 15000 },
    );
    expect(JSON.parse(result)).toEqual({
      visible: 0,
      writeError: 'SQLITE_BUSY',
    });
  } finally {
    if (client.inTransaction) client.exec('ROLLBACK');
    client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/** A dangling alias cannot supply the stable physical identity lock safety needs. */
it.skipIf(process.platform === 'win32')(
  'rejects a dangling database symlink before creating its target',
  () => {
    const root = mkdtempSync(path.join(tmpdir(), 'am-db-dangling-'));
    const target = path.join(root, 'missing.db');
    const alias = path.join(root, 'alias.db');
    try {
      symlinkSync(target, alias);
      expect(() => createDb(alias)).toThrow();
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
