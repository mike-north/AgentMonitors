## 2026-11-11 — A rejected source config keeps its outstanding drop visible; the order rebuild carries every additive event column (002 §2/§2.0/`monitor_events`; 004 §3.4) — Refs #497, #557, #451

Compose unretained admission outcomes with the source-config preflight and definition
fingerprints. The preflight runs before admission (tick step 5), so a rejected config records no
drop and queues no retry. A drop admitted under the earlier config stays outstanding: doctor keeps
it on the invalid rollup, and `monitor explain` now reports it as a `failure` materialization stage
after the definition failure, which stays the verdict (previously the definition-failure return
omitted it). Explain reports a drop beside the stale-definition delivery note without conflict.
The `monitor_events` order rebuild now carries `admission_sequence` as well as
`definition_fingerprint` when a pre-`sequence` table already has them, and the object-key index is
created after both additive columns. `definition_fingerprint` joins the `monitor_events` schema
table. A live ephemeral monitor whose persisted scope the source now rejects carries
`validationError` in its `ephemeralMonitorWork` group, and its doctor checks say no later event
can clear the work. They say that cancelling and re-declaring the watch restores observation but
leaves this id's drop and retained work reported under its retired id (002 §2; 005 doctor).

