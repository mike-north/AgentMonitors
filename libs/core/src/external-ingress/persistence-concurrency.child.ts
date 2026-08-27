import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { InboxDb } from '../inbox/db.js';
import * as schema from '../inbox/schema.js';
import { RuntimeStore } from '../runtime/store.js';
import { RECEIPT_NOW, receiptInput } from './persistence.fixtures.js';

const waitCell = new Int32Array(new SharedArrayBuffer(4));

function sleep(milliseconds: number): void {
  Atomics.wait(waitCell, 0, 0, milliseconds);
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function waitForPeerCall(filePath: string): void {
  const deadline = Date.now() + 10_000;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${filePath}`);
    sleep(10);
  }
}

describe('concurrent external receipt child', () => {
  it('submits one side of the synchronized duplicate race', async () => {
    const directory = process.env['AGENTMON_CONCURRENCY_DIR'];
    const role = process.env['AGENTMON_CONCURRENCY_ROLE'];
    if (!directory || (role !== 'a' && role !== 'b')) {
      throw new Error('Concurrency child environment is incomplete.');
    }
    const peer = role === 'a' ? 'b' : 'a';
    writeFileSync(path.join(directory, `ready-${role}`), 'ready');
    await waitForFile(path.join(directory, `ready-${peer}`));
    writeFileSync(path.join(directory, `calling-${role}`), 'calling');

    const sqlite = new Database(path.join(directory, 'agentmon.db'));
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    const store = new RuntimeStore(
      drizzle(sqlite, { schema }) as unknown as InboxDb,
    );
    const decision = store.withExternalEventReceipt(
      receiptInput(),
      () => {
        waitForPeerCall(path.join(directory, `calling-${peer}`));
        writeFileSync(path.join(directory, `callback-${role}`), 'called');
        sleep(150);
        return { outcome: 'held' };
      },
      RECEIPT_NOW,
    );
    sqlite.close();
    writeFileSync(
      path.join(directory, `result-${role}.json`),
      JSON.stringify({ decision: decision.decision }),
    );
    expect(['accepted', 'duplicate']).toContain(decision.decision);
  }, 15_000);
});
