## 2026-10-30 — Real-daemon crash recovery acceptance coverage (004 §3.4.1) — Refs #527

Adds an isolated built-CLI SIGKILL/restart test for persisted unread work and same-session identity.
It also verifies dead-daemon diagnostics and the distinction between delivery and acknowledgment.
No runtime behavior changes or automatic restart/supervisor guarantees are introduced.

