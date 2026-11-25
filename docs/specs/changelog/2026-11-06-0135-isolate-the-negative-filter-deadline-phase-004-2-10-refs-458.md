## 2026-11-06 — Isolate the negative filter deadline phase (004 §2.10) — Refs #458

The negative filter driver selects exactly one actual canonical PR-review invocation,
rather than spending both canonical filters' separate 1,000ms budgets inside one
4-second driver watchdog. Both positive canonical controls still execute. The fixture
asserts one owned negative command and terminal state before force-cleanup, and reports
child output, phase timestamps and elapsed time on failure. No helper/runtime deadline,
watchdog, retry, positive control or production source changed.

