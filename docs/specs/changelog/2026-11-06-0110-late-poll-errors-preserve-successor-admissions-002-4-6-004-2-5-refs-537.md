## 2026-11-06 — Late poll errors preserve successor admissions (002 §4.6, 004 §2.5) — Refs #537

Clarify source exclusion after a poll relinquishes its synchronous admission: its later asynchronous
ingestion error reporting cannot remove a successor's slot or wake work through it. Require public
overlapping ticks, a real SQLite fault, ordered durable reopen and watcher/checkpoint/scope controls.
This does not add ordinary ingestion rollback or a durable recovery queue.

