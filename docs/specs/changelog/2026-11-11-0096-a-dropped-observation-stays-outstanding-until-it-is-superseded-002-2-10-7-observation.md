## 2026-11-11 — A dropped observation stays outstanding until it is superseded (002 §2/§10.7/`observation_history`; 004 §3.4; 005 doctor) — Refs #497

Replace the "later clean outcome" rule from the entry below. It cleared a drop at the next
non-`errored` history row, so a quiet `no-change` poll, a rollup or debounce hold (`suppressed`),
or a later span whose only failure was retained made a permanent loss read healthy one interval
later, and a loss whose definition was removed or no longer parsed vanished from doctor. Both
contradicted 002 §2's rule that a dropped observation is never less visible than a retained one.

_Current_ rule: a drop with an object key stays outstanding until a later event of the same monitor
id, workspace and object key materializes; a drop without one, until a later span of that monitor
in that workspace materializes an event and drops nothing. Nothing else clears it. "Later" for
events is commit order (`monitor_events.sequence` above a watermark the drop row records), because
an event's `created_at` is observation time. The supersession is per monitor: another monitor's
event for the same key does not clear the drop. Without one unambiguous parsed definition, the
loss is reported in that id's `orphanedMaterializationRetries` entry, following the per-id rule for
retained work, and doctor fails a `dropped-observation:<id>` check; an invalid parsed definition
keeps it on its rollup and gets the same check. Storage: two nullable `observation_history` columns
(`unretained_object_key`, `unretained_event_watermark`), a partial drop-row index, an outcome index
on `observation_history` and an object-key index on `monitor_events`, all additive. Verified by
`libs/core/src/runtime/unretainable-suffix-admission.test.ts` and
`apps/cli/src/retry-diagnostics.test.ts` (including a real `daemon run` socket after a quiet tick).

