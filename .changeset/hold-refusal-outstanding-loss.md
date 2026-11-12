---
'@agentmonitors/core': patch
'@agentmonitors/cli': patch
---

An observation a debounce or rollup hold refuses because its payload can't be serialized is now
tracked as outstanding loss, like an observation the retry outbox couldn't retain. `doctor` counts
it and `monitor explain` keeps a failing materialization stage until it is superseded: by a later
event for the same object key, or, with no object key, by a later span that materializes an event
and drops nothing. Quiet ticks, holds and restarts no longer hide it. The refusal is still reported
once on the tick result or through the watcher's `onError`, with the same message. Doctor's loss
detail now reads `observation dropped (<count> outstanding; …)` and explain's reason
`<count> observation(s) were dropped because the runtime could not keep them; …`, since the loss may
come from more than one cause.
