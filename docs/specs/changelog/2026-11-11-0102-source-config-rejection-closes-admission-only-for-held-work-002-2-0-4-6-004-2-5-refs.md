## 2026-11-11 — Source-config rejection closes admission only for held work (002 §2.0/§4.6, 004 §2.5) — Refs #537

Reconcile the source-config preflight with held-work admission. A tick or watcher-startup
rejection closes the scope's admission gate only when it has durable holds or a retained poll
result, so a running watcher cannot commit beside that work under the rejected definition. Without
held work, the rejection never closes admission by itself, so a watcher with open admission keeps
its startup config, while one already blocked stays blocked until valid reconciliation (002 §4.6).
Require tick and rescan
proofs of both cases.

