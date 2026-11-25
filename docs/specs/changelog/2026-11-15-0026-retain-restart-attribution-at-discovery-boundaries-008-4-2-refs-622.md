## 2026-11-15 — Retain restart attribution at discovery boundaries (008 §4.2) — Refs #622

Persist marked groups discovered at the eight-pass limit as numeric suspicions for later
reconciliation. Confirm an initially empty nonce-only life with a second readable snapshot,
retaining it if confirmation is unavailable or ownership is unreadable. Explicitly require
pending disappearance, readable ownership, nonce absence and vacant hints for discharge;
commit anchor-disappearance receipts before rediscovery. Journal regressions exercise these
boundaries without changing per-process signal authority or watchdog preservation.

