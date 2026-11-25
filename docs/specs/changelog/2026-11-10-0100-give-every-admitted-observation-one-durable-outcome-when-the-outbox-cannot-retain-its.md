## 2026-11-10 — Give every admitted observation one durable outcome when the outbox cannot retain its suffix (002 §2/§2.4/`materialization_retry_outbox`/`observation_history`; 004 §3.4) — Refs #497

Fill a gap in 002: what admission does when the retry outbox rejects a failed observation's ordered
suffix for a reason that would recur on replay. The suffix can be over the per-monitor capacity
(256 rows / 8 MiB, terminal rows included), or an envelope can be outside the outbox's plain-data
domain (BigInt, cycles, nested Dates, ...). Previously the rejection rolled back the whole span,
committed prefix included, and kept the old baseline. The next tick failed identically, so the
monitor stopped for good. The not-due rollup flush also cleared `pendingRollup` before a separate
materialization transaction whose failure an empty catch swallowed, losing the whole held window.

_Current_ rule: every dispatched observation ends in exactly one outcome committed with the
source/notify state. That outcome is an event, a queued retry, or an in-transaction `errored`
row whose error ends `Not retained for retry: <reason>` (capacity, or not serializable). A suffix
is queued whole or not at all. When it cannot be queued, the failed observation is `errored` and
later siblings keep materializing. The baseline advances once every observation has an outcome.
The rollup flush now clears its hold in the same transaction as the flushed span; a rollback
leaves the window held and is reported on the tick result and as an `errored` row.

The 002 §2 sentence "If outbox admission or the state write fails, the outer transaction rolls back
the batch and retains the prior source baseline" is narrowed to storage failures of the outbox or
state write. Those, transaction-wide `RAISE(ROLLBACK)`, and a failure writing the new `errored` row
still roll back and hold the baseline. The `observation_history` Verified lines no longer cite the
removed `consumeWatch()` inner catch; they cite its outer catch, the in-transaction `admitSpan()`
rows and the rollup flush catch. Adds the internal `RuntimeStore.materializationRetryCapacity()`,
the single definition of remaining outbox room shared by enqueue and admission. Verified by
`libs/core/src/runtime/unretainable-suffix-admission.test.ts`.

