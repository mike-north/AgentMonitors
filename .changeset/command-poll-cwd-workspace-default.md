---
'@agentmonitors/source-command-poll': minor
---

`cwd` now resolves against the runtime workspace/config root for a project monitor, matching `file-fingerprint`'s existing relative-`cwd`/`globs` resolution: an **absolute** `cwd` is unchanged, a **relative** `cwd` resolves against the workspace root instead of the daemon's own process working directory, and an **omitted** `cwd` now defaults to the workspace root instead of the daemon's own process working directory (a user-level monitor, with no workspace root available, keeps the prior default).

This closes a portability gap: a scaffolded `MONITOR.md` that relied on an absolute `cwd:` baked in at authoring time broke the moment the project was relocated, cloned elsewhere, or shared to another checkout path. Omitting `cwd` (or writing a relative one) now keeps working, since the runtime resolves the workspace root fresh on every tick from wherever `MONITOR.md` was actually found.
