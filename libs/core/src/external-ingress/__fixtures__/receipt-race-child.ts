/**
 * One independent process accepting the same external event as its siblings,
 * across a series of trials. The parent starts several of these once; for each
 * trial it prepares a fresh database and releases all of them together through
 * that trial's barrier file. Starting each process once and reusing it keeps
 * the race's cost in the acceptances rather than in process startup.
 *
 * Protocol, per trial `n` in `0..trials-1`: print `READY n`, wait for
 * `<root>/go-n`, accept the event against `<root>/trial-n/agentmon.db`, then
 * print `RESULT n <json>` with the decision and whether this process's durable
 * work ran, or `ERROR n <json>`. Every wait is self-bounded so a stuck child
 * exits.
 */
import { existsSync, writeSync } from 'node:fs';
import path from 'node:path';
import { createDb } from '../../inbox/db.js';
import { RuntimeStore } from '../../runtime/store.js';
import { receiptInput } from '../persistence.fixtures.js';

const [root, trialArg] = process.argv.slice(2);
const trials = Number(trialArg);
if (root === undefined || !Number.isSafeInteger(trials) || trials < 1) {
  throw new Error(
    'receipt race child requires a root directory and a trial count',
  );
}

/** Block until `file` exists, failing after ten seconds. */
function awaitBarrier(file: string): void {
  const deadline = Date.now() + 10_000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline)
      throw new Error('receipt race barrier timed out');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
  }
}

let failed = false;
for (let trial = 0; trial < trials; trial += 1) {
  const n = String(trial);
  writeSync(1, `READY ${n}\n`);
  awaitBarrier(path.join(root, `go-${n}`));
  let ran = false;
  try {
    const db = createDb(path.join(root, `trial-${n}`, 'agentmon.db'));
    const store = new RuntimeStore(db);
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
    (db as unknown as { $client: { close(): void } }).$client.close();
    writeSync(
      1,
      `RESULT ${n} ${JSON.stringify({
        decision: result.decision,
        ran,
        receiptId:
          result.decision === 'conflict'
            ? result.existingReceiptId
            : result.receipt.receiptId,
      })}\n`,
    );
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: unknown }).code;
    writeSync(1, `ERROR ${n} ${JSON.stringify({ code, message, ran })}\n`);
  }
}
process.exitCode = failed ? 1 : 0;
