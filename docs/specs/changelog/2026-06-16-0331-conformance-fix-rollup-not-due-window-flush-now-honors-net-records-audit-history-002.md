## 2026-06-16 — Conformance fix: rollup not-due window flush now honors `net` + records audit history (002 §1.1.7, §10.7, §4.4) — Refs #180

No contract change — this records that the **implementation** was brought into conformance with the
existing spec, not a clarification of the spec itself.

- **002 §1.1.7 (net baseline strategy) + §4.4 (scheduled-rollup Pace mode).** A `notify.strategy:
rollup` monitor flushes its accumulated batch via two runtime-tick paths: the source-interval-
  elapsed ("due") path through `ingest()`, and the "not-due" path where the delivery `window` opens
  on a tick whose source poll interval has not elapsed. Per §4.4 the not-due path is the _normal_
  operating mode (authors SHOULD relax `watch.interval` to match the window). The not-due path had
  drifted from `ingest()` and skipped the `net` collapse, so a `rollup` + `baseline-strategy: net`
  monitor delivered the full play-by-play (N events) instead of one net delta. Now both paths route
  through one shared span-materialization helper, so §1.1.7's "one net delta for a missed span"
  holds on both.

- **002 §10.7 / §1.1.6 (audit history).** The same not-due flush wrote no `triggered`
  `observation_history` row, so a real windowed delivery was invisible to `monitor explain` /
  `history`. The shared helper now records the `triggered` row on both paths.

