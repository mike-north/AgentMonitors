## 2026-11-12 — Held notify work flushes on time while its source fails (002 §2.6, §2.5, §4.3, §`observation_history`; 003 §6.5; 004 §3.3) — Refs #558

Close the gap the `incoming-changes` source-error decision left open (#555): a due monitor whose
`observe()` keeps failing used to keep accepted debounce and rollup work held indefinitely,
because the error path returned before notify dispatch and the unchanged scheduling timestamp
kept the not-due rollup check from running. New 002 §2.6: after recording the failure, the
runtime runs the held-work flush (the not-due rollup window check, now `flushHeldNotifyWork()`,
generalized to any held strategy) with no new observations. It flushes a passed debounce
deadline or a matching rollup window, commits only the notify state change, and keeps the
source baseline and `lastObservationAt`, so the monitor stays due and is retried as before. The
source failure is reported beside the flushed ids, and its `errored` row is written after the
flush's `triggered` row so history and explain still show the failing source. A rolled-back
flush keeps the batch held. Schema-invalid, missing and rejected-in-flight definitions still
block. No public outcome type or API change; continuous watchers and retry cadence (#559) are
unchanged. 003 §6.5 and the #305 scenario list in 004 drop the old "held work waits for a
successful observe" consequence; 004 §3.3 adds the required scenario.

