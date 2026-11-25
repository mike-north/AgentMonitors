## 2026-07-14 — Watch-mode source-state checkpointing implemented (002 §2.4 target → current) — Refs #278

The watch-checkpoint core contract (002 §2.4, landed as _target_ via the #192 design pass) is now
implemented, unblocking a durable `file-fingerprint` watch mode: an active `watch()` source can now
durably write back its advancing change-detection state so a mid-watch daemon crash reconciles from
the last checkpointed baseline instead of re-emitting already-delivered changes. All entries below
are _current_.

- **002 §2.4 — target → current.** `ObservationContext` gains the optional
  `checkpoint?: (nextState: unknown) => Promise<void>` callback, supplied **only** on the `watch()`
  path (never `observe()`, which keeps using `ObservationResult.nextState`). Calling it durably
  writes the updated state into `monitorState.sourceState` for the watcher's own
  `(monitorId, workspacePath)` scope (002 §3, #345/#307), leaving notify state and
  `lastObservationAt` untouched. A checkpoint is a **state write only** — it never materializes or
  delivers an observation.
- **002 §2.4 — current, G14 serialization.** The runtime enqueues **both** checkpoint writes and
  `ingest()` on a single per-watcher promise chain, so a checkpoint whose durable write is in flight
  when an observation arrives completes **before** that observation is ingested (the G14
  durable-write-before-ingest ordering), and an ingest's read-modify-write of `sourceState` never
  interleaves with a checkpoint write of the same row.
- **002 §2.4 — current, failure isolation.** A checkpoint whose durable write throws MUST NOT abort
  the watcher: the runtime logs a `process.stderr` warning naming the monitor and resolves the
  callback, so even a source that does not guard `checkpoint()` keeps watching (a transient
  durability gap, not a protocol violation).
- **002 §2.4 — current, post-stop rejection.** A checkpoint delivered after the watcher's
  `AbortSignal` is aborted, or after the watcher is no longer the current active watcher for its
  monitor id, is **rejected** (one warning, no write) so a straggling `checkpoint(staleState)` can
  never clobber a newer baseline. Watcher shutdown flushes the serialization chain to a stable
  reference, so an in-flight checkpoint enqueued as shutdown begins is still awaited.
- **002 §2.3 — behavior fix (current).** A watcher **MUST** be released from the active-watcher set
  whenever it exits for **any** reason, including the `watch()` iterable completing normally — not
  only on error or `stop()`/abort. Previously a normally-completing (finite) `watch()` left its id
  permanently pinned, starving `observe()` forever and blocking any future `watchMonitors()` from
  re-establishing it. Each active-watcher slot now carries a per-watcher identity token
  (`Map<string, symbol>`) so a superseded watcher only ever releases its **own** slot, never a newer
  watcher's — this is also what makes the §2.4 post-stop rejection safe against a watcher that was
  superseded (not aborted). The "runtime does not persist a watcher's in-memory state" note also now
  cross-references §2.4: a source that opts into checkpointing has its state reconciled from the last
  checkpointed baseline on restart.
- **002 §2.4 — bugfix, pre-`try` setup leaked the active-watcher slot on a synchronous throw.**
  `consumeWatch`'s `getMonitorState` read, `watchConfig`, and the `watch()` invocation itself
  originally ran BEFORE the function's `try`, so a synchronous throw there (e.g. `SQLITE_BUSY`, or a
  source whose `watch()` validates its config and throws before ever returning an iterable — legal
  per the `ObservationSource.watch` type) rejected the watcher task's promise without ever reaching
  the `finally`, leaking the slot forever (silently darkening the monitor, with `onError` never
  firing). Fixed by hoisting that setup inside the `try`.
- **Verified by** `libs/core/src/runtime/service.test.ts`
  (`describe('watch-mode source-state checkpointing (002 §2.4)')`): checkpoint supplied on `watch()`
  and persisted-before-resolve; absent on the `observe()` path; in-flight, genuinely-delayed
  checkpoint ordered before a following ingest (the G14 serialization); checkpoint materializes no
  `monitor_events`; a failing checkpoint warns and the watcher survives; a real-SQLite restart
  round-trip reconciles a re-established watcher from the checkpointed baseline; a per-workspace
  checkpoint never mutates another workspace's row for the same monitor id; a post-stop checkpoint is
  rejected with a warning and no write; a normally completing `watch()` releases its active-watcher
  slot so `observe()` resumes; a `watch()` that throws synchronously before returning an iterable also
  releases its active-watcher slot (rather than leaking it) and is still reported via `onError`; and a
  superseded (non-aborted) watcher's stale checkpoint is rejected by the token comparison alone
  without touching its successor's persisted baseline. Public-type change shipped with an
  api-extractor rollup regeneration and a minor `@agentmonitors/core` changeset (the umbrella
  `agentmonitors` launcher re-exports nothing from `@agentmonitors/core`, so it is not part of this
  changeset; `updateInternalDependencies: "patch"` cascades it a patch bump automatically).

