---
'@agentmonitors/cli': patch
'agentmonitors': patch
---

Close the final DX gap on the manual / no-docs CLI path with six small,
thematically-unified ergonomics fixes. No change to runtime notify/debounce timing, delivery
semantics, or any hook **stdout** wire format.

- **`hook deliver`** now writes a one-line diagnostic to **stderr** (without `--debug`) when the
  stdin payload is malformed (no `session_id`) or `hook_event_name` maps to no delivery lifecycle.
  Both previously printed nothing and exited 0 — indistinguishable from "nothing pending." stdout
  stays byte-identical for hook wire compatibility; untrusted payload values are control-safe-escaped.
- **`events list` / `events ack`** — the missing-`--session` error now points at
  `agentmonitors session list` to discover an id, and `--help` repeats the pointer.
- **`session start` / `session end`** now print a one-line success ack on **stderr**
  (`AgentMon: session <id> registered; daemon at <socket>` / `session <id> ended`); stdout stays
  wire-clean.
- **`scan`** now exits **0** for a clean scan and **1** when it surfaces a real problem (a parse
  error or a duplicate monitor id), so `scan && <next-step>` scripts are meaningful. Previously it
  always exited 0.
- **`monitor history`** — passing `--dir` (a flag that means the monitors directory elsewhere, but
  is not history's `--workspace`) now yields a remediation hint pointing at `--workspace` instead of
  a bare `unknown option` error.
- Docs: the `verify --use-workspace-daemon` "presentable proof" recipe now notes that the synthetic
  PASS is not a durable, queryable event and directs a security-proof user to make a real edit +
  deliver it for a persistent artifact.
