## Why

A declarative dependent/sequential monitor chain ("when monitor A fires, arm monitor B") is expected
to be built on top of the ephemeral-monitor mechanic rather than as a parallel system. Today's
ephemeral primitive is declared only by an agent and reaped only by cancel, session close, or
dormancy; it cannot be armed by the daemon when a prior step fires, and it has no notion of being
"satisfied". The primitive must be sufficient for a chain step before the chain-authoring surface
(#124) can be built on it.

Refs #124. Source: 007 §4.7 (first bullet, "Dependent chains"), 007 §8 (verb/flag names — the
deferred fire-condition `--until` flag), 005 §14.4 (closing note: `--until` is target).

## What Changes

- The ephemeral-monitor primitive gains the properties a chain step needs: it can be **armed by the
  daemon** (not only declared by an agent) when a prior step fires, remains **session-scoped**, and
  is **reaped when satisfied** as well as when its session ends.
- The chain-authoring surface itself (how a chain is declared, and the fire-condition / `--until`
  flag that seeds it) is **out of scope** for the primitive and is left to the #124 design; it is
  recorded as an open question, not specified here.

No spec/code contradiction is resolved: 007 §4.7's chain requirement is target (verified:
`apps/cli/src/commands/watch.ts` has no `--until`, and the runtime has no daemon-armed or
satisfied-reap path).

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `agent/ephemeral-monitors`: adds daemon-armed chain-step registration and reap-when-satisfied.

## Impact

- Principles relied on: AP7 (one pipeline, two authoring paths), PP9 (daemon owns all waiting),
  PP1 (durability), SP2 (identity).
- `libs/core/src/runtime/service.ts` / `store.ts` (`ephemeral_monitors` lifecycle), possibly the
  `ephemeral_monitors` schema (per the `persistence/schema` capability).
- Likely `@agentmonitors/core` public types — changeset + api-report; website docs once a chain
  surface ships.
