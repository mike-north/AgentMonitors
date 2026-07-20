---
'@agentmonitors/cli': minor
---

Smooth three manual-CLI papercuts on the no-plugin path:

- `agentmonitors daemon run --detach` backgrounds the daemon and returns, printing its pid, socket, and log path (`--log` overrides the default `<workspace data dir>/daemon.log`; it now errors if given without `--detach`, instead of being silently ignored). It composes with `--reap-after-ms 0` for a daemon that stays up while no agent session is open, and `init` now points manual users at this form instead of a terminal-occupying `daemon run`. On success it now verifies the daemon actually serving the socket is the one it spawned (a concurrent lazy-boot elsewhere can occasionally win the race), reporting the other daemon's real pid/reap setting if not; a readiness timeout now kills the unmanaged child instead of leaving it running, and a spawn failure is reported immediately with its real cause instead of after a full timeout.
- `agentmonitors daemon status` now reports the daemon's `pid` and `reapAfterMs` (0 = disabled) alongside its existing session/event counts, in both text and `--format json` output.
- `hook deliver` now writes a one-line stderr diagnostic when it delivers nothing specifically because no per-workspace socket is configured, instead of gating that explanation behind `--debug`. It distinguishes a workspace that has never had a session start from one whose automatic boot just failed (the latter points at automatic retry, not a manual command). Its stdout stays byte-identical in every mode; a workspace that is not enabled remains silent.
- `events list`/`events ack` help summaries state that `--session <id>` is required, so it no longer has to be discovered from a runtime error.
