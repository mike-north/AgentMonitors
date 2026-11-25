## 2026-11-11 — An unserializable observation is refused at hold acceptance (002 §4.3/§4.4/§4.7, §`observation_history`, 004 §3.3) — Refs #570

Before this change, a debounce or rollup hold whose observation could not be encoded as JSON (a
BigInt or a cyclic payload) failed every notify-state write for its monitor. The source baseline
never advanced, the same batch was re-observed on every tick, and the observation's batch siblings
were never held. The only trace was a raw serializer error repeated each tick.

Add 002 §4.7. Serializability is checked once per observation, where it would join
`pendingDebounce` or `pendingRollup`, using the hold's own serializer. A refused observation is not
held. It gets one `errored` `observation_history` row naming the observation, the strategy and the
reason, reported on the tick result's `erroredObservations` or the watcher's `onError`. Its siblings
are held in order, and the baseline advances. The span's batch row counts refusals as `notHeld` and
is omitted when every observation was refused. Observations that bypass a hold are outside this
rule and keep the materialization contract (§5). Round-tripping such payloads remains out of scope.

