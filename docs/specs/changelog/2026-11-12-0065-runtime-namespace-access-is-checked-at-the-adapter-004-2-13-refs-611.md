## 2026-11-12 — Runtime namespace access is checked at the adapter (004 §2.13; Refs #611)

Make real per-uid and legacy socket namespace access fatal at the test adapter,
with path/stack diagnostics and synchronous run receipts that survive caught
errors and child exits. Children carry the receipt capability in the preload URL.
Use a read-only net-only observer for the shared real namespace: additions,
removals, and replacements fail; directory metadata and observed transient churn
are reported. Native observation has explicit run lifetime and best-effort names.
This supersedes the prior unconditional runtime-directory metadata failure while
preserving strict data/config/state and foreign-held regular-file rules.

