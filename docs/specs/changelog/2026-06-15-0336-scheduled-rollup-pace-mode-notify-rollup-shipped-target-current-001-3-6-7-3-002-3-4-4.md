## 2026-06-15 — Scheduled-rollup Pace mode (`notify: rollup`) shipped: target → current (001 §3.6, §7.3; 002 §3, §4.4, §4.5; roadmap G12) — Refs #170

Implements roadmap **G12** (capability C44, §S5.2). The third Pace mode is now **current**, not
target. Behavior change to the published `@agentmonitors/core` package and its public types, so a
changeset accompanies this change.

- **001 §3.6 — `notify: rollup` (now current).** `agentmonitors validate` accepts a `rollup`
  monitor that supplies a required five-field cron `window` (optional IANA `timezone`, default
  `UTC`) and rejects `strategy: rollup` without `window`. Verified against `rollupNotifySchema` in
  `libs/core/src/schema/monitor-schema.ts` (third arm of the `notifySchema` discriminated union).
  The §7.3 daily-digest example and the §3.4 shape list are updated to reference it.

- **002 §4.4 — runtime semantics (now current).** `dispatchRollup()` in
  `libs/core/src/runtime/service.ts` accumulates each observation into a durable
  `notifyState.pendingRollup` batch (no settle-driven `dueAt` reset), evaluates the author's
  `window` cron each tick via `cronMatchesDate` in the configured timezone, and flushes the whole
  batch as a composite delivery — clearing accumulation — only on a non-empty window. An empty
  window produces no delivery (no empty pings). One `monitor_events` row per accumulated
  observation.

- **002 §3 / §4.5 — persisted state + Pace reference (now current).** The accumulation batch is
  the new `PendingRollupState` (`libs/core/src/runtime/types.ts`), persisted in
  `monitor_state.notify_state`. It survives a daemon restart and reuses the §3 `effectiveUrgency`
  hydration backfill (issue #109) so a restart-recovered envelope never materializes an undefined
  urgency. The §4.5 four-mode Pace table is now fully current.

- **Tests** enforce all five G12 proof criteria: schema accept/reject
  (`libs/core/src/schema/monitor-schema.test.ts`), `validate` accept/reject through the real CLI
  (`apps/cli/src/commands/cli.integration.test.ts`), and durable accumulation, window flush+clear,
  empty-window no-delivery, and restart-safety of the batch
  (`libs/core/src/runtime/service.test.ts`, "rollup Pace mode").

