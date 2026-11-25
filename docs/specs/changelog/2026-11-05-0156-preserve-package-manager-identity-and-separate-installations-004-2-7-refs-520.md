## 2026-11-05 — Preserve package-manager identity and separate installations (004 §2.7) — Refs #520

Packing resolves pnpm independently of the invoking manager so workspace dependencies remain installable. The install harness discovers npm JavaScript entrypoints from PATH as well as beside Node, preserving shell-free literal arguments across separate installations.

