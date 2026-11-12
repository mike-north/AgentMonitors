/** Owned kill-probe child: real SQLite barriers bracket the edit drain commit. */
import { writeSync } from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import {
  createDb,
  RuntimeStore,
  SourceRegistry,
  AgentMonitorRuntime,
} from '../../index.js';
const [rootArg, boundary] = process.argv.slice(2);
if (!rootArg) {
  throw new Error('Owned probe requires a workspace path.');
}
const root = rootArg;
const db = createDb(path.join(root, 'state.sqlite'));
// Test instrumentation uses the store's own connection, never another descriptor.
const client = (db as unknown as { $client: Database }).$client;
const registry = new SourceRegistry();
registry.register({
  name: 'edit-source',
  stateful: true,
  scopeSchema: { type: 'object' },
  observe() {
    return Promise.resolve({ observations: [] });
  },
});
if (boundary === 'before') {
  // A bounded synchronous function stops SQLite after a later batch write while
  // the writer transaction is still open. The parent kills only this child pid.
  client.function('edit_barrier', () => {
    writeSync(1, 'BEFORE\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20_000);
    throw new Error('parent did not terminate the owned probe in time');
  });
  client.exec(
    'CREATE TEMP TRIGGER barrier AFTER INSERT ON monitor_events WHEN (SELECT COUNT(*) FROM monitor_events) = 2 BEGIN SELECT edit_barrier(); END',
  );
}
const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry);
await runtime.tick(path.join(root, 'monitors'), root);
writeSync(1, 'AFTER\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20_000);
client.close();
