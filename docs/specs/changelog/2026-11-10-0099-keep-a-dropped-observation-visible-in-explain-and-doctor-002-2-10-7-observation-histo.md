## 2026-11-10 — Keep a dropped observation visible in explain and doctor (002 §2/§10.7/`observation_history`; 004 §3.4; 005 doctor) — Refs #497

Correct 002 §2's claim that `explainMonitor` and `doctorReport` read the in-transaction `errored`
row of an observation the outbox could not retain. Neither did in effect. The span's batch
`triggered` row is written after commit, so it is newer than the drop row; explain read only the
newest row and reported `ok`. Doctor read history only for `lastObservedAt`, and its retry checks
count outbox rows, of which a drop has none. A permanently lost observation therefore looked
healthier than a recoverable one.

_Current_ rule: the batch row records the span's drop count as `notRetainedCount`, and a drop
stays outstanding until a later clean outcome (a non-`errored` row with no drop count). While one
is outstanding, explain's materialization stage fails and doctor fails the monitor's check, with
`unretainedObservationLoss` in the rollup and in doctor JSON. The drop row's `observationData`
now also names the lost observation: `notRetained: true`, its 1-based `position`, `spanSize`, and
`objectKey`/`title` when they are strings. Every text field follows the retry-error safe-text
rule (controls and Unicode separators become spaces, 1,024-character cap), and the reason always
survives the cap. The payload is never copied. Adds the internal
`RuntimeStore.outstandingUnretainedObservationLoss()` and the public `UnretainedObservationLoss`
type. Verified by `libs/core/src/runtime/unretainable-suffix-admission.test.ts` and
`apps/cli/src/retry-diagnostics.test.ts`.

