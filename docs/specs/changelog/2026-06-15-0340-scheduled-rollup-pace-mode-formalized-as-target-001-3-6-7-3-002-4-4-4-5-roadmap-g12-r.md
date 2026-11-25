## 2026-06-15 — Scheduled-rollup Pace mode formalized as _target_ (001 §3.6, §7.3; 002 §4.4–§4.5; roadmap G12) — Refs #147

Formalizes a resolved decision from the monitoring capability study
([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
capability C44; resolved §S5.2). Spec-only; all new rules are marked **target**, not current.

- **001 §3.6 — `notify: rollup` authoring surface (target).** The third `notify` strategy,
  `rollup`, is specified: `strategy: rollup` plus a five-field `window` cron expression and an
  optional `timezone` (defaulting to UTC). A `rollup` monitor accumulates observations between
  window openings and delivers them as a single composite batch when the window fires. Authors
  **SHOULD** relax `watch.interval` to match the delivery frequency — polling every 30 s is wasteful
  when delivery is a daily digest. The current schema rejects `strategy: rollup`; this section
  documents the intended authoring surface for the implementation ticket.

- **001 §7.3 — daily digest rollup authoring example (target).** Illustrates `strategy: rollup`
  with a 9am weekday `window` paired with `interval: 1h`, demonstrating the cadence-relaxation
  principle.

- **002 §4.4 — scheduled-rollup Pace mode semantics (target).** Full runtime semantics:
  accumulation in durable `notifyState` across restarts; window evaluation on each tick (five-field
  cron + timezone, same guard as the schedule source); non-empty batch → flush and clear; empty
  window → no delivery (no empty pings, C14). Key clarifications: the flushed batch enters the
  normal materialization → projection → delivery pipeline (§5 → §6 → §9); rollup is entirely on
  the shared side of the seam (§1.1.2); the delivery clock (§9) is independent of the window clock
  (§1.1.3). Three-clocks analysis applied: observation cadence **SHOULD** be relaxed independently,
  reducing token and observation cost (C44, §S5.2 primary motivation).

- **002 §4.5 — complete Pace mode reference (target row for rollup; others current).** A
  four-row comparison table: **immediate** (no notify) / **settle/debounce** (`debounce`) /
  **throttle** (`throttle`) / **scheduled rollup** (`rollup` ⚑). This completes the Pace set:
  no further Pace modes are anticipated. The table frames rollup as the lowest-cost delivery mode
  and the natural pairing with relaxed observation cadence.

- **roadmap G12** — implementation gap for `strategy: rollup`, P2, with five proof criteria
  (validate acceptance, accumulation-between-windows, flush-on-window, empty-window-no-delivery,
  restart-safety). Governs [001 §3.6], [002 §4.4–§4.5], C44/§S5.2.

Spec-only — no implementation or published-package behavior change, so no changeset.

