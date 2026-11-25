## 2026-11-23 — Drained retries count in the tick's history row (002 §2.7, §15) — Refs #617

A tick whose retry drain completed retained work recorded its events on the tick result but not in
`observation_history`: the same tick's empty source span then wrote `no-change` `{ observed: 0,
emitted: 0 }`. A tick now records one outcome row per monitor that counts the drained events. A
later span's batch row adds them to `emitted` and becomes `triggered`; otherwise the tick records
`triggered` `{ observed: 0, emitted: <drained count> }`. An `errored` row written in the same tick
stays the newest. Failed drain attempts record what they did before. A watcher's drain is
unchanged and records no batch row. When the source returned nothing and reported
`no-files-matched` or `rebaselined` on such a tick, the `triggered` row carries it as
`sourceOutcome`, and `monitor explain` reports it as it would the plain outcome.

