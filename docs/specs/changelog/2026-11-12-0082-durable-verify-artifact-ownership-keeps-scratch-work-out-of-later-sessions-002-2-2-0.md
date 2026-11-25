## 2026-11-12 — Durable verify-artifact ownership keeps scratch work out of later sessions (002 §2/§2.0/§2.7/§2.8/§10.5/§15; 004 §2.5/§3.4/§3.5.1; 005 §16 step 9) — Closes #562, Refs #561, #414, #418, #575

Replace finite, time-limited scratch cleanup with durable exact ownership, as accepted in #561.
`verify --use-workspace-daemon` registers its synthetic scratch key with the daemon before creating
the file (`verifyArtifacts.register`), naming the run token, its throwaway session, the workspace and
the verified monitor. Cleanup authority takes effect when the run requests cleanup after its proof
(`verifyArtifacts.requestCleanup`) or when the owner session is closed, reaped or missing; it is
recorded once and then never withdrawn (an owner that is inactive but not yet recorded supplies authority only while it stays inactive) and has no wall-clock expiry. With authority in effect the runtime
retracts the key's existing events and drops that exact key, for that monitor and workspace only,
at the incoming-observation boundary (before notify dispatch) and at held emission (debounce,
rollup, escalation flushes, the flush while the source fails of 002 §2.6, and the notify-edit
drain). A held flush whose only items are dropped clears the hold and writes no history row of its
own, so a failing source's `errored` row stays the newest. Source plugins and their state are
unchanged.

With 002 §2.7's retained-work drain, the drain is a held-emission boundary too. A retry row queued
before authority took effect is dropped rather than drained, on ticks and before watcher pulls: it
is removed from the outbox in one immediate transaction that re-checks authority, before the
drain's terminal and backoff checks, and it writes no event, no `errored` row and no history row.
A dropped row, even a terminal one, never pauses newer legitimate work for its monitor. Retry
completion re-checks authority under its own writer lock, so cleanup recorded by another writer
after the drain read the row still drops it. A removal that cannot commit is a failed drain step:
the row stays, one `errored` row and one `erroredObservations` entry are recorded, and other
monitors in the tick are unaffected. Previously such a retry would have materialized after cleanup
and reached a later lead session. The drain filter, completion re-check and discard share one
scratch-key predicate, so a retained retry for a key that is not a verify scratch key is never
dropped.

With 002 §2's rule that a hold refusal is outstanding loss recorded at its place in the span's
order, that place counts only the dispatched envelopes that survive the ownership filter. A held
artifact dropped at emission is not counted, so a refusal made behind it is still recorded before a
newer event of its key, which supersedes it. Counting the dropped artifact would have recorded the
refusal one place late and reported it as outstanding loss after it was superseded.

This restores the no-later-scratch-event guarantee for registered runs, including retained baseline
deletions, held deletions and held-only creates after arbitrary delay, restart and config repair.
The guarantee does not cover a killed run before its owner is reaped (the proof phase), clients or
daemons that predate ownership (they keep the finite `events.suppressObject` fallback), or sibling
monitors that happen to watch the scratch path. A matching basename alone no longer confers cleanup:
the session reaper's basename-matched tombstone and its cadence-sized lifetime are removed, so 002
§2.0 no longer sizes a suppression from cadence.

Records are retained without a TTL in the additive `verify_artifacts` table (one row per run; no
automatic retirement and no retirement command). Measured after `VACUUM` with `dbstat` on 4 KiB
pages, with a 151-character workspace path and a 188-character key, at 100, 1,000 and 10,000 runs:
about 850 bytes per run with cleanup recorded and about 1,000 bytes while awaiting cleanup, roughly
five runs per page. The table, its indexes and every released database shape are covered by
`db.released-shapes.test.ts`.

