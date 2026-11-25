## 2026-11-24 — Workspace claim TTL configuration (002 §7.1, 005 §12.1) — Refs #468

The shipped runtime now resolves `claim-ttl-ms` from existing workspace coordination frontmatter.
Daemon run/once and offline readers use the same target-workspace policy. The setting is a positive
safe integer in milliseconds, default 1,800,000; malformed values fail explicitly. Session rewrites
preserve it. Restart a daemon after edits. Daemon IPC and offline-reader tests verify the non-default
lifetime, and the built CLI rejects invalid values. The additive public constructor option is a
minor core change; CLI behavior remains a patch.

