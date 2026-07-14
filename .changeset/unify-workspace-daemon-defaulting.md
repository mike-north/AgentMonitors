---
'@agentmonitors/core': patch
'@agentmonitors/cli': patch
'agentmonitors': patch
---

Fix `agentmonitors doctor` disagreeing with `session list`/`daemon status` about whether a lead session exists, when the daemon was started directly via `agentmonitors daemon run` (the Getting Started guide's own documented usage) rather than lazily booted by a Claude Code hook.

A directly-invoked `daemon run`/`daemon once` — with no `--socket`/`AGENTMONITORS_DB`/`AGENTMONITORS_SOCKET` overrides — used to bind to the bare global default database and socket, while `doctor` already assumed an enabled workspace gets its own isolated, derived per-workspace database. `session open`, `session list`, and `daemon status` all talked to the live daemon directly and correctly showed an active lead session; `doctor` independently re-derived a different, empty database and reported no lead session at all.

`daemon run`/`daemon once` now resolve their database and socket the same per-workspace-aware way `doctor` and `session start`'s lazy boot already do, so a directly-started daemon is visible to every other workspace-aware command. `daemon status`/`daemon stop` (previously socket-only) now share the same resolution too, so they keep agreeing after this fix. `session open --workspace` is now resolved to an absolute path (matching `doctor`), and doctor's `lead-session` failure now names the exact workspace path it searched so a future mismatch is self-diagnosing.
