/** Two owned processes exercise a stale pre-lock read against a real writer. */
import { existsSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import {
  createDb,
  RuntimeStore,
  SourceRegistry,
  AgentMonitorRuntime,
} from '../../index.js';
const [rootArg, role] = process.argv.slice(2);
if (!rootArg) {
  throw new Error('Owned probe requires a workspace path.');
}
const root = rootArg;
function waitFor(name: string) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path.join(root, name))) {
    if (Date.now() >= deadline)
      throw new Error(`race barrier ${name} timed out`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
const db = createDb(path.join(root, 'state.sqlite'));
// Test instrumentation uses the store's own connection, never another descriptor.
const client = (db as unknown as { $client: Database }).$client;
let paused = false;
class ObservedStore extends RuntimeStore {
  override getMonitorState(monitorId: string, workspacePath: string | null) {
    const state = super.getMonitorState(monitorId, workspacePath);
    // Delay an actual completed read, never synthesize state. A correct drain
    // cannot trust this snapshot when it later acquires the writer boundary.
    if (
      role === 'peer' &&
      !paused &&
      !client.inTransaction &&
      state.notifyState.pendingRollup
    ) {
      paused = true;
      writeSync(1, 'READ\n');
      waitFor('start-peer');
    }
    return state;
  }
}
if (role === 'owner') {
  client.function('owner_barrier', () => {
    writeSync(1, 'LOCKED\n');
    waitFor('release-owner');
    return 0;
  });
  client.exec(
    'CREATE TEMP TRIGGER owner_pause AFTER INSERT ON monitor_events WHEN (SELECT COUNT(*) FROM monitor_events) = 2 BEGIN SELECT owner_barrier(); END',
  );
}
const registry = new SourceRegistry();
registry.register({
  name: 'edit-source',
  stateful: true,
  scopeSchema: { type: 'object' },
  observe() {
    return Promise.resolve({ observations: [] });
  },
});
const store = new ObservedStore(db);
if (role === 'peer') store.getMonitorState('held', root);
const runtime = new AgentMonitorRuntime(store, registry);
const result = await runtime.tick(path.join(root, 'monitors'), root);
writeSync(1, `RESULT ${JSON.stringify(result.emittedEventIds)}\n`);
client.close();
