## 2026-06-15 — `daemon once` distinguishes skipped-not-due monitors from no-monitors-found (002 §2.4, 005 §9.1)

`RuntimeTickResult` gains a `skippedMonitors: { monitorId, nextDueAt }[]` field, populated from the
same scheduling decision that gates evaluation — never recomputed separately. `daemon once` appends a
parenthetical suffix when non-empty: `(N not yet due — next due in Xs)`, reporting
the soonest next-due time. Previously a second `daemon once` run within a monitor's interval printed
`Evaluated 0 monitor(s), emitted 0 event(s).` — identical to the "no monitors found" output, giving
the author a silent dead end (issue #152). The genuine empty/no-monitors path is unchanged.

- **Proof:** `apps/cli/src/commands/cli.integration.test.ts` — `describe('daemon once skipped-not-due
visibility (issue #152)')`: three tests cover (a) skipped suffix on second run, (b) empty-dir
  unchanged, (c) mixed evaluated + skipped counts reported accurately.
- Patch changesets: `@agentmonitors/core` (new `skippedMonitors` field + `SkippedMonitor` type in the
  public surface) and `@agentmonitors/cli` (user-visible tick output suffix).

