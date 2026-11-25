## 2026-10-30 — Reject proxy serialization and validate before route reads (002 outbox, 004 §3.4) — Refs #483

Retry envelopes exclude proxies, including revoked proxies, before reflection or property reads.
This closes an accepted-value conversion where a proxy could expose an unvalidated toJSON hook
only when JSON.stringify read it. Full envelope validation now precedes route traversal so monitor
and watch-type accessors are rejected without running their getters. Regression tests prove no
proxy traps/getters run and no valid sibling is persisted for each unsupported case.

