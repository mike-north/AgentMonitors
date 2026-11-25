## 2026-11-12 — Preserve late forks after natural parent exit (008 §4.2; 004 §3.5.1a) — Refs #478

A target that vanishes before signalling retains its life and group suspicion and triggers
fresh bounded discovery, just as a sent signal does. Marked late forks still require fresh boot,
mark and start-time evidence; unavailable identity produces an abstention. A later empty snapshot
can retire the life. Regressions compare durable and returned receipts, cover each late-fork gate,
and protect PID-only admission occupancy with a guard mutation failure.

