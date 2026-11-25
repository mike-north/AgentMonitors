## 2026-11-11 — A drop is superseded by a later observation, not a later write; ephemeral attribution; orphan work renamed (002 §2/`monitor_events`/`materialization_retry_outbox`/`observation_history`; 004 §3.4; 005 doctor) — Refs #497

Correct the entry below. "Later" for a keyed drop was commit order, and 002 said a retained retry
that materializes counts. A retry admitted before the drop and completed after it commits above
the drop's watermark although it carries older state for the key, so it cleared the drop while the
newest state was never delivered. _Current_ rule: an event supersedes a keyed drop only when its
observation was **admitted** after the drop. Admission order is the `monitor_events`
materialization order: a queued retry reserves the next position of that table's AUTOINCREMENT
counter (`materialization_retry_outbox.admission_sequence`) and its completed event keeps it
(`monitor_events.admission_sequence`); other events are admitted at their own `sequence`. The drop
row's `unretained_event_watermark` is that counter's high-water mark, so retries admitted after the
drop, including a retained later sibling of the dropping span, still supersede it. The object-key
index covers `admission_sequence`.

Doctor scanned only `MONITOR.md` definitions, so a live ephemeral monitor's drop or retained work
was reported as an orphaned definition, and its check said to repair a definition that never
existed. _Current:_ a live ephemeral monitor's obligations are attributed to it in
`ephemeralMonitorWork`; once cancelled or reaped they stay visible in `orphanedMonitorWork` as a
retired ephemeral monitor (`monitorKind: "ephemeral"`), whose checks say so and do not ask for a
repair. The rule that nothing but supersession clears a drop is unchanged, so a retired ephemeral
monitor's drop stays outstanding.

`orphanedMaterializationRetries` (`OrphanedMaterializationRetrySummary`) is renamed
`orphanedMonitorWork` (`OrphanedMonitorWork`). An entry carries `monitorId`, `monitorKind`, and
`materializationRetries` / `unretainedObservationLoss` each only when present: a loss-only entry no
longer carries an invented all-zero retry summary. A duplicated id whose entry holds only a drop
now shows `retry-outbox=0/0` plus `dropped-observation=orphaned` on its rollups instead of
`retry-outbox=orphaned`. The entries below keep the names they were written with. Verified by
`libs/core/src/runtime/unretainable-suffix-admission.test.ts`,
`libs/core/src/inbox/db.migration.test.ts` and `apps/cli/src/retry-diagnostics.test.ts`.

