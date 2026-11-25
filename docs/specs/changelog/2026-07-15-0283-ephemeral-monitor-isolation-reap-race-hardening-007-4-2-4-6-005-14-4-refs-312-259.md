## 2026-07-15 — Ephemeral-monitor isolation + reap-race hardening (007 §4.2/§4.6, 005 §14.4) — Refs #312, #259

Follow-up hardening of the ephemeral-monitor primitive (below). Behavior changes, all _current_:

- **007 §4.6 — isolation is now a read invariant, not only a projection one.** An ephemeral
  monitor's instruction is the declaring session's private free-text guidance, so its events **MUST
  NOT** be returned by an **unscoped** (session-less) read that bypasses the projection gate. The
  runtime store now excludes ephemeral-monitor rows (recognised by the reserved `ephemeral:` id
  prefix, §4.3) from an unscoped `listEvents` and from the unscoped observation-history enumeration;
  the declaring session still reads its own ephemeral events via its session-scoped read.
  Persistent-monitor reads are unchanged. (Previously an unscoped `events list` could return a
  sibling session's ephemeral event body.)
- **007 §4.6 — reap-race: an in-flight tick must not deliver for a reaped watch.** A tick pre-fetches
  its active ephemeral monitors before `observe()` yields, so a `watch cancel` (or session
  close/dormancy) that races the observation could still project. Materialization now re-checks, at
  insert time, that the ephemeral monitor is still `active` and its declaring session is still
  `active`; if either was reaped, the observed event is retained (§4.4) but projected to **nobody**.
- **007 §4.2 — lead-only binding.** Projection delivers to lead sessions only, so a binding to a
  subagent session would observe forever but never deliver. A declaration against a non-lead session
  is now **rejected** at declaration time with a clear error (previously registered as a silently-dead
  watch).
- **005 §14.4 / 007 §4.2 — scope-parity claim made true by sharing the wrapper.** `watch declare`
  previously called `validateScope` directly and skipped the CLI `validate` command's BP3
  `change-detection.collection` friendly-error wrapper, so the "rejected with the identical diagnosis"
  claim was untrue for the keyed-collection case. Both paths now call one shared core helper,
  `validateWatchScope` (schema check + the collection wrapper), so the diagnosis is genuinely
  identical.
- **007 §4.2 — doc correction.** The `EphemeralMonitorRecord.instruction` / §4.2 "surfaced verbatim
  as the body" wording overclaimed: the instruction is a **fallback** body
  (`observation.body ?? monitor.instructions`), overridden when a source supplies its own body.
- **Verified by** the new cases in `libs/core/src/runtime/ephemeral-monitors.test.ts` (unscoped-read
  isolation, close-during-tick and cancel-during-tick reap races, retention-after-tick-then-reap,
  non-lead rejection, scope key `type` cannot override the source, and the keyed-collection parity
  diagnosis).

