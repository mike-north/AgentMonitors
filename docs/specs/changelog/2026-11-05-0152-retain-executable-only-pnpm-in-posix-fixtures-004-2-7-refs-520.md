## 2026-11-05 — Retain executable-only pnpm in POSIX fixtures (004 §2.7) — Refs #520

The compatibility wrapper retains inherited PATH when pnpm has no discoverable JavaScript launcher. Its actual nested suites exercise the existing POSIX executable fallback, including real workspace dependency rewriting and the Corepack-context control.

