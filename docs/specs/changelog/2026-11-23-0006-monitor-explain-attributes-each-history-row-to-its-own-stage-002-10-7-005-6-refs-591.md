## 2026-11-23 — `monitor explain` attributes each history row to its own stage (002 §10.7; 005 §6) — Refs #591

The Observation stage used to read the newest `observation_history` row whatever it recorded. A
skipped terminal retry, an observation a hold refused, a failed retry attempt and a terminal pause
all write `errored` rows, so right after one of them explain reported `Source observation failed`
and put the verdict at Observation, though the source was fine. 005 §6 now lists which rows each
stage reads. Explain classifies every row once, by kind (source outcome, released work, admission
loss, skipped-retry loss, retry drain, unrecognized); Observation reads only source outcomes and
released work, and reports the retained-work pause while the outbox holds work. Losses and drain
reports stay with Materialization, whose retained-work reasons now end in the oldest retry's last
error. A genuine source failure fails Observation as before. What history records is unchanged.
While retained work remains, a source failure recorded by the tick that retained it still fails
Observation: a held flush retained on a failing source call records the source's row last (002
§2.6). A retry-drain report is recognized only with a ULID retry id. 005 §6 names the limits of
reading unmarked rows. A drained tick's `triggered` row that keeps the source's own
`no-files-matched` or `rebaselined` as `sourceOutcome` is a source outcome, not released work.

