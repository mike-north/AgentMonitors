## 2026-06-09 — `rebaselined` observation outcome and `ObservationResult.outcome` diagnostic

- A new optional field `outcome?: 'rebaselined'` is added to `ObservationResult`
  (`libs/core/src/observation/types.ts`). A source can set this to signal that it advanced its
  persisted baseline to the current point but could not compute a delta (e.g. a gc'd or
  force-pushed prior ref), as opposed to a genuine quiet tick.
- A new `ObservationOutcome` member `'rebaselined'` is added to the union in
  `libs/core/src/runtime/types.ts` and to the drizzle enum in `libs/core/src/inbox/schema.ts`.
- `ingest()` in `service.ts` maps `sourceOutcome: 'rebaselined'` to the new history result, with
  correct precedence: emitted > 0 → `triggered`; else if `rebaselined` → `rebaselined`; else
  observed > 0 → `suppressed`; else → `no-change`.
- The `incoming-changes` source (`plugins/source-incoming-changes`) now sets `outcome: 'rebaselined'`
  on the diff-failure re-baseline path (the `entries === undefined` branch). The other early-return
  paths (not-a-repo, initial baseline, genuine no-advance) are left unchanged.
- `agentmonitors monitor history` help text updated to include `rebaselined` in the result legend.
- [002 §`observation_history`](../002-runtime-delivery.md) and [005 §6](../005-cli-reference.md) updated.
- Issue: [#56](https://github.com/mike-north/AgentMonitors/issues/56).

