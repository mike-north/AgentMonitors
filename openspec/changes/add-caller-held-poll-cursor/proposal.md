## Why

Poll sources (`command-poll`, `api-poll`) re-read the full upstream state on every due tick and rely
on snapshot comparison to notice change. If poll cost ever measurably bites, the principled
optimization adopted in #81 is a **caller-held cursor**: the source threads a cursor through the
polled command so the tool answers "what changed since `<cursor>`?" — without output caching, mtime
gating, or hidden cross-invocation state inside the tool.

Refs #81. This is a **sketch-only** target: explicitly not v1, not a prerequisite for `command-poll`
or keyed-collection change detection, and deliberately **not** a roadmap item. It is to be designed
fully only against observed poll cost. (Unrelated to the Cursor editor host adapter, roadmap G20.)

Source: 003 §13; roadmap note under G20; glossary "Poll cursor / source cursor protocol".

## What Changes

- A poll source MAY carry a caller-held cursor in its existing per-monitor `nextState` slot (the
  stateful baseline of PP6); the polled tool stays stateless.
- `command-poll` gains a `cursor` block: `initial` (cursor value for the first run) and `next-state`
  (a path extracted from the parsed output after each run); a `{{state}}` placeholder in `command`
  is templated with the current cursor.

Principles: relies on PP6 (stateful baseline-then-detect) and PP3 (change detection stays in the
source; the runtime still owns diffing and delivery). Resolves no existing contradiction.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `sources/contract`: poll sources may thread a caller-held cursor through `nextState`.
- `sources/command-poll`: `cursor` block and `{{state}}` argv templating.

## Impact

- `plugins/source-command-poll` (scope schema, argv templating, cursor extraction); possibly a shared
  helper in `libs/core` if `api-poll` adopts the same protocol.
- Gated on a poll-cost measurement; no implementation work starts before that gate.
- Published packages: `@agentmonitors/source-command-poll` (changeset); `apps/website` docs.
