/**
 * One independent process that first-opens a series of fresh databases through
 * `createDb()`. The parent starts several of these once, then runs each trial
 * by releasing all of them together through that trial's barrier file, so
 * their first opens of the trial's fresh path genuinely race. Starting each
 * process once and reusing it for every trial keeps the race's cost in the
 * opens themselves rather than in process startup.
 *
 * Protocol, per trial `n` in `0..trials-1`: print `READY n`, wait for
 * `<root>/go-n`, open `<root>/trial-n/agentmon.db`, then print `RESULT n <json>`
 * with the tables and indexes the open can see, or `ERROR n <json>` with the
 * error that stopped it. Every wait is self-bounded so a stuck child exits.
 */
import { existsSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { createDb } from '../../inbox/db.js';

const [root, trialArg] = process.argv.slice(2);
const trials = Number(trialArg);
if (root === undefined || !Number.isSafeInteger(trials) || trials < 1) {
  throw new Error(
    'first-open child requires a root directory and a trial count',
  );
}

/** Block until `file` exists, failing after ten seconds. */
function awaitBarrier(file: string): void {
  const deadline = Date.now() + 10_000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error('first-open barrier timed out');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
  }
}

let failed = false;
for (let trial = 0; trial < trials; trial += 1) {
  writeSync(1, `READY ${String(trial)}\n`);
  awaitBarrier(path.join(root, `go-${String(trial)}`));
  try {
    const db = createDb(
      path.join(root, `trial-${String(trial)}`, 'agentmon.db'),
    );
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
    writeSync(1, `RESULT ${String(trial)} ${JSON.stringify(names)}\n`);
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: unknown }).code;
    writeSync(
      1,
      `ERROR ${String(trial)} ${JSON.stringify({ code, message })}\n`,
    );
  }
}
process.exitCode = failed ? 1 : 0;
