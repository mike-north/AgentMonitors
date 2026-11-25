## 2026-11-06 — Fresh authored admission and balanced deferred handoffs (002 §4.6, 004 §2.5) — Refs #537

Directory discovery can outlive the definition it read while another monitor awaits. Clarify the
synchronous per-file revalidation boundary immediately before reconciliation, including stale
missing/invalid diagnostics; no generation history or live source restart is introduced. Deferred
handoff releases its retained cache lease even when argument access fails before ingestion. Its
error describes the already committed drain rather than claiming old holds remain. Require actual
public tick/startup overlap, SQLite faults/reopen, live-owner controls and independent repair reversions.

