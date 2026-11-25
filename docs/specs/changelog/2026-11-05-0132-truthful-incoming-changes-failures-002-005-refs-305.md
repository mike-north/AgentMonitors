## 2026-11-05 — Truthful incoming-changes failures (002–005) — Refs #305

Adopt [decision #555](https://github.com/mike-north/AgentMonitors/issues/555#issuecomment-6665229474):
replace 003 §6.5's silent unavailable result with the existing recoverable source-error contract.
Verify commit-ish refs, capture Git stderr, retain the last-good SHA and notify state, and preserve
quiet missing-old-SHA rebaseline/per-file snapshot omission. Require non-nullish state before a
CLI initial baseline; retain no-files-matched precedence and source-owned primitive states.
History text and explain now include the existing error payload using bounded, terminal-safe
single-line display; stored/structured audit data stays intact. No public outcome, schema or
migration is added. Required tests cover real Git/CLI, SQLite reopen and socket/offline diagnosis.
Existing error retry cadence and held-notify deferral remain unchanged; #558 and #559 track those
separately rather than silently broadening this repair.

