/**
 * Internal connection ownership and narrow runtime-only persistence operations.
 * Keep transaction capabilities and private notify metadata out of the published
 * RuntimeStore surface.
 */
import type { Database } from 'better-sqlite3';
import type { InboxDb } from '../inbox/db.js';
import { runRuntimeTransaction } from './runtime-transaction.js';

/** Store lifetime owns the binding; transaction support never retains a dead store. */
const connections = new WeakMap<object, Database>();

/** Bind a store to its existing driver; never open a second descriptor. @internal */
export function registerStoreWriter(store: object, db: InboxDb): void {
  // InboxDb erases the Drizzle driver from its public API; this is the same
  // concrete connection owned by RuntimeStore, not a separately opened handle.
  connections.set(store, (db as unknown as { $client: Database }).$client);
}

/** Resolve only a registered store's owned connection. @internal */
export function storeWriter(store: object): Database {
  const client = connections.get(store);
  if (!client) {
    throw new Error('Runtime store has no registered writer.');
  }
  return client;
}

/**
 * Own the outer immediate transaction, including reads that decide what to
 * remove. Nested event units use SQLite savepoints; no async work may escape
 * this callback before COMMIT. Joining someone else's transaction is refused.
 *
 * The transaction is the store's registered runtime transaction, the same
 * owned boundary as span admission and the held rollup window flush: a
 * rollback also restores the store's last-projected recipient cache, so a
 * failed drain cannot expose recipients of events it never committed.
 * @internal
 */
export function withStoreWriter<T>(store: object, action: () => T): T {
  const client = storeWriter(store);
  if (client.inTransaction) {
    throw new Error('Notify edit requires an owned writer transaction.');
  }
  const synchronous = (): T => {
    const result = action();
    if (result && typeof result === 'object' && 'then' in result) {
      throw new Error('Notify edit writer callback must be synchronous.');
    }
    return result;
  };
  // The runtime guard rejects a thenable before COMMIT; the runner's
  // compile-time Promise exclusion cannot be proven for an unconstrained `T`.
  return runRuntimeTransaction(
    store,
    synchronous as Parameters<typeof runRuntimeTransaction<T>>[1],
  );
}

/** Enumerate only this workspace's persisted holds, including missing definitions. @internal */
export function heldMonitorIds(store: object, workspacePath: string): string[] {
  // Row shape is fixed by the selected SQLite columns, rather than user input.
  const rows = storeWriter(store)
    .prepare(
      "SELECT monitor_id FROM monitor_state WHERE workspace_path = ? AND (json_array_length(notify_state, '$.pendingDebounce.observations') > 0 OR json_array_length(notify_state, '$.pendingRollup.observations') > 0)",
    )
    .all(workspacePath) as { monitor_id: string }[];
  return rows.map((row) => row.monitor_id);
}

/**
 * Learn private pacing identity on an existing scoped row without changing source
 * representation, observation clocks or accepted work. Caller owns the synchronous
 * writer boundary. UPDATE-only leaves a fresh scope absent until ordinary ingestion
 * establishes its first source baseline; an existing identity is never overwritten.
 * @internal
 */
export function learnNotifyPolicyIdentity(
  store: object,
  monitorId: string,
  workspacePath: string,
  policyKey: string,
): void {
  storeWriter(store)
    .prepare(
      "UPDATE monitor_state SET notify_state = json_set(COALESCE(notify_state, '{}'), '$.policyKey', ?) WHERE monitor_id = ? AND workspace_path = ? AND json_type(notify_state, '$.policyKey') IS NULL",
    )
    .run(policyKey, monitorId, workspacePath);
}

/**
 * Adopt an effective pacing edit on its existing scoped row without interpreting
 * or reserializing source-owned state. The caller's owned writer transaction also
 * contains every held event/projection/snapshot/cursor write: this update removes
 * retired holds and guards in that same commit. Only source ingestion/checkpoints
 * may replace the opaque baseline; a notify-only edit cannot create a state row
 * or change the next observation's previousState, fingerprint or scheduling clock.
 * @internal
 */
export function commitNotifyPolicyEdit(
  store: object,
  monitorId: string,
  workspacePath: string,
  notifyState: unknown,
): void {
  const result = storeWriter(store)
    .prepare(
      'UPDATE monitor_state SET notify_state = ? WHERE monitor_id = ? AND workspace_path = ?',
    )
    .run(JSON.stringify(notifyState), monitorId, workspacePath);
  if (result.changes !== 1) {
    throw new Error('Notify edit requires one existing scoped state row.');
  }
}
