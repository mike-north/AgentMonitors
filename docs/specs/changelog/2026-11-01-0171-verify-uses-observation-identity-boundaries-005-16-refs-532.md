## 2026-11-01 — Verify uses observation identity boundaries (005 §16) — Refs #532

Replace millisecond-versus-second history timestamp comparison with a pre-trigger recording frontier
and a separate trigger-completion frontier for negative evidence. Preserve changes observed during
long commands, exclude earlier same-second rows and intermediate command idle ticks, retain settling
evidence across window rotation, and refuse negative verdicts when history gaps could hide success.
Keep explicit timeout caps and two-distinct-row no-change confirmation. Unit tests use actual persisted
equal-second rows; a real daemon regression waits for durable triggered history before command exit.

