## 2026-07-15 — Onboarding-doc corrections: baseline race, one-shot hook-deliver, isolated-socket `doctor` (Refs #376)

No numbered-spec behavior change — the runtime already behaved as described below; only
`apps/website/public/skill.md` and `apps/website/src/pages/docs/getting-started.md` were corrected
to say so accurately. A blind usability evaluation found three gaps in the Phase 5 ("prove it
fires") verification recipes:

- **Baseline race, undocumented for every source but `command-poll`.** Confirmed against
  `libs/core/src/runtime/service.ts`'s `scheduleForMonitor` (a monitor with no prior observation is
  always "due," so a source's very first tick runs immediately when the daemon starts, before
  waiting `--poll-ms`) and each bundled source's `observe()`: `file-fingerprint`, `api-poll`, and
  `incoming-changes` — like `command-poll` — treat that first tick as a silent baseline (no _change_
  observation emitted; `command-poll` is a partial exception — a first-ever command that fails still
  surfaces a health observation on that tick); a change that lands before it completes is folded
  into the baseline and never detected. `schedule` has no baseline concept. Both docs now state this
  per source and the verify recipes wait one full poll interval after daemon start before
  triggering, for every source.
- **The `hook deliver` step in the "Prove it" recipe was a single invocation**, not a retry loop,
  even though a `high`-urgency monitor's ~15s claim-settle window (002 §9.1) makes an
  empty first result expected. It's now a retry loop mirroring the `events list` poll loop above it,
  confirmed against `apps/cli/src/commands/hook.ts` (`hook deliver` prints nothing at all —
  zero-byte stdout, not an empty JSON object — when nothing is yet claimable).
- **`doctor`/`monitor explain` after the isolated-socket recipe.** Both docs now note that the
  Phase 5 / "Prove it, right now" recipes run against an explicit `--socket`/`AGENTMONITORS_DB`, so
  a plain `agentmonitors doctor` right after a successful verify is expected to still report the
  monitor unobserved — confirmed against `apps/cli/src/commands/doctor.ts` and
  `apps/cli/src/commands/monitor-test.ts`'s `explain` subcommand, both of which auto-discover the
  workspace's own socket/database (falling back to the shared global default only when the
  workspace isn't enabled) and never resolve the recipe's throwaway `--socket`/`AGENTMONITORS_DB`,
  though both still honor `AGENTMONITORS_DB` when it's set in their environment.

