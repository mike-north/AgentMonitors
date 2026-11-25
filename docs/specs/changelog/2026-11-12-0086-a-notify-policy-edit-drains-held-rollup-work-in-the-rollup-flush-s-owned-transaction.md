## 2026-11-12 — A notify-policy edit drains held rollup work in the rollup flush's owned transaction (002 §4.4/§4.6; 004 §3.4) — Refs #498

Compose the locked not-due rollup flush with effective notify-policy edits. An edit that changes
rollup pacing drains the held batch outside any window, which is a held rollup flush. Its writer
boundary now runs as the store's registered runtime transaction, the same owned boundary as the
window flush and span admission, so a failed drain also restores the last-projected recipient
cache instead of leaving recipients of events it never committed. Previously the drain's SQLite
writes rolled back but that in-memory cache did not. The drain stays all-or-nothing (no prefix
commits, no suffix is retained, no drop is recorded), still refuses to join an externally owned
transaction and still rejects an asynchronous callback. The not-due window flush runs only after
the tick's edit reconciliation has succeeded and the admission gate is open, in the same
synchronous turn as that gate check. It keeps the private pacing identity it reads under the lock.
No public API change.

