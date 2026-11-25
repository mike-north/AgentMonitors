## 2026-11-07 — Keep nested-only retry details visible in text explain (005) — Refs #496

Text explain selects recognized materialization retry details when a partial compatibility report
omits the optional top-level summary. It preserves structured omission, existing stage reasons and
verdict, and canonical top-level precedence; available safe record details appear once. Empty or
absent summaries and unrelated stage details do not fabricate or duplicate records.

