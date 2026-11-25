## 2026-11-13 — Ambiguous initial argv and reused native buffers (008 §4.2) — Refs #618

Count argv immediately after the executable path's terminator, abstaining on any
additional NUL rather than guessing whether it is padding or an empty first argument.
Native empty-first-argument and crafted padded/title-rewrite layouts must preserve
ownership or explicit uncertainty, including durable discovery abstentions. Exercise
the exact embedded bridge with full, shorter, failed and differently marked replies;
only sysctl's returned byte count may supply a PID's evidence.

