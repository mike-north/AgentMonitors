## 2026-11-05 — Poll admission and live policy ownership (002 §4.6, 004 §2.5) — Refs #537

Extend the existing #556 admission rule explicitly across asynchronous polling and source creation.
A blocked returned poll result retains its original source cursor and handling, finishes the tick
without deadlocking recovery scans, and is admitted under current pacing before later source work.
Factory creation rechecks cancellation/current admission and pins the latest initial snapshot.
Process-local policy caches belong to live work and retire with completion/teardown or ephemeral
lifetime; they do not retain retired instruction history or delete durable holds. Require actual
public-tick/source/SQLite interleavings and bounded lifecycle controls. No durable ordinary recovery
queue or new source outcome is introduced.

