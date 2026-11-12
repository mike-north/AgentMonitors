---
'@agentmonitors/core': patch
---

A debounce or rollup monitor no longer stops when one observation's payload cannot be serialized (for example a BigInt or a cyclic reference). The hold refuses that observation and records it as an `errored` outcome naming the observation and the reason, in observation history and the tick's `erroredObservations` (or the watcher's `onError`). The other observations in the batch are held as usual, and later observations continue to materialize. A long observation title no longer hides the reason in history and explain, and a callback that throws while reporting a refusal can no longer lose a flushed batch.
