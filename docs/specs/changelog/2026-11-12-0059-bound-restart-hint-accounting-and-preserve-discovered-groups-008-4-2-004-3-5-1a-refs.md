## 2026-11-12 — Bound restart hint accounting and preserve discovered groups (008 §4.2; 004 §3.5.1a) — Refs #478

Batch gone-PID decisions before further asynchronous work instead of rewriting the receipt per
hint. Awaited admissions retire empty numeric group suspicions while preserving possible
survivors, unavailable discovery and the life nonce for marked detached work. Per-hint bookkeeping
changes protect refreshed work from older admission snapshots while unrelated empty hints still retire. Newly discovered
marked groups gain durable suspicion before any anchor signal, preserving later unmarked
survivor accounting across reopenings without granting numeric signal authority. Regressions
cover 12,001 gone hints under two seconds, bounded admission retention, discovered-group reopen
accounting, and both PID and reason dedupe boundaries with mutation failures.

