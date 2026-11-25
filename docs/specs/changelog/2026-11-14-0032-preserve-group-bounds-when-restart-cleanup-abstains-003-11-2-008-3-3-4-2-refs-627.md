## 2026-11-14 — Preserve group bounds when restart cleanup abstains (003 §11.2; 008 §3.3, §4.2) — Refs #627

Withhold remaining cleanup signals for a recorded group with a verified watchdog when any member has unreadable
ownership, changed identity or unavailable readers. Record the group-bound preservation
reason in the existing per-PID abstention receipt. Vetoes persist through the sweep's
bounded discovery passes. Keep per-process signal authority and reap fully verified groups,
including their watchdogs. Native macOS stock-shell restart/deadline coverage and portable
injected Linux-reader regressions verify that a readable watchdog cannot lose its bound
because another member is unverified.

