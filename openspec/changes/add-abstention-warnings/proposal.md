## Why

When the daemon leaves a suspected-ours process alone because it could not confirm the process's
identity (an abstention), a diagnostics record alone is not enough: the user would never learn that
something may be leaking. Abstentions are the safe failure mode only if they are visible, durable,
and honest about their uncertainty. Refs #507.

Source: 008 §6.1 (including its informative warning example and test implications), 008 §2.2
state 4, §12 (row "Every abstention produces a durable, honest, user-visible warning").

## What Changes

- Every abstention produces an active, durable, user-visible warning — not merely a diagnostics
  record — retrievable via `agentmonitors doctor` and delivered into the next active lead session
  through the normal delivery machinery.
- An abstention with no session open (typical for a startup sweep) persists across daemon restarts
  and surfaces when a user surface next exists; it never silently expires.
- Warnings are calibrated: they name what was left alone (pid, observed identity marks, why
  confirmation failed), state uncertainty plainly, and tell the user what they can do.
- The same abstained process observed across N ticks/sweeps yields one warning, re-raised only on
  meaningful change.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `reliability/process-hygiene`: adds the abstention warning surface, its no-session persistence,
  calibrated wording, and deduplication.

## Impact

- Code: `libs/core/src/runtime/*` (durable abstention records, projection into lead sessions),
  `apps/cli/src/commands/doctor.ts` (abstention section), restart sweep / cleanup paths that
  produce abstentions.
- Principles: PP1 (durable signals: the warning survives restarts), PP4 (session-aware delivery into
  lead sessions), PP7 (per `principles`). Delivery uses the normal machinery
  owned by `delivery/session-projection` and `delivery/lifecycles`; the `doctor` surface is owned by
  `cli/doctor`. Abstentions are produced by `add-restart-sweep-and-stray-collection` (#478) and
  `verify-identity-before-cleanup-signals` (#479).
- Contradictions resolved: none.
- Persistence: a new durable record of abstentions (see the `persistence/schema` capability for the
  schema contract once defined). Changesets for `@agentmonitors/core` and `@agentmonitors/cli`;
  api-report regeneration if public types change.
