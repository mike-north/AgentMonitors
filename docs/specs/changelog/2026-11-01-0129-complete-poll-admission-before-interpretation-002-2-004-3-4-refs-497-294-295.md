## 2026-11-01 — Complete poll admission before interpretation (002 §2; 004 §3.4) — Refs #497, #294, #295

Require the entire finite poll span, successful event prefix, ordered retry suffix and source/notify
state to commit before the first optional Interpret invocation. Independent-connection barrier tests
cover multiple recipients, repeated object transitions and empty snapshots. Outer rollback restores
the last committed recipient cache as well as database rows; held notify work survives failed
admission and reopens for replay. Transaction composition stays package-private, preserving the
concrete retry-completion API. The separate watch checkpoint contract is unchanged.

