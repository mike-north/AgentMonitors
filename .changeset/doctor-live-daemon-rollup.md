---
'@agentmonitors/cli': patch
---

Fix `agentmonitors doctor` under-reporting a monitor's `last-observed`/`last-event`/delivery counts
after a real delivery against a live daemon. `doctor` previously always read its per-monitor rollup
in-process, even when a daemon was reachable; a separate reader connection opened against the same
SQLite file as a live writer's connection can lag behind that writer's commits, freezing the rollup
at a stale snapshot. `doctor` now prefers the live daemon's own connection (a new `doctor.report`
socket RPC, mirroring `monitor explain`/`monitor history`) whenever one is reachable, falling back to
the in-process read only when the daemon is unreachable.

Also fixes `doctor` exiting non-zero for checks that are expected to fail when idle: `daemon-reachable`
and `lead-session` now use a distinct `idle` status (glyph `◇`) instead of `fail` when no agent
session is currently open, and `idle` no longer counts toward a non-zero exit code — only a genuine
`fail` does. Text and JSON output report a new `idle` count alongside `passed`/`failed`/`skipped`.
