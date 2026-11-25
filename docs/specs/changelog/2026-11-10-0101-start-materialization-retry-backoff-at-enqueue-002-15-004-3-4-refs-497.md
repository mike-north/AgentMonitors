## 2026-11-10 — Start materialization retry backoff at enqueue (002 §15; 004 §3.4) — Refs #497

New materialization retry rows first become due at least 1 second after they are enqueued, after
source acquisition and prefix materialization, rounded up to SQLite's whole-second precision.
Previously the runtime passed the tick's start time, so slow acquisition consumed the initial delay
(an observation at `12:00:00.000` admitted at `12:00:03.850` was already due at `12:00:01.000`; the
contract requires `12:00:05.000`). Observation, event, envelope, source and notify timestamps remain
observation-time provenance. No public API, schema or retry-schedule change.

A retry row's `createdAt`/`updatedAt` record enqueue time. The `observation_history` contract no
longer says a failed observation leaves the rest of its batch unaffected: the committed prefix stays
and the failed envelope plus later siblings are queued as ordered retries, with `errored` rows
written by `finishMaterializationSpan()`.

A transaction-wide `RAISE(ROLLBACK)` differs: the whole span rolls back, prefix included, nothing
is queued, the source baseline does not advance, and the single `errored` row comes from `tick()`'s
ingest-error catch (or `consumeWatch()`'s outer catch, which also ends the watcher).

