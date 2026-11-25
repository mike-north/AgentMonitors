## 2026-11-06 — Learn legacy identity and reconcile factory-less owned scopes (002 §4.6, 004 §2.5) — Refs #537

A successful unchanged scan learns missing private identity on an existing row without retiring
its guards or changing source baselines. Later known edits can reset retired guards across restart;
no pre-first-scan history is inferred. Failed validation/write does not learn identity.
Factory capability does not exempt existing watcher/poll ownership from startup reconciliation.
Current invalid scope or failed drain blocks live writes; unowned observe-only state remains ordinary
polling work. Require actual public SQLite/reopen proofs and independent narrow reversions.

