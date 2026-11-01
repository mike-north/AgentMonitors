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

/** Weak ownership keeps a store's database private without extending its public interface. */
const transactions = new WeakMap<object, RuntimeTransaction>();

/**
 * Connect a newly constructed store to its implementation-owned transaction boundary.
 * @internal
 */
export function registerRuntimeTransaction(
  store: object,
  transaction: RuntimeTransaction,
): void {
  transactions.set(store, transaction);
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
  return transaction(operation);
}
