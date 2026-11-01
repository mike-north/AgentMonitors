## Why

A daemon the user leaves running must never be why the machine is warm, slow, or loud. The
daemon's own machinery has no coherent power posture today: nothing guarantees wakes are coalesced,
that idle monitors cost close to nothing, or that sleep/wake does not trigger a thundering
catch-up. Refs #469.

Source: 008 §8 (including its measurement protocol), §12 (row "The monitoring machinery is never
why the machine is warm, slow, or loud").

## What Changes

- The daemon's own machinery — tick loop, scheduling, bookkeeping, transports — is power-friendly by
  design: no busy-spinning, coalesced wakes, event-driven paths preferred over polling where sources
  support them, conditional network requests where the source protocol allows, battery-aware
  intervals where the platform exposes power state, and sleep/wake reconciled without a thundering
  catch-up.
- Idle monitors cost close to nothing.
- A normative wake-count measurement protocol; the numeric per-interval budget is set by #469's
  design work and lands as a number in that existing assertion.
- Unchanged: monitored commands remain the user's own programs; the system governs only their
  time-boundedness (current requirement "No resource governance of monitored commands").

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `reliability/process-hygiene`: adds the daemon power posture and its wake-rate measurement
  protocol.

## Impact

- Code: `libs/core/src/runtime/*` (tick loop, scheduling, timers), source plugins that poll
  (`plugins/source-api-poll` conditional requests), transports.
- Principles: NP4 (event-driven watch paths are opt-in and additive), BP1 (missed windows are not
  replayed), PP7 (per `principles`). Tick scheduling semantics are owned by
  `runtime/tick-scheduling`; this change adds the power constraints on top without changing them.
- Contradictions resolved: none.
- Changesets for affected packages.
