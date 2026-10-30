## Why

`command-poll`'s `json-diff` strategy lets an author list top-level `change-detection.ignore-paths`
(for example a `duration` field) that are stripped before the source decides whether a change
occurred. The runtime's diff renderer is never given those paths and always diffs the raw stored
`snapshotText`, so churn in an ignored field still renders in the delivered `diffText`. In the worst
case that churn pushes the real change past the 20-entry `json-diff` cap and out of the rendered
output entirely, even though change detection correctly ignored the field. The change decision and
the rendered delta disagree about what matters.

Source: 002 §5.2 "Known gap (not yet fixed): `command-poll`'s `ignore-paths` is not carried through
to the renderer" (identified as a follow-up of issue #437). No tracking issue exists yet.

## What Changes

- Carry the object's `ignore-paths` through the persisted snapshot metadata alongside
  `change-detection.strategy`.
- Strip the same fields from both sides before rendering a `json-diff` `diffText`, so the rendered
  delta matches the source's own change decision.
- Apply the same stripping to the per-recipient and claim-time `net` recomputation, which render
  through the same strategy-aware path.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `runtime/event-materialization`: the "Diff rendering of command-poll ignore-paths fields"
  requirement changes from a documented limitation (ignored fields still render) to ignored fields
  being excluded from the rendered diff.

## Impact

- `libs/core/src/runtime/diff.ts` (renderer accepts ignore paths), `libs/core/src/runtime/service.ts`
  and `libs/core/src/runtime/store.ts` (thread the paths from snapshot metadata into every
  `json-diff` render, including the claim-time `net` recomputation).
- `plugins/source-command-poll` must expose `ignore-paths` in the observation's snapshot metadata.
- Principles: relies on PP3/AP3 (source owns change detection, runtime owns diffing) and SP5
  (object-level snapshot history). Resolves a contradiction between the source's change decision
  and the runtime's rendered delta, in favor of the source's declared ignore list.
- Published behavior of `@agentmonitors/core` and `@agentmonitors/source-command-poll` changes
  (changeset required); no public type is expected to change.
