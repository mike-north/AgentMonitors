## 2026-11-12 — Shared runtime endpoint differences are report-only (004 §2.13; Refs #611)

Keep runtime namespace access fatal at the attributable Node adapter. The real
per-uid and legacy socket namespace is shared with daemons and other worktrees,
so its endpoint diff cannot attribute writes and no longer fails a run. Report
net-change paths, direction, and before/after identities as well as transient
churn. This supersedes the prior net-change failure rule only for that namespace;
data/config/state/cache guards and the foreign-holder policy remain strict.
Document adapter bypass limits, including non-preloaded external children.

