## 2026-06-28 — file-fingerprint observe interval is surfaced in schema, CLI, and docs (003 §3.1; 005 §7, §9) — Refs #204

`file-fingerprint` now documents `watch.interval` in its source schema with the effective `30s`
default. `agentmonitors source list` includes source field descriptions, so the interval knob is
visible alongside `globs` and `cwd`.

Docs now distinguish the per-monitor observe interval from daemon `--poll-ms`: `watch.interval`
controls when a specific monitor is due to re-check files, while `--poll-ms` is only the daemon
loop-wake cadence. No default timing behavior changed.

