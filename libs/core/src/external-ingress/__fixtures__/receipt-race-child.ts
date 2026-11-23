/**
 * One independent process accepting the same external event as its siblings.
 * The parent releases every child together through a barrier file against one
 * shared database; each reports the decision it received and whether its
 * durable work ran. Every wait is self-bounded so a stuck child exits.
 */
import { existsSync, writeSync } from 'node:fs';
import { createDb } from '../../inbox/db.js';
import { RuntimeStore } from '../../runtime/store.js';
import { receiptInput } from '../persistence.fixtures.js';

const [dbPath, barrier] = process.argv.slice(2);
if (dbPath === undefined || barrier === undefined) {
  throw new Error('receipt race child requires a database path and a barrier');
}

const store = new RuntimeStore(createDb(dbPath));
writeSync(1, 'READY\n');
const deadline = Date.now() + 10_000;
while (!existsSync(barrier)) {
  if (Date.now() >= deadline) throw new Error('receipt race barrier timed out');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
}

let ran = false;
try {
  const input = receiptInput();
  const result = store.withExternalEventReceipt(input, ({ acceptedAt }) => {
    ran = true;
    const event = store.insertEvent({
      workspacePath: input.workspaceIdentity,
      monitorId: input.envelope.monitorId,
      sourceName: input.envelope.source,
      urgency: 'normal',
      title: 'Race winner',
      body: '',
      summary: 'Race winner',
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey: null,
      baselineStrategy: null,
      queryScope: {},
      tags: [],
      createdAt: acceptedAt,
    });
    return { outcome: 'materialized', eventIds: [event.id] };
  });
  writeSync(
    1,
    `RESULT ${JSON.stringify({
      decision: result.decision,
      ran,
      receiptId:
        result.decision === 'conflict'
          ? result.existingReceiptId
          : result.receipt.receiptId,
    })}\n`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown }).code;
  writeSync(1, `ERROR ${JSON.stringify({ code, message, ran })}\n`);
  process.exitCode = 1;
}
