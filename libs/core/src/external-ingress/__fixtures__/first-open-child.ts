/**
 * One independent process opening a database through `createDb()`. The parent
 * starts several of these against one fresh path and releases them together
 * through a barrier file, so their first opens genuinely race. The child
 * reports the tables and indexes it can see after its own open returns, or the
 * error that stopped it. Every wait is self-bounded so a stuck child exits.
 */
import { existsSync, writeSync } from 'node:fs';
import type { Database } from 'better-sqlite3';
import { createDb } from '../../inbox/db.js';

const [dbPath, barrier] = process.argv.slice(2);
if (dbPath === undefined || barrier === undefined) {
  throw new Error('first-open child requires a database path and a barrier');
}

writeSync(1, 'READY\n');
const deadline = Date.now() + 10_000;
while (!existsSync(barrier)) {
  if (Date.now() >= deadline) throw new Error('first-open barrier timed out');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
}

try {
  const db = createDb(dbPath);
  // Inspection uses the connection `createDb` opened, never another descriptor.
  const client = (db as unknown as { $client: Database }).$client;
  const names = client
    .prepare<[], { type: string; name: string }>(
      `SELECT type, name FROM sqlite_master
       WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all();
  client.close();
  writeSync(1, `RESULT ${JSON.stringify(names)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown }).code;
  const stack = error instanceof Error ? error.stack : undefined;
  writeSync(1, `ERROR ${JSON.stringify({ code, message, stack })}\n`);
  process.exitCode = 1;
}
