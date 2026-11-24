/**
 * A newer version marking a database while another process opens it. Holds
 * the write lock, inserts a marker with a capability this version does not
 * know, prints `READY`, keeps the lock for `holdMs`, then commits. An opener
 * that started after `READY` passes its first, lock-free capability check and
 * then waits on the write lock, so only its second check, inside the schema
 * transaction, can see the marker.
 */
import { writeSync } from 'node:fs';
import Database from 'better-sqlite3';

const [dbPath, holdArg] = process.argv.slice(2);
const holdMs = Number(holdArg);
if (dbPath === undefined || !Number.isSafeInteger(holdMs) || holdMs < 0) {
  throw new Error('newer marker writer requires a database path and a hold');
}

const sqlite = new Database(dbPath);
sqlite.exec('BEGIN IMMEDIATE');
sqlite
  .prepare(
    `INSERT INTO database_compatibility_markers
       (id, workspace_identity, capability, created_at)
     VALUES ('newer-marker', '/workspace', 'durable-ingress-v2', 0)`,
  )
  .run();
writeSync(1, 'READY\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
sqlite.exec('COMMIT');
sqlite.close();
