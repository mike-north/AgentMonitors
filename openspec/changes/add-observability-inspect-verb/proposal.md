## Why

An agent (or a human operator) can already see **received** events and **pending** (unread) events
via `events list [--unread]`, but there is no surface for the third state: a condition the daemon
has **detected** but is deliberately **holding** before delivery (a settle/debounce/throttle/rollup
window, or a recorded `net`/Interpret suppression). Without it, "a change is coming" is
indistinguishable from "nothing happened", and the only way to learn when it will fire is to poll —
which PP9 forbids. Every hold is already recorded durably, so this is a pure read over existing state.

Refs #259 (Epic: multi-host, agent-facing direction). Roadmap gap G18.

Source: 007 §5.1–§5.3, NP-AF (§1), §6 (observability three-bucket distinctness); 005 §14.5.

## What Changes

- Add `agentmonitors inspect [--session <id>] [--socket <path>] [--format <format>]`, returning for a
  session three distinct buckets in one read: **received** (claimed or acknowledged), **pending**
  (unread — fired, waiting), and **armed-but-not-yet-fired** (detected, held).
- Derive the armed bucket solely from the existing durable hold substrate (high-urgency settle,
  debounce, throttle, scheduled rollup, `net` collapse, Interpret suppression); report each armed
  entry's hold reason and, where deterministic, its earliest possible fire time.
- `inspect` is a pure read (no claim/ack/cursor advance) and covers ephemeral and persistent monitors
  identically (AP7).

Does not resolve a spec/code contradiction (target; verified: no `inspect` command or daemon method
exists in `apps/cli/src`). It does reconcile a wording difference between sources: 007 §5.3 says
each armed entry SHOULD report its hold reason and earliest fire time, while 005 §14.5 states it
does; the delta adopts 005's unconditional wording (see design.md).

## Capabilities

### New Capabilities

- `agent/observability`: the received / pending / armed observability model and the `inspect` verb.

### Modified Capabilities

<!-- none -->

## Impact

- Principles relied on: PP4, PP7 (C12 "why nothing fired is inspectable"), PP9, SP4, BP2, AP7, NP5.
- `libs/core/src/runtime/store.ts` (armed-set read over `monitor_state.notify_state` and
  `session_event_state`), `libs/core/src/runtime/service.ts`, `apps/cli/src/commands/inspect.ts`,
  `apps/cli/src/daemon-ipc.ts`; reuses the `monitor explain` hold substrate (per the `daemon/ipc`
  and `cli/monitor-commands` capabilities).
- Published `@agentmonitors/cli` (and possibly `@agentmonitors/core`) — changeset, api-report.
- `apps/website` docs for `inspect`.
