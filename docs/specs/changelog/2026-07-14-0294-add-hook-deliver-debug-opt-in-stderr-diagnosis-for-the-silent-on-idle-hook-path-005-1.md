## 2026-07-14 — Add `hook deliver --debug`: opt-in stderr diagnosis for the silent-on-idle hook path (005 §12.2.1, 006 §5.2.1) — Refs #334

Blind DX study S3 F3 (High): `agentmonitors hook deliver` emits empty stdout + exit 0 both when
nothing is pending AND when the stdin payload is misconfigured (unknown session, workspace not
enabled, urgency held) — indistinguishable failure modes for the command most often run by an
invisible hook system. §5.1's silence-on-idle stdout contract is correct and unchanged; the gap was
that there was no way to ask "why" without breaking it.

- **006 §5.2.1 — new (current).** `--debug` writes a step-by-step diagnosis to **stderr only**,
  naming which §5.2 resolution step stopped (or succeeded) and, once a session is resolved, pending
  event counts by urgency plus a per-band hold reason: `settle-window` (002 §9.1), `already-claimed` /
  `coalesced-until-ack` (the SAME vocabulary the `monitor explain` reminder-suppression diagnosis
  uses, 002 §9.2/§9.3/§10.7, issue #333), or `deferred-by-cap` (issue #299's transport-owned cap
  sizing). Stdout is required to be byte-identical between a `--debug` run and a non-`--debug` run of
  the same payload against the same daemon state.
- **005 §12.2.1 — new (current).** The CLI-reference mirror of the above, plus the flag added to
  §12.2's option table.
- **No behavior change to stdout, exit codes, or hook wiring** (explicit non-goal) — `--debug` adds
  one extra read-only daemon call (`hook.diagnose`, a new pure `AgentMonitorRuntime.diagnoseHookDelivery`)
  before the existing claim; it never claims or mutates state.

