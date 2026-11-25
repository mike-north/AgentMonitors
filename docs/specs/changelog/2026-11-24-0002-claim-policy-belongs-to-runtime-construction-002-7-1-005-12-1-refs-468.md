## 2026-11-24 — Claim policy belongs to runtime construction (002 §7.1, 005 §12.1) — Refs #468

Coordination reads and rewrites retain raw `claim-ttl-ms` text without applying it. Runtime/store
construction remains strict, with no invalid-value fallback. An invalid replacement on disk no longer
blocks lifecycle operations against a live daemon or disabled-workspace quick exits. Offline history
uses its storage workspace's policy independently of its optional query filter; omitted `--workspace`
keeps the global audit tail in cwd's selected database even with a different `CLAUDE_PROJECT_DIR`.
Built-CLI and local-state tests verify these boundaries.

