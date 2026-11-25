## 2026-11-14 — Commit preservation before terminal queries without aging signal evidence (008 §4.2) — Refs #627

Commit the completed signal batch's preservation abstentions before terminal queries.
The gates' resolved-Promise handoff issues no additional evidence query or journal operation. Keep FULL-sync
journal writes after every signal has used the final identity snapshot, so persistence
cannot introduce a blocking interval before delivery. Persist invalid PID diagnostics
before anchor confirmation. The per-PID authorization checks and selected targets are unchanged.

