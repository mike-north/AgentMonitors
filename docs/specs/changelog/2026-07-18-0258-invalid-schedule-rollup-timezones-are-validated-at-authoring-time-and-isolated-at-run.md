## 2026-07-18 — Invalid schedule/rollup timezones are validated at authoring time and isolated at runtime (001 §3.6, 002 §2.2, 003 §5.2) — Refs #297

An invalid IANA `timezone` (e.g. `America/New_Yrok`) on a `schedule` monitor made
`Intl.DateTimeFormat` throw inside `cronFieldValuesForDate()`, and `scheduleForMonitor()` was called
outside the per-monitor `observe()`/`ingest()` try/catches in `tick()` — so the throw escaped and
aborted the **entire** tick, stopping every other monitor. Two-part fix:

- **Authoring-time validation (001 §3.6, 003 §5.2).** `libs/core/src/schema/validate-scope.ts` adds
  `invalidTimezoneError()` / `isValidIanaTimeZone()`, wired into `validateWatchScope()` alongside the
  existing `change-detection.collection` check (003 §12) — so a `schedule` monitor's `scope.timezone`
  is now rejected by `validate`, `monitor test`, and `watch declare` (007 §4.2) with an actionable
  error. The `rollup` notify strategy's `timezone` already had this check
  (`rollupNotifySchema.timezone` in `monitor-schema.ts`); it now shares the same helper.
- **Runtime defensive isolation (002 §2.2).** `PollingDecision` gains an optional `error` field;
  `scheduleForMonitor()` catches a cron-matching failure internally instead of throwing. Every caller
  treats a present `error` as "this monitor cannot be scheduled right now" and isolates it: the tick
  loop records it exactly like an `observe()` failure (isolated per AP, `erroredObservations` +
  `errored` `observation_history` row); the not-due `dispatchRollup()` window-flush path (a `rollup`
  monitor's `notify.timezone`, evaluated independently of `scope.timezone`) gets the same isolation;
  `monitor.explain` (002 §10.7) renders it as an `observation`-stage `failure` computed purely
  in-memory (explain **MUST NOT** mutate state, so no `observation_history` row backs it) instead of
  crashing; `doctor` folds it into `valid`/`validationError`. `monitor-test.ts`'s no-daemon
  `explainMonitorInProcess` fallback (005 §6) also needed a fix: its case-A/B/C heuristic previously
  treated "definition ok, nothing persisted" as always meaning "never ticked" (case C, generic
  remediation) — the new in-memory-only observation failure needed a fourth signal (absence of a
  `scheduling` stage) to route to case A (show the real report) instead.

