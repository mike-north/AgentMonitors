## 2026-11-12 — A hold refusal is outstanding loss, under one rule for every drop (002 §2, §4.6, §4.7, §10.7, §`observation_history`; 005 doctor; 004 §3.3) — Refs #575

Reverse 002 §4.7's "a refusal is not a drop". An observation a debounce or rollup hold refuses
because it cannot be serialized is lost just as surely as one the retry outbox cannot retain, so
002 §2 now has one loss rule for both. Both rows are written by one recording function with the
same drop identity (`unretained_object_key`, `unretained_event_watermark`), and doctor and explain
report both as outstanding until superseded: by a later event of the same key, or, without a key,
by a later span that materializes an event and drops nothing. Quiet ticks, holds and restarts do
not clear either. A refusal is recorded at its place in the span's order: after the events of
older observations dispatched with it, and before those of newer siblings. That holds when an
escalation later in the same dispatch flushes a debounce batch (002 §4.1): the observations the
batch held when the refusal was made, whether from an earlier tick or earlier in the span, are
older, so their events do not supersede it, while an observation held after the refusal does.
If a retained suffix
began before that place, it is recorded after the suffix is queued, so a retry of an older sibling
never supersedes it. The refusal keeps its own report: its `errored` row (now
`{ error, holdRefused: true, objectKey?, title? }`, with the §4.7 message unchanged) and its
`erroredObservations`/`onError` entry. The batch row keeps `notHeld` separate from
`notRetainedCount` because the causes differ. The unkeyed supersession rule now treats a positive
value of either as a span that dropped observations. Doctor's detail becomes
`observation dropped (<count> outstanding; …): <error>` and explain's reason
`<count> observation(s) were dropped because the runtime could not keep them; …`, since
`not retained for retry` described only one kind. The new 002 §2 text also states an existing
behavior: held work counts at its flush, so an older held observation flushed after a drop
supersedes it. Refusal rows written before this change have no drop identity and stay one-time
reports. No public type or outcome changes; the payloads refused are unchanged. 004 §3.3 adds the
required scenario.

