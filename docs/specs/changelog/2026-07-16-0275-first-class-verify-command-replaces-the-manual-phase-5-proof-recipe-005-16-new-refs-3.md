## 2026-07-16 — First-class `verify` command replaces the manual Phase-5 proof recipe (005 §16, new) — Refs #399

The manual "prove it, right now" verification recipe (getting-started + skill.md Phase 5) was the
single most concentrated DX liability across four rounds of blind usability evaluation: it demanded
an expert shell dance (custom `--socket`, scratch `AGENTMONITORS_DB`, backgrounded daemon with
`trap` cleanup, hand-built hook JSON payloads, two poll loops with two different budgets, two
session-id concepts) and broke down for nearly every struggling subject — fixed-40s poll loops that
under-shot the 30s-default interval, an undocumented `suppressed` state, a `doctor` false-negative
against the recipe's throwaway socket, and silent daemon death. Two subjects explicitly asked for a
single command.

- **005 — new §16, "`verify` — Prove a monitor delivers end-to-end."** Adds a **top-level**
  `agentmonitors verify [monitor]` (sibling of `doctor`, not a `monitor` subcommand — it is an
  active, stateful, daemon-booting proof, not a read-only inspector). It boots a **supervised
  isolated daemon** (temp socket + db, reaping disabled) by default, registers a throwaway lead
  session, triggers a **real** change (auto scratch-file for file-fingerprint pattern globs, a
  restored-on-exit edit for literal globs, or `--manual` watch mode), polls with an
  **interval-aware budget derived from the monitor's own `interval` + notify settle (+ high-urgency
  15s claim-settle) + margin** (not a fixed 40s) while printing elapsed/ETA to stderr, interprets
  the observation pipeline in plain language (`triggered` = success; `no-files-matched` = fail-fast;
  `no-change` = fail-fast **unless** a `debounce`/`throttle` settle is holding the change, in which
  case a `suppressed` row keeps the wait alive until the flush `triggered` rather than being a
  distinct reported outcome; **`daemon-died`** surfaces the daemon's own error), confirms delivery
  via the **real `hook deliver` claim path**, and prints one clean **PASS** (echoing the delivered
  `additionalContext`) or **FAIL** (naming the failing stage — the stage that was actually in flight
  on a mid-run daemon crash). It tears down everything it created; `--use-workspace-daemon` instead
  targets and leaves running the real workspace daemon so a follow-up `doctor` reflects the delivery.
  The detection-budget override flag is `--timeout-ms` (milliseconds, matching the `--poll-ms` /
  `--reap-after-ms` convention).
- **005 §16 → §17 renumber.** The former "Exit codes & diagnostics" section is now §17 (no other
  doc references it by number; mirrors the earlier §15/§16 renumber when `doctor` was added).
- **Fix (current).** Implemented in `apps/cli/src/commands/verify.ts` with pure helpers in
  `verify-budget.ts` (interval/settle budget, scratch-path derivation) and `verify-report.ts`
  (PASS/FAIL renderers), wired into the CLI command tree next to `doctor`. The budget's interval /
  settle inputs come from a new canonical `schedulingDefaults` export in `@agentmonitors/core` (the
  same values `service.ts` schedules against), so the estimate can't drift from real scheduling;
  literal-vs-pattern glob classification and scratch-path derivation use the real `glob` matcher's
  `hasMagic` (so `?`, `[…]`, and `{…}` are recognized as wildcards, not just `*`). The
  getting-started / skill.md recipe replacement (demoting the manual recipe to an appendix) is a
  deliberate follow-up, not part of this change.
- **Verified by** `apps/cli/src/verify-budget.test.ts` (spec-derived budget math + glob→scratch-path
  derivation, including non-`*` glob magic), `apps/cli/src/verify-report.test.ts` (PASS / stage-named
  FAIL / distinct `daemon-died` rendering), `apps/cli/src/commands/verify.test.ts` (mid-run crash
  blames the in-flight stage), `libs/core/src/runtime/scheduling-defaults.test.ts` (defaults pinned
  to 002 §4.4/§9.1), and `apps/cli/src/commands/verify.integration.test.ts` (real file-fingerprint
  change → PASS with delivered `additionalContext` and scratch cleanup; a `debounce` monitor still
  reaching PASS despite `no-change` ticks while it settles; `no-change` and `budget-exceeded` FAILs
  naming the correct stage; monitor-not-found / ambiguous setup errors).

