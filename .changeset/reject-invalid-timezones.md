---
'@agentmonitors/core': patch
'@agentmonitors/cli': patch
'agentmonitors': patch
---

Reject invalid IANA timezones on `schedule` monitors and the `rollup` notify strategy at authoring
time (`validate`, `monitor test`, `watch declare`), and defensively isolate a runtime timezone
failure to the affected monitor instead of aborting the whole daemon tick.

Previously, a typo'd `timezone` (e.g. `America/New_Yrok`) on a `schedule` monitor made
`Intl.DateTimeFormat` throw deep inside cron scheduling — and because that call happened outside the
per-monitor error isolation, it aborted the **entire** tick, silently stopping every other monitor
from running. Now:

- `validate`, `monitor test`, and `watch declare` reject an invalid `schedule` `scope.timezone` with
  an actionable error naming the bad value (the `rollup` notify strategy's `timezone` was already
  validated this way).
- If an invalid timezone reaches the runtime anyway (a hand-edited `MONITOR.md` that skipped
  `validate`), it is isolated to that one monitor — recorded as an `errored` observation, surfaced in
  `daemon once`/`daemon run` output, and reported by `monitor explain` as an observation-stage
  failure — instead of crashing the tick or the diagnostic command. Every other monitor keeps
  running unaffected.
