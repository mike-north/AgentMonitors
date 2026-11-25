## 2026-11-06 — Bound jq commands and release query handles (004 §2.10) — Refs #458

Facility probes and canonical jq reductions now use asynchronous total verdicts within
the unchanged 1,000ms command budget. A hung/broken executable fails rather than becoming
optional omitted coverage; genuine ENOENT retains local skip/CI failure semantics.
Darwin membership queries retain and release their own child streams/reference on
failure or expiry without claiming termination. The Linux disappearing-proc regression
now reaches ENOENT and the fresh group probe under a live initial budget, and rejects
a still-present group; the fresh ESRCH success case remains distinct. No production
source, API, owned scope, aggregate or timeout budget expanded.

