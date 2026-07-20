/**
 * Run `fn` over `items` with at most `limit` invocations in flight at once,
 * preserving input order in the returned array (issue #304). This is a
 * bounded worker pool: `limit` workers pull items off a shared cursor, so a
 * completed fetch's slot is immediately taken by the next queued item instead
 * of waiting for a fixed batch to finish.
 *
 * Fails fast (issue #304 review, finding 3): the moment ANY invocation
 * rejects, the whole call rejects with that error — it does not wait for
 * other in-flight invocations to settle first. Each worker only checked a
 * shared `failed` flag *between* items in an earlier version of this
 * function, so a part that failed instantly (e.g. a 401) still had to wait
 * for every OTHER in-flight sibling to finish (up to their own full
 * deadline) before the batch surfaced the failure — re-lengthening exactly
 * the tick this concurrency bound exists to shorten. Racing a dedicated
 * failure promise against the worker pool (rather than polling a flag)
 * closes that gap: the race settles as soon as the first rejection lands,
 * regardless of what any other worker is doing.
 *
 * `fn` receives an `AbortSignal` that aborts as soon as the batch is doomed
 * (the first invocation has rejected), so a caller that wires the signal into
 * its own request/process (as `api-poll`'s `fetchBody` does) can cancel
 * in-flight siblings instead of leaving them to run to their own timeout.
 * Aborting a sibling AFTER it has already failed on its own is harmless — the
 * first failure has already won the race and is what this function rejects
 * with; a sibling's abort-triggered rejection is swallowed internally by its
 * own worker and never overwrites the surfaced error.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  // `limit` currently only ever arrives as a positive integer constant
  // (`MAX_COMPOSITE_CONCURRENCY`), but this is a shared helper — a future
  // caller passing 0/negative/non-integer would otherwise make `workerCount`
  // (below) 0, silently resolving with an array of uninitialized entries and
  // never invoking `fn` for any item. Fail loudly instead of losing work.
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `mapWithConcurrency: limit must be a positive integer, got ${String(limit)}`,
    );
  }

  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;
  const batchController = new AbortController();

  // A dedicated promise that rejects the instant the first worker fails,
  // raced below against the worker pool as a whole. `Promise.all(workers)`
  // never itself rejects (each worker catches its own error internally), so
  // this failure promise is the only rejection path — the race settles as
  // soon as it does, without waiting for `Promise.all` to also settle.
  let rejectOnFailure!: (err: unknown) => void;
  const firstFailure = new Promise<never>((_resolve, reject) => {
    rejectOnFailure = reject;
  });
  // A rejection nobody awaits still logs as an "unhandled rejection" unless
  // it has a catch handler attached somewhere; `Promise.race` below IS that
  // await, but attach a no-op handler defensively so this promise is never
  // unhandled even if `items` is empty and no worker is ever spawned.
  firstFailure.catch(() => {
    // Intentionally empty: real handling happens via the `Promise.race` below.
  });

  async function worker(): Promise<void> {
    for (;;) {
      if (batchController.signal.aborted) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        // `index < items.length` was just checked, so this element exists.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        results[index] = await fn(items[index]!, batchController.signal);
      } catch (err) {
        // Whichever concurrent worker fails first "wins" the surfaced error:
        // `rejectOnFailure` on an already-settled promise is a documented
        // no-op, so a second (or later) failing worker's error is discarded —
        // the caller only needs to know the batch failed and see *an* error
        // from it, not necessarily the temporally-first one across a race.
        batchController.abort();
        rejectOnFailure(err);
        return;
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  const allSettled = Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  );

  await Promise.race([allSettled, firstFailure]);
  return results;
}
