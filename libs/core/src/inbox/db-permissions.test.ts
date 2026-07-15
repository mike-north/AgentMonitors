/**
 * Owner-only permission tests for the SQLite database and its WAL/SHM sidecars
 * (issue #292).
 *
 * Persistence holds private snapshot/event/diff data, so the database file, its
 * `-wal`/`-shm` sidecars, and the containing directory must be owner-only even
 * when created under a permissive umask. Each test sets an explicit `0o022`
 * umask so the assertions prove the hardening rather than passing trivially.
 *
 * @see https://www.sqlite.org/wal.html (WAL/SHM sidecar files)
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from './db.js';

const isWindows = process.platform === 'win32';

function modeOf(target: string): number {
  return statSync(target).mode & 0o777;
}

describe.skipIf(isWindows)(
  'createDb — owner-only persistence (issue #292)',
  () => {
    let tmpDir: string;
    let originalUmask: number;

    beforeEach(() => {
      originalUmask = process.umask(0o022);
      tmpDir = mkdtempSync(path.join(tmpdir(), 'am-db-perms-'));
    });

    afterEach(() => {
      process.umask(originalUmask);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('creates the database, WAL and SHM sidecars owner-only in an owner-only directory', () => {
      const dbPath = path.join(tmpDir, 'data', 'inbox.db');
      createDb(dbPath);

      expect(modeOf(path.dirname(dbPath))).toBe(0o700);
      expect(modeOf(dbPath)).toBe(0o600);

      // WAL mode + the schema writes create the sidecars while the connection is
      // open; they carry the same private data, so they must be owner-only too.
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      expect(existsSync(`${dbPath}-shm`)).toBe(true);
      expect(modeOf(`${dbPath}-wal`)).toBe(0o600);
      expect(modeOf(`${dbPath}-shm`)).toBe(0o600);
    });

    it('tightens a database left world-readable by an earlier version on next open (migration)', () => {
      const dbPath = path.join(tmpDir, 'legacy', 'inbox.db');

      // Simulate a pre-#292 database: created, then left world-readable in a
      // world-readable directory.
      mkdirSync(path.dirname(dbPath), { recursive: true });
      createDb(dbPath);
      chmodSync(path.dirname(dbPath), 0o755);
      chmodSync(dbPath, 0o644);
      expect(modeOf(dbPath)).toBe(0o644);

      // Re-opening must migrate the modes forward.
      createDb(dbPath);
      expect(modeOf(path.dirname(dbPath))).toBe(0o700);
      expect(modeOf(dbPath)).toBe(0o600);
    });

    it('does not touch modes for an in-memory database', () => {
      // Regression: the :memory: path must skip all filesystem hardening and not
      // throw (there is nothing to chmod).
      expect(() => createDb(':memory:')).not.toThrow();
    });
  },
);
