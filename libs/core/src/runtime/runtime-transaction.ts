/**
 * Package-private composition of synchronous runtime persistence operations.
 * RuntimeStore registers its database/cache boundary; the runtime service owns
 * the only operation passed to it. Nothing here is re-exported from the package
 * entrypoint or exposed as a method on the published RuntimeStore class.
 *
 * This is an implementation trust boundary, not a sandbox: SQLite cannot cancel
 * asynchronous JavaScript effects. Only library-owned synchronous operations may
 * enter; Interpret, transports and plugin callbacks stay outside the transaction.
 */

/** An implementation-owned SQLite boundary; its store also restores caches on rollback. */
type RuntimeTransaction = <T>(operation: () => T) => T;

/**
 * Weak registration keeps the database private. Each runner and native liveness
 * predicate belong to the same store-owned SQLite connection; a separate flag
 * could miss SQLite ending a transaction underneath a nested savepoint.
 */
const transactions = new WeakMap<
  object,
  {
    /** Owns synchronous admission and restores the last committed recipient cache on failure. */
    readonly transaction: RuntimeTransaction;
    /** Reads SQLite's actual transaction state without beginning or repairing a transaction. */
    readonly isActive: () => boolean;
  }
>();

/**
 * Register the store's synchronous runner and a read-only native predicate for
 * that same connection. Registration composes library-owned persistence only;
 * it does not expose the connection or accept a source/plugin transaction mode.
 * @internal
 */
export function registerRuntimeTransaction(
  store: object,
  transaction: RuntimeTransaction,
  isActive: () => boolean,
): void {
  transactions.set(store, { transaction, isActive });
}

/**
 * Compose one synchronous admission span. The type excludes an accidentally
 * returned Promise; it does not enforce behavior of hostile JavaScript or undo
 * asynchronous work. Only the service's deterministic closure belongs here.
 * @internal
 */
export function runRuntimeTransaction<T>(
  store: object,
  operation: (() => T) & (T extends PromiseLike<unknown> ? never : unknown),
): T {
  const transaction = transactions.get(store);
  if (!transaction)
    throw new Error('Runtime store transaction is not registered.');
  return transaction.transaction(operation);
}

/**
 * Preserve the original materialization error when SQLite has ended the owning
 * transaction. Retrying a suffix in that state would create an unrelated commit
 * after its successful prefix was rolled back. A live savepoint-local failure
 * remains eligible for ordinary suffix admission.
 * @internal
 */
export function rethrowIfRuntimeTransactionAborted(
  store: object,
  error: unknown,
): void {
  const transaction = transactions.get(store);
  if (!transaction) {
    throw new Error('Runtime store transaction is not registered.');
  }
  if (!transaction.isActive()) {
    throw error;
  }
}
