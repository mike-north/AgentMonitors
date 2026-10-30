## Why

A `notify: { strategy: rollup }` monitor delivers only when its `window` cron opens (e.g. once each
weekday at 09:00), so observing it at low latency buys nothing: a 30-second `watch.interval` on a
daily digest spends observation cost and tokens without changing the delivery outcome. The runtime
deliberately does not enforce the coupling (current behavior), but authors get no signal when they
pair a rollup with a needlessly tight cadence.

Source: 001 §3.6 "Interaction with observation cadence" (marked target): "tooling SHOULD surface a
hint when a rollup monitor's `interval` is set tighter than its delivery window." Capability study
C44 / §S5.2. No issue is filed for this yet.

## What Changes

- Authoring tooling (`agentmonitors validate`) surfaces a non-fatal hint when a `rollup` monitor's
  `watch.interval` is tighter than its delivery `window`, suggesting a relaxed interval (e.g. `1h`).
- The hint never fails validation and never changes cadence; the runtime still does not enforce the
  coupling.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `monitor/definition`: adds the rollup cadence hint requirement alongside the existing
  "Rollup does not couple observation cadence" requirement.

## Impact

- Principles: PP5 (user-controlled delivery; the hint advises, never overrides), BP3, AP6 (the CLI
  surfaces what the core defines).
- Overlaps `cli/authoring-commands` (owner of `validate` output shape); that capability should
  reference this hint when the change is implemented.
- Code: `apps/cli` `validate` (hint output in text/JSON/TOON formats); possibly a core helper that
  computes the minimum gap between `window` openings.
- Does not resolve a contradiction.
