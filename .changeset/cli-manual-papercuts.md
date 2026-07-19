---
'@agentmonitors/cli': minor
---

Smooth three manual-CLI papercuts on the no-plugin path:

- `agentmonitors daemon run --detach` backgrounds the daemon and returns, printing its pid, socket, and log path (`--log` overrides the default `<workspace data dir>/daemon.log`). It composes with `--reap-after-ms 0` for a daemon that stays up while no agent session is open, and `init` now points manual users at this form instead of a terminal-occupying `daemon run`.
- `hook deliver` now writes a one-line stderr diagnostic when it delivers nothing specifically because no per-workspace socket is configured, instead of gating that explanation behind `--debug`. Its stdout stays byte-identical in every mode; a workspace that is not enabled remains silent.
- `events list`/`events ack` help summaries state that `--session <id>` is required, so it no longer has to be discovered from a runtime error.
