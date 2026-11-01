## Context

`events list` already answers "received" and `events list --unread` answers "pending". The missing
state is "armed-but-not-yet-fired": detected, but held. Every hold mechanism is already durably
recorded and already surfaced per monitor by `monitor explain`; `inspect` is a session-scoped read
across that same substrate.

| Hold mechanism                         | Where recorded (already durable)                |
| -------------------------------------- | ----------------------------------------------- |
| High-urgency 15 s settle window        | event age vs `DEFAULT_HIGH_URGENCY_SETTLE_MS`   |
| Debounce `settle-for` batch            | `monitor_state.notify_state` pending debounce   |
| Throttle `suppress-for` window         | `monitor_state.notify_state` suppression window |
| Scheduled-rollup `window` not yet open | `notify_state.pendingRollup` batch              |
| `net` intermediate collapse            | `session_event_state.net_suppressed_at`         |
| Interpret significance suppression     | `session_event_state.interpret_*`               |

## Decisions

- **Armed is derived, not observed.** Rejected alternative: a dedicated "armed" table written by the
  tick — rejected because the substrate is already durable and a second record could drift from it,
  and because any new watching violates PP9.
- **Three buckets, never two.** Rejected alternative: fold armed into pending — rejected because "a
  change is coming" is not "a change is waiting", which is not "a change was delivered".
- **Suppressed is "met and held", not "not met".** Required by PP7 / C12 so "why nothing fired" stays
  inspectable.
- **Hold reason / earliest fire time: SHALL, not SHOULD.** 007 §5.3 phrases this as SHOULD; 005 §14.5
  states it unconditionally ("it reports"). The delta adopts the unconditional reading, bounded by
  "where deterministic" for the fire time.

## Open Questions

- Which transport serves `inspect` (shared with the signal-verbs transport decision: Unix-socket IPC
  vs loopback HTTP), and the final verb name (007 §8).
- Output shape of each bucket entry beyond hold reason / earliest fire time is not fixed by the
  source docs.
